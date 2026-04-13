// ─── convert_proposal.js ───────────────────────────────────────────────────
// Supports TWO modes:
//
// MODE A — Notion button sends webhook AFTER manually creating a quotation page:
//   POST { "proposal_id": "<proposal_page_id>", "quotation_id": "<new_quotation_page_id>" }
//   → Reads proposal line items + metadata
//   → Fills existing quotation page (already created by Notion button)
//   → Populates inline Products & Services DB on the quotation
//   → Links Proposal → Converted Quotation relation
//   → Sets Proposal status → "Quotation Issued"
//
// MODE B — Legacy: API creates the quotation page itself (fallback)
//   POST { "page_id": "<proposal_page_id>" }
//   → Creates new Quotation page, fills it, links it back

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
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers: hdrs() })
    if (!r.ok) return null
    const blocks = (await r.json()).results || []

    // First: check direct children for child_database
    const directDb = blocks.find(b => b.type === "child_database")
    if (directDb) return directDb.id.replace(/-/g, "")

    // Second: check inside callouts and other container blocks
    const containers = blocks.filter(b => ["callout", "column", "column_list", "toggle"].includes(b.type))
    const inner = await Promise.all(
      containers.map(async b => {
        try {
          const nb = await fetch(`https://api.notion.com/v1/blocks/${b.id}/children?page_size=50`, { headers: hdrs() })
          return nb.ok ? (await nb.json()).results || [] : []
        } catch { return [] }
      })
    )
    const innerDb = inner.flat().find(b => b.type === "child_database")
    if (innerDb) return innerDb.id.replace(/-/g, "")

    return null
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
      body: JSON.stringify({ sorts: [{ property: "No", direction: "ascending" }], page_size: 50 }),
    })
    if (!r.ok) return []
    return (await r.json()).results.map(row => {
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
  return (await r.json()).id.replace(/-/g, "")
}

// ── Write a single line item into the quotation DB ────────────────────────
async function createLineItem(dbId, item) {
  const props = {
    "Notes": { title: [] },
    "Qty":   { number: item.qty || 1 },
    ...(item.product_id  ? { "Product":   { relation: [{ id: item.product_id }] } } : {}),
    ...(item.unit_price != null ? { "Unit Price": { number: Number(item.unit_price) } } : {}),
    ...(item.description ? { "Product Description": { rich_text: [{ text: { content: item.description.slice(0, 2000) } }] } } : {}),
  }
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST", headers: hdrs(),
    body:   JSON.stringify({ parent: { database_id: dbId }, properties: props }),
  })
  if (!r.ok) console.warn("[createLineItem] failed:", r.status)
}

// ── Fill an existing quotation page with proposal data ────────────────────
async function fillQuotation(quotId, propId) {
  // 1. Read proposal
  const proposal = await getPage(propId, process.env.NOTION_API_KEY)
  const pp = proposal.properties

  const companyIds    = (pp.Company?.relation || []).map(r => r.id.replace(/-/g, ""))
  const leadSourceIds = (pp["Lead Source"]?.relation || []).map(r => r.id.replace(/-/g, ""))
  const payTerms      = pp["Payment Terms"]?.select?.name || "50% Deposit"
  const quoteType     = pp["Quote Type"]?.select?.name || "New Business"
  const leadIds       = (pp["Deal Source"]?.relation || []).map(r => r.id.replace(/-/g, ""))

  console.log("[convert_proposal] proposal:", propId, "→ quotation:", quotId)

  // 2. Read line items from proposal inline DB
  const propDbId  = await findLineItemsDB(propId)
  const lineItems = propDbId ? await readLineItems(propDbId) : []
  console.log("[convert_proposal] line items:", lineItems.length)

  // 3. Patch quotation page properties
  const today = new Date().toISOString().split("T")[0]
  await patchPage(quotId, {
    "Issue Date":    { date: { start: today } },
    "Payment Terms": { select: { name: payTerms } },
    ...(quoteType        ? { "Quote Type":   { select: { name: quoteType } } } : {}),
    ...(companyIds.length ? { "Company":     { relation: [{ id: companyIds[0] }] } } : {}),
    ...(leadIds.length    ? { "Deal Source": { relation: [{ id: leadIds[0] }] } } : {}),
    ...(leadSourceIds.length ? { "Lead Source": { relation: [{ id: leadSourceIds[0] }] } } : {}),
  }, process.env.NOTION_API_KEY)

  // 4. Find existing inline DB (already there from template) or create one
  let quotDbId = await findLineItemsDB(quotId)
  if (!quotDbId) {
    console.log("[convert_proposal] no inline DB found — creating")
    quotDbId = await createLineItemsDB(quotId)
    await new Promise(r => setTimeout(r, 1500))
  }
  console.log("[convert_proposal] inline DB:", quotDbId)

  // 5. Write line items sequentially
  for (const item of lineItems) {
    await createLineItem(quotDbId, item)
  }
  console.log("[convert_proposal] wrote", lineItems.length, "line items")

  // 6. Mark proposal as Quotation Issued + link relation
  await patchPage(propId, {
    "Status": { select: { name: "Quotation Issued" } },
  }, process.env.NOTION_API_KEY)

  try {
    await patchPage(propId, {
      "Converted Quotation": { relation: [{ id: quotId }] },
    }, process.env.NOTION_API_KEY)
  } catch (e) {
    console.warn("[convert_proposal] relation link failed:", e.message)
  }

  return { lineItemsCopied: lineItems.length }
}

// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") return res.json({ service: "Opxio — Convert Proposal", status: "ready" })
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body = req.body || {}

  // ── MODE A: Notion webhook sends both proposal_id + quotation_id ──────────
  // Set up in Notion: button creates page first, then fires webhook to this endpoint
  // Webhook payload: { "proposal_id": "...", "quotation_id": "..." }
  const proposalId  = (body.proposal_id  || body.source?.page_id || body.data?.page_id || "").replace(/-/g, "")
  const quotationId = (body.quotation_id || body.data?.quotation_id || "").replace(/-/g, "")

  if (!proposalId) return res.status(400).json({ error: "Missing proposal_id" })

  try {
    if (quotationId) {
      // ── MODE A: quotation page already exists, just fill it ───────────────
      console.log("[convert_proposal] MODE A — filling existing quotation:", quotationId)
      const result = await fillQuotation(quotationId, proposalId)
      return res.status(200).json({ status: "ok", mode: "fill", proposalId, quotationId, ...result })

    } else {
      // ── MODE B: legacy — create the quotation page ourselves ──────────────
      console.log("[convert_proposal] MODE B — creating new quotation page")

      const proposal = await getPage(proposalId, process.env.NOTION_API_KEY)
      const pp = proposal.properties
      const companyIds    = (pp.Company?.relation || []).map(r => r.id.replace(/-/g, ""))
      const leadSourceIds = (pp["Lead Source"]?.relation || []).map(r => r.id.replace(/-/g, ""))
      const leadIds       = (pp["Deal Source"]?.relation || []).map(r => r.id.replace(/-/g, ""))
      const payTerms      = pp["Payment Terms"]?.select?.name || "50% Deposit"
      const quoteType     = pp["Quote Type"]?.select?.name || "New Business"
      const today         = new Date().toISOString().split("T")[0]

      const quotPage = await createPage({
        parent: { database_id: DB.QUOTATIONS },
        properties: {
          "Quotation No.": { title: [{ text: { content: "" } }] },
          "Status":        { select: { name: "Draft" } },
          "Issue Date":    { date: { start: today } },
          "Payment Terms": { select: { name: payTerms } },
          ...(quoteType        ? { "Quote Type":   { select: { name: quoteType } } } : {}),
          ...(companyIds.length ? { "Company":     { relation: [{ id: companyIds[0] }] } } : {}),
          ...(leadIds.length    ? { "Deal Source": { relation: [{ id: leadIds[0] }] } } : {}),
          ...(leadSourceIds.length ? { "Lead Source": { relation: [{ id: leadSourceIds[0] }] } } : {}),
        }
      }, process.env.NOTION_API_KEY)

      const newQuotId = quotPage.id.replace(/-/g, "")

      // Poll for inline DB
      let quotDbId = null
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 2500))
        quotDbId = await findLineItemsDB(newQuotId)
        if (quotDbId) break
      }
      if (!quotDbId) {
        quotDbId = await createLineItemsDB(newQuotId)
        await new Promise(r => setTimeout(r, 1500))
      }

      const propDbId  = await findLineItemsDB(proposalId)
      const lineItems = propDbId ? await readLineItems(propDbId) : []
      for (const item of lineItems) await createLineItem(quotDbId, item)

      await patchPage(proposalId, {
        "Status": { select: { name: "Quotation Issued" } },
      }, process.env.NOTION_API_KEY)
      try {
        await patchPage(proposalId, {
          "Converted Quotation": { relation: [{ id: quotPage.id }] },
        }, process.env.NOTION_API_KEY)
      } catch (e) {
        console.warn("[convert_proposal] relation link failed:", e.message)
      }

      return res.status(200).json({
        status: "ok", mode: "create",
        proposalId, quotationId: newQuotId,
        lineItemsCopied: lineItems.length,
      })
    }
  } catch (e) {
    console.error("[convert_proposal] error:", e.message, e.stack)
    return res.status(500).json({ error: e.message })
  }
}
