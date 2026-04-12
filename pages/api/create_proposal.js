// ─── create_proposal.js ────────────────────────────────────────────────────
// POST /api/create_proposal  { "page_id": "<lead_page_id>" }
// Triggered by Notion button on a Lead CRM page (two-action button):
//   Action 1: "Add a page to Proposals DB" (applies template with inline P&S DB)
//   Action 2: "Send webhook" to this endpoint with Lead page_id
//
// What this does:
//   1. Reads lead info (Company, PIC, OS Type, Add-Ons)
//   2. Finds the recently created Proposal page (within last 3min)
//   3. Patches Proposal with lead data (OS Type, Company, PIC, Payment Terms)
//   4. Creates or finds the inline Products & Services DB on the Proposal page
//   5. Auto-populates line items (Base OS → Main OS → Add-Ons, sequential)
//   6. Advances Lead stage → "Proposal Sent"

import { getPage, patchPage, createPage, queryDB, plain, DB } from "../../lib/notion"

function hdrs() {
  return {
    Authorization:    `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": "2022-06-28",
    "Content-Type":   "application/json",
  }
}

// ── Package slug → Catalogue DB ───────────────────────────────────────────
const OS_TYPE_SLUG_MAP = {
  "revenue os":      "revenue-os",
  "sales os":        "revenue-os",
  "operations os":   "operations-os",
  "business os":     "business-os",
  "marketing os":    "marketing-os",
  "agency os":       "full-platform-os",
  "full platform":   "full-platform-os",
  "team os":         "team-os",
  "retention os":    "retention-os",
  "intelligence os": "intelligence-os",
  "starter os":      "starter-os",
}

const ADDON_SLUG_MAP = {
  "additional system module":           "addon-system-module",
  "automation (within database)":       "addon-automation-within",
  "automation — within database":       "addon-automation-within",
  "automation (cross-database)":        "addon-automation-cross",
  "automation — cross-database":        "addon-automation-cross",
  "advanced dashboard":                 "addon-dashboard",
  "enhanced dashboard":                 "addon-dashboard",
  "custom widget":                      "addon-widget",
  "api / external integration":         "addon-api-integration",
  "automation & workflow integration":  "addon-workflow-integration",
  "lead capture system":                "addon-lead-capture",
  "client portal view":                 "addon-client-portal",
  "ai agent integration":               "addon-ai-agent",
}

const OS_PACKAGE_SLUGS = new Set([
  "revenue-os", "operations-os", "business-os", "full-platform-os",
  "marketing-os", "team-os", "retention-os", "intelligence-os",
  "starter-os",
])

// ── Fetch product info from Catalogue ──────────────────────────────────────
async function fetchProductInfo(slug) {
  if (!slug) return null
  try {
    const rows = await queryDB(DB.CATALOGUE, {
      property: "Slug", rich_text: { equals: slug }
    }, process.env.NOTION_API_KEY)
    if (!rows.length) return null
    const p = rows[0]
    return {
      id:          p.id.replace(/-/g, ""),
      name:        plain(p.properties["Product Name"]?.title || []),
      price:       p.properties.Price?.number ?? null,
      quote_type:  p.properties["Quote Type"]?.select?.name || "New Business",
      description: plain(p.properties.Description?.rich_text || []),
      slug,
    }
  } catch (e) {
    console.warn("[create_proposal] fetchProductInfo:", slug, e.message)
    return null
  }
}

// ── Find the most recently created proposal (within last 3 min) ────────────
// ── Find proposal via Lead's Proposals relation (primary) ─────────────────
// Notion button Action 1 creates proposal page with Deal Source = Lead,
// which auto-populates Lead.Proposals (bidirectional). We read that to find
// the newly created proposal — same pattern as create_quotation.js
async function findProposalFromLead(leadProps, maxAgeSeconds = 180) {
  const proposalIds = (leadProps.Proposals?.relation || []).map(r => r.id.replace(/-/g, ""))
  if (!proposalIds.length) return null

  const pages = await Promise.all(proposalIds.map(async id => {
    try {
      const p   = await getPage(id, process.env.NOTION_API_KEY)
      const age = (Date.now() - new Date(p.created_time)) / 1000
      return age <= maxAgeSeconds ? { id, page: p, age } : null
    } catch { return null }
  }))

  const recent = pages.filter(Boolean).sort((a, b) => a.age - b.age)[0]
  if (recent) {
    console.log(`[findProposalFromLead] found: ${recent.id.slice(0,8)} age:${recent.age.toFixed(0)}s`)
    return { id: recent.id }
  }
  return null
}

// ── Fallback: find most recently created proposal page (time-based) ────────
async function findRecentProposal(maxAgeSeconds = 180) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB.PROPOSALS}/query`, {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 5,
      }),
    })
    const data = await r.json()
    const now  = Date.now()
    for (const row of data.results || []) {
      const age = (now - new Date(row.created_time)) / 1000
      if (age <= maxAgeSeconds) {
        const id = row.id.replace(/-/g, "")
        console.log(`[findRecentProposal] fallback found: ${id.slice(0,8)} age:${age.toFixed(0)}s`)
        return { id, page: row }
      }
    }
  } catch (e) {
    console.warn("[findRecentProposal]", e.message)
  }
  return null
}

