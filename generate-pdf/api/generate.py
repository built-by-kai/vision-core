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
#  FONT REGISTRATION  (Satoshi)
# ═══════════════════════════════════
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

_FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")

def _try_register(alias, filename):
    path = os.path.join(_FONT_DIR, filename)
    if os.path.exists(path):
        try:
            pdfmetrics.registerFont(TTFont(alias, path))
            return True
        except Exception as e:
            print(f"[WARN] Font {alias}: {e}", file=sys.stderr)
    return False

_SATOSHI = all([
    _try_register("Satoshi",            "Satoshi-Regular.ttf"),
    _try_register("Satoshi-Bold",       "Satoshi-Bold.ttf"),
    _try_register("Satoshi-Medium",     "Satoshi-Medium.ttf"),
    _try_register("Satoshi-Black",      "Satoshi-Black.ttf"),
    _try_register("Satoshi-Italic",     "Satoshi-Italic.ttf"),
    _try_register("Satoshi-BoldItalic", "Satoshi-BoldItalic.ttf"),
])

if _SATOSHI:
    pdfmetrics.registerFontFamily(
        "Satoshi",
        normal="Satoshi",
        bold="Satoshi-Bold",
        italic="Satoshi-Italic",
        boldItalic="Satoshi-BoldItalic",
    )
    print("[INFO] Satoshi fonts registered", file=sys.stderr)
else:
    print("[WARN] Satoshi fonts not found — falling back to Helvetica", file=sys.stderr)

F_REG  = "Satoshi"            if _SATOSHI else "Helvetica"
F_MED  = "Satoshi-Medium"     if _SATOSHI else "Helvetica"
F_BOLD = "Satoshi-Bold"       if _SATOSHI else "Helvetica-Bold"
F_BLK  = "Satoshi-Black"      if _SATOSHI else "Helvetica-Bold"
F_IT   = "Satoshi-Italic"     if _SATOSHI else "Helvetica-Oblique"
F_BIT  = "Satoshi-BoldItalic" if _SATOSHI else "Helvetica-BoldOblique"


# ═══════════════════════════════════
#  DESIGN TOKENS  — Opxio B&W
# ═══════════════════════════════════

# Core palette — black & white only
C_INK    = colors.HexColor("#0D0D0D")   # near-black: header bg, table header, total row
C_BODY   = colors.HexColor("#1A1A1A")   # main body text
C_MUTED  = colors.HexColor("#6B7280")   # secondary / address text
C_SUBTLE = colors.HexColor("#9CA3AF")   # labels, captions
C_RULE   = colors.HexColor("#D1D5DB")   # thin dividers
C_ALT    = colors.HexColor("#F7F8FA")   # alternate rows, meta bg
C_WHITE  = colors.white

# Hex strings (for inline HTML color attrs in Paragraph markup)
HEX_INK    = "#0D0D0D"
HEX_BODY   = "#1A1A1A"
HEX_MUTED  = "#6B7280"
HEX_SUBTLE = "#9CA3AF"
HEX_RULE   = "#D1D5DB"
HEX_ALT    = "#F7F8FA"
HEX_WHITE  = "#FFFFFF"


# ═══════════════════════════════════
#  CONFIG
# ═══════════════════════════════════

# Vision Core Details DB
VISION_CORE_DETAILS_DB = "33c8b289e31a80b1aa85fc1921cc0adc"
# Quotations DB
QUOTATIONS_DB          = "f8167f0bda054307b90b17ad6b9c5cf8"

QUO_PATTERN = re.compile(r"^QUO-(\d{4})-(\d{4})$")

TERMS = [
    "This quotation is valid for 30 days from the issue date.",
    "All prices are in Malaysian Ringgit (MYR) and exclusive of applicable taxes.",
    "A signed acceptance or purchase order is required to commence work.",
    "50% deposit required upon acceptance; balance upon completion.",
]


# ═══════════════════════════════════
#  SHARED HELPERS
# ═══════════════════════════════════

def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def _fmt_address(addr):
    """Format a long address string into tidy lines for the PDF."""
    if not addr:
        return ""
    if "\n" in addr:
        return addr.replace("\n", "<br/>")
    addr = re.sub(r",\s*(\d{5}\b)", r"<br/>\1", addr, count=1)
    if "<br/>" not in addr:
        parts = [p.strip() for p in addr.split(",")]
        if len(parts) >= 4:
            mid = len(parts) // 2
            addr = ", ".join(parts[:mid]) + "<br/>" + ", ".join(parts[mid:])
    return addr


def _fmt_date(d):
    if not d:
        return ""
    try:
        return datetime.fromisoformat(d).strftime("%d %B %Y")
    except Exception:
        return d


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

        page = results[0]
        p    = page.get("properties", {})

        def _v(key):
            prop = p.get(key, {})
            t = prop.get("type", "")
            if t == "title":        return _plain(prop.get("title", []))
            if t == "rich_text":    return _plain(prop.get("rich_text", []))
            if t == "email":        return prop.get("email") or ""
            if t == "phone_number": return prop.get("phone_number") or ""
            if t == "select":       return (prop.get("select") or {}).get("name", "")
            if t == "url":          return prop.get("url") or ""
            return ""

        # ── Logo: try page icon first, then any files property named Logo/Brand Logo
        logo_url = ""
        icon = page.get("icon") or {}
        if icon.get("type") == "external":
            logo_url = icon["external"].get("url", "")
        elif icon.get("type") == "file":
            logo_url = icon["file"].get("url", "")

        if not logo_url:
            for prop_name in ["Logo", "Brand Logo", "logo", "Brand"]:
                prop = p.get(prop_name, {})
                if prop.get("type") == "files":
                    files = prop.get("files", [])
                    if files:
                        f0 = files[0]
                        if f0.get("type") == "external":
                            logo_url = f0["external"].get("url", "")
                        elif f0.get("type") == "file":
                            logo_url = f0["file"].get("url", "")
                        if logo_url:
                            break

        print(f"[INFO] Logo URL: {logo_url[:60] if logo_url else 'none'}", file=sys.stderr)

        return {
            "name":                _v("Name"),
            "email":               _v("Email"),
            "phone":               _v("Phone"),
            "bank_name":           _v("Bank Name"),
            "bank_account_holder": _v("Bank Account Holder Name"),
            "bank_number":         _v("Bank Number"),
            "payment_method":      _v("Payment Method"),
            "logo_url":            logo_url,
            "terms_url":           _v("Terms URL"),
        }
    except Exception as e:
        print(f"[WARN] company details: {e}", file=sys.stderr)
        return {}


# ─────────────────────────────────────────────
#  Logo helper
# ─────────────────────────────────────────────
from reportlab.platypus import Image as RLImage

def _fetch_logo(logo_url, max_w_mm=38, max_h_mm=14):
    """Download logo URL and return a ReportLab Image flowable, or None on failure."""
    if not logo_url:
        return None
    try:
        resp = requests.get(logo_url, timeout=10)
        resp.raise_for_status()
        buf = BytesIO(resp.content)
        img = RLImage(buf)
        # Scale to fit within max dimensions while preserving aspect ratio
        img_w, img_h = img.imageWidth, img.imageHeight
        if img_w <= 0 or img_h <= 0:
            return None
        max_w = max_w_mm * mm
        max_h = max_h_mm * mm
        scale = min(max_w / img_w, max_h / img_h)
        img.drawWidth  = img_w * scale
        img.drawHeight = img_h * scale
        img.hAlign = "LEFT"
        return img
    except Exception as e:
        print(f"[WARN] Logo download failed: {e}", file=sys.stderr)
        return None


