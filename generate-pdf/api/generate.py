import json
import os
import sys
from datetime import datetime, timedelta
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

# Vision Core Details database ID
VISION_CORE_DETAILS_DB = "33c8b289e31a80b1aa85fc1921cc0adc"

TERMS = [
    "This quotation is valid for 30 days from the issue date.",
    "All prices are in Malaysian Ringgit (MYR) and exclusive of applicable taxes.",
    "A signed acceptance or purchase order is required to commence work.",
    "50% deposit required upon acceptance; balance upon completion.",
]


# ─────────────────────────────────────────────
#  Helper: plain text from Notion rich-text
# ─────────────────────────────────────────────
def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


# ─────────────────────────────────────────────
#  Fetch Vision Core company details
# ─────────────────────────────────────────────
def fetch_company_details(headers):
    try:
        resp = requests.post(
            f"https://api.notion.com/v1/databases/{VISION_CORE_DETAILS_DB}/query",
            headers=headers, json={}, timeout=10
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])
        if not results:
            return {}
        props = results[0].get("properties", {})

        def _val(key):
            p = props.get(key, {})
            t = p.get("type", "")
            if t == "title":      return _plain(p.get("title", []))
            if t == "rich_text":  return _plain(p.get("rich_text", []))
            if t == "email":      return p.get("email") or ""
            if t == "phone_number": return p.get("phone_number") or ""
            if t == "select":     return (p.get("select") or {}).get("name", "")
            return ""

        return {
            "name":                _val("Name"),
            "email":               _val("Email"),
            "phone":               _val("Phone"),
            "bank_name":           _val("Bank Name"),
            "bank_account_holder": _val("Bank Account Holder Name"),
            "bank_number":         _val("Bank Number"),
            "payment_method":      _val("Payment Method"),
        }
    except Exception as e:
        print(f"[WARN] Could not fetch company details: {e}", file=sys.stderr)
        return {}


