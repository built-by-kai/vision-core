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

QUO_PATTERN = re.compile(r"^QUO-(\d{4})-(\d{4})$")
INV_SUFFIX  = {
    "Deposit":       "-D",
    "Supplementary": "-S",
    "Final Payment": "-F",
    "Retainer":      "-R",
    "Full Payment":  "",
}

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
            unit_price  = (props.get("Unit Price", {}).get("number") or
                           props.get("Rate",       {}).get("number") or 0)
            amount      = (props.get("Amount", {}).get("number") or
                           props.get("Total",  {}).get("formula", {}).get("number") or
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

    # PIC / Client relation IDs (to populate Client field on Invoice)
    pic_ids = [rel["id"] for rel in props.get("PIC", {}).get("relation", [])]

    # Already-linked invoices (avoid creating duplicates)
    existing_invoices = [rel["id"] for rel in props.get("Invoice", {}).get("relation", [])]

    # Fetch line items from the quotation's child inline DB
    line_items = fetch_line_items(page_id, hdrs)

    return {
        "quotation_no":      quotation_no,
        "amount":            amount,
        "payment_terms":     payment_terms,
        "issue_date":        issue_date,
        "status":            status,
        "quote_type":        quote_type,
        "company_ids":       company_ids,
        "company_name":      company_name,
        "pic_ids":           pic_ids,
        "existing_invoices": existing_invoices,
        "line_items":        line_items,
    }


def create_invoice(quotation_id, quotation_data, hdrs):
    """Create the Invoice page in Notion linked to the Quotation. Status = Draft."""
    today  = datetime.now().date().isoformat()
    terms  = quotation_data.get("payment_terms", "")
    amount = quotation_data.get("amount", 0)
    quo_no = quotation_data.get("quotation_no", "")

    # Determine invoice type
    if terms == "Full Upfront":
        inv_type   = "Full Payment"
        dep_amount = None
        due_date   = (datetime.now() + timedelta(days=7)).date().isoformat()
    else:
        # 50% Deposit (default)
        inv_type   = "Deposit"
        dep_amount = round(amount * 0.5, 2) if amount else None
        due_date   = (datetime.now() + timedelta(days=7)).date().isoformat()

    # Format invoice number immediately
    inv_no = format_invoice_number(quo_no, inv_type)

    # Payment balance = Total - Deposit Amount
    if dep_amount is not None:
        pay_balance = round(amount - dep_amount, 2)
    else:
        pay_balance = None

    # Build properties
    props = {
        "Invoice No.":      {"title": [{"text": {"content": inv_no}}]},
        "Invoice Type":     {"select": {"name": inv_type}},
        "Status":           {"select": {"name": "Draft"}},
        "Issue Date":       {"date": {"start": today}},
        "Total Amount":     {"number": amount},
        "Quotation":        {"relation": [{"id": quotation_id}]},
        "Payment Method":   {"select": {"name": "Bank Transfer"}},
    }

    if quotation_data.get("company_ids"):
        props["Company"] = {"relation": [{"id": quotation_data["company_ids"][0]}]}

    # Client / PIC relation
    if quotation_data.get("pic_ids"):
        props["Client"] = {"relation": [{"id": quotation_data["pic_ids"][0]}]}

    if dep_amount is not None:
        props["Deposit Amount"] = {"number": dep_amount}

    if pay_balance is not None:
        props["Payment Balance"] = {"number": pay_balance}

    if inv_type == "Deposit":
        props["Deposit Due"] = {"date": {"start": due_date}}
    else:
        props["Balance Due"] = {"date": {"start": due_date}}

    body = {
        "parent":     {"database_id": INVOICE_DB},
        "icon":       {"type": "emoji", "emoji": "🧾"},
        "properties": props,
    }

    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs, json=body, timeout=15)
    if not r.ok:
        print(f"[WARN] Create invoice {r.status_code}: {r.text}", file=sys.stderr)
        raise ValueError(f"Notion rejected invoice creation ({r.status_code}): {r.text}")
    return r.json()


def create_project(company_ids, company_name, quotation_id, invoice_id,
                   quotation_no, amount, quote_type, line_items, hdrs):
    """
    Create a Project page as the central hub for this client system build.
    Links Company, Quotation, and Invoice. Writes line items as Notes blocks.
    Returns the new project page ID.
    """
    project_name = f"{company_name} — {quotation_no}" if company_name else quotation_no

    props = {
        "Project Name": {"title": [{"text": {"content": project_name}}]},
        "Status":       {"select": {"name": "Deposit Paid"}},
        "Phase":        {"select": {"name": "Phase 1"}},
        "Total Value":  {"number": amount},
        "Quotation":    {"relation": [{"id": quotation_id}]},
        "Invoice":      {"relation": [{"id": invoice_id}]},
    }

    if company_ids:
        props["Company"] = {"relation": [{"id": company_ids[0]}]}

    if quote_type:
        props["Package"] = {"select": {"name": quote_type}}

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

    body = {
        "parent":     {"database_id": PROJECTS_DB},
        "icon":       {"type": "emoji", "emoji": "🏗️"},
        "properties": props,
        "children":   notes_blocks,
    }

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

            # Guard: only create if Approved
            if quotation["status"] != "Approved":
                self._respond(200, {
                    "status": "skipped",
                    "reason": f"Quotation status is '{quotation['status']}', not Approved",
                }); return

            # Guard: don't create duplicate if an invoice already exists
            if quotation["existing_invoices"]:
                self._respond(200, {
                    "status":      "skipped",
                    "reason":      "Invoice already exists for this quotation",
                    "invoice_ids": quotation["existing_invoices"],
                }); return

            # 1. Create Invoice
            new_inv = create_invoice(page_id, quotation, hdrs)
            inv_id  = new_inv["id"]
            print(f"[INFO] Invoice created: {inv_id}", file=sys.stderr)

            # 2. Create Project hub
            project_id = create_project(
                company_ids  = quotation["company_ids"],
                company_name = quotation["company_name"],
                quotation_id = page_id,
                invoice_id   = inv_id,
                quotation_no = quotation["quotation_no"],
                amount       = quotation["amount"],
                quote_type   = quotation["quote_type"],
                line_items   = quotation["line_items"],
                hdrs         = hdrs,
            )
            print(f"[INFO] Project created: {project_id}", file=sys.stderr)

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
                "project_id":   project_id,
                "line_items":   len(quotation["line_items"]),
            })

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)
