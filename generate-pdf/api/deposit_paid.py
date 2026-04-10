"""
deposit_paid.py
POST /api/deposit_paid   { "page_id": "<invoice_page_id>" }

Triggered by a Notion button "Mark Deposit Paid" on the Invoice page.

What it does:
  1. Validates the invoice is a Deposit or Full Payment type
  2. Updates Invoice:
       - Status          → Deposit Received
       - Deposit Paid    → today
  3. Updates linked Projects DB entry:
       - Status          → Build Started
  4. Advances linked Lead stage → Active
  5. Builds & writes WhatsApp link with implementation form URL to Invoice.WA Link
  6. Returns { wa_url, form_url, project_id, lead_id }

DBs
───
Invoices     : 9227dda9c4be42a1a4c6b1bce4862f8c
Projects     : 5719b2672d3442a29a22637a35398260
Leads CRM    : 8690d55c4d0449068c51ef49d92a26a2
Companies    : 33c8b289e31a80fe82d2ccd18bcaec68
"""
import json
import os
import re
import sys
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler
from urllib.parse import quote as url_quote

import requests

INVOICES_DB  = "9227dda9c4be42a1a4c6b1bce4862f8c"
PROJECTS_DB  = "5719b2672d3442a29a22637a35398260"
LEADS_DB     = "8690d55c4d0449068c51ef49d92a26a2"
COMPANIES_DB = "33c8b289e31a80fe82d2ccd18bcaec68"

PHASES_DB    = "33d8b289e31a81d896bfdb314521dc7b"
TASKS_DB     = "b87d0a44df344b178f14c7e94ce520b0"

IMPL_FORM_BASE = "https://vision-core-delta.vercel.app/api/implementation_form"

# Map Quotation Quote Type / Package → implementation form pkg slug
QUOTE_TYPE_TO_SLUG = {
    "full agency os":  "full-agency-os",
    "business os":     "full-agency-os",
    "workflow os":     "workflow-os",
    "operations os":   "workflow-os",
    "sales os":        "sales-crm",
    "sales crm":       "sales-crm",
    "revenue os":      "revenue-os",
    "modular os":      "modular-os",
    "starter os":      "modular-os",
    "complete os":     "complete-os",
    "custom os":       "custom-os",
}


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


def patch_page(page_id, props, hdrs):
    r = requests.patch(f"https://api.notion.com/v1/pages/{page_id}",
                       headers=hdrs, json={"properties": props}, timeout=10)
    if not r.ok:
        print(f"[WARN] patch {page_id[:8]}: {r.status_code} {r.text[:200]}", file=sys.stderr)
    return r.ok


def clean_phone(phone):
    digits = re.sub(r"\D", "", phone or "")
    if digits.startswith("0"):
        digits = "6" + digits
    return digits


def get_pic_phone(company_id, hdrs):
    """Fetch Current PIC phone from Company.People."""
    try:
        cp = get_page(company_id, hdrs).get("properties", {})
        people = (cp.get("People", {}).get("relation", [])
                  or cp.get("Clients", {}).get("relation", []))
        for rel in people:
            pp = get_page(rel["id"], hdrs).get("properties", {})
            if pp.get("Current PIC?", {}).get("checkbox", False):
                for k in ["Phone", "phone", "Mobile"]:
                    prop = pp.get(k, {})
                    if prop.get("type") == "phone_number":
                        return prop.get("phone_number") or ""
        # fallback: first person
        for rel in people[:1]:
            pp = get_page(rel["id"], hdrs).get("properties", {})
            for k in ["Phone", "phone", "Mobile"]:
                prop = pp.get(k, {})
                if prop.get("type") == "phone_number":
                    return prop.get("phone_number") or ""
    except Exception as e:
        print(f"[WARN] get_pic_phone: {e}", file=sys.stderr)
    return ""


def build_form_url(company_id, pkg_slug):
    return f"{IMPL_FORM_BASE}?c={company_id}&pkg={pkg_slug}"


def build_wa_url(phone, company_name, form_url):
    phone_clean = clean_phone(phone)
    if not phone_clean:
        return ""
    lines = [
        f"Hi {company_name}! 👋",
        "",
        "Your deposit has been received — thank you!",
        "",
        "To kick off your onboarding, please fill in our Implementation Intake Form so we can "
        "tailor your system to your team:",
        "",
        f"📋 {form_url}",
        "",
        "This should take about 10–15 minutes. The more detail you provide, the faster we can build.",
        "",
        "Looking forward to building with you!",
        "— Vision Core",
    ]
    return f"https://wa.me/{phone_clean}?text={url_quote(chr(10).join(lines))}"


