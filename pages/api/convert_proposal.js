// ─── convert_proposal.js ───────────────────────────────────────────────────
// POST /api/convert_proposal   { "page_id": "<proposal_page_id>" }
// Triggered by "Convert to Quotation" Notion button (two-action automation):
//   Action 1 (Notion): Creates the Quotation page from template (inline table already exists)
//   Action 2 (Notion): Fires this webhook with the proposal page as payload
//
// What this API does:
//   1. Extracts proposal data from the inbound payload (no extra getPage call needed)
//   2. Waits briefly, then re-fetches the proposal to get the newly linked Quotation ID
//      (the Converted Quotation relation is populated by Action 1 before webhook fires)
//   3. Patches the quotation page properties (Company, Deal Source, Payment Terms, etc.)
//   4. Finds the existing inline Products & Services DB on the quotation (from template)
//   5. Looks up products from Catalogue by OS Type + Deal Add-ons
//   6. Populates the inline table: Base OS → Main OS product → Add-ons
//   7. Marks Proposal → "Quotation Issued"
//
// NOTE: Proposals DB has no inline Products DB. Products are sourced from Catalogue.

import { getPage, patchPage, createPage, queryDB, plain, DB } from "../../lib/notion"

function hdrs() {
  return {
    Authorization:    `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": "2022-06-28",
    "Content-Type":   "application/json",
  }
}

// ── Quote Type mapping: Proposal options → Quotation options ──────────────
// Proposal:  New Business | Renewal | Add-On | Retainer
// Quotation: New Business | Expansion | Renewal | Service/Maintenance
const QUOTE_TYPE_MAP = {
  "New Business":      "New Business",
  "Renewal":           "Renewal",
  "Add-On":            "Expansion",
  "Retainer":          "Service/Maintenance",
}

// ── OS Type → Catalogue slug ───────────────────────────────────────────────
const OS_SLUG_MAP = {
  "revenue os":      "revenue-os",
  "operations os":   "operations-os",
  "business os":     "business-os",
  "marketing os":    "marketing-os",
  "team os":         "team-os",
  "retention os":    "retention-os",
  "agency os":       "full-platform-os",
  "intelligence os": "intelligence-os",
}

// ── Add-on name → Catalogue slug ──────────────────────────────────────────
const ADDON_SLUG_MAP = {
  "additional system module":          "addon-system-module",
  "automation — within database":      "addon-automation-within",
  "automation (within database)":      "addon-automation-within",
  "automation — cross-database":       "addon-automation-cross",
  "automation (cross-database)":       "addon-automation-cross",
  "advanced dashboard":                "addon-dashboard",
  "enhanced dashboard":                "addon-dashboard",
  "custom widget":                     "addon-widget",
  "api / external integration":        "addon-api-integration",
  "automation & workflow integration": "addon-workflow-integration",
  "lead capture system":               "addon-lead-capture",
  "client portal view":                "addon-client-portal",
  "ai agent integration":              "addon-ai-agent",
  "ads platform integration":          "addon-ads-integration",
  "project kickoff automation":        "automation-project-kickoff",
  "campaign kickoff automation":       "automation-campaign-kickoff",
  "client onboarding kickoff":         "automation-onboarding-kickoff",
  "renewal kickoff automation":        "automation-renewal-kickoff",
  "hiring kickoff automation":         "automation-hiring-kickoff",
  "document generation":               "addon-doc-generation",
}

const OS_PACKAGE_SLUGS = new Set([
  "revenue-os", "operations-os", "business-os", "marketing-os",
  "team-os", "retention-os", "full-platform-os", "intelligence-os",
  "micro-install-1", "micro-install-2", "micro-install-3",
])

// ── Module descriptions (mirrors create_quotation.js) ─────────────────────
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

// ── Fetch a product from Catalogue by slug ────────────────────────────────
async function fetchProduct(slug) {
  if (!slug) return null
  try {
    const rows = await queryDB(DB.CATALOGUE, {
      property: "Slug", rich_text: { equals: slug }
    }, process.env.NOTION_API_KEY)
    if (!rows.length) return null
    const p = rows[0]
    const props = p.properties
    return {
      id:          p.id.replace(/-/g, ""),
      name:        plain(props["Product Name"]?.title || []),
      price:       props.Price?.number ?? null,
      description: plain(props.Description?.rich_text || []),
      slug,
    }
  } catch (e) {
    console.warn("[convert_proposal] fetchProduct:", slug, e.message)
    return null
  }
}

// ── Read Add-ons from a Deal page ─────────────────────────────────────────
async function fetchDealAddons(dealId) {
  if (!dealId) return []
  try {
    const deal = await getPage(dealId, process.env.NOTION_API_KEY)
    const addons = deal.properties["Add-ons"]?.multi_select || []
    const results = []
    for (const item of addons) {
      const slug = ADDON_SLUG_MAP[item.name.toLowerCase().trim()]
      if (!slug) continue
      const product = await fetchProduct(slug)
      if (product?.id) results.push(product)
    }
    return results
  } catch (e) {
    console.warn("[convert_proposal] fetchDealAddons:", e.message)
    return []
  }
}

// ── Find inline Products & Services DB on a page ──────────────────────────
// Checks direct children, then inside callouts/columns (template nesting)
async function findLineItemsDB(pageId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers: hdrs() })
    if (!r.ok) return null
    const blocks = (await r.json()).results || []

    const direct = blocks.find(b => b.type === "child_database")
    if (direct) return direct.id.replace(/-/g, "")

    const containers = blocks.filter(b =>
      ["callout", "column", "column_list", "toggle"].includes(b.type)
    )
    const inner = await Promise.all(
      containers.map(async b => {
        try {
          const nb = await fetch(`https://api.notion.com/v1/blocks/${b.id}/children?page_size=50`, { headers: hdrs() })
          return nb.ok ? (await nb.json()).results || [] : []
        } catch { return [] }
      })
    )
    const nested = inner.flat().find(b => b.type === "child_database")
    if (nested) return nested.id.replace(/-/g, "")

    return null
  } catch (e) {
    console.warn("[convert_proposal] findLineItemsDB:", e.message)
    return null
  }
}

