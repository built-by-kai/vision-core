// Debug endpoint — captures full Notion webhook request and stores in Vercel Blob
import { put, list } from "@vercel/blob"

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization")

  if (req.method === "OPTIONS") return res.status(200).end()

  // GET → retrieve the last captured payload
  if (req.method === "GET") {
    try {
      const { blobs } = await list({ prefix: "webhook-debug/", limit: 5 })
      if (!blobs.length) return res.json({ message: "No payloads captured yet" })
      // Return list of blobs with download URLs
      const entries = blobs.map(b => ({ url: b.downloadUrl, name: b.pathname, size: b.size, uploaded: b.uploadedAt }))
      return res.json({ count: blobs.length, entries })
    } catch (e) {
      return res.json({ error: e.message })
    }
  }

  // POST (or any other method) → capture everything
  const capture = {
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    query: req.query,
    body: req.body,
    bodyType: typeof req.body,
    bodyKeys: req.body ? Object.keys(req.body) : [],
  }

  try {
    const filename = `webhook-debug/${Date.now()}.json`
    await put(filename, JSON.stringify(capture, null, 2), {
      access: "public",
      contentType: "application/json",
    })
  } catch (e) {
    console.error("[webhook_debug] blob write:", e.message)
  }

  // Always return 200 OK
  return res.status(200).json({ ok: true, captured: true })
}
