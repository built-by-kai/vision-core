import json
import os
import sys
from datetime import datetime
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
#  Customise these to match your company
# ─────────────────────────────────────────────
COMPANY_INFO = {
    "name":    "Vision Core",
    "address": "Kuala Lumpur, Malaysia",
    "phone":   "+60 12-345 6789",
    "email":   "hello@visioncore.com",
    "website": "visioncore.com",
    "reg_no":  "SA0012345-X",
}

TERMS = [
    "This quotation is valid for 30 days from the issue date.",
    "All prices are in Malaysian Ringgit (MYR) and are exclusive of applicable taxes.",
    "A signed acceptance or purchase order is required to commence work.",
    "50% deposit is required upon acceptance (where applicable); balance upon delivery.",
]

# Palette
NAVY       = colors.HexColor("#0D1B2A")
GOLD       = colors.HexColor("#C9A84C")
LIGHT_GRAY = colors.HexColor("#F5F5F5")
WHITE      = colors.white
DARK_TEXT  = colors.HexColor("#333333")
MID_TEXT   = colors.HexColor("#666666")


# ─────────────────────────────────────────────
#  Helper: plain text from Notion rich-text
# ─────────────────────────────────────────────
def _plain(rich_text_array):
    return "".join(t.get("plain_text", "") for t in (rich_text_array or []))


