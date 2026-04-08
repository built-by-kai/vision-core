"""
generate_invoice.py
POST /api/generate_invoice   { "page_id": "<invoice_page_id>" }

1. Fetches the Invoice page from Notion
2. Follows the Quotation relation to pull line items + quote type (→ package slug)
3. Follows Company + Clients relations for billing info
4. Generates a professional Invoice PDF (same design system as quotation)
5. Uploads to Vercel Blob  →  writes URL back to Invoice.PDF
6. If Invoice Type = Deposit OR Status = Deposit Received / Full Payment Received:
   - Generates the Implementation intake form URL
   - Writes it back to Invoice.Intake Form URL

Invoice DB ID : 9227dda9c4be42a1a4c6b1bce4862f8c
Collection    : cbe7a0bc-4856-49c2-99fa-29ec147df2a1
"""
import json
import os
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

# ─────────────────────────────────────────────
#  Config
# ─────────────────────────────────────────────
VISION_CORE_DETAILS_DB = "33c8b289e31a80b1aa85fc1921cc0adc"
IMPL_FORM_BASE = "https://vision-core-delta.vercel.app/api/implementation_form"

# Map Quotation "Quote Type" values → package slugs for intake form
QUOTE_TYPE_TO_PKG = {
    "Workflow OS":    "workflow-os",
    "Sales CRM":      "sales-crm",
    "Full Agency OS": "full-agency-os",
    "Complete OS":    "complete-os",
    "Revenue OS":     "revenue-os",
    "Modular OS":     "modular-os",
    "Custom OS":      "custom-os",
}

INVOICE_TERMS = [
    "Payment is due by the date stated on this invoice.",
    "All prices are in Malaysian Ringgit (MYR) and exclusive of applicable taxes.",
    "Late payments may be subject to a 1.5% monthly service charge.",
    "For queries, please contact us within 7 days of receiving this invoice.",
]

# ─────────────────────────────────────────────
#  Design tokens (matches generate.py)
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


# ─────────────────────────────────────────────
#  Fetch our own company details
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
            if t == "select":       return (prop.get("select") or {}).get("name", "")
            return ""

        return {
            "name":                _v("Name"),
            "email":               _v("Email"),
            "phone":               _v("Phone"),
            "bank_name":           _v("Bank Name"),
            "bank_account_holder": _v("Bank Account Holder Name"),
            "bank_number":         _v("Bank Number"),
            "payment_method":      _v("Payment Method"),
        }
    except Exception as e:
        print(f"[WARN] company details: {e}", file=sys.stderr)
        return {}


