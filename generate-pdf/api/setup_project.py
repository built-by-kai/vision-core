"""
setup_project.py
POST /api/setup_project  { "page_id": "<project_page_id>" }

Triggered by a Notion button on a Project page.
Reads the Package type, then fetches phase templates from the
Phase Templates DB in Notion — fully editable without code changes.

Prevents duplicates — safe to call multiple times.

Databases:
  Projects DB       : 842fe60097f68303b34e01a5432d24cc
  Phases   DB       : 39ffe60097f682b4bf11814aadaf233f
  Tasks    DB       : b87d0a44df344b178f14c7e94ce520b0
  Phase Templates DB      : 704727fe90644f0d91b9a35a3ef6eb5f
  Phase Template Tasks DB : 46e7a39983b94a57860f8765c1a50168
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

import requests

PROJECTS_DB       = "842fe60097f68303b34e01a5432d24cc"
PHASES_DB         = "39ffe60097f682b4bf11814aadaf233f"
TASKS_DB          = "b87d0a44df344b178f14c7e94ce520b0"
TEMPLATES_DB      = "704727fe90644f0d91b9a35a3ef6eb5f"
TASK_TEMPLATES_DB = "46e7a39983b94a57860f8765c1a50168"

PRIORITY_EMOJI = {"High": "🔴", "Medium": "🟡", "Low": "🔵"}

PHASE_STAGE_LABELS = {
    0: "Phase 0 — Pre-Build",
    1: "Phase 1 — Foundation",
    2: "Phase 2",
    3: "Phase 3",
    4: "Phase 4 — Client Review & Revisions",
    5: "Phase 5 — QA & Handover",
    6: "Phase 6 — QA & Handover",
}


# ─────────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────────

def _hdrs():
    return {
        "Authorization":  "Bearer " + os.environ.get("NOTION_API_KEY", ""),
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


def fetch_project(page_id, hdrs):
    r = requests.get("https://api.notion.com/v1/pages/" + page_id, headers=hdrs, timeout=15)
    r.raise_for_status()
    props = r.json().get("properties", {})

    pkg_prop = props.get("Package", {})
    package  = (pkg_prop.get("select") or {}).get("name", "")

    title_prop = props.get("Project Name", {})
    name = "".join(t.get("plain_text", "") for t in title_prop.get("title", []))

    company_ids = [rel["id"] for rel in props.get("Company", {}).get("relation", [])]

    addon_products = [
        opt.get("name", "")
        for opt in props.get("Add-on Products", {}).get("multi_select", [])
        if opt.get("name", "")
    ]

    return {"name": name, "package": package, "company_ids": company_ids, "addon_products": addon_products}


def fetch_tasks_for_os(os_type, hdrs):
    """
    Fetch all tasks from Phase Template Tasks DB for an OS type.
    Returns a dict: { phase_no (int): [(task_name, priority), ...] }
    Tasks are sorted by Task Order within each phase.
    Deduplicates on task name per phase to guard against double entries.
    """
    payload = {
        "filter": {
            "property": "OS Type",
            "select":   {"equals": os_type},
        },
        "sorts": [
            {"property": "Phase No.",   "direction": "ascending"},
            {"property": "Task Order",  "direction": "ascending"},
        ],
        "page_size": 100,
    }
    r = requests.post(
        "https://api.notion.com/v1/databases/" + TASK_TEMPLATES_DB + "/query",
        headers=hdrs, json=payload, timeout=15,
    )
    r.raise_for_status()

    tasks_by_phase = {}
    seen = {}  # (phase_no, task_name) -> True — dedup guard

    for page in r.json().get("results", []):
        props    = page.get("properties", {})
        phase_no = int(props.get("Phase No.", {}).get("number") or 0)
        priority = (props.get("Priority", {}).get("select") or {}).get("name", "Medium")
        task_name = "".join(
            t.get("plain_text", "")
            for t in props.get("Task Name", {}).get("title", [])
        ).strip()

        if not task_name:
            continue
        key = (phase_no, task_name)
        if key in seen:
            continue
        seen[key] = True

        if phase_no not in tasks_by_phase:
            tasks_by_phase[phase_no] = []
        tasks_by_phase[phase_no].append((task_name, priority))

    return tasks_by_phase


def fetch_addon_tasks(slug, hdrs):
    """
    Fetch tasks for a specific Layer 2 add-on product by its slug.
    Returns a list of (task_name, priority) tuples sorted by Task Order.
    """
    payload = {
        "filter": {
            "property": "Product Slug",
            "rich_text": {"equals": slug},
        },
        "sorts": [{"property": "Task Order", "direction": "ascending"}],
        "page_size": 50,
    }
    r = requests.post(
        "https://api.notion.com/v1/databases/" + TASK_TEMPLATES_DB + "/query",
        headers=hdrs, json=payload, timeout=15,
    )
    if not r.ok:
        print("[WARN] fetch_addon_tasks failed for " + slug, file=sys.stderr)
        return []

    tasks = []
    for page in r.json().get("results", []):
        props = page.get("properties", {})
        task_name = "".join(
            t.get("plain_text", "")
            for t in props.get("Task Name", {}).get("title", [])
        ).strip()
        priority = (props.get("Priority", {}).get("select") or {}).get("name", "Medium")
        if task_name:
            tasks.append((task_name, priority))
    return tasks


def fetch_templates(os_type, hdrs):
    """
    Query the Phase Templates DB filtered by OS Type, sorted by Phase No. ascending.
    Tasks are loaded from Phase Template Tasks DB (editable per phase).

    Source OS support: if a phase row has Source OS + Source Phase Nos. set,
    tasks are fetched from that OS for those phase numbers instead of the local rows.
    This allows Business OS Phase 2 to pull directly from Operations OS Phase 2+3 tasks,
    and Business OS Phase 3 to pull from Sales OS Phase 2+3 — single source of truth.

    Returns a list of phase defs: [{phase_no, phase, deliverables, tasks: [(name, priority), ...]}, ...]
    """
    # Load all tasks for this OS upfront in one query
    tasks_by_phase = fetch_tasks_for_os(os_type, hdrs)

    # Cache for any source OS task lookups (avoid re-fetching for multiple phases)
    source_os_cache = {}

    payload = {
        "filter": {
            "property": "OS Type",
            "select":   {"equals": os_type},
        },
        "sorts": [{"property": "Phase No.", "direction": "ascending"}],
        "page_size": 50,
    }
    r = requests.post(
        "https://api.notion.com/v1/databases/" + TEMPLATES_DB + "/query",
        headers=hdrs, json=payload, timeout=15,
    )
    r.raise_for_status()
    results = r.json().get("results", [])

    if not results:
        return []

    phases = []
    for page in results:
        props = page.get("properties", {})

        phase_no = int(props.get("Phase No.", {}).get("number") or 0)

        phase_name = "".join(
            t.get("plain_text", "")
            for t in props.get("Phase Name", {}).get("title", [])
        )

        deliverables = "".join(
            t.get("plain_text", "")
            for t in props.get("Deliverables", {}).get("rich_text", [])
        )

        # ── Source OS cross-reference (e.g. Business OS → Operations OS) ──
        source_os = (props.get("Source OS", {}).get("select") or {}).get("name", "")
        source_phase_nos_raw = "".join(
            t.get("plain_text", "")
            for t in props.get("Source Phase Nos.", {}).get("rich_text", [])
        ).strip()

        if source_os and source_phase_nos_raw:
            # Parse comma-separated phase numbers
            source_phase_nos = [
                int(n.strip())
                for n in source_phase_nos_raw.split(",")
                if n.strip().isdigit()
            ]
            # Fetch source OS tasks (cached per OS to avoid duplicate API calls)
            if source_os not in source_os_cache:
                print(
                    "[INFO] Fetching source tasks: " + source_os +
                    " phases " + source_phase_nos_raw,
                    file=sys.stderr,
                )
                source_os_cache[source_os] = fetch_tasks_for_os(source_os, hdrs)
            source_tasks = source_os_cache[source_os]

            # Combine tasks from the specified source phase numbers, deduplicating by name
            tasks = []
            seen_names = set()
            for spno in source_phase_nos:
                for task_name, priority in source_tasks.get(spno, []):
                    if task_name not in seen_names:
                        seen_names.add(task_name)
                        tasks.append((task_name, priority))
        else:
            # Tasks come from Phase Template Tasks DB — fall back to text field if none found
            tasks = tasks_by_phase.get(phase_no, [])
            if not tasks:
                tasks_raw = "".join(
                    t.get("plain_text", "")
                    for t in props.get("Tasks", {}).get("rich_text", [])
                )
                for line in tasks_raw.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    if "|" in line:
                        parts = line.split("|", 1)
                        task_name = parts[0].strip()
                        priority  = parts[1].strip()
                        if priority not in ("High", "Medium", "Low"):
                            priority = "Medium"
                    else:
                        task_name = line
                        priority  = "Medium"
                    tasks.append((task_name, priority))

        phases.append({
            "phase_no":     phase_no,
            "phase":        phase_name,
            "deliverables": deliverables,
            "tasks":        tasks,
        })

    return phases


def existing_phase_numbers(project_page_id, hdrs):
    """Return set of Phase No. integers already linked to this project."""
    r = requests.post(
        "https://api.notion.com/v1/databases/" + PHASES_DB + "/query",
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


def create_phase(project_page_id, phase_def, hdrs):
    phase_no = phase_def["phase_no"]
    tasks    = phase_def.get("tasks", [])

    props = {
        "Phase Name": {"title": [{"text": {"content": phase_def["phase"]}}]},
        "Phase No.":  {"number": phase_no},
        "Status":     {"select": {"name": "Not Started"}},
        "Project":    {"relation": [{"id": project_page_id}]},
    }
    if phase_def.get("deliverables"):
        props["Deliverables"] = {
            "rich_text": [{"text": {"content": phase_def["deliverables"]}}]
        }

    # Build initial page content
    children = []

    if phase_def.get("deliverables"):
        children.append({
            "object": "block", "type": "callout",
            "callout": {
                "rich_text": [{"type": "text", "text": {"content": phase_def["deliverables"]}}],
                "icon":  {"type": "emoji", "emoji": "🎯"},
                "color": "gray_background",
            }
        })

    children.append({"object": "block", "type": "divider", "divider": {}})

    children.append({
        "object": "block", "type": "heading_2",
        "heading_2": {
            "rich_text": [{"type": "text", "text": {"content": "📋 Tasks"}}],
            "color": "default",
        }
    })

    children.append({
        "object": "block", "type": "callout",
        "callout": {
            "rich_text": [{"type": "text", "text": {
                "content": "Tasks below are synced from the Tasks database. "
                           "Open any task to update status, due date, or assignee."
            }}],
            "icon":  {"type": "emoji", "emoji": "💡"},
            "color": "blue_background",
        }
    })

    for task_name, priority in tasks:
        emoji = PRIORITY_EMOJI.get(priority, "⚪")
        children.append({
            "object": "block", "type": "to_do",
            "to_do": {
                "rich_text": [
                    {
                        "type": "text",
                        "text": {"content": emoji + "  " + task_name},
                        "annotations": {"bold": priority == "High"},
                    },
                    {
                        "type": "text",
                        "text": {"content": "  [" + priority + "]"},
                        "annotations": {"color": "gray", "italic": True},
                    },
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
    append a linked @mention block for each task so clicking opens the real task page.
    """
    if not task_entries:
        return

    mention_blocks = []
    for task_page_id, task_name, priority in task_entries:
        emoji = PRIORITY_EMOJI.get(priority, "⚪")
        mention_blocks.append({
            "object": "block", "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [
                    {
                        "type": "text",
                        "text": {"content": emoji + "  "},
                        "annotations": {},
                    },
                    {
                        "type": "mention",
                        "mention": {"type": "page", "page": {"id": task_page_id}},
                    },
                    {
                        "type": "text",
                        "text": {"content": "  [" + priority + "]"},
                        "annotations": {"color": "gray", "italic": True},
                    },
                ],
            }
        })

    blocks = [
        {"object": "block", "type": "divider", "divider": {}},
        {
            "object": "block", "type": "heading_3",
            "heading_3": {
                "rich_text": [{"type": "text", "text": {"content": "🔗 Linked Task Pages"}}],
            }
        },
    ] + mention_blocks

    requests.patch(
        "https://api.notion.com/v1/blocks/" + phase_page_id + "/children",
        headers=hdrs, json={"children": blocks}, timeout=20,
    )


