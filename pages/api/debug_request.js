// debug_request.js — echoes back request details for debugging Notion button webhooks
// Set your Notion button URL to: https://dashboard.opxio.io/api/debug_request?page_id={{id}}
// Then check Vercel function logs at: https://vercel.com/opxio-io/opxio-dashboard/logs

export default async function handler(req, res) {
  const entry = {
    ts: new Date().toISOString(),
    method: req.method,
    query: req.query,
    body: req.body,
    ua: req.headers["user-agent"],
    ct: req.headers["content-type"],
    all_headers: req.headers,
  }
  console.log("[debug_request]", JSON.stringify(entry))
  return res.status(200).json({ ok: true, received: entry })
}