// ── Create Products & Services DB on a page ───────────────────────────────
// Matches the schema used by create_quotation.js for consistency
async function createLineItemsDB(pageId) {
  const r = await fetch("https://api.notion.com/v1/databases", {
    method: "POST", headers: hdrs(),
    body: JSON.stringify({
      parent:    { type: "page_id", page_id: pageId },
      is_inline: true,
      title:     [{ type: "text", text: { content: "Products & Services" } }],
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
  if (!r.ok) throw new Error(`Create inline DB: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return (await r.json()).id.replace(/-/g, "")
}

// ── Write one line item into the Products & Services DB ───────────────────
async function createLineItem(dbId, product) {
  const baseProps = {
    "Notes": { title: [] },
    "Qty":   { number: 1 },
    ...(product.id    ? { "Product":    { relation: [{ id: product.id }] } } : {}),
    ...(product.price != null ? { "Unit Price": { number: Number(product.price) } } : {}),
  }

  // Try known description column names in order (template may vary)
  const descCols = product.description ? ["Description", "Product Description", "Details"] : []

  for (const col of [...descCols, null]) {
    const props = col
      ? { ...baseProps, [col]: { rich_text: [{ text: { content: product.description.slice(0, 2000) } }] } }
      : baseProps
    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: hdrs(),
      body:   JSON.stringify({ parent: { database_id: dbId }, properties: props }),
    })
    if (r.ok) return await r.json()
    if (col === null) {
      const txt = await r.text()
      console.warn(`[convert_proposal] createLineItem all attempts failed: ${r.status} ${txt.slice(0, 200)}`)
    }
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Convert Proposal", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body = req.body || {}
  console.log("[convert_proposal] payload:", JSON.stringify(body).slice(0, 300))

  // Extract proposal page ID — handle all Notion webhook/button payload formats
  // Notion automation sends: { source: {...}, data: { object: "page", id: "...", properties: {...} } }
  const proposalId = (
    body.proposal_id    ||
    body.data?.id       ||   // ← Notion automation format (primary)
    body.source?.page_id ||
    body.page?.id ||
    body.data?.page_id ||
    body.page_id ||
    ""
  ).replace(/-/g, "")

  if (!proposalId) {
    console.error("[convert_proposal] no proposal ID found in payload:", JSON.stringify(body))
    return res.status(400).json({ error: "Missing proposal ID", received: body })
  }

  try {
    // ── 1. Read proposal from inbound payload (no extra API call needed) ────
    // Notion automation embeds the full page in body.data. Fall back to getPage
    // only if the payload doesn't carry properties (e.g. manual test calls).
    const proposalPage = (body.data?.object === "page" && body.data?.properties)
      ? body.data
      : await getPage(proposalId, process.env.NOTION_API_KEY)
    const pp = proposalPage.properties

    const osTypeRaw  = pp["OS Type"]?.select?.name || ""
    const payTerms   = pp["Payment Terms"]?.select?.name || "50% Deposit"
    const proposalQT = pp["Quote Type"]?.select?.name || "New Business"
    const quoteType  = QUOTE_TYPE_MAP[proposalQT] || "New Business"
    const companyIds = (pp.Company?.relation        || []).map(r => r.id.replace(/-/g, ""))
    const dealIds    = (pp["Deal Source"]?.relation  || []).map(r => r.id.replace(/-/g, ""))
    const leadIds    = (pp["Lead Source"]?.relation  || []).map(r => r.id.replace(/-/g, ""))
    const picIds     = (pp.PIC?.relation             || []).map(r => r.id.replace(/-/g, ""))

    console.log("[convert_proposal] proposal:", proposalId, "| osType:", osTypeRaw, "| quoteType:", quoteType)

    // ── 2. Find the Quotation page Notion just created (Action 1) ───────────
    // Notion's Action 1 creates the Quotation and links it via the bidirectional
    // Proposal ↔ Converted Quotation relation. The webhook (Action 2) fires
    // after, so re-fetching the proposal gives us the new quotation ID.
    // Wait up to ~6s with two attempts.
    let quotId = null

    const getLinkedQuotation = async () => {
      const fresh = await getPage(proposalId, process.env.NOTION_API_KEY)
      const linked = fresh.properties["Converted Quotation"]?.relation || []
      if (!linked.length) return null
      // Pick the most recently created one
      const pages = await Promise.all(
        linked.map(r => getPage(r.id.replace(/-/g, ""), process.env.NOTION_API_KEY).catch(() => null))
      )
      const sorted = pages
        .filter(Boolean)
        .sort((a, b) => new Date(b.created_time) - new Date(a.created_time))
      return sorted[0]?.id.replace(/-/g, "") || null
    }

    // First attempt after 2s
    await new Promise(r => setTimeout(r, 2000))
    quotId = await getLinkedQuotation()

    // Second attempt after another 3s if not found yet
    if (!quotId) {
      console.log("[convert_proposal] quotation not linked yet — retrying in 3s")
      await new Promise(r => setTimeout(r, 3000))
      quotId = await getLinkedQuotation()
    }

    if (!quotId) {
      throw new Error("Could not find the Quotation page created by Notion. Check that Action 1 links the Quotation to the Proposal via the 'Converted Quotation' relation.")
    }
    console.log("[convert_proposal] found quotation:", quotId)

    // ── 3. Patch quotation properties in parallel ───────────────────────────
    const today = new Date().toISOString().split("T")[0]
    await patchPage(quotId, {
      "Status":        { select: { name: "Draft" } },
      "Issue Date":    { date: { start: today } },
      "Payment Terms": { select: { name: payTerms } },
      ...(quoteType         ? { "Quote Type":   { select: { name: quoteType } } } : {}),
      ...(companyIds.length ? { "Company":      { relation: [{ id: companyIds[0] }] } } : {}),
      ...(dealIds.length    ? { "Deal Source":  { relation: [{ id: dealIds[0] }] } } : {}),
      ...(leadIds.length    ? { "Lead Source":  { relation: [{ id: leadIds[0] }] } } : {}),
      ...(picIds.length     ? { "PIC":          { relation: [{ id: picIds[0] }] } } : {}),
    }, process.env.NOTION_API_KEY)
    console.log("[convert_proposal] quotation props patched")

    // ── 4. Look up products from Catalogue ─────────────────────────────────
    const osSlug  = OS_SLUG_MAP[osTypeRaw.toLowerCase().trim()] || null
    const isOsPkg = osSlug && OS_PACKAGE_SLUGS.has(osSlug)

    const [baseProduct, mainProduct, addonProducts] = await Promise.all([
      isOsPkg ? fetchProduct("base-os") : Promise.resolve(null),
      osSlug  ? fetchProduct(osSlug)    : Promise.resolve(null),
      dealIds.length ? fetchDealAddons(dealIds[0]) : Promise.resolve([]),
    ])

    const lineItems = []
    if (isOsPkg && baseProduct?.id) lineItems.push(baseProduct)
    if (mainProduct?.id) {
      lineItems.push({
        ...mainProduct,
        description: buildModuleDescription(osSlug) || mainProduct.description,
      })
    }
    lineItems.push(...addonProducts)
    console.log("[convert_proposal] products to write:", lineItems.map(l => l.name))

    // ── 5. Find the existing inline Products & Services DB on the quotation ─
    // Notion's template already has this table — we find it, not create it.
    // Allow a moment for Notion to fully index the new page's children.
    let dbId = await findLineItemsDB(quotId)
    if (!dbId) {
      console.log("[convert_proposal] inline DB not found yet — waiting 2s and retrying")
      await new Promise(r => setTimeout(r, 2000))
      dbId = await findLineItemsDB(quotId)
    }
    if (!dbId) {
      // Last resort: create it so products still get written
      console.log("[convert_proposal] inline DB still not found — creating fallback")
      dbId = await createLineItemsDB(quotId)
      await new Promise(r => setTimeout(r, 800))
    }
    console.log("[convert_proposal] inline DB:", dbId)

    // ── 6. Write line items sequentially (preserves order) ─────────────────
    for (const item of lineItems) {
      await createLineItem(dbId, item)
    }
    console.log("[convert_proposal] wrote", lineItems.length, "line items")

    // ── 7. Mark proposal → Quotation Issued ────────────────────────────────
    await patchPage(proposalId, {
      "Status": { select: { name: "Quotation Issued" } },
    }, process.env.NOTION_API_KEY)

    return res.status(200).json({
      status:          "ok",
      proposal_id:     proposalId,
      quotation_id:    quotId,
      os_type:         osTypeRaw,
      quote_type_used: quoteType,
      line_items:      lineItems.length,
      products:        lineItems.map(l => l.name),
    })

  } catch (e) {
    console.error("[convert_proposal] error:", e.message, e.stack?.slice(0, 400))
    return res.status(500).json({ error: e.message })
  }
}
