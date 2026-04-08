"""
Vision Core — Quotation PDF Generator (Vercel Serverless Function)
===================================================================
Webhook endpoint that:
1. Receives POST from Notion button automation
2. Pulls quotation data from Notion API (page props, company, PIC, line items)
3. Generates a branded PDF using ReportLab
4. Uploads PDF to Vercel Blob Storage
5. Writes the PDF URL back to the Notion quotation page
"""

from http.server import BaseHTTPRequestHandler
import json
import os
import sys
from io import BytesIO
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs

import requests as http_requests
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
)

# ── Config ──
NOTION_API_KEY = os.environ.get("NOTION_API_KEY", "")
BLOB_READ_WRITE_TOKEN = os.environ.get("BLOB_READ_WRITE_TOKEN", "")
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")  # optional auth

NOTION_BASE = "https://api.notion.com/v1"
NOTION_HEADERS = {
    "Authorization": f"Bearer {NOTION_API_KEY}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
}

# ── Black & White Palette ──
CLR_BLACK = HexColor("#111111")
CLR_DARK = HexColor("#222222")
CLR_TEXT = HexColor("#333333")
CLR_MUTED = HexColor("#999999")
CLR_LIGHT = HexColor("#e0e0e0")
CLR_BORDER = HexColor("#cccccc")
CLR_BG = HexColor("#f7f7f7")
CLR_WHITE = HexColor("#ffffff")

# ── Vision Core Details DB (fetched dynamically) ──
COMPANY_DETAILS_DB_ID = os.environ.get(
    "COMPANY_DETAILS_DB_ID", "33c8b289e31a80b1aa85fc1921cc0adc"
)

# Fallback defaults (used if Notion fetch fails)
COMPANY_INFO_DEFAULTS = {
    "name": "Vision Core",
    "tagline": "Systems Builder & Notion Consultant",
    "email": "kaikhairula@gmail.com",
    "phone": "+60 11-5408 3044",
    "bank_name": "AMBANK ISLAMIC BERHAD",
    "account_name": "AQILAH BINTI KHAIRUL AZHAR",
    "account_number": "8881-06934-4034",
    "payment_method": "Bank Transfer",
    "prepared_by": "Nadia — Vision Core",
}


def fetch_company_info():
    """Fetch company details from Vision Core Details DB in Notion."""
    try:
        resp = notion_post(f"/databases/{COMPANY_DETAILS_DB_ID}/query", {
            "page_size": 1
        })
        results = resp.get("results", [])
        if not results:
            return dict(COMPANY_INFO_DEFAULTS)

        props = results[0].get("properties", {})
        name = get_prop_value(props, "Name", "title") or COMPANY_INFO_DEFAULTS["name"]
        industry = get_prop_value(props, "Industry", "select")
        email = get_prop_value(props, "Email", "email") or COMPANY_INFO_DEFAULTS["email"]
        phone = get_prop_value(props, "Phone", "phone_number") or COMPANY_INFO_DEFAULTS["phone"]
        bank_name = get_prop_value(props, "Bank Name", "rich_text") or COMPANY_INFO_DEFAULTS["bank_name"]
        account_name = get_prop_value(props, "Bank Account Holder Name", "rich_text") or COMPANY_INFO_DEFAULTS["account_name"]
        account_number = get_prop_value(props, "Bank Number", "rich_text") or COMPANY_INFO_DEFAULTS["account_number"]
        payment_method = get_prop_value(props, "Payment Method", "select") or COMPANY_INFO_DEFAULTS["payment_method"]

        return {
            "name": name,
            "tagline": industry or COMPANY_INFO_DEFAULTS["tagline"],
            "email": email,
            "phone": phone,
            "bank_name": bank_name.replace("**", ""),  # strip markdown bold
            "account_name": account_name,
            "account_number": account_number.replace("**", ""),  # strip markdown bold
            "payment_method": payment_method,
            "prepared_by": f"Nadia — {name}",
        }
    except Exception as e:
        print(f"Error fetching company info: {e}", file=sys.stderr)
        return dict(COMPANY_INFO_DEFAULTS)

TERMS = [
    "This quotation is valid for 30 days from the issue date.",
    "50% deposit required before project commencement. Balance 50% upon project completion.",
    "Scope changes after approval may result in revised pricing.",
    "All prices are in MYR (RM) and exclusive of SST unless stated otherwise.",
    "Project timeline will be confirmed upon deposit payment.",
]


