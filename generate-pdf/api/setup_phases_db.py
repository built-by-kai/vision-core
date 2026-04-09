"""
setup_phases_db.py
GET /api/setup_phases_db

ONE-TIME SETUP — hit this URL once in a browser after deploying.

Creates the Phases DB linked to the Projects DB, then enriches the
Projects DB with tracking fields and a Phases relation.

Phases DB schema:
  Phase Name (title)
  Project     relation → Projects DB
  Status      select: Not Started / In Progress / Review / Done
  Phase No.   number  (for ordering)
  Start Date  date
  Due Date    date
  Deliverables rich_text
  Notes       rich_text

Projects DB additions:
  Start Date       date
  Target End Date  date
  Phases           relation → Phases DB (two-way)
  Add-on Value     number  (manual entry for extra invoices billed)
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler

import requests

PROJECTS_DB = "5719b2672d3442a29a22637a35398260"
NOTION_VER  = "2022-06-28"


def _hdrs():
    key = os.environ.get("NOTION_API_KEY", "")
    return {
        "Authorization":  f"Bearer {key}",
        "Notion-Version": NOTION_VER,
        "Content-Type":   "application/json",
    }


def get_projects_parent(hdrs):
    """Return the parent page_id of the Projects DB."""
    r = requests.get(
        f"https://api.notion.com/v1/databases/{PROJECTS_DB}",
        headers=hdrs, timeout=10
    )
    r.raise_for_status()
    parent = r.json().get("parent", {})
    if parent.get("type") == "page_id":
        return parent["page_id"].replace("-", "")
    if parent.get("type") == "block_id":
        return parent["block_id"].replace("-", "")
    # Workspace-level or unknown — search for a usable page
    return None


def find_existing_phases_db(hdrs):
    """Return existing Phases DB id if already created."""
    r = requests.post(
        "https://api.notion.com/v1/search",
        headers=hdrs,
        json={"query": "Phases", "filter": {"value": "database", "property": "object"}},
        timeout=10,
    )
    if r.ok:
        for result in r.json().get("results", []):
            title = "".join(
                t.get("plain_text", "")
                for t in result.get("title", [])
            )
            if title.strip().lower() in ("phases", "project phases"):
                return result["id"].replace("-", "")
    return None


def create_phases_db(parent_page_id, hdrs):
    """Create the Phases DB. Returns db_id (no dashes)."""
    body = {
        "parent":    {"type": "page_id", "page_id": parent_page_id},
        "is_inline": False,
        "title": [{"type": "text", "text": {"content": "Phases"}}],
        "icon": {"type": "emoji", "emoji": "🗂️"},
        "properties": {
            # Title column
            "Phase Name": {"title": {}},

            # Relation to Projects DB
            "Project": {
                "relation": {
                    "database_id":  PROJECTS_DB,
                    "single_property": {},
                }
            },

            # Status workflow
            "Status": {
                "select": {
                    "options": [
                        {"name": "Not Started", "color": "gray"},
                        {"name": "In Progress", "color": "blue"},
                        {"name": "Review",      "color": "yellow"},
                        {"name": "Done",        "color": "green"},
                        {"name": "On Hold",     "color": "orange"},
                    ]
                }
            },

            # Phase ordering (1, 2, 3…)
            "Phase No.": {"number": {"format": "number"}},

            # Date window
            "Start Date": {"date": {}},
            "Due Date":   {"date": {}},

            # Content
            "Deliverables": {"rich_text": {}},
            "Notes":        {"rich_text": {}},
        },
    }

    r = requests.post(
        "https://api.notion.com/v1/databases",
        headers=hdrs, json=body, timeout=20
    )
    if not r.ok:
        raise ValueError(f"Create Phases DB failed {r.status_code}: {r.text[:400]}")
    db_id = r.json()["id"].replace("-", "")
    print(f"[INFO] Phases DB created: {db_id}", file=sys.stderr)
    return db_id


def update_projects_db(phases_db_id, hdrs):
    """
    Patch Projects DB to add:
      - Start Date       (date)
      - Target End Date  (date)
      - Add-on Value     (number)
      - Phases           (relation → Phases DB, two-way)
    Only adds fields that don't already exist.
    """
    # Get current schema
    r = requests.get(
        f"https://api.notion.com/v1/databases/{PROJECTS_DB}",
        headers=hdrs, timeout=10
    )
    r.raise_for_status()
    existing = set(r.json().get("properties", {}).keys())

    new_props = {}

    if "Start Date" not in existing:
        new_props["Start Date"] = {"date": {}}

    if "Target End Date" not in existing:
        new_props["Target End Date"] = {"date": {}}

    if "Add-on Value" not in existing:
        new_props["Add-on Value"] = {"number": {"format": "ringgit"}}

    if "Phases" not in existing:
        new_props["Phases"] = {
            "relation": {
                "database_id":  phases_db_id,
                "single_property": {},
            }
        }

    if not new_props:
        print("[INFO] Projects DB already up-to-date", file=sys.stderr)
        return []

    pr = requests.patch(
        f"https://api.notion.com/v1/databases/{PROJECTS_DB}",
        headers=hdrs,
        json={"properties": new_props},
        timeout=15,
    )
    if pr.ok:
        print(f"[INFO] Projects DB updated: {list(new_props.keys())}", file=sys.stderr)
        return list(new_props.keys())
    else:
        print(f"[WARN] Projects DB update {pr.status_code}: {pr.text[:300]}", file=sys.stderr)
        return []


def run_setup(hdrs):
    # 1. Check for existing Phases DB
    phases_db_id = find_existing_phases_db(hdrs)
    already_existed = bool(phases_db_id)

    if not phases_db_id:
        # 2. Find parent of Projects DB
        parent_id = get_projects_parent(hdrs)
        if not parent_id:
            raise ValueError(
                "Could not find a parent page for the Phases DB. "
                "Please create a 'Phases' database manually and link it to Projects."
            )

        # 3. Create Phases DB
        phases_db_id = create_phases_db(parent_id, hdrs)

    # 4. Update Projects DB with new fields + Phases relation
    added_fields = update_projects_db(phases_db_id, hdrs)

    return {
        "status":           "success",
        "phases_db_id":     phases_db_id,
        "phases_db_url":    f"https://notion.so/{phases_db_id}",
        "already_existed":  already_existed,
        "projects_db_fields_added": added_fields,
        "next_steps": [
            "Open Projects DB → add a 'Phases' filtered inline view on each project page",
            "In Phases DB: create a timeline/board view filtered by Project for visual tracking",
            "Set phase No. 1, 2, 3… to control sort order",
        ]
    }


class handler(BaseHTTPRequestHandler):

    def _respond(self, code, body_dict):
        body = json.dumps(body_dict, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not os.environ.get("NOTION_API_KEY"):
            self._respond(500, {"error": "NOTION_API_KEY not set"}); return
        try:
            result = run_setup(_hdrs())
            self._respond(200, result)
        except Exception as e:
            import traceback; traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def do_POST(self):
        self.do_GET()

    def log_message(self, fmt, *args):
        print(f"[HTTP] {fmt % args}", file=sys.stderr)
