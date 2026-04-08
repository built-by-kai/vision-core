"""
create_invoice.py
POST /api/create_invoice   { "page_id": "<quotation_page_id>" }

Triggered by Notion automation when Quotation Status → Approved.
Creates a pre-filled Invoice page, links it to the Quotation, and
returns the new Invoice page ID.

Auto-determines Invoice Type:
  Payment Terms = "Full Upfront"  → Full Payment (no deposit)
  Payment Terms = "50% Deposit"   → Deposit invoice first

Quotation DB  : f8167f0bda054307b90b17ad6b9c5cf8
Invoice DB    : 9227dda9c4be42a1a4c6b1bce4862f8c
"""
import json
import os
import sys
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler

import requests

QUOTATION_DB = "f8167f0bda054307b90b17ad6b9c5cf8"
INVOICE_DB   = "9227dda9c4be42a1a4c6b1bce4862f8c"


def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def _hdrs():
    api_key = os.environ.get("NOTION_API_KEY", "")
    return {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


def fetch_quotation(page_id, hdrs):
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                     headers=hdrs, timeout=15)
    r.raise_for_status()
    props = r.json().get("properties", {})

    quotation_no   = _plain(props.get("Quotation No.", {}).get("title", []))
    amount         = props.get("Amount", {}).get("number") or 0
    payment_terms  = (props.get("Payment Terms", {}).get("select") or {}).get("name", "")
    issue_date     = (props.get("Issue Date", {}).get("date") or {}).get("start", "")
    status         = (props.get("Status", {}).get("select") or {}).get("name", "")

    # Company relation IDs
    company_ids = [rel["id"] for rel in props.get("Company", {}).get("relation", [])]

    # Already-linked invoices (avoid creating duplicates)
    existing_invoices = [rel["id"] for rel in props.get("Invoice", {}).get("relation", [])]

    return {
        "quotation_no":      quotation_no,
        "amount":            amount,
        "payment_terms":     payment_terms,
        "issue_date":        issue_date,
        "status":            status,
        "company_ids":       company_ids,
        "existing_invoices": existing_invoices,
    }


def create_invoice(quotation_id, quotation_data, hdrs):
    """Create the Invoice page in Notion and link it back to the Quotation."""
    today     = datetime.now().date().isoformat()
    terms     = quotation_data.get("payment_terms", "")
    amount    = quotation_data.get("amount", 0)

    # Determine invoice type and due date
    if terms == "Full Upfront":
        inv_type   = "Full Payment"
        dep_amount = None
        # Due in 7 days
        due_date   = (datetime.now() + timedelta(days=7)).date().isoformat()
        inv_status = "Deposit Pending"   # reuse field — treated as "payment pending"
    else:
        # 50% Deposit (default)
        inv_type   = "Deposit"
        dep_amount = round(amount * 0.5, 2) if amount else None
        due_date   = (datetime.now() + timedelta(days=7)).date().isoformat()
        inv_status = "Deposit Pending"

    # Build properties
    props = {
        "Invoice No.":   {"title": [{"text": {"content": ""}}]},  # auto-numbered on Generate PDF
        "Invoice Type":  {"select": {"name": inv_type}},
        "Status":        {"select": {"name": inv_status}},
        "Issue Date":    {"date": {"start": today}},
        "Total Amount":  {"number": amount},
        "Quotation":     {"relation": [{"id": quotation_id}]},
    }

    if quotation_data["company_ids"]:
        props["Company"] = {"relation": [{"id": quotation_data["company_ids"][0]}]}

    if dep_amount is not None:
        props["Deposit Paid"] = {"number": dep_amount}

    if inv_type == "Deposit":
        props["Payment Deposit Date"] = {"date": {"start": due_date}}
    else:
        props["Payment Balance Date"] = {"date": {"start": due_date}}

    body = {
        "parent":     {"database_id": INVOICE_DB},
        "icon":       {"type": "emoji", "emoji": "🧾"},
        "properties": props,
    }

    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs, json=body, timeout=15)
    r.raise_for_status()
    return r.json()


class handler(BaseHTTPRequestHandler):

    def _respond(self, code, body_dict):
        body = json.dumps(body_dict).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._respond(200, {"service": "Vision Core — Create Invoice from Quotation",
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

            # Extract quotation page_id
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
            quotation = fetch_quotation(page_id, hdrs)

            print(f"[INFO] Quotation: {quotation['quotation_no']} | "
                  f"Status: {quotation['status']} | Terms: {quotation['payment_terms']}",
                  file=sys.stderr)

            # Guard: only create if Approved
            if quotation["status"] != "Approved":
                self._respond(200, {
                    "status":  "skipped",
                    "reason":  f"Quotation status is '{quotation['status']}', not Approved",
                }); return

            # Guard: don't create duplicate if an invoice already exists
            if quotation["existing_invoices"]:
                self._respond(200, {
                    "status":  "skipped",
                    "reason":  "Invoice already exists for this quotation",
                    "invoice_ids": quotation["existing_invoices"],
                }); return

            new_inv = create_invoice(page_id, quotation, hdrs)
            inv_id  = new_inv["id"]

            print(f"[INFO] Invoice created: {inv_id}", file=sys.stderr)

            self._respond(200, {
                "status":       "success",
                "quotation_no": quotation["quotation_no"],
                "invoice_id":   inv_id,
                "invoice_type": "Full Payment" if quotation["payment_terms"] == "Full Upfront" else "Deposit",
            })

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)
