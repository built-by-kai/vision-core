// ─── create_addon.js ───────────────────────────────────────────────────────
// POST /api/create_addon   { "page_id": "<client_account_page_id>" }
// Triggered by Notion button "Create Add-on Quotation" on a Client Account page.
//
// 1. Fetches Client Account → Company, Linked Deal, Project Tracker, Install Name
// 2. Creates a Draft Quotation (Full Upfront, Quote Type = Add-on)
// 3. Creates an Add-on record in Add-ons DB linked to Client Account + Quotation
// 4. Appends blank Products & Services inline DB to the quotation page
// 5. Returns quotation URL

import { getPage, createPage, plain, DB, hdrs } from "../../lib/notion"

async function fetchClientAccount(caId, token) {
  const page  = await getPage(caId, token)
  const props = page.properties

  const installName     = plain(props["Install Name"]?.title || []) || "Client"
  const companyId       = props.Company?.relation?.[0]?.id?.replace(/-/g, "")       || null
  const dealId          = props["Linked Deal"]?.relation?.[0]?.id?.replace(/-/g, "") || null
  const projectId       = props["Project Tracker"]?.relation?.[0]?.id?.replace(/-/g, "") || null
  const picId           = props["Primary Contact"]?.relation?.[0]?.id?.replace(/-/g, "") || null

  return { installName, companyId, dealId, projectId, picId }
}

async function createAddonQuotation(caId, caData, token) {
  const today = new Date().toISOString().split("T")[0]
  const { companyId, dealId, projectId } = caData

  const props = {
    "Quotation No.": { title: [{ text: { content: "" } }] },
    "Status":        { select: { name: "Draft" } },
    "Issue Date":    { date: { start: today } },
    "Payment Terms": { select: { name: "Full Upfront" } },
    "Quote Type":    { select: { name: "Add-on" } },
    "Package Type":  { rich_text: [{ text: { content: "Add-on" } }] },
    ...(companyId ? { "Company":     { relation: [{ id: companyId }] } } : {}),
    ...(dealId    ? { "Deal Source": { relation: [{ id: dealId    }] } } : {}),
    // Link back to the project so create_invoice won't spin up a duplicate project
    ...(projectId ? { "Project":     { relation: [{ id: projectId }] } } : {}),
  }

  const r = await fetch("https://api.notion.com/v1/pages", {
    method:  "POST",
    headers: hdrs(token),
    body:    JSON.stringify({ parent: { database_id: DB.QUOTATIONS }, properties: props }),
  })
  if (!r.ok) {
    const txt = await r.text()
    throw new Error(`Create quotation failed ${r.status}: ${txt.slice(0, 200)}`)
  }
  const page = await r.json()
  return { id: page.id.replace(/-/g, ""), url: page.url || `https://notion.so/${page.id.replace(/-/g, "")}` }
}

// ── Create an Add-on tracker record ─────────────────────────────────────────
async function createAddonRecord({ caId, quotationId, companyId, dealId, installName, token }) {
  try {
    const props = {
      "Add-on Name":          { title: [{ text: { content: `Add-on — ${installName}` } }] },
      "Status":               { select: { name: "Pending" } },
      "Requested When":       { select: { name: "Post-Install" } },
      ...(companyId   ? { "Company":              { relation: [{ id: companyId   }] } } : {}),
      ...(quotationId ? { "Quotation":             { relation: [{ id: quotationId }] } } : {}),
      ...(dealId      ? { "Linked Deal":           { relation: [{ id: dealId      }] } } : {}),
      ...(caId        ? { "Linked Client Account": { relation: [{ id: caId        }] } } : {}),
    }
    const page    = await createPage({ parent: { database_id: DB.ADD_ONS }, properties: props }, token)
    const addonId = page.id.replace(/-/g, "")
    console.log("[create_addon] Add-on record created:", addonId)
    return addonId
  } catch (e) {
    console.warn("[create_addon] createAddonRecord:", e.message)
    return null
  }
}

async function createLineItemsDB(pageId, token) {
  const r = await fetch("https://api.notion.com/v1/databases", {
    method:  "POST",
    headers: hdrs(token),
    body:    JSON.stringify({
      parent:    { type: "page_id", page_id: pageId },
      is_inline: true,
      title: [{ type: "text", text: { content: "Products & Services" } }],
      properties: {
        "Notes":      { title: {} },
        "Product":    { relation: { database_id: DB.CATALOGUE, single_property: {} } },
        "Unit Price": { number: { format: "number" } },
        "Qty":        { number: { format: "number" } },
      },
    }),
  })
  if (!r.ok) {
    console.warn("[create_addon] line items DB:", (await r.text()).slice(0, 200))
    return null
  }
  const db = await r.json()
  return db.id.replace(/-/g, "")
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

    const caId   = rawId.replace(/-/g, "")
    const caData = await fetchClientAccount(caId, token)

    // 1. Create the Add-on Quotation
    const { id: quotId, url: quotUrl } = await createAddonQuotation(caId, caData, token)

    // 2. Create Add-on tracker record linked to Client Account + Quotation
    const addonId = await createAddonRecord({
      caId,
      quotationId: quotId,
      companyId:   caData.companyId,
      dealId:      caData.dealId,
      installName: caData.installName,
      token,
    })

    // 3. Append blank Products & Services inline DB to the quotation page
    try { await createLineItemsDB(quotId, token) } catch (e) {
      console.warn("[create_addon] line items DB:", e.message)
    }

    return res.json({
      status:          "success",
      client_account:  caId,
      install_name:    caData.installName,
      quotation_id:    quotId,
      quotation_url:   quotUrl,
      addon_record_id: addonId,
      note:            "Fill in line items, then set Status → Approved to generate invoice",
    })
  } catch (e) {
    console.error("[create_addon]", e)
    return res.status(500).json({ error: e.message })
  }
}
