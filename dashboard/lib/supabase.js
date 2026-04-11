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
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

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
 * Helper: resolve a Notion DB id for a client
 * Falls back to the internal Opxio DB ids if not overridden
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
