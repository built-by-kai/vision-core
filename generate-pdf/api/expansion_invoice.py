"""
expansion_invoice.py
POST /api/expansion_invoice   { "page_id": "<expansion_page_id>" }

Triggered by a Notion button "Create Invoice" on the Expansions page.

What it does:
  1. Fetches the Expansion page → Name, Value, Type, Client (Company), Implementation, Deal (Lead)
  2. Creates a Supplementary invoice in Invoices DB:
       - Invoice Type  : Supplementary
       - Status        : Deposit Pending  (expansions use same 50% deposit flow if Value > RM800,
                         or Full Upfront for Micro add-ons)
       - Total Amount  : Expansion.Value
       - Company       : Expansion.Client
       - Implementation: Expansion.Implementation
       - Lead          : Expansion.Deal
       - Issue Date    : today
  3. Links the new Invoice back to Expansion.Invoice
  4. Auto-generates the Supplementary Invoice PDF
  5. Updates Expansion status → Proposal Sent
  6. Returns { invoice_id, invoice_pdf }

Payment logic:
  - Micro Add-On (RM300–800)       → Full Upfront
  - Standard Add-On (RM800–2K)     → 50% Deposit
  - Major Expansion (RM2K+)        → 50% Deposit

DBs
───
Expansions   : 47a500ac8dd4464d96a8e4d799485421
Invoices     : 9227dda9c4be42a1a4c6b1bce4862f8c
"""
import json
import os
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler

import requests

EXPANSIONS_DB = "47a500ac8dd4464d96a8e4d799485421"
INVOICES_DB   = "9227dda9c4be42a1a4c6b1bce4862f8c"


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
    expansion_id = raw_id.replace("-", "")

    exp = get_page(expansion_id, hdrs)
    props = exp.get("properties", {})

    # Expansion fields
    exp_name = _plain(props.get("Name", {}).get("title", []))
    exp_value = props.get("Value", {}).get("number") or 0
    exp_type  = (props.get("Type", {}).get("select") or {}).get("name", "")
    exp_status = (props.get("Status", {}).get("select") or {}).get("name", "")

    print(f"[INFO] Creating invoice for expansion: {exp_name!r} value={exp_value} type={exp_type}", file=sys.stderr)

    if exp_status in ("Deposit Pending", "Deposit Paid", "In Progress", "Final Pending", "Closed – Paid"):
        raise ValueError(f"Expansion already has an active invoice (status: {exp_status})")

    # Linked IDs
    company_ids = [r["id"].replace("-", "") for r in props.get("Client", {}).get("relation", [])]
    impl_ids    = [r["id"].replace("-", "") for r in props.get("Implementation", {}).get("relation", [])]
    lead_ids    = [r["id"].replace("-", "") for r in props.get("Deal", {}).get("relation", [])]

    company_id = company_ids[0] if company_ids else None
    impl_id    = impl_ids[0]    if impl_ids    else None
    lead_id    = lead_ids[0]    if lead_ids    else None

    # Payment terms: Micro = Full Upfront, Standard/Major = 50% Deposit
    is_micro = "Micro" in exp_type
    payment_terms  = "Full Upfront" if is_micro else "50% Deposit"
    inv_status     = "Full Payment Received" if is_micro else "Deposit Pending"
    # For micro, full amount upfront. For others, deposit = 50%
    deposit_amt    = 0 if is_micro else round(exp_value * 0.5, 2)
    final_pay_amt  = 0 if is_micro else round(exp_value * 0.5, 2)

    today = date.today().isoformat()

    # ── Create Supplementary Invoice ──────────
    inv_props = {
        "Invoice No.":   {"title": [{"text": {"content": ""}}]},
        "Invoice Type":  {"select": {"name": "Supplementary"}},
        "Status":        {"select": {"name": "Deposit Pending" if not is_micro else "Balance Pending"}},
        "Issue Date":    {"date": {"start": today}},
        "Total Amount":  {"number": exp_value},
        "Payment Terms": {"select": {"name": payment_terms}},
    }
    if not is_micro and deposit_amt:
        inv_props["Deposit (50%)"]  = {"number": deposit_amt}
        inv_props["Final Payment"]  = {"number": final_pay_amt}
    if company_id:
        inv_props["Company"]        = {"relation": [{"id": company_id}]}
    if impl_id:
        inv_props["Implementation"] = {"relation": [{"id": impl_id}]}
    if lead_id:
        inv_props["Deal Source"]    = {"relation": [{"id": lead_id}]}

    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs,
                      json={"parent": {"database_id": INVOICES_DB}, "properties": inv_props},
                      timeout=15)
    if not r.ok:
        raise ValueError(f"Create invoice failed {r.status_code}: {r.text[:300]}")

    inv_page = r.json()
    inv_id   = inv_page["id"].replace("-", "")
    print(f"[INFO] Supplementary invoice created: {inv_id}", file=sys.stderr)

    # ── Link Invoice back to Expansion ───────
    patch_page(expansion_id, {
        "Invoice": {"relation": [{"id": inv_id}]},
        "Status":  {"select": {"name": "Proposal Sent"}},
    }, hdrs)

    # ── Auto-generate PDF ─────────────────────
    pdf_url = ""
    try:
        gen_hdrs = {"Content-Type": "application/json"}
        ws = os.environ.get("WEBHOOK_SECRET", "")
        if ws:
            gen_hdrs["Authorization"] = f"Bearer {ws}"
        gr = requests.post(
            "https://vision-core-delta.vercel.app/api/generate_invoice",
            headers=gen_hdrs, json={"page_id": inv_id}, timeout=55,
        )
        if gr.ok:
            pdf_url = gr.json().get("pdf_url", "")
            print(f"[INFO] Supplementary invoice PDF: {pdf_url[:60]}", file=sys.stderr)
        else:
            print(f"[WARN] PDF gen {gr.status_code}: {gr.text[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] PDF auto-gen: {e}", file=sys.stderr)

    return {
        "status":       "success",
        "expansion_id": expansion_id,
        "invoice_id":   inv_id,
        "invoice_pdf":  pdf_url,
        "exp_value":    exp_value,
        "payment_terms": payment_terms,
        "is_micro":     is_micro,
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
            "service": "Vision Core — Expansion Invoice",
            "status":  "ready",
            "usage":   "POST with {page_id} from an Expansions page",
        })

    def do_POST(self):
        try:
            length  = int(self.headers.get("Content-Length", 0))
            raw     = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw) if raw else {}
            print(f"[DEBUG] expansion_invoice: {json.dumps(payload)[:300]}", file=sys.stderr)
            result = process(payload)
            self._respond(200, result)
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[HTTP] {fmt % args}", file=sys.stderr)
