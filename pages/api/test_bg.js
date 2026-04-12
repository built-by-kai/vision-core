// Minimal test: does waitUntil actually run background work?
// GET /api/test_bg?page_id=<id>
// Should patch "PDF" with a test URL after responding

import { waitUntil } from "@vercel/functions"

export default function handler(req, res) {
  const pageId = (req.query.page_id || "").replace(/-/g, "")
  if (!pageId) return res.status(400).json({ error: "missing page_id" })

  res.status(200).json({ status: "accepted", page_id: pageId })

  waitUntil((async () => {
    try {
      console.log("[test_bg] background started for", pageId)
      const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties: { "PDF": { url: "https://test-bg-worked.com/ok.pdf" } } }),
      })
      const j = await r.json()
      console.log("[test_bg] patch result:", r.status, j.id ? "ok" : JSON.stringify(j))
    } catch (e) {
      console.error("[test_bg] error:", e.message)
    }
  })())
}
