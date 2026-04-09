"""
generate_receipt.py
POST /api/generate_receipt   { "page_id": "<invoice_page_id>" }

Triggered by "Generate Receipt" button on Invoice page (after
Full Payment Received or Final Payment received).

1. Fetches Invoice data
2. Scans Receipt DB → assigns next REC-YYYY-XXXX number
3. Creates a Receipt page in Receipt DB (linked to Invoice + Company)
4. Generates a clean receipt PDF
5. Uploads to Vercel Blob → writes PDF URL back to Receipt page

Invoice DB  : 9227dda9c4be42a1a4c6b1bce4862f8c
Receipt DB  : 3b99088af86c48c598a6422d764b24ac
Collection  : 6ece1679-cb82-4f75-9a68-386de2ef63f7
"""
import json
import os
import re
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from io import BytesIO

import requests
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle,
    Paragraph, Spacer, HRFlowable
)

VISION_CORE_DETAILS_DB = "33c8b289e31a80b1aa85fc1921cc0adc"
RECEIPT_DB             = "3b99088af86c48c598a6422d764b24ac"

REC_PATTERN = re.compile(r"^REC-(\d{4})-(\d{4})$")

# ─────────────────────────────────────────────
#  Design tokens
# ─────────────────────────────────────────────
C_BLACK = colors.HexColor("#111827")
C_D700  = colors.HexColor("#374151")
C_D600  = colors.HexColor("#4B5563")
C_D500  = colors.HexColor("#6B7280")
C_D400  = colors.HexColor("#9CA3AF")
C_D300  = colors.HexColor("#D1D5DB")
C_D200  = colors.HexColor("#E5E7EB")
C_D100  = colors.HexColor("#F3F4F6")
C_D50   = colors.HexColor("#F9FAFB")
C_WHITE = colors.white


def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def _fmt_date(d):
    if not d:
        return ""
    try:
        return datetime.fromisoformat(d).strftime("%d %B %Y")
    except Exception:
        return d


# ─────────────────────────────────────────────
#  Our company details
# ─────────────────────────────────────────────
def fetch_company_details(hdrs):
    try:
        r = requests.post(
            f"https://api.notion.com/v1/databases/{VISION_CORE_DETAILS_DB}/query",
            headers=hdrs, json={}, timeout=10
        )
        r.raise_for_status()
        results = r.json().get("results", [])
        if not results:
            return {}
        p = results[0].get("properties", {})

        def _v(key):
            prop = p.get(key, {})
            t = prop.get("type", "")
            if t == "title":        return _plain(prop.get("title", []))
            if t == "rich_text":    return _plain(prop.get("rich_text", []))
            if t == "email":        return prop.get("email") or ""
            if t == "phone_number": return prop.get("phone_number") or ""
            return ""

        return {
            "name":  _v("Name"),
            "email": _v("Email"),
            "phone": _v("Phone"),
            "bank_name":           _v("Bank Name"),
            "bank_account_holder": _v("Bank Account Holder Name"),
            "bank_number":         _v("Bank Number"),
        }
    except Exception as e:
        print(f"[WARN] company details: {e}", file=sys.stderr)
        return {}


# ─────────────────────────────────────────────
#  Auto-numbering
# ─────────────────────────────────────────────
def next_receipt_number(year, hdrs):
    try:
        has_more, cursor, max_seq = True, None, 0
        while has_more:
            body = {"page_size": 100}
            if cursor:
                body["start_cursor"] = cursor
            r = requests.post(
                f"https://api.notion.com/v1/databases/{RECEIPT_DB}/query",
                headers=hdrs, json=body, timeout=15
            )
            r.raise_for_status()
            data     = r.json()
            has_more = data.get("has_more", False)
            cursor   = data.get("next_cursor")
            for page in data.get("results", []):
                props     = page.get("properties", {})
                title_arr = props.get("Receipt No.", {}).get("title", [])
                title     = "".join(t.get("plain_text", "") for t in title_arr)
                m = REC_PATTERN.match(title)
                if m and int(m.group(1)) == year:
                    max_seq = max(max_seq, int(m.group(2)))
        return f"REC-{year}-{max_seq + 1:04d}"
    except Exception as e:
        print(f"[WARN] auto-number receipt: {e}", file=sys.stderr)
        return f"REC-{year}-XXXX"


