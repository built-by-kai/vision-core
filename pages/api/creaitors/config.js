// pages/api/creaitors/config.js
// GET  ?token=  → returns { sections: [...] } for this client
// POST ?token=  body { sections: [...] } → saves to clients.labels.executive_sections
//
// Config stored in clients.labels.executive_sections (no extra table needed).
// All other label keys are preserved on every write.

import { createClient } from '@supabase/supabase-js'
import { getClientByToken } from '../../../lib/supabase'

const VALID_SECTIONS = ['campaign', 'content', 'crm', 'crm-log', 'kol']
const DEFAULT_SECTIONS = ['campaign', 'content']

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })

  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600')
    const sections = client.labels?.executive_sections || DEFAULT_SECTIONS
    return res.status(200).json({ sections })
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')

    let body = req.body
    if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch { return res.status(400).json({ error: 'Invalid JSON' }) }
    }

    const { sections } = body || {}
    if (!Array.isArray(sections)) {
      return res.status(400).json({ error: 'sections must be an array' })
    }

    // Sanitise — only allow known values, preserve order
    const clean = sections.filter(s => VALID_SECTIONS.includes(s))
    if (!clean.length) {
      return res.status(400).json({ error: 'No valid sections provided' })
    }

    // Merge into existing labels (preserves all other keys)
    const newLabels = { ...(client.labels || {}), executive_sections: clean }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    )

    const { error } = await supabase
      .from('clients')
      .update({ labels: newLabels })
      .eq('id', client.id)

    if (error) {
      console.error('creaitors/config POST error:', error)
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json({ sections: clean })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