# ─────────────────────────────────────────────
#  1. Fetch invoice + linked quotation data
# ─────────────────────────────────────────────
def fetch_invoice_data(page_id, hdrs):
    """Fetch invoice page then enrich with Quotation line items."""
    resp = requests.get(
        f"https://api.notion.com/v1/pages/{page_id}", headers=hdrs, timeout=15
    )
    resp.raise_for_status()
    props = resp.json().get("properties", {})

    invoice_no    = _plain(props.get("Invoice No.", {}).get("title", []))
    issue_date    = (props.get("Issue Date", {}).get("date") or {}).get("start", "")
    invoice_type  = (props.get("Invoice Type", {}).get("select") or {}).get("name", "")
    status        = (props.get("Status", {}).get("select") or {}).get("name", "")
    total_amount  = props.get("Total Amount", {}).get("number") or 0
    deposit_paid  = props.get("Deposit Paid", {}).get("number") or 0

    # Due date: use Payment Deposit Date for Deposit invoices, else Balance Date
    dep_date = (props.get("Payment Deposit Date", {}).get("date") or {}).get("start", "")
    bal_date = (props.get("Payment Balance Date", {}).get("date") or {}).get("start", "")
    due_date = dep_date if invoice_type == "Deposit" else (bal_date or dep_date)

    # ── Company (billing client) ──
    company_name = company_address = company_id = ""
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
            for k in ["Address", "address"]:
                if cp.get(k, {}).get("type") == "rich_text":
                    company_address = _plain(cp[k]["rich_text"]); break
        except Exception as e:
            print(f"[WARN] company: {e}", file=sys.stderr)

    # ── PIC (from Clients relation) ──
    pic_name = pic_email = ""
    for rel in props.get("Clients", {}).get("relation", [])[:1]:
        try:
            pr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
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

    # ── Quotation: pull line items + package type ──
    line_items = []
    pkg_slug = ""
    for rel in props.get("Quotation", {}).get("relation", [])[:1]:
        try:
            qid = rel["id"].replace("-", "")
            qr = requests.get(f"https://api.notion.com/v1/pages/{qid}",
                              headers=hdrs, timeout=10)
            qr.raise_for_status()
            qprops = qr.json().get("properties", {})

            # Package slug from Quote Type
            qt = (qprops.get("Quote Type", {}).get("select") or {}).get("name", "")
            pkg_slug = QUOTE_TYPE_TO_PKG.get(qt, "")

            # Fetch quotation's child line-items DB
            br = requests.get(f"https://api.notion.com/v1/blocks/{qid}/children",
                              headers=hdrs, timeout=10)
            br.raise_for_status()
            all_blocks = list(br.json().get("results", []))

            for block in list(all_blocks):
                if block.get("type") in ("callout", "column_list", "column"):
                    try:
                        nb = requests.get(
                            f"https://api.notion.com/v1/blocks/{block['id']}/children",
                            headers=hdrs, timeout=10)
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
                        headers=hdrs, json={}, timeout=10)
                    dbr.raise_for_status()
                    rows = dbr.json().get("results", [])
                    if not rows:
                        continue
                    for row in rows:
                        rp = row.get("properties", {})
                        item = {}
                        for prel in rp.get("Product", {}).get("relation", [])[:1]:
                            try:
                                xr = requests.get(
                                    f"https://api.notion.com/v1/pages/{prel['id']}",
                                    headers=hdrs, timeout=10)
                                xr.raise_for_status()
                                xp = xr.json().get("properties", {})
                                np = xp.get("Product Name", {})
                                if np.get("type") == "title":
                                    item["name"] = _plain(np["title"])
                            except Exception as e:
                                print(f"[WARN] product: {e}", file=sys.stderr)
                        pd = rp.get("Product Description", {})
                        if pd.get("type") == "rollup":
                            for arr in pd.get("rollup", {}).get("array", []):
                                t = arr.get("type")
                                if t == "rich_text": item["desc"] = _plain(arr["rich_text"]); break
                                if t == "title":     item["desc"] = _plain(arr["title"]);     break
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
            print(f"[WARN] quotation fetch: {e}", file=sys.stderr)

    # Fallback to Total Amount if no line items
    if not line_items and total_amount:
        line_items = [{"name": "Professional Services", "desc": "",
                       "qty": 1, "unit_price": float(total_amount)}]

    return {
        "invoice_no":      invoice_no or "INV",
        "issue_date":      issue_date,
        "due_date":        due_date,
        "invoice_type":    invoice_type,
        "status":          status,
        "total_amount":    total_amount,
        "deposit_paid":    deposit_paid,
        "company_name":    company_name,
        "company_address": company_address,
        "company_id":      company_id,
        "pic_name":        pic_name,
        "pic_email":       pic_email,
        "line_items":      line_items,
        "pkg_slug":        pkg_slug,
        "our_company":     fetch_company_details(hdrs),
    }