# ═══════════════════════════════════════════════════════════════
# NOTION API HELPERS
# ═══════════════════════════════════════════════════════════════

def notion_get(endpoint):
    """GET request to Notion API."""
    r = http_requests.get(f"{NOTION_BASE}{endpoint}", headers=NOTION_HEADERS)
    r.raise_for_status()
    return r.json()


def notion_post(endpoint, data):
    """POST request to Notion API."""
    r = http_requests.post(f"{NOTION_BASE}{endpoint}", headers=NOTION_HEADERS, json=data)
    r.raise_for_status()
    return r.json()


def notion_patch(endpoint, data):
    """PATCH request to Notion API."""
    r = http_requests.patch(f"{NOTION_BASE}{endpoint}", headers=NOTION_HEADERS, json=data)
    r.raise_for_status()
    return r.json()


def extract_page_id(body):
    """Extract page_id from Notion webhook payload.

    Notion button webhook format:
    {
      "source": { "type": "automation", "page_id": "..." },
      "data": { "Quotation No.": "...", ... }
    }
    """
    # Notion button: page_id is under "source"
    if "source" in body and "page_id" in body.get("source", {}):
        return body["source"]["page_id"]
    # Also check under "data" (older format / manual calls)
    if "data" in body and "page_id" in body["data"]:
        return body["data"]["page_id"]
    # Fallback: check for page_id at top level
    if "page_id" in body:
        return body["page_id"]
    raise ValueError(f"No page_id found in webhook payload. Keys received: {list(body.keys())}")


def get_prop_value(props, name, prop_type=None):
    """Safely extract a property value from Notion page properties."""
    prop = props.get(name, {})
    t = prop.get("type", prop_type)

    if t == "title":
        items = prop.get("title", [])
        return "".join(i.get("plain_text", "") for i in items) if items else ""
    elif t == "rich_text":
        items = prop.get("rich_text", [])
        return "".join(i.get("plain_text", "") for i in items) if items else ""
    elif t == "number":
        return prop.get("number") or 0
    elif t == "select":
        sel = prop.get("select")
        return sel.get("name", "") if sel else ""
    elif t == "date":
        d = prop.get("date")
        return d.get("start", "") if d else ""
    elif t == "relation":
        rels = prop.get("relation", [])
        return [r["id"] for r in rels] if rels else []
    elif t == "email":
        return prop.get("email") or ""
    elif t == "phone_number":
        return prop.get("phone_number") or ""
    elif t == "url":
        return prop.get("url") or ""
    elif t == "formula":
        formula = prop.get("formula", {})
        ft = formula.get("type", "")
        return formula.get(ft, "")
    elif t == "rollup":
        rollup = prop.get("rollup", {})
        rt = rollup.get("type", "")
        if rt == "array":
            arr = rollup.get("array", [])
            results = []
            for item in arr:
                it = item.get("type", "")
                if it == "title":
                    results.append("".join(x.get("plain_text", "") for x in item.get("title", [])))
                elif it == "rich_text":
                    results.append("".join(x.get("plain_text", "") for x in item.get("rich_text", [])))
                elif it == "number":
                    results.append(item.get("number", 0))
            return results
        return rollup.get(rt, "")
    elif t == "unique_id":
        uid = prop.get("unique_id", {})
        prefix = uid.get("prefix", "")
        number = uid.get("number", "")
        return f"{prefix}-{number}" if prefix else str(number)
    return ""