SETUP_PROJECT_URL = "https://opxio.vercel.app/api/setup_project"


def trigger_setup_project(project_id):
    """
    Call the setup_project endpoint to auto-generate phases and tasks
    for a project based on its Package type in the Phase Templates DB.
    """
    try:
        r = requests.post(
            SETUP_PROJECT_URL,
            json={"page_id": project_id},
            timeout=25,
        )
        if r.ok:
            data = r.json()
            print(f"[INFO] setup_project: {data.get("phases_created", 0)} phases, {data.get("tasks_created", 0)} tasks", file=sys.stderr)
            return data.get("phases_created", 0), data.get("tasks_created", 0)
        else:
            print(f"[WARN] setup_project returned {r.status_code}: {r.text[:200]}", file=sys.stderr)
            return 0, 0
    except Exception as e:
        print(f"[WARN] setup_project call failed: {e}", file=sys.stderr)
        return 0, 0

def process(payload):
    hdrs = _hdrs()

    # Parse page_id
    raw_id = None
    src = payload.get("source") or {}
    if isinstance(src, dict):
        raw_id = src.get("page_id") or src.get("id")
    if not raw_id:
        data = payload.get("data") or {}
        if isinstance(data, dict):
            raw_id = data.get("page_id") or data.get("id")
    if not raw_id:
        raw_id = payload.get("page_id") or payload.get("id")
    if not raw_id:
        raise ValueError("No page_id in payload")
    page_id = raw_id.replace("-", "")

    inv = get_page(page_id, hdrs)
    props = inv.get("properties", {})

    # Validate invoice type
    inv_type = (props.get("Invoice Type", {}).get("select") or {}).get("name", "")
    status   = (props.get("Status", {}).get("select") or {}).get("name", "")
    if inv_type == "Final Payment":
        raise ValueError("This is a Final Payment invoice — use Mark Final Paid instead")
    if status == "Deposit Received":
        raise ValueError("Deposit already marked as received")

    print(f"[INFO] Processing deposit paid for invoice {page_id[:8]} (type={inv_type})", file=sys.stderr)

    today = date.today().isoformat()

    # ── 1. Update Invoice ─────────────────────
    patch_page(page_id, {
        "Status":       {"select": {"name": "Deposit Received"}},
        "Deposit Paid": {"date": {"start": today}},
    }, hdrs)
    print(f"[INFO] Invoice → Deposit Received", file=sys.stderr)

    # ── 2. Gather linked IDs ──────────────────
    company_ids = [r["id"].replace("-", "") for r in props.get("Company", {}).get("relation", [])]
    company_id  = company_ids[0] if company_ids else None

    quotation_ids = [r["id"].replace("-", "") for r in props.get("Quotation", {}).get("relation", [])]
    quotation_id  = quotation_ids[0] if quotation_ids else None

    lead_ids = [r["id"].replace("-", "") for r in props.get("Deal Source", {}).get("relation", [])]
    lead_id  = lead_ids[0] if lead_ids else None

    # Also try to find lead via Quotation → Deal Source relation if not directly on Invoice
    if not lead_id and quotation_id:
        try:
            qp = get_page(quotation_id, hdrs).get("properties", {})
            lead_ids = [r["id"].replace("-", "") for r in qp.get("Deal Source", {}).get("relation", [])]
            lead_id  = lead_ids[0] if lead_ids else None
        except Exception as e:
            print(f"[WARN] Lead from Quotation: {e}", file=sys.stderr)

    # Also try via Leads DB query on Quotation relation
    if not lead_id and quotation_id:
        try:
            dr = requests.post(
                f"https://api.notion.com/v1/databases/{LEADS_DB}/query",
                headers=hdrs,
                json={"filter": {"property": "Quotation", "relation": {"contains": quotation_id}}},
                timeout=10,
            )
            if dr.ok:
                results = dr.json().get("results", [])
                if results:
                    lead_id = results[0]["id"].replace("-", "")
        except Exception as e:
            print(f"[WARN] Lead via DB query: {e}", file=sys.stderr)

    # ── 3. Advance Lead stage → Building ───────
    if lead_id:
        lp = get_page(lead_id, hdrs).get("properties", {})
        current_stage = (lp.get("Stage", {}).get("status") or {}).get("name", "")
        if current_stage not in ("Building", "Balance Due", "Delivered",
                                 "Active", "Closed – Paid"):   # legacy names
            patch_page(lead_id, {"Stage": {"status": {"name": "Building"}}}, hdrs)
            print(f"[INFO] Lead {lead_id[:8]} → Building", file=sys.stderr)
    else:
        print(f"[WARN] No lead found for invoice", file=sys.stderr)

    # ── 4. Update Projects entry → Build Started ──
    project_id = None
    impl_project_ids = [r["id"].replace("-", "")
                        for r in props.get("Implementation", {}).get("relation", [])]

    # If not directly linked on invoice, search Projects DB via Quotation
    if not impl_project_ids and quotation_id:
        try:
            pr = requests.post(
                f"https://api.notion.com/v1/databases/{PROJECTS_DB}/query",
                headers=hdrs,
                json={"filter": {"property": "Quotation", "relation": {"contains": quotation_id}}},
                timeout=10,
            )
            if pr.ok:
                results = pr.json().get("results", [])
                if results:
                    impl_project_ids = [results[0]["id"].replace("-", "")]
        except Exception as e:
            print(f"[WARN] Project lookup: {e}", file=sys.stderr)

    if impl_project_ids:
        project_id = impl_project_ids[0]
        patch_page(project_id, {
            "Status":     {"select": {"name": "Build Started"}},
            "Start Date": {"date": {"start": today}},
        }, hdrs)
        # Also link Invoice → Implementation if not already
        patch_page(page_id, {
            "Implementation": {"relation": [{"id": project_id}]}
        }, hdrs)
        print(f"[INFO] Project {project_id[:8]} → Build Started", file=sys.stderr)

        # ── 4a. Auto-generate phases & tasks via setup_project ──
        phases_count, tasks_count = trigger_setup_project(project_id)
    else:
        phases_count, tasks_count = 0, 0
        print(f"[WARN] No Projects entry found for this invoice", file=sys.stderr)

    # ── 5. Get package slug for form URL ──────
    pkg_slug = "full-agency-os"  # default
    if project_id:
        try:
            pp = get_page(project_id, hdrs).get("properties", {})
            pkg_raw = (pp.get("Package", {}).get("select") or {}).get("name", "").lower()
            for key, slug in QUOTE_TYPE_TO_SLUG.items():
                if key in pkg_raw:
                    pkg_slug = slug
                    break
        except Exception:
            pass

    # ── 6. Build WA onboarding message ───────
    company_name = ""
    if company_id:
        try:
            cp = get_page(company_id, hdrs).get("properties", {})
            for v in cp.values():
                if v.get("type") == "title":
                    company_name = _plain(v.get("title", []))
                    break
        except Exception:
            pass

    form_url = build_form_url(company_id or "", pkg_slug)
    pic_phone = get_pic_phone(company_id, hdrs) if company_id else ""
    wa_url    = build_wa_url(pic_phone, company_name or "there", form_url)

    # Write WA Link back to Invoice so user can open WhatsApp immediately
    if wa_url:
        patch_page(page_id, {"WA Link": {"url": wa_url}}, hdrs)
        print(f"[INFO] WA link written to Invoice", file=sys.stderr)
    else:
        print(f"[WARN] No PIC phone — WA link not generated", file=sys.stderr)

    return {
        "status":         "success",
        "invoice_id":     page_id,
        "lead_id":        lead_id,
        "project_id":     project_id,
        "company_id":     company_id,
        "form_url":       form_url,
        "wa_url":         wa_url or None,
        "pkg_slug":       pkg_slug,
        "phases_created": phases_count,
        "tasks_created":  tasks_count,
    }


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
            "service": "Vision Core — Deposit Paid",
            "status":  "ready",
            "usage":   "POST with {page_id} from a Deposit Invoice page",
        })

    def do_POST(self):
        try:
            length  = int(self.headers.get("Content-Length", 0))
            raw     = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw) if raw else {}
            print(f"[DEBUG] deposit_paid: {json.dumps(payload)[:300]}", file=sys.stderr)
            result = process(payload)
            self._respond(200, result)
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[HTTP] {fmt % args}", file=sys.stderr)