# ─────────────────────────────────────────────
#  2. Generate Invoice PDF
# ─────────────────────────────────────────────
def generate_pdf(data):
    buffer = BytesIO()
    W, H   = A4
    margin = 20 * mm
    usable = W - 2 * margin

    co        = data.get("our_company", {})
    co_name   = co.get("name")                or "Vision Core"
    co_email  = co.get("email")               or ""
    co_phone  = co.get("phone")               or ""
    co_bank   = co.get("bank_name")           or ""
    co_holder = co.get("bank_account_holder") or ""
    co_acc    = co.get("bank_number")         or ""
    co_pay    = co.get("payment_method")      or ""

    def _fmt_date(d):
        if not d:
            return ""
        try:
            return datetime.fromisoformat(d).strftime("%d %B %Y")
        except Exception:
            return d

    issue_display = _fmt_date(data.get("issue_date"))
    due_display   = _fmt_date(data.get("due_date"))

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
        return " ".join(c if c != " " else "  " for c in text)

    story = []

    # ── 1. Top accent bar ─────────────────────
    story.append(HRFlowable(width=usable, color=C_BLACK, thickness=4, spaceAfter=6*mm))

    # ── 2. Header: company left | "Invoice" right ──
    co_info = ""
    if co_phone: co_info += co_phone
    if co_email: co_info += ("<br/>" if co_info else "") + co_email

    hdr = Table([[
        Table([
            [Paragraph(f"<b>{co_name}</b>",
                       st("cn", fontSize=13, fontName="Helvetica-Bold", textColor=C_BLACK))],
            [Paragraph(co_info,
                       st("ci", fontSize=8, textColor=C_D500, leading=12))],
        ], colWidths=[usable * 0.55],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0),
                              ("VALIGN", (0,0),(-1,-1),"TOP")])),
        Paragraph("Invoice",
                  st("qt", fontSize=28, fontName="Helvetica-Bold",
                     textColor=C_BLACK, alignment=2)),
    ]], colWidths=[usable * 0.55, usable * 0.45])
    hdr.setStyle(TableStyle([
        ("VALIGN",  (0,0),(-1,-1), "TOP"),
        ("PADDING", (0,0),(-1,-1), 0),
    ]))
    story.append(hdr)
    story.append(Spacer(1, 7*mm))

    # ── 3. Meta row: INVOICE NO. | DATE | DUE DATE ──
    def _mcell(label, value):
        return Table([
            [Paragraph(tracked(label),
                       st(f"ml{label[:3]}", fontSize=7, textColor=C_D400, leading=10))],
            [Paragraph(f"<b>{value}</b>",
                       st(f"mv{label[:3]}", fontSize=10, fontName="Helvetica-Bold",
                          textColor=C_BLACK, leading=15))],
        ], colWidths=[usable/3 - 2],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0),
                              ("VALIGN", (0,0),(-1,-1),"TOP")]))

    # Show Invoice Type label in meta if set
    inv_type_label = data.get("invoice_type", "")
    inv_no_display = data.get("invoice_no", "")
    if inv_type_label:
        inv_no_display += f"  ({inv_type_label})"

    meta = Table([[
        _mcell("INVOICE NO.", inv_no_display),
        _mcell("DATE",        issue_display or "—"),
        _mcell("DUE DATE",    due_display   or "—"),
    ]], colWidths=[usable/3]*3)
    meta.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), C_D50),
        ("PADDING",    (0,0),(-1,-1), 10),
        ("LINEAFTER",  (0,0),(1,-1),  0.5, C_D300),
        ("VALIGN",     (0,0),(-1,-1), "TOP"),
    ]))
    story.append(meta)
    story.append(Spacer(1, 8*mm))

    # ── 4. Bill To ────────────────────────────
    story.append(Paragraph(
        tracked("BILL TO"),
        st("bt_lbl", fontSize=7, textColor=C_D400, leading=12)
    ))
    story.append(Spacer(1, 2*mm))
    story.append(Paragraph(
        f"<b>{data.get('company_name') or 'N/A'}</b>",
        st("co2", fontSize=11, fontName="Helvetica-Bold", textColor=C_BLACK, leading=15)
    ))
    if data.get("pic_name"):
        story.append(Paragraph(
            f"Attn: {data['pic_name']}",
            st("pic", fontSize=9, textColor=C_D500, leading=13)
        ))
    if data.get("company_address"):
        story.append(Paragraph(
            data["company_address"].replace("\n", "<br/>"),
            st("adr", fontSize=9, textColor=C_D500, leading=13)
        ))
    if data.get("pic_email"):
        story.append(Paragraph(
            data["pic_email"],
            st("em", fontSize=9, textColor=C_D500, leading=13)
        ))
    story.append(Spacer(1, 8*mm))

    # ── 5. Line items ─────────────────────────
    cw = [usable*0.55, usable*0.10, usable*0.18, usable*0.17]

    s_th  = st("th",  fontSize=7, fontName="Helvetica-Bold", textColor=C_WHITE)
    s_thr = st("thr", fontSize=7, fontName="Helvetica-Bold", textColor=C_WHITE, alignment=2)
    s_thc = st("thc", fontSize=7, fontName="Helvetica-Bold", textColor=C_WHITE, alignment=1)
    s_name = st("nm", fontSize=9, fontName="Helvetica-Bold", textColor=C_BLACK)
    s_desc = st("dc", fontSize=8, textColor=C_D500, leading=12)
    s_num  = st("nu", fontSize=9, textColor=C_D700, alignment=2)
    s_numc = st("nuc",fontSize=9, textColor=C_D700, alignment=1)

    rows = [[
        Paragraph(tracked("DESCRIPTION"), s_th),
        Paragraph(tracked("QTY"),         s_thc),
        Paragraph(tracked("UNIT PRICE"),  s_thr),
        Paragraph(tracked("AMOUNT"),      s_thr),
    ]]

    total = 0.0
    for item in data.get("line_items", []):
        qty   = float(item.get("qty", 1))
        price = float(item.get("unit_price", 0))
        amt   = qty * price
        total += amt

        desc_inner = [[Paragraph(item.get("name", ""), s_name)]]
        if item.get("desc"):
            desc_inner.append([Paragraph(item["desc"], s_desc)])
        desc_cell = Table(
            desc_inner,
            colWidths=[cw[0] - 16],
            style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")])
        )
        rows.append([
            desc_cell,
            Paragraph(f"{qty:g}", s_numc),
            Paragraph(f"RM {price:,.2f}", s_num),
            Paragraph(f"RM {amt:,.2f}",   s_num),
        ])

    n_data = len(rows)
    items_tbl = Table(rows, colWidths=cw)
    items_tbl.setStyle(TableStyle([
        ("BACKGROUND",     (0,0), (-1,0),        C_BLACK),
        ("PADDING",        (0,0), (-1,-1),        8),
        ("VALIGN",         (0,0), (-1,-1),        "TOP"),
        ("LINEBELOW",      (0,1), (-1,n_data-1),  0.5, C_D200),
        ("ROWBACKGROUNDS", (0,1), (-1,n_data-1),  [C_WHITE, C_D100]),
    ]))
    story.append(items_tbl)
    story.append(Spacer(1, 4*mm))

    # ── 6. Totals ─────────────────────────────
    invoice_type  = data.get("invoice_type", "")
    deposit_paid  = float(data.get("deposit_paid", 0) or 0)
    is_deposit    = invoice_type == "Deposit"
    is_final      = invoice_type == "Final Payment"
    is_full       = invoice_type == "Full Payment"

    # Compute what's actually due on this invoice
    if is_deposit:
        # Use stored deposit_paid value if set, else 50%
        amount_due = deposit_paid if deposit_paid > 0 else total * 0.5
    elif is_final:
        amount_due = total - deposit_paid if deposit_paid > 0 else total
    else:  # Full Payment, Retainer, or unset
        amount_due = total

    tot_rows = []
    tot_rows.append([
        Paragraph("Subtotal", st("stl", fontSize=9, textColor=C_D400, alignment=2)),
        Paragraph(f"RM {total:,.2f}", st("stv", fontSize=9, textColor=C_D700, alignment=2)),
    ])
    if is_deposit and amount_due != total:
        tot_rows.append([
            Paragraph("Deposit Due", st("ddl", fontSize=9, textColor=C_D400, alignment=2)),
            Paragraph(f"RM {amount_due:,.2f}", st("ddv", fontSize=9, textColor=C_D700, alignment=2)),
        ])
    if is_final and deposit_paid > 0:
        tot_rows.append([
            Paragraph("Deposit Paid", st("dpl", fontSize=9, textColor=C_D400, alignment=2)),
            Paragraph(f"(RM {deposit_paid:,.2f})", st("dpv", fontSize=9, textColor=C_D700, alignment=2)),
        ])

    n_tot = len(tot_rows)
    due_label = "Amount Due" if is_deposit else "Total Due"
    tot_rows.append([
        Paragraph(f"<b>{due_label}</b>",
                  st("tdl", fontSize=11, fontName="Helvetica-Bold", textColor=C_BLACK, alignment=2)),
        Paragraph(f"<b>RM {amount_due:,.2f}</b>",
                  st("tdv", fontSize=11, fontName="Helvetica-Bold", textColor=C_BLACK, alignment=2)),
    ])

    tot_tbl = Table(tot_rows, colWidths=[usable*0.65, usable*0.35])
    tot_tbl.setStyle(TableStyle([
        ("PADDING",   (0,0),(-1,-1),        [4, 5, 4, 5]),
        ("VALIGN",    (0,0),(-1,-1),        "MIDDLE"),
        ("BACKGROUND",(0,n_tot),(-1,n_tot), C_D50),
        ("LINEABOVE", (0,n_tot),(-1,n_tot), 1, C_BLACK),
        ("LINEBELOW", (0,n_tot),(-1,n_tot), 1, C_BLACK),
    ]))
    story.append(tot_tbl)
    story.append(Spacer(1, 9*mm))

    # ── 7. Divider ────────────────────────────
    story.append(HRFlowable(width=usable, color=C_D200, thickness=0.5))
    story.append(Spacer(1, 6*mm))

    # ── 8. Terms | Payment Details ────────────
    terms_html = (f"<font size='7' color='#9CA3AF'>{tracked('NOTES & TERMS')}</font><br/><br/>")
    for term in INVOICE_TERMS:
        terms_html += f"<font size='8' color='#4B5563'>{term}</font><br/>"

    pay_lines = []
    if co_pay:    pay_lines.append(f"<b>Method</b>  {co_pay}")
    if co_bank:   pay_lines.append(f"<b>Bank</b>  {co_bank}")
    if co_holder: pay_lines.append(f"<b>Account Name</b>  {co_holder}")
    if co_acc:    pay_lines.append(f"<b>Account No.</b>  {co_acc}")

    pay_html = (f"<font size='7' color='#9CA3AF'>{tracked('PAYMENT DETAILS')}</font><br/><br/>")
    pay_html += "<br/>".join(
        f"<font size='8' color='#4B5563'>{l}</font>" for l in pay_lines
    )

    bot = Table([[
        Paragraph(terms_html, st("tp", fontSize=8, leading=14, textColor=C_D600)),
        Paragraph(pay_html,   st("pp", fontSize=8, leading=14, textColor=C_D600)),
    ]], colWidths=[usable*0.55, usable*0.45])
    bot.setStyle(TableStyle([
        ("VALIGN",       (0,0),(-1,-1), "TOP"),
        ("LEFTPADDING",  (0,0),(0,-1),  0),
        ("RIGHTPADDING", (0,0),(0,-1),  20),
        ("LEFTPADDING",  (1,0),(1,-1),  20),
        ("LINEAFTER",    (0,0),(0,-1),  0.5, C_D200),
    ]))
    story.append(bot)
    story.append(Spacer(1, 5*mm))

    # ── 9. Footer ─────────────────────────────
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
    return buffer, amount_due