def fetch_quotation_data(page_id):
    """Fetch all quotation data from Notion."""
    # 1. Get quotation page properties
    page = notion_get(f"/pages/{page_id}")
    props = page.get("properties", {})

    quotation_no = get_prop_value(props, "Quotation No.", "title")
    amount = get_prop_value(props, "Amount", "number")
    issue_date_raw = get_prop_value(props, "Issue Date", "date")
    payment_terms = get_prop_value(props, "Payment Terms", "select")
    quote_type = get_prop_value(props, "Quote Type", "select")
    status = get_prop_value(props, "Status", "select")
    company_ids = get_prop_value(props, "Company", "relation")
    pic_ids = get_prop_value(props, "PIC", "relation")

    # Format date
    if issue_date_raw:
        try:
            dt = datetime.fromisoformat(issue_date_raw)
            issue_date = dt.strftime("%d %b %Y")
            valid_until = (dt + timedelta(days=30)).strftime("%d %b %Y")
        except ValueError:
            issue_date = issue_date_raw
            valid_until = ""
    else:
        issue_date = datetime.now().strftime("%d %b %Y")
        valid_until = (datetime.now() + timedelta(days=30)).strftime("%d %b %Y")

    # 2. Get company details
    client_company = ""
    client_address = ""
    client_email = ""
    client_phone = ""

    if company_ids:
        try:
            company_page = notion_get(f"/pages/{company_ids[0]}")
            cp = company_page.get("properties", {})
            client_company = get_prop_value(cp, "Name", "title")
            client_address = get_prop_value(cp, "Address", "rich_text")
            client_email = get_prop_value(cp, "Email", "email")
            client_phone = get_prop_value(cp, "Phone", "phone_number")
        except Exception:
            pass

    # 3. Get PIC details
    client_pic = ""
    pic_email = ""
    pic_phone = ""

    if pic_ids:
        try:
            pic_page = notion_get(f"/pages/{pic_ids[0]}")
            pp = pic_page.get("properties", {})
            client_pic = get_prop_value(pp, "Name", "title")
            pic_email = get_prop_value(pp, "Email", "email")
            pic_phone = get_prop_value(pp, "Phone", "phone_number")
        except Exception:
            pass

    # 4. Find inline Line Items database
    line_items = []
    try:
        blocks = notion_get(f"/blocks/{page_id}/children?page_size=100")
        line_items_db_id = None

        for block in blocks.get("results", []):
            if block.get("type") == "child_database":
                # Check if it's the Line Items database
                title = block.get("child_database", {}).get("title", "")
                if "line item" in title.lower() or "item" in title.lower():
                    line_items_db_id = block["id"]
                    break

            # Also check inside callout blocks (Line Items is inside a callout)
            if block.get("type") == "callout" and block.get("has_children"):
                children = notion_get(f"/blocks/{block['id']}/children?page_size=100")
                for child in children.get("results", []):
                    if child.get("type") == "child_database":
                        line_items_db_id = child["id"]
                        break
                if line_items_db_id:
                    break

        if line_items_db_id:
            # Query the Line Items database
            items_resp = notion_post(f"/databases/{line_items_db_id}/query", {
                "page_size": 100
            })
            for item in items_resp.get("results", []):
                ip = item.get("properties", {})
                qty = get_prop_value(ip, "Qty", "number") or 1
                unit_price = get_prop_value(ip, "Unit Price", "number") or 0
                notes = get_prop_value(ip, "Notes", "title")

                # Get product NAME from relation
                product_name = ""
                product_ids = get_prop_value(ip, "Product", "relation")
                if product_ids:
                    try:
                        prod_page = notion_get(f"/pages/{product_ids[0]}")
                        pp = prod_page.get("properties", {})
                        product_name = get_prop_value(pp, "Name", "title")
                    except Exception:
                        pass

                # Get product description from rollup
                prod_desc = ""
                product_desc = get_prop_value(ip, "Product Description", "rollup")
                if isinstance(product_desc, list) and product_desc:
                    prod_desc = product_desc[0]
                elif isinstance(product_desc, str):
                    prod_desc = product_desc

                # Build description: "Product Name — description" or fallback to notes
                if product_name and prod_desc:
                    description = f"<b>{product_name}</b> — {prod_desc}"
                elif product_name:
                    description = f"<b>{product_name}</b>"
                elif notes:
                    description = notes
                else:
                    description = prod_desc

                if description or unit_price:
                    line_items.append({
                        "description": description,
                        "qty": int(qty) if qty == int(qty) else qty,
                        "unit_price": float(unit_price),
                    })
    except Exception as e:
        print(f"Error fetching line items: {e}", file=sys.stderr)

    # Use PIC contact info, fall back to company info
    contact_email = pic_email or client_email
    contact_phone = pic_phone or client_phone

    # Fetch company info dynamically from Notion
    co = fetch_company_info()

    return {
        "page_id": page_id,
        "quotation_no": quotation_no or "QUO-DRAFT",
        "company_name": co["name"],
        "company_tagline": co["tagline"],
        "company_email": co["email"],
        "company_phone": co["phone"],
        "client_company": client_company,
        "client_pic": client_pic,
        "client_address": client_address,
        "client_email": contact_email,
        "client_phone": contact_phone,
        "issue_date": issue_date,
        "valid_until": valid_until,
        "quote_type": quote_type or "New Business",
        "payment_terms": payment_terms or "50% Deposit",
        "line_items": line_items,
        "tax_rate": 0,
        "bank_details": {
            "bank_name": co["bank_name"],
            "account_name": co["account_name"],
            "account_number": co["account_number"],
            "payment_method": co.get("payment_method", "Bank Transfer"),
        },
        "terms": TERMS,
        "prepared_by": co["prepared_by"],
    }