# ─────────────────────────────────────────────
#  1. Fetch all quotation data from Notion
# ─────────────────────────────────────────────
def fetch_quotation_data(page_id):
    api_key = os.environ.get("NOTION_API_KEY")
    if not api_key:
        raise ValueError("NOTION_API_KEY environment variable is not set")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }

    # ── Page properties ──────────────────────
    resp = requests.get(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=headers, timeout=15
    )
    resp.raise_for_status()
    props = resp.json().get("properties", {})

    # Quotation No.
    quotation_no = _plain(props.get("Quotation No.", {}).get("title", []))

    # Issue Date
    issue_date = ""
    date_prop = props.get("Issue Date", {})
    if date_prop.get("type") == "date" and date_prop.get("date"):
        issue_date = date_prop["date"].get("start", "")

    # Payment Terms
    payment_terms = ""
    pt = props.get("Payment Terms", {}).get("select") or {}
    payment_terms = pt.get("name", "")

    # Quote Type
    qt = props.get("Quote Type", {}).get("select") or {}
    quote_type = qt.get("name", "")

    # Status
    st = props.get("Status", {}).get("select") or {}
    status = st.get("name", "Draft")

    # Amount (stored directly on the row)
    amount = props.get("Amount", {}).get("number") or 0

    # ── Company (relation) ───────────────────
    company_name = ""
    company_address = ""
    company_rel = props.get("Company", {}).get("relation", [])
    if company_rel:
        try:
            c_resp = requests.get(
                f"https://api.notion.com/v1/pages/{company_rel[0]['id']}",
                headers=headers, timeout=10
            )
            c_resp.raise_for_status()
            c_props = c_resp.json().get("properties", {})

            # Title property (try a few common names)
            for key in ["Name", "Company Name", "name"]:
                if key in c_props and c_props[key].get("type") == "title":
                    company_name = _plain(c_props[key].get("title", []))
                    if company_name:
                        break

            # Address (rich_text)
            for key in ["Address", "address", "Company Address"]:
                if key in c_props and c_props[key].get("type") == "rich_text":
                    company_address = _plain(c_props[key].get("rich_text", []))
                    if company_address:
                        break
        except Exception as e:
            print(f"[WARN] Could not fetch company: {e}", file=sys.stderr)

    # ── PIC – Person In Charge (relation) ────
    pic_name = ""
    pic_email = ""
    pic_rel = props.get("PIC", {}).get("relation", [])
    if pic_rel:
        try:
            p_resp = requests.get(
                f"https://api.notion.com/v1/pages/{pic_rel[0]['id']}",
                headers=headers, timeout=10
            )
            p_resp.raise_for_status()
            p_props = p_resp.json().get("properties", {})

            for key in ["Name", "Full Name", "Contact Name", "name"]:
                if key in p_props and p_props[key].get("type") == "title":
                    pic_name = _plain(p_props[key].get("title", []))
                    if pic_name:
                        break

            for key in ["Email", "email", "Email Address"]:
                if key in p_props and p_props[key].get("type") == "email":
                    pic_email = p_props[key].get("email") or ""
                    if pic_email:
                        break
        except Exception as e:
            print(f"[WARN] Could not fetch PIC: {e}", file=sys.stderr)

    # ── Line items (from child blocks / child database) ──
    line_items = []
    try:
        b_resp = requests.get(
            f"https://api.notion.com/v1/blocks/{page_id}/children",
            headers=headers, timeout=10
        )
        b_resp.raise_for_status()
        blocks = b_resp.json().get("results", [])

        for block in blocks:
            btype = block.get("type")

            # Child database (most common pattern for line-item tables)
            if btype == "child_database":
                db_id = block["id"].replace("-", "")
                try:
                    db_resp = requests.post(
                        f"https://api.notion.com/v1/databases/{db_id}/query",
                        headers=headers, json={}, timeout=10
                    )
                    db_resp.raise_for_status()
                    rows = db_resp.json().get("results", [])

                    for row in rows:
                        rp = row.get("properties", {})
                        item = {}

                        # Description / item name
                        for key in ["Item", "Description", "Service", "Name", "name"]:
                            prop = rp.get(key, {})
                            if prop.get("type") == "title":
                                item["description"] = _plain(prop.get("title", []))
                            elif prop.get("type") == "rich_text":
                                item["description"] = _plain(prop.get("rich_text", []))
                            if item.get("description"):
                                break

                        # Quantity
                        for key in ["Qty", "Quantity", "qty", "quantity", "Units"]:
                            prop = rp.get(key, {})
                            if prop.get("type") == "number" and prop.get("number") is not None:
                                item["qty"] = prop["number"]
                                break

                        # Unit price
                        for key in ["Unit Price", "Price", "Rate", "Unit Rate", "unit_price"]:
                            prop = rp.get(key, {})
                            if prop.get("type") == "number" and prop.get("number") is not None:
                                item["unit_price"] = prop["number"]
                                break

                        if item.get("description"):
                            item.setdefault("qty", 1)
                            item.setdefault("unit_price", 0)
                            line_items.append(item)
                except Exception as e:
                    print(f"[WARN] Could not query child DB: {e}", file=sys.stderr)

    except Exception as e:
        print(f"[WARN] Could not fetch page blocks: {e}", file=sys.stderr)

    # Fallback: use the Amount field directly if no line items found
    if not line_items and amount:
        line_items = [{
            "description": "Professional Services",
            "qty": 1,
            "unit_price": float(amount),
        }]

    return {
        "quotation_no":   quotation_no or "QUOTE",
        "issue_date":     issue_date,
        "payment_terms":  payment_terms,
        "quote_type":     quote_type,
        "status":         status,
        "amount":         amount,
        "company_name":   company_name,
        "company_address": company_address,
        "pic_name":       pic_name,
        "pic_email":      pic_email,
        "line_items":     line_items,
    }


