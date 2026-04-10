"""
create_invoice.py
POST /api/create_invoice   { "page_id": "<quotation_page_id>" }

Triggered by Notion automation when Quotation Status → Approved.
1. Creates a pre-filled Invoice page linked to the Quotation
2. Creates a Project page (central hub) linked to Company, Quotation,
   Invoice — with line items from the quotation written as Notes

Auto-determines Invoice Type:
  Payment Terms = "Full Upfront"  → Full Payment (no deposit)
  Payment Terms = "50% Deposit"   → Deposit invoice first

Quotation DB : f8167f0bda054307b90b17ad6b9c5cf8
Invoice DB   : 9227dda9c4be42a1a4c6b1bce4862f8c
Projects DB  : 5719b2672d3442a29a22637a35398260
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler

import requests

QUOTATION_DB = "f8167f0bda054307b90b17ad6b9c5cf8"
INVOICE_DB   = "9227dda9c4be42a1a4c6b1bce4862f8c"
PROJECTS_DB  = "5719b2672d3442a29a22637a35398260"

# Cover image URLs per Package type (GitHub raw CDN — always available)
COVER_BASE = "https://raw.githubusercontent.com/opxio-io/opxio/main/generate-pdf/covers"
COVER_MAP = {
    "Starter OS":      f"{COVER_BASE}/starter-os.png",
    "Operations OS":   f"{COVER_BASE}/operations-os.png",
    "Sales OS":        f"{COVER_BASE}/sales-os.png",
    "Business OS":     f"{COVER_BASE}/business-os.png",
    "Marketing OS":    f"{COVER_BASE}/marketing-os.png",
    "Intelligence OS": f"{COVER_BASE}/intelligence-os.png",
    "Expansion":       f"{COVER_BASE}/expansion.png",
}

QUO_PATTERN = re.compile(r"^QUO-(\d{4})-(\d{4})$")
INV_SUFFIX  = {
    "Deposit":       "-D",
    "Supplementary": "-S",
    "Final Payment": "-F",
    "Retainer":      "-R",
    "Full Payment":  "",
}

# ── Layer 2 add-on product name → slug mapping ──────────────────────────────
# Keys are lowercase substrings that uniquely identify each add-on as it would
# appear in a quotation line item. Order matters — more specific first.
ADDON_SLUG_MAP = {
    "ai agent":           "ai-agent",
    "lead capture":       "lead-capture",
    "client portal":      "client-portal",
    "advanced dashboard": "advanced-dashboard",
    "custom widget":      "custom-widget",
    "api / external":     "api-integration",
    "api/external":       "api-integration",
    "api integration":    "api-integration",
    "make/n8n":           "make-n8n-integration",
    "n8n":                "make-n8n-integration",
    "make.com":           "make-n8n-integration",
    "automation & workflow": "make-n8n-integration",
    "cross-database":     "automation-cross",
    "cross database":     "automation-cross",
    "automation (cross":  "automation-cross",
    "within database":    "automation-within",
    "within-database":    "automation-within",
    "automation (within": "automation-within",
    "additional system module": "additional-module",
    "additional module":  "additional-module",
}

# Layer 1 OS names — excluded from add-on detection
LAYER_1_OS_NAMES = {
    "base os", "starter os", "operations os", "sales os",
    "business os", "marketing os", "intelligence os", "full platform os",
}


def extract_addon_slugs(line_items):
    """
    Given a list of quotation line item dicts (each with a 'name' key),
    return a deduplicated list of Layer 2 add-on product slugs to write
    to the project's 'Add-on Products' multi-select field.
    """
    slugs = []
    seen  = set()
    for item in line_items:
        name_lower = (item.get("name") or "").lower().strip()
        # Skip if it's a Layer 1 OS package
        if any(os_name in name_lower for os_name in LAYER_1_OS_NAMES):
            continue
        # Match against slug map
        for keyword, slug in ADDON_SLUG_MAP.items():
            if keyword in name_lower and slug not in seen:
                seen.add(slug)
                slugs.append(slug)
                break
    return slugs


def format_invoice_number(quotation_no, invoice_type):
    """Derive INV number from the linked quotation's QUO number."""
    suffix = INV_SUFFIX.get(invoice_type, "-D")
    m = QUO_PATTERN.match(quotation_no or "")
    if m:
        return f"INV-{m.group(1)}-{m.group(2)}{suffix}"
    # Fallback: timestamp-based
    from datetime import datetime as _dt
    ts = _dt.now().strftime("%H%M")
    return f"INV-{_dt.now().year}-{ts}{suffix}"


