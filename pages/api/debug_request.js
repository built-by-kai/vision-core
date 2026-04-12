import fs from "fs"
import path from "path"

export default async function handler(req, res) {
  const entry = {
    ts: new Date().toISOString(),
    method: req.method,
    query: req.query,
    body: req.body,
    ua: req.headers["user-agent"],
    ct: req.headers["content-type"],
  }
  // Write to /tmp so we can read it
  try {
    fs.writeFileSync("/tmp/last_notion_req.json", JSON.stringify(entry, null, 2))
  } catch {}
  console.log("[debug_request]", JSON.stringify(entry))
  return res.status(200).json({ ok: true, received: entry })
}
