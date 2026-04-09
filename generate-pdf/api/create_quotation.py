"""
create_quotation.py
POST /api/create_quotation

Called by a Notion button automation on either:
  - Leads CRM page  → payload: { "page_id": "<lead_page_id>", "source": "lead" }
  - Companies page  → payload: { "page_id": "<company_page_id>", "source": "company" }

Notion also wraps button payloads as:
  { "source": { "page_id": "...", "type": "page_mention" }, "data": {...} }
  or  { "data": { "page_id": "..." } }
  or just { "page_id": "..." }

The endpoint:
  1. Detects whether the triggering page is a Lead or a Company
  2. If Lead  → fetches linked Company + PIC, sets Lead relation on Quotation
  3. If Company → uses Company directly, no Lead linked
  4. Creates a new Quotation page in Quotations DB with:
       - Quotation No.  : auto (title left blank — Notion unique_id fills it)
       - Lead           : [lead page] (if from Lead)
       - Company        : [company page]
       - Status         : Draft
       - Quote Type     : derived from Lead's Package Type / Interest, else "New Business"
       - Issue Date     : today
       - Payment Terms  : 50% Deposit (default)
  5. Returns { "quotation_url": "...", "quotation_id": "..." }

DBs
───
Quotations  : f8167f0bda054307b90b17ad6b9c5cf8
Leads CRM   : 8690d55c4d0449068c51ef49d92a26a2
Companies   : 33c8b289e31a80fe82d2ccd18bcaec68
Products    : 33c8b289e31a80bebdf1ecd506e5ccc3
"""

import json
import os
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler

import requests

# ── DB IDs ────────────────────────────────────
QUOTATIONS_DB = "f8167f0bda054307b90b17ad6b9c5cf8"
LEADS_DB      = "8690d55c4d0449068c51ef49d92a26a2"
COMPANIES_DB  = "33c8b289e31a80fe82d2ccd18bcaec68"
PRODUCTS_DB   = "33c8b289e31a80bebdf1ecd506e5ccc3"

# Exact match: Package Type select value → Product slug in Products DB
# These match the option names set on Leads CRM Package Type field exactly.
PACKAGE_SLUG_MAP = {
    "operations os":              "operations-os",
    "sales os":                   "sales-os",
    "business os":                "business-os",
    "business os – phase by phase": "business-os-phase",
    "starter os":                 "starter-os",
}

# Fallback keyword map for Interest multi-select and legacy/partial matches
INTEREST_SLUG_MAP = {
    "operations os":                  "operations-os",
    "sales os":                       "sales-os",
    "business os":                    "business-os",
    "starter os":                     "starter-os",
    "additional module":              "add-on-module-os",
    "automation":                     "automation-within-db",
    "advanced dashboard":             "advanced-dashboard",
    "custom widget":                  "custom-widget",
    "api / external integration":     "api-integration",
    "automation & workflow integration": "workflow-integration",
    "lead capture system":            "lead-capture",
    "client portal view":             "client-portal",
    "ai agent integration":           "ai-agent",
}


# ── Helpers ───────────────────────────────────
def _hdrs():
    key = os.environ.get("NOTION_API_KEY", "")
    if not key:
        raise ValueError("NOTION_API_KEY not set")
    return {
        "Authorization":  f"Bearer {key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def get_page(page_id, hdrs):
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                     headers=hdrs, timeout=15)
    r.raise_for_status()
    return r.json()


def detect_source(page_id, hdrs):
    """
    Return ("lead"|"company"|"unknown", props dict).
    A Lead page has a 'Stage' status property.
    A Company page has a 'Company' title property (key varies) and no Stage.
    """
    page  = get_page(page_id, hdrs)
    props = page.get("properties", {})

    if "Stage" in props and props["Stage"].get("type") == "status":
        return "lead", props
    # Check if it's a company: look for title field
    for v in props.values():
        if v.get("type") == "title":
            # Company pages have Company as title; Lead pages have Lead Name
            # If there's no Stage, it's a Company
            return "company", props
    return "unknown", props


def fetch_product_info(slug, hdrs):
    """
    Query Products DB for the given slug.
    Returns dict: {id, name, price, quote_type}.
    Falls back to safe defaults on any error.
    """
    default = {"id": None, "name": None, "price": None, "quote_type": "New Business"}
    try:
        r = requests.post(
            f"https://api.notion.com/v1/databases/{PRODUCTS_DB}/query",
            headers=hdrs,
            json={"filter": {"property": "Slug", "rich_text": {"equals": slug}}},
            timeout=10,
        )
        if r.ok:
            results = r.json().get("results", [])
            if results:
                p     = results[0]
                props = p.get("properties", {})
                qt    = (props.get("Quote Type", {}).get("select") or {}).get("name", "New Business")
                name  = _plain(props.get("Product Name", {}).get("title", []))
                price = props.get("Price", {}).get("number")
                pid   = p["id"].replace("-", "")
                print(f"[INFO] Product found: '{name}' slug='{slug}' quote_type='{qt}'", file=sys.stderr)
                return {"id": pid, "name": name, "price": price, "quote_type": qt}
        print(f"[WARN] No product found for slug '{slug}'", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] fetch_product_info: {e}", file=sys.stderr)
    return default


