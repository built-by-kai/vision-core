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

import { getPage, patchPage, createPage, queryDB, plain, DB } from "../../lib/notion"


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
// Notion button Action 1 creates the page, Action 2 fires our webhook.
// By the time we run, the page already exists — query newest page, no filter.
// Single attempt: no retries needed since the page was just created.
async function findRecentQuotation(maxAgeSeconds = 90) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB.QUOTATIONS}/query`, {
      method:  "POST",
      headers: hdrs(),
      body:    JSON.stringify({
        sorts:     [{ timestamp: "created_time", direction: "descending" }],
        page_size: 1,
      }),
    })
    if (!r.ok) {
      console.warn(`[create_quotation] findRecentQuotation ${r.status}`)
      return null
    }
    const page = (await r.json()).results?.[0]
    if (!page) return null
    const age = (Date.now() - new Date(page.created_time)) / 1000
    console.log(`[create_quotation] newest quotation age: ${age.toFixed(1)}s`)
    if (age <= maxAgeSeconds) {
      const id = page.id.replace(/-/g, "")
      return { id, url: page.url || `https://notion.so/${id}` }
    }
    return null
  } catch (e) {
    console.warn("[create_quotation] findRecentQuotation:", e.message)
    return null
  }
}

// ── Patch quotation properties (parallel) ─────────────────────────────────
// PIC is a ROLLUP — auto-resolves from Company. Never patch PIC directly.
// All patches run in parallel via Promise.allSettled for speed.
async function patchQuotationProps(quotId, { companyIds, quoteType, leadId, packageName }) {
  const today = new Date().toISOString().split("T")[0]
  const token = process.env.NOTION_API_KEY

  // Build all property patches we want to apply
  const propPatches = {
    "Issue Date":    { date: { start: today } },
    "Payment Terms": { select: { name: "50% Deposit" } },
    "Status":        { select: { name: "Draft" } },
    ...(quoteType   ? { "Quote Type":   { select: { name: quoteType } } } : {}),
    ...(companyIds.length ? { "Company": { relation: [{ id: companyIds[0] }] } } : {}),
  }

  // Single PATCH call with all properties at once (faster, atomic)
  try {
    await patchPage(quotId, propPatches, token)
    console.log("[create_quotation] core props patched in one call")
  } catch (e) {
    // If bulk fails, fall back to individual patches
    console.warn("[create_quotation] bulk patch failed, trying individually:", e.message)
    await Promise.allSettled(
      Object.entries(propPatches).map(([k, v]) =>
        patchPage(quotId, { [k]: v }, token).catch(err =>
          console.warn(`[create_quotation] patch '${k}' failed:`, err.message)
        )
      )
    )
  }

  // Deal Source — try field names until one works
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
async function findLineItemsDB(pageId, retries = 3) {
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
        if (dbBlock) {
          console.log(`[create_quotation] findLineItemsDB found on attempt ${i + 1}`)
          return dbBlock.id.replace(/-/g, "")
        }
      }
    } catch (e) {
      console.warn(`[create_quotation] findLineItemsDB attempt ${i + 1}:`, e.message)
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000))
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
async function createLineItem(dbId, product) {
  // Base props — no description field yet (column name varies by template)
  const baseProps = {
    "Notes": { title: [] },
    "Qty":   { number: 1 },
    ...(product.id ? { "Product": { relation: [{ id: product.id }] } } : {}),
    ...(product.price != null ? { "Unit Price": { number: Number(product.price) } } : {}),
  }

  // Try each known description column name in order
  const descColumns = product.description
    ? ["Product Description", "Description", "Details"]
    : []

  for (const col of [...descColumns, null]) {
    const props = col
      ? { ...baseProps, [col]: { rich_text: [{ text: { content: product.description.slice(0, 2000) } }] } }
      : baseProps
    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: hdrs(),
      body:   JSON.stringify({ parent: { database_id: dbId }, properties: props }),
    })
    if (r.ok) return await r.json()
    if (col === null) {
      // Last attempt failed — log the error
      const text = await r.text()
      console.warn(`[createLineItem] all attempts failed: ${r.status} ${text.slice(0, 200)}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: All work is done BEFORE responding.
// Vercel serverless functions cannot reliably run code after res.json() is
// called — the function may be frozen immediately. Do everything first, then
// respond. Notion's button waits up to ~15s for a response; our work finishes
// well within that window.
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Create Quotation", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body  = req.body || {}
  const rawId = body.page_id || body.source?.page_id || body.data?.page_id
                || body.data?.id || body.source?.id
  if (!rawId) return res.status(400).json({ error: "Missing page_id" })
  const pageId = rawId.replace(/-/g, "")

  try {
    // ── 1. Detect source (Lead vs Company) ───────────────────────────────────
    const { type: sourceType, props } = await detectSource(pageId)
    console.log("[create_quotation] source:", sourceType, pageId)

    let leadId = null, companyIds = [], product = null, addons = [], quoteType = "New Business"

    if (sourceType === "lead") {
      leadId = pageId
      const info = await extractLeadInfo(props)
      companyIds = info.companyIds
      product    = info.product
      addons     = info.addons
      quoteType  = product?.quote_type || "New Business"
      console.log("[create_quotation] lead info:", { companyIds, product: product?.name, addons: addons.length })
    } else {
      companyIds = [pageId]
    }

    // ── 2. Find or create quotation page ────────────────────────────────────
    let quotId = null, quotUrl = null, foundViaNotion = false

    if (sourceType === "lead") {
      const recent = await findRecentQuotation()
      if (recent) {
        quotId = recent.id; quotUrl = recent.url; foundViaNotion = true
        console.log("[create_quotation] found Notion-created quotation:", quotId)
        await patchQuotationProps(quotId, { companyIds, quoteType, leadId, packageName: product?.name })
      }
    }

    if (!quotId) {
      // Fallback: create quotation via API
      const today = new Date().toISOString().split("T")[0]
      const cprops = {
        "Quotation No.": { title: [{ text: { content: "" } }] },
        "Status":        { select: { name: "Draft" } },
        "Issue Date":    { date: { start: today } },
        "Payment Terms": { select: { name: "50% Deposit" } },
        ...(quoteType       ? { "Quote Type": { select: { name: quoteType } } } : {}),
        ...(companyIds.length ? { "Company": { relation: [{ id: companyIds[0] }] } } : {}),
      }
      const page = await createPage({ parent: { database_id: DB.QUOTATIONS }, properties: cprops }, process.env.NOTION_API_KEY)
      quotId  = page.id.replace(/-/g, "")
      quotUrl = page.url || `https://notion.so/${quotId}`
      console.log("[create_quotation] created new quotation:", quotId)

      if (leadId) {
        for (const field of ["Deal Source", "Lead", "Deals", "Source"]) {
          try { await patchPage(quotId, { [field]: { relation: [{ id: leadId }] } }, process.env.NOTION_API_KEY); break } catch {}
        }
      }
    }

    // ── 3. Auto-populate Products & Services line items ──────────────────────
    if (sourceType === "lead" && product?.id) {
      try {
        // findLineItemsDB: 3 retries with short waits for template propagation
        let liDbId = await findLineItemsDB(quotId, 3)
        if (!liDbId) liDbId = await createLineItemsDB(quotId)
        await ensureProductRelation(liDbId)

        // Base OS first (No. 1), then main product (No. 2), then add-ons
        if (OS_PACKAGE_SLUGS.has(product.slug)) {
          const base = await fetchProductInfo("base-os")
          if (base?.id) await createLineItem(liDbId, base)
        }

        const modDesc = buildModuleDescription(product.slug)
        await createLineItem(liDbId, { ...product, description: modDesc || product.description })

        for (const addon of addons) {
          await createLineItem(liDbId, addon)
        }
        console.log("[create_quotation] line items created")
      } catch (e) {
        console.warn("[create_quotation] line items error (non-fatal):", e.message)
      }
    }

    // ── 4. Advance Lead stage → Proposed ────────────────────────────────────
    if (leadId) {
      try { await patchPage(leadId, { "Stage": { status: { name: "Proposed" } } }, process.env.NOTION_API_KEY) } catch {}
    }

    console.log("[create_quotation] done", { quotId, foundViaNotion, quoteType, productFound: !!product?.id })
    return res.status(200).json({
      status: "ok", quotId, quotUrl, foundViaNotion, quoteType,
      productFound: !!product?.id, productName: product?.name ?? null,
    })

  } catch (e) {
    console.error("[create_quotation] fatal:", e)
    return res.status(500).json({ error: e.message })
  }
}
