"""
send_quotation.py
POST /api/send_quotation   { "page_id": "<quotation_page_id>" }

Triggered by a Notion button "Send to Client".
1. Fetches the quotation page (PIC phone, PDF URL, quotation number)
2. Builds a WhatsApp URL: https://wa.me/{phone}?text={message}
3. Writes the WA URL back to the "WA Link" field on the Quotation page
4. Updates Status → "Issued"
5. Returns the WA URL in the response

The user then clicks the "WA Link" field in Notion to open WhatsApp.

Quotation DB : f8167f0bda054307b90b17ad6b9c5cf8
"""
import json
import os
import re
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from urllib.parse import quote as url_quote

import requests

QUOTATIONS_DB = "f8167f0bda054307b90b17ad6b9c5cf8"


def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def _hdrs():
    api_key = os.environ.get("NOTION_API_KEY", "")
    return {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


def clean_phone(phone: str) -> str:
    """Strip non-digits, ensure Malaysian numbers start with country code."""
    digits = re.sub(r"\D", "", phone)
    # Malaysian: 01x… → 601x…
    if digits.startswith("0"):
        digits = "6" + digits
    return digits


def fetch_quotation_for_wa(page_id, hdrs):
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                     headers=hdrs, timeout=15)
    r.raise_for_status()
    page  = r.json()
    props = page.get("properties", {})

    # Title (quotation number) — find dynamically
    title_prop_name = "Quotation No."
    for k, v in props.items():
        if v.get("type") == "title":
            title_prop_name = k
            break
    quotation_no = _plain(props.get(title_prop_name, {}).get("title", []))

    # PDF URL
    pdf_url = props.get("PDF", {}).get("url") or ""

    # Status
    status = (props.get("Status", {}).get("select") or {}).get("name", "")

    # Company name
    company_name = ""
    for rel in props.get("Company", {}).get("relation", [])[:1]:
        try:
            cr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=hdrs, timeout=10)
            cr.raise_for_status()
            cp = cr.json().get("properties", {})
            for v in cp.values():
                if v.get("type") == "title":
                    company_name = _plain(v.get("title", []))
                    break
        except Exception as e:
            print(f"[WARN] company: {e}", file=sys.stderr)

    # PIC phone (and name)
    pic_name = pic_phone = ""
    for rel in props.get("PIC", {}).get("relation", [])[:1]:
        try:
            pr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=hdrs, timeout=10)
            pr.raise_for_status()
            pp = pr.json().get("properties", {})
            for k in ["Name", "Full Name", "name"]:
                if pp.get(k, {}).get("type") == "title":
                    pic_name = _plain(pp[k]["title"]); break
            for k in ["Phone", "phone", "Phone Number", "Mobile", "WhatsApp"]:
                prop = pp.get(k, {})
                if prop.get("type") == "phone_number":
                    pic_phone = prop.get("phone_number") or ""; break
                if prop.get("type") == "rich_text":
                    pic_phone = _plain(prop.get("rich_text", [])); break
        except Exception as e:
            print(f"[WARN] PIC: {e}", file=sys.stderr)

    return {
        "quotation_no":   quotation_no,
        "pdf_url":        pdf_url,
        "status":         status,
        "company_name":   company_name,
        "pic_name":       pic_name,
        "pic_phone":      pic_phone,
        "title_prop_name": title_prop_name,
    }


def build_whatsapp_url(data: dict) -> str:
    """Build wa.me link with a pre-filled message."""
    phone = clean_phone(data.get("pic_phone", ""))
    if not phone:
        return ""

    quo_no    = data.get("quotation_no", "")
    co_name   = data.get("company_name", "")
    pdf_url   = data.get("pdf_url", "")
    pic_name  = data.get("pic_name", "")

    greeting  = f"Hi {pic_name}," if pic_name else "Hi,"
    subject   = f"Quotation {quo_no}" if quo_no else "our quotation"
    for_whom  = f" for {co_name}" if co_name else ""

    lines = [
        f"{greeting}",
        "",
        f"Please find attached {subject}{for_whom}.",
    ]
    if pdf_url:
        lines += ["", f"View PDF: {pdf_url}"]
    lines += [
        "",
        "Do let us know if you have any questions.",
        "Looking forward to working with you!",
        "",
        "Best regards,",
        "Vision Core",
    ]
    message = "\n".join(lines)
    return f"https://wa.me/{phone}?text={url_quote(message)}"


def ensure_wa_link_property(page_id, hdrs):
    """Create 'WA Link' URL property on the parent database if it doesn't exist yet."""
    try:
        # Get parent database ID from the page
        pr = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                          headers=hdrs, timeout=10)
        pr.raise_for_status()
        db_id = (pr.json().get("parent") or {}).get("database_id", "").replace("-", "")
        if not db_id:
            return

        # Fetch database schema
        dbr = requests.get(f"https://api.notion.com/v1/databases/{db_id}",
                           headers=hdrs, timeout=10)
        dbr.raise_for_status()
        existing_props = dbr.json().get("properties", {})

        if "WA Link" not in existing_props:
            print("[INFO] Creating 'WA Link' URL property in database", file=sys.stderr)
            requests.patch(
                f"https://api.notion.com/v1/databases/{db_id}",
                headers=hdrs,
                json={"properties": {"WA Link": {"url": {}}}},
                timeout=10
            ).raise_for_status()
            print("[INFO] 'WA Link' property created", file=sys.stderr)
        else:
            print("[INFO] 'WA Link' property already exists", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] ensure_wa_link_property: {e}", file=sys.stderr)


