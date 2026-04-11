// 60-second in-memory cache for Notion API responses.
// Keeps infrastructure cost flat regardless of dashboard traffic.

const _store = new Map()
const TTL    = 60 * 1000 // 60 seconds

export function cacheGet(key) {
  const entry = _store.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > TTL) {
    _store.delete(key)
    return null
  }
  return entry.data
}

export function cacheSet(key, data) {
  _store.set(key, { data, ts: Date.now() })
}

export function cacheKey(...parts) {
  return parts.join(':')
}
