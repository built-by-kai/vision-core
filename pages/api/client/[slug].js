// ─── pages/api/client/[slug].js ───────────────────────────────────────────
// GET /api/client/<slug>?token=<access_token>&module=<dbKey>
//
// Multi-tenant Notion data endpoint.
// 1. Validates access_token against Supabase clients table
// 2. Resolves the correct Notion database for the requested module
// 3. Fetches & caches Notion data (60s TTL)
// 4. Applies field_map to normalize property names across clients
//
// Returns: { authorized: bool, data: [...], module: string, cached: bool }

import { getClientConfig, resolveDB, resolveField } from "../../../lib/supabase"
import { queryDB, plain, getProp }                  from "../../../lib/notion"
import { cacheGet, cacheSet, cacheKey }             from "../../../lib/cache"

// ── Module → standard DB key map ──────────────────────────────────────────
// These are the keys clients use in their `databases` JSON column in Supabase.
// If a client hasn't overridden a key, the request returns empty data.
const MODULE_DB_KEYS = {
  deals:    "LEADS",
  pipeline: "LEADS",
  projects: "PROJECTS",
  phases:   "PHASES",
  invoices: "INVOICE",
  clients:  "CLIENTS",
  // Dashboard meta
  meta:     null, // handled separately
}

// ── Standard field schema ──────────────────────────────────────────────────
// Maps internal field names → Notion property names (overrideable per client)
const FIELD_DEFAULTS = {
  // Deals / Pipeline
  dealName:    "Lead Name",
  dealStage:   "Stage",
  dealValue:   "Estimated Value",
  dealSource:  "Source",
  dealPackage: "Package Type",
  // Projects
  projectStatus:   "Status",
  projectCompany:  "Company",
  // Invoices
  invoiceAmount: "Total Amount",
  invoiceStatus: "Status",
  invoiceType:   "Invoice Type",
  // Phases
  phaseProgress: "Task Progress",
  phaseDue:      "Due Date",
}

// ── Normalize a Notion page using field_map ────────────────────────────────
function normalizePage(page, fieldMap) {
  const merged = { ...FIELD_DEFAULTS, ...fieldMap }
  const out    = { id: page.id.replace(/-/g, "") }

  for (const [stdKey, notionProp] of Object.entries(merged)) {
    out[stdKey] = getProp(page, notionProp)
  }

  // Always include created/last edited time
  out._created = page.created_time || null
  out._updated = page.last_edited_time || null

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const { slug }  = req.query
  const { token, module: mod, filter: rawFilter } = req.query

  if (!slug || !token) {
    return res.status(400).json({ error: "Missing slug or token" })
  }

  // ── 1. Validate token ─────────────────────────────────────────────────
  let client
  try {
    client = await getClientConfig(slug)
  } catch {
    return res.status(500).json({ error: "Config fetch failed" })
  }

  if (!client || client.access_token !== token) {
    // Never reveal why — just return unauthorized
    return res.status(200).json({ authorized: false, data: null })
  }

  // ── 2. Resolve database ───────────────────────────────────────────────
  const dbKey = mod || "deals"

  // Meta module — return client config (no Notion data needed)
  if (dbKey === "meta") {
    const { notion_token, access_token, ...safeConfig } = client
    return res.status(200).json({ authorized: true, clientConfig: safeConfig })
  }

  // Look up DB ID: client override first, then standard key
  const dbId = client.databases?.[dbKey] || client.databases?.[dbKey.toUpperCase()] || null

  if (!dbId) {
    return res.status(200).json({ authorized: true, data: [], module: dbKey, note: "No database configured for this module" })
  }

  // ── 3. Check cache ────────────────────────────────────────────────────
  const ck     = cacheKey(slug, dbKey, rawFilter || "all")
  const cached = cacheGet(ck)
  if (cached) {
    return res.status(200).json({ authorized: true, data: cached, module: dbKey, cached: true })
  }

  // ── 4. Fetch from Notion ──────────────────────────────────────────────
  try {
    // Parse optional filter (simple equality for now)
    let filter = undefined
    if (rawFilter) {
      try { filter = JSON.parse(decodeURIComponent(rawFilter)) } catch {}
    }

    const pages = await queryDB(dbId, filter, client.notion_token)
    const data  = pages.map(p => normalizePage(p, client.field_map || {}))

    cacheSet(ck, data)

    return res.status(200).json({ authorized: true, data, module: dbKey, cached: false })
  } catch (e) {
    console.error(`[client:${slug}] Notion error:`, e.message)
    return res.status(500).json({ error: "Data fetch failed" })
  }
}
