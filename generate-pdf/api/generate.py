"""generate.py — Unified PDF Generator
Routes on URL path — Notion buttons unchanged.
"""

from datetime import datetime
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler
from io import BytesIO
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle,
    Paragraph, Spacer, HRFlowable
)
import json
import os
import re
import requests
import sys


# ═══════════════════════════════════
#  QUOTATION PDF
# ═══════════════════════════════════

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
QUOTATIONS_DB          = "f8167f0bda054307b90b17ad6b9c5cf8"

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


def _fmt_address(addr):
    """Format a long address string into 2-3 tidy lines for the PDF."""
    if not addr:
        return ""
    import re
    # Already has real newlines — honour them
    if "\n" in addr:
        return addr.replace("\n", "<br/>")
    # Split before postcode (5-digit MY code) e.g. "..., 50450 KL..."
    addr = re.sub(r",\s*(\d{5}\b)", r"<br/>\1", addr, count=1)
    # If still one long line, split after the 2nd comma segment
    if "<br/>" not in addr:
        parts = [p.strip() for p in addr.split(",")]
        if len(parts) >= 4:
            mid = len(parts) // 2
            addr = ", ".join(parts[:mid]) + "<br/>" + ", ".join(parts[mid:])
    return addr


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
    company_name = company_address = company_phone = ""
    for rel in props.get("Company", {}).get("relation", [])[:1]:
        try:
            cr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=hdrs, timeout=10)
            cr.raise_for_status()
            cp = cr.json().get("properties", {})
            # Title field — try all known names including "Company"
            for k in ["Company", "Name", "Company Name", "name"]:
                if cp.get(k, {}).get("type") == "title":
                    company_name = _plain(cp[k]["title"]); break
            for k in ["Address", "Company Address", "Billing Address", "Mailing Address", "address"]:
                prop = cp.get(k, {})
                if prop.get("type") == "rich_text":
                    v = _plain(prop.get("rich_text", []))
                    if v: company_address = v; break
                elif prop.get("type") == "title":
                    v = _plain(prop.get("title", []))
                    if v: company_address = v; break
            for k in ["Phone", "Phone Number", "Contact Number", "Tel", "Mobile"]:
                prop = cp.get(k, {})
                if prop.get("type") == "phone_number":
                    v = prop.get("phone_number") or ""
                    if v: company_phone = v; break
                elif prop.get("type") == "rich_text":
                    v = _plain(prop.get("rich_text", []))
                    if v: company_phone = v; break
        except Exception as e:
            print(f"[WARN] company: {e}", file=sys.stderr)

    # PIC — priority order:
    #   1. Quotation.PIC rollup if it returns relation page IDs
    #   2. Company.People relation (Current PIC? preferred) ← most reliable
    #   3. Company.People relation (any first person)
    pic_name = pic_email = pic_phone = ""
    pic_page_ids = []

    pic_prop = props.get("PIC", {})
    if pic_prop.get("type") == "rollup":
        for item in pic_prop.get("rollup", {}).get("array", []):
            if item.get("type") == "relation":
                pic_page_ids = [r2["id"] for r2 in item.get("relation", [])]; break
    elif pic_prop.get("type") == "relation":
        pic_page_ids = [rel["id"] for rel in pic_prop.get("relation", [])]

    # Fallback: pull PIC directly from Company.People relation
    if not pic_page_ids:
        for rel in props.get("Company", {}).get("relation", [])[:1]:
            try:
                cr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                                  headers=hdrs, timeout=10)
                cr.raise_for_status()
                cp_people = cr.json().get("properties", {})
                people_rels = (cp_people.get("People", {}).get("relation", [])
                               or cp_people.get("Clients", {}).get("relation", [])
                               or cp_people.get("Contacts", {}).get("relation", []))
                # Prefer Current PIC? = True; fall back to first person
                pic_candidates = []
                for person_rel in people_rels:
                    try:
                        pr2 = requests.get(f"https://api.notion.com/v1/pages/{person_rel['id']}",
                                           headers=hdrs, timeout=10)
                        pr2.raise_for_status()
                        pp2 = pr2.json().get("properties", {})
                        is_pic = pp2.get("Current PIC?", {}).get("checkbox", False)
                        pic_candidates.append((is_pic, person_rel["id"]))
                    except Exception:
                        pass
                # Sort: Current PIC first
                pic_candidates.sort(key=lambda x: x[0], reverse=True)
                if pic_candidates:
                    pic_page_ids = [pic_candidates[0][1]]
            except Exception as e:
                print(f"[WARN] Company PIC fallback: {e}", file=sys.stderr)

    for pid in pic_page_ids[:1]:
        try:
            pr = requests.get(f"https://api.notion.com/v1/pages/{pid}",
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
            print(f"[WARN] PIC fetch: {e}", file=sys.stderr)

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

                    item["qty"] = rp.get("Qty", {}).get("number") or 1

                    # Catalog Price — rollup from Products (the "list price")
                    cp_prop = rp.get("Catalog Price", {})
                    catalog_price = 0
                    if cp_prop.get("type") == "rollup":
                        rl = cp_prop.get("rollup", {})
                        catalog_price = (rl.get("number") or
                                         next((a.get("number", 0) for a in rl.get("array", [])
                                               if a.get("type") == "number"), 0))
                    elif cp_prop.get("type") == "number":
                        catalog_price = cp_prop.get("number") or 0

                    # Unit Price — manual discount override; fall back to Catalog Price
                    manual_price = rp.get("Unit Price", {}).get("number") or 0
                    item["catalog_price"] = catalog_price
                    item["unit_price"]    = manual_price if manual_price > 0 else catalog_price
                    item["is_discounted"] = (manual_price > 0 and manual_price != catalog_price)

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
        "company_phone":   company_phone,
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
    if data.get("company_address"):
        story.append(Paragraph(
            _fmt_address(data["company_address"]),
            st("adr", fontSize=9, textColor=C_D500, leading=13)
        ))
    if data.get("company_phone"):
        story.append(Paragraph(
            data["company_phone"],
            st("cph", fontSize=9, textColor=C_D500, leading=13)
        ))
    if data.get("pic_name"):
        attn = f"Attn: {data['pic_name']}"
        if data.get("pic_email"):
            attn += f"  ·  {data['pic_email']}"
        story.append(Paragraph(
            attn,
            st("pic", fontSize=9, textColor=C_D600, leading=13)
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
        qty            = float(item.get("qty", 1))
        price          = float(item.get("unit_price", 0))
        catalog_price  = float(item.get("catalog_price", 0))
        is_discounted  = item.get("is_discounted", False)
        amt            = qty * price
        total         += amt

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

        # Unit price cell — show strikethrough catalog price + discounted price if applicable
        s_strike = st("stk", fontSize=8, textColor=C_D400, alignment=2)
        if is_discounted and catalog_price > 0:
            price_cell = Table([
                [Paragraph(f"<strike>RM {catalog_price:,.2f}</strike>", s_strike)],
                [Paragraph(f"RM {price:,.2f}", s_num)],
            ], colWidths=[cw[2] - 16],
               style=TableStyle([("PADDING",(0,0),(-1,-1),0),("VALIGN",(0,0),(-1,-1),"TOP")]))
        else:
            price_cell = Paragraph(f"RM {price:,.2f}", s_num)

        rows.append([
            desc_cell,
            Paragraph(f"{qty:g}", s_numc),
            price_cell,
            Paragraph(f"RM {amt:,.2f}", s_num),
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
        Paragraph("<b>Total Quote</b>",
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
def void_linked_invoices(page_id, hdrs):
    """
    If the quotation already has invoices linked, void them.
    Called before regenerating the PDF so stale invoices don't survive a re-draft.
    """
    try:
        qr = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                          headers=hdrs, timeout=10)
        qr.raise_for_status()
        inv_rels = qr.json().get("properties", {}).get("Invoice", {}).get("relation", [])
        for rel in inv_rels:
            inv_id = rel["id"].replace("-", "")
            # Only void Draft or Deposit Pending invoices — don't touch paid ones
            ip = requests.get(f"https://api.notion.com/v1/pages/{inv_id}",
                              headers=hdrs, timeout=10).json()
            inv_status = (ip.get("properties", {}).get("Status", {}).get("select") or {}).get("name", "")
            if inv_status in ("Draft", "Deposit Pending"):
                requests.patch(
                    f"https://api.notion.com/v1/pages/{inv_id}",
                    headers=hdrs,
                    json={"properties": {"Status": {"select": {"name": "Voided"}}}},
                    timeout=10,
                )
                print(f"[INFO] Voided invoice {inv_id[:8]} (was {inv_status})", file=sys.stderr)
            else:
                print(f"[INFO] Skipped invoice {inv_id[:8]} — status {inv_status!r} (not voidable)", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] void_linked_invoices: {e}", file=sys.stderr)


def update_notion_page(page_id, pdf_url, total_amount, quotation_no=None, title_prop_name=None):
    api_key = os.environ.get("NOTION_API_KEY")
    if not api_key:
        raise ValueError("NOTION_API_KEY not set")
    hdrs = {
        "Authorization":  f"Bearer {api_key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }
    from datetime import date as _date
    today = _date.today().isoformat()

    # Reset to Draft + refresh Issue Date + write PDF URL + update Amount
    payload = {
        "properties": {
            "PDF":        {"url": pdf_url},
            "Status":     {"select": {"name": "Draft"}},
            "Issue Date": {"date": {"start": today}},
        }
    }
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
    print(f"[INFO] Quotation reset to Draft, Issue Date → {today}", file=sys.stderr)


# ─────────────────────────────────────────────
#  Vercel handler
# ─────────────────────────────────────────────


# ═══════════════════════════════════
#  INVOICE PDF
# ═══════════════════════════════════

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

# ─────────────────────────────────────────────
#  Config
# ─────────────────────────────────────────────
VISION_CORE_DETAILS_DB = "33c8b289e31a80b1aa85fc1921cc0adc"
IMPL_FORM_BASE = "https://vision-core-delta.vercel.app/api/implementation_form"

QUO_PATTERN = re.compile(r"^QUO-(\d{4})-(\d{4})$")
INV_PATTERN = re.compile(r"^INV-\d{4}-\d{4}(-[DSFR])?$")

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


def format_invoice_number(quotation_no, invoice_type, issue_date):
    """
    Derive invoice number from quotation number.
    QUO-2026-0001 + Deposit  →  INV-2026-0001-D
    QUO-2026-0001 + Final    →  INV-2026-0001-F
    QUO-2026-0001 + Full     →  INV-2026-0001
    QUO-2026-0001 + Retainer →  INV-2026-0001-R
    Falls back to INV-YYYY-XXXX (timestamp-based) if no quotation link.
    """
    suffix = INV_SUFFIX.get(invoice_type, "")
    m = QUO_PATTERN.match(quotation_no or "")
    if m:
        return f"INV-{m.group(1)}-{m.group(2)}{suffix}"

    # No linked quotation — use current year + timestamp as fallback
    year = datetime.now().year
    if issue_date:
        try:
            year = datetime.fromisoformat(issue_date).year
        except Exception:
            pass
    ts = datetime.now().strftime("%H%M")   # e.g. 1432 — unique enough within a day
    return f"INV-{year}-{ts}{suffix}"


def assign_invoice_number(page_id, current_no, quotation_no, invoice_type, issue_date, hdrs):
    """If invoice title isn't already formatted, assign the derived number."""
    if INV_PATTERN.match(current_no or ""):
        return current_no   # already formatted

    new_no = format_invoice_number(quotation_no, invoice_type, issue_date)
    try:
        requests.patch(
            f"https://api.notion.com/v1/pages/{page_id}",
            headers=hdrs,
            json={"properties": {
                "Invoice No.": {"title": [{"text": {"content": new_no}}]}
            }},
            timeout=10
        ).raise_for_status()
        print(f"[INFO] Invoice numbered: {new_no}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] Could not update invoice title: {e}", file=sys.stderr)
    return new_no


# ─────────────────────────────────────────────
#  1. Fetch invoice + linked quotation data
# ─────────────────────────────────────────────
def fetch_invoice_data(page_id, hdrs):
    """Fetch invoice page then enrich with Quotation line items."""
    resp = requests.get(
        f"https://api.notion.com/v1/pages/{page_id}", headers=hdrs, timeout=15
    )
    if not resp.ok:
        raise ValueError(f"Notion GET /pages/{page_id} returned {resp.status_code}: {resp.text[:300]}")
    props = resp.json().get("properties", {})

    invoice_no    = _plain(props.get("Invoice No.", {}).get("title", []))
    issue_date    = (props.get("Issue Date", {}).get("date") or {}).get("start", "")
    invoice_type  = (props.get("Invoice Type", {}).get("select") or {}).get("name", "")
    status        = (props.get("Status", {}).get("select") or {}).get("name", "")
    total_amount  = props.get("Total Amount", {}).get("number") or 0
    deposit_paid     = props.get("Deposit (50%)", {}).get("number") or 0
    payment_balance  = props.get("Final Payment", {}).get("number") or 0

    # Due date: use Deposit Due for Deposit invoices, else Balance Due
    dep_date = (props.get("Deposit Due", {}).get("date") or {}).get("start", "")
    bal_date = (props.get("Final Payment Due", {}).get("date") or {}).get("start", "")
    due_date = dep_date if invoice_type == "Deposit" else (bal_date or dep_date)

    # ── Company (billing client) ──
    company_name = company_address = company_id = company_phone = ""
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
            for k in ["Phone", "Phone Number", "Contact Number", "Tel", "Mobile"]:
                prop = cp.get(k, {})
                if prop.get("type") == "phone_number":
                    company_phone = prop.get("phone_number") or ""; break
                if prop.get("type") == "rich_text":
                    company_phone = _plain(prop.get("rich_text", [])); break
        except Exception as e:
            print(f"[WARN] company: {e}", file=sys.stderr)

    # ── PIC (rollup of Primary Contact relation, or direct relation) ──
    pic_name = pic_email = pic_phone = ""
    pic_prop = props.get("PIC", {})
    pic_page_ids = []
    if pic_prop.get("type") == "rollup":
        for item in pic_prop.get("rollup", {}).get("array", []):
            t = item.get("type", "")
            if t == "relation":
                pic_page_ids = [r["id"] for r in item.get("relation", [])]
                break
            if t == "title":
                pic_name = _plain(item.get("title", [])); break
            if t == "rich_text":
                pic_name = _plain(item.get("rich_text", [])); break
    elif pic_prop.get("type") == "relation":
        pic_page_ids = [r["id"] for r in pic_prop.get("relation", [])]

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
            for k in ["Phone", "Phone Number", "Mobile", "Tel"]:
                prop = pp.get(k, {})
                if prop.get("type") == "phone_number":
                    pic_phone = prop.get("phone_number") or ""; break
                if prop.get("type") == "rich_text":
                    pic_phone = _plain(prop.get("rich_text", [])); break
        except Exception as e:
            print(f"[WARN] PIC fetch: {e}", file=sys.stderr)

    # ── Quotation: pull line items + package type + quotation number ──
    line_items = []
    pkg_slug = ""
    quotation_no = ""
    for rel in props.get("Quotation", {}).get("relation", [])[:1]:
        try:
            qid = rel["id"].replace("-", "")
            qr = requests.get(f"https://api.notion.com/v1/pages/{qid}",
                              headers=hdrs, timeout=10)
            qr.raise_for_status()
            qprops = qr.json().get("properties", {})

            # Quotation number for deriving invoice number
            quotation_no = _plain(qprops.get("Quotation No.", {}).get("title", []))

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

    # Auto-assign formatted invoice number if not already set
    invoice_no = assign_invoice_number(
        page_id, invoice_no, quotation_no, invoice_type, issue_date, hdrs
    )

    return {
        "invoice_no":       invoice_no or "INV",
        "issue_date":       issue_date,
        "due_date":         due_date,
        "invoice_type":     invoice_type,
        "status":           status,
        "total_amount":     total_amount,
        "deposit_paid":     deposit_paid,
        "payment_balance":  payment_balance,
        "company_name":     company_name,
        "company_address":  company_address,
        "company_phone":    company_phone,
        "company_id":       company_id,
        "pic_name":         pic_name,
        "pic_email":        pic_email,
        "pic_phone":        pic_phone,
        "line_items":       line_items,
        "pkg_slug":         pkg_slug,
        "our_company":      fetch_company_details(hdrs),
    }


# ─────────────────────────────────────────────
#  1b. Activate Invoice: set Issue Date + Payment Balance (status depends on type)
# ─────────────────────────────────────────────
def activate_invoice(page_id, total_amount, deposit_paid, invoice_type, hdrs):
    """
    Called when Generate Invoice PDF button is clicked.
    - Deposit invoice   → Status: Deposit Pending
    - Final invoice     → Status: Balance Pending (keep as-is, already set)
    - Issue Date: today (only if not already set)
    - Payment Balance: total - deposit
    """
    today = __import__("datetime").datetime.now().date().isoformat()

    pay_balance = round(total_amount - deposit_paid, 2) if deposit_paid > 0 else total_amount

    # Only update status for Deposit invoices — Final invoices are already Balance Pending
    if invoice_type == "Final Payment":
        status_prop = {}
    else:
        status_prop = {"Status": {"select": {"name": "Deposit Pending"}}}

    payload = {
        "properties": {
            **status_prop,
            "Issue Date":       {"date":   {"start": today}},
            "Final Payment":  {"number": pay_balance},
        }
    }
    r = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json=payload, timeout=10
    )
    if not r.ok:
        print(f"[WARN] activate_invoice PATCH {r.status_code}: {r.text[:400]}", file=sys.stderr)
        # Non-fatal — continue even if status update fails
    return today


# ─────────────────────────────────────────────
#  2. Generate Invoice PDF
# ─────────────────────────────────────────────
def generate_invoice_pdf(data):
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
    if data.get("company_address"):
        story.append(Paragraph(
            _fmt_address(data["company_address"]),
            st("adr", fontSize=9, textColor=C_D500, leading=13)
        ))
    if data.get("company_phone"):
        story.append(Paragraph(
            data["company_phone"],
            st("cph", fontSize=9, textColor=C_D500, leading=13)
        ))
    if data.get("pic_name"):
        attn = f"Attn: {data['pic_name']}"
        if data.get("pic_email"):
            attn += f"  ·  {data['pic_email']}"
        story.append(Paragraph(
            attn,
            st("pic", fontSize=9, textColor=C_D600, leading=13)
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
        ("TOPPADDING",    (0,0),(-1,-1),        5),
        ("BOTTOMPADDING", (0,0),(-1,-1),        5),
        ("LEFTPADDING",   (0,0),(-1,-1),        4),
        ("RIGHTPADDING",  (0,0),(-1,-1),        4),
        ("VALIGN",        (0,0),(-1,-1),        "MIDDLE"),
        ("BACKGROUND",    (0,n_tot),(-1,n_tot), C_D50),
        ("LINEABOVE",     (0,n_tot),(-1,n_tot), 1, C_BLACK),
        ("LINEBELOW",     (0,n_tot),(-1,n_tot), 1, C_BLACK),
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
def update_notion_invoice(page_id, pdf_url, amount_due, intake_url, hdrs):
    payload = {"properties": {}}

    # Only write the PDF URL — Amount is set at creation time and should not be overwritten
    if pdf_url:
        payload["properties"]["Invoice PDF"] = {"url": pdf_url}

    # Only write Intake Form URL if the property exists in the DB schema
    if intake_url:
        try:
            db_r = requests.get(
                "https://api.notion.com/v1/databases/9227dda9c4be42a1a4c6b1bce4862f8c",
                headers=hdrs, timeout=10
            )
            if db_r.ok and "Intake Form URL" in db_r.json().get("properties", {}):
                payload["properties"]["Intake Form URL"] = {"url": intake_url}
            else:
                print(f"[INFO] Skipping 'Intake Form URL' — not in Invoice DB schema", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] Could not check DB schema for Intake Form URL: {e}", file=sys.stderr)

    if not payload["properties"]:
        print(f"[WARN] Nothing to write back to Notion invoice page", file=sys.stderr)
        return

    r = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json=payload, timeout=10,
    )
    if not r.ok:
        raise ValueError(f"Notion PATCH invoice page {r.status_code}: {r.text[:300]}")


# ─────────────────────────────────────────────
#  Vercel handler
# ─────────────────────────────────────────────


# ═══════════════════════════════════
#  RECEIPT PDF
# ═══════════════════════════════════

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
def generate_receipt_pdf(receipt_no, data):
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
    dep_inv_no  = data.get("deposit_inv_no", "")
    cur_inv_no  = data.get("invoice_no") or "—"
    if dep_inv_no and dep_inv_no != cur_inv_no:
        inv_ref_display = f"{dep_inv_no} / {cur_inv_no}"
    else:
        inv_ref_display = cur_inv_no
    meta = Table([[
        _mcell("RECEIPT NO.", receipt_no),
        _mcell("DATE",        pay_date_display),
        _mcell("INVOICE REF", inv_ref_display),
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
    if data.get("company_address"):
        rf_rows.append([Paragraph(data["company_address"],
                                  st("addr", fontSize=9, textColor=C_D500, leading=12))])
    if data.get("company_phone"):
        rf_rows.append([Paragraph(data["company_phone"],
                                  st("cph", fontSize=9, textColor=C_D500, leading=12))])
    if data.get("pic_name"):
        attn = f"Attn: {data['pic_name']}"
        if data.get("pic_email"):
            attn += f"  ·  {data['pic_email']}"
        rf_rows.append([Paragraph(attn, st("pic", fontSize=9, textColor=C_D600, leading=12))])
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
         Paragraph(f"Invoice {inv_ref_display} — {inv_type}",
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
        Paragraph("AMOUNT RECEIVED",
                  st("al", fontSize=8, textColor=C_D400, alignment=0, leading=11)),
        Paragraph(f"RM {amount_paid:,.2f}",
                  ParagraphStyle("av", parent=styles["Normal"],
                                 fontName="Helvetica-Bold", fontSize=20,
                                 textColor=C_BLACK, alignment=2, leading=24)),
    ]], colWidths=[usable * 0.40, usable * 0.60])
    amt_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,-1), C_D50),
        ("LINEABOVE",     (0,0),(-1,0),  2, C_BLACK),
        ("LINEBELOW",     (0,0),(-1,0),  2, C_BLACK),
        ("LEFTPADDING",   (0,0),(0,0),   14),
        ("RIGHTPADDING",  (0,0),(0,0),   6),
        ("LEFTPADDING",   (1,0),(1,0),   6),
        ("RIGHTPADDING",  (1,0),(1,0),   14),
        ("TOPPADDING",    (0,0),(-1,-1), 13),
        ("BOTTOMPADDING", (0,0),(-1,-1), 13),
        ("VALIGN",        (0,0),(-1,-1), "MIDDLE"),
        ("ALIGN",         (1,0),(1,0),   "RIGHT"),
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


# ═══════════════════════════════════
#  UNIFIED HANDLER
# ═══════════════════════════════════

class handler(BaseHTTPRequestHandler):

    def _respond(self, code, body_dict):
        body = json.dumps(body_dict).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _doc_type(self):
        path = self.path.split("?")[0]
        if "receipt" in path:  return "receipt"
        if "invoice" in path:  return "invoice"
        return "quotation"

    def _parse_page_id(self, body):
        page_id = None
        if "source" in body:
            page_id = body["source"].get("page_id") or body["source"].get("id")
        if not page_id and "data" in body:
            page_id = body["data"].get("page_id") or body["data"].get("id")
        if not page_id:
            page_id = body.get("page_id") or body.get("id")
        return page_id.replace("-", "") if page_id else None

    def do_GET(self):
        doc_type = self._doc_type()
        if doc_type == "invoice":
            from urllib.parse import parse_qs, urlparse
            qs = parse_qs(urlparse(self.path).query)
            api_key = os.environ.get("NOTION_API_KEY", "")
            INVOICE_DB = "9227dda9c4be42a1a4c6b1bce4862f8c"
            hdrs = {"Authorization": "Bearer " + api_key, "Notion-Version": "2022-06-28", "Content-Type": "application/json"}
            if "schema" in qs:
                pid = (qs.get("page_id") or [None])[0]
                try:
                    if pid:
                        r = requests.get("https://api.notion.com/v1/pages/" + pid.replace("-",""), headers=hdrs, timeout=15)
                        r.raise_for_status()
                        props = r.json().get("properties", {})
                        schema = {k: v.get("type") for k, v in props.items()}
                        db_id = (r.json().get("parent") or {}).get("database_id","").replace("-","")
                        db_schema = {}
                        if db_id:
                            dr = requests.get("https://api.notion.com/v1/databases/" + db_id, headers=hdrs, timeout=10)
                            if dr.ok:
                                db_schema = {k: v.get("type") for k, v in dr.json().get("properties",{}).items()}
                        self._respond(200, {"page_properties": schema, "db_schema": db_schema}); return
                    dr = requests.get("https://api.notion.com/v1/databases/" + INVOICE_DB, headers=hdrs, timeout=10)
                    dr.raise_for_status()
                    self._respond(200, {k: v.get("type") for k,v in dr.json().get("properties",{}).items()}); return
                except Exception as e:
                    self._respond(500, {"error": str(e)}); return
            if "test" in qs:
                pid = (qs.get("page_id") or [None])[0]
                if not pid:
                    self._respond(400, {"error": "Missing page_id"}); return
                try:
                    raw = requests.get("https://api.notion.com/v1/pages/" + pid.replace("-",""), headers=hdrs, timeout=15)
                    if not raw.ok:
                        self._respond(500, {"status": raw.status_code, "body": raw.text[:500]}); return
                    props = raw.json().get("properties", {})
                    self._respond(200, {
                        "page_id":      pid,
                        "properties":   {k: v.get("type") for k,v in props.items()},
                        "invoice_type": (props.get("Invoice Type",{}).get("select") or {}).get("name",""),
                        "status":       (props.get("Status",{}).get("select") or {}).get("name",""),
                        "total_amount": props.get("Total Amount",{}).get("number") or 0,
                    }); return
                except Exception as e:
                    self._respond(500, {"error": str(e)}); return
        labels = {"quotation":"Quotation PDF Generator","invoice":"Invoice PDF Generator","receipt":"Receipt Generator"}
        self._respond(200, {"service": "Vision Core — " + labels[doc_type], "status": "ready"})

    def do_POST(self):
        try:
            secret = os.environ.get("WEBHOOK_SECRET", "")
            if secret and self.headers.get("Authorization","") != "Bearer " + secret:
                self._respond(401, {"error": "Unauthorized"}); return

            length   = int(self.headers.get("Content-Length", 0))
            raw      = self.rfile.read(length) if length > 0 else b"{}"
            body     = json.loads(raw) if raw else {}
            doc_type = self._doc_type()
            print("[DEBUG] " + doc_type + " payload: " + json.dumps(body), file=sys.stderr)

            page_id = self._parse_page_id(body)
            if not page_id:
                self._respond(400, {"error": "No page_id found"}); return
            if not os.environ.get("NOTION_API_KEY"):
                self._respond(500, {"error": "NOTION_API_KEY not set"}); return

            if doc_type == "quotation":
                print("[INFO] Quotation PDF: " + page_id, file=sys.stderr)
                _ak = os.environ.get("NOTION_API_KEY","")
                if _ak:
                    _h = {"Authorization":"Bearer "+_ak,"Notion-Version":"2022-06-28","Content-Type":"application/json"}
                    void_linked_invoices(page_id, _h)
                data       = fetch_quotation_data(page_id)
                pdf_buffer = generate_pdf(data)
                safe       = data["quotation_no"].replace(" ","-").replace("/","-").replace("\\","-")
                pdf_url    = upload_to_blob(pdf_buffer, "quotations/" + safe + ".pdf")
                total      = sum(float(i.get("qty",1))*float(i.get("unit_price",0)) for i in data.get("line_items",[]))
                update_notion_page(page_id, pdf_url, total,
                                   quotation_no=data["quotation_no"],
                                   title_prop_name=data.get("title_prop_name"))
                self._respond(200, {"status":"success","quotation_no":data["quotation_no"],"pdf_url":pdf_url})

            elif doc_type == "invoice":
                print("[INFO] Invoice PDF: " + page_id, file=sys.stderr)
                api_key = os.environ.get("NOTION_API_KEY")
                hdrs = {"Authorization":"Bearer "+api_key,"Notion-Version":"2022-06-28","Content-Type":"application/json"}
                _pre = fetch_invoice_data(page_id, hdrs)
                activate_invoice(page_id,
                    total_amount=float(_pre.get("total_amount",0) or 0),
                    deposit_paid=float(_pre.get("deposit_paid",0) or 0),
                    invoice_type=_pre.get("invoice_type",""), hdrs=hdrs)
                data = fetch_invoice_data(page_id, hdrs)
                pdf_buffer, amount_due = generate_invoice_pdf(data)
                safe    = data["invoice_no"].replace(" ","-").replace("/","-").replace("\\","-")
                pdf_url = upload_to_blob(pdf_buffer, "invoices/" + safe + ".pdf")
                intake_url = ""
                if data.get("invoice_type") in ("Deposit","Full Payment") and data.get("company_id"):
                    slug = data.get("pkg_slug","")
                    intake_url = (IMPL_FORM_BASE+"?c="+data["company_id"]+"&pkg="+slug) if slug else (IMPL_FORM_BASE+"?c="+data["company_id"])
                update_notion_invoice(page_id, pdf_url, amount_due, intake_url, hdrs)
                result = {"status":"success","invoice_no":data["invoice_no"],"pdf_url":pdf_url,"amount_due":amount_due}
                if intake_url: result["intake_form_url"] = intake_url
                self._respond(200, result)

            elif doc_type == "receipt":
                print("[INFO] Receipt: " + page_id, file=sys.stderr)
                api_key = os.environ.get("NOTION_API_KEY")
                hdrs = {"Authorization":"Bearer "+api_key,"Notion-Version":"2022-06-28","Content-Type":"application/json"}
                data            = fetch_invoice_data(page_id, hdrs)
                year            = datetime.now().year
                receipt_no      = next_receipt_number(year, hdrs)
                receipt_page_id = create_receipt_page(page_id, receipt_no, data, hdrs)
                pdf_buffer      = generate_receipt_pdf(receipt_no, data)
                safe            = receipt_no.replace(" ","-")
                pdf_url         = upload_to_blob(pdf_buffer, "receipts/" + safe + ".pdf")
                requests.patch("https://api.notion.com/v1/pages/"+receipt_page_id,
                               headers=hdrs, json={"properties":{"PDF":{"url":pdf_url}}}, timeout=10).raise_for_status()
                try:
                    requests.patch("https://api.notion.com/v1/pages/"+page_id,
                                   headers=hdrs, json={"properties":{"Receipt":{"url":pdf_url}}}, timeout=10)
                except Exception as e:
                    print("[WARN] Receipt write-back: " + str(e), file=sys.stderr)
                self._respond(200, {"status":"success","receipt_no":receipt_no,"pdf_url":pdf_url,"invoice_no":data["invoice_no"]})

        except Exception as e:
            import traceback; traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        print("[HTTP] " + (format % args), file=sys.stderr)