def advance_lead_stage(page_id, hdrs):
    """Find leads linked to this quotation and advance them to 'Quotation Issued'."""
    LEADS_DB = "8690d55c4d0449068c51ef49d92a26a2"
    try:
        # The "Deal Source" property on the Quotation page holds the linked Lead(s)
        pr = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                          headers=hdrs, timeout=10)
        pr.raise_for_status()
        lead_rels = pr.json().get("properties", {}).get("Deal Source", {}).get("relation", [])

        if not lead_rels:
            # Fallback: query Leads DB for leads whose "Quotation" synced relation contains this page
            dr = requests.post(
                f"https://api.notion.com/v1/databases/{LEADS_DB}/query",
                headers=hdrs,
                json={"filter": {"property": "Quotation", "relation": {"contains": page_id}}},
                timeout=10,
            )
            if dr.ok:
                lead_rels = [{"id": r["id"]} for r in dr.json().get("results", [])]

        for rel in lead_rels:
            lead_id = rel["id"].replace("-", "")
            # Only advance if currently at Lead or Qualified (don't revert a won deal)
            lp = requests.get(f"https://api.notion.com/v1/pages/{lead_id}",
                              headers=hdrs, timeout=10).json()
            current_stage = (lp.get("properties", {}).get("Stage", {})
                               .get("status", {}) or {}).get("name", "")
            if current_stage in ("Lead", "Qualified"):
                requests.patch(
                    f"https://api.notion.com/v1/pages/{lead_id}",
                    headers=hdrs,
                    json={"properties": {"Stage": {"status": {"name": "Quotation Issued"}}}},
                    timeout=10,
                )
                print(f"[INFO] Lead {lead_id[:8]} advanced to Quotation Issued", file=sys.stderr)
            else:
                print(f"[INFO] Lead {lead_id[:8]} already at {current_stage!r} — no stage change", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] advance_lead_stage: {e}", file=sys.stderr)


def mark_issued_and_write_wa_link(page_id, wa_url, hdrs):
    """Update Quotation: Status → Issued, WA Link → wa_url. Also advance linked Lead stage."""
    # Make sure the WA Link field exists in the DB before writing to it
    if wa_url:
        ensure_wa_link_property(page_id, hdrs)

    payload = {
        "properties": {
            "Status": {"select": {"name": "Issued"}},
        }
    }
    if wa_url:
        payload["properties"]["WA Link"] = {"url": wa_url}

    r = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json=payload, timeout=10
    )
    if not r.ok:
        print(f"[WARN] Notion PATCH {r.status_code}: {r.text[:200]}", file=sys.stderr)

    # Advance linked Lead to "Quotation Issued"
    advance_lead_stage(page_id, hdrs)

    return r.ok


class handler(BaseHTTPRequestHandler):

    def _respond(self, code, body_dict):
        body = json.dumps(body_dict).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._respond(200, {"service": "Vision Core — Send Quotation to Client",
                            "status":  "ready"})

    def do_POST(self):
        try:
            secret = os.environ.get("WEBHOOK_SECRET", "")
            if secret and self.headers.get("Authorization", "") != f"Bearer {secret}":
                self._respond(401, {"error": "Unauthorized"}); return

            length = int(self.headers.get("Content-Length", 0))
            raw    = self.rfile.read(length) if length > 0 else b"{}"
            body   = json.loads(raw) if raw else {}

            print(f"[DEBUG] payload: {json.dumps(body)}", file=sys.stderr)

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
                self._respond(400, {"error": "No page_id"}); return

            if not os.environ.get("NOTION_API_KEY"):
                self._respond(500, {"error": "NOTION_API_KEY not set"}); return

            hdrs = _hdrs()
            data = fetch_quotation_for_wa(page_id, hdrs)
            print(f"[INFO] Quotation: {data['quotation_no']} | PIC phone: {data['pic_phone']}",
                  file=sys.stderr)

            wa_url = build_whatsapp_url(data)
            if not wa_url:
                print("[WARN] No PIC phone found — WA link not generated", file=sys.stderr)

            ok = mark_issued_and_write_wa_link(page_id, wa_url, hdrs)

            resp = {
                "status":       "success" if ok else "partial",
                "quotation_no": data["quotation_no"],
                "wa_url":       wa_url or None,
                "notion_updated": ok,
            }
            if not data["pic_phone"]:
                resp["warning"] = "No phone number found on PIC — add a Phone field to the PIC/Contacts DB"
            if not data["pdf_url"]:
                resp["note"] = "PDF not yet generated — generate PDF first for a richer WA message"

            self._respond(200, resp)

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)
