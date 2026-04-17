// ─── create_addon.js ───────────────────────────────────────────────────────
// POST /api/create_addon   { "page_id": "<project_page_id>" }
// Triggered by Notion button "Create Add-on Quotation" on a Project page.
//
// 1. Fetches Project → Company, Deal Source, original Quotation, Package
// 2. Creates a Draft Quotation (Full Upfront, Quote Type = same as original)
// 3. Appends blank Products & Services DB to quotation page
// 4. Returns quotation URL

import { getPage, createPage, queryDB, plain, DB } from "../../lib/notion"


function hdrs() {
  return {
    Authorization:    `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": "2022-06-28",
    "Content-Type":   "application/json",
  }
}

async function fetchProject(projectId) {
  const page  = await getPage(projectId, process.env.NOTION_API_KEY)
  const props = page.properties

  const companyIds = (props.Company?.relation || []).map(r => r.id.replace(/-/g, ""))

  let leadIds = []
  for (const field of ["Deal Source", "Lead", "Deals"]) {
    const rels = props[field]?.relation || []
    if (rels.length) {
      leadIds = rels.map(r => r.id.replace(/-/g, ""))
      break
    }
  }

  const originalQuotationIds = (props.Quotation?.relation || []).map(r => r.id.replace(/-/g, ""))
  const pkg      = props.Package?.select?.name || "New Business"
  const projName = plain(props["Project Name"]?.title || [])

  return { companyIds, leadIds, originalQuotationIds, package: pkg, projectName: projName }
}

async function createAddonQuotation(projectId, projData) {
  const today = new Date().toISOString().split("T")[0]
  const { companyIds, leadIds, package: pkg } = projData

  const baseProps = {
    "Quotation No.": { title: [{ text: { content: "" } }] },
    "Status":        { select: { name: "Draft" } },
    "Issue Date":    { date: { start: today } },
    "Payment Terms": { select: { name: "Full Upfront" } },
    "Quote Type":    { select: { name: pkg } },
    "Package Type":  { rich_text: [{ text: { content: "Add-on" } }] },
  }

  if (companyIds.length) {
    baseProps.Company = { relation: [{ id: companyIds[0] }] }
  }

  // Link back to the project so create_invoice won't make a duplicate project
  baseProps.Project = { relation: [{ id: projectId }] }

  // Try to link Deal Source (Lead) — field name may vary
  const leadPropNames = ["Deal Source", "Lead", "Deals"]

  for (const fieldName of leadPropNames) {
    const props = { ...baseProps }
    if (leadIds.length) {
      props[fieldName] = { relation: [{ id: leadIds[0] }] }
    }

    const r = await fetch("https://api.notion.com/v1/pages", {
      method:  "POST",
      headers: hdrs(),
      body:    JSON.stringify({ parent: { database_id: DB.QUOTATIONS }, properties: props }),
    })

    if (r.ok) {
      const page = await r.json()
      const id   = page.id.replace(/-/g, "")
      return { id, url: page.url || `https://notion.so/${id}` }
    }

    const text = await r.text()
    // If rejected because of specific field, try the next name
    if (text.includes(fieldName) || text.includes("relation")) continue
    // Other error — fall through to create without lead field
    console.warn(`[create_addon] create attempt failed ${r.status}: ${text.slice(0, 200)}`)
    break
  }

  // Fallback: create without lead field
  const r = await fetch("https://api.notion.com/v1/pages", {
    method:  "POST",
    headers: hdrs(),
    body:    JSON.stringify({ parent: { database_id: DB.QUOTATIONS }, properties: baseProps }),
  })
  if (!r.ok) {
    const txt = await r.text()
    throw new Error(`Create quotation failed ${r.status}: ${txt.slice(0, 200)}`)
  }
  const page = await r.json()
  const id   = page.id.replace(/-/g, "")
  return { id, url: page.url || `https://notion.so/${id}` }
}

async function createLineItemsDB(pageId) {
  // Callout header
  await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method:  "PATCH",
    headers: hdrs(),
    body:    JSON.stringify({
      children: [{
        type: "callout",
        callout: {
          rich_text: [{ type: "text", text: { content: "Products & Services" }, annotations: { bold: true } }],
          icon: null, color: "default_background",
        },
      }],
    }),
  })

  // Inline Products & Services DB
  const r = await fetch("https://api.notion.com/v1/databases", {
    method:  "POST",
    headers: hdrs(),
    body:    JSON.stringify({
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
  if (r.ok) {
    const db = await r.json()
    return db.id.replace(/-/g, "")
  }
  const txt = await r.text()
  console.warn(`[create_addon] DB create ${r.status}: ${txt.slice(0, 200)}`)
  return null
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Create Add-on Quotation", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const body  = req.body || {}
    const rawId = body.page_id || body.source?.page_id || body.data?.page_id
    if (!rawId) return res.status(400).json({ error: "Missing page_id" })

    const projectId = rawId.replace(/-/g, "")
    const projData  = await fetchProject(projectId)
    const { id: quotId, url: quotUrl } = await createAddonQuotation(projectId, projData)

    try {
      await createLineItemsDB(quotId)
    } catch (e) {
      console.warn("[create_addon] line items DB:", e.message)
    }

    return res.json({
      status:        "success",
      project_id:    projectId,
      project_name:  projData.projectName,
      quotation_id:  quotId,
      quotation_url: quotUrl,
      note:          "Fill in add-on line items, then set Status → Approved to generate invoice",
    })
  } catch (e) {
    console.error("[create_addon]", e)
    return res.status(500).json({ error: e.message })
  }
}
