// /api/admin/clients — protected CRUD for client management
// Auth: ?adminKey=xxx  or  x-admin-key header (matches ADMIN_KEY env var)

import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  })
}

function isAuthorized(req) {
  const key = req.query.adminKey || req.headers["x-admin-key"] || ""
  const expected = process.env.ADMIN_KEY || "opxio-admin-2026"
  return key === expected
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key")
  if (req.method === "OPTIONS") return res.status(200).end()

  if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" })

  const sb = getSupabase()

  // GET — list all clients
  if (req.method === "GET") {
    const { data, error } = await sb.from("clients").select("*").order("created_at", { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  // POST — create new client
  if (req.method === "POST") {
    const body = req.body
    if (!body.client_name || !body.slug) return res.status(400).json({ error: "client_name and slug required" })
    const token = body.access_token || crypto.randomBytes(32).toString("hex")
    const { data, error } = await sb.from("clients").insert({
      client_name:  body.client_name,
      slug:         body.slug,
      os_type:      body.os_type      || [],
      access_token: token,
      notion_token: body.notion_token || process.env.NOTION_API_KEY,
      databases:    body.databases    || {},
      field_map:    body.field_map    || {},
      labels:       body.labels       || {},
      status:       body.status       || "active",
      monthly_fee:  body.monthly_fee  || 0,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json(data)
  }

  // PUT — update client by slug
  if (req.method === "PUT") {
    const { slug } = req.query
    if (!slug) return res.status(400).json({ error: "slug required" })
    const body = req.body
    const updates = {}
    const allowed = ["client_name","os_type","notion_token","databases","field_map","labels","status","monthly_fee","next_renewal","notion_workspace_id"]
    for (const k of allowed) if (k in body) updates[k] = body[k]
    updates.updated_at = new Date().toISOString()
    const { data, error } = await sb.from("clients").update(updates).eq("slug", slug).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  // DELETE — delete client by slug
  if (req.method === "DELETE") {
    const { slug } = req.query
    if (!slug) return res.status(400).json({ error: "slug required" })
    const { error } = await sb.from("clients").delete().eq("slug", slug)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: "Method not allowed" })
}
