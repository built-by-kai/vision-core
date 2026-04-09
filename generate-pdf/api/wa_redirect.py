"""
wa_redirect.py
GET /api/wa_redirect?page_id=<quotation_page_id>

Opens WhatsApp directly — no Notion field needed.
Fetches the quotation PIC phone + PDF URL, builds a wa.me link,
then HTTP 302 redirects the browser straight to WhatsApp.

Usage in Notion:
  Add a Formula property to the Quotation DB:
    "https://vision-core-delta.vercel.app/api/wa_redirect?page_id=" + id()
  Click that URL → WhatsApp opens instantly with pre-filled message.
"""
import os
import re
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse, quote as url_quote

import requests


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
    digits = re.sub(r"\D", "", phone)
    if digits.startswith("0"):
        digits = "6" + digits
    return digits


def build_wa_url(page_id: str, hdrs: dict) -> str:
    """Fetch quotation page and build wa.me redirect URL."""
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                     headers=hdrs, timeout=15)
    r.raise_for_status()
    page  = r.json()
    props = page.get("properties", {})

    # Quotation number (title property)
    quotation_no = ""
    for v in props.values():
        if v.get("type") == "title":
            quotation_no = _plain(v.get("title", []))
            break

    # PDF URL
    pdf_url = props.get("PDF", {}).get("url") or ""

    # Company name
    company_name = ""
    for rel in props.get("Company", {}).get("relation", [])[:1]:
        try:
            cr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=hdrs, timeout=10)
            cr.raise_for_status()
            for v in cr.json().get("properties", {}).values():
                if v.get("type") == "title":
                    company_name = _plain(v.get("title", []))
                    break
        except Exception as e:
            print(f"[WARN] company: {e}", file=sys.stderr)

    # PIC name + phone
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

    phone = clean_phone(pic_phone)
    if not phone:
        return ""

    greeting = f"Hi {pic_name}," if pic_name else "Hi,"
    subject  = f"Quotation {quotation_no}" if quotation_no else "our quotation"
    for_whom = f" for {company_name}" if company_name else ""

    lines = [
        greeting, "",
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


class handler(BaseHTTPRequestHandler):

    def _html(self, code, body_html):
        body = body_html.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            qs       = parse_qs(urlparse(self.path).query)
            page_id  = (qs.get("page_id") or qs.get("id") or [None])[0]

            if not page_id:
                self._html(400, "<h2>Missing page_id parameter</h2>")
                return

            page_id = page_id.replace("-", "")

            if not os.environ.get("NOTION_API_KEY"):
                self._html(500, "<h2>NOTION_API_KEY not set</h2>")
                return

            hdrs   = _hdrs()
            wa_url = build_wa_url(page_id, hdrs)

            if not wa_url:
                self._html(400, (
                    "<h2>No phone number found</h2>"
                    "<p>Make sure the PIC linked to this quotation has a Phone field.</p>"
                ))
                return

            print(f"[INFO] Redirecting to: {wa_url[:80]}...", file=sys.stderr)

            # HTTP 302 redirect straight to WhatsApp
            body = f'<meta http-equiv="refresh" content="0;url={wa_url}">'.encode()
            self.send_response(302)
            self.send_header("Location", wa_url)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._html(500, f"<h2>Error</h2><pre>{e}</pre>")

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)
