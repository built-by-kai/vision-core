// ─── cache.js — In-memory Notion data cache (60s TTL) ─────────────────────
// Keeps Vercel function costs flat by not re-hitting Notion on every request.
// TTL is intentionally short so data stays fresh for dashboard users.

const _store = new Map()
const TTL_MS = 60 * 1000 // 60 seconds

export function cacheKey(...parts) {
  return parts.join(":")
}

export function cacheGet(key) {
  const entry = _store.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > TTL_MS) { _store.delete(key); return null }
  return entry.data
}

export function cacheSet(key, data) {
  _store.set(key, { data, ts: Date.now() })
}

export function cacheDelete(key) {
  _store.delete(key)
}

export function cacheClear() {
  _store.clear()
}
