import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = process.env.SUPABASE_URL
const supabaseKey  = process.env.SUPABASE_SERVICE_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)

// ─── Config cache ─────────────────────────────────────────────
// All client records loaded into memory on startup, refreshed every 5 minutes.
// Prevents a Supabase call on every single dashboard request.

let _cache     = {}
let _lastFetch = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export async function getClientConfig(slug) {
  const now = Date.now()

  if (now - _lastFetch > CACHE_TTL || Object.keys(_cache).length === 0) {
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('status', 'active')

    if (error) throw new Error(`Supabase config fetch failed: ${error.message}`)

    _cache = {}
    for (const row of data) {
      _cache[row.slug] = row
    }
    _lastFetch = now
  }

  return _cache[slug] || null
}