# ─────────────────────────────────────────────
#  1. Fetch all quotation data from Notion
# ─────────────────────────────────────────────
def fetch_quotation_data(page_id):
    api_key = os.environ.get("NOTION_API_KEY")
    if not api_key:
        raise ValueError("NOTION_API_KEY not set")

    headers = {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }

    # Page properties
    resp = requests.get(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=headers, timeout=15
    )
    resp.raise_for_status()
    props = resp.json().get("properties", {})

    quotation_no  = _plain(props.get("Quotation No.", {}).get("title", []))
    issue_date    = (props.get("Issue Date", {}).get("date") or {}).get("start", "")
    payment_terms = (props.get("Payment Terms", {}).get("select") or {}).get("name", "")
    quote_type    = (props.get("Quote Type", {}).get("select") or {}).get("name", "")
    amount        = props.get("Amount", {}).get("number") or 0

    # Company
    company_name = company_address = ""
    for rel in props.get("Company", {}).get("relation", [])[:1]:
        try:
            cr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=headers, timeout=10)
            cr.raise_for_status()
            cp = cr.json().get("properties", {})
            for k in ["Name", "Company Name", "name"]:
                if cp.get(k, {}).get("type") == "title":
                    company_name = _plain(cp[k]["title"]); break
            for k in ["Address", "address"]:
                if cp.get(k, {}).get("type") == "rich_text":
                    company_address = _plain(cp[k]["rich_text"]); break
        except Exception as e:
            print(f"[WARN] company: {e}", file=sys.stderr)

    # PIC
    pic_name = pic_email = ""
    for rel in props.get("PIC", {}).get("relation", [])[:1]:
        try:
            pr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=headers, timeout=10)
            pr.raise_for_status()
            pp = pr.json().get("properties", {})
            for k in ["Name", "Full Name", "name"]:
                if pp.get(k, {}).get("type") == "title":
                    pic_name = _plain(pp[k]["title"]); break
            for k in ["Email", "email"]:
                if pp.get(k, {}).get("type") == "email":
                    pic_email = pp[k].get("email") or ""; break
        except Exception as e:
            print(f"[WARN] PIC: {e}", file=sys.stderr)

    # Line items from inline child database inside callout
    line_items = []
    try:
        br = requests.get(f"https://api.notion.com/v1/blocks/{page_id}/children",
                          headers=headers, timeout=10)
        br.raise_for_status()
        all_blocks = list(br.json().get("results", []))

        for block in list(all_blocks):
            if block.get("type") in ("callout", "column_list", "column"):
                try:
                    nb = requests.get(
                        f"https://api.notion.com/v1/blocks/{block['id']}/children",
                        headers=headers, timeout=10)
                    nb.raise_for_status()
                    all_blocks.extend(nb.json().get("results", []))
                except Exception:
                    pass

        for block in all_blocks:
            if block.get("type") != "child_database":
                continue
            db_id = block["id"].replace("-", "")
            try:
                dbr = requests.post(
                    f"https://api.notion.com/v1/databases/{db_id}/query",
                    headers=headers, json={}, timeout=10)
                dbr.raise_for_status()
                rows = dbr.json().get("results", [])
                if not rows:
                    continue

                for row in rows:
                    rp   = row.get("properties", {})
                    item = {}

                    # Product name from relation
                    for rel in rp.get("Product", {}).get("relation", [])[:1]:
                        try:
                            xr = requests.get(
                                f"https://api.notion.com/v1/pages/{rel['id']}",
                                headers=headers, timeout=10)
                            xr.raise_for_status()
                            xp = xr.json().get("properties", {})
                            name_p = xp.get("Product Name", {})
                            if name_p.get("type") == "title":
                                item["name"] = _plain(name_p["title"])
                        except Exception as e:
                            print(f"[WARN] product: {e}", file=sys.stderr)

                    # Product description from rollup
                    pd = rp.get("Product Description", {})
                    if pd.get("type") == "rollup":
                        for arr in pd.get("rollup", {}).get("array", []):
                            t = arr.get("type")
                            if t == "rich_text": item["desc"] = _plain(arr["rich_text"]); break
                            if t == "title":     item["desc"] = _plain(arr["title"]);     break

                    # Notes fallback
                    notes = _plain(rp.get("Notes", {}).get("title", []))
                    if not item.get("name"):
                        item["name"] = notes

                    item["qty"]        = rp.get("Qty", {}).get("number") or 1
                    item["unit_price"] = rp.get("Unit Price", {}).get("number") or 0

                    if item.get("name"):
                        line_items.append(item)

                if line_items:
                    break
            except Exception as e:
                print(f"[WARN] child DB: {e}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] blocks: {e}", file=sys.stderr)

    if not line_items and amount:
        line_items = [{"name": "Professional Services", "desc": "", "qty": 1,
                       "unit_price": float(amount)}]

    company_details = fetch_company_details(headers)

    return {
        "quotation_no":    quotation_no or "QUOTE",
        "issue_date":      issue_date,
        "payment_terms":   payment_terms,
        "quote_type":      quote_type,
        "amount":          amount,
        "company_name":    company_name,
        "company_address": company_address,
        "pic_name":        pic_name,
        "pic_email":       pic_email,
        "line_items":      line_items,
        "our_company":     company_details,
    }


