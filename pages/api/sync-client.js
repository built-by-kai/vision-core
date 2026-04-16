// /api/sync-client
// Called by a Notion button on the Dashboard Clients database.
// Reads the row's properties from Notion and upserts into Supabase.
//
// Notion button sends:
//   POST https://dashboard.opxio.io/api/sync-client?secret=<SYNC_SECRET>
//   Body: { "data": { "id": "{{page_id}}" } }
//   (Notion wraps the payload in a "data" key)

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

function parseJsonField(val) {
  if (!val) return null
  try { return JSON.parse(val) } catch { return null }
}

function mapPageToRow(page) {
  const p = page.properties

  const clientName   = plain(p["Client Name"]?.title  || p.Name?.title || [])
  const slug         = plain(p["Slug"]?.rich_text      || [])
  const accessToken  = plain(p["Access Token"]?.rich_text || [])
  const notionToken  = plain(p["Notion Token"]?.rich_text || [])
  const statusVal    = p["Status"]?.select?.name || "active"
  const databasesRaw = plain(p["Databases"]?.rich_text  || [])
  const labelsRaw    = plain(p["Labels"]?.rich_text      || [])
  const fieldMapRaw  = plain(p["Field Map"]?.rich_text   || [])

  if (!slug) throw new Error("Row is missing a Slug — cannot sync without a unique key.")

  return {
    client_name:   clientName || slug,
    slug,
    access_token:  accessToken || null,
    notion_token:  notionToken || null,
    status:        statusVal.toLowerCase() === "inactive" ? "inactive" : "active",
    databases:     parseJsonField(databasesRaw),
    labels:        parseJsonField(labelsRaw),
    field_map:     parseJsonField(fieldMapRaw),
    updated_at:    new Date().toISOString(),
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  // ── Secret check ──────────────────────────────────────────────────────────
  const secret = req.query.secret
  if (!secret || secret !== SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  try {
    // ── Extract page ID from Notion button payload ─────────────────────────
    // Notion sends: { "data": { "id": "page-uuid", ... } }
    // or sometimes at top level: { "id": "page-uuid" }
    const body   = req.body || {}
    const pageId = body?.data?.id || body?.id || req.query.pageId

    if (!pageId) {
      return res.status(400).json({ error: "Missing page ID. Expected body.data.id from Notion button." })
    }

    // ── Fetch the Notion page ─────────────────────────────────────────────
    const page = await getNotionPage(pageId)
    const row  = mapPageToRow(page)

    // ── Upsert into Supabase ──────────────────────────────────────────────
    const { error } = await supabase()
      .from("clients")
      .upsert(row, { onConflict: "slug" })

    if (error) throw error

    console.log(`sync-client: synced "${row.slug}" (${row.client_name})`)
    return res.status(200).json({
      ok: true,
      synced: row.slug,
      client: row.client_name,
    })

  } catch (err) {
    console.error("sync-client:", err)
    return res.status(500).json({ error: err.message })
  }
}
