// Lightweight widget access check.
// Called by HTML widgets on load — before rendering anything.
// GET /api/widget-access?token=...&widget=marketing/stats
//
// Returns: { allowed: true } or { allowed: false }
// Never reveals WHY access is denied.

import { getClientByToken, hasWidgetAccess } from "../../lib/supabase"

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const token  = req.query.token  || req.headers['x-widget-token']
  const widget = req.query.widget || ''

  if (!token || !widget) return res.status(200).json({ allowed: false })

  const client = await getClientByToken(token)
  if (!client) return res.status(200).json({ allowed: false })

  const allowed = hasWidgetAccess(client, widget)
  return res.status(200).json({ allowed })
}
