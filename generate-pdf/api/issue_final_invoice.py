"""
issue_final_invoice.py
POST /api/issue_final_invoice   { "page_id": "<project_page_id>" }

Triggered by a Notion button "Issue Final Invoice" on the Projects page
when build is complete and you're ready for handover.

What it does:
  1. Fetches the Projects page → gets Company, Quotation, Deposit Invoice, Lead
  2. From Quotation reads: Total Amount, Payment Terms, Final Payment amount
  3. Creates a Final Payment invoice in Invoices DB:
       - Invoice Type  : Final Payment
       - Status        : Balance Pending
       - Company       : [from project]
       - Quotation     : [from project]
       - Lead          : [from project]
       - Implementation: [this project]
       - Deposit Invoice: [deposit invoice]
       - Final Payment : Total Amount - Deposit (50%)
       - Issue Date    : today
  4. Auto-generates the Final Invoice PDF
  5. Updates Projects status → In Review (awaiting client sign-off + final payment)
  6. Advances Lead stage → Pending Final Payment
  7. Returns { invoice_id, invoice_pdf }

DBs
───
Projects     : 5719b2672d3442a29a22637a35398260
Invoices     : 9227dda9c4be42a1a4c6b1bce4862f8c
Quotations   : f8167f0bda054307b90b17ad6b9c5cf8
Leads CRM    : 8690d55c4d0449068c51ef49d92a26a2
"""
import json
import os
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler

import requests

PROJECTS_DB  = "5719b2672d3442a29a22637a35398260"
INVOICES_DB  = "9227dda9c4be42a1a4c6b1bce4862f8c"
LEADS_DB     = "8690d55c4d0449068c51ef49d92a26a2"


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
    project_id = raw_id.replace("-", "")

    proj = get_page(project_id, hdrs)
    props = proj.get("properties", {})

    # Validate project status — must be Build Started or In Review
    status = (props.get("Status", {}).get("select") or {}).get("name", "")
    if status == "Completed":
        raise ValueError("Project already completed")

    print(f"[INFO] Issuing final invoice for project {project_id[:8]} (status={status})", file=sys.stderr)

    # ── Gather IDs from Project ───────────────
    company_ids   = [r["id"].replace("-", "") for r in props.get("Company", {}).get("relation", [])]
    quotation_ids = [r["id"].replace("-", "") for r in props.get("Quotation", {}).get("relation", [])]
    invoice_ids   = [r["id"].replace("-", "") for r in props.get("Invoice", {}).get("relation", [])]
    lead_ids      = [r["id"].replace("-", "") for r in props.get("PIC", {}).get("relation", [])]  # PIC = Lead relation on Projects DB

    company_id   = company_ids[0]   if company_ids   else None
    quotation_id = quotation_ids[0] if quotation_ids else None
    deposit_inv_id = invoice_ids[0] if invoice_ids   else None
    lead_id      = lead_ids[0]      if lead_ids      else None

    # ── Get amounts from Quotation ────────────
    total_amount  = 0
    deposit_amt   = 0
    final_payment = 0
    payment_terms = "50% Deposit"

    if quotation_id:
        try:
            qp = get_page(quotation_id, hdrs).get("properties", {})
            total_amount  = qp.get("Amount", {}).get("number") or 0
            payment_terms = (qp.get("Payment Terms", {}).get("select") or {}).get("name", "50% Deposit")
            # Deposit Due (50%) is a formula — read the deposit invoice for actual amount
        except Exception as e:
            print(f"[WARN] Quotation fetch: {e}", file=sys.stderr)

    # Get deposit amount from deposit invoice
    if deposit_inv_id:
        try:
            dp = get_page(deposit_inv_id, hdrs).get("properties", {})
            deposit_amt = dp.get("Deposit (50%)", {}).get("number") or 0
        except Exception as e:
            print(f"[WARN] Deposit invoice fetch: {e}", file=sys.stderr)

    if payment_terms == "Full Upfront":
        raise ValueError("This was a Full Upfront payment — no final invoice needed")

    final_payment = total_amount - deposit_amt if deposit_amt else (total_amount * 0.5)
    today = date.today().isoformat()

    # ── Create Final Invoice ──────────────────
    inv_props = {
        "Invoice No.":    {"title": [{"text": {"content": ""}}]},
        "Invoice Type":   {"select": {"name": "Final Payment"}},
        "Status":         {"select": {"name": "Balance Pending"}},
        "Issue Date":     {"date": {"start": today}},
        "Total Amount":   {"number": total_amount},
        "Final Payment":  {"number": round(final_payment, 2)},
        "Payment Terms":  {"select": {"name": payment_terms}},
        "Implementation": {"relation": [{"id": project_id}]},
    }
    if company_id:
        inv_props["Company"]  = {"relation": [{"id": company_id}]}
    if quotation_id:
        inv_props["Quotation"] = {"relation": [{"id": quotation_id}]}
    if deposit_inv_id:
        inv_props["Deposit Invoice"] = {"relation": [{"id": deposit_inv_id}]}
        # Also set self as Final Invoice on deposit invoice
    if lead_id:
        inv_props["Lead"] = {"relation": [{"id": lead_id}]}

    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs,
                      json={"parent": {"database_id": INVOICES_DB}, "properties": inv_props},
                      timeout=15)
    if not r.ok:
        raise ValueError(f"Create final invoice failed {r.status_code}: {r.text[:300]}")

    inv_page    = r.json()
    inv_id      = inv_page["id"].replace("-", "")
    print(f"[INFO] Final invoice created: {inv_id}", file=sys.stderr)

    # Link deposit invoice → this final invoice
    if deposit_inv_id:
        patch_page(deposit_inv_id, {"Final Invoice": {"relation": [{"id": inv_id}]}}, hdrs)

    # ── Auto-generate Final Invoice PDF ──────
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
            print(f"[INFO] Final invoice PDF generated: {pdf_url[:60]}", file=sys.stderr)
        else:
            print(f"[WARN] PDF gen {gr.status_code}: {gr.text[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] PDF auto-gen: {e}", file=sys.stderr)

    # ── Update Project → In Review ────────────
    patch_page(project_id, {"Status": {"select": {"name": "In Review"}}}, hdrs)
    print(f"[INFO] Project → In Review", file=sys.stderr)

    # ── Advance Lead → Pending Final Payment ──
    if lead_id:
        lp = get_page(lead_id, hdrs).get("properties", {})
        current = (lp.get("Stage", {}).get("status") or {}).get("name", "")
        if current not in ("Pending Final Payment", "Closed – Paid"):
            patch_page(lead_id, {"Stage": {"status": {"name": "Pending Final Payment"}}}, hdrs)
            print(f"[INFO] Lead {lead_id[:8]} → Pending Final Payment", file=sys.stderr)

    return {
        "status":          "success",
        "project_id":      project_id,
        "final_invoice_id": inv_id,
        "invoice_pdf":     pdf_url,
        "final_payment":   round(final_payment, 2),
        "total_amount":    total_amount,
        "lead_id":         lead_id,
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
            "service": "Vision Core — Issue Final Invoice",
            "status":  "ready",
            "usage":   "POST with {page_id} from a Projects page",
        })

    def do_POST(self):
        try:
            length  = int(self.headers.get("Content-Length", 0))
            raw     = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw) if raw else {}
            print(f"[DEBUG] issue_final_invoice: {json.dumps(payload)[:300]}", file=sys.stderr)
            result = process(payload)
            self._respond(200, result)
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[HTTP] {fmt % args}", file=sys.stderr)
