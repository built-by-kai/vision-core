"""
create_quotation.py
POST /api/create_quotation

Called by a Notion button automation on either:
  - Leads CRM page  → payload: { "page_id": "<lead_page_id>", "source": "lead" }
  - Companies page  → payload: { "page_id": "<company_page_id>", "source": "company" }

Notion also wraps button payloads as:
  { "source": { "page_id": "...", "type": "page_mention" }, "data": {...} }
  or  { "data": { "page_id": "..." } }
  or just { "page_id": "..." }

The endpoint:
  1. Detects whether the triggering page is a Lead or a Company
  2. If Lead  → fetches linked Company + PIC, sets Lead relation on Quotation
  3. If Company → uses Company directly, no Lead linked
  4. Creates a new Quotation page in Quotations DB with:
       - Quotation No.  : auto (title left blank — Notion unique_id fills it)
       - Lead           : [lead page] (if from Lead)
       - Company        : [company page]
       - Status         : Draft
       - Quote Type     : derived from Lead's Package Type / Interest, else "New Business"
       - Issue Date     : today
       - Payment Terms  : 50% Deposit (default)
  5. Returns { "quotation_url": "...", "quotation_id": "..." }

DBs
───
Quotations  : f8167f0bda054307b90b17ad6b9c5cf8
Leads CRM   : 8690d55c4d0449068c51ef49d92a26a2
Companies   : 33c8b289e31a80fe82d2ccd18bcaec68
Products    : 33c8b289e31a80bebdf1ecd506e5ccc3
"""

import json
import os
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler

import requests

# ── DB IDs ────────────────────────────────────
QUOTATIONS_DB = "f8167f0bda054307b90b17ad6b9c5cf8"
LEADS_DB      = "8690d55c4d0449068c51ef49d92a26a2"
COMPANIES_DB  = "33c8b289e31a80fe82d2ccd18bcaec68"
PRODUCTS_DB   = "9d61639072364fb09eeccece94d082a7"  # Catalogue DB (rebuilt Apr 2026)

# Exact match: Package Type select value → Product slug in Products DB
# These match the option names set on Leads CRM Package Type field exactly.
# Slugs for which Base OS (RM 0, included) is auto-added as first line item
OS_PACKAGE_SLUGS = frozenset({
    "operations-os", "sales-os", "business-os", "business-os-phase", "starter-os"
})

PACKAGE_SLUG_MAP = {
    "operations os":              "operations-os",
    "sales os":                   "sales-os",
    "business os":                "business-os",
    "business os – phase by phase": "business-os-phase",
    "starter os":                 "starter-os",
}

# Fallback keyword map for Interest multi-select and legacy/partial matches
INTEREST_SLUG_MAP = {
    "operations os":                     "operations-os",
    "sales os":                          "sales-os",
    "business os":                       "business-os",
    "starter os":                        "starter-os",
    "additional module":                 "addon-system-module",
    "additional system module":          "addon-system-module",
    "automation (within":                "addon-automation-within",
    "automation (cross":                 "addon-automation-cross",
    "advanced dashboard":                "addon-dashboard",
    "custom widget":                     "addon-widget",
    "api / external integration":        "addon-api-integration",
    "automation & workflow integration": "addon-workflow-integration",
    "lead capture system":               "addon-lead-capture",
    "client portal view":                "addon-client-portal",
    "ai agent integration":              "addon-ai-agent",
}


