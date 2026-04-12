import json
import os
import sys
from http.server import BaseHTTPRequestHandler

import requests

# ─────────────────────────────────────────────
#  Notion Database IDs
# ─────────────────────────────────────────────
CONTACTS_DB   = "b0afe60097f68265b93401fbc6f0fec4"  # Contacts (People)
COMPANIES_DB  = "725fe60097f682c09be901fe6ebb6b41"  # Companies
LEADS_DB      = "caafe60097f683398df40197eeedbffe"  # Deals CRM
MEETINGS_DB   = "f9ffe60097f68389a09981dfece9e98f"  # Meetings
PIC_HIST_DB   = "36efe60097f682d2b3410198d11714c7"  # PIC History
EXPANSIONS_DB = "7c6fe60097f682fbbe9b81f828f6d3f8"  # Expansions (active client add-ons)

# Valid Source options per database
CONTACTS_SOURCES = {"Threads", "LinkedIn", "WhatsApp", "Email", "Instagram", "TikTok", "Internal Staff", "Referral"}
LEADS_SOURCES    = {"Threads", "Linkedin", "WhatsApp", "Email", "Instagram", "TikTok", "Referral", "Existing Client"}

# Valid Interest options for Deals CRM (must match Notion multi_select exactly)
VALID_INTERESTS = {
    "Revenue OS", "Operations OS", "Business OS", "Marketing OS", "Agency OS",
    "Intelligence OS", "Starter OS", "People OS", "Client Success OS",
    "Additional Module", "Automation", "Advanced Dashboard", "Custom Widget",
    "API / External Integration", "Automation & Workflow Integration",
    "Lead Capture System", "Client Portal View", "AI Agent Integration",
}

# Valid Industry options for Companies
VALID_INDUSTRIES = {
    "Marketing & Creative Agency", "Consulting & Advisory", "Media & Content Production",
    "Events & Experiential", "PR & Communications", "Technology & SaaS",
    "E-Commerce & Retail", "Real Estate", "Education & Training", "Health & Wellness",
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
    "general manager":          "Executive Staff",
    "biz dev manager":          "Biz Dev Manager",
    "employee/staff":           None,  # no matching option — role left blank
    "employee":                 None,
    "staff":                    None,
    "other":                    None,  # skip — no matching option
}