def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def _hdrs():
    api_key = os.environ.get("NOTION_API_KEY", "")
    return {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


def fetch_line_items(quotation_page_id, hdrs):
    """
    Fetch child blocks of the Quotation page and look for a child_database
    (the line-items inline DB). Then query that DB for all rows.
    Returns a list of dicts: {name, qty, unit_price, amount, description}
    """
    line_items = []

    # 1. Get child blocks to find the inline line-items database
    r = requests.get(
        f"https://api.notion.com/v1/blocks/{quotation_page_id}/children",
        headers=hdrs, timeout=15
    )
    r.raise_for_status()
    blocks = r.json().get("results", [])

    child_db_id = None
    for block in blocks:
        if block.get("type") == "child_database":
            child_db_id = block["id"].replace("-", "")
            break

    if not child_db_id:
        return line_items

    # 2. Query the child DB for all rows
    has_more = True
    cursor   = None
    while has_more:
        payload = {"page_size": 100}
        if cursor:
            payload["start_cursor"] = cursor

        r = requests.post(
            f"https://api.notion.com/v1/databases/{child_db_id}/query",
            headers=hdrs, json=payload, timeout=15
        )
        r.raise_for_status()
        data     = r.json()
        has_more = data.get("has_more", False)
        cursor   = data.get("next_cursor")

        for page in data.get("results", []):
            props = page.get("properties", {})

            name        = _plain(props.get("Item", props.get("Name", props.get("Service", {}))).get("title", []))
            description = _plain(props.get("Description", {}).get("rich_text", []))
            qty         = (props.get("Qty",      {}).get("number") or
                           props.get("Quantity", {}).get("number") or 1)

            # Catalog Price — rollup from Products DB (the "list price")
            cp_prop = props.get("Catalog Price", {})
            catalog_price = 0
            if cp_prop.get("type") == "rollup":
                rl = cp_prop.get("rollup", {})
                catalog_price = (rl.get("number") or
                                 next((a.get("number", 0) for a in rl.get("array", [])
                                       if a.get("type") == "number"), 0))
            elif cp_prop.get("type") == "number":
                catalog_price = cp_prop.get("number") or 0

            # Unit Price — manual discount override; fall back to Catalog Price
            unit_price  = (props.get("Unit Price", {}).get("number") or
                           props.get("Rate",       {}).get("number") or
                           catalog_price)

            amount      = (props.get("Subtotal", {}).get("formula", {}).get("number") or
                           props.get("Total",    {}).get("formula", {}).get("number") or
                           (qty * unit_price))

            if name:
                line_items.append({
                    "name":        name,
                    "qty":         qty,
                    "unit_price":  unit_price,
                    "amount":      amount,
                    "description": description,
                })

    return line_items


def fetch_quotation(page_id, hdrs):
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                     headers=hdrs, timeout=15)
    r.raise_for_status()
    props = r.json().get("properties", {})

    quotation_no  = _plain(props.get("Quotation No.", {}).get("title", []))
    # Quotation DB field is still "Amount" (only Invoice DB was renamed to "Total Amount")
    amount        = props.get("Amount", {}).get("number") or 0
    payment_terms = (props.get("Payment Terms", {}).get("select") or {}).get("name", "")
    issue_date    = (props.get("Issue Date", {}).get("date") or {}).get("start", "")
    status        = (props.get("Status", {}).get("select") or {}).get("name", "")
    quote_type    = (props.get("Package", props.get("Type", props.get("Quote Type", {}))).get("select") or {}).get("name", "")

    # Company relation IDs + name
    company_rels = props.get("Company", {}).get("relation", [])
    company_ids  = [rel["id"] for rel in company_rels]
    company_name = ""
    if company_ids:
        cr = requests.get(f"https://api.notion.com/v1/pages/{company_ids[0]}",
                          headers=hdrs, timeout=15)
        if cr.ok:
            cp = cr.json().get("properties", {})
            # Company name is usually the title property
            for v in cp.values():
                if v.get("type") == "title":
                    company_name = _plain(v.get("title", []))
                    break

    # PIC / Client — PIC may be rollup (of Primary Contact relation) or direct relation
    CLIENTS_DB = "036622227fd244ad9a77633d5ae0a64b"
    pic_ids  = []
    pic_name = ""
    pic_prop = props.get("PIC", {})
    if pic_prop.get("type") == "rollup":
        for item in pic_prop.get("rollup", {}).get("array", []):
            t = item.get("type", "")
            if t == "relation":
                # Rollup of a relation field — page IDs available directly
                pic_ids = [r["id"] for r in item.get("relation", [])]
                print(f"[INFO] PIC IDs from rollup-relation: {pic_ids}", file=sys.stderr)
                break
            if t == "title":     pic_name = _plain(item.get("title", []));     break
            if t == "rich_text": pic_name = _plain(item.get("rich_text", [])); break
    elif pic_prop.get("type") == "relation":
        pic_ids = [rel["id"] for rel in pic_prop.get("relation", [])]

    # Fallback: if we only got a name, search the Clients DB
    if pic_name and not pic_ids:
        try:
            sr = requests.post(
                f"https://api.notion.com/v1/databases/{CLIENTS_DB}/query",
                headers=hdrs,
                json={"filter": {"property": "Name", "title": {"equals": pic_name}}},
                timeout=10
            )
            if sr.ok:
                results = sr.json().get("results", [])
                if results:
                    pic_ids = [results[0]["id"]]
                    print(f"[INFO] Found client '{pic_name}' in Clients DB via name search", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] Client lookup: {e}", file=sys.stderr)

    # Lead relation — "Deal Source" two-way relation on Quotation (renamed from "Lead")
    lead_ids = [rel["id"] for rel in props.get("Deal Source", {}).get("relation", [])]

    # Existing project — if set, this is an add-on quotation; don't create a new project
    existing_project_ids = [
        rel["id"].replace("-", "")
        for rel in props.get("Project", {}).get("relation", [])
    ]

    # Already-linked invoices (avoid creating duplicates)
    existing_invoices = [rel["id"] for rel in props.get("Invoice", {}).get("relation", [])]

    # Fetch line items from the quotation's child inline DB
    line_items = fetch_line_items(page_id, hdrs)

    # Package Type (rich_text on quotation — e.g. "Add-on")
    package_type_text = _plain(props.get("Package Type", {}).get("rich_text", []))

    return {
        "quotation_no":        quotation_no,
        "amount":              amount,
        "payment_terms":       payment_terms,
        "issue_date":          issue_date,
        "status":              status,
        "quote_type":          quote_type,
        "company_ids":         company_ids,
        "company_name":        company_name,
        "pic_ids":             pic_ids,
        "lead_ids":            lead_ids,
        "existing_project_ids": existing_project_ids,
        "existing_invoices":   existing_invoices,
        "line_items":          line_items,
        "package_type_text":   package_type_text,
    }


