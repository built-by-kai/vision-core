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


# ═══════════════════════════════════════════════════════════════
# TASK TEMPLATES — keyed by package family
# Each phase has: name, day_offset (from project start), duration_days, tasks[]
# Each task has: name, owner, priority, day_offset (relative to phase start)
# ═══════════════════════════════════════════════════════════════

PACKAGE_TEMPLATES = {
    "operations": [
        {"name": "Phase 1 — Discovery & Setup", "day_offset": 0, "duration": 14, "tasks": [
            {"name": "Kick-off call & gather requirements",       "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Audit current workflows & tools",           "owner": "Kai",    "priority": "High",   "day": 1},
            {"name": "Set up Notion workspace structure",         "owner": "Kai",    "priority": "High",   "day": 3},
            {"name": "Configure permissions & sharing",           "owner": "Kai",    "priority": "Medium", "day": 5},
            {"name": "Import existing data & contacts",           "owner": "Kai",    "priority": "Medium", "day": 7},
            {"name": "Client review — Discovery sign-off",        "owner": "Client", "priority": "High",   "day": 12},
        ]},
        {"name": "Phase 2 — Core Build", "day_offset": 14, "duration": 21, "tasks": [
            {"name": "Build task & project management system",    "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Build SOP & documentation hub",             "owner": "Kai",    "priority": "High",   "day": 3},
            {"name": "Build meeting notes & agenda system",       "owner": "Kai",    "priority": "Medium", "day": 7},
            {"name": "Set up automations & recurring tasks",      "owner": "Kai",    "priority": "High",   "day": 10},
            {"name": "Build dashboards & reporting views",        "owner": "Kai",    "priority": "Medium", "day": 14},
            {"name": "Internal QA & testing",                     "owner": "Kai",    "priority": "High",   "day": 18},
        ]},
        {"name": "Phase 3 — Launch & Handover", "day_offset": 35, "duration": 14, "tasks": [
            {"name": "Client walkthrough & training session",     "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Collect feedback & adjustments",            "owner": "Client", "priority": "High",   "day": 3},
            {"name": "Apply revisions",                           "owner": "Kai",    "priority": "High",   "day": 5},
            {"name": "Final handover & documentation",            "owner": "Kai",    "priority": "High",   "day": 10},
            {"name": "Post-launch check-in (1 week)",             "owner": "Kai",    "priority": "Medium", "day": 14},
        ]},
    ],
    "sales": [
        {"name": "Phase 1 — Discovery & CRM Setup", "day_offset": 0, "duration": 14, "tasks": [
            {"name": "Kick-off call & sales process audit",      "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Map sales pipeline stages",                "owner": "Kai",    "priority": "High",   "day": 2},
            {"name": "Set up CRM database & lead tracking",      "owner": "Kai",    "priority": "High",   "day": 4},
            {"name": "Import existing contacts & deals",         "owner": "Kai",    "priority": "Medium", "day": 7},
            {"name": "Client review — Pipeline sign-off",        "owner": "Client", "priority": "High",   "day": 12},
        ]},
        {"name": "Phase 2 — Automation & Workflows", "day_offset": 14, "duration": 21, "tasks": [
            {"name": "Build lead capture & intake forms",        "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Set up follow-up automations",             "owner": "Kai",    "priority": "High",   "day": 4},
            {"name": "Build quotation & proposal system",        "owner": "Kai",    "priority": "High",   "day": 8},
            {"name": "Build sales reporting dashboard",          "owner": "Kai",    "priority": "Medium", "day": 12},
            {"name": "Internal QA & testing",                    "owner": "Kai",    "priority": "High",   "day": 18},
        ]},
        {"name": "Phase 3 — Launch & Training", "day_offset": 35, "duration": 14, "tasks": [
            {"name": "Sales team training session",              "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Collect feedback & adjustments",           "owner": "Client", "priority": "High",   "day": 3},
            {"name": "Apply revisions",                          "owner": "Kai",    "priority": "High",   "day": 5},
            {"name": "Final handover & playbook delivery",       "owner": "Kai",    "priority": "High",   "day": 10},
            {"name": "Post-launch check-in (1 week)",            "owner": "Kai",    "priority": "Medium", "day": 14},
        ]},
    ],
    "complete": [
        {"name": "Phase 1 — Discovery & Architecture", "day_offset": 0, "duration": 14, "tasks": [
            {"name": "Kick-off call & full business audit",      "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Map all departments & workflows",          "owner": "Kai",    "priority": "High",   "day": 2},
            {"name": "Design system architecture & schema",      "owner": "Kai",    "priority": "High",   "day": 5},
            {"name": "Set up master Notion workspace",           "owner": "Kai",    "priority": "High",   "day": 8},
            {"name": "Client review — Architecture sign-off",    "owner": "Client", "priority": "High",   "day": 12},
        ]},
        {"name": "Phase 2 — Operations Build", "day_offset": 14, "duration": 21, "tasks": [
            {"name": "Build task & project management",          "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Build SOP & knowledge base",               "owner": "Kai",    "priority": "High",   "day": 4},
            {"name": "Build meeting & agenda system",            "owner": "Kai",    "priority": "Medium", "day": 8},
            {"name": "Set up operational automations",           "owner": "Kai",    "priority": "High",   "day": 12},
            {"name": "Mid-build client review",                  "owner": "Client", "priority": "High",   "day": 18},
        ]},
        {"name": "Phase 3 — Sales & CRM Build", "day_offset": 35, "duration": 21, "tasks": [
            {"name": "Build CRM & pipeline tracker",            "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Build lead capture & intake",              "owner": "Kai",    "priority": "High",   "day": 4},
            {"name": "Build quotation & invoicing flow",         "owner": "Kai",    "priority": "High",   "day": 8},
            {"name": "Set up sales automations & follow-ups",    "owner": "Kai",    "priority": "High",   "day": 12},
            {"name": "Build sales dashboard & reports",          "owner": "Kai",    "priority": "Medium", "day": 16},
        ]},
        {"name": "Phase 4 — Integration & Launch", "day_offset": 56, "duration": 14, "tasks": [
            {"name": "Cross-link all systems & dashboards",      "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Full system QA & stress test",             "owner": "Kai",    "priority": "High",   "day": 3},
            {"name": "Team training — all departments",          "owner": "Kai",    "priority": "High",   "day": 6},
            {"name": "Collect feedback & final adjustments",     "owner": "Client", "priority": "High",   "day": 9},
            {"name": "Final handover & documentation",           "owner": "Kai",    "priority": "High",   "day": 11},
            {"name": "Post-launch check-in (1 week)",            "owner": "Kai",    "priority": "Medium", "day": 14},
        ]},
    ],
    "modular": [
        {"name": "Phase 1 — Discovery & Setup", "day_offset": 0, "duration": 10, "tasks": [
            {"name": "Kick-off call & scope confirmation",       "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Set up workspace & base structure",        "owner": "Kai",    "priority": "High",   "day": 2},
            {"name": "Import existing data",                     "owner": "Kai",    "priority": "Medium", "day": 5},
            {"name": "Client review — Setup sign-off",           "owner": "Client", "priority": "High",   "day": 8},
        ]},
        {"name": "Phase 2 — Module Build", "day_offset": 10, "duration": 14, "tasks": [
            {"name": "Build core module & databases",            "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Set up automations & views",               "owner": "Kai",    "priority": "High",   "day": 5},
            {"name": "Build dashboard & reporting",              "owner": "Kai",    "priority": "Medium", "day": 9},
            {"name": "Internal QA & testing",                    "owner": "Kai",    "priority": "High",   "day": 12},
        ]},
        {"name": "Phase 3 — Handover", "day_offset": 24, "duration": 7, "tasks": [
            {"name": "Client walkthrough & training",            "owner": "Kai",    "priority": "High",   "day": 0},
            {"name": "Apply feedback & revisions",               "owner": "Kai",    "priority": "High",   "day": 3},
            {"name": "Final handover",                           "owner": "Kai",    "priority": "High",   "day": 5},
            {"name": "Post-launch check-in",                     "owner": "Kai",    "priority": "Medium", "day": 7},
        ]},
    ],
}