# ─────────────────────────────────────────────
#  Fetch invoice data
# ─────────────────────────────────────────────
def fetch_invoice_data(page_id, hdrs):
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                     headers=hdrs, timeout=15)
    r.raise_for_status()
    props = r.json().get("properties", {})

    invoice_no   = _plain(props.get("Invoice No.", {}).get("title", []))
    invoice_type = (props.get("Invoice Type", {}).get("select") or {}).get("name", "")
    status       = (props.get("Status",       {}).get("select") or {}).get("name", "")
    total_amount = props.get("Amount",            {}).get("number") or 0
    deposit_amt  = props.get("Deposit Due (50%)", {}).get("number") or 0
    pay_balance  = props.get("Payment Balance",   {}).get("number") or 0
    pay_method   = (props.get("Payment Method", {}).get("select") or {}).get("name", "")
    pay_methods  = [pay_method] if pay_method else []

    # Payment date — Deposit Paid for deposit invoices, Balance Paid for final/full
    dep_date = (props.get("Deposit Paid", {}).get("date") or {}).get("start", "")
    bal_date = (props.get("Balance Paid",  {}).get("date") or {}).get("start", "")
    pay_date = bal_date if invoice_type in ("Final Payment", "Full Payment") else (dep_date or bal_date)

    # Amount for receipt display
    if invoice_type == "Deposit":
        amount_paid = deposit_amt if deposit_amt > 0 else round(total_amount * 0.5, 2)
    else:
        # Final Payment or Full Payment — show total project amount
        amount_paid = total_amount

    # Keep the breakdown amounts for the summary section
    balance_paid = pay_balance if pay_balance > 0 else (total_amount - deposit_amt)

    # Company
    company_name = company_id = ""
    for rel in props.get("Company", {}).get("relation", [])[:1]:
        try:
            cr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=hdrs, timeout=10)
            cr.raise_for_status()
            cp = cr.json().get("properties", {})
            company_id = rel["id"].replace("-", "")
            for k in ["Company", "Name", "Company Name"]:
                if cp.get(k, {}).get("type") == "title":
                    company_name = _plain(cp[k]["title"]); break
        except Exception as e:
            print(f"[WARN] company: {e}", file=sys.stderr)

    # PIC — rollup of Primary Contact relation or direct relation
    pic_name = pic_email = ""
    pic_prop = props.get("PIC", {})
    pic_page_ids = []
    if pic_prop.get("type") == "rollup":
        for item in pic_prop.get("rollup", {}).get("array", []):
            t = item.get("type", "")
            if t == "relation":
                pic_page_ids = [r2["id"] for r2 in item.get("relation", [])]; break
    elif pic_prop.get("type") == "relation":
        pic_page_ids = [rel["id"] for rel in pic_prop.get("relation", [])]
    for pid in pic_page_ids[:1]:
        try:
            pr = requests.get(f"https://api.notion.com/v1/pages/{pid}",
                              headers=hdrs, timeout=10)
            pr.raise_for_status()
            pp = pr.json().get("properties", {})
            for k in ["Name", "Full Name"]:
                if pp.get(k, {}).get("type") == "title":
                    pic_name = _plain(pp[k]["title"]); break
            for k in ["Email", "email"]:
                if pp.get(k, {}).get("type") == "email":
                    pic_email = pp[k].get("email") or ""; break
        except Exception as e:
            print(f"[WARN] PIC: {e}", file=sys.stderr)

    return {
        "invoice_no":   invoice_no,
        "invoice_type": invoice_type,
        "status":       status,
        "total_amount": total_amount,
        "deposit_amt":  deposit_amt,
        "pay_balance":  pay_balance,
        "balance_paid": balance_paid,
        "amount_paid":  amount_paid,
        "pay_methods":  pay_methods,
        "pay_date":     pay_date,
        "dep_date":     dep_date,
        "bal_date":     bal_date,
        "company_name": company_name,
        "company_id":   company_id,
        "pic_name":     pic_name,
        "pic_email":    pic_email,
        "our_company":  fetch_company_details(hdrs),
    }