def create_line_items_db(page_id, hdrs):
    """
    Append a child_database block called 'Line Items' to the quotation page.
    Then patch its schema to add Product relation, Qty, Unit Price.
    Returns the new DB id (str, no dashes).
    """
    # 1. Append child_database block
    r = requests.patch(
        f"https://api.notion.com/v1/blocks/{page_id}/children",
        headers=hdrs,
        json={"children": [{"type": "child_database", "child_database": {"title": "Line Items"}}]},
        timeout=15,
    )
    if not r.ok:
        raise ValueError(f"child_database append failed {r.status_code}: {r.text[:200]}")
    blocks = r.json().get("results", [])
    if not blocks:
        raise ValueError("No block returned after appending child_database")
    db_id = blocks[0]["id"].replace("-", "")
    print(f"[INFO] Line Items DB created: {db_id}", file=sys.stderr)

    # 2. Update schema — add Product relation, Qty, Unit Price
    schema_r = requests.patch(
        f"https://api.notion.com/v1/databases/{db_id}",
        headers=hdrs,
        json={"properties": {
            "Product": {
                "type": "relation",
                "relation": {
                    "database_id": PRODUCTS_DB,
                    "type": "single_property",
                    "single_property": {},
                },
            },
            "Qty":        {"number": {"format": "number"}},
            "Unit Price": {"number": {"format": "ringgit"}},
        }},
        timeout=15,
    )
    if not schema_r.ok:
        print(f"[WARN] Line Items schema patch failed: {schema_r.text[:200]}", file=sys.stderr)

    return db_id


def create_line_item(db_id, product_id, product_name, price, hdrs):
    """Create the first line item row in the Line Items DB."""
    props = {
        "Name": {"title": [{"text": {"content": product_name or "Professional Services"}}]},
        "Qty":  {"number": 1},
    }
    if product_id:
        props["Product"] = {"relation": [{"id": product_id}]}
    if price is not None:
        props["Unit Price"] = {"number": float(price)}

    r = requests.post(
        "https://api.notion.com/v1/pages",
        headers=hdrs,
        json={"parent": {"database_id": db_id}, "properties": props},
        timeout=15,
    )
    if not r.ok:
        print(f"[WARN] Line item create failed {r.status_code}: {r.text[:200]}", file=sys.stderr)
    else:
        print(f"[INFO] Line item created: '{product_name}' × 1 @ RM{price}", file=sys.stderr)
    return r.ok


def extract_lead_info(props, hdrs):
    """
    Pull Company relation and full product info from a Lead page.
    Returns (company_ids, product_dict) where product_dict has
    {id, name, price, quote_type}.
    """
    company_ids = [r["id"].replace("-", "")
                   for r in props.get("Company", {}).get("relation", [])]

    # 1. Exact match on Package Type (primary OS package select)
    pkg_raw = (props.get("Package Type", {}).get("select") or {}).get("name", "").lower().strip()
    slug = PACKAGE_SLUG_MAP.get(pkg_raw)

    # 2. Fall back to first Interest item that matches (multi-select)
    if not slug:
        for item in props.get("Interest", {}).get("multi_select", []):
            key_lower = item.get("name", "").lower().strip()
            slug = INTEREST_SLUG_MAP.get(key_lower)
            if slug:
                break

    print(f"[INFO] Package Type='{pkg_raw}' → slug='{slug or 'not found'}'", file=sys.stderr)

    # 3. Fetch full product info from Products DB
    product = fetch_product_info(slug or "operations-os", hdrs)

    return company_ids, product


def create_quotation_page(lead_id, company_ids, quote_type, hdrs):
    """Create a new Quotation page and return its id + Notion URL."""
    today = date.today().isoformat()

    # ── Step 1: create with safe core properties only ──
    props = {
        # Title left blank — Notion unique_id auto-generates Quotation No.
        "Quotation No.": {"title": [{"text": {"content": ""}}]},
        "Status":        {"select": {"name": "Draft"}},
        "Issue Date":    {"date": {"start": today}},
        "Payment Terms": {"select": {"name": "50% Deposit"}},
    }

    if company_ids:
        props["Company"] = {"relation": [{"id": cid} for cid in company_ids[:1]]}

    body = {
        "parent":     {"database_id": QUOTATIONS_DB},
        "properties": props,
    }

    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs, json=body, timeout=15)
    if not r.ok:
        raise ValueError(f"Notion create page {r.status_code}: {r.text[:400]}")

    page    = r.json()
    page_id = page["id"].replace("-", "")
    url     = page.get("url", f"https://notion.so/{page_id}")
    print(f"[INFO] Quotation page created: {page_id}", file=sys.stderr)

    # ── Step 2: patch Quote Type (select — may not exist yet) ──
    try:
        patch_props = {"Quote Type": {"select": {"name": quote_type}}}
        pr = requests.patch(f"https://api.notion.com/v1/pages/{page_id}",
                            headers=hdrs,
                            json={"properties": patch_props}, timeout=10)
        if not pr.ok:
            print(f"[WARN] Quote Type patch failed: {pr.text[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] Quote Type patch error: {e}", file=sys.stderr)

    # ── Step 3: patch Deal Source relation (may be named differently) ──
    if lead_id:
        linked = False
        for field_name in ("Deal Source", "Lead", "Deals", "Source"):
            try:
                pr = requests.patch(
                    f"https://api.notion.com/v1/pages/{page_id}",
                    headers=hdrs,
                    json={"properties": {field_name: {"relation": [{"id": lead_id}]}}},
                    timeout=10,
                )
                if pr.ok:
                    print(f"[INFO] Lead linked via field '{field_name}'", file=sys.stderr)
                    linked = True
                    break
                else:
                    print(f"[WARN] Field '{field_name}' failed: {pr.status_code}", file=sys.stderr)
            except Exception as e:
                print(f"[WARN] Lead link error ({field_name}): {e}", file=sys.stderr)
        if not linked:
            print(f"[WARN] Could not link Lead — check property name on Quotations DB", file=sys.stderr)

    return page_id, url




