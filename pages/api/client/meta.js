import { getClientConfig } from '@/lib/supabase'

// Returns client config (no Notion data) — used by the dashboard page
// to know which widgets to render and what labels to show.
export default async function handler(req, res) {
  const { slug, token } = req.query

  if (!slug || !token) return res.status(400).json({ error: 'Missing params' })

  let client
  try {
    client = await getClientConfig(slug)
  } catch {
    return res.status(500).json({ error: 'Config fetch failed' })
  }

  if (!client || client.access_token !== token) {
    return res.status(200).json({ authorized: false, clientConfig: null })
  }

  // Never expose notion_token or access_token to the browser
  const { notion_token, access_token, ...safeConfig } = client
  return res.status(200).json({ authorized: true, clientConfig: safeConfig })
}
