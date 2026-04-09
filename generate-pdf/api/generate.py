import json
import os
import re
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

# Vision Core Details DB
VISION_CORE_DETAILS_DB = "33c8b289e31a80b1aa85fc1921cc0adc"
# Quotations DB (collection 2c4b070c-d8f3-4cc7-8fe4-67ef7f5241d3)
QUOTATIONS_DB          = "2c4b070cd8f34cc78fe467ef7f5241d3"

QUO_PATTERN = re.compile(r"^QUO-(\d{4})-(\d{4})$")

TERMS = [
    "This quotation is valid for 30 days from the issue date.",
    "All prices are in Malaysian Ringgit (MYR) and exclusive of applicable taxes.",
    "A signed acceptance or purchase order is required to commence work.",
    "50% deposit required upon acceptance; balance upon completion.",
]

# ─────────────────────────────────────────────
#  Design tokens  (Cal.com / grayscale system)
# ─────────────────────────────────────────────
C_BLACK  = colors.HexColor("#111827")   # headings
C_D700   = colors.HexColor("#374151")   # body text
C_D600   = colors.HexColor("#4B5563")   # secondary body
C_D500   = colors.HexColor("#6B7280")   # muted
C_D400   = colors.HexColor("#9CA3AF")   # labels / placeholders
C_D300   = colors.HexColor("#D1D5DB")   # dividers
C_D200   = colors.HexColor("#E5E7EB")   # row lines
C_D100   = colors.HexColor("#F3F4F6")   # alt-row bg
C_D50    = colors.HexColor("#F9FAFB")   # meta-cell bg
C_WHITE  = colors.white

HEX_BLACK = "#111827"
HEX_D200  = "#E5E7EB"
HEX_D100  = "#F3F4F6"
HEX_D50   = "#F9FAFB"
HEX_WHITE = "#FFFFFF"


