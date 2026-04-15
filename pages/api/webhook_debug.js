// pages/api/webhook_debug.js
// Debug endpoint — captures Notion button payload into Vercel Blob
// POST: stores payload → GET: retrieves last captured payload
// URL: https://dashboard.opxio.io/api/webhook_debug

import { put, list, del } from "@vercel/blob"

const BLOB_NAME = "webhook_debug_last.json"

export default async function handler(req, res) {
  // GET → return last captured payload
  if (req.method === "GET") {
    try {
      const { blobs } = await list({ prefix: BLOB_NAME })
      if (!blobs.length) return res.json({ message: "No captured payload yet. Click the Notion button first." })
      const r = await fetch(blobs[0].url)
      const data = await r.json()
      return res.json(data)
    } catch (e) {
      return res.json({ error: e.message })
    }
  }

  // POST → capture and store
  const captured = {
    timestamp: new Date().toISOString(),
    method: req.method,
    headers: {
      "content-type": req.headers?.["content-type"],
      "user-agent": req.headers?.["user-agent"],
      "notion-hook-id": req.headers?.["notion-hook-id"],
      "x-notion-signature": req.headers?.["x-notion-signature"],
    },
    query: req.query,
    body: req.body,
    rawBody: typeof req.body === "string" ? req.body : null,
  }

  console.log("[webhook_debug]", JSON.stringify(captured, null, 2))

  // Store in Vercel Blob
  try {
    // Clean up old blob
    const { blobs } = await list({ prefix: BLOB_NAME })
    for (const b of blobs) await del(b.url)
    // Store new
    await put(BLOB_NAME, JSON.stringify(captured, null, 2), {
      access: "public",
      contentType: "application/json",
    })
  } catch (e) {
    console.warn("[webhook_debug] blob store failed:", e.message)
  }

  return res.status(200).json({ received: true })
}
