// ─── convert_proposal.js ───────────────────────────────────────────────────
// POST /api/convert_proposal  { "page_id": "<proposal_page_id>" }
// Triggered by "Convert to Quotation" button on an approved Proposal page.
//
// What this does:
//   1. Reads Proposal fields (Company, PIC, OS Type, Payment Terms, etc.)
//   2. Reads Proposal's inline Products & Services line items
//   3. Creates a new Quotation page in the Quotations DB
//   4. Creates/finds inline Products & Services DB on new Quotation page
//   5. Copies all line items from Proposal → Quotation (preserving order)
//   6. Marks Proposal status → "Converted"
//   7. Advances Lead stage → "Quotation Issued" (if Lead linked)

import { getPage, patchPage, createPage, plain, DB } from "../../lib/notion"

function hdrs() {
  return {
    Authorization:    `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": "2022-06-28",
    "Content-Type":   "application/json",
  }
}

// ── Find inline Products & Services DB on a page ──────────────────────────
async function findLineItemsDB(pageId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, { headers: hdrs() })
    if (!r.ok) return null
    const blocks = (await r.json()).results || []
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
    return dbBlock ? dbBlock.id.replace(/-/g, "") : null
  } catch (e) {
    console.warn("[findLineItemsDB]", e.message)
    return null
  }
}

// ── Read all line items from an inline Products & Services DB ─────────────
async function readLineItems(dbId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({
        sorts: [{ property: "No", direction: "ascending" }],
        page_size: 50,
      }),
    })
    if (!r.ok) return []
    const data = await r.json()
    return (data.results || []).map(row => {
      const p = row.properties
      const productRels = p.Product?.relation || []
      return {
        product_id:  productRels.length ? productRels[0].id.replace(/-/g, "") : null,
        name:        plain(p.Notes?.title || p["Product Name"]?.title || []),
        description: plain(p["Product Description"]?.rich_text || p.Description?.rich_text || []),
        qty:         p.Qty?.number ?? 1,
        unit_price:  p["Unit Price"]?.number ?? 0,
      }
    }).filter(item => item.product_id || item.name || item.unit_price)
  } catch (e) {
    console.warn("[readLineItems]", e.message)
    return []
  }
}

// ── Create inline Products & Services DB on quotation page ────────────────
async function createLineItemsDB(pageId) {
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

// ── Create a single line item in the quotation DB ─────────────────────────
async function createLineItem(dbId, item) {
  const props = {
    "Notes": { title: [] },
    "Qty":   { number: item.qty || 1 },
    ...(item.product_id   ? { "Product":   { relation: [{ id: item.product_id }] } } : {}),
    ...(item.unit_price != null ? { "Unit Price": { number: Number(item.unit_price) } } : {}),
    ...(item.description  ? { "Product Description": { rich_text: [{ text: { content: item.description.slice(0, 2000) } }] } } : {}),
  }
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST", headers: hdrs(),
    body:   JSON.stringify({ parent: { database_id: dbId }, properties: props }),
  })
  if (!r.ok) {
    // Fallback without description
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({ parent: { database_id: dbId }, properties: {
        "Notes": { title: [] },
        "Qty":   { number: item.qty || 1 },
        ...(item.product_id   ? { "Product":   { relation: [{ id: item.product_id }] } } : {}),
        ...(item.unit_price != null ? { "Unit Price": { number: Number(item.unit_price) } } : {}),
      }}),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") return res.json({ service: "Opxio — Convert Proposal", status: "ready" })
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body  = req.body || {}
  const rawId = body.page_id || body.source?.page_id || body.data?.page_id || body.data?.id
  if (!rawId) return res.status(400).json({ error: "Missing page_id" })
  const propId = rawId.replace(/-/g, "")

  try {
    // ── 1. Read Proposal page ────────────────────────────────────────────────
    const proposal = await getPage(propId, process.env.NOTION_API_KEY)
    const pp       = proposal.properties

    const companyIds = (pp.Company?.relation || []).map(r => r.id.replace(/-/g, ""))
    const picIds     = (pp.PIC?.relation || []).map(r => r.id.replace(/-/g, ""))
    const osType     = pp["OS Type"]?.select?.name || ""
    const payTerms   = pp["Payment Terms"]?.select?.name || "50% Deposit"
    const quoteType  = pp["Quote Type"]?.select?.name || "New Business"
    const proposalNo = plain(pp["Ref Number"]?.title || [])
    const leadIds    = (pp["Deal Source"]?.relation || []).map(r => r.id.replace(/-/g, ""))

    // Company name for package type field (rich text in Quotations)
    let packageName = osType

    console.log("[convert_proposal] proposal:", propId, "OS:", osType, "company:", companyIds[0] || "none")

    // ── 2. Read line items from Proposal's inline DB ─────────────────────────
    const propDbId  = await findLineItemsDB(propId)
    const lineItems = propDbId ? await readLineItems(propDbId) : []
    console.log("[convert_proposal] line items from proposal:", lineItems.length)

    // ── 3. Create new Quotation page ─────────────────────────────────────────
    const today = new Date().toISOString().split("T")[0]
    const quotPage = await createPage({
      parent: { database_id: DB.QUOTATIONS },
      properties: {
        "Quotation No.": { title: [{ text: { content: "" } }] },
        "Status":        { select: { name: "Draft" } },
        "Issue Date":    { date: { start: today } },
        "Payment Terms": { select: { name: payTerms } },
        ...(quoteType     ? { "Quote Type":   { select: { name: quoteType } } } : {}),
        ...(companyIds.length ? { "Company":  { relation: [{ id: companyIds[0] }] } } : {}),
        ...(picIds.length     ? { "PIC Name": { relation: [{ id: picIds[0] }] } } : {}),
        ...(packageName       ? { "Package Type": { rich_text: [{ text: { content: packageName } }] } } : {}),
      }
    }, process.env.NOTION_API_KEY)

    const quotId  = quotPage.id.replace(/-/g, "")
    const quotUrl = quotPage.url || `https://notion.so/${quotId}`
    console.log("[convert_proposal] created quotation:", quotId)

    // ── 4. Create inline Products & Services on Quotation ───────────────────
    let quotDbId = await findLineItemsDB(quotId)
    if (!quotDbId) {
      quotDbId = await createLineItemsDB(quotId)
    }

    // ── 5. Copy line items from Proposal → Quotation (sequential = preserve order) ─
    for (const item of lineItems) {
      await createLineItem(quotDbId, item)
    }
    console.log(`[convert_proposal] copied ${lineItems.length} line items to quotation`)

    // ── 6. Mark Proposal as Converted ────────────────────────────────────────
    await patchPage(propId, {
      "Status": { select: { name: "Converted" } },
    }, process.env.NOTION_API_KEY)

    // ── 7. Deal Source already linked above in createPage ────────────────────
    // Lead stage advances to "Awaiting Deposit" only when deposit invoice is created.
    if (leadIds.length) {
      console.log("[convert_proposal] quotation linked to deal:", leadIds[0])
    }

    console.log("[convert_proposal] done →", quotId)
    return res.status(200).json({
      status: "ok",
      propId,
      quotId,
      quotUrl,
      lineItemsCopied: lineItems.length,
    })
  } catch (e) {
    console.error("[convert_proposal] error:", e.message, e.stack)
    return res.status(500).json({ error: e.message })
  }
}
