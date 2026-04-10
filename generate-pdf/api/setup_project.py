"""
setup_project.py
POST /api/setup_project  { "page_id": "<project_page_id>" }

Triggered by a Notion button on a Project page.
Reads the Package type, then auto-creates:
  - Phase 1–N pages in Phases DB (linked to project)
  - All standard tasks for that OS in Tasks DB (linked to phase + project)

Prevents duplicates — safe to call multiple times.

Databases:
  Projects DB : 5719b2672d3442a29a22637a35398260
  Phases   DB : 33d8b289e31a81d896bfdb314521dc7b
  Tasks    DB : b87d0a44df344b178f14c7e94ce520b0
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

import requests

PROJECTS_DB = "5719b2672d3442a29a22637a35398260"
PHASES_DB   = "33d8b289e31a81d896bfdb314521dc7b"
TASKS_DB    = "b87d0a44df344b178f14c7e94ce520b0"

# ─────────────────────────────────────────────────────────────────
#  OS PHASE + TASK DEFINITIONS
#  Each OS maps to a list of phases.
#  Each phase has: name, deliverables, and a list of tasks.
#  Tasks: (task_name, priority)  — "High" | "Medium" | "Low"
# ─────────────────────────────────────────────────────────────────

PRE_BUILD = {
    "phase": "Phase 0 — Pre-Build",
    "deliverables": "Scope locked, contract signed, deposit received, client intake completed",
    "tasks": [
        ("Send contract / service agreement to client",       "High"),
        ("Confirm deposit payment received",                  "High"),
        ("Schedule kickoff meeting with client",              "High"),
        ("Send pre-kickoff questionnaire to client",          "Medium"),
        ("Conduct kickoff meeting — document requirements",   "High"),
        ("Review client's existing tools and workflows",      "High"),
        ("Document pain points and must-solve problems",      "High"),
        ("Confirm final scope and deliverables with client",  "High"),
        ("Send client implementation intake form",            "High"),
        ("Review completed intake form",                      "High"),
        ("Set up shared communication channel (WhatsApp/email)","Medium"),
        ("Brief client on Notion basics if unfamiliar",       "Low"),
        ("Create project timeline and share with client",     "Medium"),
    ],
}

OS_BLUEPRINT = {

    "Starter OS": [
        PRE_BUILD,
        {
            "phase": "Phase 1 — Foundation",
            "deliverables": "Base OS installed: Client DB, Team Directory, Company Profile, Settings, Activity Log",
            "tasks": [
                ("Set up Notion workspace structure",           "High"),
                ("Install Client Database",                    "High"),
                ("Install Team Members & Staff Directory",     "High"),
                ("Install Company Profile database",           "Medium"),
                ("Install Settings & Configuration database",  "Medium"),
                ("Install Activity Log database",              "Medium"),
                ("Link all Base OS databases with relations",  "High"),
                ("Configure Base OS views and filters",        "Medium"),
            ],
        },
        {
            "phase": "Phase 2 — Core Modules",
            "deliverables": "3–4 selected modules installed and configured per client scope",
            "tasks": [
                ("Confirm selected modules with client",       "High"),
                ("Build Module 1 database and views",          "High"),
                ("Build Module 2 database and views",          "High"),
                ("Build Module 3 database and views",          "High"),
                ("Link modules to Base OS databases",          "High"),
                ("Configure automations for selected modules", "Medium"),
                ("Populate with client's existing data",       "Medium"),
            ],
        },
        {
            "phase": "Phase 3 — QA & Handover",
            "deliverables": "System tested, client trained, handover complete",
            "tasks": [
                ("Internal QA — test all relations and views", "High"),
                ("Fix issues from QA review",                  "High"),
                ("Prepare client walkthrough agenda",          "Medium"),
                ("Conduct live walkthrough session with client","High"),
                ("Deliver Notion system to client workspace",  "High"),
                ("Collect client sign-off",                    "Medium"),
                ("Issue final invoice",                        "High"),
            ],
        },
    ],

    "Operations OS": [
        PRE_BUILD,
        {
            "phase": "Phase 1 — Foundation",
            "deliverables": "Base OS + workspace structure ready",
            "tasks": [
                ("Set up Notion workspace structure",           "High"),
                ("Install Client Database",                    "High"),
                ("Install Team Members & Staff Directory",     "High"),
                ("Install Company Profile database",           "Medium"),
                ("Install Settings & Configuration database",  "Medium"),
                ("Install Activity Log database",              "Medium"),
                ("Link all Base OS databases with relations",  "High"),
                ("Configure Base OS views and filters",        "Medium"),
            ],
        },
        {
            "phase": "Phase 2 — Project & Task Layer",
            "deliverables": "Project Tracker, Task Management, and Responsibility Matrix live",
            "tasks": [
                ("Build Project Tracker database",             "High"),
                ("Build Task Management database",             "High"),
                ("Build Team Responsibility Matrix",           "High"),
                ("Link Project Tracker → Tasks relation",      "High"),
                ("Link Tasks → Team Members relation",         "Medium"),
                ("Configure project views (Board, Timeline)",  "Medium"),
                ("Configure task views (My Tasks, By Project)","Medium"),
                ("Set up task status automations",             "Medium"),
            ],
        },
        {
            "phase": "Phase 3 — Client & Process Layer",
            "deliverables": "Client Onboarding Tracker, SOP Library, and Delivery Milestones live",
            "tasks": [
                ("Build Client Onboarding Tracker",            "High"),
                ("Build Process & SOP Library database",       "High"),
                ("Build Delivery Milestone Tracker",           "High"),
                ("Build Retainer Management Tracker",          "Medium"),
                ("Link Onboarding Tracker → Client DB",        "High"),
                ("Link SOP Library → Team Members",            "Medium"),
                ("Populate with 3–5 sample SOPs",              "Medium"),
                ("Configure onboarding checklist template",    "Medium"),
            ],
        },
        {
            "phase": "Phase 4 — QA & Handover",
            "deliverables": "System tested, client trained, handover complete",
            "tasks": [
                ("Internal QA — test all relations and views", "High"),
                ("Fix issues from QA review",                  "High"),
                ("Prepare client walkthrough agenda",          "Medium"),
                ("Conduct live walkthrough session with client","High"),
                ("Deliver Notion system to client workspace",  "High"),
                ("Collect client sign-off",                    "Medium"),
                ("Issue final invoice",                        "High"),
            ],
        },
    ],

    "Sales OS": [
        PRE_BUILD,
        {
            "phase": "Phase 1 — Foundation",
            "deliverables": "Base OS + workspace structure ready",
            "tasks": [
                ("Set up Notion workspace structure",           "High"),
                ("Install Client Database",                    "High"),
                ("Install Team Members & Staff Directory",     "High"),
                ("Install Company Profile database",           "Medium"),
                ("Install Settings & Configuration database",  "Medium"),
                ("Install Activity Log database",              "Medium"),
                ("Link all Base OS databases with relations",  "High"),
                ("Configure Base OS views and filters",        "Medium"),
            ],
        },
        {
            "phase": "Phase 2 — Pipeline & CRM",
            "deliverables": "CRM, Sales Pipeline, and Proposals DB live",
            "tasks": [
                ("Build Leads CRM database",                   "High"),
                ("Build Sales Pipeline database",              "High"),
                ("Build Proposals / Quotations database",      "High"),
                ("Link CRM → Companies relation",              "High"),
                ("Link Pipeline → CRM relation",               "High"),
                ("Configure pipeline stages and views",        "High"),
                ("Configure CRM views (By Stage, By Owner)",   "Medium"),
                ("Set up lead source tracking",                "Medium"),
            ],
        },
        {
            "phase": "Phase 3 — Revenue Tracking",
            "deliverables": "Meetings Log, Revenue Dashboard, and revenue forecasting live",
            "tasks": [
                ("Build Meetings & Calls Log database",        "High"),
                ("Build Revenue Dashboard database",           "High"),
                ("Link Meetings → CRM and Pipeline",           "High"),
                ("Build revenue forecast formula",             "High"),
                ("Configure Revenue Dashboard views",          "Medium"),
                ("Set up won/lost deal tracking",              "Medium"),
                ("Populate with 3–5 sample deals",             "Low"),
            ],
        },
        {
            "phase": "Phase 4 — QA & Handover",
            "deliverables": "System tested, client trained, handover complete",
            "tasks": [
                ("Internal QA — test all relations and views", "High"),
                ("Fix issues from QA review",                  "High"),
                ("Prepare client walkthrough agenda",          "Medium"),
                ("Conduct live walkthrough session with client","High"),
                ("Deliver Notion system to client workspace",  "High"),
                ("Collect client sign-off",                    "Medium"),
                ("Issue final invoice",                        "High"),
            ],
        },
    ],

    "Business OS": [
        PRE_BUILD,
        {
            "phase": "Phase 1 — Foundation",
            "deliverables": "Base OS + workspace structure ready",
            "tasks": [
                ("Set up Notion workspace structure",           "High"),
                ("Install Client Database",                    "High"),
                ("Install Team Members & Staff Directory",     "High"),
                ("Install Company Profile database",           "Medium"),
                ("Install Settings & Configuration database",  "Medium"),
                ("Install Activity Log database",              "Medium"),
                ("Link all Base OS databases with relations",  "High"),
                ("Configure Base OS views and filters",        "Medium"),
            ],
        },
        {
            "phase": "Phase 2 — Operations OS",
            "deliverables": "Full Operations OS: Project Tracker, Task Management, Onboarding, SOPs, Delivery, Retainer",
            "tasks": [
                ("Build Project Tracker database",             "High"),
                ("Build Task Management database",             "High"),
                ("Build Team Responsibility Matrix",           "High"),
                ("Build Client Onboarding Tracker",            "High"),
                ("Build Process & SOP Library database",       "High"),
                ("Build Delivery Milestone Tracker",           "High"),
                ("Build Retainer Management Tracker",          "Medium"),
                ("Link all Operations OS databases",           "High"),
                ("Configure all Operations OS views",          "Medium"),
                ("QA — Operations OS layer",                   "High"),
            ],
        },
        {
            "phase": "Phase 3 — Sales OS",
            "deliverables": "Full Sales OS: CRM, Pipeline, Proposals, Meetings, Revenue Dashboard",
            "tasks": [
                ("Build Leads CRM database",                   "High"),
                ("Build Sales Pipeline database",              "High"),
                ("Build Proposals / Quotations database",      "High"),
                ("Build Meetings & Calls Log database",        "High"),
                ("Build Revenue Dashboard database",           "High"),
                ("Link all Sales OS databases",                "High"),
                ("Configure Sales OS views and pipeline stages","Medium"),
                ("Link Sales OS → Operations OS (shared clients)","High"),
                ("QA — Sales OS layer",                        "High"),
            ],
        },
        {
            "phase": "Phase 4 — QA & Handover",
            "deliverables": "Full system tested, client trained, handover complete",
            "tasks": [
                ("Cross-system QA — test all relations",       "High"),
                ("Fix issues from QA review",                  "High"),
                ("Prepare client walkthrough agenda",          "Medium"),
                ("Conduct live walkthrough — Operations OS",   "High"),
                ("Conduct live walkthrough — Sales OS",        "High"),
                ("Deliver Notion system to client workspace",  "High"),
                ("Collect client sign-off",                    "Medium"),
                ("Issue final invoice",                        "High"),
            ],
        },
    ],

    "Marketing OS": [
        PRE_BUILD,
        {
            "phase": "Phase 1 — Foundation",
            "deliverables": "Base OS + workspace structure ready",
            "tasks": [
                ("Set up Notion workspace structure",           "High"),
                ("Install Client Database",                    "High"),
                ("Install Team Members & Staff Directory",     "High"),
                ("Install Company Profile database",           "Medium"),
                ("Install Settings & Configuration database",  "Medium"),
                ("Install Activity Log database",              "Medium"),
                ("Link all Base OS databases with relations",  "High"),
                ("Configure Base OS views and filters",        "Medium"),
            ],
        },
        {
            "phase": "Phase 2 — Campaign & Content Layer",
            "deliverables": "Campaign Tracker, Content Production, Content Calendar, and Brief & Approval Log live",
            "tasks": [
                ("Build Campaign Tracker database",            "High"),
                ("Build Content Production Tracker database",  "High"),
                ("Build Content Calendar database",            "High"),
                ("Build Brief & Approval Log database",        "High"),
                ("Link Campaign → Content Production",         "High"),
                ("Link Content Calendar → Content Production", "High"),
                ("Configure campaign status workflow",         "Medium"),
                ("Configure content approval workflow",        "Medium"),
            ],
        },
        {
            "phase": "Phase 3 — Asset & Brand Layer",
            "deliverables": "Brand Asset Library and KPI tracking live",
            "tasks": [
                ("Build Brand & Client Asset Library database","High"),
                ("Configure asset categorisation and tags",    "Medium"),
                ("Link Asset Library → Campaigns",             "Medium"),
                ("Build KPI & Performance tracking views",     "High"),
                ("Configure campaign reporting dashboard",     "Medium"),
                ("Populate with sample campaigns and assets",  "Low"),
            ],
        },
        {
            "phase": "Phase 4 — QA & Handover",
            "deliverables": "System tested, client trained, handover complete",
            "tasks": [
                ("Internal QA — test all relations and views", "High"),
                ("Fix issues from QA review",                  "High"),
                ("Prepare client walkthrough agenda",          "Medium"),
                ("Conduct live walkthrough session with client","High"),
                ("Deliver Notion system to client workspace",  "High"),
                ("Collect client sign-off",                    "Medium"),
                ("Issue final invoice",                        "High"),
            ],
        },
    ],

    "Intelligence OS": [
        PRE_BUILD,
        {
            "phase": "Phase 1 — Foundation",
            "deliverables": "Base OS + workspace structure ready",
            "tasks": [
                ("Set up Notion workspace structure",           "High"),
                ("Install Client Database",                    "High"),
                ("Install Team Members & Staff Directory",     "High"),
                ("Install Company Profile database",           "Medium"),
                ("Install Settings & Configuration database",  "Medium"),
                ("Install Activity Log database",              "Medium"),
                ("Link all Base OS databases with relations",  "High"),
                ("Configure Base OS views and filters",        "Medium"),
            ],
        },
        {
            "phase": "Phase 2 — Prospect & Market Intelligence",
            "deliverables": "Prospect Intelligence DB and Market Intelligence Log live",
            "tasks": [
                ("Build Prospect Intelligence Database",       "High"),
                ("Configure prospect scoring formula",         "High"),
                ("Build Market Intelligence Log database",     "High"),
                ("Configure market signal categorisation",     "Medium"),
                ("Link Prospect DB → Companies relation",      "High"),
                ("Set up data input workflow",                 "Medium"),
                ("Test with 5 sample prospect entries",        "Medium"),
            ],
        },
        {
            "phase": "Phase 3 — Competitor & Performance Tracking",
            "deliverables": "Competitor Tracker and Performance Dashboard live",
            "tasks": [
                ("Build Competitor Tracker database",          "High"),
                ("Configure competitor monitoring fields",     "Medium"),
                ("Build Performance Dashboard Database",       "High"),
                ("Configure performance KPI formulas",         "High"),
                ("Link Performance Dashboard → all Intel DBs", "High"),
                ("Build intelligence summary views",           "Medium"),
            ],
        },
        {
            "phase": "Phase 4 — Automation & Integration",
            "deliverables": "Automated data pipelines and AI signal monitors configured",
            "tasks": [
                ("Scope automation requirements with client",  "High"),
                ("Build Make.com / N8N automation flows",      "High"),
                ("Connect external data sources via API",      "High"),
                ("Set up AI signal monitoring pipeline",       "High"),
                ("Test end-to-end data flow",                  "High"),
                ("Document automation logic",                  "Medium"),
            ],
        },
        {
            "phase": "Phase 5 — QA & Handover",
            "deliverables": "Full system tested, client trained, handover complete",
            "tasks": [
                ("Full system QA — data, automations, views",  "High"),
                ("Fix issues from QA review",                  "High"),
                ("Prepare client walkthrough agenda",          "Medium"),
                ("Conduct live walkthrough session with client","High"),
                ("Deliver system + automation documentation",  "High"),
                ("Collect client sign-off",                    "Medium"),
                ("Issue final invoice",                        "High"),
            ],
        },
    ],

    "Expansion": [
        PRE_BUILD,
        {
            "phase": "Phase 1 — Scope & Design",
            "deliverables": "Add-on scope confirmed, design approved",
            "tasks": [
                ("Review expansion scope with client",         "High"),
                ("Map new module to existing system",          "High"),
                ("Confirm database structure and relations",   "High"),
                ("Get client approval on design",              "Medium"),
            ],
        },
        {
            "phase": "Phase 2 — Build",
            "deliverables": "Expansion module built and connected to existing OS",
            "tasks": [
                ("Build expansion database / module",          "High"),
                ("Connect to existing OS databases",           "High"),
                ("Configure views and filters",                "Medium"),
                ("Set up automations if applicable",           "Medium"),
                ("Internal testing",                           "High"),
            ],
        },
        {
            "phase": "Phase 3 — QA & Handover",
            "deliverables": "Expansion tested, client trained, handover complete",
            "tasks": [
                ("QA — test integration with existing system", "High"),
                ("Fix issues from QA review",                  "High"),
                ("Walkthrough with client",                    "High"),
                ("Collect client sign-off",                    "Medium"),
                ("Issue final invoice",                        "High"),
            ],
        },
    ],
}


# ─────────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────────

def _hdrs():
    return {
        "Authorization":  f"Bearer {os.environ.get('NOTION_API_KEY', '')}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


def fetch_project(page_id, hdrs):
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}", headers=hdrs, timeout=15)
    r.raise_for_status()
    props = r.json().get("properties", {})

    pkg_prop = props.get("Package", {})
    package  = (pkg_prop.get("select") or {}).get("name", "")

    title_prop = props.get("Project Name", {})
    name = "".join(t.get("plain_text", "") for t in title_prop.get("title", []))

    company_ids = [rel["id"] for rel in props.get("Company", {}).get("relation", [])]

    return {"name": name, "package": package, "company_ids": company_ids}


def existing_phase_numbers(project_page_id, hdrs):
    """Return set of Phase No. integers already linked to this project."""
    r = requests.post(
        f"https://api.notion.com/v1/databases/{PHASES_DB}/query",
        headers=hdrs,
        json={"filter": {"property": "Project", "relation": {"contains": project_page_id}}},
        timeout=15,
    )
    if not r.ok:
        return set()
    nums = set()
    for page in r.json().get("results", []):
        n = page.get("properties", {}).get("Phase No.", {}).get("number")
        if n is not None:
            nums.add(int(n))
    return nums


PRIORITY_EMOJI = {"High": "🔴", "Medium": "🟡", "Low": "🔵"}


def create_phase(project_page_id, phase_no, phase_def, hdrs):
    props = {
        "Phase Name": {"title": [{"text": {"content": phase_def["phase"]}}]},
        "Phase No.":  {"number": phase_no},
        "Status":     {"select": {"name": "Not Started"}},
        "Project":    {"relation": [{"id": project_page_id}]},
    }
    if phase_def.get("deliverables"):
        props["Deliverables"] = {"rich_text": [{"text": {"content": phase_def["deliverables"]}}]}

    # Build initial page content: deliverables callout + tasks heading + task rows
    tasks = phase_def.get("tasks", [])

    children = []

    # Deliverables callout
    if phase_def.get("deliverables"):
        children.append({
            "object": "block",
            "type": "callout",
            "callout": {
                "rich_text": [{"type": "text", "text": {"content": phase_def["deliverables"]}}],
                "icon": {"type": "emoji", "emoji": "🎯"},
                "color": "gray_background",
            }
        })

    # Divider
    children.append({"object": "block", "type": "divider", "divider": {}})

    # Tasks heading
    children.append({
        "object": "block",
        "type": "heading_2",
        "heading_2": {
            "rich_text": [{"type": "text", "text": {"content": "📋 Tasks"}}],
            "color": "default",
        }
    })

    # Hint callout
    children.append({
        "object": "block",
        "type": "callout",
        "callout": {
            "rich_text": [{"type": "text", "text": {
                "content": "Tasks below are synced from the Tasks database. Open any task to update status, due date, or assignee. Use the Tasks relation property above to see live progress."
            }}],
            "icon": {"type": "emoji", "emoji": "💡"},
            "color": "blue_background",
        }
    })

    # Task rows as to-do blocks (one per task)
    for task_name, priority in tasks:
        emoji = PRIORITY_EMOJI.get(priority, "⚪")
        children.append({
            "object": "block",
            "type": "to_do",
            "to_do": {
                "rich_text": [
                    {"type": "text", "text": {"content": f"{emoji}  {task_name}"},
                     "annotations": {"bold": priority == "High"}},
                    {"type": "text", "text": {"content": f"  [{priority}]"},
                     "annotations": {"color": "gray", "italic": True}},
                ],
                "checked": False,
            }
        })

    body = {
        "parent":     {"database_id": PHASES_DB},
        "icon":       {"type": "emoji", "emoji": "📋"},
        "properties": props,
        "children":   children,
    }
    r = requests.post("https://api.notion.com/v1/pages", headers=hdrs, json=body, timeout=15)
    r.raise_for_status()
    return r.json()["id"]


def update_phase_task_checkboxes(phase_page_id, task_entries, hdrs):
    """
    After tasks are created in the Tasks DB (with their page IDs),
    append a linked mention block for each task so clicking opens the real task page.
    This replaces the static to_do blocks with live @mentions.
    Called after all tasks for a phase are created.
    """
    mention_blocks = []
    for task_page_id, task_name, priority in task_entries:
        emoji = PRIORITY_EMOJI.get(priority, "⚪")
        mention_blocks.append({
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [
                    {"type": "text", "text": {"content": f"{emoji}  "},
                     "annotations": {}},
                    {"type": "mention", "mention": {"type": "page", "page": {"id": task_page_id}}},
                    {"type": "text", "text": {"content": f"  [{priority}]"},
                     "annotations": {"color": "gray", "italic": True}},
                ],
            }
        })

    if not mention_blocks:
        return

    # Add a divider + "Linked Tasks" heading + mention list
    blocks = [
        {"object": "block", "type": "divider", "divider": {}},
        {
            "object": "block",
            "type": "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "🔗 Linked Task Pages"}}],
            }
        },
    ] + mention_blocks

    requests.patch(
        f"https://api.notion.com/v1/blocks/{phase_page_id}/children",
        headers=hdrs,
        json={"children": blocks},
        timeout=20,
    )


PHASE_STAGE_LABELS = {
    0: "Phase 0 — Pre-Build",
    1: "Phase 1",
    2: "Phase 2",
    3: "Phase 3",
    4: "Phase 4",
    5: "Phase 5",
}


def create_task(project_page_id, phase_page_id, phase_no, task_no, task_name, priority, hdrs):
    stage_label = PHASE_STAGE_LABELS.get(phase_no, f"Phase {phase_no}")
    props = {
        "Task Name":   {"title": [{"text": {"content": task_name}}]},
        "Task No.":    {"number": task_no},
        "Status":      {"select": {"name": "Not Started"}},
        "Priority":    {"select": {"name": priority}},
        "Phase Stage": {"select": {"name": stage_label}},
        "Phase":       {"relation": [{"id": phase_page_id}]},
        "Project":     {"relation": [{"id": project_page_id}]},
    }
    body = {"parent": {"database_id": TASKS_DB}, "properties": props}
    r = requests.post("https://api.notion.com/v1/pages", headers=hdrs, json=body, timeout=15)
    r.raise_for_status()
    return r.json()["id"]


# ─────────────────────────────────────────────────────────────────
#  HANDLER
# ─────────────────────────────────────────────────────────────────

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
            "service": "Opxio — Project Setup (Phases + Tasks)",
            "status":  "ready",
            "os_types": list(OS_BLUEPRINT.keys()),
        })

    def do_POST(self):
        try:
            secret = os.environ.get("WEBHOOK_SECRET", "")
            if secret and self.headers.get("Authorization", "") != f"Bearer {secret}":
                self._respond(401, {"error": "Unauthorized"}); return

            length = int(self.headers.get("Content-Length", 0))
            raw    = self.rfile.read(length) if length > 0 else b"{}"
            body   = json.loads(raw) if raw else {}

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
                self._respond(400, {"error": "Missing page_id"}); return

            if not os.environ.get("NOTION_API_KEY"):
                self._respond(500, {"error": "NOTION_API_KEY not set"}); return

            hdrs    = _hdrs()
            project = fetch_project(page_id, hdrs)
            package = project["package"]

            print(f"[INFO] Project: {project['name']} | Package: {package}", file=sys.stderr)

            if not package:
                self._respond(400, {"error": "Project has no Package set. Set the Package field first."}); return

            blueprint = OS_BLUEPRINT.get(package)
            if not blueprint:
                self._respond(400, {"error": f"No blueprint found for package '{package}'. Supported: {list(OS_BLUEPRINT.keys())}"}); return

            # Check for existing phases — prevent duplicates
            existing = existing_phase_numbers(page_id, hdrs)
            if existing:
                self._respond(200, {
                    "status":  "skipped",
                    "reason":  f"Project already has phases: {sorted(existing)}. Delete existing phases first to regenerate.",
                    "project": project["name"],
                    "package": package,
                }); return

            # Create phases + tasks
            total_phases = 0
            total_tasks  = 0
            task_counter = 1

            for phase_no, phase_def in enumerate(blueprint, start=0):
                phase_id = create_phase(page_id, phase_no, phase_def, hdrs)
                total_phases += 1
                print(f"[INFO] Created phase {phase_no}: {phase_def['phase']}", file=sys.stderr)

                # Collect (task_page_id, task_name, priority) for linked mention blocks
                task_entries = []
                for task_name, priority in phase_def["tasks"]:
                    task_id = create_task(page_id, phase_id, phase_no, task_counter, task_name, priority, hdrs)
                    task_entries.append((task_id, task_name, priority))
                    task_counter += 1
                    total_tasks  += 1

                # Append linked @mention blocks to the phase page
                update_phase_task_checkboxes(phase_id, task_entries, hdrs)
                print(f"[INFO] Appended {len(task_entries)} linked task mentions to phase {phase_no}", file=sys.stderr)

            self._respond(200, {
                "status":       "success",
                "project":      project["name"],
                "package":      package,
                "phases_created": total_phases,
                "tasks_created":  total_tasks,
            })

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)
