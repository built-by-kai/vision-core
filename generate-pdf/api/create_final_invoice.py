"""
create_final_invoice.py
POST /api/create_final_invoice   { "page_id": "<deposit_invoice_page_id>" }

Triggered by Notion automation when Deposit Invoice Status → "Deposit Received".
1. Reads the Deposit invoice (amounts, company, PIC, quotation link)
2. Auto-creates "Deposit Paid" + "Balance Paid" date fields in Invoice DB if missing
3. Creates a Final Payment invoice row pre-filled with all correct amounts
4. Links it back to the same Quotation

Invoice DB : 9227dda9c4be42a1a4c6b1bce4862f8c
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler

import requests

INVOICE_DB  = "9227dda9c4be42a1a4c6b1bce4862f8c"
QUO_PATTERN = re.compile(r"^QUO-(\d{4})-(\d{4})$")
INV_PATTERN = re.compile(r"^INV-(\d{4})-(\d{4})(-[DSFR])?$")


def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def _hdrs():
    api_key = os.environ.get("NOTION_API_KEY", "")
    return {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


# ─────────────────────────────────────────────
#  Ensure "Deposit Paid" + "Balance Paid" date
#  fields exist in the Invoice DB
# ─────────────────────────────────────────────
def ensure_date_fields(hdrs):
    """
    Check Invoice DB schema and create 'Deposit Paid' and 'Balance Paid'
    date fields if they don't already exist.
    """
    r = requests.get(f"https://api.notion.com/v1/databases/{INVOICE_DB}",
                     headers=hdrs, timeout=10)
    if not r.ok:
        print(f"[WARN] Could not fetch Invoice DB schema: {r.status_code}", file=sys.stderr)
        return
    existing = {k for k in r.json().get("properties", {})}
    needed   = {"Deposit Paid", "Balance Paid"} - existing
    if not needed:
        print(f"[INFO] Date fields already exist", file=sys.stderr)
        return
    patch_props = {name: {"date": {}} for name in needed}
    pr = requests.patch(
        f"https://api.notion.com/v1/databases/{INVOICE_DB}",
        headers=hdrs,
        json={"properties": patch_props},
        timeout=10,
    )
    if pr.ok:
        print(f"[INFO] Created fields: {needed}", file=sys.stderr)
    else:
        print(f"[WARN] Could not create date fields {pr.status_code}: {pr.text[:200]}", file=sys.stderr)


# ─────────────────────────────────────────────
#  Read the Deposit invoice page
# ─────────────────────────────────────────────
def fetch_deposit_invoice(page_id, hdrs):
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                     headers=hdrs, timeout=15)
    if not r.ok:
        raise ValueError(f"Notion GET /pages/{page_id} returned {r.status_code}: {r.text[:300]}")
    props = r.json().get("properties", {})

    invoice_no   = _plain(props.get("Invoice No.", {}).get("title", []))
    invoice_type = (props.get("Invoice Type", {}).get("select") or {}).get("name", "")
    status       = (props.get("Status",       {}).get("select") or {}).get("name", "")
    total_amount = props.get("Amount", {}).get("number") or 0
    deposit_amt  = props.get("Deposit Due (50%)", {}).get("number") or 0
    pay_balance  = props.get("Payment Balance", {}).get("number") or 0
    issue_date   = (props.get("Issue Date", {}).get("date") or {}).get("start", "")

    # Relations
    quotation_ids = [rel["id"] for rel in props.get("Quotation", {}).get("relation", [])]
    company_ids   = [rel["id"] for rel in props.get("Company",   {}).get("relation", [])]

    # PIC — rollup of relation or direct relation
    pic_ids  = []
    pic_prop = props.get("PIC", {})
    if pic_prop.get("type") == "rollup":
        for item in pic_prop.get("rollup", {}).get("array", []):
            t = item.get("type", "")
            if t == "relation":
                pic_ids = [r2["id"] for r2 in item.get("relation", [])]; break
            if t in ("title", "rich_text"):
                # Name only — can't resolve to ID here, skip
                break
    elif pic_prop.get("type") == "relation":
        pic_ids = [rel["id"] for rel in pic_prop.get("relation", [])]

    # Payment Terms
    payment_terms = (props.get("Payment Terms", {}).get("select") or {}).get("name", "")

    # Deposit Paid date (to copy onto Final invoice)
    deposit_paid_date = (props.get("Deposit Paid", {}).get("date") or {}).get("start", "")

    return {
        "invoice_no":        invoice_no,
        "invoice_type":      invoice_type,
        "status":            status,
        "total_amount":      total_amount,
        "deposit_amt":       deposit_amt,
        "pay_balance":       pay_balance,
        "issue_date":        issue_date,
        "quotation_ids":     quotation_ids,
        "company_ids":       company_ids,
        "pic_ids":           pic_ids,
        "payment_terms":     payment_terms,
        "deposit_paid_date": deposit_paid_date,
    }


# ─────────────────────────────────────────────
#  Derive Final invoice number from Deposit no.
# ─────────────────────────────────────────────
def make_final_inv_no(deposit_inv_no):
    """
    INV-2026-0001-D  →  INV-2026-0001-F
    INV-2026-0001    →  INV-2026-0001-F
    """
    m = INV_PATTERN.match(deposit_inv_no or "")
    if m:
        return f"INV-{m.group(1)}-{m.group(2)}-F"
    # Fallback
    ts = datetime.now().strftime("%H%M")
    return f"INV-{datetime.now().year}-{ts}-F"


# ─────────────────────────────────────────────
#  Check for existing Final invoice (avoid dupes)
# ─────────────────────────────────────────────
def find_existing_final(quotation_ids, hdrs):
    """Return existing Final Payment invoice ID if one already exists."""
    if not quotation_ids:
        return None
    try:
        r = requests.post(
            f"https://api.notion.com/v1/databases/{INVOICE_DB}/query",
            headers=hdrs,
            json={
                "filter": {
                    "and": [
                        {"property": "Quotation",     "relation": {"contains": quotation_ids[0]}},
                        {"property": "Invoice Type",  "select":   {"equals": "Final Payment"}},
                    ]
                }
            },
            timeout=10,
        )
        if r.ok:
            results = r.json().get("results", [])
            if results:
                return results[0]["id"]
    except Exception as e:
        print(f"[WARN] Duplicate check: {e}", file=sys.stderr)
    return None


# ─────────────────────────────────────────────
#  Create the Final Payment invoice page
# ─────────────────────────────────────────────
def create_final_invoice(deposit_data, hdrs):
    today    = datetime.now().date().isoformat()
    due_date = (datetime.now() + timedelta(days=14)).date().isoformat()

    total_amount = deposit_data["total_amount"]
    deposit_amt  = deposit_data["deposit_amt"]
    # Balance = total - deposit; fall back to stored pay_balance if available
    balance      = deposit_data["pay_balance"] or round(total_amount - deposit_amt, 2)

    final_no = make_final_inv_no(deposit_data["invoice_no"])

    props = {
        "Invoice No.":      {"title":  [{"text": {"content": final_no}}]},
        "Invoice Type":     {"select": {"name": "Final Payment"}},
        "Status":           {"select": {"name": "Balance Pending"}},
        "Issue Date":       {"date":   {"start": today}},
        "Amount":           {"number": total_amount},
        "Deposit Due (50%)":{"number": deposit_amt},
        "Payment Balance":  {"number": balance},
        "Balance Due":      {"date":   {"start": due_date}},
        "Payment Method":   {"select": {"name": "Bank Transfer"}},
    }

    if deposit_data.get("payment_terms"):
        props["Payment Terms"] = {"select": {"name": deposit_data["payment_terms"]}}

    if deposit_data.get("quotation_ids"):
        props["Quotation"] = {"relation": [{"id": deposit_data["quotation_ids"][0]}]}

    if deposit_data.get("company_ids"):
        props["Company"] = {"relation": [{"id": deposit_data["company_ids"][0]}]}

    if deposit_data.get("pic_ids"):
        props["PIC"] = {"relation": [{"id": deposit_data["pic_ids"][0]}]}

    # Copy Deposit Paid date so Final invoice shows when deposit was received
    if deposit_data.get("deposit_paid_date"):
        props["Deposit Paid"] = {"date": {"start": deposit_data["deposit_paid_date"]}}

    # Link back to the Deposit invoice
    if deposit_data.get("deposit_page_id"):
        props["Deposit Invoice"] = {"relation": [{"id": deposit_data["deposit_page_id"]}]}

    body = {
        "parent":     {"database_id": INVOICE_DB},
        "icon":       {"type": "emoji", "emoji": "🧾"},
        "properties": props,
    }

    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs, json=body, timeout=15)
    if not r.ok:
        # Retry without PIC if that caused the error
        if "PIC" in r.text:
            props.pop("PIC", None)
            body["properties"] = props
            r = requests.post("https://api.notion.com/v1/pages",
                              headers=hdrs, json=body, timeout=15)
        if not r.ok:
            raise ValueError(f"Notion rejected final invoice creation ({r.status_code}): {r.text[:400]}")

    return r.json()


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
            "service": "Vision Core — Create Final Invoice from Deposit Invoice",
            "status":  "ready",
        })

    def do_POST(self):
        try:
            secret = os.environ.get("WEBHOOK_SECRET", "")
            if secret and self.headers.get("Authorization", "") != f"Bearer {secret}":
                self._respond(401, {"error": "Unauthorized"}); return

            length = int(self.headers.get("Content-Length", 0))
            raw    = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw)
            except Exception:
                body = {}

            print(f"[DEBUG] payload: {json.dumps(body)}", file=sys.stderr)

            # Extract page_id (deposit invoice page)
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
                self._respond(400, {"error": "No page_id found"}); return

            if not os.environ.get("NOTION_API_KEY"):
                self._respond(500, {"error": "NOTION_API_KEY not set"}); return

            hdrs  = _hdrs()
            force = body.get("force", False)

            # 1. Fetch deposit invoice data
            deposit = fetch_deposit_invoice(page_id, hdrs)
            print(f"[INFO] Deposit invoice: {deposit['invoice_no']} | "
                  f"Status: {deposit['status']} | Type: {deposit['invoice_type']}",
                  file=sys.stderr)

            # Guard: only trigger when Status = "Deposit Received"
            if not force and deposit["status"] != "Deposit Received":
                self._respond(200, {
                    "status": "skipped",
                    "reason": f"Invoice status is '{deposit['status']}', not 'Deposit Received'",
                }); return

            # Guard: must be a Deposit type invoice
            if not force and deposit["invoice_type"] != "Deposit":
                self._respond(200, {
                    "status": "skipped",
                    "reason": f"Invoice type is '{deposit['invoice_type']}', not 'Deposit'",
                }); return

            # Guard: don't create duplicate Final invoice
            existing = find_existing_final(deposit["quotation_ids"], hdrs)
            if existing and not force:
                self._respond(200, {
                    "status":            "skipped",
                    "reason":            "Final Payment invoice already exists",
                    "final_invoice_id":  existing,
                }); return

            # 2. Ensure date fields exist in Invoice DB
            ensure_date_fields(hdrs)

            # 3. Create Final Payment invoice (pass deposit page ID for back-link)
            deposit["deposit_page_id"] = page_id
            final_page = create_final_invoice(deposit, hdrs)
            final_id   = final_page["id"]
            final_no   = make_final_inv_no(deposit["invoice_no"])
            print(f"[INFO] Final invoice created: {final_id} ({final_no})", file=sys.stderr)

            # 4. Write "Final Invoice" relation back onto the Deposit invoice row
            try:
                bl = requests.patch(
                    f"https://api.notion.com/v1/pages/{page_id}",
                    headers=hdrs,
                    json={"properties": {"Final Invoice": {"relation": [{"id": final_id}]}}},
                    timeout=10,
                )
                if bl.ok:
                    print(f"[INFO] Back-linked Final Invoice onto Deposit row", file=sys.stderr)
                else:
                    print(f"[WARN] Back-link failed {bl.status_code}: {bl.text[:150]}", file=sys.stderr)
            except Exception as e:
                print(f"[WARN] Back-link error: {e}", file=sys.stderr)

            self._respond(200, {
                "status":           "success",
                "deposit_inv_no":   deposit["invoice_no"],
                "final_invoice_id": final_id,
                "final_invoice_no": final_no,
                "total_amount":     deposit["total_amount"],
                "balance_due":      deposit["pay_balance"] or round(deposit["total_amount"] - deposit["deposit_amt"], 2),
            })

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)
