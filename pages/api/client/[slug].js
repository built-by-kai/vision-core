import { getClientConfig }            from '@/lib/supabase'
import { getNotionClient, queryDatabase, applyFieldMap } from '@/lib/notion'
import { cacheGet, cacheSet, cacheKey } from '@/lib/cache'

export default async function handler(req, res) {
  const { slug } = req.query
  const { token, module } = req.query

  // ── 1. Validate token ────────────────────────────────────
  if (!slug || !token) {
    return res.status(400).json({ error: 'Missing slug or token' })
  }

  let client
  try {
    client = await getClientConfig(slug)
  } catch (e) {
    return res.status(500).json({ error: 'Config fetch failed' })
  }

  if (!client || client.access_token !== token) {
    // Return blank — never reveal why access was denied
    return res.status(200).json({ authorized: false, data: null })
  }

  // ── 2. Determine which database to fetch ─────────────────
  const dbKey = module || 'default'
  const dbId  = client.databases[dbKey]

  if (!dbId) {
    return res.status(200).json({ authorized: true, data: [], module: dbKey })
  }

  // ── 3. Check cache ───────────────────────────────────────
  const key    = cacheKey(slug, dbKey)
  const cached = cacheGet(key)
  if (cached) {
    return res.status(200).json({ authorized: true, data: cached, module: dbKey, cached: true })
  }

  // ── 4. Fetch from Notion ─────────────────────────────────
  try {
    const notion = getNotionClient(client.notion_token)
    const pages  = await queryDatabase(notion, dbId)
    const data   = applyFieldMap(pages, client.field_map)

    cacheSet(key, data)

    return res.status(200).json({ authorized: true, data, module: dbKey, cached: false })
  } catch (e) {
    console.error(`[${slug}] Notion fetch error:`, e.message)
    return res.status(500).json({ error: 'Data fetch failed' })
  }
}
