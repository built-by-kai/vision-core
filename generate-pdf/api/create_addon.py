"""
create_addon.py
POST /api/create_addon   { "page_id": "<project_page_id>" }

Triggered by a "Create Add-on Quotation" button on a Project page.

Flow:
  1. Fetches the Project page → Company, Deal Source (Lead), original Quotation
  2. Creates a new Draft Quotation in Quotations DB:
       - Company + Deal Source linked (same as original)
       - Project linked (so create_invoice won't make a second project)
       - Payment Terms: Full Upfront (add-ons billed in full, not 50/50)
       - Quote Type: same as original package
       - Status: Draft
  3. Creates a blank Products & Services DB on the quotation page
     (user fills in the extra line items in Notion)
  4. Returns the new quotation URL

When the add-on quotation is Approved:
  → create_invoice webhook fires → detects existing Project → creates a
    Supplementary invoice linked to the same project hub (no new project).

Projects DB : 5719b2672d3442a29a22637a35398260
Quotations DB: f8167f0bda054307b90b17ad6b9c5cf8
Products DB  : 33c8b289e31a80bebdf1ecd506e5ccc3
"""

import json
import os
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler

import requests

PROJECTS_DB   = "5719b2672d3442a29a22637a35398260"
QUOTATIONS_DB = "f8167f0bda054307b90b17ad6b9c5cf8"
PRODUCTS_DB   = "33c8b289e31a80bebdf1ecd506e5ccc3"


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


def fetch_project(project_id, hdrs):
    """
    Fetch the Project page and extract Company, Lead (Deal Source),
    original Quotation, and package type.
    """
    r = requests.get(
        f"https://api.notion.com/v1/pages/{project_id}",
        headers=hdrs, timeout=15
    )
    r.raise_for_status()
    props = r.json().get("properties", {})

    # Company relation
    company_ids = [
        rel["id"].replace("-", "")
        for rel in props.get("Company", {}).get("relation", [])
    ]

    # Deal Source (Lead) — stored as "PIC" relation on Projects DB
    # Try multiple field names in priority order
    lead_ids = []
    for field in ("Deal Source", "Lead", "PIC", "Deals"):
        rels = props.get(field, {}).get("relation", [])
        if rels:
            lead_ids = [r2["id"].replace("-", "") for r2 in rels]
            print(f"[INFO] Lead found via field '{field}': {lead_ids}", file=sys.stderr)
            break

    # Original Quotation (for project name / quote type)
    original_quotation_ids = [
        rel["id"].replace("-", "")
        for rel in props.get("Quotation", {}).get("relation", [])
    ]

    # Package / Quote Type
    package = (props.get("Package", {}).get("select") or {}).get("name", "New Business")

    # Project name for logging
    project_name = _plain(props.get("Project Name", {}).get("title", []))

    return {
        "company_ids":            company_ids,
        "lead_ids":               lead_ids,
        "original_quotation_ids": original_quotation_ids,
        "package":                package,
        "project_name":           project_name,
    }


def create_addon_quotation(project_id, project_data, hdrs):
    """
    Create a Draft Quotation in Quotations DB with:
      - Company + Deal Source from the project
      - Project relation back to the project (key: prevents duplicate project creation)
      - Payment Terms: Full Upfront (add-ons billed in full)
      - Quote Type: same as original package
      - Status: Draft
    Returns (page_id_no_dashes, notion_url).
    """
    today = date.today().isoformat()

    company_ids = project_data["company_ids"]
    lead_ids    = project_data["lead_ids"]
    package     = project_data["package"]

    props = {
        "Quotation No.": {"title": [{"text": {"content": ""}}]},  # auto unique_id
        "Status":        {"select": {"name": "Draft"}},
        "Issue Date":    {"date": {"start": today}},
        "Payment Terms": {"select": {"name": "Full Upfront"}},    # add-ons: pay in full
        "Quote Type":    {"select": {"name": package}},
        "Package Type":  {"rich_text": [{"text": {"content": "Add-on"}}]},
    }

    if company_ids:
        props["Company"] = {"relation": [{"id": cid} for cid in company_ids[:1]]}

    # Link back to the project — create_invoice will detect this and skip
    # creating a new project hub (it'll just link the supplementary invoice instead)
    try:
        props["Project"] = {"relation": [{"id": project_id}]}
    except Exception:
        pass

    # Deal Source (Lead) — links the add-on quotation to the pipeline deal
    if lead_ids:
        for field_name in ("Deal Source", "Lead", "Deals"):
            try:
                test_props = dict(props)
                test_props[field_name] = {"relation": [{"id": lid} for lid in lead_ids[:1]]}
                r = requests.post(
                    "https://api.notion.com/v1/pages",
                    headers=hdrs,
                    json={"parent": {"database_id": QUOTATIONS_DB}, "properties": test_props},
                    timeout=15,
                )
                if r.ok:
                    page = r.json()
                    page_id  = page["id"].replace("-", "")
                    page_url = page.get("url", f"https://notion.so/{page_id}")
                    print(f"[INFO] Add-on quotation created: {page_id} (Lead via '{field_name}')", file=sys.stderr)
                    return page_id, page_url
                elif "Deal Source" in r.text or field_name in r.text:
                    print(f"[WARN] Field '{field_name}' rejected, trying next…", file=sys.stderr)
                    continue
                else:
                    # Different error — try without any lead field
                    print(f"[WARN] Create failed {r.status_code}: {r.text[:200]}", file=sys.stderr)
                    break
            except Exception as e:
                print(f"[WARN] create_addon_quotation ({field_name}): {e}", file=sys.stderr)

    # Fallback: no lead link
    r = requests.post(
        "https://api.notion.com/v1/pages",
        headers=hdrs,
        json={"parent": {"database_id": QUOTATIONS_DB}, "properties": props},
        timeout=15,
    )
    if not r.ok:
        raise ValueError(f"Notion create add-on quotation {r.status_code}: {r.text[:400]}")

    page     = r.json()
    page_id  = page["id"].replace("-", "")
    page_url = page.get("url", f"https://notion.so/{page_id}")
    print(f"[INFO] Add-on quotation created (no lead): {page_id}", file=sys.stderr)
    return page_id, page_url