# Map package names → template key
PACKAGE_FAMILY = {
    "operations os":   "operations",
    "workflow os":     "operations",
    "sales os":        "sales",
    "sales crm":       "sales",
    "revenue os":      "sales",
    "business os":     "complete",
    "full agency os":  "complete",
    "complete os":     "complete",
    "modular os":      "modular",
    "starter os":      "modular",
    "custom os":       "modular",
}


def create_notion_page(db_id, props, hdrs):
    """Create a page in a Notion database and return its ID."""
    r = requests.post(
        "https://api.notion.com/v1/pages",
        headers=hdrs,
        json={"parent": {"database_id": db_id}, "properties": props},
        timeout=15,
    )
    if not r.ok:
        print(f"[WARN] create page in {db_id[:8]}: {r.status_code} {r.text[:200]}", file=sys.stderr)
        return None
    return r.json().get("id", "").replace("-", "")


def generate_phases_and_tasks(project_id, package_name, start_date_str, hdrs):
    """
    Auto-generate phases and tasks for a project based on its package type.
    Returns (phases_created, tasks_created) counts.
    """
    pkg_lower = package_name.lower().strip()
    family = PACKAGE_FAMILY.get(pkg_lower, "operations")  # default to operations
    template = PACKAGE_TEMPLATES.get(family, PACKAGE_TEMPLATES["operations"])

    start = date.fromisoformat(start_date_str)
    phases_created = 0
    tasks_created = 0

    for phase_idx, phase_tpl in enumerate(template, 1):
        phase_start = start + timedelta(days=phase_tpl["day_offset"])
        phase_end   = phase_start + timedelta(days=phase_tpl["duration"])

        # Create phase in Phases DB
        phase_props = {
            "Phase Name": {"title": [{"text": {"content": phase_tpl["name"]}}]},
            "Project":    {"relation": [{"id": project_id}]},
            "Status":     {"select": {"name": "Not Started" if phase_idx > 1 else "In Progress"}},
            "Phase No.":  {"number": phase_idx},
            "Start Date": {"date": {"start": phase_start.isoformat()}},
            "Due Date":   {"date": {"start": phase_end.isoformat()}},
        }
        phase_id = create_notion_page(PHASES_DB, phase_props, hdrs)
        if not phase_id:
            continue
        phases_created += 1
        print(f"[INFO] Phase {phase_idx} created: {phase_tpl['name']}", file=sys.stderr)

        # Create tasks for this phase
        for task_idx, task_tpl in enumerate(phase_tpl["tasks"], 1):
            task_due = phase_start + timedelta(days=task_tpl["day"])
            task_props = {
                "Task Name": {"title": [{"text": {"content": task_tpl["name"]}}]},
                "Phase":     {"relation": [{"id": phase_id}]},
                "Project":   {"relation": [{"id": project_id}]},
                "Status":    {"select": {"name": "Not Started"}},
                "Owner":     {"select": {"name": task_tpl["owner"]}},
                "Priority":  {"select": {"name": task_tpl["priority"]}},
                "Due Date":  {"date": {"start": task_due.isoformat()}},
                "Task No.":  {"number": task_idx},
            }
            tid = create_notion_page(TASKS_DB, task_props, hdrs)
            if tid:
                tasks_created += 1

        print(f"[INFO] → {len(phase_tpl['tasks'])} tasks created for Phase {phase_idx}", file=sys.stderr)

    return phases_created, tasks_created


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

    # ── 3. Advance Lead stage → Active ───────
    if lead_id:
        lp = get_page(lead_id, hdrs).get("properties", {})
        current_stage = (lp.get("Stage", {}).get("status") or {}).get("name", "")
        if current_stage not in ("Active", "Closed – Paid"):
            patch_page(lead_id, {"Stage": {"status": {"name": "Active"}}}, hdrs)
            print(f"[INFO] Lead {lead_id[:8]} → Active", file=sys.stderr)
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

        # ── 4a. Auto-generate phases & tasks ─────
        try:
            pp = get_page(project_id, hdrs).get("properties", {})
            pkg_raw = (pp.get("Package", {}).get("select") or {}).get("name", "Operations OS")
            phases_count, tasks_count = generate_phases_and_tasks(
                project_id, pkg_raw, today, hdrs
            )
            print(f"[INFO] Auto-generated {phases_count} phases, {tasks_count} tasks", file=sys.stderr)
        except Exception as e:
            phases_count, tasks_count = 0, 0
            print(f"[WARN] Auto-generate phases/tasks failed: {e}", file=sys.stderr)
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