# ─────────────────────────────────────────────
#  QR Code helper
# ─────────────────────────────────────────────
def _make_qr(url, size_mm=28):
    """Generate a QR code image flowable for the given URL, or None on failure."""
    if not url:
        return None
    try:
        import qrcode
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=2,
        )
        qr.add_data(url)
        qr.make(fit=True)
        pil_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
        buf = BytesIO()
        pil_img.save(buf, format="PNG")
        buf.seek(0)
        sz = size_mm * mm
        img = RLImage(buf)
        img.drawWidth  = sz
        img.drawHeight = sz
        img.hAlign = "LEFT"
        return img
    except Exception as e:
        print(f"[WARN] QR code failed: {e}", file=sys.stderr)
        return None


# ─────────────────────────────────────────────
#  Shared PDF style helper
# ─────────────────────────────────────────────
def _make_st(styles_obj):
    """Return a ParagraphStyle factory using Satoshi (or Helvetica fallback)."""
    def st(name, **kw):
        kw.setdefault("fontName",  F_REG)
        kw.setdefault("fontSize",  9)
        kw.setdefault("leading",   13)
        kw.setdefault("textColor", C_BODY)
        return ParagraphStyle(name, parent=styles_obj["Normal"], **kw)
    return st


def _tracked(text):
    """Simulate CSS letter-spacing for uppercase labels."""
    return " ".join(c if c != " " else "  " for c in text)


# ═══════════════════════════════════
#  QUOTATION  — data fetch
# ═══════════════════════════════════

def next_quotation_number(year, hdrs, db_id=None):
    """Scan all quotations, find highest QUO-YYYY-XXXX for this year, return next."""
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
                for prop_val in props.values():
                    if prop_val.get("type") == "title":
                        title = "".join(t.get("plain_text", "") for t in prop_val.get("title", []))
                        m = QUO_PATTERN.match(title)
                        if m and int(m.group(1)) == year:
                            max_seq = max(max_seq, int(m.group(2)))
    except Exception as e:
        print(f"[WARN] auto-number quotation: {e}", file=sys.stderr)
    result = f"QUO-{year}-{max_seq + 1:04d}"
    print(f"[INFO] Next quotation number: {result} (max found: {max_seq})", file=sys.stderr)
    return result


def assign_quotation_number(issue_date, current_no, hdrs, db_id=None):
    if QUO_PATTERN.match(current_no or ""):
        return current_no
    year = datetime.now().year
    if issue_date:
        try:
            year = datetime.fromisoformat(issue_date).year
        except Exception:
            pass
    return next_quotation_number(year, hdrs, db_id=db_id)


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

    parent_db_id = (page_data.get("parent") or {}).get("database_id", "").replace("-", "")

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

    quotation_no = assign_quotation_number(issue_date, quotation_no, hdrs, db_id=parent_db_id)

    # Company
    company_name = company_address = company_phone = ""
    for rel in props.get("Company", {}).get("relation", [])[:1]:
        try:
            cr = requests.get(f"https://api.notion.com/v1/pages/{rel['id']}",
                              headers=hdrs, timeout=10)
            cr.raise_for_status()
            cp = cr.json().get("properties", {})
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

    # PIC
    pic_name = pic_email = pic_phone = ""
    pic_page_ids = []

    pic_prop = props.get("PIC", {})
    if pic_prop.get("type") == "rollup":
        for item in pic_prop.get("rollup", {}).get("array", []):
            if item.get("type") == "relation":
                pic_page_ids = [r2["id"] for r2 in item.get("relation", [])]; break
    elif pic_prop.get("type") == "relation":
        pic_page_ids = [rel["id"] for rel in pic_prop.get("relation", [])]

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

                    cp_prop = rp.get("Catalog Price", {})
                    catalog_price = 0
                    if cp_prop.get("type") == "rollup":
                        rl = cp_prop.get("rollup", {})
                        raw_cp = (rl.get("number") or
                                  next((a.get("number") for a in rl.get("array", [])
                                        if a.get("type") == "number"), None))
                        catalog_price = float(raw_cp) if raw_cp is not None else 0
                    elif cp_prop.get("type") == "number":
                        raw_cp = cp_prop.get("number")
                        catalog_price = float(raw_cp) if raw_cp is not None else 0

                    raw_up = rp.get("Unit Price", {}).get("number")
                    manual_price = float(raw_up) if raw_up is not None else 0
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


