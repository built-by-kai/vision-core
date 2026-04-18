// ─── create_addon.js ───────────────────────────────────────────────────────
// POST /api/create_addon   { "page_id": "<project_page_id>" }
// Triggered by Notion button "Create Add-on Quotation" on a Project page.
//
// 1. Fetches Project → Company, Deal, original Quotation, Client Account
// 2. Creates a Draft Quotation (Full Upfront, Quote Type = Add-on)
// 3. Creates an Add-on record in Add-ons DB linked to the Quotation
// 4. Appends blank Products & Services DB to quotation page
// 5. Returns quotation URL

import { getPage, createPage, plain, DB, hdrs } from "../../lib/notion"

async function fetchProject(projectId, token) {
  const page  = await getPage(projectId, token)
  const props = page.properties

  const companyId = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null

  // Get Deal from Project
  let dealId = null
  for (const field of ["Deals", "Deal Source", "Lead"]) {
    const rels = props[field]?.relation || []
    if (rels.length) { dealId = rels[0].id.replace(/-/g, ""); break }
  }

  // Get Client Account (dual-property synced)
  const clientAccountId = props["Client Account"]?.relation?.[0]?.id?.replace(/-/g, "") || null

  const originalQuotationId = props.Quotation?.relation?.[0]?.id?.replace(/-/g, "") || null
  const projName = plain(props["Project Name"]?.title || [])

  return { companyId, dealId, clientAccountId, originalQuotationId, projectName: projName }
}

async function createAddonQuotation(projectId, projData, token) {
  const today = new Date().toISOString().split("T")[0]
  const { companyId, dealId } = projData

  const baseProps = {
    "Quotation No.": { title: [{ text: { content: "" } }] },
    "Status":        { select: { name: "Draft" } },
    "Issue Date":    { date: { start: today } },
    "Payment Terms": { select: { name: "Full Upfront" } },
    "Quote Type":    { select: { name: "Add-on" } },
    "Package Type":  { rich_text: [{ text: { content: "Add-on" } }] },
    // Link back to the project so create_invoice won't create a duplicate project
    "Project":       { relation: [{ id: projectId }] },
    ...(companyId ? { "Company": { relation: [{ id: companyId }] } } : {}),
    ...(dealId    ? { "Deal Source": { relation: [{ id: dealId }] } } : {}),
  }

  const r = await fetch("https://api.notion.com/v1/pages", {
    method:  "POST",
    headers: hdrs(token),
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

// ── Create an entry in the Add-ons tracker DB ───────────────────────────────
// This is the source-of-truth record for what the client purchased.
// The Quotation / Invoice flow is the billing side; this is the operational side.
async function createAddonRecord({ projectId, quotationId, companyId, dealId, clientAccountId, projName, token }) {
  try {
    const today = new Date().toISOString().split("T")[0]
    const addonName = projName ? `Add-on — ${projName}` : "Add-on"

    const props = {
      "Add-on Name":    { title: [{ text: { content: addonName } }] },
      "Status":         { select: { name: "Pending" } },
      "Requested When": { select: { name: "Post-Install" } },
      ...(companyId       ? { "Company":              { relation: [{ id: companyId       }] } } : {}),
      ...(quotationId     ? { "Quotation":             { relation: [{ id: quotationId     }] } } : {}),
      ...(dealId          ? { "Linked Deal":           { relation: [{ id: dealId          }] } } : {}),
      ...(clientAccountId ? { "Linked Client Account": { relation: [{ id: clientAccountId }] } } : {}),
    }

    const page = await createPage({ parent: { database_id: DB.ADD_ONS }, properties: props }, token)
    const addonId = page.id.replace(/-/g, "")
    console.log("[create_addon] Add-on record created:", addonId)
    return addonId
  } catch (e) {
    console.warn("[create_addon] createAddonRecord:", e.message)
    return null
  }
}

async function createLineItemsDB(pageId, token) {
  // Inline Products & Services DB for the quotation
  const r = await fetch("https://api.notion.com/v1/databases", {
    method:  "POST",
    headers: hdrs(token),
    body:    JSON.stringify({
      parent:    { type: "page_id", page_id: pageId },
      is_inline: true,
      title: [{ type: "text", text: { content: "Products & Services" } }],
      properties: {
        "Notes":       { title: {} },
        "Product":     { relation: { database_id: DB.CATALOGUE, single_property: {} } },
        "Unit Price":  { number: { format: "number" } },
        "Qty":         { number: { format: "number" } },
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

  const token = process.env.NOTION_API_KEY

  try {
    const body  = req.body || {}
    const rawId = body.page_id || body.source?.page_id || body.data?.page_id || body.data?.id
    if (!rawId) return res.status(400).json({ error: "Missing page_id" })

    const projectId = rawId.replace(/-/g, "")
    const projData  = await fetchProject(projectId, token)

    // 1. Create the Add-on Quotation
    const { id: quotId, url: quotUrl } = await createAddonQuotation(projectId, projData, token)

    // 2. Create Add-on tracker record and link it to the quotation
    const addonId = await createAddonRecord({
      projectId,
      quotationId:     quotId,
      companyId:       projData.companyId,
      dealId:          projData.dealId,
      clientAccountId: projData.clientAccountId,
      projName:        projData.projectName,
      token,
    })

    // 3. Append blank Products & Services inline DB to the quotation page
    try {
      await createLineItemsDB(quotId, token)
    } catch (e) {
      console.warn("[create_addon] line items DB:", e.message)
    }

    return res.json({
      status:         "success",
      project_id:     projectId,
      project_name:   projData.projectName,
      quotation_id:   quotId,
      quotation_url:  quotUrl,
      addon_record_id: addonId,
      note:           "Fill in add-on line items in the quotation, then set Status → Approved to generate invoice",
    })
  } catch (e) {
    console.error("[create_addon]", e)
    return res.status(500).json({ error: e.message })
  }
}