# ─────────────────────────────────────────────
#  2. Generate PDF with ReportLab
# ─────────────────────────────────────────────
def generate_pdf(data):
    buffer = BytesIO()
    W, H = A4
    margin = 18 * mm
    usable = W - 2 * margin

    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=margin, leftMargin=margin,
        topMargin=margin, bottomMargin=margin,
    )

    styles = getSampleStyleSheet()

    def style(name, **kw):
        kw.setdefault("fontName", "Helvetica")
        kw.setdefault("fontSize", 9)
        kw.setdefault("leading", 13)
        return ParagraphStyle(name, parent=styles["Normal"], **kw)

    s_white     = style("white",    textColor=WHITE)
    s_white_b   = style("white_b",  textColor=WHITE, fontName="Helvetica-Bold")
    s_gold_b    = style("gold_b",   textColor=GOLD,  fontName="Helvetica-Bold", fontSize=16)
    s_body      = style("body",     textColor=DARK_TEXT)
    s_label     = style("label",    textColor=MID_TEXT, fontSize=8)
    s_th        = style("th",       textColor=WHITE, fontName="Helvetica-Bold", alignment=1)
    s_num       = style("num",      textColor=DARK_TEXT, alignment=2)
    s_num_b     = style("num_b",    textColor=WHITE, fontName="Helvetica-Bold", alignment=2)
    s_footer    = style("footer",   textColor=MID_TEXT, fontSize=7, alignment=1)
    s_terms_ttl = style("terms_ttl",textColor=NAVY, fontName="Helvetica-Bold", fontSize=10)

    story = []

    # ── Header banner ────────────────────────
    hdr_left = [
        [Paragraph(COMPANY_INFO["name"], s_gold_b)],
        [Paragraph(
            f"{COMPANY_INFO['address']}<br/>"
            f"{COMPANY_INFO['phone']}<br/>"
            f"{COMPANY_INFO['email']}",
            s_white
        )],
    ]
    hdr_right = [
        [Paragraph("QUOTATION",
                   style("q_ttl", textColor=WHITE, fontName="Helvetica-Bold",
                         fontSize=22, alignment=2))],
        [Paragraph(
            f"<font color='#C9A84C'><b>{data['quotation_no']}</b></font>",
            style("q_no", textColor=WHITE, fontSize=11, alignment=2)
        )],
    ]

    hdr_tbl = Table(
        [[Table(hdr_left, colWidths=[usable * 0.6],
                style=TableStyle([("BACKGROUND", (0,0),(-1,-1), NAVY),
                                  ("PADDING",    (0,0),(-1,-1), 0)])),
          Table(hdr_right, colWidths=[usable * 0.4],
                style=TableStyle([("BACKGROUND", (0,0),(-1,-1), NAVY),
                                  ("PADDING",    (0,0),(-1,-1), 0)]))]],
        colWidths=[usable * 0.6, usable * 0.4]
    )
    hdr_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), NAVY),
        ("PADDING",    (0,0),(-1,-1), 12),
        ("VALIGN",     (0,0),(-1,-1), "MIDDLE"),
        ("LINEBELOW",  (0,-1),(-1,-1), 2, GOLD),
    ]))
    story.append(hdr_tbl)
    story.append(Spacer(1, 6*mm))

    # ── Bill-to / Details row ────────────────
    issue_display = data.get("issue_date", "")
    if issue_display:
        try:
            issue_display = datetime.fromisoformat(issue_display).strftime("%d %B %Y")
        except Exception:
            pass

    bill_to_lines = f"<b>{data.get('company_name') or 'N/A'}</b>"
    if data.get("company_address"):
        bill_to_lines += f"<br/>{data['company_address'].replace(chr(10), '<br/>')}"
    if data.get("pic_name"):
        bill_to_lines += f"<br/>Attn: {data['pic_name']}"
        if data.get("pic_email"):
            bill_to_lines += f"<br/>{data['pic_email']}"

    detail_inner = Table([
        [Paragraph("Issue Date:",    s_label), Paragraph(issue_display or "—", s_body)],
        [Paragraph("Quote Type:",    s_label), Paragraph(data.get("quote_type")    or "—", s_body)],
        [Paragraph("Payment Terms:", s_label), Paragraph(data.get("payment_terms") or "—", s_body)],
        [Paragraph("Status:",        s_label), Paragraph(data.get("status")        or "Draft", s_body)],
    ], colWidths=[usable*0.17, usable*0.28],
       style=TableStyle([("PADDING", (0,0),(-1,-1), 2), ("VALIGN",(0,0),(-1,-1),"TOP")]))

    info_tbl = Table(
        [[Paragraph("<b>BILL TO</b>",
                    style("bill_lbl", textColor=NAVY, fontName="Helvetica-Bold", fontSize=8)),
          "",
          Paragraph("<b>DETAILS</b>",
                    style("det_lbl",  textColor=NAVY, fontName="Helvetica-Bold", fontSize=8))],
         [Paragraph(bill_to_lines, s_body), "", detail_inner]],
        colWidths=[usable*0.45, usable*0.1, usable*0.45]
    )
    info_tbl.setStyle(TableStyle([
        ("VALIGN",  (0,0),(-1,-1), "TOP"),
        ("PADDING", (0,0),(-1,-1), 4),
    ]))
    story.append(info_tbl)
    story.append(Spacer(1, 6*mm))

    # ── Line-items table ─────────────────────
    col_w = [usable*0.05, usable*0.47, usable*0.08, usable*0.20, usable*0.20]

    rows = [[
        Paragraph("NO.",          s_th),
        Paragraph("DESCRIPTION",  s_th),
        Paragraph("QTY",          s_th),
        Paragraph("UNIT PRICE",   style("th_r", textColor=WHITE, fontName="Helvetica-Bold", alignment=2)),
        Paragraph("AMOUNT (MYR)", style("th_r2",textColor=WHITE, fontName="Helvetica-Bold", alignment=2)),
    ]]

    total = 0.0
    for i, item in enumerate(data.get("line_items", []), 1):
        qty   = float(item.get("qty", 1))
        price = float(item.get("unit_price", 0))
        amt   = qty * price
        total += amt
        rows.append([
            Paragraph(str(i), s_body),
            Paragraph(item.get("description", ""), s_body),
            Paragraph(f"{qty:g}", s_num),
            Paragraph(f"{price:,.2f}", s_num),
            Paragraph(f"{amt:,.2f}", s_num),
        ])

    # Total row
    rows.append([
        "", "",
        Paragraph("<b>TOTAL</b>",
                  style("tot_lbl", textColor=WHITE, fontName="Helvetica-Bold",
                        fontSize=10, alignment=2)),
        "",
        Paragraph(f"<b>MYR {total:,.2f}</b>",
                  style("tot_val", textColor=WHITE, fontName="Helvetica-Bold",
                        fontSize=10, alignment=2)),
    ])

    # Optional deposit row
    has_deposit = (data.get("payment_terms") == "50% Deposit")
    if has_deposit:
        deposit = total * 0.5
        rows.append([
            "", "",
            Paragraph("<b>DEPOSIT DUE (50%)</b>",
                      style("dep_lbl", textColor=GOLD, fontName="Helvetica-Bold",
                            fontSize=9, alignment=2)),
            "",
            Paragraph(f"<b>MYR {deposit:,.2f}</b>",
                      style("dep_val", textColor=GOLD, fontName="Helvetica-Bold",
                            fontSize=9, alignment=2)),
        ])

    n_data = len(rows)
    total_row_i = n_data - 2 if has_deposit else n_data - 1

    ts = TableStyle([
        # Header
        ("BACKGROUND",  (0, 0),  (-1, 0),  NAVY),
        ("TEXTCOLOR",   (0, 0),  (-1, 0),  WHITE),
        # Data rows alternating background
        ("ROWBACKGROUNDS", (0, 1), (-1, total_row_i - 1), [WHITE, LIGHT_GRAY]),
        # Grid for data rows
        ("GRID",        (0, 0),  (-1, total_row_i - 1), 0.5, colors.HexColor("#DDDDDD")),
        ("PADDING",     (0, 0),  (-1, -1), 6),
        ("VALIGN",      (0, 0),  (-1, -1), "TOP"),
        # Total row
        ("BACKGROUND",  (0, total_row_i), (-1, total_row_i), NAVY),
        ("LINEABOVE",   (0, total_row_i), (-1, total_row_i), 1.5, GOLD),
        ("SPAN",        (0, total_row_i), (1, total_row_i)),
        ("SPAN",        (2, total_row_i), (3, total_row_i)),
    ])

    if has_deposit:
        dep_i = n_data - 1
        ts.add("BACKGROUND", (0, dep_i), (-1, dep_i), NAVY)
        ts.add("SPAN",       (0, dep_i), (1, dep_i))
        ts.add("SPAN",       (2, dep_i), (3, dep_i))

    items_tbl = Table(rows, colWidths=col_w)
    items_tbl.setStyle(ts)
    story.append(items_tbl)
    story.append(Spacer(1, 8*mm))

    # ── Terms & conditions ───────────────────
    story.append(Paragraph("Terms &amp; Conditions", s_terms_ttl))
    story.append(Spacer(1, 2*mm))
    for idx, term in enumerate(TERMS, 1):
        story.append(Paragraph(f"{idx}.  {term}", s_body))

    story.append(Spacer(1, 10*mm))

    # ── Signature block ──────────────────────
    sig_tbl = Table([
        [Paragraph("Authorised Signature", s_label),
         Paragraph("Client Acceptance",    s_label)],
        [Paragraph(
             f"<br/><br/><br/>{'─'*28}<br/>"
             f"<b>{COMPANY_INFO['name']}</b>",
             s_body),
         Paragraph(
             f"<br/><br/><br/>{'─'*28}<br/>"
             f"{data.get('company_name', '')}",
             s_body)],
    ], colWidths=[usable*0.5, usable*0.5])
    sig_tbl.setStyle(TableStyle([
        ("PADDING", (0,0),(-1,-1), 6),
        ("VALIGN",  (0,0),(-1,-1), "TOP"),
    ]))
    story.append(sig_tbl)
    story.append(Spacer(1, 6*mm))

    # ── Footer ───────────────────────────────
    story.append(HRFlowable(width=usable, color=GOLD, thickness=1))
    story.append(Spacer(1, 2*mm))
    story.append(Paragraph(
        f"{COMPANY_INFO['name']}  ·  {COMPANY_INFO['email']}  ·  "
        f"{COMPANY_INFO['website']}  ·  Reg: {COMPANY_INFO['reg_no']}",
        s_footer
    ))

    doc.build(story)
    buffer.seek(0)
    return buffer


