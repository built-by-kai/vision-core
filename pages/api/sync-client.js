// /api/sync-client
// Called by a Notion button on the Dashboard Clients database.
// Reads the row's properties from Notion and upserts into Supabase.
//
// Notion button config:
//   Action: "Send data to URL"
//   URL:    https://api.opxio.io/api/sync-client?secret=opxio-sync-2026
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

// ── Notion Dashboard Clients DB → Supabase clients table ──────────────────
//
// Notion field              → Supabase column
// ─────────────────────────────────────────────────────────────────────────
// Client Name (title)       → client_name
// Slug (text)               → slug             [unique key]
// Access Token (text)       → access_token
// Notion Token (text)       → notion_token
// Notion Workspace ID (text)→ notion_workspace_id
// Status (select)           → status
// OS Type (multi_select)    → os_type[]
// Monthly Fee (number)      → monthly_fee
// Next Renewal (date)       → next_renewal
//
// DB IDs → databases JSONB:
// Leads DB ID               → databases.LEADS
// Deals DB ID               → databases.DEALS
// Invoice DB ID             → databases.INVOICE
// Projects DB ID            → databases.PROJECTS
// Proposals DB ID           → databases.PROPOSALS
// Quotations DB ID          → databases.QUOTATIONS
//
// Field Mappings → field_map JSONB:
// Stage Field               → field_map.STAGE_FIELD
// Status Field              → field_map.STATUS_FIELD
// Package Field             → field_map.PACKAGE_FIELD
// Meeting Type Field        → field_map.TYPE_FIELD
// Invoice Type Field        → field_map.INVOICE_TYPE_FIELD
//
// Stage configs → labels JSONB:
// Lead Stages (JSON text)   → labels.stages + labels.activeStages
// Deal Stages (JSON text)   → labels.dealAllStages / dealPotentialStages /
//                              dealWonStages / dealWonLabel / dealDeliveredLabel

function mapPageToRow(page) {
  const p = page.properties

  const clientName       = plain(p["Client Name"]?.title || [])
  const slug             = plain(p["Slug"]?.rich_text || [])
  if (!slug) throw new Error("Row is missing a Slug — cannot sync without a unique key.")

  const accessToken      = plain(p["Access Token"]?.rich_text  || []) || null
  const notionToken      = plain(p["Notion Token"]?.rich_text  || []) || null
  const workspaceId      = plain(p["Notion Workspace ID"]?.rich_text || []) || null
  const statusVal        = p["Status"]?.select?.name || "active"
  const osTypeRaw        = p["OS Type"]?.multi_select || []
  const monthlyFee       = p["Monthly Fee"]?.number || 0
  const nextRenewalRaw   = p["Next Renewal"]?.date?.start || null

  // DB IDs → databases JSONB
  const databases = {}
  const dbMap = {
    LEADS:      "Leads DB ID",
    DEALS:      "Deals DB ID",
    INVOICE:    "Invoice DB ID",
    PROJECTS:   "Projects DB ID",
    PROPOSALS:  "Proposals DB ID",
    QUOTATIONS: "Quotations DB ID",
  }
  for (const [key, field] of Object.entries(dbMap)) {
    const val = plain(p[field]?.rich_text || [])
    if (val) databases[key] = val
  }

  // Field mappings → field_map JSONB
  const field_map = {}
  const fmMap = {
    STAGE_FIELD:        "Stage Field",
    STATUS_FIELD:       "Status Field",
    PACKAGE_FIELD:      "Package Field",
    TYPE_FIELD:         "Meeting Type Field",
    INVOICE_TYPE_FIELD: "Invoice Type Field",
  }
  for (const [key, field] of Object.entries(fmMap)) {
    const val = plain(p[field]?.rich_text || [])
    if (val) field_map[key] = val
  }

  // Lead Stages JSON → labels.stages + labels.activeStages
  // Format: { "stages": [...], "activeStages": [...] }  OR plain JSON array
  const labels = {}
  const leadStagesObj = tryParseJson(plain(p["Lead Stages"]?.rich_text || []))
  if (leadStagesObj) {
    if (Array.isArray(leadStagesObj)) {
      labels.stages = leadStagesObj
    } else {
      if (leadStagesObj.stages)       labels.stages       = leadStagesObj.stages
      if (leadStagesObj.activeStages) labels.activeStages = leadStagesObj.activeStages
    }
  }

  // Deal Stages JSON → labels.deal*
  // Format: { "all": [...], "potential": [...], "won": [...], "wonLabel": "...", "deliveredLabel": "..." }
  const dealStagesObj = tryParseJson(plain(p["Deal Stages"]?.rich_text || []))
  if (dealStagesObj) {
    if (dealStagesObj.all)            labels.dealAllStages       = dealStagesObj.all
    if (dealStagesObj.potential)      labels.dealPotentialStages = dealStagesObj.potential
    if (dealStagesObj.won)            labels.dealWonStages       = dealStagesObj.won
    if (dealStagesObj.wonLabel)       labels.dealWonLabel        = dealStagesObj.wonLabel
    if (dealStagesObj.deliveredLabel) labels.dealDeliveredLabel  = dealStagesObj.deliveredLabel
  }

  return {
    client_name:          clientName || slug,
    slug,
    access_token:         accessToken,
    notion_token:         notionToken,
    notion_workspace_id:  workspaceId,
    status:               ["active","inactive","paused"].includes(statusVal) ? statusVal : "active",
    os_type:              osTypeRaw.map(o => o.name),
    monthly_fee:          monthlyFee,
    next_renewal:         nextRenewalRaw,
    databases:            Object.keys(databases).length > 0 ? databases : {},
    field_map:            Object.keys(field_map).length > 0 ? field_map : {},
    labels:               Object.keys(labels).length > 0 ? labels : {},
    updated_at:           new Date().toISOString(),
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const secret = req.query.secret
  if (!secret || secret !== SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  try {
    // Notion button sends: { "data": { "id": "page-uuid" } }
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
      os_type: row.os_type,
      databases: row.databases,
      field_map: row.field_map,
      labels: row.labels,
    })

  } catch (err) {
    console.error("sync-client:", err)
    return res.status(500).json({ error: err.message })
  }
}