# ── Helpers ───────────────────────────────────
def _hdrs():
    key = os.environ.get("NOTION_API_KEY", "")
    if not key:
        raise ValueError("NOTION_API_KEY not set")
    return {
        "Authorization":  f"Bearer {key}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


def _plain(arr):
    return "".join(t.get("plain_text", "") for t in (arr or []))


def get_page(page_id, hdrs):
    r = requests.get(f"https://api.notion.com/v1/pages/{page_id}",
                     headers=hdrs, timeout=15)
    r.raise_for_status()
    return r.json()


def detect_source(page_id, hdrs):
    """
    Return ("lead"|"company"|"unknown", props dict).
    A Lead page has a 'Stage' status property.
    A Company page has a 'Company' title property (key varies) and no Stage.
    """
    page  = get_page(page_id, hdrs)
    props = page.get("properties", {})

    if "Stage" in props and props["Stage"].get("type") == "status":
        return "lead", props
    # Check if it's a company: look for title field
    for v in props.values():
        if v.get("type") == "title":
            # Company pages have Company as title; Lead pages have Lead Name
            # If there's no Stage, it's a Company
            return "company", props
    return "unknown", props


def fetch_product_info(slug, hdrs):
    """
    Query Products DB for the given slug.
    Returns dict: {id, name, price, quote_type}.
    Falls back to safe defaults on any error.
    """
    default = {"id": None, "name": None, "price": None, "quote_type": "New Business"}
    try:
        r = requests.post(
            f"https://api.notion.com/v1/databases/{PRODUCTS_DB}/query",
            headers=hdrs,
            json={"filter": {"property": "Slug", "rich_text": {"equals": slug}}},
            timeout=10,
        )
        if r.ok:
            results = r.json().get("results", [])
            if results:
                p     = results[0]
                props = p.get("properties", {})
                qt    = (props.get("Quote Type", {}).get("select") or {}).get("name", "New Business")
                name  = _plain(props.get("Product Name", {}).get("title", []))
                price = props.get("Price", {}).get("number")
                pid   = p["id"].replace("-", "")
                print(f"[INFO] Product found: '{name}' slug='{slug}' quote_type='{qt}'", file=sys.stderr)
                desc = _plain(props.get("Description", {}).get("rich_text", []))
                return {"id": pid, "name": name, "price": price,
                        "quote_type": qt, "slug": slug, "description": desc}
        print(f"[WARN] No product found for slug '{slug}'", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] fetch_product_info: {e}", file=sys.stderr)
    return {"id": None, "name": None, "price": None, "quote_type": "New Business",
            "slug": None, "description": ""}


def find_line_items_db(page_id, hdrs, retries=4, wait_base=2):
    """
    Look for an existing child_database on the page (top-level and one level
    inside any callout blocks).  Retries up to `retries` times with exponential
    back-off to handle the brief delay after Notion applies a template.
    Returns db_id (str, no dashes) or None.
    """
    import time
    for attempt in range(retries):
        try:
            r = requests.get(f"https://api.notion.com/v1/blocks/{page_id}/children",
                             headers=hdrs, timeout=15)
            if r.ok:
                blocks = r.json().get("results", [])
                all_blocks = list(blocks)

                for block in blocks:
                    if block.get("type") == "callout":
                        try:
                            cr = requests.get(
                                f"https://api.notion.com/v1/blocks/{block['id']}/children",
                                headers=hdrs, timeout=10)
                            if cr.ok:
                                all_blocks.extend(cr.json().get("results", []))
                        except Exception:
                            pass

                for block in all_blocks:
                    if block.get("type") == "child_database":
                        db_id = block["id"].replace("-", "")
                        print(f"[INFO] Found existing DB on attempt {attempt+1}: {db_id}", file=sys.stderr)
                        return db_id

                print(f"[INFO] No child_database found yet (attempt {attempt+1}/{retries})", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] find_line_items_db attempt {attempt+1}: {e}", file=sys.stderr)

        if attempt < retries - 1:
            time.sleep(wait_base * (attempt + 1))

    return None


def create_line_items_db(page_id, hdrs):
    """
    Appends two blocks to the quotation page:
      1. A callout (no emoji, default background) with bold 'Products & Services'
         as its text — acts as a visual section header.
      2. An inline 'Products & Services' database directly on the page.
         NOTE: Notion's REST API only allows page_id as DB parent, so the DB
         cannot be nested inside the callout block programmatically.
    Returns db_id (str, no dashes) or raises on failure.
    """
    # ── 1. Callout header — no emoji, default background ─────────────────
    requests.patch(
        f"https://api.notion.com/v1/blocks/{page_id}/children",
        headers=hdrs,
        json={"children": [{
            "type": "callout",
            "callout": {
                "rich_text": [{
                    "type": "text",
                    "text": {"content": "Products & Services"},
                    "annotations": {"bold": True, "color": "default"},
                }],
                "icon":  None,
                "color": "default_background",
            },
        }]},
        timeout=15,
    )

    # ── 2. Inline DB on the page ─────────────────────────────────────────
    r = requests.post(
        "https://api.notion.com/v1/databases",
        headers=hdrs,
        json={
            "parent":    {"type": "page_id", "page_id": page_id},
            "is_inline": True,
            "title": [{"type": "text", "text": {"content": "Products & Services"}}],
            # Properties in desired column order.
            # Notes (title) is pinned first by Notion — user drags it to last once.
            "properties": {
                "Notes": {"title": {}},
                "Product": {
                    "relation": {
                        "database_id": PRODUCTS_DB,
                        "single_property": {},
                    }
                },
                "Description": {"rich_text": {}},
                "Unit Price":  {"number": {"format": "ringgit"}},
                "Qty":         {"number": {"format": "number"}},
                "Subtotal":    {"formula": {"expression": 'prop("Qty") * prop("Unit Price")'}},
            },
        },
        timeout=15,
    )

    if not r.ok:
        raise ValueError(f"Create DB failed {r.status_code}: {r.text[:300]}")

    db_id = r.json()["id"].replace("-", "")
    print(f"[INFO] Products & Services DB: {db_id}", file=sys.stderr)
    return db_id


def append_template_blocks(page_id, hdrs):
    """
    Appends the full quotation template content beneath the Products & Services DB:
      - spacer
      - Terms and Conditions (heading_2 + 4 numbered items)
      - divider
      - Acceptance (heading_2 + table)
      - divider
      - footer italic text
    Mirrors the existing 'New page' template in the Quotations DB exactly.
    """
    T = lambda content, **ann: {
        "type": "text",
        "text": {"content": content},
        **({"annotations": ann} if ann else {}),
    }

    blocks = [
        # spacer
        {"type": "paragraph", "paragraph": {"rich_text": []}},

        # Terms heading
        {"type": "heading_2", "heading_2": {
            "rich_text": [T("Terms and Conditions")],
            "is_toggleable": False,
        }},

        # T&C items
        {"type": "numbered_list_item", "numbered_list_item": {"rich_text": [
            T("This quotation is valid for "),
            T("30 days", bold=True),
            T(" from the issue date."),
        ]}},
        {"type": "numbered_list_item", "numbered_list_item": {"rich_text": [
            T("Payment terms as specified above. For 50-50 terms: 50% deposit before "
              "project commencement, 50% balance upon completion."),
        ]}},
        {"type": "numbered_list_item", "numbered_list_item": {"rich_text": [
            T("Scope changes after approval may result in revised pricing."),
        ]}},
        {"type": "numbered_list_item", "numbered_list_item": {"rich_text": [
            T("All prices are in "),
            T("MYR (RM)", bold=True),
            T(" and exclusive of SST unless stated otherwise."),
        ]}},

        # divider
        {"type": "divider", "divider": {}},

        # Acceptance heading
        {"type": "heading_2", "heading_2": {
            "rich_text": [T("Acceptance")],
            "is_toggleable": False,
        }},

        # Acceptance table — 2 cols, header row (empty), then 3 data rows
        {"type": "table", "table": {
            "table_width": 2,
            "has_column_header": True,
            "has_row_header":    False,
            "children": [
                # header row (empty labels)
                {"type": "table_row", "table_row": {"cells": [[], []]}},
                {"type": "table_row", "table_row": {"cells": [[T("Client Name", bold=True)], []]}},
                {"type": "table_row", "table_row": {"cells": [[T("Signature",   bold=True)], []]}},
                {"type": "table_row", "table_row": {"cells": [[T("Date",        bold=True)], []]}},
            ],
        }},

        # divider
        {"type": "divider", "divider": {}},

        # footer
        {"type": "paragraph", "paragraph": {
            "rich_text": [T("builtbykai — Prepared with care.", italic=True)],
        }},
    ]

    r = requests.patch(
        f"https://api.notion.com/v1/blocks/{page_id}/children",
        headers=hdrs, json={"children": blocks}, timeout=20,
    )
    if r.ok:
        print(f"[INFO] Template blocks appended", file=sys.stderr)
    else:
        print(f"[WARN] Template blocks {r.status_code}: {r.text[:200]}", file=sys.stderr)


def ensure_product_relation(db_id, hdrs):
    """
    Patch the 'Product' relation property on the Products & Services DB to point
    to the current Catalogue DB. Needed because the Notion template's inline DB
    still has the old relation target — this brings it up to date before any rows
    are inserted, so the Product name column and Catalog Price rollup work correctly.
    Non-fatal if it fails (rows are still created, just without the relation link).
    """
    r = requests.patch(
        f"https://api.notion.com/v1/databases/{db_id}",
        headers=hdrs,
        json={
            "properties": {
                "Product": {
                    "relation": {
                        "database_id": PRODUCTS_DB,
                        "single_property": {},
                    }
                }
            }
        },
        timeout=15,
    )
    if r.ok:
        print(f"[INFO] Product relation updated to Catalogue DB on {db_id[:8]}", file=sys.stderr)
    else:
        print(f"[WARN] Could not update Product relation: {r.status_code}: {r.text[:200]}", file=sys.stderr)


def create_line_item(db_id, product_id, product_name, price, hdrs, description=""):
    """
    Create a line item in the Products & Services DB.
    - Notes (title): left blank — the Product relation shows the name
    - Description: rich_text populated from Products DB description
    - Product: linked relation
    - Qty: 1
    - Unit Price: from catalog

    If the first attempt fails with 400 (e.g. the template DB doesn't have a
    Description column), retries once without the Description property.
    """
    props = {
        "Notes": {"title": []},    # blank — product name comes via relation
        "Qty":   {"number": 1},
    }
    if product_id:
        props["Product"] = {"relation": [{"id": product_id}]}
    if price is not None:
        props["Unit Price"] = {"number": float(price)}
    if description:
        props["Description"] = {"rich_text": [{"text": {"content": description}}]}

    r = requests.post(
        "https://api.notion.com/v1/pages",
        headers=hdrs,
        json={"parent": {"database_id": db_id}, "properties": props},
        timeout=15,
    )

    # Retry without Description if the DB schema doesn't have that column
    if not r.ok and r.status_code == 400 and description and "Description" in r.text:
        print(f"[WARN] Description column not found in DB, retrying without it", file=sys.stderr)
        props.pop("Description", None)
        r = requests.post(
            "https://api.notion.com/v1/pages",
            headers=hdrs,
            json={"parent": {"database_id": db_id}, "properties": props},
            timeout=15,
        )

    if not r.ok:
        print(f"[WARN] Line item create failed {r.status_code}: {r.text[:200]}", file=sys.stderr)
    else:
        print(f"[INFO] Line item created: '{product_name}' × 1 @ RM{price}", file=sys.stderr)
    return r.ok


def extract_lead_info(props, hdrs):
    """
    Pull Company, PIC relations, main product info, and confirmed add-on products
    from a Lead page.
    Returns (company_ids, pic_ids, product_dict, addon_products_list).
    addon_products_list is a list of product dicts fetched from Products DB.
    """
    company_ids = [r["id"].replace("-", "")
                   for r in props.get("Company", {}).get("relation", [])]

    # PIC — may be called "PIC", "Contact", "Person in Charge"
    pic_ids = []
    for field in ("PIC", "Contact", "Person in Charge"):
        pic_ids = [r["id"].replace("-", "")
                   for r in props.get(field, {}).get("relation", [])]
        if pic_ids:
            break

    # 1. Exact match on Package Type (primary OS package select)
    pkg_raw = (props.get("Package Type", {}).get("select") or {}).get("name", "").lower().strip()
    slug = PACKAGE_SLUG_MAP.get(pkg_raw)

    # 2. Fall back to first Interest item that matches (multi-select)
    if not slug:
        for item in props.get("Interest", {}).get("multi_select", []):
            key_lower = item.get("name", "").lower().strip()
            slug = INTEREST_SLUG_MAP.get(key_lower)
            if slug:
                break

    print(f"[INFO] Package Type='{pkg_raw}' → slug='{slug or 'not found'}'", file=sys.stderr)

    # 3. Fetch full product info from Products DB
    product = fetch_product_info(slug or "operations-os", hdrs)

    # 4. Read confirmed Add-ons multi-select → fetch product info for each
    addon_name_to_slug = {
        "additional system module":          "addon-system-module",
        "automation (within database)":      "addon-automation-within",
        "automation (cross-database)":       "addon-automation-cross",
        "advanced dashboard":                "addon-dashboard",
        "custom widget":                     "addon-widget",
        "api / external integration":        "addon-api-integration",
        "automation & workflow (make/n8n)":  "addon-workflow-integration",
        "lead capture system":               "addon-lead-capture",
        "client portal view":                "addon-client-portal",
        "ai agent integration":              "addon-ai-agent",
    }

    addon_products = []
    for item in props.get("Add-ons", {}).get("multi_select", []):
        addon_name_lower = item.get("name", "").lower().strip()
        addon_slug = addon_name_to_slug.get(addon_name_lower)
        if addon_slug:
            addon_info = fetch_product_info(addon_slug, hdrs)
            if addon_info.get("id"):
                addon_products.append(addon_info)
                print(f"[INFO] Add-on: '{addon_info['name']}' slug='{addon_slug}'", file=sys.stderr)

    return company_ids, pic_ids, product, addon_products


def create_quotation_page(lead_id, company_ids, quote_type, hdrs, package_name=None, pic_ids=None):
    """Create a new Quotation page and return its id + Notion URL."""
    today = date.today().isoformat()

    # ── Step 1: create with safe core properties only ──
    props = {
        # Title left blank — Notion unique_id auto-generates Quotation No.
        "Quotation No.": {"title": [{"text": {"content": ""}}]},
        "Status":        {"status": {"name": "Draft"}},
        "Issue Date":    {"date": {"start": today}},
        "Payment Terms": {"select": {"name": "50% Deposit"}},
    }
    if package_name:
        props["Package Type"] = {"rich_text": [{"text": {"content": package_name}}]}

    if company_ids:
        props["Company"] = {"relation": [{"id": cid} for cid in company_ids[:1]]}

    if pic_ids:
        props["PIC"] = {"relation": [{"id": pid} for pid in pic_ids[:1]]}

    body = {
        "parent":     {"database_id": QUOTATIONS_DB},
        "properties": props,
    }

    r = requests.post("https://api.notion.com/v1/pages",
                      headers=hdrs, json=body, timeout=15)
    if not r.ok:
        raise ValueError(f"Notion create page {r.status_code}: {r.text[:400]}")

    page    = r.json()
    page_id = page["id"].replace("-", "")
    url     = page.get("url", f"https://notion.so/{page_id}")
    print(f"[INFO] Quotation page created: {page_id}", file=sys.stderr)

    # ── Step 2: patch Quote Type + Package Type ──
    try:
        patch_props = {"Quote Type": {"select": {"name": quote_type}}}
        pr = requests.patch(f"https://api.notion.com/v1/pages/{page_id}",
                            headers=hdrs,
                            json={"properties": patch_props}, timeout=10)
        if not pr.ok:
            print(f"[WARN] Quote Type patch failed: {pr.text[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] Quote Type patch error: {e}", file=sys.stderr)

    # ── Step 3: patch Deal Source relation (may be named differently) ──
    if lead_id:
        linked = False
        for field_name in ("Deal Source", "Lead", "Deals", "Source"):
            try:
                pr = requests.patch(
                    f"https://api.notion.com/v1/pages/{page_id}",
                    headers=hdrs,
                    json={"properties": {field_name: {"relation": [{"id": lead_id}]}}},
                    timeout=10,
                )
                if pr.ok:
                    print(f"[INFO] Lead linked via field '{field_name}'", file=sys.stderr)
                    linked = True
                    break
                else:
                    print(f"[WARN] Field '{field_name}' failed: {pr.status_code}", file=sys.stderr)
            except Exception as e:
                print(f"[WARN] Lead link error ({field_name}): {e}", file=sys.stderr)
        if not linked:
            print(f"[WARN] Could not link Lead — check property name on Quotations DB", file=sys.stderr)

    return page_id, url




def find_recent_quotation(lead_id, hdrs, max_age_seconds=120):
    """
    Query the Quotations DB for the most recently created page whose
    Deal Source relation includes `lead_id`, created within the last
    `max_age_seconds` seconds (default 2 minutes).

    Retries up to 4 times with increasing back-off to handle the brief
    delay between the Notion button creating the page and the webhook
    arriving.

    Returns (page_id_no_dashes, notion_url) or (None, None).
    """
    import time
    from datetime import datetime, timezone

    for attempt in range(4):
        try:
            r = requests.post(
                f"https://api.notion.com/v1/databases/{QUOTATIONS_DB}/query",
                headers=hdrs,
                json={
                    "filter": {
                        "property": "Deal Source",
                        "relation": {"contains": lead_id},
                    },
                    "sorts": [{"timestamp": "created_time", "direction": "descending"}],
                    "page_size": 1,
                },
                timeout=10,
            )
            if r.ok:
                results = r.json().get("results", [])
                if results:
                    page = results[0]
                    created_dt = datetime.fromisoformat(
                        page["created_time"].replace("Z", "+00:00")
                    )
                    age = (datetime.now(timezone.utc) - created_dt).total_seconds()
                    print(f"[INFO] Candidate quotation age: {age:.1f}s (limit {max_age_seconds}s)", file=sys.stderr)
                    if age <= max_age_seconds:
                        pid = page["id"].replace("-", "")
                        url = page.get("url", f"https://notion.so/{pid}")
                        print(f"[INFO] Found recent Notion-created quotation: {pid}", file=sys.stderr)
                        return pid, url
                    else:
                        print(f"[INFO] Quotation too old ({age:.0f}s), will create new", file=sys.stderr)
                        return None, None
            else:
                print(f"[WARN] find_recent_quotation query {r.status_code}: {r.text[:200]}", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] find_recent_quotation attempt {attempt+1}: {e}", file=sys.stderr)

        if attempt < 3:
            time.sleep(2 * (attempt + 1))   # 2s, 4s, 6s

    return None, None


def _patch_prop(page_id, label, prop_dict, hdrs):
    """Patch a single property on a Notion page. Logs success/failure per field."""
    try:
        r = requests.patch(
            f"https://api.notion.com/v1/pages/{page_id}",
            headers=hdrs,
            json={"properties": prop_dict},
            timeout=10,
        )
        if r.ok:
            print(f"[INFO] Patched '{label}' on {page_id[:8]}", file=sys.stderr)
        else:
            print(f"[WARN] Patch '{label}' failed {r.status_code}: {r.text[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] Patch '{label}' error: {e}", file=sys.stderr)


def patch_quotation_props(page_id, company_ids, quote_type, lead_id, hdrs,
                          package_name=None, pic_ids=None):
    """
    Patch properties of an existing quotation page one field at a time so a
    single bad property name/type cannot block all the others.
    """
    today = date.today().isoformat()

    # Core date + payment fields
    _patch_prop(page_id, "Issue Date",
                {"Issue Date": {"date": {"start": today}}}, hdrs)
    _patch_prop(page_id, "Payment Terms",
                {"Payment Terms": {"select": {"name": "50% Deposit"}}}, hdrs)

    # Status — try both status type and select type (DB may vary)
    r = requests.patch(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=hdrs,
        json={"properties": {"Status": {"status": {"name": "Draft"}}}},
        timeout=10,
    )
    if not r.ok:
        # fallback: some DBs use select for Status
        requests.patch(
            f"https://api.notion.com/v1/pages/{page_id}",
            headers=hdrs,
            json={"properties": {"Status": {"select": {"name": "Draft"}}}},
            timeout=10,
        )
    print(f"[INFO] Status patch attempted on {page_id[:8]}", file=sys.stderr)

    # Quote Type
    if quote_type:
        _patch_prop(page_id, "Quote Type",
                    {"Quote Type": {"select": {"name": quote_type}}}, hdrs)

    # Package Type (rich_text)
    if package_name:
        _patch_prop(page_id, "Package Type",
                    {"Package Type": {"rich_text": [{"text": {"content": package_name}}]}}, hdrs)

    # Company relation
    if company_ids:
        _patch_prop(page_id, "Company",
                    {"Company": {"relation": [{"id": cid} for cid in company_ids[:1]]}}, hdrs)

    # PIC relation
    if pic_ids:
        _patch_prop(page_id, "PIC",
                    {"PIC": {"relation": [{"id": pid} for pid in pic_ids[:1]]}}, hdrs)

    # Deal Source relation (idempotent — already set by Notion button but patch to be safe)
    if lead_id:
        _patch_prop(page_id, "Deal Source",
                    {"Deal Source": {"relation": [{"id": lead_id}]}}, hdrs)


def process(payload):
    hdrs = _hdrs()

    # ── Parse page_id from various Notion webhook shapes ──
    raw_page_id = None

    # Shape 1: { "source": { "page_id": "..." } }
    source = payload.get("source") or {}
    if isinstance(source, dict):
        raw_page_id = source.get("page_id") or source.get("id")

    # Shape 2: { "data": { "page_id": "..." } }
    if not raw_page_id:
        data = payload.get("data") or {}
        if isinstance(data, dict):
            raw_page_id = data.get("page_id") or data.get("id")

    # Shape 3: flat { "page_id": "..." }
    if not raw_page_id:
        raw_page_id = payload.get("page_id") or payload.get("id")

    if not raw_page_id:
        raise ValueError("No page_id found in payload")

    page_id = raw_page_id.replace("-", "")
    print(f"[INFO] Triggering page: {page_id}", file=sys.stderr)

    # ── Detect Lead vs Company ─────────────────
    # Allow caller to hint via "source" string key (separate from source object)
    hint = payload.get("type", "")  # "lead" or "company" if explicitly set

    if hint == "lead":
        source_type = "lead"
        props = get_page(page_id, hdrs).get("properties", {})
    elif hint == "company":
        source_type = "company"
        props = get_page(page_id, hdrs).get("properties", {})
    else:
        source_type, props = detect_source(page_id, hdrs)

    print(f"[INFO] Detected source type: {source_type}", file=sys.stderr)

    # ── Build quotation fields ─────────────────
    lead_id     = None
    company_ids = []
    pic_ids     = []
    product     = {"id": None, "name": None, "price": None, "quote_type": "New Business"}

    if source_type == "lead":
        lead_id = page_id
        company_ids, pic_ids, product, addon_products = extract_lead_info(props, hdrs)
        print(f"[INFO] Lead → Companies: {company_ids}, PIC: {pic_ids}, Product: {product['name']}, Quote Type: {product['quote_type']}, Add-ons: {[a['name'] for a in addon_products]}", file=sys.stderr)

    elif source_type == "company":
        company_ids  = [page_id]
        addon_products = []
        print(f"[INFO] Company: {page_id}", file=sys.stderr)

    quote_type = product["quote_type"]

    # ── Find or Create Quotation page ────────────────────────────────────────
    # NEW ARCHITECTURE:
    #   When the Notion button fires it does two actions in sequence:
    #     1. "Add page in Quotations DB" (template auto-applied, Deal Source pre-set)
    #     2. "Send webhook" → this endpoint
    #
    #   We first try to find that Notion-created page (it will have our lead linked
    #   and be very recent).  If found we patch its properties and populate line items
    #   into the template's existing Products & Services DB (inside the callout).
    #
    #   If NOT found (e.g. webhook fired from a different trigger, or the button
    #   action didn't create a page), we fall back to creating a new page ourselves
    #   and building the DB from scratch — same as the old behaviour.

    found_via_notion = False

    package_name = product.get("name") if source_type == "lead" else None

    if source_type == "lead" and lead_id:
        quot_id, quot_url = find_recent_quotation(lead_id, hdrs)
        if quot_id:
            found_via_notion = True
            print(f"[INFO] Using Notion-created quotation: {quot_id}", file=sys.stderr)
            patch_quotation_props(quot_id, company_ids, quote_type, lead_id, hdrs,
                                  package_name=package_name, pic_ids=pic_ids)

    if not found_via_notion:
        quot_id, quot_url = create_quotation_page(lead_id, company_ids, quote_type, hdrs,
                                                   package_name=package_name, pic_ids=pic_ids)
        print(f"[INFO] Created new Quotation: {quot_id} → {quot_url}", file=sys.stderr)

    # ── Auto-populate line items ──────────────────────────────────────────────
    if source_type == "lead" and product.get("id"):
        try:
            # find_line_items_db() now retries with back-off to handle template
            # propagation delay when the page was created by the Notion button.
            li_db_id = find_line_items_db(quot_id, hdrs)

            if not li_db_id:
                if found_via_notion:
                    # Template should have supplied the DB — log a warning but
                    # still try to create one so the quotation isn't empty.
                    print(f"[WARN] Template DB not found after retries — creating fallback DB", file=sys.stderr)
                li_db_id = create_line_items_db(quot_id, hdrs)

            # Ensure the Product relation points to the current Catalogue DB.
            # The Notion template's inline DB may still reference the old DB.
            ensure_product_relation(li_db_id, hdrs)

            # Create Base OS FIRST (gets No. 1) so it has the lowest row number.
            # The template DB should be sorted ascending by No., making No. 1
            # appear at the top.  Main product is created second (No. 2).
            if product.get("slug") in OS_PACKAGE_SLUGS:
                base = fetch_product_info("base-os", hdrs)
                if base.get("id"):
                    create_line_item(li_db_id, base["id"], base["name"],
                                     base["price"], hdrs,
                                     description=base.get("description", ""))

            create_line_item(li_db_id, product["id"], product["name"],
                             product["price"], hdrs,
                             description=product.get("description", ""))

            # Add confirmed add-on line items (No. 3, 4, 5…)
            for addon in addon_products:
                create_line_item(li_db_id, addon["id"], addon["name"],
                                 addon["price"], hdrs,
                                 description=addon.get("description", ""))
                print(f"[INFO] Add-on line item added: {addon['name']}", file=sys.stderr)

        except Exception as e:
            # Non-fatal — quotation still exists, user can add line items manually
            print(f"[WARN] Auto line item failed: {e}", file=sys.stderr)

    # ── Advance Lead stage → Proposed ────────────────────────────────────────
    if lead_id:
        try:
            requests.patch(
                f"https://api.notion.com/v1/pages/{lead_id}",
                headers=hdrs,
                json={"properties": {"Stage": {"status": {"name": "Proposed"}}}},
                timeout=10,
            )
            print(f"[INFO] Lead {lead_id[:8]} → Proposed", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] Stage advance to Proposed: {e}", file=sys.stderr)

    return {
        "status":          "success",
        "source_type":     source_type,
        "quotation_id":    quot_id,
        "quotation_url":   quot_url,
        "quote_type":      quote_type,
        "lead_id":         lead_id,
        "company_ids":     company_ids,
        "line_item":       product.get("name"),
        "addons":          [a["name"] for a in addon_products],
        "found_via_notion": found_via_notion,
    }


# ── Phases DB one-time setup ──────────────────────────────────────────────────

PROJECTS_DB = "5719b2672d3442a29a22637a35398260"

def run_phases_setup(hdrs):
    """
    Creates the Phases DB (if not present) and patches Projects DB with
    Start Date, Target End Date, Add-on Value (RM), and a Phases relation.
    Safe to re-run — only adds missing fields.
    """
    # Search for existing Phases DB
    phases_db_id = None
    sr = requests.post(
        "https://api.notion.com/v1/search",
        headers=hdrs,
        json={"query": "Phases", "filter": {"value": "database", "property": "object"}},
        timeout=10,
    )
    if sr.ok:
        for result in sr.json().get("results", []):
            title = "".join(t.get("plain_text", "") for t in result.get("title", []))
            if title.strip().lower() in ("phases", "project phases"):
                phases_db_id = result["id"].replace("-", "")
                break

    already_existed = bool(phases_db_id)

    if not phases_db_id:
        # Find parent page of Projects DB
        dr = requests.get(
            f"https://api.notion.com/v1/databases/{PROJECTS_DB}",
            headers=hdrs, timeout=10
        )
        dr.raise_for_status()
        parent = dr.json().get("parent", {})
        parent_id = (parent.get("page_id") or parent.get("block_id") or "").replace("-", "")
        if not parent_id:
            raise ValueError("Could not determine parent page for Phases DB")

        # Create Phases DB
        cr = requests.post(
            "https://api.notion.com/v1/databases",
            headers=hdrs,
            json={
                "parent":    {"type": "page_id", "page_id": parent_id},
                "is_inline": False,
                "title": [{"type": "text", "text": {"content": "Phases"}}],
                "icon": {"type": "emoji", "emoji": "🗂️"},
                "properties": {
                    "Phase Name": {"title": {}},
                    "Project": {
                        "relation": {
                            "database_id": PROJECTS_DB,
                            "single_property": {},
                        }
                    },
                    "Status": {
                        "select": {"options": [
                            {"name": "Not Started", "color": "gray"},
                            {"name": "In Progress", "color": "blue"},
                            {"name": "Review",      "color": "yellow"},
                            {"name": "Done",        "color": "green"},
                            {"name": "On Hold",     "color": "orange"},
                        ]}
                    },
                    "Phase No.":    {"number": {"format": "number"}},
                    "Start Date":   {"date": {}},
                    "Due Date":     {"date": {}},
                    "Deliverables": {"rich_text": {}},
                    "Notes":        {"rich_text": {}},
                },
            },
            timeout=20,
        )
        cr.raise_for_status()
        phases_db_id = cr.json()["id"].replace("-", "")
        print(f"[INFO] Phases DB created: {phases_db_id}", file=sys.stderr)

    # Patch Projects DB with new tracking fields
    schema_r = requests.get(
        f"https://api.notion.com/v1/databases/{PROJECTS_DB}",
        headers=hdrs, timeout=10
    )
    schema_r.raise_for_status()
    existing = set(schema_r.json().get("properties", {}).keys())

    new_props = {}
    if "Start Date"      not in existing: new_props["Start Date"]      = {"date": {}}
    if "Target End Date" not in existing: new_props["Target End Date"] = {"date": {}}
    if "Add-on Value"    not in existing: new_props["Add-on Value"]    = {"number": {"format": "ringgit"}}
    if "Phases"          not in existing:
        new_props["Phases"] = {
            "relation": {
                "database_id": phases_db_id,
                "single_property": {},
            }
        }
    # Deals = two-way relation back to Leads CRM (the deal that spawned this project)
    if "Deals" not in existing:
        new_props["Deals"] = {
            "relation": {
                "database_id": LEADS_DB,
                "single_property": {},
            }
        }

    added_fields = []
    if new_props:
        pr = requests.patch(
            f"https://api.notion.com/v1/databases/{PROJECTS_DB}",
            headers=hdrs, json={"properties": new_props}, timeout=15
        )
        if pr.ok:
            added_fields = list(new_props.keys())
            print(f"[INFO] Projects DB updated: {added_fields}", file=sys.stderr)
        else:
            # Try adding fields one at a time in case one causes a conflict
            for fname, fdef in new_props.items():
                try:
                    single = requests.patch(
                        f"https://api.notion.com/v1/databases/{PROJECTS_DB}",
                        headers=hdrs, json={"properties": {fname: fdef}}, timeout=15
                    )
                    if single.ok:
                        added_fields.append(fname)
                        print(f"[INFO] Added '{fname}' to Projects DB", file=sys.stderr)
                    else:
                        print(f"[WARN] Could not add '{fname}': {single.text[:150]}", file=sys.stderr)
                except Exception as fe:
                    print(f"[WARN] Field '{fname}': {fe}", file=sys.stderr)

    return {
        "status":          "success",
        "phases_db_id":    phases_db_id,
        "phases_db_url":   f"https://notion.so/{phases_db_id}",
        "already_existed": already_existed,
        "fields_added_to_projects_db": added_fields,
    }


# ── Add-on quotation (triggered from Project page) ────────────────────────────

def process_addon(payload):
    """
    Creates a new Draft Quotation linked to an existing Project page.
    Payload: { "type": "addon", "page_id": "<project_page_id>" }
    """
    hdrs = _hdrs()

    # Parse project_id
    raw_id = None
    source = payload.get("source") or {}
    if isinstance(source, dict):
        raw_id = source.get("page_id") or source.get("id")
    if not raw_id:
        data = payload.get("data") or {}
        if isinstance(data, dict):
            raw_id = data.get("page_id") or data.get("id")
    if not raw_id:
        raw_id = payload.get("page_id") or payload.get("id")
    if not raw_id:
        raise ValueError("No page_id found in addon payload")

    project_id = raw_id.replace("-", "")
    print(f"[INFO] Add-on for Project: {project_id}", file=sys.stderr)

    # Fetch project → Company, Lead, Package
    pr = requests.get(
        f"https://api.notion.com/v1/pages/{project_id}",
        headers=hdrs, timeout=15
    )
    pr.raise_for_status()
    props = pr.json().get("properties", {})

    company_ids = [
        r["id"].replace("-", "")
        for r in props.get("Company", {}).get("relation", [])
    ]
    lead_ids = []
    for field in ("Deal Source", "Lead", "PIC", "Deals"):
        rels = props.get(field, {}).get("relation", [])
        if rels:
            lead_ids = [r["id"].replace("-", "") for r in rels]
            break
    package = (props.get("Package", {}).get("select") or {}).get("name", "New Business")
    project_name = _plain(props.get("Project Name", {}).get("title", []))

    # Create add-on quotation
    today = date.today().isoformat()
    quo_props = {
        "Quotation No.": {"title": [{"text": {"content": ""}}]},
        "Status":        {"select": {"name": "Draft"}},
        "Issue Date":    {"date": {"start": today}},
        "Payment Terms": {"select": {"name": "Full Upfront"}},
        "Quote Type":    {"select": {"name": package}},
        "Package Type":  {"rich_text": [{"text": {"content": "Add-on"}}]},
    }
    if company_ids:
        quo_props["Company"] = {"relation": [{"id": cid} for cid in company_ids[:1]]}
    try:
        quo_props["Project"] = {"relation": [{"id": project_id}]}
    except Exception:
        pass

    # Try with lead field, fall back without
    created = False
    quot_id = quot_url = None
    for field_name in ((lead_ids and ["Deal Source", "Lead", "Deals"]) or [None]):
        try:
            test = dict(quo_props)
            if field_name and lead_ids:
                test[field_name] = {"relation": [{"id": lead_ids[0]}]}
            r = requests.post(
                "https://api.notion.com/v1/pages",
                headers=hdrs,
                json={"parent": {"database_id": QUOTATIONS_DB}, "properties": test},
                timeout=15,
            )
            if r.ok:
                page     = r.json()
                quot_id  = page["id"].replace("-", "")
                quot_url = page.get("url", f"https://notion.so/{quot_id}")
                created  = True
                break
        except Exception as e:
            print(f"[WARN] add-on create ({field_name}): {e}", file=sys.stderr)

    if not created:
        r = requests.post(
            "https://api.notion.com/v1/pages",
            headers=hdrs,
            json={"parent": {"database_id": QUOTATIONS_DB}, "properties": quo_props},
            timeout=15,
        )
        r.raise_for_status()
        page     = r.json()
        quot_id  = page["id"].replace("-", "")
        quot_url = page.get("url", f"https://notion.so/{quot_id}")

    # Blank Products & Services DB on the add-on quotation
    try:
        li_db = create_line_items_db(quot_id, hdrs)
        print(f"[INFO] Add-on P&S DB: {li_db}", file=sys.stderr)
    except Exception as e:
        print(f"[WARN] Add-on P&S DB: {e}", file=sys.stderr)

    print(f"[INFO] Add-on quotation created: {quot_id}", file=sys.stderr)
    return {
        "status":        "success",
        "type":          "addon",
        "project_id":    project_id,
        "project_name":  project_name,
        "quotation_id":  quot_id,
        "quotation_url": quot_url,
        "note":          "Fill in add-on line items in Notion, then set Status → Approved to auto-generate Supplementary invoice",
    }


# ── Vercel handler ────────────────────────────
class handler(BaseHTTPRequestHandler):

    def _respond(self, code, body_dict):
        body = json.dumps(body_dict).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)

        # GET ?setup=1  →  one-time Phases DB + Projects DB fields setup
        if "setup" in qs:
            if not os.environ.get("NOTION_API_KEY"):
                self._respond(500, {"error": "NOTION_API_KEY not set"}); return
            try:
                result = run_phases_setup(_hdrs())
                self._respond(200, result)
            except Exception as e:
                import traceback; traceback.print_exc(file=sys.stderr)
                self._respond(500, {"error": str(e)})
            return

        self._respond(200, {
            "service": "Vision Core — Create Quotation",
            "status":  "ready",
            "usage":   (
                "POST {page_id} from Lead/Company — or {page_id, type:'addon'} from Project. "
                "GET ?setup=1 for one-time Phases DB setup."
            ),
        })

    def do_POST(self):
        try:
            length  = int(self.headers.get("Content-Length", 0))
            raw     = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw) if raw else {}

            print(f"[DEBUG] create_quotation payload: {json.dumps(payload)[:400]}", file=sys.stderr)

            if payload.get("type") == "addon":
                result = process_addon(payload)
            else:
                result = process(payload)
            self._respond(200, result)

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._respond(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[HTTP] {fmt % args}", file=sys.stderr)