# ─────────────────────────────────────────────
#  3. Upload to Vercel Blob Storage
# ─────────────────────────────────────────────
def upload_to_blob(pdf_buffer, filename):
    token = os.environ.get("BLOB_READ_WRITE_TOKEN")
    if not token:
        raise ValueError("BLOB_READ_WRITE_TOKEN environment variable is not set")

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
        raise ValueError("NOTION_API_KEY environment variable is not set")

    headers = {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }

    payload = {"properties": {"PDF": {"url": pdf_url}}}
    if total_amount and total_amount > 0:
        payload["properties"]["Amount"] = {"number": total_amount}

    resp = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=headers, json=payload, timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


# ─────────────────────────────────────────────
#  Vercel handler
# ─────────────────────────────────────────────
def handler(request):
    try:
        # ── Health check ──
        if request.method == "GET":
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "service": "Vision Core Quotation PDF Generator",
                    "status":  "ready",
                })
            }

        if request.method != "POST":
            return {"statusCode": 405, "body": json.dumps({"error": "Method not allowed"})}

        # ── Optional auth ──
        secret = os.environ.get("WEBHOOK_SECRET", "")
        if secret:
            auth = request.headers.get("authorization", "")
            if auth != f"Bearer {secret}":
                return {"statusCode": 401, "body": json.dumps({"error": "Unauthorized"})}

        # ── Parse body ──
        try:
            body = request.json()
        except Exception:
            body = {}

        print(f"[DEBUG] Payload keys: {list(body.keys())}", file=sys.stderr)

        # ── Extract page_id (Notion sends it in source.page_id) ──
        page_id = None
        if "source" in body:
            page_id = body["source"].get("page_id")
        if not page_id and "data" in body:
            page_id = body["data"].get("page_id")
        if not page_id:
            page_id = body.get("page_id")
        if not page_id:
            page_id = (request.query or {}).get("pageId")

        if not page_id:
            return {"statusCode": 400, "body": json.dumps({"error": "No page_id found in request"})}

        print(f"[INFO] Generating PDF for page: {page_id}", file=sys.stderr)

        # ── Core workflow ──
        data       = fetch_quotation_data(page_id)
        pdf_buffer = generate_pdf(data)

        safe_name = (data["quotation_no"]
                     .replace(" ", "-").replace("/", "-").replace("\\", "-"))
        filename  = f"quotations/{safe_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"

        pdf_url = upload_to_blob(pdf_buffer, filename)

        total_amount = sum(
            float(item.get("qty", 1)) * float(item.get("unit_price", 0))
            for item in data.get("line_items", [])
        )

        update_notion_page(page_id, pdf_url, total_amount)

        return {
            "statusCode": 200,
            "body": json.dumps({
                "status":       "success",
                "quotation_no": data["quotation_no"],
                "pdf_url":      pdf_url,
            })
        }

    except Exception as e:
        print(f"[ERROR] {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
