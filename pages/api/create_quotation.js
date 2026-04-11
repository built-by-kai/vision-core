// ─── create_quotation.js ───────────────────────────────────────────────────
// POST /api/create_quotation   { "page_id": "<lead_or_company_page_id>" }
// Triggered by Notion button on a Lead CRM page.
//
// 1. Detect whether source page is a Lead or Company
// 2. Find recently Notion-created quotation (from button action 1) OR create new one
// 3. Patch quotation properties (dates, terms, quote type, company, PIC)
// 4. Auto-populate line items (Base OS + main product)
// 5. Advance Lead stage → Proposed
//
// DBs: Quotations, Leads CRM, Companies, Catalogue (Products)

import { getPage, patchPage, createPage, queryDB, plain, DB } from "../../lib/notion"


function hdrs() {
  return {
    Authorization:    `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": "2022-06-28",
    "Content-Type":   "application/json",
  }
}

// ── Package slug maps ──────────────────────────────────────────────────────
const PACKAGE_SLUG_MAP = {
  "operations os":                  "operations-os",
  "sales os":                       "sales-os",
  "business os":                    "business-os",
  "business os – phase by phase":   "business-os-phase",
  "starter os":                     "starter-os",
}

const INTEREST_SLUG_MAP = {
  "operations os":                      "operations-os",
  "sales os":                           "sales-os",
  "business os":                        "business-os",
  "starter os":                         "starter-os",
  "additional module":                  "addon-system-module",
  "additional system module":           "addon-system-module",
  "automation (within":                 "addon-automation-within",
  "automation (cross":                  "addon-automation-cross",
  "advanced dashboard":                 "addon-dashboard",
  "custom widget":                      "addon-widget",
  "api / external integration":         "addon-api-integration",
  "automation & workflow integration":  "addon-workflow-integration",
  "lead capture system":                "addon-lead-capture",
  "client portal view":                 "addon-client-portal",
  "ai agent integration":               "addon-ai-agent",
}

const OS_PACKAGE_SLUGS = new Set([
  "operations-os", "sales-os", "business-os", "business-os-phase", "starter-os"
])

// ── Detect source type ─────────────────────────────────────────────────────
async function detectSource(pageId) {
  const page  = await getPage(pageId, process.env.NOTION_API_KEY)
  const props = page.properties
  if (props.Stage?.type === "status") return { type: "lead", props }
  return { type: "company", props }
}

// ── Fetch product info from Catalogue DB ──────────────────────────────────
async function fetchProductInfo(slug) {
  if (!slug) return null
  try {
    const rows = await queryDB(DB.CATALOGUE, {
      property: "Slug", rich_text: { equals: slug }
    }, process.env.NOTION_API_KEY)
    if (!rows.length) return null
    const p     = rows[0]
    const props = p.properties
    return {
      id:         p.id.replace(/-/g, ""),
      name:       plain(props["Product Name"]?.title || []),
      price:      props.Price?.number ?? null,
      quote_type: props["Quote Type"]?.select?.name || "New Business",
      description: plain(props.Description?.rich_text || []),
      slug,
    }
  } catch (e) {
    console.warn("[create_quotation] fetchProductInfo:", e.message)
    return null
  }
}

// ── Extract lead info ─────────────────────────────────────────────────────
async function extractLeadInfo(props) {
  const companyIds = (props.Company?.relation || []).map(r => r.id.replace(/-/g, ""))
  let   picIds     = []
  for (const field of ["PIC", "Contact", "Person in Charge"]) {
    picIds = (props[field]?.relation || []).map(r => r.id.replace(/-/g, ""))
    if (picIds.length) break
  }

  // Resolve package slug
  const pkgRaw = (props["Package Type"]?.select?.name || "").toLowerCase().trim()
  let slug = PACKAGE_SLUG_MAP[pkgRaw]

  if (!slug) {
    for (const item of (props.Interest?.multi_select || [])) {
      const k = item.name.toLowerCase().trim()
      for (const [key, val] of Object.entries(INTEREST_SLUG_MAP)) {
        if (k.includes(key)) { slug = val; break }
      }
      if (slug) break
    }
  }

  const product    = await fetchProductInfo(slug || "operations-os")
  const addons     = []
  const addonSlugMap = {
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
  for (const item of (props["Add-ons"]?.multi_select || [])) {
    const aSlug = addonSlugMap[item.name.toLowerCase().trim()]
    if (aSlug) {
      const ap = await fetchProductInfo(aSlug)
      if (ap?.id) addons.push(ap)
    }
  }

  return { companyIds, picIds, product, addons }
}

// ── Find recently Notion-created quotation ────────────────────────────────
async function findRecentQuotation(leadId, maxAgeSeconds = 120) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const rows = await queryDB(DB.QUOTATIONS, {
        property: "Deal Source", relation: { contains: leadId }
      }, process.env.NOTION_API_KEY)

      // Sort by created_time descending
      rows.sort((a, b) => new Date(b.created_time) - new Date(a.created_time))

      if (rows.length) {
        const age = (Date.now() - new Date(rows[0].created_time)) / 1000
        if (age <= maxAgeSeconds) {
          const id = rows[0].id.replace(/-/g, "")
          return { id, url: rows[0].url || `https://notion.so/${id}` }
        }
      }
    } catch (e) {
      console.warn(`[create_quotation] findRecentQuotation attempt ${attempt + 1}:`, e.message)
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
  }
  return null
}

