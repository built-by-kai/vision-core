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


def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def _fmt_address(addr):
    """Format a long address string into 2-3 tidy lines for the PDF."""
    if not addr:
        return ""
    import re
    if "\n" in addr:
        return addr.replace("\n", "<br/>")
    addr = re.sub(r",\s*(\d{5}\b)", r"<br/>\1", addr, count=1)
    if "<br/>" not in addr:
        parts = [p.strip() for p in addr.split(",")]
        if len(parts) >= 4:
            mid = len(parts) // 2
            addr = ", ".join(parts[:mid]) + "<br/>" + ", ".join(parts[mid:])
    return addr


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
            "payment_method":      _v("Payment Method") or "Bank Transfer",
        }
    except Exception as e:
        print(f"[WARN] company details: {e}", file=sys.stderr)
        return {}


# ─────────────────────────────────────────────
#  Auto-numbering
# ─────────────────────────────────────────────
# Invoice type → suffix mapping
INV_SUFFIX = {
    "Deposit":       "-D",
    "Supplementary": "-S",
    "Final Payment": "-F",
    "Retainer":      "-R",
    "Full Payment":  "",   # no suffix — it's the only invoice
}

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
    total_amount  = props.get("Amount", {}).get("number") or 0
    deposit_paid     = props.get("Deposit Due (50%)", {}).get("number") or 0
    payment_balance  = props.get("Payment Balance", {}).get("number") or 0

    # Due date: use Deposit Due for Deposit invoices, else Balance Due
    dep_date = (props.get("Deposit Due", {}).get("date") or {}).get("start", "")
    bal_date = (props.get("Balance Due", {}).get("date") or {}).get("start", "")
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

    # ── PIC (rollup of Primary Contact relation, or direct relation) ──
    pic_name = pic_email = ""
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
        "company_id":       company_id,
        "pic_name":         pic_name,
        "pic_email":        pic_email,
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
            "Payment Balance":  {"number": pay_balance},
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
            _fmt_address(data["company_address"]),
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
class handler(BaseHTTPRequestHandler):

    def _respond(self, code, body_dict):
        body = json.dumps(body_dict).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        qs = parse_qs(urlparse(self.path).query)

        # ?schema=true&page_id=<invoice_page_id>  → dump that page's property names/types
        if "schema" in qs:
            api_key = os.environ.get("NOTION_API_KEY", "")
            hdrs = {
                "Authorization":  f"Bearer {api_key}",
                "Notion-Version": "2022-06-28",
                "Content-Type":   "application/json",
            }
            page_id = (qs.get("page_id") or [None])[0]
            if page_id:
                page_id = page_id.replace("-", "")
                try:
                    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                                     headers=hdrs, timeout=15)
                    r.raise_for_status()
                    props = r.json().get("properties", {})
                    schema = {k: v.get("type") for k, v in props.items()}
                    # Also fetch parent DB schema
                    db_id = (r.json().get("parent") or {}).get("database_id", "").replace("-", "")
                    db_schema = {}
                    if db_id:
                        dr = requests.get(f"https://api.notion.com/v1/databases/{db_id}",
                                          headers=hdrs, timeout=10)
                        if dr.ok:
                            db_schema = {k: v.get("type") for k, v in dr.json().get("properties", {}).items()}
                    self._respond(200, {"page_properties": schema, "db_schema": db_schema})
                    return
                except Exception as e:
                    self._respond(500, {"error": str(e)}); return
            # No page_id — just return Invoice DB schema
            INVOICE_DB = "9227dda9c4be42a1a4c6b1bce4862f8c"
            try:
                dr = requests.get(f"https://api.notion.com/v1/databases/{INVOICE_DB}",
                                  headers=hdrs, timeout=10)
                dr.raise_for_status()
                schema = {k: v.get("type") for k, v in dr.json().get("properties", {}).items()}
                self._respond(200, schema); return
            except Exception as e:
                self._respond(500, {"error": str(e)}); return

        # ?test=1&page_id=<invoice_page_id>  → run full flow and show detailed result/error
        if "test" in qs:
            page_id = (qs.get("page_id") or [None])[0]
            if not page_id:
                self._respond(400, {"error": "Missing page_id"}); return
            page_id = page_id.replace("-", "")
            api_key = os.environ.get("NOTION_API_KEY", "")
            hdrs = {
                "Authorization":  f"Bearer {api_key}",
                "Notion-Version": "2022-06-28",
                "Content-Type":   "application/json",
            }
            try:
                # Step 1: fetch raw page
                raw = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                                   headers=hdrs, timeout=15)
                if not raw.ok:
                    self._respond(500, {
                        "step": "fetch_page",
                        "status": raw.status_code,
                        "body": raw.text[:500],
                    }); return
                props = raw.json().get("properties", {})
                prop_summary = {k: v.get("type") for k, v in props.items()}

                # Step 2: parse key fields
                total_amount = props.get("Amount", {}).get("number") or 0
                deposit_paid = props.get("Deposit Due (50%)", {}).get("number") or 0
                invoice_type = (props.get("Invoice Type", {}).get("select") or {}).get("name", "")
                status       = (props.get("Status", {}).get("select") or {}).get("name", "")
                quotation_rel = props.get("Quotation", {}).get("relation", [])
                pic_rel       = props.get("PIC", {}).get("relation", [])
                company_rel   = props.get("Company", {}).get("relation", [])

                self._respond(200, {
                    "page_id":       page_id,
                    "properties":    prop_summary,
                    "invoice_type":  invoice_type,
                    "status":        status,
                    "total_amount":  total_amount,
                    "deposit_paid":  deposit_paid,
                    "quotation_rel": quotation_rel,
                    "pic_rel":       pic_rel,
                    "company_rel":   company_rel,
                    "note": "All fields parsed OK. Try POST to generate the PDF."
                })
            except Exception as e:
                import traceback; tb = traceback.format_exc()
                self._respond(500, {"error": str(e), "trace": tb[-800:]})
            return

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

            step = "fetch_invoice_data (pre)"
            _pre = fetch_invoice_data(page_id, hdrs)
            print(f"[INFO] Step OK: {step}", file=sys.stderr)

            step = "activate_invoice"
            activate_invoice(
                page_id,
                total_amount  = float(_pre.get("total_amount", 0) or 0),
                deposit_paid  = float(_pre.get("deposit_paid", 0) or 0),
                invoice_type  = _pre.get("invoice_type", ""),
                hdrs          = hdrs,
            )
            print(f"[INFO] Step OK: {step}", file=sys.stderr)

            step = "fetch_invoice_data (post-activate)"
            data = fetch_invoice_data(page_id, hdrs)
            print(f"[INFO] Step OK: {step} — invoice_no={data.get('invoice_no')}", file=sys.stderr)

            step = "generate_pdf"
            pdf_buffer, amount_due = generate_pdf(data)
            print(f"[INFO] Step OK: {step} — amount_due={amount_due}", file=sys.stderr)

            safe     = (data["invoice_no"]
                        .replace(" ", "-").replace("/", "-").replace("\\", "-"))
            filename = f"invoices/{safe}.pdf"

            step = "upload_to_blob"
            pdf_url = upload_to_blob(pdf_buffer, filename)
            print(f"[INFO] Step OK: {step} — url={pdf_url[:60]}", file=sys.stderr)

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

            step = "update_notion_invoice"
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
            self._respond(500, {"error": str(e), "failed_at_step": locals().get("step", "unknown")})

    def log_message(self, format, *args):
        print(f"[HTTP] {format % args}", file=sys.stderr)
