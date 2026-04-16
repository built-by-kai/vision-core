// /api/sync-client
// Called by a Notion button on the Dashboard Clients database.
// Reads the row's properties from Notion and upserts into Supabase.
//
// Notion button config:
//   Action: "Send data to URL"
//   URL:    https://dashboard.opxio.io/api/sync-client?secret=opxio-sync-2026
//   Method: POST  (Notion auto-sends { "data": { "id": "{{page_id}}" } })

import { createClient } from "@supabase/supabase-js"

const NOTION_VERSION = "2022-06-28"
const SYNC_SECRET    = process.env.SYNC_SECRET || "opxio-sync-2026"

function supabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  )
}

async function getNotionPage(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
    },
  })
  if (!res.ok) throw new Error(`Notion fetch failed: ${res.status}`)
  return res.json()
}

function plain(richText) {
  return (richText || []).map(t => t.plain_text).join("").trim()
}

function tryParseJson(str) {
  if (!str) return null
  try { return JSON.parse(str) } catch { return null }
}

// Build the Supabase row from Notion page properties.
// Notion DB schema → Supabase clients table:
//
//  Client Name (title)      → client_name
//  Slug        (text)       → slug          [unique key]
//  Access Token(text)       → access_token
//  Notion Token(text)       → notion_token
//  Status      (select)     → status
//  Stage Field (text)       → field_map.STAGE_FIELD
//  Lead Stages (text/JSON)  → labels.stages + labels.activeStages
//  Deal Stages (text/JSON)  → labels.dealAllStages + labels.dealPotentialStages + labels.dealWonStages
//  Leads DB ID (text)       → databases.LEADS
//  Deals DB ID (text)       → databases.DEALS
//  Invoice DB ID (text)     → databases.INVOICE
//  Projects DB ID (text)    → databases.PROJECTS
//  Proposals DB ID (text)   → databases.PROPOSALS
//  Quotations DB ID (text)  → databases.QUOTATIONS

function mapPageToRow(page) {
  const p = page.properties

  const clientName   = plain(p["Client Name"]?.title || [])
  const slug         = plain(p["Slug"]?.rich_text     || [])

  if (!slug) throw new Error("Row is missing a Slug — cannot sync without a unique key.")

  const accessToken  = plain(p["Access Token"]?.rich_text  || []) || null
  const notionToken  = plain(p["Notion Token"]?.rich_text  || []) || null
  const statusVal    = p["Status"]?.select?.name || "active"
  const stageField   = plain(p["Stage Field"]?.rich_text   || []) || null

  // DB IDs → databases JSONB
  const leadsDbId      = plain(p["Leads DB ID"]?.rich_text     || []) || null
  const dealsDbId      = plain(p["Deals DB ID"]?.rich_text     || []) || null
  const invoiceDbId    = plain(p["Invoice DB ID"]?.rich_text   || []) || null
  const projectsDbId   = plain(p["Projects DB ID"]?.rich_text  || []) || null
  const proposalsDbId  = plain(p["Proposals DB ID"]?.rich_text || []) || null
  const quotationsDbId = plain(p["Quotations DB ID"]?.rich_text|| []) || null

  // Build databases object — only include non-empty values
  const databases = {}
  if (leadsDbId)      databases.LEADS      = leadsDbId
  if (dealsDbId)      databases.DEALS      = dealsDbId
  if (invoiceDbId)    databases.INVOICE    = invoiceDbId
  if (projectsDbId)   databases.PROJECTS   = projectsDbId
  if (proposalsDbId)  databases.PROPOSALS  = proposalsDbId
  if (quotationsDbId) databases.QUOTATIONS = quotationsDbId

  // Lead Stages → labels.stages + labels.activeStages
  // Stored as JSON in Notion text field:
  // { "stages": [...], "activeStages": [...] }  OR just a plain JSON array for stages
  const leadStagesRaw = plain(p["Lead Stages"]?.rich_text || [])
  const leadStagesObj = tryParseJson(leadStagesRaw)

  // Deal Stages → labels.deal* fields
  // Stored as JSON: { "all": [...], "potential": [...], "won": [...], "wonLabel": "...", "deliveredLabel": "..." }
  const dealStagesRaw = plain(p["Deal Stages"]?.rich_text || [])
  const dealStagesObj = tryParseJson(dealStagesRaw)

  // Build labels object
  const labels = {}
  if (leadStagesObj) {
    if (Array.isArray(leadStagesObj)) {
      labels.stages = leadStagesObj
    } else {
      if (leadStagesObj.stages)       labels.stages       = leadStagesObj.stages
      if (leadStagesObj.activeStages) labels.activeStages = leadStagesObj.activeStages
    }
  }
  if (dealStagesObj) {
    if (dealStagesObj.all)            labels.dealAllStages       = dealStagesObj.all
    if (dealStagesObj.potential)      labels.dealPotentialStages = dealStagesObj.potential
    if (dealStagesObj.won)            labels.dealWonStages       = dealStagesObj.won
    if (dealStagesObj.wonLabel)       labels.dealWonLabel        = dealStagesObj.wonLabel
    if (dealStagesObj.deliveredLabel) labels.dealDeliveredLabel  = dealStagesObj.deliveredLabel
  }

  // Build field_map
  const field_map = {}
  if (stageField) field_map.STAGE_FIELD = stageField

  return {
    client_name:  clientName || slug,
    slug,
    access_token: accessToken,
    notion_token: notionToken,
    status:       ["active","inactive","paused"].includes(statusVal) ? statusVal : "active",
    databases:    Object.keys(databases).length > 0 ? databases : null,
    labels:       Object.keys(labels).length > 0 ? labels : null,
    field_map:    Object.keys(field_map).length > 0 ? field_map : null,
    updated_at:   new Date().toISOString(),
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  // Secret check
  const secret = req.query.secret
  if (!secret || secret !== SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  try {
    // Notion button sends: { "data": { "id": "page-uuid", ... } }
    // Fallback: bare { "id": "..." } or ?pageId= query param
    const body   = req.body || {}
    const pageId = body?.data?.id || body?.id || req.query.pageId

    if (!pageId) {
      return res.status(400).json({ error: "Missing page ID. Expected body.data.id from Notion button." })
    }

    const page = await getNotionPage(pageId)
    const row  = mapPageToRow(page)

    const { error } = await supabase()
      .from("clients")
      .upsert(row, { onConflict: "slug" })

    if (error) throw error

    console.log(`sync-client: synced "${row.slug}" (${row.client_name})`)
    return res.status(200).json({
      ok: true,
      synced: row.slug,
      client: row.client_name,
      databases: row.databases,
      labels: row.labels,
    })

  } catch (err) {
    console.error("sync-client:", err)
    return res.status(500).json({ error: err.message })
  }
}