# ═══════════════════════════════════
#  QUOTATION PDF  — Opxio theme
# ═══════════════════════════════════
def generate_pdf(data):
    buffer = BytesIO()
    W, H   = A4
    margin = 20 * mm
    usable = W - 2 * margin        # ≈ 170 mm

    co        = data.get("our_company", {})
    co_name   = co.get("name")               or "Opxio"
    co_email  = co.get("email")              or ""
    co_phone  = co.get("phone")              or ""
    co_bank      = co.get("bank_name")          or ""
    co_holder    = co.get("bank_account_holder") or ""
    co_acc       = co.get("bank_number")        or ""
    co_pay       = co.get("payment_method")     or ""
    co_terms_url = co.get("terms_url")          or ""
    logo_img     = _fetch_logo(co.get("logo_url", ""), max_w_mm=42, max_h_mm=14)

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
        topMargin=12 * mm, bottomMargin=12 * mm,
    )

    styles = getSampleStyleSheet()
    st = _make_st(styles)

    story = []

    # ── 1. Dark header block ─────────────────────────────
    co_contact = ""
    if co_phone: co_contact += co_phone
    if co_email: co_contact += ("  ·  " if co_contact else "") + co_email

    # Left side: logo (if available) or company name text, plus contact line below
    if logo_img:
        left_rows = [
            [logo_img],
            [Paragraph(co_contact,
                       st("hdr_contact", fontName=F_REG, fontSize=8,
                          textColor=colors.HexColor("#9CA3AF"), leading=12))],
        ]
    else:
        left_rows = [
            [Paragraph(co_name,
                       st("hdr_name", fontName=F_BOLD, fontSize=14,
                          textColor=C_WHITE, leading=18))],
            [Paragraph(co_contact,
                       st("hdr_contact", fontName=F_REG, fontSize=8,
                          textColor=colors.HexColor("#9CA3AF"), leading=12))],
        ]

    hdr_left = Table(left_rows, colWidths=[usable * 0.55],
       style=TableStyle([("PADDING", (0,0),(-1,-1), 0), ("VALIGN",(0,0),(-1,-1),"TOP")]))

    hdr_right = Paragraph(
        "Quotation",
        st("hdr_title", fontName=F_BLK, fontSize=32, textColor=C_WHITE,
           alignment=2, leading=38)
    )

    hdr = Table([[hdr_left, hdr_right]], colWidths=[usable * 0.55, usable * 0.45])
    hdr.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), C_INK),
        ("VALIGN",     (0,0),(-1,-1), "MIDDLE"),
        ("LEFTPADDING",  (0,0),(-1,-1), 16),
        ("RIGHTPADDING", (0,0),(-1,-1), 16),
        ("TOPPADDING",   (0,0),(-1,-1), 16),
        ("BOTTOMPADDING",(0,0),(-1,-1), 16),
    ]))
    story.append(hdr)

    # ── 2. Teal accent line ──────────────────────────────
    story.append(HRFlowable(width=usable, color=C_INK, thickness=3, spaceAfter=7*mm))

    # ── 3. Meta row ──────────────────────────────────────
    def _mcell(label, value):
        return Table([
            [Paragraph(label,
                       st(f"ml_{label[:4]}", fontName=F_MED, fontSize=7,
                          textColor=C_SUBTLE, leading=10))],
            [Paragraph(value,
                       st(f"mv_{label[:4]}", fontName=F_BOLD, fontSize=11,
                          textColor=C_BODY, leading=16))],
        ], colWidths=[usable/3 - 28],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")]))

    meta = Table([[
        _mcell("QUOTE NO.",   data.get("quotation_no", "")),
        _mcell("DATE",        issue_display or "—"),
        _mcell("VALID UNTIL", valid_display or "—"),
    ]], colWidths=[usable/3]*3)
    meta.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), C_ALT),
        ("PADDING",    (0,0),(-1,-1), 12),
        ("LINEAFTER",  (0,0),(1,-1),  0.5, C_RULE),
        ("VALIGN",     (0,0),(-1,-1), "TOP"),
    ]))
    story.append(meta)
    story.append(Spacer(1, 8*mm))

    # ── 4. Bill To ───────────────────────────────────────
    story.append(Paragraph(
        _tracked("BILL TO"),
        st("bt_lbl", fontName=F_MED, fontSize=7, textColor=C_SUBTLE, leading=11)
    ))
    story.append(Spacer(1, 3*mm))
    story.append(Paragraph(
        data.get("company_name") or "N/A",
        st("co2", fontName=F_BOLD, fontSize=12, textColor=C_BODY, leading=16)
    ))
    if data.get("company_address"):
        story.append(Paragraph(
            _fmt_address(data["company_address"]),
            st("adr", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=13)
        ))
    if data.get("company_phone"):
        story.append(Paragraph(
            data["company_phone"],
            st("cph", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=13)
        ))
    if data.get("pic_name"):
        attn = f"Attn: {data['pic_name']}"
        if data.get("pic_email"):
            attn += f"  ·  {data['pic_email']}"
        story.append(Paragraph(
            attn,
            st("pic", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=13)
        ))
    story.append(Spacer(1, 9*mm))

    # ── 5. Line items table ──────────────────────────────
    cw = [usable*0.54, usable*0.10, usable*0.19, usable*0.17]

    # Header row styles
    s_th  = st("th",  fontName=F_MED, fontSize=7, textColor=C_WHITE, leading=10)
    s_thr = st("thr", fontName=F_MED, fontSize=7, textColor=C_WHITE, alignment=2, leading=10)
    s_thc = st("thc", fontName=F_MED, fontSize=7, textColor=C_WHITE, alignment=1, leading=10)

    # Data row styles
    s_name  = st("nm",  fontName=F_BOLD, fontSize=9, textColor=C_BODY, leading=13)
    s_desc  = st("dc",  fontName=F_REG,  fontSize=8, textColor=C_MUTED, leading=12)
    s_num   = st("nu",  fontName=F_REG,  fontSize=9, textColor=C_BODY, alignment=2, leading=13)
    s_numc  = st("nuc", fontName=F_REG,  fontSize=9, textColor=C_BODY, alignment=1, leading=13)
    s_strk  = st("stk", fontName=F_REG,  fontSize=8, textColor=C_SUBTLE, alignment=2, leading=11)

    rows = [[
        Paragraph(_tracked("DESCRIPTION"), s_th),
        Paragraph(_tracked("QTY"),         s_thc),
        Paragraph(_tracked("UNIT PRICE"),  s_thr),
        Paragraph(_tracked("AMOUNT"),      s_thr),
    ]]

    total = 0.0
    for item in data.get("line_items", []):
        qty           = float(item.get("qty") or 1)
        price         = float(item.get("unit_price") or 0)
        catalog_price = float(item.get("catalog_price") or 0)
        is_discounted = item.get("is_discounted", False)
        amt           = qty * price
        total        += amt

        desc_inner = [[Paragraph(item.get("name", ""), s_name)]]
        if item.get("desc"):
            desc_inner.append([Paragraph(item["desc"], s_desc)])
        desc_cell = Table(
            desc_inner,
            colWidths=[cw[0] - 16],
            style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")])
        )

        if is_discounted and catalog_price > 0:
            price_cell = Table([
                [Paragraph(f"<strike>RM {catalog_price:,.2f}</strike>", s_strk)],
                [Paragraph(f"RM {price:,.2f}", s_num)],
            ], colWidths=[cw[2] - 16],
               style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")]))
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
        ("BACKGROUND",     (0,0), (-1,0),        C_INK),
        ("PADDING",        (0,0), (-1,-1),        [8, 10, 8, 10]),
        ("VALIGN",         (0,0), (-1,-1),        "TOP"),
        ("LINEBELOW",      (0,1), (-1,n_data-1),  0.5, C_RULE),
        ("ROWBACKGROUNDS", (0,1), (-1,n_data-1),  [C_WHITE, C_ALT]),
    ]))
    story.append(items_tbl)
    story.append(Spacer(1, 5*mm))

    # ── 6. Totals ────────────────────────────────────────
    has_deposit = (data.get("payment_terms") == "50% Deposit")
    deposit     = total * 0.5 if has_deposit else 0

    tot_rows = [[
        Paragraph("Subtotal",
                  st("stl", fontName=F_REG, fontSize=9, textColor=C_MUTED, alignment=2)),
        Paragraph(f"RM {total:,.2f}",
                  st("stv", fontName=F_REG, fontSize=9, textColor=C_BODY, alignment=2)),
    ]]
    if has_deposit:
        tot_rows.append([
            Paragraph("Deposit Due (50%)",
                      st("ddl", fontName=F_REG, fontSize=9, textColor=C_MUTED, alignment=2)),
            Paragraph(f"RM {deposit:,.2f}",
                      st("ddv", fontName=F_REG, fontSize=9, textColor=C_BODY, alignment=2)),
        ])

    n_tot = len(tot_rows)
    tot_rows.append([
        Paragraph("Total Quote",
                  st("tdl", fontName=F_BOLD, fontSize=11, textColor=C_WHITE, alignment=2)),
        Paragraph(f"RM {total:,.2f}",
                  st("tdv", fontName=F_BOLD, fontSize=11, textColor=C_WHITE, alignment=2)),
    ])

    tot_tbl = Table(tot_rows, colWidths=[usable*0.65, usable*0.35])
    tot_tbl.setStyle(TableStyle([
        ("TOPPADDING",    (0,0),(-1,-1),        5),
        ("BOTTOMPADDING", (0,0),(-1,-1),        5),
        ("LEFTPADDING",   (0,0),(-1,-1),        4),
        ("RIGHTPADDING",  (0,0),(-1,-1),        8),
        ("VALIGN",        (0,0),(-1,-1),        "MIDDLE"),
        ("BACKGROUND",    (0,n_tot),(-1,n_tot), C_INK),
        ("LEFTPADDING",   (0,n_tot),(-1,n_tot), 10),
        ("RIGHTPADDING",  (0,n_tot),(-1,n_tot), 10),
        ("TOPPADDING",    (0,n_tot),(-1,n_tot), 10),
        ("BOTTOMPADDING", (0,n_tot),(-1,n_tot), 10),
    ]))
    story.append(tot_tbl)
    story.append(Spacer(1, 10*mm))

    # ── 7. Thin divider ──────────────────────────────────
    story.append(HRFlowable(width=usable, color=C_RULE, thickness=0.5))
    story.append(Spacer(1, 6*mm))

    # ── 8. T&C QR  |  Payment Details ───────────────────
    qr_img = _make_qr(co_terms_url, size_mm=28)

    pay_lines = []
    if co_pay:    pay_lines.append(f"<font color='{HEX_SUBTLE}' size='7'>{_tracked('METHOD')}</font><br/><font size='8' color='{HEX_BODY}'>{co_pay}</font>")
    if co_bank:   pay_lines.append(f"<font color='{HEX_SUBTLE}' size='7'>{_tracked('BANK')}</font><br/><font size='8' color='{HEX_BODY}'>{co_bank}</font>")
    if co_holder: pay_lines.append(f"<font color='{HEX_SUBTLE}' size='7'>{_tracked('ACCOUNT NAME')}</font><br/><font size='8' color='{HEX_BODY}'>{co_holder}</font>")
    if co_acc:    pay_lines.append(f"<font color='{HEX_SUBTLE}' size='7'>{_tracked('ACCOUNT NO.')}</font><br/><font size='8' color='{HEX_BODY}'>{co_acc}</font>")

    pay_header = f"<font name='{F_MED}' size='7' color='{HEX_SUBTLE}'>{_tracked('PAYMENT DETAILS')}</font>"
    pay_html   = pay_header + "<br/><br/>" + "<br/><br/>".join(pay_lines) if pay_lines else pay_header

    if qr_img:
        # Left: QR code + acceptance statement
        qr_label = Paragraph(
            f"<font name='{F_MED}' size='7' color='{HEX_SUBTLE}'>{_tracked('TERMS & CONDITIONS')}</font>",
            st("qrl", fontName=F_MED, fontSize=7, textColor=C_SUBTLE, leading=10)
        )
        qr_note = Paragraph(
            f"<font name='{F_REG}' size='7' color='{HEX_MUTED}'>Scan to read our full Terms & Conditions. "
            "By proceeding with this quotation, the client acknowledges and agrees to the terms therein.</font>",
            st("qrn", fontName=F_REG, fontSize=7, textColor=C_MUTED, leading=11)
        )
        left_col = Table([
            [qr_label],
            [Spacer(1, 3*mm)],
            [qr_img],
            [Spacer(1, 3*mm)],
            [qr_note],
        ], colWidths=[usable*0.55 - 20],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")]))
    else:
        # Fallback: plain text terms
        terms_lines = [f"<font name='{F_MED}' size='7' color='{HEX_SUBTLE}'>{_tracked('NOTES & TERMS')}</font>", ""]
        for term in TERMS:
            terms_lines.append(f"<font name='{F_REG}' size='8' color='{HEX_MUTED}'>• {term}</font>")
        left_col = Paragraph("<br/>".join(terms_lines), st("tp", fontName=F_REG, fontSize=8, leading=15, textColor=C_BODY))

    bot = Table([[
        left_col,
        Paragraph(pay_html, st("pp", fontName=F_REG, fontSize=8, leading=15, textColor=C_BODY)),
    ]], colWidths=[usable*0.55, usable*0.45])
    bot.setStyle(TableStyle([
        ("VALIGN",       (0,0),(-1,-1), "TOP"),
        ("LEFTPADDING",  (0,0),(0,-1),  0),
        ("RIGHTPADDING", (0,0),(0,-1),  20),
        ("LEFTPADDING",  (1,0),(1,-1),  20),
        ("LINEAFTER",    (0,0),(0,-1),  0.5, C_RULE),
    ]))
    story.append(bot)
    story.append(Spacer(1, 6*mm))

    # ── 9. Footer ─────────────────────────────────────────
    story.append(HRFlowable(width=usable, color=C_INK, thickness=1.5, spaceAfter=3*mm))
    fp_parts = [co_name]
    if co_email: fp_parts.append(co_email)
    if co_phone: fp_parts.append(co_phone)
    story.append(Paragraph(
        f"<font color='{HEX_SUBTLE}'>{'  ·  '.join(fp_parts)}</font>",
        st("ftr", fontName=F_REG, fontSize=7, textColor=C_SUBTLE, alignment=1)
    ))

    doc.build(story)
    buffer.seek(0)
    return buffer


# ═══════════════════════════════════
#  3. Upload to Vercel Blob
# ═══════════════════════════════════
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


# ═══════════════════════════════════
#  4. Write back to Notion
# ═══════════════════════════════════
def void_linked_invoices(page_id, hdrs):
    try:
        qr = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                          headers=hdrs, timeout=10)
        qr.raise_for_status()
        inv_rels = qr.json().get("properties", {}).get("Invoice", {}).get("relation", [])
        for rel in inv_rels:
            inv_id = rel["id"].replace("-", "")
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

    payload = {
        "properties": {
            "PDF":        {"url": pdf_url},
            "Status":     {"select": {"name": "Draft"}},
            "Issue Date": {"date": {"start": today}},
        }
    }
    if total_amount and total_amount > 0:
        payload["properties"]["Amount"] = {"number": total_amount}
    if quotation_no and title_prop_name and QUO_PATTERN.match(quotation_no):
        payload["properties"][title_prop_name] = {
            "title": [{"text": {"content": quotation_no}}]
        }
    resp = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json=payload, timeout=10,
    )
    if not resp.ok:
        print(f"[WARN] update_notion_page PATCH failed {resp.status_code}: {resp.text[:300]}", file=sys.stderr)
    resp.raise_for_status()