# Map Notion Role → Department (auto-populated on contact creation)
DEPT_MAP = {
    "CEO":              "Board of Directors",
    "COO":              "Operations",
    "CTO":              "Technology",
    "CFO":              "Finance",
    "CMO":              "Sales & Marketing",
    "Marketing Manager":"Sales & Marketing",
    "Biz Dev Manager":  "Sales & Marketing",
    "Executive Staff":  "Board of Directors",
    "Ops Manager":      "Operations",
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


def create_page(db_id, properties, hdrs, icon_emoji=None):
    body = {"parent": {"database_id": db_id}, "properties": properties}
    if icon_emoji:
        body["icon"] = {"type": "emoji", "emoji": icon_emoji}
    r = requests.post("https://api.notion.com/v1/pages", headers=hdrs, json=body, timeout=10)
    if not r.ok:
        raise ValueError(f"Notion create_page {r.status_code}: {r.text[:600]}")
    return r.json()


def update_page(page_id, properties, hdrs):
    r = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json={"properties": properties}, timeout=10,
    )
    if not r.ok:
        raise ValueError(f"Notion update_page {r.status_code}: {r.text[:400]}")
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
    phone        = rv(responses, "phone", "phoneNumber", "phone_number", "attendeePhoneNumber",
                      "mobile", "contact_number", "contactNumber")
    industry_raw = rv(responses, "industry", default=[])
    role_raw     = rv(responses, "role")
    team_size    = rv(responses, "team_size", "teamSize")
    challenge    = rv(responses, "notes", "challenge", "operationalChallenge")
    referral_raw = rv(responses, "source", "referral", "whereDidYouFindMe", default=[])
    interest_raw = rv(responses, "interest", default=[])
    notion_exp   = rv(responses, "notion_familiarity", "notionExperience", "notion")

    # Cal.com guests field — additional attendees who added their emails
    guests_raw   = rv(responses, "guests", default=[])
    guest_emails = guests_raw if isinstance(guests_raw, list) else ([guests_raw] if guests_raw else [])
    guest_emails = [g.strip() for g in guest_emails if g and g.strip() != email]

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

    # Location text
    location_text = ""
    if meeting_url:
        location_text = "Online Meeting (Cal Video)"
    elif isinstance(payload.get("location"), str):
        loc = payload["location"]
        if not loc.startswith("integrations:") and not loc.startswith("http"):
            location_text = loc

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
        for key, val in ROLE_MAP.items():
            if key in role_key:
                notion_role = val
                break

    # Resolve department from role
    notion_dept = DEPT_MAP.get(notion_role) if notion_role else None

    # Normalise referral to list
    referral_list = referral_raw if isinstance(referral_raw, list) else ([referral_raw] if referral_raw else [])

    # ── Active client metadata (pre-bound company from Company page link) ──
    metadata         = payload.get("metadata") or {}
    bound_company_id = (metadata.get("company_id") or "").replace("-", "")
    # What the active client is looking for — determines routing
    request_type     = rv(responses, "requestType", "request_type", "lookingFor",
                          "what_are_you_looking_for", default="").lower()
    # Classify: "add-on"/"expansion" → Expansions DB, else → Leads CRM
    is_expansion = any(k in request_type for k in ("add", "expansion", "extra", "feature", "addon"))
    is_active_client = bool(bound_company_id)  # came via company-specific link

    # Debug: log all response keys + values
    print(f"[DEBUG] Response keys: {list(responses.keys())}", file=sys.stderr)
    for k, v in responses.items():
        print(f"[DEBUG]   {k!r} = {v!r}", file=sys.stderr)
    print(f"[INFO] Booking: name={name!r} email={email!r} company={company_name!r} phone={phone!r}", file=sys.stderr)
    print(f"[INFO] Active client: {is_active_client}, bound_company_id: {bound_company_id!r}, request_type: {request_type!r}", file=sys.stderr)

    # ── 1. Find or create Company ──────────────
    company_id         = None
    company_is_new     = False
    company_has_people = False

    if bound_company_id:
        # Active client link — company already known
        company_id = bound_company_id
        try:
            co_page = requests.get(f"https://api.notion.com/v1/pages/{company_id}",
                                   headers=hdrs, timeout=10).json()
            people_rel = co_page.get("properties", {}).get("People", {}).get("relation", [])
            company_has_people = len(people_rel) > 0
        except Exception:
            pass
        print(f"[INFO] Using bound company: {company_id}", file=sys.stderr)

    elif company_name:
        # Try match by company name first
        existing_co = search_db(
            COMPANIES_DB,
            {"property": "Company", "title": {"equals": company_name}},
            hdrs,
        )
        # Fallback: match by email domain (different person, same company)
        if not existing_co and email and "@" in email:
            domain = email.split("@")[1].lower()
            if domain not in {"gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"}:
                r_all = requests.post(
                    f"https://api.notion.com/v1/databases/{COMPANIES_DB}/query",
                    headers=hdrs, json={"page_size": 100}, timeout=10,
                )
                if r_all.ok:
                    for co in r_all.json().get("results", []):
                        co_email = co.get("properties", {}).get("Email", {}).get("email", "") or ""
                        if co_email and co_email.split("@")[-1].lower() == domain:
                            existing_co = co
                            print(f"[INFO] Matched company by domain @{domain}", file=sys.stderr)
                            break

        if existing_co:
            company_id = existing_co["id"].replace("-", "")
            people_rel = existing_co.get("properties", {}).get("People", {}).get("relation", [])
            company_has_people = len(people_rel) > 0
            print(f"[INFO] Existing company: {company_id}, has_people={company_has_people}", file=sys.stderr)
        else:
            co_props = {
                "Company": {"title": [{"text": {"content": company_name}}]},
                "Status":  {"select": {"name": "Prospect"}},
            }
            if industry:
                co_props["Industry"] = {"select": {"name": industry}}
            if team_size:
                co_props["Team Size"] = {"select": {"name": team_size}}
            new_co     = create_page(COMPANIES_DB, co_props, hdrs, icon_emoji="🏢")
            company_id = new_co["id"].replace("-", "")
            company_is_new = True
            print(f"[INFO] Created company: {company_id}", file=sys.stderr)

    # ── 2. Find or create Contact ──────────────
    contact_id    = None
    is_new_contact = False
    existing_cl   = None

    if email:
        existing_cl = search_db(
            CONTACTS_DB,
            {"property": "Email", "email": {"equals": email}},
            hdrs,
        )
        if existing_cl:
            contact_id = existing_cl["id"].replace("-", "")
            print(f"[INFO] Existing contact: {contact_id}", file=sys.stderr)
            # Ensure company is linked if not already
            if company_id:
                existing_co_rels = existing_cl.get("properties", {}).get("Company", {}).get("relation", [])
                existing_co_ids  = [r["id"].replace("-", "") for r in existing_co_rels]
                if company_id not in existing_co_ids:
                    update_page(contact_id, {
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
            if notion_dept:
                cl_props["Department"] = {"select": {"name": notion_dept}}
            if company_id:
                cl_props["Company"] = {"relation": [{"id": company_id}]}

            src = map_sources(referral_list, CONTACTS_SOURCES)
            if src:
                cl_props["Source"] = {"multi_select": src}

            new_cl     = create_page(CONTACTS_DB, cl_props, hdrs, icon_emoji="👤")
            contact_id = new_cl["id"].replace("-", "")
            is_new_contact = True
            is_pic_assigned = is_pic
            print(f"[INFO] Created contact: {contact_id}", file=sys.stderr)

    # Track whether this contact is the PIC (used for PIC History)
    is_pic_assigned = is_new_contact and (company_is_new or not company_has_people)

    # ── 3. Build notes ─────────────────────────
    notes_parts = []
    if team_size:  notes_parts.append(f"Team size: {team_size}")
    if challenge:  notes_parts.append(f"Biggest challenge: {challenge}")
    if notion_exp: notes_parts.append(f"Notion experience: {notion_exp}")
    notes_text = "\n".join(notes_parts)

    # ── 4. Create Lead or Expansion ───────────────
    if company_name and name:
        entry_name = f"{company_name} · {name}"
    elif company_name:
        entry_name = company_name
    else:
        entry_name = name or "New Lead"

    lead_id = None

    if is_active_client and is_expansion:
        # Active client wants add-on → Expansions DB
        exp_props = {
            "Name":   {"title": [{"text": {"content": entry_name}}]},
            "Status": {"select": {"name": "New Request"}},
        }
        if company_id:
            exp_props["Client"] = {"relation": [{"id": company_id}]}
        if notes_text:
            exp_props["Notes"] = {"rich_text": [{"text": {"content": notes_text}}]}
        new_entry = create_page(EXPANSIONS_DB, exp_props, hdrs, icon_emoji="🔧")
        lead_id   = new_entry["id"].replace("-", "")
        print(f"[INFO] Created expansion: {lead_id}", file=sys.stderr)
    else:
        # New lead or active client wanting new system → Deals CRM
        # Active client skips "Incoming" and starts at "Qualified"
        stage       = "Qualified" if is_active_client else "Incoming"
        client_type = "Existing Client" if is_active_client else "New Client"

        lead_props = {
            "Lead Name":   {"title": [{"text": {"content": entry_name}}]},
            "Stage":       {"status": {"name": stage}},
            "Client Type": {"select": {"name": client_type}},
        }
        if company_id:
            lead_props["Company"] = {"relation": [{"id": company_id}]}
        if notes_text:
            lead_props["Notes"] = {"rich_text": [{"text": {"content": notes_text}}]}

        lead_src = map_sources(referral_list, LEADS_SOURCES)
        if is_active_client and not lead_src:
            lead_src = [{"name": "Existing Client"}]
        if lead_src:
            lead_props["Source"] = {"multi_select": lead_src}

        # Interest — what OS/product the prospect is looking for
        interest_list = interest_raw if isinstance(interest_raw, list) else ([interest_raw] if interest_raw else [])
        interest_values = [{"name": v} for v in interest_list if v in VALID_INTERESTS]
        if interest_values:
            lead_props["Interest"] = {"multi_select": interest_values}

        # Discovery Call date
        if start_time:
            lead_props["Discovery Call"] = {"date": {"start": start_time, "end": end_time or None}}

        new_entry = create_page(LEADS_DB, lead_props, hdrs)
        lead_id   = new_entry["id"].replace("-", "")
        print(f"[INFO] Created lead (stage={stage}): {lead_id}", file=sys.stderr)

    # Link contact → lead (Contacts.Deals is primary side)
    if contact_id and lead_id:
        update_page(contact_id, {"Deals": {"relation": [{"id": lead_id}]}}, hdrs)

    # ── 5. Create Meeting ──────────────────────
    if is_active_client:
        mtg_label = "Active Client Session"
        mtg_type  = "Client Session"
    else:
        mtg_label = "Discovery Call"
        mtg_type  = "Discovery"
    mtg_title = f"{mtg_label} – {name}" if name else mtg_label
    mtg_props = {
        "Meeting Title": {"title": [{"text": {"content": mtg_title}}]},
        "Type":          {"select": {"name": mtg_type}},
    }
    if start_time:
        mtg_props["Date"] = {"date": {"start": start_time, "end": end_time or None}}
    if meeting_url:
        mtg_props["Meeting URL"] = {"url": meeting_url}
    if location_text:
        mtg_props["Location"] = {"rich_text": [{"text": {"content": location_text}}]}
    if company_id:
        mtg_props["Company"] = {"relation": [{"id": company_id}]}

    new_mtg = create_page(MEETINGS_DB, mtg_props, hdrs)
    mtg_id  = new_mtg["id"]
    print(f"[INFO] Created meeting: {mtg_id}", file=sys.stderr)

    # ── 6. PIC History entry (new PIC only) ───
    if is_pic_assigned and contact_id:
        booking_date = start_time[:10] if start_time else ""
        hist_props = {
            "PIC Name":   {"title": [{"text": {"content": name}}]},
            "Event Type": {"select": {"name": "PIC Assigned"}},
        }
        if booking_date:
            hist_props["Start Date"] = {"date": {"start": booking_date}}
        if notion_role:
            hist_props["Role"] = {"select": {"name": notion_role}}

        try:
            new_hist = create_page(PIC_HIST_DB, hist_props, hdrs)
            hist_id  = new_hist["id"]
            print(f"[INFO] Created PIC history: {hist_id}", file=sys.stderr)

            # Link Person (Contacts.History primary side fallback to PIC History.Person)
            try:
                update_page(hist_id, {"Person": {"relation": [{"id": contact_id}]}}, hdrs)
            except Exception:
                existing_hist_rels = existing_cl.get("properties", {}).get("History", {}).get("relation", []) if existing_cl else []
                update_page(contact_id, {"History": {"relation": existing_hist_rels + [{"id": hist_id}]}}, hdrs)

            # Link Related Deal (via Deals CRM PIC Changes — primary side)
            if lead_id:
                try:
                    update_page(lead_id, {"PIC Changes": {"relation": [{"id": hist_id}]}}, hdrs)
                except Exception as e:
                    print(f"[WARN] Could not link PIC history to lead: {e}", file=sys.stderr)

        except Exception as e:
            print(f"[WARN] PIC history creation failed: {e}", file=sys.stderr)

    # ── 7. Link meeting → Lead & Contact ──────
    # Deals CRM.Meetings is primary → populates Meetings.Participants
    if lead_id:
        update_page(lead_id, {"Meetings": {"relation": [{"id": mtg_id}]}}, hdrs)

    # Contacts.Meetings is primary → populates Meetings.Attendee
    if contact_id:
        existing_cl_mtgs = []
        if existing_cl:
            existing_cl_mtgs = existing_cl.get("properties", {}).get("Meetings", {}).get("relation", [])
        update_page(contact_id, {
            "Meetings": {"relation": existing_cl_mtgs + [{"id": mtg_id}]}
        }, hdrs)

    # ── 8. Link guest attendees ────────────────
    for guest_email in guest_emails:
        guest_cl = search_db(
            CONTACTS_DB,
            {"property": "Email", "email": {"equals": guest_email}},
            hdrs,
        )
        if not guest_cl:
            print(f"[INFO] Guest {guest_email!r} not found in Contacts — skipping", file=sys.stderr)
            continue

        guest_cl_id = guest_cl["id"].replace("-", "")
        print(f"[INFO] Linking guest {guest_email!r} (contact {guest_cl_id}) to meeting", file=sys.stderr)

        existing_guest_mtgs = guest_cl.get("properties", {}).get("Meetings", {}).get("relation", [])
        update_page(guest_cl_id, {
            "Meetings": {"relation": existing_guest_mtgs + [{"id": mtg_id}]}
        }, hdrs)

        guest_deals = guest_cl.get("properties", {}).get("Deals", {}).get("relation", [])
        for deal in guest_deals:
            deal_id = deal["id"].replace("-", "")
            deal_page = requests.get(
                f"https://api.notion.com/v1/pages/{deal_id}",
                headers=hdrs, timeout=10,
            ).json()
            existing_deal_mtgs = deal_page.get("properties", {}).get("Meetings", {}).get("relation", [])
            update_page(deal_id, {
                "Meetings": {"relation": existing_deal_mtgs + [{"id": mtg_id}]}
            }, hdrs)
            print(f"[INFO] Linked guest lead {deal_id} to meeting", file=sys.stderr)

    return {
        "status":           "success",
        "entry_name":       entry_name,
        "routed_to":        "expansions" if (is_active_client and is_expansion) else "leads_crm",
        "stage":            "New Request" if (is_active_client and is_expansion) else ("Qualified" if is_active_client else "Incoming"),
        "company_id":       company_id,
        "contact_id":       contact_id,
        "lead_id":          lead_id,
        "meeting_id":       mtg_id,
        "is_new_contact":   is_new_contact,
        "company_is_new":   company_is_new,
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
            "service": "Opxio – Cal.com Booking Webhook",
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
