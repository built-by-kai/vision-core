// ─── create_quotation.js ───────────────────────────────────────────────────
// POST /api/create_quotation   { "page_id": "<lead_or_company_page_id>" }
// Triggered by Notion button on a Lead CRM page.
//
// 1. Detect whether source page is a Lead or Company
// 2. Find recently Notion-created quotation (from button action 1) OR create new one
// 3. Patch quotation properties (dates, terms, quote type, company, PIC)
// 4. Auto-populate line items (Base OS + main product + add-ons)
// 5. Advance Lead stage → Proposed
//
// DBs: Quotations, Leads CRM, Companies, Catalogue (Products)

import { getPage, patchPage, createPage, plain, DB } from "../../lib/notion"


function hdrs() {
  return {
    Authorization:    `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": "2022-06-28",
    "Content-Type":   "application/json",
  }
}

// ── Package slug maps (aligned with Catalogue DB, Apr 2026) ───────────────
const PACKAGE_SLUG_MAP = {
  "operations os":                  "operations-os",
  "sales os":                       "revenue-os",
  "revenue os":                     "revenue-os",
  "business os":                    "business-os",
  "business os – phase by phase":   "business-os",
  "agency os":                      "full-platform-os",
  "marketing os":                   "marketing-os",
  "team os":                        "team-os",
  "retention os":                   "retention-os",
  "intelligence os":                "intelligence-os",
  "starter os":                     "starter-os",
  "micro install":                  "micro-install-1",
  "micro install — 1 module":       "micro-install-1",
  "micro install — 2 modules":      "micro-install-2",
  "micro install — 3 modules":      "micro-install-3",
}

const INTEREST_SLUG_MAP = {
  "operations os":                      "operations-os",
  "sales os":                           "revenue-os",
  "revenue os":                         "revenue-os",
  "business os":                        "business-os",
  "agency os":                          "full-platform-os",
  "marketing os":                       "marketing-os",
  "team os":                            "team-os",
  "retention os":                       "retention-os",
  "starter os":                         "starter-os",
  "additional module":                  "addon-system-module",
  "additional system module":           "addon-system-module",
  "automation (within":                 "addon-automation-within",
  "automation (cross":                  "addon-automation-cross",
  "advanced dashboard":                 "addon-dashboard",
  "enhanced dashboard":                 "addon-dashboard",
  "custom widget":                      "addon-widget",
  "api / external integration":         "addon-api-integration",
  "automation & workflow integration":  "addon-workflow-integration",
  "lead capture system":                "addon-lead-capture",
  "client portal view":                 "addon-client-portal",
  "ai agent integration":               "addon-ai-agent",
  "ads platform integration":           "addon-ads-integration",
  "project kickoff":                    "automation-project-kickoff",
  "campaign kickoff":                   "automation-campaign-kickoff",
  "onboarding kickoff":                 "automation-onboarding-kickoff",
}

const OS_PACKAGE_SLUGS = new Set([
  "operations-os", "revenue-os", "business-os", "full-platform-os",
  "marketing-os", "team-os", "retention-os", "intelligence-os",
  "starter-os", "micro-install-1", "micro-install-2", "micro-install-3",
])

// ── Module descriptions per OS slug ───────────────────────────────────────
const OS_MODULES = {
  "revenue-os": {
    "Revenue OS": ["CRM & Pipeline", "Proposal & Deal Tracker", "Payment Tracker",
                   "Finance & Expense Tracker", "Product & Pricing Catalogue"],
  },
  "operations-os": {
    "Operations OS": ["Project Tracker", "Task Management", "Client Onboarding Tracker",
                      "Team Responsibility Matrix", "SOP & Process Library"],
  },
  "marketing-os": {
    "Marketing OS": ["Campaign Tracker", "Content Production Tracker", "Content Calendar",
                     "Brand & Asset Library", "Ads Tracker"],
  },
  "business-os": {
    "Revenue OS":    ["CRM & Pipeline", "Proposal & Deal Tracker", "Payment Tracker",
                      "Finance & Expense Tracker", "Product & Pricing Catalogue"],
    "Operations OS": ["Project Tracker", "Task Management", "Client Onboarding Tracker",
                      "Team Responsibility Matrix", "SOP & Process Library"],
  },
  "full-platform-os": {
    "Revenue OS":    ["CRM & Pipeline", "Proposal & Deal Tracker", "Payment Tracker",
                      "Finance & Expense Tracker", "Product & Pricing Catalogue"],
    "Operations OS": ["Project Tracker", "Task Management", "Client Onboarding Tracker",
                      "Team Responsibility Matrix", "SOP & Process Library"],
    "Marketing OS":  ["Campaign Tracker", "Content Production Tracker", "Content Calendar",
                      "Brand & Asset Library", "Ads Tracker"],
  },
}

function buildModuleDescription(slug) {
  const groups = OS_MODULES[slug]
  if (!groups) return ""
  return Object.entries(groups)
    .map(([grp, mods]) => `${grp}: ${mods.join(" · ")}`)
    .join("\n")
}

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
  for (const field of ["PIC Name", "PIC", "Contact", "Person in Charge"]) {
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
    "enhanced dashboard":                "addon-dashboard",
    "custom widget":                     "addon-widget",
    "api / external integration":        "addon-api-integration",
    "automation & workflow (make/n8n)":  "addon-workflow-integration",
    "lead capture system":               "addon-lead-capture",
    "client portal view":                "addon-client-portal",
    "ai agent integration":              "addon-ai-agent",
    "ads platform integration":          "addon-ads-integration",
    "project kickoff automation":        "automation-project-kickoff",
    "campaign kickoff automation":       "automation-campaign-kickoff",
    "client onboarding kickoff":         "automation-onboarding-kickoff",
    "renewal kickoff automation":        "automation-renewal-kickoff",
    "hiring kickoff automation":         "automation-hiring-kickoff",
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

// ── Find recently Notion-created quotation ─────────────────────────────────
// Notion button Action 1 creates the quotation page (with template) before
// Action 2 fires our webhook. The template page has NO Status set — so we
// can't filter by Status. Instead, sort by created_time and pick the most
// recent page within a tight time window (60 s).
async function findRecentQuotation(maxAgeSeconds = 60) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://api.notion.com/v1/databases/${DB.QUOTATIONS}/query`, {
        method:  "POST",
        headers: hdrs(),
        body:    JSON.stringify({
          sorts:     [{ timestamp: "created_time", direction: "descending" }],
          page_size: 1,
        }),
      })
      if (r.ok) {
        const data = await r.json()
        const page = data.results?.[0]
        if (page) {
          const age = (Date.now() - new Date(page.created_time)) / 1000
          console.log(`[create_quotation] findRecentQuotation: newest page age ${age.toFixed(1)}s`)
          if (age <= maxAgeSeconds) {
            const id = page.id.replace(/-/g, "")
            return { id, url: page.url || `https://notion.so/${id}` }
          }
          // Page is old → no recent Notion-created page exists
          return null
        }
      } else {
        console.warn(`[create_quotation] findRecentQuotation ${r.status}: ${await r.text()}`)
      }
    } catch (e) {
      console.warn(`[create_quotation] findRecentQuotation attempt ${attempt + 1}:`, e.message)
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 1500))
  }
  return null
}