# ═══════════════════════════════════════════════════════════════
# PDF GENERATOR (ReportLab)
# ═══════════════════════════════════════════════════════════════

def _draw_page_bg(canvas_obj, doc):
    """Draw minimal black & white page accents."""
    w, h = A4
    # Thin black line at top
    canvas_obj.setStrokeColor(CLR_BLACK)
    canvas_obj.setLineWidth(1.5)
    canvas_obj.line(18 * mm, h - 10 * mm, w - 18 * mm, h - 10 * mm)
    # Thin black line at bottom
    canvas_obj.setLineWidth(0.5)
    canvas_obj.line(18 * mm, 18 * mm, w - 18 * mm, 18 * mm)
    # Footer text
    canvas_obj.setFillColor(CLR_MUTED)
    canvas_obj.setFont("Helvetica", 6.5)
    canvas_obj.drawString(18 * mm, 12 * mm, "Vision Core  |  Digital Systems & Creative Studio")
    canvas_obj.drawRightString(w - 18 * mm, 12 * mm, f"Page {doc.page}")


def generate_pdf(data):
    """Generate a clean black & white quotation PDF, returns BytesIO buffer."""
    buffer = BytesIO()

    from reportlab.platypus import KeepTogether

    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=14 * mm, bottomMargin=24 * mm,
    )
    styles = getSampleStyleSheet()
    W = 174 * mm  # usable width

    # ── Styles ──
    styles.add(ParagraphStyle(name="CompanyName", fontName="Helvetica-Bold", fontSize=16, textColor=CLR_BLACK, spaceAfter=1 * mm, leading=18, letterSpacing=2))
    styles.add(ParagraphStyle(name="Tagline", fontName="Helvetica", fontSize=7, textColor=CLR_MUTED, leading=9, spaceBefore=0.5 * mm))
    styles.add(ParagraphStyle(name="DocTitle", fontName="Helvetica-Bold", fontSize=24, textColor=CLR_BLACK, spaceBefore=6 * mm, spaceAfter=6 * mm, leading=26))
    styles.add(ParagraphStyle(name="SectionLabel", fontName="Helvetica-Bold", fontSize=7, textColor=CLR_MUTED, spaceBefore=0, spaceAfter=2 * mm, leading=9))
    styles.add(ParagraphStyle(name="MetaLabel", fontName="Helvetica", fontSize=6.5, textColor=CLR_MUTED, leading=9))
    styles.add(ParagraphStyle(name="MetaValue", fontName="Helvetica-Bold", fontSize=8.5, textColor=CLR_BLACK, leading=12))
    styles["BodyText"].fontName = "Helvetica"
    styles["BodyText"].fontSize = 8
    styles["BodyText"].textColor = CLR_TEXT
    styles["BodyText"].leading = 12
    styles.add(ParagraphStyle(name="BodyBold", fontName="Helvetica-Bold", fontSize=8, textColor=CLR_BLACK, leading=12))
    styles.add(ParagraphStyle(name="Small", fontName="Helvetica", fontSize=7, textColor=CLR_MUTED, leading=10))

    story = []

    # ═══════════════════════════════════════════
    # HEADER — Company name + tagline
    # ═══════════════════════════════════════════
    story.append(Spacer(1, 1 * mm))
    story.append(Paragraph(data.get("company_name", "Vision Core").upper(), styles["CompanyName"]))
    story.append(Paragraph(data.get("company_tagline", ""), styles["Tagline"]))

    # QUOTATION title
    story.append(Paragraph("QUOTATION", styles["DocTitle"]))

    # ═══════════════════════════════════════════
    # QUOTE META — clean row with separator dots
    # ═══════════════════════════════════════════
    def meta_pair(label, value, w):
        t = Table([
            [Paragraph(label.upper(), styles["MetaLabel"])],
            [Paragraph(str(value), styles["MetaValue"])],
        ], colWidths=[w])
        t.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
        return t

    meta_row = Table([[
        meta_pair("Quotation No.", data.get("quotation_no", ""), 38 * mm),
        meta_pair("Date", data.get("issue_date", ""), 32 * mm),
        meta_pair("Valid Until", data.get("valid_until", ""), 32 * mm),
        meta_pair("Type", data.get("quote_type", ""), 30 * mm),
        meta_pair("Terms", data.get("payment_terms", ""), 30 * mm),
    ]], colWidths=[38 * mm, 32 * mm, 32 * mm, 30 * mm, 30 * mm])
    meta_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 4)]))
    story.append(meta_row)
    story.append(Spacer(1, 5 * mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=CLR_LIGHT))
    story.append(Spacer(1, 5 * mm))

    # ═══════════════════════════════════════════
    # FROM / TO — two columns
    # ═══════════════════════════════════════════
    from_lines = [v for v in [data.get("company_address"), data.get("company_email"), data.get("company_phone")] if v]
    to_lines = [v for v in [data.get("client_address"), data.get("client_email"), data.get("client_phone")] if v]

    def addr_block(label, name, attn, details):
        rows = [
            [Paragraph(label.upper(), styles["MetaLabel"])],
            [Paragraph(name, styles["BodyBold"])],
        ]
        if attn:
            rows.append([Paragraph(attn, styles["BodyText"])])
        if details:
            rows.append([Paragraph("<br/>".join(details), styles["Small"])])
        t = Table(rows, colWidths=[82 * mm])
        t.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
        return t

    addr_row = Table([[
        addr_block("From", data.get("company_name", ""), "", from_lines),
        addr_block("To", data.get("client_company", ""), f"Attn: {data.get('client_pic', '')}" if data.get("client_pic") else "", to_lines),
    ]], colWidths=[87 * mm, 87 * mm])
    addr_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(addr_row)
    story.append(Spacer(1, 6 * mm))

    # ═══════════════════════════════════════════
    # LINE ITEMS — clean black header
    # ═══════════════════════════════════════════
    hdr_s = lambda n, a=TA_LEFT: ParagraphStyle(name=n, fontName="Helvetica-Bold", fontSize=7, textColor=CLR_WHITE, alignment=a, leading=9)
    cell_s = lambda n, a=TA_LEFT, b=False: ParagraphStyle(name=n, fontName="Helvetica-Bold" if b else "Helvetica", fontSize=8, textColor=CLR_TEXT, alignment=a, leading=12)

    header = [
        Paragraph("DESCRIPTION", hdr_s("H1")),
        Paragraph("QTY", hdr_s("H2", TA_CENTER)),
        Paragraph("AMOUNT (RM)", hdr_s("H3", TA_RIGHT)),
    ]
    table_data = [header]
    items = data.get("line_items", [])

    for i, item in enumerate(items, 1):
        qty = item.get("qty", 1)
        up = item.get("unit_price", 0)
        sub = qty * up
        desc = item.get("description", "")
        table_data.append([
            Paragraph(desc, cell_s(f"C{i}1")),
            Paragraph(str(qty), cell_s(f"C{i}2", TA_CENTER)),
            Paragraph(f"{sub:,.2f}", cell_s(f"C{i}3", TA_RIGHT, True)),
        ])

    col_widths = [112 * mm, 18 * mm, 34 * mm]
    lt = Table(table_data, colWidths=col_widths, repeatRows=1)
    style_cmds = [
        # Black header bar
        ("BACKGROUND", (0, 0), (-1, 0), CLR_BLACK),
        ("TEXTCOLOR", (0, 0), (-1, 0), CLR_WHITE),
        ("TOPPADDING", (0, 0), (-1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("LEFTPADDING", (0, 0), (-1, 0), 8),
        ("RIGHTPADDING", (0, 0), (-1, 0), 8),
        # Data rows
        ("TOPPADDING", (0, 1), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 7),
        ("LEFTPADDING", (0, 1), (-1, -1), 8),
        ("RIGHTPADDING", (0, 1), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]
    # Light separator lines between rows
    for i in range(1, len(table_data)):
        style_cmds.append(("LINEBELOW", (0, i), (-1, i), 0.5, CLR_LIGHT))
    # Alternating row backgrounds
    for i in range(2, len(table_data), 2):
        style_cmds.append(("BACKGROUND", (0, i), (-1, i), CLR_BG))
    lt.setStyle(TableStyle(style_cmds))
    story.append(lt)
    story.append(Spacer(1, 4 * mm))

    # ═══════════════════════════════════════════
    # TOTALS — right-aligned
    # ═══════════════════════════════════════════
    subtotal = sum(item.get("qty", 1) * item.get("unit_price", 0) for item in items)
    tax_rate = data.get("tax_rate", 0)
    tax_amount = subtotal * (tax_rate / 100) if tax_rate else 0
    total = subtotal + tax_amount
    payment_terms = data.get("payment_terms", "Full Upfront")

    def tot_row(label, value, highlight=False, bold=False):
        tc = CLR_WHITE if highlight else (CLR_BLACK if bold else CLR_TEXT)
        lbl_s = ParagraphStyle(name=f"TL_{label[:5]}", fontName="Helvetica-Bold" if (bold or highlight) else "Helvetica", fontSize=8.5 if highlight else 8, textColor=tc, alignment=TA_RIGHT)
        val_s = ParagraphStyle(name=f"TV_{label[:5]}", fontName="Helvetica-Bold", fontSize=9.5 if highlight else 8, textColor=tc, alignment=TA_RIGHT)
        return [Paragraph(label, lbl_s), Paragraph(f"RM {value:,.2f}", val_s)]

    totals_rows = [tot_row("SUBTOTAL", subtotal)]
    if tax_rate:
        totals_rows.append(tot_row("TAX", tax_amount))
    totals_rows.append(tot_row("TOTAL", total, highlight=True))
    if "50%" in payment_terms.lower() or "50-50" in payment_terms.lower():
        totals_rows.append(tot_row("DEPOSIT (50%)", total * 0.5, bold=True))

    totals_tbl = Table(totals_rows, colWidths=[30 * mm, 38 * mm])
    tot_style = [
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]
    # Black background on TOTAL row
    total_idx = 2 if tax_rate else 1
    tot_style.append(("BACKGROUND", (0, total_idx), (-1, total_idx), CLR_BLACK))
    tot_style.append(("TEXTCOLOR", (0, total_idx), (-1, total_idx), CLR_WHITE))
    # Top border on totals
    tot_style.append(("LINEABOVE", (0, 0), (-1, 0), 0.5, CLR_LIGHT))
    totals_tbl.setStyle(TableStyle(tot_style))

    wrapper = Table([["", totals_tbl]], colWidths=[W - 68 * mm, 68 * mm])
    wrapper.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(wrapper)
    story.append(Spacer(1, 8 * mm))

    # ═══════════════════════════════════════════
    # BANK + TERMS — side by side
    # ═══════════════════════════════════════════
    bank = data.get("bank_details", {})
    bank_rows = []
    if bank:
        bank_rows.append([Paragraph("PAYMENT METHOD", ParagraphStyle(name="PMH", fontName="Helvetica-Bold", fontSize=7.5, textColor=CLR_BLACK, leading=11))])
        bank_lines = []
        pm = bank.get("payment_method", "Bank Transfer")
        bank_lines.append(pm)
        if bank.get("account_name"):
            bank_lines.append(f"{bank['account_name']}")
        if bank.get("bank_name"):
            bank_lines.append(f"{bank['bank_name']}")
        if bank.get("account_number"):
            bank_lines.append(f"{bank['account_number']}")
        bank_rows.append([Paragraph("<br/>".join(bank_lines), styles["Small"])])

    bank_cell = Table(bank_rows, colWidths=[78 * mm]) if bank_rows else Paragraph("", styles["BodyText"])
    if bank_rows:
        bank_cell.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))

    terms_rows = [[Paragraph("TERMS & CONDITIONS", ParagraphStyle(name="TCH", fontName="Helvetica-Bold", fontSize=7.5, textColor=CLR_BLACK, leading=11))]]
    for i, term in enumerate(data.get("terms", TERMS), 1):
        terms_rows.append([Paragraph(f"{i}. {term}", styles["Small"])])

    terms_cell = Table(terms_rows, colWidths=[88 * mm])
    terms_cell.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))

    bottom_row = Table([[bank_cell, terms_cell]], colWidths=[80 * mm, 90 * mm])
    bottom_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(bottom_row)
    story.append(Spacer(1, 8 * mm))

    # ═══════════════════════════════════════════
    # SIGNATURE — two columns
    # ═══════════════════════════════════════════
    sig_data = [
        [Paragraph("PREPARED BY", styles["MetaLabel"]), Paragraph("ACCEPTED BY", styles["MetaLabel"])],
        [Paragraph(data.get("prepared_by", "builtbykai"), styles["BodyBold"]), Paragraph("", styles["BodyText"])],
        [Spacer(1, 12 * mm), Spacer(1, 12 * mm)],
        [HRFlowable(width="50%", thickness=0.5, color=CLR_MUTED), HRFlowable(width="50%", thickness=0.5, color=CLR_MUTED)],
        [Paragraph("Signature / Date", styles["Small"]), Paragraph("Signature / Date", styles["Small"])],
    ]
    st = Table(sig_data, colWidths=[87 * mm, 87 * mm])
    st.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(st)

    # Build with custom page background
    doc.build(story, onFirstPage=_draw_page_bg, onLaterPages=_draw_page_bg)
    buffer.seek(0)
    return buffer