# ─────────────────────────────────────────────
#  2. Generate PDF — clean minimal style
# ─────────────────────────────────────────────
def generate_pdf(data):
    buffer = BytesIO()
    W, H   = A4
    margin = 20 * mm
    usable = W - 2 * margin

    # Company info
    co        = data.get("our_company", {})
    co_name   = co.get("name")               or "Vision Core"
    co_email  = co.get("email")              or ""
    co_phone  = co.get("phone")              or ""
    co_bank   = co.get("bank_name")          or ""
    co_holder = co.get("bank_account_holder") or ""
    co_acc    = co.get("bank_number")        or ""
    co_pay    = co.get("payment_method")     or ""

    # Dates
    issue_display = valid_display = ""
    if data.get("issue_date"):
        try:
            idt           = datetime.fromisoformat(data["issue_date"])
            issue_display = idt.strftime("%d %B %Y")
            valid_display = (idt + timedelta(days=30)).strftime("%d %B %Y")
        except Exception:
            issue_display = data.get("issue_date", "")

    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=margin, leftMargin=margin,
        topMargin=15 * mm, bottomMargin=13 * mm,
    )

    # Palette — light / minimal
    C_DARK  = colors.HexColor("#0D1B2A")
    C_BLACK = colors.HexColor("#111111")
    C_DGRAY = colors.HexColor("#444444")
    C_GRAY  = colors.HexColor("#888888")
    C_LGRAY = colors.HexColor("#F4F4F4")
    C_LINE  = colors.HexColor("#DDDDDD")
    C_WHITE = colors.white

    styles = getSampleStyleSheet()

    def st(name, **kw):
        kw.setdefault("fontName",  "Helvetica")
        kw.setdefault("fontSize",  9)
        kw.setdefault("leading",   13)
        kw.setdefault("textColor", C_BLACK)
        return ParagraphStyle(name, parent=styles["Normal"], **kw)

    def spaced(text):
        return " ".join(c if c != " " else "  " for c in text)

    story = []

    # ── Top accent bar ────────────────────────
    story.append(HRFlowable(width=usable, color=C_DARK, thickness=3, spaceAfter=5*mm))

    # ── Header: company left | "Quotation" right ──
    co_sub = ""
    if co_phone: co_sub += co_phone
    if co_email: co_sub += ("<br/>" if co_sub else "") + co_email

    hdr = Table([[
        Table([
            [Paragraph(f"<b>{co_name}</b>",
                       st("cnm", fontSize=13, fontName="Helvetica-Bold", textColor=C_DARK))],
            [Paragraph(co_sub, st("csub", fontSize=8, textColor=C_GRAY, leading=12))],
        ], colWidths=[usable * 0.55],
           style=TableStyle([("PADDING", (0,0),(-1,-1), 0),
                              ("VALIGN",  (0,0),(-1,-1), "TOP")])),

        Paragraph("Quotation",
                  st("qth", fontSize=30, fontName="Helvetica-Bold",
                     textColor=C_DARK, alignment=2)),
    ]], colWidths=[usable * 0.55, usable * 0.45])
    hdr.setStyle(TableStyle([
        ("VALIGN",  (0,0),(-1,-1), "TOP"),
        ("PADDING", (0,0),(-1,-1), 0),
    ]))
    story.append(hdr)
    story.append(Spacer(1, 7*mm))

    # ── Metadata: Quote No. | Date | Valid Until ──
    def _mcell(label, value):
        return Table([
            [Paragraph(spaced(label),
                       st(f"ml{label[:2]}", fontSize=7, textColor=C_GRAY, leading=10))],
            [Paragraph(f"<b>{value}</b>",
                       st(f"mv{label[:2]}", fontSize=10, fontName="Helvetica-Bold",
                          textColor=C_DARK, leading=15))],
        ], colWidths=[usable / 3 - 2],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0),
                              ("VALIGN", (0,0),(-1,-1),"TOP")]))

    meta = Table([[
        _mcell("QUOTE NO.",   data.get("quotation_no", "")),
        _mcell("DATE",        issue_display),
        _mcell("VALID UNTIL", valid_display),
    ]], colWidths=[usable/3]*3)
    meta.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), C_LGRAY),
        ("PADDING",    (0,0),(-1,-1), 10),
        ("LINEAFTER",  (0,0),(1,-1),  0.5, C_LINE),
        ("VALIGN",     (0,0),(-1,-1), "TOP"),
    ]))
    story.append(meta)
    story.append(Spacer(1, 7*mm))

    # ── Bill To ───────────────────────────────
    story.append(Paragraph(spaced("BILL TO"),
                            st("btl", fontSize=7, textColor=C_GRAY, leading=10)))
    story.append(Spacer(1, 3*mm))
    story.append(Paragraph(f"<b>{data.get('company_name') or 'N/A'}</b>",
                            st("btco", fontSize=11, fontName="Helvetica-Bold",
                               textColor=C_DARK, leading=15)))
    if data.get("pic_name"):
        story.append(Paragraph(f"PIC: {data['pic_name']}",
                                st("btp", fontSize=9, textColor=C_DGRAY, leading=13)))
    if data.get("company_address"):
        story.append(Paragraph(data["company_address"].replace("\n", "<br/>"),
                                st("bta", fontSize=9, textColor=C_DGRAY, leading=13)))
    if data.get("pic_email"):
        story.append(Paragraph(data["pic_email"],
                                st("bte", fontSize=9, textColor=C_DGRAY, leading=13)))
    story.append(Spacer(1, 7*mm))

    # ── Line items ────────────────────────────
    # DESCRIPTION (name + sub-desc) | QTY | UNIT PRICE | AMOUNT
    col_w = [usable*0.50, usable*0.10, usable*0.20, usable*0.20]

    s_th  = st("th",   fontSize=8, fontName="Helvetica-Bold", textColor=C_WHITE)
    s_thr = st("thr",  fontSize=8, fontName="Helvetica-Bold", textColor=C_WHITE, alignment=2)
    s_thc = st("thc",  fontSize=8, fontName="Helvetica-Bold", textColor=C_WHITE, alignment=1)
    s_cel = st("cel",  fontSize=9, textColor=C_BLACK)
    s_sub = st("sub",  fontSize=8, textColor=C_GRAY, leading=11)
    s_num = st("num",  fontSize=9, textColor=C_BLACK, alignment=2)
    s_nmc = st("nmc",  fontSize=9, textColor=C_BLACK, alignment=1)

    rows = [[
        Paragraph(spaced("DESCRIPTION"), s_th),
        Paragraph(spaced("QTY"),         s_thc),
        Paragraph(spaced("UNIT PRICE"),  s_thr),
        Paragraph(spaced("AMOUNT"),      s_thr),
    ]]

    total = 0.0
    for item in data.get("line_items", []):
        qty   = float(item.get("qty", 1))
        price = float(item.get("unit_price", 0))
        amt   = qty * price
        total += amt

        # Description cell: name (bold) + optional sub-description
        desc_rows = [[Paragraph(item.get("name", ""), s_cel)]]
        if item.get("desc"):
            desc_rows.append([Paragraph(item["desc"], s_sub)])

        desc_cell = Table(
            desc_rows,
            colWidths=[col_w[0] - 16],
            style=TableStyle([("PADDING",(0,0),(-1,-1),0),
                               ("VALIGN", (0,0),(-1,-1),"TOP")])
        )

        rows.append([
            desc_cell,
            Paragraph(f"{qty:g}", s_nmc),
            Paragraph(f"RM {price:,.2f}", s_num),
            Paragraph(f"RM {amt:,.2f}",  s_num),
        ])

    n_data = len(rows)
    items_tbl = Table(rows, colWidths=col_w)
    items_tbl.setStyle(TableStyle([
        ("BACKGROUND",     (0,0),(-1,0),         C_DARK),
        ("PADDING",        (0,0),(-1,-1),         8),
        ("VALIGN",         (0,0),(-1,-1),         "TOP"),
        ("LINEBELOW",      (0,1),(-1,n_data-1),   0.5, C_LINE),
        ("ROWBACKGROUNDS", (0,1),(-1,n_data-1),   [C_WHITE, C_LGRAY]),
    ]))
    story.append(items_tbl)
    story.append(Spacer(1, 4*mm))

    # ── Totals (right-aligned, clean) ─────────
    has_deposit = (data.get("payment_terms") == "50% Deposit")
    deposit     = total * 0.5 if has_deposit else 0

    tot_rows = []
    tot_rows.append([
        Paragraph("Subtotal", st("sl", fontSize=9, textColor=C_GRAY, alignment=2)),
        Paragraph(f"RM {total:,.2f}", st("sv", fontSize=9, alignment=2)),
    ])
    if has_deposit:
        tot_rows.append([
            Paragraph("Deposit Due (50%)", st("dl", fontSize=9, textColor=C_GRAY, alignment=2)),
            Paragraph(f"RM {deposit:,.2f}", st("dv", fontSize=9, alignment=2)),
        ])
    n_tot = len(tot_rows)
    tot_rows.append([
        Paragraph("<b>Total Due</b>",
                  st("tl", fontSize=11, fontName="Helvetica-Bold", textColor=C_DARK, alignment=2)),
        Paragraph(f"<b>RM {total:,.2f}</b>",
                  st("tv", fontSize=11, fontName="Helvetica-Bold", textColor=C_DARK, alignment=2)),
    ])

    tot_tbl = Table(tot_rows, colWidths=[usable*0.72, usable*0.28])
    tot_tbl.setStyle(TableStyle([
        ("PADDING",   (0,0),(-1,-1),        4),
        ("VALIGN",    (0,0),(-1,-1),        "MIDDLE"),
        ("LINEABOVE", (0,n_tot),(-1,n_tot), 0.5, C_LINE),
    ]))
    story.append(tot_tbl)
    story.append(Spacer(1, 6*mm))

    # ── Thin divider ──────────────────────────
    story.append(HRFlowable(width=usable, color=C_LINE, thickness=0.5))
    story.append(Spacer(1, 5*mm))

    # ── Notes & Terms  |  Payment Details ─────
    terms_html = f"<font size='7' color='#888888'>{spaced('NOTES & TERMS')}</font><br/><br/>"
    for term in TERMS:
        terms_html += f"<font size='8' color='#444444'>{term}</font><br/>"

    pay_html = f"<font size='7' color='#888888'>{spaced('PAYMENT DETAILS')}</font><br/><br/>"
    if co_pay:
        pay_html += f"<font size='8' color='#444444'><b>Method</b>  {co_pay}</font><br/>"
    if co_bank:
        pay_html += f"<font size='8' color='#444444'><b>Bank</b>  {co_bank}</font><br/>"
    if co_holder:
        pay_html += f"<font size='8' color='#444444'><b>Account Name</b>  {co_holder}</font><br/>"
    if co_acc:
        pay_html += f"<font size='8' color='#444444'><b>Account No.</b>  {co_acc}</font>"

    bot = Table([[
        Paragraph(terms_html, st("tp", fontSize=8, leading=13, textColor=C_DGRAY)),
        Paragraph(pay_html,   st("pp", fontSize=8, leading=13, textColor=C_DGRAY)),
    ]], colWidths=[usable*0.55, usable*0.45])
    bot.setStyle(TableStyle([
        ("VALIGN",        (0,0),(-1,-1), "TOP"),
        ("LEFTPADDING",   (0,0),(0,-1),  0),
        ("RIGHTPADDING",  (0,0),(0,-1),  14),
        ("LEFTPADDING",   (1,0),(1,-1),  14),
        ("LINEAFTER",     (0,0),(0,-1),  0.5, C_LINE),
    ]))
    story.append(bot)
    story.append(Spacer(1, 5*mm))

    # ── Footer ────────────────────────────────
    story.append(HRFlowable(width=usable, color=C_LINE, thickness=0.5))
    story.append(Spacer(1, 2*mm))
    fp = [f"<b>{co_name}</b>"]
    if co_email: fp.append(co_email)
    if co_phone: fp.append(co_phone)
    story.append(Paragraph("  ·  ".join(fp),
                            st("ftr", fontSize=7, textColor=C_GRAY, alignment=1)))

    doc.build(story)
    buffer.seek(0)
    return buffer