// ── Patch quotation properties ─────────────────────────────────────────────
// PIC is a ROLLUP on the Quotation DB — auto-resolves from Company. Do not patch.
async function patchQuotationProps(quotId, { companyIds, quoteType, leadId, packageName }) {
  const today = new Date().toISOString().split("T")[0]
  const token = process.env.NOTION_API_KEY

  // Status is a select field (not status type) in this DB
  const patches = [
    { "Issue Date":    { date: { start: today } } },
    { "Payment Terms": { select: { name: "50% Deposit" } } },
    { "Status":        { select: { name: "Draft" } } },
    ...(quoteType    ? [{ "Quote Type":   { select: { name: quoteType } } }] : []),
    ...(packageName  ? [{ "Package Type": { rich_text: [{ text: { content: packageName } }] } }] : []),
    ...(companyIds.length ? [{ "Company": { relation: [{ id: companyIds[0] }] } }] : []),
  ]

  for (const props of patches) {
    try {
      await patchPage(quotId, props, token)
    } catch (e) {
      console.warn("[create_quotation] patch prop failed:", Object.keys(props)[0], e.message)
    }
  }

  // Link lead via Deal Source relation
  if (leadId) {
    for (const field of ["Deal Source", "Lead", "Deals", "Source"]) {
      try {
        await patchPage(quotId, { [field]: { relation: [{ id: leadId }] } }, token)
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

  const body  = req.body || {}
  const rawId = body.page_id || body.source?.page_id || body.data?.page_id
  if (!rawId) return res.status(400).json({ error: "Missing page_id" })
  const pageId = rawId.replace(/-/g, "")

  // ── Respond immediately so Notion button doesn't timeout ──────────────────
  res.status(200).json({ status: "processing", page_id: pageId })

  // ── All heavy work runs after response is sent ────────────────────────────
  try {
    // ── Detect source ────────────────────────────────────────────────────────
    const { type: sourceType, props } = await detectSource(pageId)

    let leadId = null, companyIds = []
    let product = null, addons = []
    let quoteType = "New Business"

    if (sourceType === "lead") {
      leadId = pageId
      const info = await extractLeadInfo(props)
      companyIds = info.companyIds
      product    = info.product
      addons     = info.addons
      quoteType  = product?.quote_type || "New Business"
    } else {
      companyIds = [pageId]
    }

    // ── Find or create quotation page ───────────────────────────────────────
    let quotId = null, quotUrl = null, foundViaNotion = false

    if (sourceType === "lead" && leadId) {
      // Look for the quotation Notion created via Action 1 (template applied)
      const recent = await findRecentQuotation()
      if (recent) {
        quotId = recent.id; quotUrl = recent.url; foundViaNotion = true
        await patchQuotationProps(quotId, { companyIds, quoteType, leadId, packageName: product?.name })
      }
    }

    if (!quotId) {
      // Fallback: create quotation ourselves
      const today = new Date().toISOString().split("T")[0]
      const cprops = {
        "Quotation No.": { title: [{ text: { content: "" } }] },
        "Status":        { select: { name: "Draft" } },
        "Issue Date":    { date: { start: today } },
        "Payment Terms": { select: { name: "50% Deposit" } },
        ...(quoteType ? { "Quote Type": { select: { name: quoteType } } } : {}),
        ...(companyIds.length ? { "Company": { relation: [{ id: companyIds[0] }] } } : {}),
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

    // ── Auto-populate line items ─────────────────────────────────────────────
    if (sourceType === "lead" && product?.id) {
      try {
        let liDbId = await findLineItemsDB(quotId)
        if (!liDbId) liDbId = await createLineItemsDB(quotId)

        await ensureProductRelation(liDbId)

        // Base OS first (row No. 1)
        if (OS_PACKAGE_SLUGS.has(product.slug)) {
          const base = await fetchProductInfo("base-os")
          if (base?.id) {
            await createLineItem(liDbId, base)
            await new Promise(r => setTimeout(r, 500))
          }
        }

        // Main product (row No. 2) — use module description if available
        const modDesc = buildModuleDescription(product.slug)
        await createLineItem(liDbId, { ...product, description: modDesc || product.description })

        // Add-ons (rows No. 3+)
        for (const addon of addons) {
          await createLineItem(liDbId, addon)
        }
      } catch (e) {
        console.warn("[create_quotation] line items:", e.message)
      }
    }

    // ── Advance Lead stage → Proposed ───────────────────────────────────────
    if (leadId) {
      try { await patchPage(leadId, { "Stage": { status: { name: "Proposed" } } }, process.env.NOTION_API_KEY) } catch {}
    }

    console.log("[create_quotation] done", { quotId, foundViaNotion, quoteType })
  } catch (e) {
    console.error("[create_quotation]", e)
  }
}