# ═══════════════════════════════════════════════════════════════
# VERCEL BLOB UPLOAD
# ═══════════════════════════════════════════════════════════════

def upload_to_blob(pdf_buffer, filename):
    """Upload PDF to Vercel Blob Storage, returns public URL."""
    r = http_requests.put(
        f"https://blob.vercel-storage.com/{filename}",
        headers={
            "Authorization": f"Bearer {BLOB_READ_WRITE_TOKEN}",
            "Content-Type": "application/pdf",
            "x-api-version": "7",
        },
        data=pdf_buffer.read(),
    )
    r.raise_for_status()
    return r.json().get("url", "")


# ═══════════════════════════════════════════════════════════════
# UPDATE NOTION PAGE WITH PDF LINK
# ═══════════════════════════════════════════════════════════════

def update_notion_page(page_id, pdf_url, total_amount):
    """Write the PDF URL and computed Amount back to the Notion quotation page."""
    notion_patch(f"/pages/{page_id}", {
        "properties": {
            "PDF": {"url": pdf_url},
            "Amount": {"number": total_amount},
        }
    })


# ═══════════════════════════════════════════════════════════════
# VERCEL HANDLER
# ═══════════════════════════════════════════════════════════════

class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        """Handle POST webhook from Notion button."""
        try:
            # Optional: verify webhook secret
            if WEBHOOK_SECRET:
                auth = self.headers.get("Authorization", "")
                if auth != f"Bearer {WEBHOOK_SECRET}":
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b'{"error": "Unauthorized"}')
                    return

            # Parse body
            content_length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(content_length) if content_length else b"{}"
            body = json.loads(raw)
            print(f"Webhook payload: {json.dumps(body)[:500]}", file=sys.stderr)

            # Extract page_id
            page_id = extract_page_id(body)
            print(f"Generating PDF for page: {page_id}", file=sys.stderr)

            # Fetch data from Notion
            data = fetch_quotation_data(page_id)
            print(f"Quotation: {data['quotation_no']} for {data['client_company']}", file=sys.stderr)

            # Generate PDF
            pdf_buffer = generate_pdf(data)

            # Upload to Vercel Blob
            safe_name = data["quotation_no"].replace(" ", "-").replace("/", "-")
            filename = f"quotations/{safe_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
            pdf_url = upload_to_blob(pdf_buffer, filename)
            print(f"PDF uploaded: {pdf_url}", file=sys.stderr)

            # Compute total from line items
            items = data.get("line_items", [])
            total_amount = sum(
                item.get("qty", 1) * item.get("unit_price", 0) for item in items
            )

            # Write PDF URL + Amount back to Notion page
            update_notion_page(page_id, pdf_url, total_amount)
            print(f"Notion page updated — PDF link + Amount: {total_amount}", file=sys.stderr)

            # Respond
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "success",
                "quotation_no": data["quotation_no"],
                "pdf_url": pdf_url,
            }).encode())

        except ValueError as e:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_GET(self):
        """Health check endpoint."""
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({
            "service": "Vision Core Quotation PDF Generator",
            "status": "ready",
            "usage": "POST /api/generate with { data: { page_id: '...' } }",
        }).encode())