# ─────────────────────────────────────────────
#  3. Upload to Vercel Blob Storage
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
        data=pdf_buffer.read(),
        timeout=30,
    )
    resp.raise_for_status()
    result = resp.json()
    return result.get("url") or result.get("downloadUrl", "")


# ─────────────────────────────────────────────
#  4. Write PDF URL + Amount back to Notion
# ─────────────────────────────────────────────
def update_notion_page(page_id, pdf_url, total_amount):
    api_key = os.environ.get("NOTION_API_KEY")
    if not api_key:
        raise ValueError("NOTION_API_KEY not set")

    headers = {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }
    payload = {"properties": {"PDF": {"url": pdf_url}}}
    if total_amount and total_amount > 0:
        payload["properties"]["Amount"] = {"number": total_amount}

    requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=headers, json=payload, timeout=10,
    ).raise_for_status()


# ─────────────────────────────────────────────
#  Vercel handler (class-based)
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
        self._respond(200, {"service": "Vision Core Quotation PDF Generator",
                            "status":  "ready"})

    def do_POST(self):
        try:
            secret = os.environ.get("WEBHOOK_SECRET", "")
            if secret:
                if self.headers.get("Authorization", "") != f"Bearer {secret}":
                    self._respond(401, {"error": "Unauthorized"}); return

            length = int(self.headers.get("Content-Length", 0))
            raw    = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw)
            except Exception:
                body = {}

            print(f"[DEBUG] payload: {json.dumps(body)}", file=sys.stderr)

            page_id = None
            if "source" in body:
                src = body["source"]
                page_id = src.get("page_id") or src.get("id")
            if not page_id and "data" in body:
                dat = body["data"]
                page_id = dat.get("page_id") or dat.get("id")
            if not page_id:
                page_id = body.get("page_id") or body.get("id")
            if page_id:
                page_id = page_id.replace("-", "")

            if not page_id:
                self._respond(400, {"error": "No page_id found"}); return

            print(f"[INFO] Generating PDF for: {page_id}", file=sys.stderr)

            data       = fetch_quotation_data(page_id)
            pdf_buffer = generate_pdf(data)

            safe = (data["quotation_no"]
                    .replace(" ", "-").replace("/", "-").replace("\\", "-"))
            filename = f"quotations/{safe}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"

            pdf_url = upload_to_blob(pdf_buffer, filename)

            total_amount = sum(
                float(i.get("qty", 1)) * float(i.get("unit_price", 0))
                for i in data.get("line_items", [])
            )
            update_notion_page(page_id, pdf_url, total_amount)

            self._respond(200, {"status":       "success",
                                "quotation_no": data["quotation_no"],
                                "pdf_url":      pdf_url})

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})