def process(payload):
    hdrs = _hdrs()

    # ── Parse page_id from various Notion webhook shapes ──
    raw_page_id = None

    # Shape 1: { "source": { "page_id": "..." } }
    source = payload.get("source") or {}
    if isinstance(source, dict):
        raw_page_id = source.get("page_id") or source.get("id")

    # Shape 2: { "data": { "page_id": "..." } }
    if not raw_page_id:
        data = payload.get("data") or {}
        if isinstance(data, dict):
            raw_page_id = data.get("page_id") or data.get("id")

    # Shape 3: flat { "page_id": "..." }
    if not raw_page_id:
        raw_page_id = payload.get("page_id") or payload.get("id")

    if not raw_page_id:
        raise ValueError("No page_id found in payload")

    page_id = raw_page_id.replace("-", "")
    print(f"[INFO] Triggering page: {page_id}", file=sys.stderr)

    # ── Detect Lead vs Company ─────────────────
    # Allow caller to hint via "source" string key (separate from source object)
    hint = payload.get("type", "")  # "lead" or "company" if explicitly set

    if hint == "lead":
        source_type = "lead"
        props = get_page(page_id, hdrs).get("properties", {})
    elif hint == "company":
        source_type = "company"
        props = get_page(page_id, hdrs).get("properties", {})
    else:
        source_type, props = detect_source(page_id, hdrs)

    print(f"[INFO] Detected source type: {source_type}", file=sys.stderr)

    # ── Build quotation fields ─────────────────
    lead_id     = None
    company_ids = []
    product     = {"id": None, "name": None, "price": None, "quote_type": "New Business"}

    if source_type == "lead":
        lead_id = page_id
        company_ids, product = extract_lead_info(props, hdrs)
        print(f"[INFO] Lead → Companies: {company_ids}, Product: {product['name']}, Quote Type: {product['quote_type']}", file=sys.stderr)

    elif source_type == "company":
        company_ids = [page_id]
        print(f"[INFO] Company: {page_id}", file=sys.stderr)

    quote_type = product["quote_type"]

    # ── Create Quotation page ─────────────────
    quot_id, quot_url = create_quotation_page(lead_id, company_ids, quote_type, hdrs)
    print(f"[INFO] Created Quotation: {quot_id} → {quot_url}", file=sys.stderr)

    # ── Auto-create Line Items DB + first line item ──
    # Only when triggered from a lead with a resolved product
    if source_type == "lead" and product.get("id"):
        try:
            li_db_id = create_line_items_db(quot_id, hdrs)
            create_line_item(
                li_db_id,
                product["id"],
                product["name"],
                product["price"],
                hdrs,
            )
        except Exception as e:
            # Non-fatal — quotation still created, user can add line items manually
            print(f"[WARN] Auto line item failed: {e}", file=sys.stderr)

    return {
        "status":        "success",
        "source_type":   source_type,
        "quotation_id":  quot_id,
        "quotation_url": quot_url,
        "quote_type":    quote_type,
        "lead_id":       lead_id,
        "company_ids":   company_ids,
        "line_item":     product.get("name"),
    }


# ── Vercel handler ────────────────────────────
class handler(BaseHTTPRequestHandler):

    def _respond(self, code, body_dict):
        body = json.dumps(body_dict).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._respond(200, {
            "service": "Vision Core — Create Quotation",
            "status":  "ready",
            "usage":   "POST with {page_id} from a Lead or Company page",
        })

    def do_POST(self):
        try:
            length  = int(self.headers.get("Content-Length", 0))
            raw     = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw) if raw else {}

            print(f"[DEBUG] create_quotation payload: {json.dumps(payload)[:400]}", file=sys.stderr)

            result = process(payload)
            self._respond(200, result)

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[HTTP] {fmt % args}", file=sys.stderr)