# ─────────────────────────────────────────────
#  Create Receipt page in Notion
# ─────────────────────────────────────────────
def create_receipt_page(invoice_page_id, receipt_no, data, hdrs):
    today    = datetime.now().date().isoformat()
    pay_date = data.get("pay_date") or today

    props = {
        "Receipt No.":  {"title": [{"text": {"content": receipt_no}}]},
        "Amount Paid":  {"number": data["amount_paid"]},
        "Payment Date": {"date": {"start": pay_date}},
        "Invoice":      {"relation": [{"id": invoice_page_id}]},
    }
    if data["company_id"]:
        props["Company"] = {"relation": [{"id": data["company_id"]}]}
    if data["pay_methods"]:
        props["Payment Method"] = {"multi_select": [{"name": m} for m in data["pay_methods"]]}

    body = {
        "parent":     {"database_id": RECEIPT_DB},
        "icon":       {"type": "emoji", "emoji": "🧾"},
        "properties": props,
    }
    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs, json=body, timeout=15)
    r.raise_for_status()
    return r.json()["id"]


# ─────────────────────────────────────────────
#  Generate Receipt PDF
# ─────────────────────────────────────────────
def generate_pdf(receipt_no, data):
    buffer = BytesIO()
    W, H   = A4
    margin = 20 * mm
    usable = W - 2 * margin

    co        = data.get("our_company", {})
    co_name   = co.get("name")  or "Vision Core"
    co_email  = co.get("email") or ""
    co_phone  = co.get("phone") or ""

    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=margin, leftMargin=margin,
        topMargin=14 * mm, bottomMargin=12 * mm,
    )
    styles = getSampleStyleSheet()

    def st(name, **kw):
        kw.setdefault("fontName",  "Helvetica")
        kw.setdefault("fontSize",  9)
        kw.setdefault("leading",   13)
        kw.setdefault("textColor", C_D700)
        return ParagraphStyle(name, parent=styles["Normal"], **kw)

    def tracked(text):
        # Use non-breaking spaces so ReportLab doesn't strip them
        return "&#160;".join(c if c != " " else "&#160;&#160;" for c in text)

    story = []

    # ── Top accent bar ────────────────────────
    story.append(HRFlowable(width=usable, color=C_BLACK, thickness=4, spaceAfter=6*mm))

    # ── Header ───────────────────────────────
    co_info = ""
    if co_phone: co_info += co_phone
    if co_email: co_info += ("<br/>" if co_info else "") + co_email

    hdr = Table([[
        Table([
            [Paragraph(f"<b>{co_name}</b>",
                       st("cn", fontSize=13, fontName="Helvetica-Bold", textColor=C_BLACK))],
            [Paragraph(co_info, st("ci", fontSize=8, textColor=C_D500, leading=12))],
        ], colWidths=[usable * 0.55],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")])),
        Paragraph("Receipt",
                  st("rt", fontSize=28, fontName="Helvetica-Bold",
                     textColor=C_BLACK, alignment=2)),
    ]], colWidths=[usable * 0.55, usable * 0.45])
    hdr.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"), ("PADDING",(0,0),(-1,-1),0)]))
    story.append(hdr)
    story.append(Spacer(1, 7*mm))

    # ── Meta row: RECEIPT NO | DATE | INVOICE ─
    def _mcell(label, value):
        return Table([
            [Paragraph(tracked(label),
                       st(f"ml{label[:2]}", fontSize=7, textColor=C_D400, leading=10))],
            [Paragraph(f"<b>{value}</b>",
                       st(f"mv{label[:2]}", fontSize=10, fontName="Helvetica-Bold",
                          textColor=C_BLACK, leading=15))],
        ], colWidths=[usable/3 - 2],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")]))

    pay_date_display = _fmt_date(data.get("pay_date")) or datetime.now().strftime("%d %B %Y")
    meta = Table([[
        _mcell("RECEIPT NO.", receipt_no),
        _mcell("DATE",        pay_date_display),
        _mcell("INVOICE REF", data.get("invoice_no") or "—"),
    ]], colWidths=[usable/3]*3)
    meta.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), C_D50),
        ("PADDING",    (0,0),(-1,-1), 10),
        ("LINEAFTER",  (0,0),(1,-1),  0.5, C_D300),
        ("VALIGN",     (0,0),(-1,-1), "TOP"),
    ]))
    story.append(meta)
    story.append(Spacer(1, 10*mm))

    # ── Received From ─────────────────────────
    rf_rows = [
        [Paragraph(tracked("RECEIVED FROM"),
                   st("rf_lbl", fontSize=7, textColor=C_D400, leading=9))],
        [Paragraph(f"<b>{data.get('company_name') or 'N/A'}</b>",
                   st("co2", fontSize=11, fontName="Helvetica-Bold", textColor=C_BLACK, leading=15))],
    ]
    if data.get("pic_name"):
        rf_rows.append([Paragraph(f"Attn: {data['pic_name']}",
                                  st("pic", fontSize=9, textColor=C_D500, leading=12))])
    if data.get("pic_email"):
        rf_rows.append([Paragraph(data["pic_email"],
                                  st("em", fontSize=9, textColor=C_D500, leading=12))])
    rf_tbl = Table(rf_rows, colWidths=[usable])
    rf_tbl.setStyle(TableStyle([
        ("PADDING",    (0,0),(-1,-1), 0),
        ("TOPPADDING", (0,1),(0,1),   3),
        ("VALIGN",     (0,0),(-1,-1), "TOP"),
    ]))
    story.append(rf_tbl)
    story.append(Spacer(1, 8*mm))

    # ── Payment summary box ───────────────────
    inv_type    = data.get("invoice_type", "")
    pay_methods = data.get("pay_methods", [])
    pay_str     = ", ".join(pay_methods) if pay_methods else "—"
    is_full_pay = inv_type in ("Final Payment", "Full Payment")

    def _fd(d):
        if not d: return "—"
        try: return datetime.fromisoformat(d).strftime("%d %B %Y")
        except: return d

    summary_rows = [
        [Paragraph(tracked("PAYMENT FOR"),    st("sl",  fontSize=7, textColor=C_D400)),
         Paragraph(f"Invoice {data.get('invoice_no', '')} — {inv_type}",
                   st("sv",  fontSize=9, textColor=C_D700))],
        [Paragraph(tracked("PAYMENT METHOD"), st("ml2", fontSize=7, textColor=C_D400)),
         Paragraph(pay_str,                   st("mv2", fontSize=9, textColor=C_D700))],
    ]

    if is_full_pay and data.get("deposit_amt"):
        dep_amt  = data["deposit_amt"]
        bal_amt  = data["balance_paid"]
        dep_date = _fd(data.get("dep_date", ""))
        bal_date = _fd(data.get("bal_date", ""))
        summary_rows += [
            [Paragraph(tracked("DEPOSIT PAID"),  st("dl", fontSize=7, textColor=C_D400)),
             Paragraph(f"RM {dep_amt:,.2f}  ·  {dep_date}",
                       st("dv", fontSize=9, textColor=C_D700))],
            [Paragraph(tracked("BALANCE PAID"),  st("bl", fontSize=7, textColor=C_D400)),
             Paragraph(f"RM {bal_amt:,.2f}  ·  {bal_date}",
                       st("bv", fontSize=9, textColor=C_D700))],
        ]

    n_sum = len(summary_rows)
    sum_style = [
        ("BACKGROUND", (0,0),(-1,-1), C_D50),
        ("PADDING",    (0,0),(-1,-1), 10),
        ("VALIGN",     (0,0),(-1,-1), "MIDDLE"),
    ] + [("LINEBELOW", (0,r),(-1,r), 0.5, C_D200) for r in range(n_sum - 1)]
    summary_tbl = Table(summary_rows, colWidths=[usable * 0.32, usable * 0.68])
    summary_tbl.setStyle(TableStyle(sum_style))
    story.append(summary_tbl)
    story.append(Spacer(1, 8*mm))

    # ── Amount received (large) ───────────────
    amount_paid = data.get("amount_paid", 0)
    amt_tbl = Table([[
        Paragraph(tracked("AMOUNT RECEIVED"),
                  st("al", fontSize=9, textColor=C_D400, alignment=2)),
        Paragraph(f"<b>RM {amount_paid:,.2f}</b>",
                  st("av", fontSize=20, fontName="Helvetica-Bold",
                     textColor=C_BLACK, alignment=2)),
    ]], colWidths=[usable * 0.45, usable * 0.55])
    amt_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), C_D50),
        ("LINEABOVE",  (0,0),(-1,0),  2, C_BLACK),
        ("LINEBELOW",  (0,0),(-1,0),  2, C_BLACK),
        ("PADDING",    (0,0),(-1,-1), 14),
        ("VALIGN",     (0,0),(-1,-1), "MIDDLE"),
    ]))
    story.append(amt_tbl)
    story.append(Spacer(1, 12*mm))

    # ── Thank you note ────────────────────────
    story.append(Paragraph(
        "Thank you for your payment. This receipt confirms that the amount above "
        "has been received in full for the invoice referenced.",
        st("ty", fontSize=9, textColor=C_D600, leading=14)
    ))
    story.append(Spacer(1, 14*mm))

    # ── Signature area ────────────────────────
    sig = Table([[
        Table([
            [Paragraph("Authorised by", st("sgl", fontSize=7, textColor=C_D400))],
            [Spacer(1, 10*mm)],
            [HRFlowable(width=usable*0.38, color=C_D300, thickness=0.5)],
            [Paragraph(co_name, st("sgn", fontSize=8, textColor=C_D600))],
        ], colWidths=[usable*0.45],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")])),
        Paragraph("", st("sp")),  # spacer column
    ]], colWidths=[usable*0.5, usable*0.5])
    sig.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"), ("PADDING",(0,0),(-1,-1),0)]))
    story.append(sig)
    story.append(Spacer(1, 10*mm))

    # ── Footer ───────────────────────────────
    story.append(HRFlowable(width=usable, color=C_D200, thickness=0.5))
    story.append(Spacer(1, 3*mm))
    fp = [f"<b>{co_name}</b>"]
    if co_email: fp.append(co_email)
    if co_phone: fp.append(co_phone)
    story.append(Paragraph(
        "  ·  ".join(fp),
        st("ftr", fontSize=7, textColor=C_D400, alignment=1)
    ))

    doc.build(story)
    buffer.seek(0)
    return buffer


# ─────────────────────────────────────────────
#  Upload to Vercel Blob
# ─────────────────────────────────────────────
def upload_to_blob(pdf_buffer, filename):
    token = os.environ.get("BLOB_READ_WRITE_TOKEN")
    if not token:
        raise ValueError("BLOB_READ_WRITE_TOKEN not set")
    resp = requests.put(
        f"https://blob.vercel-storage.com/{filename}",
        headers={
            "Authorization":  f"Bearer {token}",
            "Content-Type":   "application/pdf",
            "x-content-type": "application/pdf",
        },
        data=pdf_buffer.read(), timeout=30,
    )
    resp.raise_for_status()
    result = resp.json()
    return result.get("url") or result.get("downloadUrl", "")


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
        self._respond(200, {"service": "Vision Core Receipt Generator", "status": "ready"})

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

            api_key = os.environ.get("NOTION_API_KEY")
            if not api_key:
                self._respond(500, {"error": "NOTION_API_KEY not set"}); return

            hdrs = {
                "Authorization":  f"Bearer {api_key}",
                "Notion-Version": "2022-06-28",
                "Content-Type":   "application/json",
            }

            data = fetch_invoice_data(page_id, hdrs)
            print(f"[INFO] Generating receipt for invoice: {data['invoice_no']}", file=sys.stderr)

            year       = datetime.now().year
            receipt_no = next_receipt_number(year, hdrs)

            # Create Receipt page in Notion
            receipt_page_id = create_receipt_page(page_id, receipt_no, data, hdrs)
            print(f"[INFO] Receipt page created: {receipt_page_id}", file=sys.stderr)

            # Generate PDF
            pdf_buffer = generate_pdf(receipt_no, data)
            safe       = receipt_no.replace(" ", "-")
            filename   = f"receipts/{safe}.pdf"
            pdf_url    = upload_to_blob(pdf_buffer, filename)

            # Write PDF URL back to Receipt page
            requests.patch(
                f"https://api.notion.com/v1/pages/{receipt_page_id}",
                headers=hdrs,
                json={"properties": {"PDF": {"url": pdf_url}}},
                timeout=10,
            ).raise_for_status()

            # Write receipt URL back to Invoice page — Customer Receipt (B) for
            # Final/Full Payment, Customer Receipt (D) for Deposit
            inv_type = data.get("invoice_type", "")
            receipt_field = "Customer Receipt (D)" if inv_type == "Deposit" else "Full Payment Receipt"
            try:
                wr = requests.patch(
                    f"https://api.notion.com/v1/pages/{page_id}",
                    headers=hdrs,
                    json={"properties": {receipt_field: {"url": pdf_url}}},
                    timeout=10,
                )
                if wr.ok:
                    print(f"[INFO] Wrote receipt URL to Invoice.{receipt_field!r}", file=sys.stderr)
                else:
                    print(f"[WARN] Could not write to {receipt_field!r}: {wr.status_code} {wr.text[:150]}", file=sys.stderr)
            except Exception as e:
                print(f"[WARN] Invoice receipt write-back: {e}", file=sys.stderr)

            self._respond(200, {
                "status":         "success",
                "receipt_no":     receipt_no,
                "pdf_url":        pdf_url,
                "invoice_no":     data["invoice_no"],
                "receipt_field":  receipt_field,
            })

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)