// ── Find inline Products & Services DB on a page ──────────────────────────
async function findLineItemsDB(pageId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
      headers: hdrs(),
    })
    if (!r.ok) return null
    const blocks = (await r.json()).results || []
    // Check direct children AND inside callouts
    const callouts = blocks.filter(b => b.type === "callout")
    const inner = await Promise.all(
      callouts.map(async b => {
        try {
          const nb = await fetch(`https://api.notion.com/v1/blocks/${b.id}/children`, { headers: hdrs() })
          return nb.ok ? (await nb.json()).results || [] : []
        } catch { return [] }
      })
    )
    const allBlocks = [...blocks, ...inner.flat()]
    const dbBlock = allBlocks.find(b => b.type === "child_database")
    if (dbBlock) return dbBlock.id.replace(/-/g, "")
  } catch (e) {
    console.warn("[findLineItemsDB]", e.message)
  }
  return null
}

// ── Create Products & Services inline DB on the proposal page ─────────────
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
      title:     [{ type: "text", text: { content: "Products & Services" } }],
      properties: {
        "Notes":               { title: {} },
        "Product":             { relation: { database_id: DB.CATALOGUE, single_property: {} } },
        "Product Description": { rich_text: {} },
        "Unit Price":          { number: { format: "ringgit" } },
        "Qty":                 { number: { format: "number" } },
        "Subtotal":            { formula: { expression: 'prop("Qty") * prop("Unit Price")' } },
      },
    }),
  })
  if (!r.ok) throw new Error(`Create DB: ${r.status} ${(await r.text()).slice(0, 150)}`)
  const db = await r.json()
  return db.id.replace(/-/g, "")
}

// ── Get existing placeholder rows from the inline DB ──────────────────────
async function getExistingRows(dbId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({ page_size: 50 }),
    })
    if (!r.ok) return []
    return (await r.json()).results || []
  } catch (e) {
    console.warn("[getExistingRows]", e.message)
    return []
  }
}

// ── Fill an existing placeholder row with product data ─────────────────────
async function fillRow(rowId, product) {
  const props = {
    "Qty": { number: 1 },
    ...(product.id        ? { "Product":   { relation: [{ id: product.id }] } } : {}),
    ...(product.price != null ? { "Unit Price": { number: Number(product.price) } } : {}),
    ...(product.description ? { "Product Description": { rich_text: [{ text: { content: product.description.slice(0, 2000) } }] } } : {}),
  }
  // Try with description col first, then without
  for (const descCol of product.description ? ["Product Description", "Description", "Details", null] : [null]) {
    const p = descCol
      ? { ...props, [descCol]: { rich_text: [{ text: { content: product.description.slice(0, 2000) } }] } }
      : props
    const r = await fetch(`https://api.notion.com/v1/pages/${rowId}`, {
      method: "PATCH", headers: hdrs(),
      body: JSON.stringify({ properties: p }),
    })
    if (r.ok) return
  }
}