def create_task(project_page_id, phase_page_id, phase_no, task_no, task_name, priority, hdrs,
               stage_label=None):
    if stage_label is None:
        stage_label = PHASE_STAGE_LABELS.get(phase_no, "Phase " + str(phase_no))
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
            "service":    "Opxio — Project Setup (Phases + Tasks)",
            "status":     "ready",
            "templates":  "Loaded from Notion Phase Templates DB",
            "templates_db": TEMPLATES_DB,
        })

    def do_POST(self):
        try:
            secret = os.environ.get("WEBHOOK_SECRET", "")
            if secret and self.headers.get("Authorization", "") != "Bearer " + secret:
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

            print("[INFO] Project: " + project["name"] + " | Package: " + package, file=sys.stderr)

            if not package:
                self._respond(400, {
                    "error": "Project has no Package set. Set the Package field first."
                }); return

            # Load phase templates from Notion
            blueprint = fetch_templates(package, hdrs)

            if not blueprint:
                self._respond(400, {
                    "error": "No phase templates found for package '" + package + "'. "
                             "Check the Phase Templates DB in Notion.",
                }); return

            # Check for existing phases — prevent duplicates
            existing = existing_phase_numbers(page_id, hdrs)
            if existing:
                self._respond(200, {
                    "status":  "skipped",
                    "reason":  "Project already has phases: " + str(sorted(existing)) +
                               ". Delete existing phases first to regenerate.",
                    "project": project["name"],
                    "package": package,
                }); return

            # Set Project Phase to Phase 0 — Pre-Build
            requests.patch(
                "https://api.notion.com/v1/pages/" + page_id,
                headers=hdrs,
                json={"properties": {"Phase": {"select": {"name": "Phase 0 — Pre-Build"}}}},
                timeout=10,
            )
            print("[INFO] Project Phase → Phase 0 — Pre-Build", file=sys.stderr)

            # Create phases + tasks
            total_phases = 0
            total_tasks  = 0
            task_counter = 1

            for phase_def in blueprint:
                phase_no = phase_def["phase_no"]
                phase_id = create_phase(page_id, phase_def, hdrs)
                total_phases += 1
                print("[INFO] Created phase " + str(phase_no) + ": " + phase_def["phase"], file=sys.stderr)

                # Collect (task_page_id, task_name, priority) for linked mention blocks
                task_entries = []
                phase_stage_label = phase_def["phase"]  # use actual phase name from template
                for task_name, priority in phase_def["tasks"]:
                    task_id = create_task(
                        page_id, phase_id, phase_no,
                        task_counter, task_name, priority, hdrs,
                        stage_label=phase_stage_label,
                    )
                    task_entries.append((task_id, task_name, priority))
                    task_counter += 1
                    total_tasks  += 1

                # Append linked @mention blocks to the phase page
                update_phase_task_checkboxes(phase_id, task_entries, hdrs)
                print(
                    "[INFO] Appended " + str(len(task_entries)) +
                    " linked task mentions to phase " + str(phase_no),
                    file=sys.stderr,
                )

            # ── Add-ons & Integrations phase (if any add-on products are on the project) ──
            addon_products = project.get("addon_products", [])
            if addon_products:
                print("[INFO] Add-ons found: " + ", ".join(addon_products), file=sys.stderr)

                # Gather all tasks across slugs, deduplicating by name
                all_addon_tasks = []
                seen_addon = set()
                for slug in addon_products:
                    slug_tasks = fetch_addon_tasks(slug, hdrs)
                    for task_name, priority in slug_tasks:
                        if task_name not in seen_addon:
                            seen_addon.add(task_name)
                            all_addon_tasks.append((task_name, priority))
                    print(
                        "[INFO] Fetched " + str(len(slug_tasks)) +
                        " tasks for slug: " + slug,
                        file=sys.stderr,
                    )

                if all_addon_tasks:
                    # Find a sensible phase number — insert before the last two phases
                    # (typically Client Review + QA & Handover) by using the second-to-last
                    # blueprint phase_no minus 0.5, so it sorts between them naturally.
                    # Fall back to 98 if the blueprint is very short.
                    if len(blueprint) >= 2:
                        second_last_no = blueprint[-2]["phase_no"]
                        addon_phase_no = second_last_no  # same slot, won't conflict on Notion
                        # Use the last main build phase + 1 as the number to keep ordering clear
                        last_build_no  = blueprint[-3]["phase_no"] if len(blueprint) >= 3 else second_last_no
                        addon_phase_no = last_build_no + 1
                    else:
                        addon_phase_no = 98

                    addon_phase_def = {
                        "phase_no":     addon_phase_no,
                        "phase":        "Add-ons & Integrations",
                        "deliverables": (
                            "Implementation of all add-on products included in the quotation: "
                            + ", ".join(addon_products) + "."
                        ),
                        "tasks": all_addon_tasks,
                    }
                    addon_phase_id = create_phase(page_id, addon_phase_def, hdrs)
                    total_phases += 1
                    print(
                        "[INFO] Created Add-ons & Integrations phase with " +
                        str(len(all_addon_tasks)) + " tasks",
                        file=sys.stderr,
                    )

                    # Create task records in Tasks DB for the add-on phase
                    addon_task_entries = []
                    for task_name, priority in all_addon_tasks:
                        task_id = create_task(
                            page_id, addon_phase_id, addon_phase_no,
                            task_counter, task_name, priority, hdrs,
                            stage_label="Add-ons & Integrations",
                        )
                        addon_task_entries.append((task_id, task_name, priority))
                        task_counter += 1
                        total_tasks  += 1

                    # Append linked mention blocks
                    update_phase_task_checkboxes(addon_phase_id, addon_task_entries, hdrs)

            self._respond(200, {
                "status":         "success",
                "project":        project["name"],
                "package":        package,
                "phases_created": total_phases,
                "tasks_created":  total_tasks,
                "addons":         addon_products,
            })

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print("[HTTP] " + (format % args), file=sys.stderr)