// ── Patch quotation properties ─────────────────────────────────────────────
async function patchQuotationProps(quotId, { companyIds, picIds, quoteType, leadId, packageName }) {
  const today = new Date().toISOString().split("T")[0]

  const patches = [
    { "Issue Date":    { date: { start: today } } },
    { "Payment Terms": { select: { name: "50% Deposit" } } },
    { "Status":        { status: { name: "Draft" } } },
    ...(quoteType ? [{ "Quote Type": { select: { name: quoteType } } }] : []),
    ...(packageName ? [{ "Package Type": { rich_text: [{ text: { content: packageName } }] } }] : []),
    ...(companyIds.length ? [{ "Company": { relation: [{ id: companyIds[0] }] } }] : []),
    ...(picIds.length ? [{ "PIC": { relation: [{ id: picIds[0] }] } }] : []),
  ]

  for (const props of patches) {
    try { await patchPage(quotId, props, process.env.NOTION_API_KEY) } catch {}
  }

  // Link lead (try multiple field names)
  if (leadId) {
    for (const field of ["Deal Source", "Lead", "Deals", "Source"]) {
      try {
        await patchPage(quotId, { [field]: { relation: [{ id: leadId }] } }, process.env.NOTION_API_KEY)
        break
      } catch {}
    }
  }
}

// ── Find line items DB on quotation page ──────────────────────────────────
async function findLineItemsDB(pageId, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, { headers: hdrs() })
      if (r.ok) {
        const blocks = [...(await r.json()).results]
        // Also check inside callouts
        for (const block of [...blocks]) {
          if (block.type === "callout") {
            try {
              const nb = await fetch(`https://api.notion.com/v1/blocks/${block.id}/children`, { headers: hdrs() })
              if (nb.ok) blocks.push(...(await nb.json()).results)
            } catch {}
          }
        }
        const dbBlock = blocks.find(b => b.type === "child_database")
        if (dbBlock) return dbBlock.id.replace(/-/g, "")
      }
    } catch (e) {
      console.warn(`[create_quotation] findLineItemsDB attempt ${i + 1}:`, e.message)
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)))
  }
  return null
}