# ═══════════════════════════════════
#  INVOICE  — config & data fetch
# ═══════════════════════════════════

IMPL_FORM_BASE = "https://opxio.vercel.app/api/implementation_form"

INV_PATTERN = re.compile(r"^INV-\d{4}-\d{4}(-[DSFR])?$")

INV_SUFFIX = {
    "Deposit":       "-D",
    "Final Payment": "-F",
    "Full Payment":  "",
    "Retainer":      "-R",
}

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


def format_invoice_number(quotation_no, invoice_type, issue_date):
    suffix = INV_SUFFIX.get(invoice_type, "")
    m = QUO_PATTERN.match(quotation_no or "")
    if m:
        return f"INV-{m.group(1)}-{m.group(2)}{suffix}"
    year = datetime.now().year
    if issue_date:
        try:
            year = datetime.fromisoformat(issue_date).year
        except Exception:
            pass
    ts = datetime.now().strftime("%H%M")
    return f"INV-{year}-{ts}{suffix}"


def assign_invoice_number(page_id, current_no, quotation_no, invoice_type, issue_date, hdrs):
    if INV_PATTERN.match(current_no or ""):
        return current_no
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


def fetch_invoice_data(page_id, hdrs):
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
    deposit_paid  = props.get("Deposit (50%)", {}).get("number") or 0
    payment_balance = props.get("Final Payment", {}).get("number") or 0

    dep_date = (props.get("Deposit Due", {}).get("date") or {}).get("start", "")
    bal_date = (props.get("Final Payment Due", {}).get("date") or {}).get("start", "")
    due_date = dep_date if invoice_type == "Deposit" else (bal_date or dep_date)

    # Company
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

    # PIC
    pic_name = pic_email = pic_phone = ""
    pic_prop = props.get("PIC", {})
    pic_page_ids = []
    if pic_prop.get("type") == "rollup":
        for item in pic_prop.get("rollup", {}).get("array", []):
            t = item.get("type", "")
            if t == "relation":
                pic_page_ids = [r["id"] for r in item.get("relation", [])]; break
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

    # Quotation: pull line items + package slug
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

            quotation_no = _plain(qprops.get("Quotation No.", {}).get("title", []))
            qt = (qprops.get("Quote Type", {}).get("select") or {}).get("name", "")
            pkg_slug = QUOTE_TYPE_TO_PKG.get(qt, "")

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
                        item["qty"] = rp.get("Qty", {}).get("number") or 1
                        raw_up = rp.get("Unit Price", {}).get("number")
                        item["unit_price"] = float(raw_up) if raw_up is not None else 0
                        if item.get("name"):
                            line_items.append(item)
                    if line_items:
                        break
                except Exception as e:
                    print(f"[WARN] child DB: {e}", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] quotation fetch: {e}", file=sys.stderr)

    if not line_items and total_amount:
        line_items = [{"name": "Professional Services", "desc": "",
                       "qty": 1, "unit_price": float(total_amount)}]

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


