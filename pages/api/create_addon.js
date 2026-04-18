// ─── create_addon.js ───────────────────────────────────────────────────────
// POST /api/create_addon   { "page_id": "<project_or_client_account_page_id>" }
// Triggered by Notion button "New Add-on" on either:
//   • Project page       — mid-build add-ons (most common during active work)
//   • Client Account page — post-install add-ons
//
// Auto-detects which page type was passed, reads all 4 relations from it,
// then:
//   1. Creates Add-on record in Add-ons DB (CA + Deal + Project + Company)
//   2. Creates linked Draft Quotation
//   3. Appends blank Products & Services inline DB to the Quotation
//
// After this runs:
//   → Open Add-on record → pick Catalogue Item → Base Price auto-fills
//   → Fill Quotation line items → Approve → invoice pipeline runs

import { getPage, createPage, plain, DB, hdrs } from "../../lib/notion"

// ── Detect source page and extract all needed relations ───────────────────
async function resolveSourcePage(pageId, token) {
  const page   = await getPage(pageId, token)
  const props  = page.properties
  const dbId   = (page.parent?.database_id || "").replace(/-/g, "")

  const isProject        = dbId === DB.PROJECTS.replace(/-/g, "")
  const isClientAccount  = dbId === DB.CLIENT_ACCOUNTS.replace(/-/g, "")

  if (!isProject && !isClientAccount) {
    throw new Error(`Page ${pageId} is not a Project or Client Account page`)
  }

  if (isProject) {
    const companyId = props.Company?.relation?.[0]?.id?.replace(/-/g, "")            || null
    const dealId    = props.Deals?.relation?.[0]?.id?.replace(/-/g, "")              || null
    const caId      = props["Client Account"]?.relation?.[0]?.id?.replace(/-/g, "") || null
    // Install name: pull from Client Account if linked, else fall back to project name
    let installName = plain(props["Project Name"]?.title || []).replace(/ Build$/, "").trim()
    if (caId) {
      try {
        const ca = await getPage(caId, token)
        installName = plain(ca.properties["Install Name"]?.title || []) || installName
      } catch {}
    }
    return { companyId, dealId, projectId: pageId, caId, installName }
  }

  // isClientAccount
  const companyId   = props.Company?.relation?.[0]?.id?.replace(/-/g, "")            || null
  const dealId      = props["Linked Deal"]?.relation?.[0]?.id?.replace(/-/g, "")     || null
  const projectId   = props["Project Tracker"]?.relation?.[0]?.id?.replace(/-/g, "") || null
  const installName = plain(props["Install Name"]?.title || []) || "Client"
  return { companyId, dealId, projectId, caId: pageId, installName }
}

// ── 1. Create Add-on record ───────────────────────────────────────────────
async function createAddonRecord({ caId, companyId, dealId, projectId, installName, sourcePageId, token }) {
  const requestedWhen = sourcePageId === projectId ? "Mid-Build" : "Post-Handover"
  const props = {
    "Add-on Name":           { title: [{ text: { content: `Add-on — ${installName}` } }] },
    "Status":                { select: { name: "Pending" } },
    "Requested When":        { select: { name: requestedWhen } },
    ...(companyId  ? { "Company":               { relation: [{ id: companyId  }] } } : {}),
    ...(caId       ? { "Linked Client Account": { relation: [{ id: caId       }] } } : {}),
    ...(dealId     ? { "Linked Deal":           { relation: [{ id: dealId     }] } } : {}),
    ...(projectId  ? { "Linked Project":        { relation: [{ id: projectId  }] } } : {}),
  }
  const page    = await createPage({ parent: { database_id: DB.ADD_ONS }, properties: props }, token)
  const addonId = page.id.replace(/-/g, "")
  console.log("[create_addon] Add-on record created:", addonId)
  return { addonId, addonUrl: page.url }
}

// ── 2. Create Draft Quotation linked to the Add-on ───────────────────────
async function createAddonQuotation({ companyId, dealId, projectId, token }) {
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

// ── 3. Append Products & Services inline DB to Quotation ─────────────────
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

    const pageId = rawId.replace(/-/g, "")

    // Auto-detect Project vs Client Account and read all needed relations
    const { companyId, dealId, projectId, caId, installName } = await resolveSourcePage(pageId, token)

    // 1. Create Add-on record
    const { addonId, addonUrl } = await createAddonRecord({
      caId, companyId, dealId, projectId, installName, sourcePageId: pageId, token,
    })

    // 2. Create linked Quotation
    const { quotId, quotUrl } = await createAddonQuotation({ companyId, dealId, projectId, token })

    // 3. Link Quotation back to Add-on record
    await fetch(`https://api.notion.com/v1/pages/${addonId}`, {
      method:  "PATCH",
      headers: hdrs(token),
      body:    JSON.stringify({ properties: { "Quotation": { relation: [{ id: quotId }] } } }),
    }).catch(e => console.warn("[create_addon] link quotation→addon:", e.message))

    // 4. Append Products & Services table to Quotation
    await createLineItemsDB(quotId, token).catch(e => console.warn("[create_addon] line items DB:", e.message))

    return res.json({
      status:         "success",
      source:         projectId === pageId ? "project" : "client_account",
      install_name:   installName,
      addon_id:       addonId,
      addon_url:      addonUrl,
      quotation_id:   quotId,
      quotation_url:  quotUrl,
    })
  } catch (e) {
    console.error("[create_addon]", e)
    return res.status(500).json({ error: e.message })
  }
}