# ─────────────────────────────────────────────
def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def fetch_company_details(headers):
    try:
        r = requests.post(
            f"https://api.notion.com/v1/databases/{VISION_CORE_DETAILS_DB}/query",
            headers=headers, json={}, timeout=10
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
#  Auto-numbering
# ─────────────────────────────────────────────
def next_quotation_number(year, hdrs, db_id=None):
    """Scan all quotations, find highest QUO-YYYY-XXXX for this year, return next."""
    # Use the provided db_id (from page parent) — fallback to hardcoded constant
    target_db = db_id or QUOTATIONS_DB
    print(f"[INFO] Scanning DB {target_db} for QUO-{year}-XXXX", file=sys.stderr)
    max_seq = 0
    try:
        has_more, cursor = True, None
        while has_more:
            body = {"page_size": 100}
            if cursor:
                body["start_cursor"] = cursor
            r = requests.post(
                f"https://api.notion.com/v1/databases/{target_db}/query",
                headers=hdrs, json=body, timeout=15
            )
            r.raise_for_status()
            data     = r.json()
            has_more = data.get("has_more", False)
            cursor   = data.get("next_cursor")
            for page in data.get("results", []):
                props = page.get("properties", {})
                # Search all properties for a title that matches QUO pattern
                for prop_val in props.values():
                    if prop_val.get("type") == "title":
                        title = "".join(t.get("plain_text", "") for t in prop_val.get("title", []))
                        m = QUO_PATTERN.match(title)
                        if m and int(m.group(1)) == year:
                            max_seq = max(max_seq, int(m.group(2)))
                            print(f"[INFO] Found existing: {title}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] auto-number quotation: {e}", file=sys.stderr)
    result = f"QUO-{year}-{max_seq + 1:04d}"
    print(f"[INFO] Next quotation number: {result} (max found: {max_seq})", file=sys.stderr)
    return result


def assign_quotation_number(issue_date, current_no, hdrs, db_id=None):
    """Calculate next QUO-YYYY-XXXX. Does NOT patch Notion — caller handles that."""
    if QUO_PATTERN.match(current_no or ""):
        return current_no   # already formatted — nothing to do

    year = datetime.now().year
    if issue_date:
        try:
            year = datetime.fromisoformat(issue_date).year
        except Exception:
            pass

    return next_quotation_number(year, hdrs, db_id=db_id)


# ─────────────────────────────────────────────
#  1. Fetch quotation data
# ─────────────────────────────────────────────
def fetch_quotation_data(page_id):
    api_key = os.environ.get("NOTION_API_KEY")
    if not api_key:
        raise ValueError("NOTION_API_KEY not set")

    hdrs = {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }

    resp = requests.get(
        f"https://api.notion.com/v1/pages/{page_id}", headers=hdrs, timeout=15
    )
    resp.raise_for_status()
    page_data = resp.json()
    props     = page_data.get("properties", {})

    # Get the ACTUAL parent database ID from the page itself — never rely on hardcoded ID
    parent_db_id = (page_data.get("parent") or {}).get("database_id", "").replace("-", "")
    print(f"[INFO] Parent DB ID: {parent_db_id}", file=sys.stderr)

    # Find title property name dynamically (robust if DB uses different name)
    title_prop_name = "Quotation No."
    for _k, _v in props.items():
        if _v.get("type") == "title":
            title_prop_name = _k
            break

    quotation_no  = _plain(props.get(title_prop_name, {}).get("title", []))
    issue_date    = (props.get("Issue Date", {}).get("date") or {}).get("start", "")
    payment_terms = (props.get("Payment Terms", {}).get("select") or {}).get("name", "")
    quote_type    = (props.get("Quote Type", {}).get("select") or {}).get("name", "")
    amount        = props.get("Amount", {}).get("number") or 0

    # Calculate formatted quotation number using the real DB ID from the page parent
    quotation_no = assign_quotation_number(issue_date, quotation_no, hdrs, db_id=parent_db_id)

    # Company
    company_name = company_address = ""
    for rel in props.get("Company", {}).get("relation", [])[:1]:
        try:
            cr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=hdrs, timeout=10)
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
    pic_name = pic_email = pic_phone = ""
    for rel in props.get("PIC", {}).get("relation", [])[:1]:
        try:
            pr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=hdrs, timeout=10)
            pr.raise_for_status()
            pp = pr.json().get("properties", {})
            for k in ["Name", "Full Name", "name"]:
                if pp.get(k, {}).get("type") == "title":
                    pic_name = _plain(pp[k]["title"]); break
            for k in ["Email", "email"]:
                if pp.get(k, {}).get("type") == "email":
                    pic_email = pp[k].get("email") or ""; break
            for k in ["Phone", "phone", "Phone Number", "Mobile", "WhatsApp"]:
                prop = pp.get(k, {})
                if prop.get("type") == "phone_number":
                    pic_phone = prop.get("phone_number") or ""; break
                if prop.get("type") == "rich_text":
                    pic_phone = _plain(prop.get("rich_text", [])); break
        except Exception as e:
            print(f"[WARN] PIC: {e}", file=sys.stderr)

    # Line items
    line_items = []
    try:
        br = requests.get(f"https://api.notion.com/v1/blocks/{page_id}/children",
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
                    rp   = row.get("properties", {})
                    item = {}

                    # Product name
                    for rel in rp.get("Product", {}).get("relation", [])[:1]:
                        try:
                            xr = requests.get(
                                f"https://api.notion.com/v1/pages/{rel['id']}",
                                headers=hdrs, timeout=10)
                            xr.raise_for_status()
                            xp = xr.json().get("properties", {})
                            np = xp.get("Product Name", {})
                            if np.get("type") == "title":
                                item["name"] = _plain(np["title"])
                        except Exception as e:
                            print(f"[WARN] product: {e}", file=sys.stderr)

                    # Product description rollup
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
        print(f"[WARN] blocks: {e}", file=sys.stderr)

    if not line_items and amount:
        line_items = [{"name": "Professional Services", "desc": "",
                       "qty": 1, "unit_price": float(amount)}]

    return {
        "quotation_no":    quotation_no or "QUOTE",
        "title_prop_name": title_prop_name,
        "issue_date":      issue_date,
        "payment_terms":   payment_terms,
        "quote_type":      quote_type,
        "amount":          amount,
        "company_name":    company_name,
        "company_address": company_address,
        "pic_name":        pic_name,
        "pic_email":       pic_email,
        "pic_phone":       pic_phone,
        "line_items":      line_items,
        "our_company":     fetch_company_details(hdrs),
    }


# ─────────────────────────────────────────────
#  2. Generate PDF — Cal.com / Vision Core style
# ─────────────────────────────────────────────
def generate_pdf(data):
    buffer = BytesIO()
    W, H   = A4
    margin = 20 * mm
    usable = W - 2 * margin        # ≈ 170 mm

    co        = data.get("our_company", {})
    co_name   = co.get("name")               or "Vision Core"
    co_email  = co.get("email")              or ""
    co_phone  = co.get("phone")              or ""
    co_bank   = co.get("bank_name")          or ""
    co_holder = co.get("bank_account_holder") or ""
    co_acc    = co.get("bank_number")        or ""
    co_pay    = co.get("payment_method")     or ""

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
        """Letter-spacing — one space between each char, two between words."""
        return " ".join(c if c != " " else "  " for c in text)

    story = []

    # ── 1. Top accent bar ─────────────────────
    story.append(HRFlowable(
        width=usable, color=C_BLACK, thickness=4, spaceAfter=6*mm
    ))

    # ── 2. Header: company left | "Quotation" right ──
    co_info = ""
    if co_phone: co_info += co_phone
    if co_email: co_info += ("<br/>" if co_info else "") + co_email

    hdr = Table([[
        # Left: company block
        Table([
            [Paragraph(f"<b>{co_name}</b>",
                       st("cn", fontSize=13, fontName="Helvetica-Bold", textColor=C_BLACK))],
            [Paragraph(co_info,
                       st("ci", fontSize=8, textColor=C_D500, leading=12))],
        ], colWidths=[usable * 0.55],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0),
                              ("VALIGN", (0,0),(-1,-1),"TOP")])),
        # Right: title
        Paragraph("Quotation",
                  st("qt", fontSize=28, fontName="Helvetica-Bold",
                     textColor=C_BLACK, alignment=2)),
    ]], colWidths=[usable * 0.55, usable * 0.45])
    hdr.setStyle(TableStyle([
        ("VALIGN",  (0,0),(-1,-1), "TOP"),
        ("PADDING", (0,0),(-1,-1), 0),
    ]))
    story.append(hdr)
    story.append(Spacer(1, 7*mm))

    # ── 3. Meta row: QUOTE NO. | DATE | VALID UNTIL ──
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

    meta = Table([[
        _mcell("QUOTE NO.",   data.get("quotation_no", "")),
        _mcell("DATE",        issue_display),
        _mcell("VALID UNTIL", valid_display),
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
    # Columns: DESCRIPTION (product name + detail) | QTY | UNIT PRICE | AMOUNT
    # widths:  55%                                  | 10% | 18%        | 17%
    cw = [usable*0.55, usable*0.10, usable*0.18, usable*0.17]

    s_th  = st("th",  fontSize=7, fontName="Helvetica-Bold", textColor=C_WHITE)
    s_thr = st("thr", fontSize=7, fontName="Helvetica-Bold", textColor=C_WHITE, alignment=2)
    s_thc = st("thc", fontSize=7, fontName="Helvetica-Bold", textColor=C_WHITE, alignment=1)

    s_name = st("nm",  fontSize=9, fontName="Helvetica-Bold", textColor=C_BLACK)
    s_desc = st("dc",  fontSize=8, textColor=C_D500, leading=12)
    s_num  = st("nu",  fontSize=9, textColor=C_D700, alignment=2)
    s_numc = st("nuc", fontSize=9, textColor=C_D700, alignment=1)

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

        # Description cell: product name bold on top, detail text below
        desc_inner = [
            [Paragraph(item.get("name", ""), s_name)],
        ]
        if item.get("desc"):
            desc_inner.append(
                [Paragraph(item["desc"], s_desc)]
            )
        desc_cell = Table(
            desc_inner,
            colWidths=[cw[0] - 16],
            style=TableStyle([
                ("PADDING", (0,0),(-1,-1), 0),
                ("VALIGN",  (0,0),(-1,-1), "TOP"),
            ])
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
        ("BACKGROUND",     (0,0), (-1,0),         C_BLACK),
        ("PADDING",        (0,0), (-1,-1),         8),
        ("VALIGN",         (0,0), (-1,-1),         "TOP"),
        ("LINEBELOW",      (0,1), (-1,n_data-1),   0.5, C_D200),
        ("ROWBACKGROUNDS", (0,1), (-1,n_data-1),   [C_WHITE, C_D100]),
    ]))
    story.append(items_tbl)
    story.append(Spacer(1, 4*mm))

    # ── 6. Totals (right-aligned, no bg) ──────
    has_deposit = (data.get("payment_terms") == "50% Deposit")
    deposit     = total * 0.5 if has_deposit else 0

    tot_rows = []
    tot_rows.append([
        Paragraph("Subtotal", st("stl", fontSize=9, textColor=C_D400, alignment=2)),
        Paragraph(f"RM {total:,.2f}", st("stv", fontSize=9, textColor=C_D700, alignment=2)),
    ])
    if has_deposit:
        tot_rows.append([
            Paragraph("Deposit Due (50%)", st("ddl", fontSize=9, textColor=C_D400, alignment=2)),
            Paragraph(f"RM {deposit:,.2f}", st("ddv", fontSize=9, textColor=C_D700, alignment=2)),
        ])
    n_tot = len(tot_rows)
    tot_rows.append([
        Paragraph("<b>Total Due</b>",
                  st("tdl", fontSize=11, fontName="Helvetica-Bold",
                     textColor=C_BLACK, alignment=2)),
        Paragraph(f"<b>RM {total:,.2f}</b>",
                  st("tdv", fontSize=11, fontName="Helvetica-Bold",
                     textColor=C_BLACK, alignment=2)),
    ])

    # Totals align to the right two columns of the table (UNIT PRICE + AMOUNT = 35%)
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

    # ── 7. Thin divider ───────────────────────
    story.append(HRFlowable(width=usable, color=C_D200, thickness=0.5))
    story.append(Spacer(1, 6*mm))

    # ── 8. NOTES & TERMS  |  PAYMENT DETAILS (two columns) ───
    terms_html = (f"<font size='7' color='#9CA3AF'>{tracked('NOTES & TERMS')}</font>"
                  f"<br/><br/>")
    for term in TERMS:
        terms_html += f"<font size='8' color='#4B5563'>{term}</font><br/>"

    pay_lines = []
    if co_pay:    pay_lines.append(f"<b>Method</b>  {co_pay}")
    if co_bank:   pay_lines.append(f"<b>Bank</b>  {co_bank}")
    if co_holder: pay_lines.append(f"<b>Account Name</b>  {co_holder}")
    if co_acc:    pay_lines.append(f"<b>Account No.</b>  {co_acc}")

    pay_html = (f"<font size='7' color='#9CA3AF'>{tracked('PAYMENT DETAILS')}</font>"
                f"<br/><br/>")
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
    return buffer


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
#  4. Write back to Notion
# ─────────────────────────────────────────────
def update_notion_page(page_id, pdf_url, total_amount, quotation_no=None, title_prop_name=None):
    api_key = os.environ.get("NOTION_API_KEY")
    if not api_key:
        raise ValueError("NOTION_API_KEY not set")
    hdrs = {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }
    payload = {"properties": {"PDF": {"url": pdf_url}}}
    if total_amount and total_amount > 0:
        payload["properties"]["Amount"] = {"number": total_amount}
    # Write quotation number to the title property in the same PATCH call
    if quotation_no and title_prop_name and QUO_PATTERN.match(quotation_no):
        payload["properties"][title_prop_name] = {
            "title": [{"text": {"content": quotation_no}}]
        }
        print(f"[INFO] Writing quotation number {quotation_no} to '{title_prop_name}'", file=sys.stderr)
    resp = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json=payload, timeout=10,
    )
    if not resp.ok:
        print(f"[WARN] update_notion_page PATCH failed {resp.status_code}: {resp.text[:300]}", file=sys.stderr)
    resp.raise_for_status()


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

            print(f"[INFO] Generating for: {page_id}", file=sys.stderr)

            data       = fetch_quotation_data(page_id)
            pdf_buffer = generate_pdf(data)

            safe     = (data["quotation_no"]
                        .replace(" ","-").replace("/","-").replace("\\","-"))
            filename = f"quotations/{safe}.pdf"

            pdf_url = upload_to_blob(pdf_buffer, filename)

            total_amount = sum(
                float(i.get("qty", 1)) * float(i.get("unit_price", 0))
                for i in data.get("line_items", [])
            )
            update_notion_page(
                page_id, pdf_url, total_amount,
                quotation_no=data["quotation_no"],
                title_prop_name=data.get("title_prop_name"),
            )

            self._respond(200, {"status":       "success",
                                "quotation_no": data["quotation_no"],
                                "pdf_url":      pdf_url})
        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})