def activate_invoice(page_id, total_amount, deposit_paid, invoice_type, hdrs):
    today = __import__("datetime").datetime.now().date().isoformat()
    pay_balance = round(total_amount - deposit_paid, 2) if deposit_paid > 0 else total_amount

    if invoice_type == "Final Payment":
        status_prop = {}
    else:
        status_prop = {"Status": {"select": {"name": "Deposit Pending"}}}

    payload = {
        "properties": {
            **status_prop,
            "Issue Date":   {"date":   {"start": today}},
            "Final Payment": {"number": pay_balance},
        }
    }
    r = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json=payload, timeout=10
    )
    if not r.ok:
        print(f"[WARN] activate_invoice PATCH {r.status_code}: {r.text[:400]}", file=sys.stderr)
    return today


# ═══════════════════════════════════
#  INVOICE PDF  — Opxio theme
# ═══════════════════════════════════
def generate_invoice_pdf(data):
    buffer = BytesIO()
    W, H   = A4
    margin = 20 * mm
    usable = W - 2 * margin

    co        = data.get("our_company", {})
    co_name   = co.get("name")                or "Opxio"
    co_email  = co.get("email")               or ""
    co_phone  = co.get("phone")               or ""
    co_bank      = co.get("bank_name")           or ""
    co_holder    = co.get("bank_account_holder") or ""
    co_acc       = co.get("bank_number")         or ""
    co_pay       = co.get("payment_method")      or ""
    co_terms_url = co.get("terms_url")           or ""
    logo_img     = _fetch_logo(co.get("logo_url", ""), max_w_mm=42, max_h_mm=14)

    issue_display = _fmt_date(data.get("issue_date"))
    due_display   = _fmt_date(data.get("due_date"))

    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=margin, leftMargin=margin,
        topMargin=12 * mm, bottomMargin=12 * mm,
    )
    styles = getSampleStyleSheet()
    st = _make_st(styles)

    story = []

    # ── 1. Dark header block ─────────────────────────────
    co_contact = ""
    if co_phone: co_contact += co_phone
    if co_email: co_contact += ("  ·  " if co_contact else "") + co_email

    if logo_img:
        left_rows = [
            [logo_img],
            [Paragraph(co_contact,
                       st("hdr_contact", fontName=F_REG, fontSize=8,
                          textColor=colors.HexColor("#9CA3AF"), leading=12))],
        ]
    else:
        left_rows = [
            [Paragraph(co_name,
                       st("hdr_name", fontName=F_BOLD, fontSize=14,
                          textColor=C_WHITE, leading=18))],
            [Paragraph(co_contact,
                       st("hdr_contact", fontName=F_REG, fontSize=8,
                          textColor=colors.HexColor("#9CA3AF"), leading=12))],
        ]

    hdr_left = Table(left_rows, colWidths=[usable * 0.55],
       style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")]))

    inv_type_label = data.get("invoice_type", "")
    title_text = f"Invoice<br/><font name='{F_REG}' size='13' color='#9CA3AF'>{inv_type_label}</font>" if inv_type_label else "Invoice"
    hdr_right = Paragraph(
        title_text,
        st("hdr_title", fontName=F_BLK, fontSize=32, textColor=C_WHITE, alignment=2, leading=38)
    )

    hdr = Table([[hdr_left, hdr_right]], colWidths=[usable * 0.55, usable * 0.45])
    hdr.setStyle(TableStyle([
        ("BACKGROUND",   (0,0),(-1,-1), C_INK),
        ("VALIGN",       (0,0),(-1,-1), "MIDDLE"),
        ("LEFTPADDING",  (0,0),(-1,-1), 16),
        ("RIGHTPADDING", (0,0),(-1,-1), 16),
        ("TOPPADDING",   (0,0),(-1,-1), 16),
        ("BOTTOMPADDING",(0,0),(-1,-1), 16),
    ]))
    story.append(hdr)

    # ── 2. Teal accent line ──────────────────────────────
    story.append(HRFlowable(width=usable, color=C_INK, thickness=3, spaceAfter=7*mm))

    # ── 3. Meta row ──────────────────────────────────────
    def _mcell(label, value):
        return Table([
            [Paragraph(label,
                       st(f"ml_{label[:4]}", fontName=F_MED, fontSize=7,
                          textColor=C_SUBTLE, leading=10))],
            [Paragraph(value,
                       st(f"mv_{label[:4]}", fontName=F_BOLD, fontSize=11,
                          textColor=C_BODY, leading=16))],
        ], colWidths=[usable/3 - 28],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")]))

    meta = Table([[
        _mcell("INVOICE NO.", data.get("invoice_no", "")),
        _mcell("DATE",        issue_display or "—"),
        _mcell("DUE DATE",    due_display   or "—"),
    ]], colWidths=[usable/3]*3)
    meta.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), C_ALT),
        ("PADDING",    (0,0),(-1,-1), 12),
        ("LINEAFTER",  (0,0),(1,-1),  0.5, C_RULE),
        ("VALIGN",     (0,0),(-1,-1), "TOP"),
    ]))
    story.append(meta)
    story.append(Spacer(1, 8*mm))

    # ── 4. Bill To ───────────────────────────────────────
    story.append(Paragraph(
        _tracked("BILL TO"),
        st("bt_lbl", fontName=F_MED, fontSize=7, textColor=C_SUBTLE, leading=11)
    ))
    story.append(Spacer(1, 3*mm))
    story.append(Paragraph(
        data.get("company_name") or "N/A",
        st("co2", fontName=F_BOLD, fontSize=12, textColor=C_BODY, leading=16)
    ))
    if data.get("company_address"):
        story.append(Paragraph(
            _fmt_address(data["company_address"]),
            st("adr", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=13)
        ))
    if data.get("company_phone"):
        story.append(Paragraph(
            data["company_phone"],
            st("cph", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=13)
        ))
    if data.get("pic_name"):
        attn = f"Attn: {data['pic_name']}"
        if data.get("pic_email"):
            attn += f"  ·  {data['pic_email']}"
        story.append(Paragraph(
            attn,
            st("pic", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=13)
        ))
    story.append(Spacer(1, 9*mm))

    # ── 5. Line items table ──────────────────────────────
    cw = [usable*0.54, usable*0.10, usable*0.19, usable*0.17]

    s_th  = st("th",  fontName=F_MED, fontSize=7, textColor=C_WHITE, leading=10)
    s_thr = st("thr", fontName=F_MED, fontSize=7, textColor=C_WHITE, alignment=2, leading=10)
    s_thc = st("thc", fontName=F_MED, fontSize=7, textColor=C_WHITE, alignment=1, leading=10)
    s_name = st("nm", fontName=F_BOLD, fontSize=9, textColor=C_BODY, leading=13)
    s_desc = st("dc", fontName=F_REG,  fontSize=8, textColor=C_MUTED, leading=12)
    s_num  = st("nu", fontName=F_REG,  fontSize=9, textColor=C_BODY, alignment=2, leading=13)
    s_numc = st("nuc",fontName=F_REG,  fontSize=9, textColor=C_BODY, alignment=1, leading=13)

    rows = [[
        Paragraph(_tracked("DESCRIPTION"), s_th),
        Paragraph(_tracked("QTY"),         s_thc),
        Paragraph(_tracked("UNIT PRICE"),  s_thr),
        Paragraph(_tracked("AMOUNT"),      s_thr),
    ]]

    total = 0.0
    for item in data.get("line_items", []):
        qty   = float(item.get("qty") or 1)
        price = float(item.get("unit_price") or 0)
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
        ("BACKGROUND",     (0,0), (-1,0),        C_INK),
        ("PADDING",        (0,0), (-1,-1),        [8, 10, 8, 10]),
        ("VALIGN",         (0,0), (-1,-1),        "TOP"),
        ("LINEBELOW",      (0,1), (-1,n_data-1),  0.5, C_RULE),
        ("ROWBACKGROUNDS", (0,1), (-1,n_data-1),  [C_WHITE, C_ALT]),
    ]))
    story.append(items_tbl)
    story.append(Spacer(1, 5*mm))

    # ── 6. Totals ────────────────────────────────────────
    invoice_type  = data.get("invoice_type", "")
    deposit_paid  = float(data.get("deposit_paid", 0) or 0)
    is_deposit    = invoice_type == "Deposit"
    is_final      = invoice_type == "Final Payment"

    if is_deposit:
        amount_due = deposit_paid if deposit_paid > 0 else total * 0.5
    elif is_final:
        amount_due = total - deposit_paid if deposit_paid > 0 else total
    else:
        amount_due = total

    tot_rows = [[
        Paragraph("Subtotal",
                  st("stl", fontName=F_REG, fontSize=9, textColor=C_MUTED, alignment=2)),
        Paragraph(f"RM {total:,.2f}",
                  st("stv", fontName=F_REG, fontSize=9, textColor=C_BODY, alignment=2)),
    ]]
    if is_deposit and amount_due != total:
        tot_rows.append([
            Paragraph("Deposit Due",
                      st("ddl", fontName=F_REG, fontSize=9, textColor=C_MUTED, alignment=2)),
            Paragraph(f"RM {amount_due:,.2f}",
                      st("ddv", fontName=F_REG, fontSize=9, textColor=C_BODY, alignment=2)),
        ])
    if is_final and deposit_paid > 0:
        tot_rows.append([
            Paragraph("Deposit Paid",
                      st("dpl", fontName=F_REG, fontSize=9, textColor=C_MUTED, alignment=2)),
            Paragraph(f"(RM {deposit_paid:,.2f})",
                      st("dpv", fontName=F_REG, fontSize=9, textColor=C_MUTED, alignment=2)),
        ])

    n_tot = len(tot_rows)
    due_label = "Amount Due" if is_deposit else "Total Due"
    tot_rows.append([
        Paragraph(due_label,
                  st("tdl", fontName=F_BOLD, fontSize=11, textColor=C_WHITE, alignment=2)),
        Paragraph(f"RM {amount_due:,.2f}",
                  st("tdv", fontName=F_BOLD, fontSize=11, textColor=C_WHITE, alignment=2)),
    ])

    tot_tbl = Table(tot_rows, colWidths=[usable*0.65, usable*0.35])
    tot_tbl.setStyle(TableStyle([
        ("TOPPADDING",    (0,0),(-1,-1),        5),
        ("BOTTOMPADDING", (0,0),(-1,-1),        5),
        ("LEFTPADDING",   (0,0),(-1,-1),        4),
        ("RIGHTPADDING",  (0,0),(-1,-1),        8),
        ("VALIGN",        (0,0),(-1,-1),        "MIDDLE"),
        ("BACKGROUND",    (0,n_tot),(-1,n_tot), C_INK),
        ("LEFTPADDING",   (0,n_tot),(-1,n_tot), 10),
        ("RIGHTPADDING",  (0,n_tot),(-1,n_tot), 10),
        ("TOPPADDING",    (0,n_tot),(-1,n_tot), 10),
        ("BOTTOMPADDING", (0,n_tot),(-1,n_tot), 10),
    ]))
    story.append(tot_tbl)
    story.append(Spacer(1, 10*mm))

    # ── 7. Divider ───────────────────────────────────────
    story.append(HRFlowable(width=usable, color=C_RULE, thickness=0.5))
    story.append(Spacer(1, 6*mm))

    # ── 8. T&C QR  |  Payment Details ───────────────────
    qr_img = _make_qr(co_terms_url, size_mm=28)

    pay_lines = []
    if co_pay:    pay_lines.append(f"<font color='{HEX_SUBTLE}' size='7'>{_tracked('METHOD')}</font><br/><font size='8' color='{HEX_BODY}'>{co_pay}</font>")
    if co_bank:   pay_lines.append(f"<font color='{HEX_SUBTLE}' size='7'>{_tracked('BANK')}</font><br/><font size='8' color='{HEX_BODY}'>{co_bank}</font>")
    if co_holder: pay_lines.append(f"<font color='{HEX_SUBTLE}' size='7'>{_tracked('ACCOUNT NAME')}</font><br/><font size='8' color='{HEX_BODY}'>{co_holder}</font>")
    if co_acc:    pay_lines.append(f"<font color='{HEX_SUBTLE}' size='7'>{_tracked('ACCOUNT NO.')}</font><br/><font size='8' color='{HEX_BODY}'>{co_acc}</font>")

    pay_header = f"<font name='{F_MED}' size='7' color='{HEX_SUBTLE}'>{_tracked('PAYMENT DETAILS')}</font>"
    pay_html   = pay_header + "<br/><br/>" + "<br/><br/>".join(pay_lines) if pay_lines else pay_header

    if qr_img:
        qr_label = Paragraph(
            f"<font name='{F_MED}' size='7' color='{HEX_SUBTLE}'>{_tracked('TERMS & CONDITIONS')}</font>",
            st("qrl2", fontName=F_MED, fontSize=7, textColor=C_SUBTLE, leading=10)
        )
        qr_note = Paragraph(
            f"<font name='{F_REG}' size='7' color='{HEX_MUTED}'>Scan to read our full Terms & Conditions. "
            "Payment of this invoice constitutes acceptance of the terms therein.</font>",
            st("qrn2", fontName=F_REG, fontSize=7, textColor=C_MUTED, leading=11)
        )
        left_col = Table([
            [qr_label],
            [Spacer(1, 3*mm)],
            [qr_img],
            [Spacer(1, 3*mm)],
            [qr_note],
        ], colWidths=[usable*0.55 - 20],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")]))
    else:
        terms_lines = [f"<font name='{F_MED}' size='7' color='{HEX_SUBTLE}'>{_tracked('NOTES & TERMS')}</font>", ""]
        for term in INVOICE_TERMS:
            terms_lines.append(f"<font name='{F_REG}' size='8' color='{HEX_MUTED}'>• {term}</font>")
        left_col = Paragraph("<br/>".join(terms_lines), st("tp2", fontName=F_REG, fontSize=8, leading=15, textColor=C_BODY))

    bot = Table([[
        left_col,
        Paragraph(pay_html, st("pp2", fontName=F_REG, fontSize=8, leading=15, textColor=C_BODY)),
    ]], colWidths=[usable*0.55, usable*0.45])
    bot.setStyle(TableStyle([
        ("VALIGN",       (0,0),(-1,-1), "TOP"),
        ("LEFTPADDING",  (0,0),(0,-1),  0),
        ("RIGHTPADDING", (0,0),(0,-1),  20),
        ("LEFTPADDING",  (1,0),(1,-1),  20),
        ("LINEAFTER",    (0,0),(0,-1),  0.5, C_RULE),
    ]))
    story.append(bot)
    story.append(Spacer(1, 6*mm))

    # ── 9. Footer ─────────────────────────────────────────
    story.append(HRFlowable(width=usable, color=C_INK, thickness=1.5, spaceAfter=3*mm))
    fp_parts = [co_name]
    if co_email: fp_parts.append(co_email)
    if co_phone: fp_parts.append(co_phone)
    story.append(Paragraph(
        f"<font color='{HEX_SUBTLE}'>{'  ·  '.join(fp_parts)}</font>",
        st("ftr", fontName=F_REG, fontSize=7, textColor=C_SUBTLE, alignment=1)
    ))

    doc.build(story)
    buffer.seek(0)
    return buffer, amount_due


def update_notion_invoice(page_id, pdf_url, amount_due, intake_url, hdrs):
    payload = {"properties": {}}

    if pdf_url:
        payload["properties"]["Invoice PDF"] = {"url": pdf_url}

    if intake_url:
        try:
            db_r = requests.get(
                "https://api.notion.com/v1/databases/9227dda9c4be42a1a4c6b1bce4862f8c",
                headers=hdrs, timeout=10
            )
            if db_r.ok and "Intake Form URL" in db_r.json().get("properties", {}):
                payload["properties"]["Intake Form URL"] = {"url": intake_url}
        except Exception as e:
            print(f"[WARN] Could not check DB schema for Intake Form URL: {e}", file=sys.stderr)

    if not payload["properties"]:
        return

    r = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs, json=payload, timeout=10,
    )
    if not r.ok:
        raise ValueError(f"Notion PATCH invoice page {r.status_code}: {r.text[:300]}")


