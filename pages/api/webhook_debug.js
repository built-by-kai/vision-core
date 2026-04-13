// pages/api/webhook_debug.js
// Temporary debug endpoint — logs exact payload from Notion automation
// URL: https://dashboard.opxio.io/api/webhook_debug

export default async function handler(req, res) {
  const body = req.body || {}
  const headers = req.headers || {}

  console.log("[webhook_debug] METHOD:", req.method)
  console.log("[webhook_debug] HEADERS:", JSON.stringify(headers, null, 2))
  console.log("[webhook_debug] BODY:", JSON.stringify(body, null, 2))

  return res.status(200).json({
    received: true,
    method: req.method,
    body,
    content_type: headers["content-type"],
  })
}