def create_invoice(quotation_id, quotation_data, hdrs):
    """Create the Invoice page in Notion linked to the Quotation. Status = Draft."""
    today  = datetime.now().date().isoformat()
    terms  = quotation_data.get("payment_terms", "")
    amount = quotation_data.get("amount", 0)
    quo_no = quotation_data.get("quotation_no", "")

    # Determine invoice type
    # Add-on quotations are detected by: Payment Terms=Full Upfront AND an
    # existing project already linked (set by create_addon.py).
    is_addon = (
        terms == "Full Upfront"
        and bool(quotation_data.get("existing_project_ids"))
    )

    if is_addon:
        inv_type   = "Supplementary"
        dep_amount = None
        due_date   = (datetime.now() + timedelta(days=14)).date().isoformat()
    elif terms == "Full Upfront":
        inv_type   = "Full Payment"
        dep_amount = None
        due_date   = (datetime.now() + timedelta(days=14)).date().isoformat()
    else:
        # 50% Deposit (default)
        inv_type   = "Deposit"
        dep_amount = round(amount * 0.5, 2) if amount else None
        due_date   = (datetime.now() + timedelta(days=14)).date().isoformat()

    # Format invoice number immediately
    inv_no = format_invoice_number(quo_no, inv_type)

    # Payment balance = Total - Deposit Amount
    if dep_amount is not None:
        pay_balance = round(amount - dep_amount, 2)
    else:
        pay_balance = None

    # Build properties — matched to actual Invoice DB schema
    props = {
        "Invoice No.":    {"title": [{"text": {"content": inv_no}}]},
        "Invoice Type":   {"select": {"name": inv_type}},
        "Status":         {"select": {"name": "Draft"}},
        "Issue Date":     {"date": {"start": today}},
        "Total Amount": {"number": amount},
        "Quotation":      {"relation": [{"id": quotation_id}]},
        "Payment Method": {"select": {"name": "Bank Transfer"}},
    }

    if terms:
        props["Payment Terms"] = {"select": {"name": terms}}

    # Company relation
    if quotation_data.get("company_ids"):
        props["Company"] = {"relation": [{"id": quotation_data["company_ids"][0]}]}

    # PIC relation
    if quotation_data.get("pic_ids"):
        props["PIC"] = {"relation": [{"id": quotation_data["pic_ids"][0]}]}

    # Deal Source relation — links invoice directly to the deal
    if quotation_data.get("lead_ids"):
        props["Deal Source"] = {"relation": [{"id": quotation_data["lead_ids"][0]}]}

    if inv_type == "Deposit":
        if dep_amount is not None:
            props["Deposit (50%)"] = {"number": dep_amount}   # deposit amount
        if pay_balance is not None:
            props["Final Payment"]   = {"number": pay_balance}  # balance amount
        props["Deposit Due"]           = {"date": {"start": due_date}}   # deposit due date
    else:
        # Full payment
        props["Final Payment Due"] = {"date": {"start": due_date}}

    # Check that Company relation property exists in Invoice DB (log only — don't remove it)
    if quotation_data.get("company_ids"):
        try:
            schema_r = requests.get(f"https://api.notion.com/v1/databases/{INVOICE_DB}",
                                    headers=hdrs, timeout=10)
            if schema_r.ok:
                existing = schema_r.json().get("properties", {})
                if "Company" in existing:
                    print(f"[INFO] 'Company' property found in Invoice DB (type: {existing['Company'].get('type')})", file=sys.stderr)
                else:
                    print(f"[WARN] 'Company' property NOT found in Invoice DB — props: {list(existing.keys())}", file=sys.stderr)
                    props.pop("Company", None)
        except Exception as e:
            print(f"[WARN] Company schema check failed: {e}", file=sys.stderr)

    body = {
        "parent":     {"database_id": INVOICE_DB},
        "icon":       {"type": "emoji", "emoji": "🧾"},
        "properties": props,
    }

    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs, json=body, timeout=15)
    if not r.ok:
        print(f"[WARN] Create invoice {r.status_code}: {r.text}", file=sys.stderr)
        # If Company caused the error, retry without it
        if "Company" in r.text:
            props.pop("Company", None)
            body["properties"] = props
            r = requests.post("https://api.notion.com/v1/pages",
                              headers=hdrs, json=body, timeout=15)
        if not r.ok:
            raise ValueError(f"Notion rejected invoice creation ({r.status_code}): {r.text}")
    return r.json()