# ═══════════════════════════════════
#  RECEIPT  — config & data
# ═══════════════════════════════════

RECEIPT_DB  = "3b99088af86c48c598a6422d764b24ac"
REC_PATTERN = re.compile(r"^REC-(\d{4})-(\d{4})$")


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


def create_receipt_page(invoice_page_id, receipt_no, data, hdrs):
    today    = datetime.now().date().isoformat()
    pay_date = data.get("pay_date") or today

    props = {
        "Receipt No.":  {"title": [{"text": {"content": receipt_no}}]},
        "Amount Paid":  {"number": data.get("amount_paid", 0)},
        "Payment Date": {"date": {"start": pay_date}},
        "Invoice":      {"relation": [{"id": invoice_page_id}]},
    }
    if data.get("company_id"):
        props["Company"] = {"relation": [{"id": data["company_id"]}]}
    if data.get("pay_methods"):
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


# ═══════════════════════════════════
#  RECEIPT PDF  — Opxio theme
# ═══════════════════════════════════
def generate_receipt_pdf(receipt_no, data):
    buffer = BytesIO()
    W, H   = A4
    margin = 20 * mm
    usable = W - 2 * margin

    co       = data.get("our_company", {})
    co_name  = co.get("name")  or "Opxio"
    co_email = co.get("email") or ""
    co_phone = co.get("phone") or ""
    logo_img = _fetch_logo(co.get("logo_url", ""), max_w_mm=42, max_h_mm=14)

    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=margin, leftMargin=margin,
        topMargin=12 * mm, bottomMargin=12 * mm,
    )
    styles = getSampleStyleSheet()
    st = _make_st(styles)

    story = []

    # ── 1. Dark header block ─────────────────────────────
    co_contact = ""
    if co_phone: co_contact += co_phone
    if co_email: co_contact += ("  ·  " if co_contact else "") + co_email

    if logo_img:
        left_rows = [
            [logo_img],
            [Paragraph(co_contact,
                       st("hdr_contact", fontName=F_REG, fontSize=8,
                          textColor=colors.HexColor("#9CA3AF"), leading=12))],
        ]
    else:
        left_rows = [
            [Paragraph(co_name,
                       st("hdr_name", fontName=F_BOLD, fontSize=14,
                          textColor=C_WHITE, leading=18))],
            [Paragraph(co_contact,
                       st("hdr_contact", fontName=F_REG, fontSize=8,
                          textColor=colors.HexColor("#9CA3AF"), leading=12))],
        ]

    hdr_left = Table(left_rows, colWidths=[usable * 0.55],
       style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")]))

    hdr = Table([[hdr_left,
                  Paragraph("Receipt",
                             st("hdr_title", fontName=F_BLK, fontSize=32,
                                textColor=C_WHITE, alignment=2, leading=38))
                  ]], colWidths=[usable * 0.55, usable * 0.45])
    hdr.setStyle(TableStyle([
        ("BACKGROUND",   (0,0),(-1,-1), C_INK),
        ("VALIGN",       (0,0),(-1,-1), "MIDDLE"),
        ("LEFTPADDING",  (0,0),(-1,-1), 16),
        ("RIGHTPADDING", (0,0),(-1,-1), 16),
        ("TOPPADDING",   (0,0),(-1,-1), 16),
        ("BOTTOMPADDING",(0,0),(-1,-1), 16),
    ]))
    story.append(hdr)

    # ── 2. Teal accent line ──────────────────────────────
    story.append(HRFlowable(width=usable, color=C_INK, thickness=3, spaceAfter=7*mm))

    # ── 3. Meta row ──────────────────────────────────────
    def _mcell(label, value):
        return Table([
            [Paragraph(label,
                       st(f"ml_{label[:3]}", fontName=F_MED, fontSize=7,
                          textColor=C_SUBTLE, leading=10))],
            [Paragraph(value,
                       st(f"mv_{label[:3]}", fontName=F_BOLD, fontSize=11,
                          textColor=C_BODY, leading=16))],
        ], colWidths=[usable/3 - 28],
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
        ("BACKGROUND", (0,0),(-1,-1), C_ALT),
        ("PADDING",    (0,0),(-1,-1), 12),
        ("LINEAFTER",  (0,0),(1,-1),  0.5, C_RULE),
        ("VALIGN",     (0,0),(-1,-1), "TOP"),
    ]))
    story.append(meta)
    story.append(Spacer(1, 10*mm))

    # ── 4. Received From ─────────────────────────────────
    story.append(Paragraph(
        _tracked("RECEIVED FROM"),
        st("rf_lbl", fontName=F_MED, fontSize=7, textColor=C_SUBTLE, leading=11)
    ))
    story.append(Spacer(1, 3*mm))
    story.append(Paragraph(
        data.get("company_name") or "N/A",
        st("co2", fontName=F_BOLD, fontSize=12, textColor=C_BODY, leading=16)
    ))
    if data.get("company_address"):
        story.append(Paragraph(
            data["company_address"],
            st("addr", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=12)
        ))
    if data.get("company_phone"):
        story.append(Paragraph(
            data["company_phone"],
            st("cph", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=12)
        ))
    if data.get("pic_name"):
        attn = f"Attn: {data['pic_name']}"
        if data.get("pic_email"):
            attn += f"  ·  {data['pic_email']}"
        story.append(Paragraph(
            attn, st("pic", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=12)
        ))
    story.append(Spacer(1, 9*mm))

    # ── 5. Payment summary box ───────────────────────────
    inv_type    = data.get("invoice_type", "")
    pay_methods = data.get("pay_methods", [])
    pay_str     = ", ".join(pay_methods) if pay_methods else "—"
    is_full_pay = inv_type in ("Final Payment", "Full Payment")

    def _fd(d):
        if not d: return "—"
        try: return datetime.fromisoformat(d).strftime("%d %B %Y")
        except: return d

    summary_rows = [
        [Paragraph(_tracked("PAYMENT FOR"),
                   st("sl", fontName=F_MED, fontSize=7, textColor=C_SUBTLE)),
         Paragraph(f"Invoice {inv_ref_display} — {inv_type}",
                   st("sv", fontName=F_REG, fontSize=9, textColor=C_BODY))],
        [Paragraph(_tracked("PAYMENT METHOD"),
                   st("ml2", fontName=F_MED, fontSize=7, textColor=C_SUBTLE)),
         Paragraph(pay_str,
                   st("mv2", fontName=F_REG, fontSize=9, textColor=C_BODY))],
    ]

    if is_full_pay and data.get("deposit_amt"):
        dep_amt  = data["deposit_amt"]
        bal_amt  = data.get("balance_paid", 0)
        dep_date = _fd(data.get("dep_date", ""))
        bal_date = _fd(data.get("bal_date", ""))
        summary_rows += [
            [Paragraph(_tracked("DEPOSIT PAID"),
                       st("dl", fontName=F_MED, fontSize=7, textColor=C_SUBTLE)),
             Paragraph(f"RM {dep_amt:,.2f}  ·  {dep_date}",
                       st("dv", fontName=F_REG, fontSize=9, textColor=C_BODY))],
            [Paragraph(_tracked("BALANCE PAID"),
                       st("bl", fontName=F_MED, fontSize=7, textColor=C_SUBTLE)),
             Paragraph(f"RM {bal_amt:,.2f}  ·  {bal_date}",
                       st("bv", fontName=F_REG, fontSize=9, textColor=C_BODY))],
        ]

    n_sum = len(summary_rows)
    sum_style = [
        ("BACKGROUND", (0,0),(-1,-1), C_ALT),
        ("TOPPADDING",    (0,0),(-1,-1), 10),
        ("BOTTOMPADDING", (0,0),(-1,-1), 10),
        ("LEFTPADDING",   (0,0),(-1,-1), 12),
        ("RIGHTPADDING",  (0,0),(-1,-1), 12),
        ("VALIGN",        (0,0),(-1,-1), "MIDDLE"),
    ] + [("LINEBELOW", (0,r),(-1,r), 0.5, C_RULE) for r in range(n_sum - 1)]
    summary_tbl = Table(summary_rows, colWidths=[usable * 0.30, usable * 0.70])
    summary_tbl.setStyle(TableStyle(sum_style))
    story.append(summary_tbl)
    story.append(Spacer(1, 8*mm))

    # ── 6. Amount received ────────────────────────────────
    amount_paid = data.get("amount_paid", 0) or 0
    amt_tbl = Table([[
        Paragraph(_tracked("AMOUNT RECEIVED"),
                  st("al", fontName=F_MED, fontSize=8, textColor=C_WHITE,
                     alignment=0, leading=11)),
        Paragraph(f"RM {amount_paid:,.2f}",
                  st("av", fontName=F_BLK, fontSize=22,
                     textColor=C_WHITE, alignment=2, leading=28)),
    ]], colWidths=[usable * 0.40, usable * 0.60])
    amt_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,-1), C_INK),
        ("LEFTPADDING",   (0,0),(0,0),   16),
        ("RIGHTPADDING",  (0,0),(0,0),   8),
        ("LEFTPADDING",   (1,0),(1,0),   8),
        ("RIGHTPADDING",  (1,0),(1,0),   16),
        ("TOPPADDING",    (0,0),(-1,-1), 14),
        ("BOTTOMPADDING", (0,0),(-1,-1), 14),
        ("VALIGN",        (0,0),(-1,-1), "MIDDLE"),
    ]))
    story.append(amt_tbl)
    story.append(Spacer(1, 12*mm))

    # ── 7. Thank you note ─────────────────────────────────
    story.append(Paragraph(
        "Thank you for your payment. This receipt confirms that the amount above "
        "has been received in full for the invoice referenced.",
        st("ty", fontName=F_REG, fontSize=9, textColor=C_MUTED, leading=14)
    ))
    story.append(Spacer(1, 14*mm))

    # ── 8. Signature area ────────────────────────────────
    sig = Table([[
        Table([
            [Paragraph("Authorised by",
                       st("sgl", fontName=F_MED, fontSize=7, textColor=C_SUBTLE))],
            [Spacer(1, 10*mm)],
            [HRFlowable(width=usable*0.38, color=C_RULE, thickness=0.5)],
            [Paragraph(co_name,
                       st("sgn", fontName=F_REG, fontSize=8, textColor=C_MUTED))],
        ], colWidths=[usable*0.45],
           style=TableStyle([("PADDING",(0,0),(-1,-1),0), ("VALIGN",(0,0),(-1,-1),"TOP")])),
        Paragraph("", st("sp")),
    ]], colWidths=[usable*0.5, usable*0.5])
    sig.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"), ("PADDING",(0,0),(-1,-1),0)]))
    story.append(sig)
    story.append(Spacer(1, 10*mm))

    # ── 9. Footer ─────────────────────────────────────────
    story.append(HRFlowable(width=usable, color=C_INK, thickness=1.5, spaceAfter=3*mm))
    fp_parts = [co_name]
    if co_email: fp_parts.append(co_email)
    if co_phone: fp_parts.append(co_phone)
    story.append(Paragraph(
        f"<font color='{HEX_SUBTLE}'>{'  ·  '.join(fp_parts)}</font>",
        st("ftr", fontName=F_REG, fontSize=7, textColor=C_SUBTLE, alignment=1)
    ))

    doc.build(story)
    buffer.seek(0)
    return buffer


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
        labels = {"quotation": "Opxio — Quotation PDF", "invoice": "Opxio — Invoice PDF", "receipt": "Opxio — Receipt PDF"}
        self._respond(200, {"service": labels[doc_type], "status": "ready"})

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