def create_line_items_db(page_id, hdrs):
    """
    Append a callout header + blank Products & Services inline DB on the
    new add-on quotation page.  User fills in their add-on line items.
    """
    # Callout header
    requests.patch(
        f"https://api.notion.com/v1/blocks/{page_id}/children",
        headers=hdrs,
        json={"children": [{
            "type": "callout",
            "callout": {
                "rich_text": [{
                    "type": "text",
                    "text": {"content": "Products & Services"},
                    "annotations": {"bold": True, "color": "default"},
                }],
                "icon":  None,
                "color": "default_background",
            },
        }]},
        timeout=15,
    )

    # Inline DB
    r = requests.post(
        "https://api.notion.com/v1/databases",
        headers=hdrs,
        json={
            "parent":    {"type": "page_id", "page_id": page_id},
            "is_inline": True,
            "title": [{"type": "text", "text": {"content": "Products & Services"}}],
            "properties": {
                "Notes":       {"title": {}},
                "Product":     {"relation": {"database_id": PRODUCTS_DB, "single_property": {}}},
                "Description": {"rich_text": {}},
                "Unit Price":  {"number": {"format": "ringgit"}},
                "Qty":         {"number": {"format": "number"}},
                "Subtotal":    {"formula": {"expression": 'prop("Qty") * prop("Unit Price")'}},
            },
        },
        timeout=15,
    )

    if r.ok:
        db_id = r.json()["id"].replace("-", "")
        print(f"[INFO] Add-on Products & Services DB: {db_id}", file=sys.stderr)
        return db_id
    else:
        print(f"[WARN] Add-on DB create {r.status_code}: {r.text[:200]}", file=sys.stderr)
        return None


def process(payload):
    hdrs = _hdrs()

    # Parse project page_id from Notion webhook shapes
    raw_id = None
    source = payload.get("source") or {}
    if isinstance(source, dict):
        raw_id = source.get("page_id") or source.get("id")
    if not raw_id:
        data = payload.get("data") or {}
        if isinstance(data, dict):
            raw_id = data.get("page_id") or data.get("id")
    if not raw_id:
        raw_id = payload.get("page_id") or payload.get("id")
    if not raw_id:
        raise ValueError("No page_id found in payload")

    project_id = raw_id.replace("-", "")
    print(f"[INFO] Add-on for Project: {project_id}", file=sys.stderr)

    # 1. Fetch project details
    project_data = fetch_project(project_id, hdrs)
    print(f"[INFO] Project: '{project_data['project_name']}' | "
          f"Company: {project_data['company_ids']} | "
          f"Lead: {project_data['lead_ids']}", file=sys.stderr)

    # 2. Create add-on quotation
    quot_id, quot_url = create_addon_quotation(project_id, project_data, hdrs)

    # 3. Blank Products & Services DB (user fills in add-on scope)
    try:
        create_line_items_db(quot_id, hdrs)
    except Exception as e:
        print(f"[WARN] Add-on DB: {e}", file=sys.stderr)

    return {
        "status":          "success",
        "project_id":      project_id,
        "project_name":    project_data["project_name"],
        "quotation_id":    quot_id,
        "quotation_url":   quot_url,
        "note":            "Fill in add-on line items, then set Status → Approved to generate invoice",
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
            "service": "Vision Core — Create Add-on Quotation",
            "status":  "ready",
            "usage":   "POST with {page_id} from a Project page",
        })

    def do_POST(self):
        try:
            length  = int(self.headers.get("Content-Length", 0))
            raw     = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw) if raw else {}

            print(f"[DEBUG] create_addon payload: {json.dumps(payload)[:400]}", file=sys.stderr)

            result = process(payload)
            self._respond(200, result)

        except Exception as e:
            import traceback; traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[HTTP] {fmt % args}", file=sys.stderr)