// ── Create Products & Services DB on quotation page ───────────────────────
async function createLineItemsDB(pageId) {
  // Callout header
  await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH", headers: hdrs(),
    body: JSON.stringify({ children: [{
      type: "callout",
      callout: {
        rich_text: [{ type: "text", text: { content: "Products & Services" }, annotations: { bold: true } }],
        icon: null, color: "default_background",
      },
    }] }),
  })

  // Inline DB
  const r = await fetch("https://api.notion.com/v1/databases", {
    method: "POST", headers: hdrs(),
    body: JSON.stringify({
      parent:    { type: "page_id", page_id: pageId },
      is_inline: true,
      title: [{ type: "text", text: { content: "Products & Services" } }],
      properties: {
        "Notes":       { title: {} },
        "Product":     { relation: { database_id: DB.CATALOGUE, single_property: {} } },
        "Description": { rich_text: {} },
        "Unit Price":  { number: { format: "ringgit" } },
        "Qty":         { number: { format: "number" } },
        "Subtotal":    { formula: { expression: 'prop("Qty") * prop("Unit Price")' } },
      },
    }),
  })
  if (!r.ok) throw new Error(`Create DB failed ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const db = await r.json()
  return db.id.replace(/-/g, "")
}

// ── Ensure Product relation points to current Catalogue DB ────────────────
async function ensureProductRelation(dbId) {
  try {
    await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
      method: "PATCH", headers: hdrs(),
      body: JSON.stringify({
        properties: {
          "Product": { relation: { database_id: DB.CATALOGUE, single_property: {} } }
        }
      }),
    })
    // Wait for schema propagation
    await new Promise(r => setTimeout(r, 1500))
  } catch (e) {
    console.warn("[create_quotation] ensureProductRelation:", e.message)
  }
}

// ── Create a single line item ──────────────────────────────────────────────
async function createLineItem(dbId, product, retry = true) {
  const props = {
    "Notes": { title: [] },
    "Qty":   { number: 1 },
    ...(product.id ? { "Product": { relation: [{ id: product.id }] } } : {}),
    ...(product.price != null ? { "Unit Price": { number: Number(product.price) } } : {}),
    ...(product.description ? { "Description": { rich_text: [{ text: { content: product.description } }] } } : {}),
  }
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST", headers: hdrs(),
    body:   JSON.stringify({ parent: { database_id: dbId }, properties: props }),
  })
  if (!r.ok && retry) {
    // Retry without Description
    const p2 = { ...props }; delete p2.Description
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: hdrs(),
      body:   JSON.stringify({ parent: { database_id: dbId }, properties: p2 }),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Create Quotation", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const body  = req.body || {}
    const rawId = body.page_id || body.source?.page_id || body.data?.page_id
    if (!rawId) return res.status(400).json({ error: "Missing page_id" })
    const pageId = rawId.replace(/-/g, "")

    // ── Detect source ──────────────────────────────────────────────────────
    const { type: sourceType, props } = await detectSource(pageId)

    let leadId = null, companyIds = [], picIds = []
    let product = null, addons = []
    let quoteType = "New Business"

    if (sourceType === "lead") {
      leadId = pageId
      const info = await extractLeadInfo(props)
      companyIds = info.companyIds
      picIds     = info.picIds
      product    = info.product
      addons     = info.addons
      quoteType  = product?.quote_type || "New Business"
    } else {
      companyIds = [pageId]
    }

    // ── Find or create quotation page ─────────────────────────────────────
    let quotId = null, quotUrl = null, foundViaNotion = false

    if (sourceType === "lead" && leadId) {
      const recent = await findRecentQuotation(leadId)
      if (recent) {
        quotId = recent.id; quotUrl = recent.url; foundViaNotion = true
        await patchQuotationProps(quotId, {
          companyIds, picIds, quoteType, leadId, packageName: product?.name
        })
      }
    }

    if (!quotId) {
      const today = new Date().toISOString().split("T")[0]
      const cprops = {
        "Quotation No.": { title: [{ text: { content: "" } }] },
        "Status":        { status: { name: "Draft" } },
        "Issue Date":    { date: { start: today } },
        "Payment Terms": { select: { name: "50% Deposit" } },
        ...(quoteType ? { "Quote Type": { select: { name: quoteType } } } : {}),
        ...(product?.name ? { "Package Type": { rich_text: [{ text: { content: product.name } }] } } : {}),
        ...(companyIds.length ? { "Company": { relation: [{ id: companyIds[0] }] } } : {}),
        ...(picIds.length ? { "PIC": { relation: [{ id: picIds[0] }] } } : {}),
      }
      const page = await createPage({ parent: { database_id: DB.QUOTATIONS }, properties: cprops }, process.env.NOTION_API_KEY)
      quotId  = page.id.replace(/-/g, "")
      quotUrl = page.url || `https://notion.so/${quotId}`

      // Link lead
      if (leadId) {
        for (const field of ["Deal Source", "Lead", "Deals", "Source"]) {
          try { await patchPage(quotId, { [field]: { relation: [{ id: leadId }] } }, process.env.NOTION_API_KEY); break } catch {}
        }
      }
    }

    // ── Auto-populate line items ───────────────────────────────────────────
    if (sourceType === "lead" && product?.id) {
      try {
        let liDbId = await findLineItemsDB(quotId)
        if (!liDbId) liDbId = await createLineItemsDB(quotId)

        await ensureProductRelation(liDbId)

        // Base OS first (gets row No. 1)
        if (OS_PACKAGE_SLUGS.has(product.slug)) {
          const base = await fetchProductInfo("base-os")
          if (base?.id) {
            await createLineItem(liDbId, base)
            // Brief delay to maintain ordering
            await new Promise(r => setTimeout(r, 500))
          }
        }

        // Main product (row No. 2)
        await createLineItem(liDbId, product)

        // Add-ons (rows No. 3+)
        for (const addon of addons) {
          await createLineItem(liDbId, addon)
        }
      } catch (e) {
        console.warn("[create_quotation] line items:", e.message)
      }
    }

    // ── Advance Lead stage → Proposed ─────────────────────────────────────
    if (leadId) {
      try { await patchPage(leadId, { "Stage": { status: { name: "Proposed" } } }, process.env.NOTION_API_KEY) } catch {}
    }

    return res.json({
      status:            "success",
      source_type:       sourceType,
      quotation_id:      quotId,
      quotation_url:     quotUrl,
      quote_type:        quoteType,
      lead_id:           leadId,
      company_ids:       companyIds,
      line_item:         product?.name || null,
      addons:            addons.map(a => a.name),
      found_via_notion:  foundViaNotion,
    })
  } catch (e) {
    console.error("[create_quotation]", e)
    return res.status(500).json({ error: e.message })
  }
}