// ── Create a new line item row ─────────────────────────────────────────────
async function createLineItem(dbId, product) {
  const baseProps = {
    "Notes": { title: [] },
    "Qty":   { number: 1 },
    ...(product.id    ? { "Product":   { relation: [{ id: product.id }] } } : {}),
    ...(product.price != null ? { "Unit Price": { number: Number(product.price) } } : {}),
  }
  const descCols = product.description ? ["Product Description", "Description", "Details"] : []
  for (const col of [...descCols, null]) {
    const props = col
      ? { ...baseProps, [col]: { rich_text: [{ text: { content: product.description.slice(0, 2000) } }] } }
      : baseProps
    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: hdrs(),
      body:   JSON.stringify({ parent: { database_id: dbId }, properties: props }),
    })
    if (r.ok) return
    if (col === null) console.warn("[createLineItem] failed:", r.status)
  }
}

// ─── Convert Lead → Deal ──────────────────────────────────────────────────────
// Called by ?type=deal  (Notion "Convert to Deal" button on Leads page)
//
// Button setup — two actions:
//   Action 1: "Add page to Deals DB" — Notion creates the Deal page from template.
//             In the button config, set "Lead Source" = current Lead page.
//             This creates the bidirectional link before the webhook fires.
//   Action 2: "Send webhook" → POST /api/create_proposal with {"type":"deal"}
//             Webhook finds the newly created Deal via Lead.Deal relation,
//             patches all data in, advances Lead stage → Converted.
//
// Fallback: if the two-action button isn't set up, the handler creates
// the Deal page itself (same end result).

async function findDealFromLead(leadProps, maxAgeSeconds = 180) {
  // Primary: check the Lead.Deal relation (set by Action 1 button)
  const dealIds = (leadProps.Deal?.relation || []).map(r => r.id.replace(/-/g, ""))
  for (const id of dealIds) {
    try {
      const dp = await getPage(id, process.env.NOTION_API_KEY)
      const age = (Date.now() - new Date(dp.created_time).getTime()) / 1000
      if (age < maxAgeSeconds) return dp
    } catch {}
  }
  return null
}

async function handleConvertToDeal(leadId, res) {
  const token = process.env.NOTION_API_KEY
  const lead  = await getPage(leadId, token)
  const lp    = lead.properties

  const companyIds    = (lp.Company?.relation    || []).map(r => r.id.replace(/-/g, ""))
  const picIds        = (lp["PIC Name"]?.relation || []).map(r => r.id.replace(/-/g, ""))
  const osInterest    = lp["OS Interest"]?.select?.name || ""
  const addons        = (lp["Add-ons"]?.multi_select || []).map(a => a.name)
  const situation     = plain(lp.Situation?.rich_text || [])
  const notes         = plain(lp.Notes?.rich_text     || [])
  const leadName      = plain(lp["Lead Name"]?.title   || [])
  const discoveryCall = lp["Discovery Call"]?.date?.start || null

  // ── Find or create the Deal page ──────────────────────────────────────────
  // If Action 1 already created it (two-action button), find it via Lead.Deal relation
  // and just patch it. Otherwise create it fresh.
  let dealPage = await findDealFromLead(lp)
  let dealId

  if (dealPage) {
    dealId = dealPage.id.replace(/-/g, "")
    console.log(`[convert_to_deal] found existing deal page: ${dealId}`)
  } else {
    // Fallback: create the Deal page (single-action button or webhook-only setup)
    dealPage = await createPage({
      parent: { database_id: DB.DEALS },
      properties: {
        "Lead Name":   { title: [{ text: { content: leadName } }] },
        "Stage":       { status: { name: "Discovery Done" } },
        "Lead Source": { relation: [{ id: leadId }] },
      },
    }, token)
    dealId = dealPage.id.replace(/-/g, "")
    console.log(`[convert_to_deal] created new deal page: ${dealId}`)
  }

  // ── Patch all Lead data into the Deal ─────────────────────────────────────
  await patchPage(dealId, {
    "Stage":       { status: { name: "Discovery Done" } },
    "Lead Source": { relation: [{ id: leadId }] },
    ...(leadName          ? { "Lead Name":     { title: [{ text: { content: leadName } }] } } : {}),
    ...(companyIds.length ? { "Company":       { relation: [{ id: companyIds[0] }] } } : {}),
    ...(picIds.length     ? { "PIC Name":      { relation: [{ id: picIds[0]     }] } } : {}),
    ...(osInterest        ? { "Package Type":  { select: { name: osInterest } } } : {}),
    ...(addons.length     ? { "Add-ons":       { multi_select: addons.map(n => ({ name: n })) } } : {}),
    ...(situation         ? { "Situation":     { rich_text: [{ text: { content: situation } }] } } : {}),
    ...(notes             ? { "Notes":         { rich_text: [{ text: { content: notes } }] } } : {}),
    ...(discoveryCall     ? { "Discovery Call":{ date: { start: discoveryCall } } } : {}),
  }, token)

  // ── Update Lead: link Deal + advance Stage → Converted ────────────────────
  await patchPage(leadId, {
    "Deal":  { relation: [{ id: dealId }] },
    "Stage": { status: { name: "Converted" } },
  }, token)

  console.log(`[convert_to_deal] ✓ lead ${leadId} → deal ${dealId}`)
  return res.status(200).json({ status: "ok", leadId, dealId, dealUrl: dealPage.url })
}

// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") return res.json({ service: "Opxio — Create Proposal", status: "ready" })
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body  = req.body || {}
  const rawId = body.page_id || body.source?.page_id || body.data?.page_id || body.data?.id
  if (!rawId) return res.status(400).json({ error: "Missing page_id" })
  const leadId = rawId.replace(/-/g, "")

  // Route to Convert to Deal handler if type=deal
  if ((body.type || req.query.type) === "deal") {
    return handleConvertToDeal(leadId, res).catch(e => {
      console.error("[convert_to_deal] error:", e.message)
      return res.status(500).json({ error: e.message })
    })
  }

  try {
    // ── 1. Get Lead info ─────────────────────────────────────────────────────
    const lead       = await getPage(leadId, process.env.NOTION_API_KEY)
    const leadProps  = lead.properties
    const companyIds = (leadProps.Company?.relation || []).map(r => r.id.replace(/-/g, ""))

    let picIds = []
    for (const f of ["PIC Name", "PIC", "Contact", "Person in Charge"]) {
      picIds = (leadProps[f]?.relation || []).map(r => r.id.replace(/-/g, ""))
      if (picIds.length) break
    }

    // Resolve OS type
    // OS Interest (Leads field) or Package Type (Deals field) — check both
    const osName = leadProps["OS Interest"]?.select?.name || leadProps["Package Type"]?.select?.name || ""
    const pkgRaw = osName.toLowerCase().trim()
    const slug   = OS_TYPE_SLUG_MAP[pkgRaw] || "operations-os"

    // Add-ons from lead — field is "Add-ons" (lowercase o)
    const addonSlugs = []
    for (const item of (leadProps["Add-ons"]?.multi_select || leadProps["Add-Ons"]?.multi_select || [])) {
      const k = item.name.toLowerCase().trim()
      for (const [key, val] of Object.entries(ADDON_SLUG_MAP)) {
        if (k.includes(key)) { addonSlugs.push(val); break }
      }
    }

    // Fetch products in parallel
    const isOS = OS_PACKAGE_SLUGS.has(slug)
    const [mainProduct, baseProduct, ...addonProducts] = await Promise.all([
      fetchProductInfo(slug),
      isOS ? fetchProductInfo("base-os") : Promise.resolve(null),
      ...addonSlugs.map(s => fetchProductInfo(s)),
    ])

    console.log("[create_proposal] lead:", leadId, "slug:", slug, "addons:", addonSlugs.length)

    // ── 2. Find recently created Proposal page ───────────────────────────────
    // Primary: via Lead.Proposals bidirectional relation (most reliable)
    // Fallback: time-based search (if button wasn't set up with Deal Source)
    let propId = null
    let recent = await findProposalFromLead(leadProps)
    if (!recent) {
      console.log("[create_proposal] relation not found yet — retrying after 2.5s")
      await new Promise(r => setTimeout(r, 2500))
      const freshLead = await getPage(leadId, process.env.NOTION_API_KEY)
      recent = await findProposalFromLead(freshLead.properties)
    }
    if (!recent) recent = await findRecentProposal()

    if (recent) {
      propId = recent.id
      console.log("[create_proposal] found proposal:", propId)
    } else {
      // Fallback: create proposal page directly
      const today = new Date().toISOString().split("T")[0]
      const newProp = await createPage({
        parent: { database_id: DB.PROPOSALS },
        properties: {
          "Ref Number":    { title: [{ text: { content: "" } }] },
          "Status":        { select: { name: "Draft" } },
          "Date":          { date: { start: today } },
          "Payment Terms": { select: { name: "50% Deposit" } },
          ...(osName ? { "OS Type": { select: { name: osName } } } : {}),
          ...(companyIds.length ? { "Company": { relation: [{ id: companyIds[0] }] } } : {}),
          ...(picIds.length ? { "PIC": { relation: [{ id: picIds[0] }] } } : {}),
        }
      }, process.env.NOTION_API_KEY)
      propId = newProp.id.replace(/-/g, "")
      console.log("[create_proposal] fallback created:", propId)
    }

    // ── 3. Patch Proposal properties ─────────────────────────────────────────
    const today = new Date().toISOString().split("T")[0]
    const patchProps = {
      "Status":        { select: { name: "Draft" } },
      "Date":          { date: { start: today } },
      "Payment Terms": { select: { name: "50% Deposit" } },
      "Deal Source":   { relation: [{ id: leadId }] },
      ...(osName               ? { "OS Type":    { select: { name: osName } } } : {}),
      ...(mainProduct?.quote_type ? { "Quote Type": { select: { name: mainProduct.quote_type } } } : {}),
      ...(companyIds.length ? { "Company": { relation: [{ id: companyIds[0] }] } } : {}),
      ...(picIds.length     ? { "PIC":     { relation: [{ id: picIds[0] }] } } : {}),
      // Copy Situation from Lead so it pre-fills the proposal — editable in Notion before generating
      ...((() => {
        const sit = plain(leadProps.Situation?.rich_text || [])
        return sit ? { "Situation": { rich_text: [{ text: { content: sit.slice(0, 2000) } }] } } : {}
      })()),
    }
    await patchPage(propId, patchProps, process.env.NOTION_API_KEY)

    // ── 4. Line Items DB ─────────────────────────────────────────────────────
    let dbId = await findLineItemsDB(propId)
    if (!dbId) {
      dbId = await createLineItemsDB(propId)
      console.log("[create_proposal] created line items DB:", dbId)
    }

    // ── 5. Fill line items (Base OS → Main product → Add-ons) ───────────────
    const lineItems = []
    if (isOS && baseProduct?.id) lineItems.push(baseProduct)
    if (mainProduct?.id)         lineItems.push(mainProduct)
    lineItems.push(...addonProducts.filter(Boolean))

    // Use existing template placeholder rows first, create new rows for overflow
    const existingRows = await getExistingRows(dbId)
    console.log(`[create_proposal] ${existingRows.length} existing rows, ${lineItems.length} products`)

    for (let i = 0; i < lineItems.length; i++) {
      if (i < existingRows.length) {
        // Fill the existing placeholder row in place
        await fillRow(existingRows[i].id, lineItems[i])
      } else {
        // More products than placeholder rows — create new rows
        await createLineItem(dbId, lineItems[i])
      }
    }
    console.log(`[create_proposal] ${lineItems.length} line items populated`)

    // ── 6. Stage advancement removed — proposal/quotation status tracked on documents

    return res.status(200).json({
      status: "ok", propId,
      productName: mainProduct?.name ?? null,
      lineItemsCount: lineItems.length,
    })
  } catch (e) {
    console.error("[create_proposal] error:", e.message, e.stack)
    return res.status(500).json({ error: e.message })
  }
}