def create_project(company_ids, company_name, quotation_id, invoice_id,
                   quotation_no, amount, quote_type, line_items, hdrs,
                   lead_ids=None, pic_ids=None, package_name=None):
    """
    Create a Project page as the central hub for this client system build.
    Links Company, Quotation, Invoice, Deals (lead), and PIC (contact).
    Returns the new project page ID.

    Field mappings on Projects DB:
      Package  → actual product name (e.g. "Operations OS"), NOT quote_type
      Deals    → Lead/Deal CRM page relation
      PIC      → actual contact person relation (separate from Deals)
    """
    type_label = package_name or quote_type or quotation_no
    project_name = f"{company_name} — {type_label}" if company_name else type_label

    props = {
        "Project Name": {"title": [{"text": {"content": project_name}}]},
        "Status":       {"select": {"name": "Deposit Pending"}},
        "Phase":        {"select": {"name": "Phase 1"}},
        "Total Value":  {"number": amount},
        "Quotation":    {"relation": [{"id": quotation_id}]},
        "Invoice":      {"relation": [{"id": invoice_id}]},
    }

    if company_ids:
        props["Company"] = {"relation": [{"id": company_ids[0]}]}

    # Package = actual product name (e.g. "Operations OS"), not the billing type
    if package_name:
        props["Package"] = {"select": {"name": package_name}}
    elif quote_type:
        # Fallback: use quote_type only if no product name available
        props["Package"] = {"select": {"name": quote_type}}

    # Deals = Lead/Deal CRM relation (previously incorrectly stored in PIC)
    if lead_ids:
        for field in ("Deals", "Deal Source", "Lead"):
            try:
                props[field] = {"relation": [{"id": lead_ids[0]}]}
                break
            except Exception:
                pass

    # PIC = actual contact person (separate relation field)
    if pic_ids:
        props["PIC"] = {"relation": [{"id": pic_ids[0]}]}

    # Build line-item notes as rich_text blocks
    notes_blocks = []
    if line_items:
        # Heading
        notes_blocks.append({
            "object": "block",
            "type":   "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "Quoted Line Items"}}]
            }
        })
        for item in line_items:
            label = item["name"]
            if item.get("qty") and item.get("unit_price"):
                label += f"  ×{item['qty']}  @ ${item['unit_price']:,.2f}"
            if item.get("amount"):
                label += f"  =  ${item['amount']:,.2f}"
            if item.get("description"):
                label += f"\n{item['description']}"

            notes_blocks.append({
                "object": "block",
                "type":   "bulleted_list_item",
                "bulleted_list_item": {
                    "rich_text": [{"type": "text", "text": {"content": label}}]
                }
            })

    # Set cover image based on package type
    pkg_label = package_name or quote_type or ""
    cover_url = COVER_MAP.get(pkg_label)

    body = {
        "parent":     {"database_id": PROJECTS_DB},
        "icon":       {"type": "emoji", "emoji": "🏗️"},
        "properties": props,
        "children":   notes_blocks,
    }
    if cover_url:
        body["cover"] = {"type": "external", "external": {"url": cover_url}}

    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs, json=body, timeout=15)
    if not r.ok:
        print(f"[WARN] Create project {r.status_code}: {r.text}", file=sys.stderr)
        raise ValueError(f"Notion rejected project creation ({r.status_code}): {r.text}")
    return r.json()["id"]