# ─────────────────────────────────────────────
#  3. Upload to Vercel Blob
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
#  4. Write back to Notion Invoice page
# ─────────────────────────────────────────────
def update_notion_invoice(page_id, pdf_url, amount_due, intake_url, hdrs):
    payload = {"properties": {}}

    if pdf_url:
        payload["properties"]["PDF"] = {"url": pdf_url}
    if amount_due > 0:
        payload["properties"]["Total Amount"] = {"number": amount_due}
    if intake_url:
        payload["properties"]["Intake Form URL"] = {"url": intake_url}

    requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json=payload, timeout=10,
    ).raise_for_status()


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
        self._respond(200, {"service": "Vision Core Invoice PDF Generator", "status": "ready"})

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

            # Extract page_id from Notion button webhook or direct call
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

            print(f"[INFO] Generating invoice for: {page_id}", file=sys.stderr)

            api_key = os.environ.get("NOTION_API_KEY")
            if not api_key:
                self._respond(500, {"error": "NOTION_API_KEY not set"}); return

            hdrs = {
                "Authorization":  f"Bearer {api_key}",
                "Notion-Version": "2022-06-28",
                "Content-Type":   "application/json",
            }

            data        = fetch_invoice_data(page_id, hdrs)
            pdf_buffer, amount_due = generate_pdf(data)

            safe     = (data["invoice_no"]
                        .replace(" ", "-").replace("/", "-").replace("\\", "-"))
            filename = f"invoices/{safe}.pdf"

            pdf_url = upload_to_blob(pdf_buffer, filename)

            # Generate intake form URL if deposit/full payment invoiced
            status       = data.get("status", "")
            invoice_type = data.get("invoice_type", "")
            company_id   = data.get("company_id", "")
            pkg_slug     = data.get("pkg_slug", "")

            should_gen_intake = (
                invoice_type in ("Deposit", "Full Payment") or
                status in ("Deposit Received", "Full Payment Received")
            )
            intake_url = ""
            if should_gen_intake and company_id and pkg_slug:
                intake_url = f"{IMPL_FORM_BASE}?c={company_id}&pkg={pkg_slug}"
                print(f"[INFO] Intake form URL: {intake_url}", file=sys.stderr)
            elif should_gen_intake and company_id and not pkg_slug:
                # No package slug — generate link without pkg param; Nadia can append it
                intake_url = f"{IMPL_FORM_BASE}?c={company_id}"
                print(f"[WARN] No pkg_slug found — intake URL generated without package", file=sys.stderr)

            update_notion_invoice(page_id, pdf_url, amount_due, intake_url, hdrs)

            result = {
                "status":       "success",
                "invoice_no":   data["invoice_no"],
                "pdf_url":      pdf_url,
                "amount_due":   amount_due,
            }
            if intake_url:
                result["intake_form_url"] = intake_url
            self._respond(200, result)

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)
