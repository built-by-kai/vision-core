import json
import os
import sys
from http.server import BaseHTTPRequestHandler

import requests

# ─────────────────────────────────────────────
#  Notion Database IDs
# ─────────────────────────────────────────────
CLIENTS_DB   = "036622227fd244ad9a77633d5ae0a64b"  # Clients (People)
COMPANIES_DB = "33c8b289e31a80fe82d2ccd18bcaec68"  # Companies
LEADS_DB     = "8690d55c4d0449068c51ef49d92a26a2"  # Leads CRM
MEETINGS_DB  = "e283b9d542a34865bf518c3a0e43f1fe"  # Meetings

# Valid Source options per database
CLIENTS_SOURCES  = {"Threads", "LinkedIn", "WhatsApp", "Email", "Instagram", "TikTok", "Internal"}
LEADS_SOURCES    = {"Threads", "Linkedin", "WhatsApp", "Email", "Instagram", "TikTok"}

# Valid Industry options for Companies
VALID_INDUSTRIES = {
    "Marketing & Creative Agency", "Consulting & Advisory", "Media & Content Production",
    "Events & Experiential", "PR & Communications", "Technology & SaaS",
    "E-commerce & Retail", "Real Estate", "Education & Training", "Health & Wellness",
    "Legal & Professional Services", "Finance & Accounting", "Manufacturing",
    "Printing & Packaging", "Other",
}

# Map Cal.com role labels → Notion Role select options
ROLE_MAP = {
    "chief executive officer": "CEO",
    "ceo":                     "CEO",
    "chief technical officer":  "CTO",
    "cto":                     "CTO",
    "chief financial officer":  "CFO",
    "cfo":                     "CFO",
    "chief operations officer": "COO",
    "coo":                     "COO",
    "chief marketing officer":  "CMO",
    "cmo":                     "CMO",
    "operations manager":       "Ops Manager",
    "ops manager":              "Ops Manager",
    "marketing manager":        "Marketing Manager",
    "project manager":          "Project Manager",
    "executive staff":          "Executive Staff",
    "biz dev manager":          "Biz Dev Manager",
    "other":                    None,                 # skip — no matching option
}


# ─────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────
def notion_headers():
    api_key = os.environ.get("NOTION_API_KEY")
    if not api_key:
        raise ValueError("NOTION_API_KEY not set")
    return {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


def search_db(db_id, filter_payload, hdrs):
    """Query a Notion DB and return the first matching page or None."""
    r = requests.post(
        f"https://api.notion.com/v1/databases/{db_id}/query",
        headers=hdrs, json={"filter": filter_payload}, timeout=10,
    )
    r.raise_for_status()
    results = r.json().get("results", [])
    return results[0] if results else None


def create_page(db_id, properties, hdrs, icon_url=None):
    body = {"parent": {"database_id": db_id}, "properties": properties}
    if icon_url:
        body["icon"] = {"type": "external", "external": {"url": icon_url}}
    r = requests.post(
        "https://api.notion.com/v1/pages",
        headers=hdrs, json=body, timeout=10,
    )
    r.raise_for_status()
    return r.json()


def update_page(page_id, properties, hdrs):
    r = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json={"properties": properties}, timeout=10,
    )
    r.raise_for_status()
    return r.json()


def map_sources(raw_values, valid_set):
    """Map a list of referral strings to valid Notion Source multi_select names."""
    result = []
    values = raw_values if isinstance(raw_values, list) else ([raw_values] if raw_values else [])
    for v in values:
        v_lower = v.lower().strip()
        for opt in valid_set:
            if opt.lower() in v_lower or v_lower in opt.lower():
                if {"name": opt} not in result:
                    result.append({"name": opt})
                break
    return result


def rv(responses, *keys, default=""):
    """Extract a value from Cal.com responses dict by trying multiple keys."""
    for key in keys:
        val = responses.get(key)
        if val is None:
            continue
        if isinstance(val, dict):
            # Cal.com wraps values as {"label": "...", "value": "..."}
            v = val.get("value")
            # Phone type can also nest as {"value": {"phone": "+60...", "countryCode": "MY"}}
            if isinstance(v, dict):
                v = v.get("phone") or v.get("number") or str(v)
        else:
            v = val
        if v is not None and v != "":
            return v
    return default