def link_project_to_invoice(invoice_id, project_id, hdrs):
    """Write the Project relation back onto the Invoice page (if the field exists)."""
    body = {"properties": {"Project": {"relation": [{"id": project_id}]}}}
    r = requests.patch(f"https://api.notion.com/v1/pages/{invoice_id}",
                       headers=hdrs, json=body, timeout=15)
    # Non-fatal — field may not exist yet; caller logs the outcome
    return r.ok


def link_project_to_quotation(quotation_id, project_id, hdrs):
    """Write the Project relation back onto the Quotation page (if the field exists)."""
    body = {"properties": {"Project": {"relation": [{"id": project_id}]}}}
    r = requests.patch(f"https://api.notion.com/v1/pages/{quotation_id}",
                       headers=hdrs, json=body, timeout=15)
    return r.ok


class handler(BaseHTTPRequestHandler):

    def _respond(self, code, body_dict):
        body = json.dumps(body_dict).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)

        if "schema" in qs:
            # Return Invoice DB schema so we can see exact property names + types
            try:
                hdrs = _hdrs()
                r = requests.get(f"https://api.notion.com/v1/databases/{INVOICE_DB}",
                                 headers=hdrs, timeout=10)
                r.raise_for_status()
                props = r.json().get("properties", {})
                schema = {k: v.get("type") for k, v in props.items()}
                self._respond(200, {"invoice_db_schema": schema})
            except Exception as e:
                self._respond(500, {"error": str(e)})
            return

        if "debug" in qs:
            # ?debug=1&page_id=<quotation_page_id> — show what would be fetched, no creation
            page_id = (qs.get("page_id") or [None])[0]
            if not page_id:
                self._respond(400, {"error": "Missing page_id"}); return
            page_id = page_id.replace("-", "")
            try:
                hdrs = _hdrs()
                quotation = fetch_quotation(page_id, hdrs)
                self._respond(200, {
                    "quotation_no":  quotation["quotation_no"],
                    "status":        quotation["status"],
                    "amount":        quotation["amount"],
                    "payment_terms": quotation["payment_terms"],
                    "company_ids":   quotation["company_ids"],
                    "company_name":  quotation["company_name"],
                    "pic_ids":       quotation["pic_ids"],
                    "existing_invoices": quotation["existing_invoices"],
                    "line_items_count": len(quotation["line_items"]),
                    "line_items": quotation["line_items"],
                })
            except Exception as e:
                import traceback; traceback.print_exc(file=sys.stderr)
                self._respond(500, {"error": str(e)})
            return

        self._respond(200, {"service": "Vision Core — Create Invoice from Quotation",
                            "status":  "ready"})

    def do_POST(self):
        try:
            secret = os.environ.get("WEBHOOK_SECRET", "")
            if secret and self.headers.get("Authorization", "") != f"Bearer {secret}":
                self._respond(401, {"error": "Unauthorized"}); return

            length = int(self.headers.get("Content-Length", 0))
            raw    = self.rfile.read(length) if length > 0 else b"{}"
            body   = json.loads(raw) if raw else {}

            print(f"[DEBUG] payload: {json.dumps(body)}", file=sys.stderr)

            # Extract quotation page_id
            page_id = None
            if "source" in body:
                page_id = body["source"].get("page_id") or body["source"].get("id")
            if not page_id and "data" in body:
                page_id = body["data"].get("page_id") or body["data"].get("id")
            if not page_id:
                page_id = body.get("page_id") or body.get("id")
            if page_id:
                page_id = page_id.replace("-", "")

            if not page_id:
                self._respond(400, {"error": "No page_id"}); return

            if not os.environ.get("NOTION_API_KEY"):
                self._respond(500, {"error": "NOTION_API_KEY not set"}); return

            hdrs      = _hdrs()
            quotation = fetch_quotation(page_id, hdrs)

            print(f"[INFO] Quotation: {quotation['quotation_no']} | "
                  f"Status: {quotation['status']} | Terms: {quotation['payment_terms']}",
                  file=sys.stderr)

            # Guard: only create if Approved (bypass with force=true for testing)
            force = body.get("force", False)
            if not force and quotation["status"] != "Approved":
                self._respond(200, {
                    "status": "skipped",
                    "reason": f"Quotation status is '{quotation['status']}', not Approved",
                }); return

            # Guard: don't create duplicate if an invoice already exists
            if not force and quotation["existing_invoices"]:
                self._respond(200, {
                    "status":      "skipped",
                    "reason":      "Invoice already exists for this quotation",
                    "invoice_ids": quotation["existing_invoices"],
                }); return

            # 1. Create Invoice
            new_inv = create_invoice(page_id, quotation, hdrs)
            inv_id  = new_inv["id"]
            print(f"[INFO] Invoice created: {inv_id}", file=sys.stderr)

            # 1b. Auto-generate invoice PDF immediately
            pdf_url = ""
            try:
                gen_hdrs = {"Content-Type": "application/json"}
                webhook_secret = os.environ.get("WEBHOOK_SECRET", "")
                if webhook_secret:
                    gen_hdrs["Authorization"] = f"Bearer {webhook_secret}"
                gr = requests.post(
                    "https://vision-core-delta.vercel.app/api/generate_invoice",
                    headers=gen_hdrs,
                    json={"page_id": inv_id},
                    timeout=55,
                )
                if gr.ok:
                    pdf_url = gr.json().get("pdf_url", "")
                    print(f"[INFO] Invoice PDF auto-generated: {pdf_url[:60]}", file=sys.stderr)
                else:
                    print(f"[WARN] PDF generation returned {gr.status_code}: {gr.text[:200]}", file=sys.stderr)
            except Exception as e:
                print(f"[WARN] Auto PDF generation failed: {e}", file=sys.stderr)

            # 1c. Advance the Deal stage to "Won – Pending Deposit"
            # Use lead_ids directly from quotation (faster than DB query)
            DEALS_DB = "8690d55c4d0449068c51ef49d92a26a2"
            try:
                lead_ids_to_advance = quotation.get("lead_ids", [])
                # Fallback: query by Quotation relation if lead not on quotation yet
                if not lead_ids_to_advance:
                    dr = requests.post(
                        f"https://api.notion.com/v1/databases/{DEALS_DB}/query",
                        headers=hdrs,
                        json={"filter": {"property": "Quotation", "relation": {"contains": page_id}}},
                        timeout=10,
                    )
                    if dr.ok:
                        lead_ids_to_advance = [r["id"] for r in dr.json().get("results", [])]

                for lead_id in lead_ids_to_advance:
                    requests.patch(
                        f"https://api.notion.com/v1/pages/{lead_id}",
                        headers=hdrs,
                        json={"properties": {"Stage": {"status": {"name": "Deposit Due"}}}},
                        timeout=10,
                    )
                    print(f"[INFO] Deal {lead_id[:8]} → Deposit Due", file=sys.stderr)
            except Exception as e:
                print(f"[WARN] Deal stage update: {e}", file=sys.stderr)

            # 2. Find or create Project hub
            existing_project_ids = quotation.get("existing_project_ids", [])
            is_addon = bool(existing_project_ids)

            if is_addon:
                # Add-on quotation — link invoice to the EXISTING project hub
                project_id = existing_project_ids[0]
                print(f"[INFO] Add-on detected — linking to existing Project: {project_id}", file=sys.stderr)

                # Update Add-on Value on the project (increment by add-on amount)
                try:
                    # Fetch current add-on value
                    pr = requests.get(
                        f"https://api.notion.com/v1/pages/{project_id}",
                        headers=hdrs, timeout=10
                    )
                    if pr.ok:
                        curr_addon = pr.json().get("properties", {}).get(
                            "Add-on Value", {}
                        ).get("number") or 0
                        new_addon = round(curr_addon + quotation["amount"], 2)
                        requests.patch(
                            f"https://api.notion.com/v1/pages/{project_id}",
                            headers=hdrs,
                            json={"properties": {"Add-on Value": {"number": new_addon}}},
                            timeout=10,
                        )
                        print(f"[INFO] Project Add-on Value updated: RM {new_addon}", file=sys.stderr)
                except Exception as e:
                    print(f"[WARN] Add-on Value update: {e}", file=sys.stderr)
            else:
                # New project — standard flow
                project_id = create_project(
                    company_ids  = quotation["company_ids"],
                    company_name = quotation["company_name"],
                    quotation_id = page_id,
                    invoice_id   = inv_id,
                    quotation_no = quotation["quotation_no"],
                    amount       = quotation["amount"],
                    quote_type   = quotation["quote_type"],
                    line_items   = quotation["line_items"],
                    lead_ids     = quotation.get("lead_ids", []),
                    pic_ids      = quotation.get("pic_ids", []),
                    package_name = quotation.get("package_type_text") or None,
                    hdrs         = hdrs,
                )
                print(f"[INFO] Project created: {project_id}", file=sys.stderr)

                # Auto-populate Add-on Products from quotation line items
                addon_slugs = extract_addon_slugs(quotation["line_items"])
                if addon_slugs:
                    try:
                        requests.patch(
                            f"https://api.notion.com/v1/pages/{project_id}",
                            headers=hdrs,
                            json={"properties": {
                                "Add-on Products": {
                                    "multi_select": [{"name": s} for s in addon_slugs]
                                }
                            }},
                            timeout=10,
                        )
                        print(
                            f"[INFO] Add-on Products set on project: {addon_slugs}",
                            file=sys.stderr,
                        )
                    except Exception as e:
                        print(f"[WARN] Could not set Add-on Products: {e}", file=sys.stderr)

            # 3. Back-link Project onto Invoice and Quotation (non-fatal if field missing)
            inv_linked  = link_project_to_invoice(inv_id, project_id, hdrs)
            quo_linked  = link_project_to_quotation(page_id, project_id, hdrs)
            print(f"[INFO] Back-linked Project → Invoice:{inv_linked}  Quotation:{quo_linked}",
                  file=sys.stderr)

            self._respond(200, {
                "status":       "success",
                "quotation_no": quotation["quotation_no"],
                "invoice_id":   inv_id,
                "invoice_no":   new_inv.get("properties", {}).get("Invoice No.", {}).get("title", [{}])[0].get("plain_text", ""),
                "invoice_type": "Full Payment" if quotation["payment_terms"] == "Full Upfront" else "Deposit",
                "invoice_pdf":  pdf_url,
                "project_id":   project_id,
                "line_items":   len(quotation["line_items"]),
            })

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)

