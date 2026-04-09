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

# Map Lead Package Type / Interest → Quotation Quote Type
PACKAGE_QUOTE_TYPE_MAP = {
    "modular os":    "New Business",
    "revenue os":    "New Business",
    "full agency os":"New Business",
    "workflow os":   "New Business",
    "sales crm":     "New Business",
    "complete os":   "New Business",
    "custom os":     "New Business",
    "expansion":     "Expansion",
    "renewal":       "Renewal",
    "service":       "Service/Maintenance",
    "maintenance":   "Service/Maintenance",
    "add-on":        "Expansion",
    "addon":         "Expansion",
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


def extract_lead_info(props):
    """Pull Company relation, Package Type, and Quote Type hint from a Lead page."""
    company_ids = [r["id"].replace("-", "")
                   for r in props.get("Company", {}).get("relation", [])]

    # Derive quote type from Package Type select
    pkg_raw = (props.get("Package Type", {}).get("select") or {}).get("name", "").lower()
    quote_type = "New Business"
    for key, val in PACKAGE_QUOTE_TYPE_MAP.items():
        if key in pkg_raw:
            quote_type = val
            break

    # Also check Interest multi_select if Package Type blank
    if pkg_raw == "":
        for item in props.get("Interest", {}).get("multi_select", []):
            key_lower = item.get("name", "").lower()
            for key, val in PACKAGE_QUOTE_TYPE_MAP.items():
                if key in key_lower:
                    quote_type = val
                    break

    return company_ids, quote_type


def create_quotation_page(lead_id, company_ids, quote_type, hdrs):
    """Create a new Quotation page and return its id + Notion URL."""
    today = date.today().isoformat()

    props = {
        # Title left blank — Notion unique_id auto-generates Quotation No.
        "Quotation No.": {"title": [{"text": {"content": ""}}]},
        "Status":        {"select": {"name": "Draft"}},
        "Quote Type":    {"select": {"name": quote_type}},
        "Issue Date":    {"date": {"start": today}},
        "Payment Terms": {"select": {"name": "50% Deposit"}},
    }

    if lead_id:
        props["Lead"] = {"relation": [{"id": lead_id}]}

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
    return page_id, url


def write_back_url(triggering_page_id, quotation_url, hdrs):
    """Write the new quotation URL back to 'Open Quotation →' on the triggering page."""
    try:
        r = requests.patch(
            f"https://api.notion.com/v1/pages/{triggering_page_id}",
            headers=hdrs,
            json={"properties": {"Open Quotation \u2192": {"url": quotation_url}}},
            timeout=10,
        )
        if r.ok:
            print(f"[INFO] Wrote quotation URL back to triggering page", file=sys.stderr)
        else:
            print(f"[WARN] Write-back failed {r.status_code}: {r.text[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] write_back_url: {e}", file=sys.stderr)


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
    quote_type  = "New Business"

    if source_type == "lead":
        lead_id = page_id
        company_ids, quote_type = extract_lead_info(props)
        print(f"[INFO] Lead → Companies: {company_ids}, Quote Type: {quote_type}", file=sys.stderr)

    elif source_type == "company":
        company_ids = [page_id]
        print(f"[INFO] Company: {page_id}", file=sys.stderr)

    # ── Create Quotation ──────────────────────
    quot_id, quot_url = create_quotation_page(lead_id, company_ids, quote_type, hdrs)
    print(f"[INFO] Created Quotation: {quot_id} → {quot_url}", file=sys.stderr)

    # ── Write URL back to triggering page so user can click to open ──
    write_back_url(page_id, quot_url, hdrs)

    return {
        "status":        "success",
        "source_type":   source_type,
        "quotation_id":  quot_id,
        "quotation_url": quot_url,
        "quote_type":    quote_type,
        "lead_id":       lead_id,
        "company_ids":   company_ids,
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
