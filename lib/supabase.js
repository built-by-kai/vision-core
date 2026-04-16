// ─── Supabase client config helper ────────────────────────────────────────
// Server-side only. Never expose SUPABASE_SERVICE_KEY to the browser.

import { createClient } from "@supabase/supabase-js"

let _client = null

function getClient() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    )
  }
  return _client
}

// ─── In-memory cache (5 min TTL) ──────────────────────────────────────────
const _cache = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 min TTL

function cacheGet(key) {
  const entry = _cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null }
  return entry.data
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() })
}

// ─── Fetch client config by slug ──────────────────────────────────────────
/**
 * @param {string} slug
 * @returns {Promise<object|null>} client row or null
 */
export async function getClientConfig(slug) {
  const cached = cacheGet(`client:${slug}`)
  if (cached) return cached

  const { data, error } = await getClient()
    .from("clients")
    .select("*")
    .eq("slug", slug)
    .eq("status", "active")
    .single()

  if (error || !data) return null
  cacheSet(`client:${slug}`, data)
  return data
}

/**
 * Validate access token against a client row.
 * Used by Notion-button-triggered API routes.
 * @param {string} token
 * @returns {Promise<object|null>} client row or null
 */
export async function getClientByToken(token) {
  if (!token) return null
  const cached = cacheGet(`token:${token}`)
  if (cached) return cached

  const { data, error } = await getClient()
    .from("clients")
    .select("*")
    .eq("access_token", token)
    .eq("status", "active")
    .single()

  if (error || !data) return null
  cacheSet(`token:${token}`, data)
  return data
}

/**
 * Invalidate cache entries for a slug (call after config updates)
 */
export function invalidateClientCache(slug) {
  for (const key of _cache.keys()) {
    if (key.includes(slug)) _cache.delete(key)
  }
}

/**
 * Helper: get the Notion API token for a client.
 * Uses the client's own notion_token if set, otherwise falls back to
 * the shared NOTION_API_KEY env var (Opxio's internal token).
 */
export function getNotionToken(client) {
  return client?.notion_token || process.env.NOTION_API_KEY
}

/**
 * Helper: resolve a Notion DB id for a client.
 * Falls back to the internal Opxio DB ids if not overridden.
 */
export function resolveDB(client, dbKey, fallback) {
  return client?.databases?.[dbKey] || fallback
}

/**
 * Helper: resolve a field name via client's field_map
 */
export function resolveField(client, stdField, fallback) {
  return client?.field_map?.[stdField] || fallback
}

/**
 * Helper: resolve a label via client's labels
 */
export function resolveLabel(client, key, fallback) {
  return client?.labels?.[key] || fallback
}

/**
 * Widget access control.
 * If client.allowed_widgets is null/undefined → all widgets are allowed (no restriction).
 * If it is a non-empty array → only listed slugs are allowed.
 * Slug format matches the URL path segment: "marketing/stats", "marketing/campaigns", etc.
 *
 * @param {object} client  - client row from Supabase
 * @param {string} widget  - slug to check, e.g. "marketing/stats"
 * @returns {boolean}
 */
export function hasWidgetAccess(client, widget) {
  // Stored in client.labels.allowed_widgets (no schema change needed — reuses existing labels JSONB)
  // null / missing = no restriction (all widgets allowed)
  // array present = whitelist — only listed slugs are accessible
  const list = client?.labels?.allowed_widgets
  if (!list || !Array.isArray(list) || list.length === 0) return true
  return list.includes(widget)
}