# ─────────────────────────────────────────────
#  Core booking processor
# ─────────────────────────────────────────────
def process_booking(payload):
    hdrs = notion_headers()

    # ── Extract fields from Cal.com payload ───
    responses    = payload.get("responses") or {}
    attendees    = payload.get("attendees") or []
    attendee     = attendees[0] if attendees else {}

    name         = rv(responses, "name",   "fullName")   or attendee.get("name", "")
    email        = rv(responses, "email")                 or attendee.get("email", "")
    company_name = rv(responses, "company", "companyName", "Company Name")
    phone        = rv(responses, "phone",  "phoneNumber")
    industry_raw = rv(responses, "industry", default=[])
    role_raw     = rv(responses, "role")
    team_size    = rv(responses, "team_size", "teamSize")
    challenge    = rv(responses, "notes", "challenge", "operationalChallenge")
    referral_raw = rv(responses, "source", "referral", "whereDidYouFindMe", default=[])
    notion_exp   = rv(responses, "notion_familiarity", "notionExperience", "notion")

    # Booking metadata
    start_time   = payload.get("startTime", "")  # ISO-8601
    end_time     = payload.get("endTime", "")

    # Meeting/video URL — Cal.com puts it in videoCallData or location
    meeting_url = ""
    vcd = payload.get("videoCallData") or {}
    if vcd.get("url"):
        meeting_url = vcd["url"]
    elif isinstance(payload.get("location"), str) and payload["location"].startswith("http"):
        meeting_url = payload["location"]
    elif payload.get("meetingUrl"):
        meeting_url = payload["meetingUrl"]

    # Normalise industry to single string (MultiSelect → first value)
    industry = ""
    if isinstance(industry_raw, list) and industry_raw:
        industry = industry_raw[0]
    elif isinstance(industry_raw, str):
        industry = industry_raw
    if industry and industry not in VALID_INDUSTRIES:
        industry = "Other"

    # Resolve role label → Notion select option
    notion_role = None
    if role_raw:
        role_key = role_raw.lower().strip()
        # strip parenthetical abbreviation e.g. "Chief Executive Officer (CEO)" → match on full name
        for key, val in ROLE_MAP.items():
            if key in role_key:
                notion_role = val
                break

    # Normalise referral to list
    referral_list = referral_raw if isinstance(referral_raw, list) else ([referral_raw] if referral_raw else [])

    print(f"[INFO] Booking: name={name!r} email={email!r} company={company_name!r}", file=sys.stderr)

    # ── 1. Find or create Company ──────────────
    company_id         = None
    company_is_new     = False
    company_has_people = False

    if company_name:
        existing_co = search_db(
            COMPANIES_DB,
            {"property": "Name", "title": {"equals": company_name}},
            hdrs,
        )
        if existing_co:
            company_id = existing_co["id"].replace("-", "")
            people_rel = existing_co.get("properties", {}).get("People", {}).get("relation", [])
            company_has_people = len(people_rel) > 0
            print(f"[INFO] Existing company: {company_id}, has_people={company_has_people}", file=sys.stderr)
        else:
            co_props = {
                "Name":   {"title": [{"text": {"content": company_name}}]},
                "Status": {"select": {"name": "Prospect"}},
            }
            if industry:
                co_props["Industry"] = {"select": {"name": industry}}
            if team_size:
                co_props["Team Size"] = {"select": {"name": team_size}}
            new_co     = create_page(COMPANIES_DB, co_props, hdrs, icon_url="https://www.notion.so/icons/building_gray.svg")
            company_id = new_co["id"].replace("-", "")
            company_is_new = True
            print(f"[INFO] Created company: {company_id}", file=sys.stderr)

    # ── 2. Find or create Client (Person) ──────
    client_id     = None
    is_new_client = False

    if email:
        existing_cl = search_db(
            CLIENTS_DB,
            {"property": "Email", "email": {"equals": email}},
            hdrs,
        )
        if existing_cl:
            client_id = existing_cl["id"].replace("-", "")
            print(f"[INFO] Existing client: {client_id}", file=sys.stderr)
            # Ensure company is linked if not already
            if company_id:
                existing_co_rels = existing_cl.get("properties", {}).get("Company", {}).get("relation", [])
                existing_co_ids  = [r["id"].replace("-", "") for r in existing_co_rels]
                if company_id not in existing_co_ids:
                    update_page(client_id, {
                        "Company": {"relation": existing_co_rels + [{"id": company_id}]}
                    }, hdrs)
        else:
            # First person from this company = PIC
            is_pic = company_is_new or not company_has_people

            cl_props = {
                "Name":         {"title": [{"text": {"content": name}}]},
                "Email":        {"email": email},
                "Current PIC?": {"checkbox": is_pic},
                "Status":       {"select": {"name": "Active"}},
            }
            if phone:
                cl_props["Phone"] = {"phone_number": phone}
            if notion_role:
                cl_props["Role"] = {"select": {"name": notion_role}}
            if company_id:
                cl_props["Company"] = {"relation": [{"id": company_id}]}

            src = map_sources(referral_list, CLIENTS_SOURCES)
            if src:
                cl_props["Source"] = {"multi_select": src}

            new_cl    = create_page(CLIENTS_DB, cl_props, hdrs, icon_url="https://www.notion.so/icons/person_gray.svg")
            client_id = new_cl["id"].replace("-", "")
            is_new_client = True
            print(f"[INFO] Created client: {client_id}", file=sys.stderr)

    # ── 3. Build notes ─────────────────────────
    notes_parts = []
    if team_size:  notes_parts.append(f"Team size: {team_size}")
    if challenge:  notes_parts.append(f"Biggest challenge: {challenge}")
    if notion_exp: notes_parts.append(f"Notion experience: {notion_exp}")
    notes_text = "\n".join(notes_parts)

    # ── 4. Create Lead ─────────────────────────
    if company_name and name:
        lead_name = f"{company_name} · {name}"
    elif company_name:
        lead_name = company_name
    else:
        lead_name = name or "New Lead"
    lead_props = {
        "Lead Name": {"title": [{"text": {"content": lead_name}}]},
        "Stage":     {"status": {"name": "Contacted"}},
    }
    if company_id:
        lead_props["Company"] = {"relation": [{"id": company_id}]}
    if client_id:
        lead_props["Contacted Lead"] = {"relation": [{"id": client_id}]}
    if notes_text:
        lead_props["Notes"] = {"rich_text": [{"text": {"content": notes_text}}]}

    lead_src = map_sources(referral_list, LEADS_SOURCES)
    if lead_src:
        lead_props["Source"] = {"multi_select": lead_src}

    new_lead = create_page(LEADS_DB, lead_props, hdrs)
    lead_id  = new_lead["id"].replace("-", "")
    print(f"[INFO] Created lead: {lead_id}", file=sys.stderr)

    # ── 5. Create Meeting ──────────────────────
    mtg_name  = f"Discovery Call – {name}" if name else "Discovery Call"
    mtg_props = {
        "Name": {"title": [{"text": {"content": mtg_name}}]},
        "Type": {"select": {"name": "Discovery"}},
    }
    if start_time:
        mtg_props["Date"] = {"date": {"start": start_time, "end": end_time or None}}
    if meeting_url:
        mtg_props["Meeting URL"] = {"url": meeting_url}
    if client_id:
        mtg_props["Attendee"] = {"relation": [{"id": client_id}]}
    if lead_id:
        mtg_props["Participants"] = {"relation": [{"id": lead_id}]}

    new_mtg = create_page(MEETINGS_DB, mtg_props, hdrs)
    mtg_id  = new_mtg["id"]
    print(f"[INFO] Created meeting: {mtg_id}", file=sys.stderr)

    # ── 6. Link meeting back to Lead ───────────
    update_page(lead_id, {"Meetings": {"relation": [{"id": mtg_id}]}}, hdrs)

    return {
        "status":         "success",
        "lead_name":      lead_name,
        "company_id":     company_id,
        "client_id":      client_id,
        "lead_id":        lead_id,
        "meeting_id":     mtg_id,
        "is_new_client":  is_new_client,
        "company_is_new": company_is_new,
    }


# ─────────────────────────────────────────────
#  Vercel handler
# ─────────────────────────────────────────────
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
            "service": "Vision Core – Cal.com Booking Webhook",
            "status":  "ready",
        })

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw    = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw)
            except Exception:
                body = {}

            print(f"[DEBUG] Cal webhook: {json.dumps(body)[:600]}", file=sys.stderr)

            # Only process BOOKING_CREATED
            trigger = body.get("triggerEvent", "")
            if trigger and trigger != "BOOKING_CREATED":
                self._respond(200, {"status": "ignored", "trigger": trigger})
                return

            # Cal.com wraps booking data in a "payload" key
            payload = body.get("payload") or body

            result = process_booking(payload)
            self._respond(200, result)

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})
