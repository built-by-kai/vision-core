// ─── create_addon.js ───────────────────────────────────────────────────────
// POST /api/create_addon   { "page_id": "<client_account_page_id>" }
// Triggered by Notion button "New Add-on" on a Client Account page.
//
// Flow:
//   1. Read Client Account → Company, Linked Deal, Project Tracker, Install Name
//   2. Create Add-on record in Add-ons DB with all relations pre-filled
//      (Client Account, Deal, Project, Company)
//   3. Create a Draft Quotation linked to the Add-on record
//   4. Append blank Products & Services inline DB to the Quotation page
//
// After this runs:
//   → Open the Add-on record → pick Catalogue Item → Base Price auto-fills
//   → Fill line items in the Quotation → Approve → invoice pipeline kicks in

import { getPage, createPage, plain, DB, hdrs } from "../../lib/notion"

async function fetchClientAccount(caId, token) {
  const page  = await getPage(caId, token)
  const props = page.properties

  const installName = plain(props["Install Name"]?.title || []) || "Client"
  const companyId   = props.Company?.relation?.[0]?.id?.replace(/-/g, "")            || null
  const dealId      = props["Linked Deal"]?.relation?.[0]?.id?.replace(/-/g, "")     || null
  const projectId   = props["Project Tracker"]?.relation?.[0]?.id?.replace(/-/g, "") || null

  return { installName, companyId, dealId, projectId }
}

// ── 1. Create Add-on record with all relations pre-filled ────────────────────
async function createAddonRecord({ caId, companyId, dealId, projectId, installName, token }) {
  const today = new Date().toISOString().split("T")[0]
  const props = {
    "Add-on Name":          { title: [{ text: { content: `Add-on — ${installName}` } }] },
    "Status":               { select: { name: "Pending" } },
    "Requested When":       { select: { name: "Post-Install" } },
    ...(companyId  ? { "Company":              { relation: [{ id: companyId  }] } } : {}),
    ...(caId       ? { "Linked Client Account":{ relation: [{ id: caId       }] } } : {}),
    ...(dealId     ? { "Linked Deal":          { relation: [{ id: dealId     }] } } : {}),
    ...(projectId  ? { "Linked Project":       { relation: [{ id: projectId  }] } } : {}),
  }
  const page    = await createPage({ parent: { database_id: DB.ADD_ONS }, properties: props }, token)
  const addonId = page.id.replace(/-/g, "")
  console.log("[create_addon] Add-on record created:", addonId)
  return { addonId, addonUrl: page.url }
}

// ── 2. Create a Draft Quotation pre-linked to the Add-on ────────────────────
async function createAddonQuotation({ addonId, companyId, dealId, projectId, token }) {
  const today = new Date().toISOString().split("T")[0]
  const props = {
    "Quotation No.": { title: [{ text: { content: "" } }] },
    "Status":        { select: { name: "Draft" } },
    "Issue Date":    { date: { start: today } },
    "Payment Terms": { select: { name: "Full Upfront" } },
    "Quote Type":    { select: { name: "Add-on" } },
    "Package Type":  { rich_text: [{ text: { content: "Add-on" } }] },
    ...(companyId ? { "Company":     { relation: [{ id: companyId }] } } : {}),
    ...(dealId    ? { "Deal Source": { relation: [{ id: dealId    }] } } : {}),
    // Back-link to project so create_invoice doesn't spin up a duplicate project
    ...(projectId ? { "Project":     { relation: [{ id: projectId }] } } : {}),
  }
  const r = await fetch("https://api.notion.com/v1/pages", {
    method:  "POST",
    headers: hdrs(token),
    body:    JSON.stringify({ parent: { database_id: DB.QUOTATIONS }, properties: props }),
  })
  if (!r.ok) throw new Error(`Quotation create failed ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const page = await r.json()
  return { quotId: page.id.replace(/-/g, ""), quotUrl: page.url }
}

// ── 3. Append blank Products & Services inline DB to Quotation page ─────────
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
  if (!r.ok) console.warn("[create_addon] line items DB:", (await r.text()).slice(0, 200))
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Create Add-on", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const token = process.env.NOTION_API_KEY
  try {
    const body  = req.body || {}
    const rawId = body.page_id || body.source?.page_id || body.data?.page_id || body.data?.id
    if (!rawId) return res.status(400).json({ error: "Missing page_id" })

    const caId   = rawId.replace(/-/g, "")
    const caData = await fetchClientAccount(caId, token)

    // 1. Create Add-on record (all relations pre-filled)
    const { addonId, addonUrl } = await createAddonRecord({ caId, ...caData, token })

    // 2. Create linked Quotation
    const { quotId, quotUrl } = await createAddonQuotation({
      addonId,
      companyId:  caData.companyId,
      dealId:     caData.dealId,
      projectId:  caData.projectId,
      token,
    })

    // 3. Link Quotation back to Add-on record
    try {
      await fetch(`https://api.notion.com/v1/pages/${addonId}`, {
        method:  "PATCH",
        headers: hdrs(token),
        body:    JSON.stringify({ properties: { "Quotation": { relation: [{ id: quotId }] } } }),
      })
    } catch (e) {
      console.warn("[create_addon] link quotation→addon:", e.message)
    }

    // 4. Append Products & Services table to Quotation
    try { await createLineItemsDB(quotId, token) } catch (e) {
      console.warn("[create_addon] line items DB:", e.message)
    }

    return res.json({
      status:         "success",
      client_account: caId,
      install_name:   caData.installName,
      addon_id:       addonId,
      addon_url:      addonUrl,
      quotation_id:   quotId,
      quotation_url:  quotUrl,
      next_steps:     "Open Add-on record → pick Catalogue Item → Base Price fills. Then fill Quotation line items → Approve when ready to invoice.",
    })
  } catch (e) {
    console.error("[create_addon]", e)
    return res.status(500).json({ error: e.message })
  }
}
