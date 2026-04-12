// Diagnostic: test each step of PDF generation pipeline in background
// GET /api/test_bg?page_id=<id>

import { waitUntil } from "@vercel/functions"
import { uploadBlob } from "../../lib/blob"
import { fetchQuotationData, generateQuotationPdf } from "../../lib/pdf"

export default function handler(req, res) {
  const pageId = (req.query.page_id || "").replace(/-/g, "")
  if (!pageId) return res.status(400).json({ error: "missing page_id" })

  res.status(200).json({ status: "accepted", page_id: pageId })

  waitUntil((async () => {
    // Step 1: fetch data
    let data
    try {
      console.log("[test_bg] step1: fetchQuotationData")
      data = await fetchQuotationData(pageId, process.env.NOTION_API_KEY)
      console.log("[test_bg] step1 ok — quotation_no:", data.quotation_no, "items:", data.line_items?.length)
    } catch (e) {
      console.error("[test_bg] step1 FAILED:", e.message)
      return
    }

    // Step 2: generate PDF
    let pdfBuf
    try {
      console.log("[test_bg] step2: generateQuotationPdf")
      pdfBuf = await generateQuotationPdf(data)
      console.log("[test_bg] step2 ok — size:", pdfBuf?.length)
    } catch (e) {
      console.error("[test_bg] step2 FAILED:", e.message, e.stack)
      return
    }

    // Step 3: upload blob
    let blobUrl
    try {
      console.log("[test_bg] step3: uploadBlob — token set?", !!process.env.BLOB_READ_WRITE_TOKEN)
      const result = await uploadBlob(`test/${pageId}.pdf`, pdfBuf)
      blobUrl = result.url
      console.log("[test_bg] step3 ok — url:", blobUrl)
    } catch (e) {
      console.error("[test_bg] step3 FAILED:", e.message, e.stack)
      return
    }

    // Step 4: patch Notion
    try {
      console.log("[test_bg] step4: patchPage")
      const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties: { "PDF": { url: `${blobUrl}?v=${Date.now()}` } } }),
      })
      const j = await r.json()
      console.log("[test_bg] step4:", r.status, j.id ? "ok" : JSON.stringify(j).slice(0, 200))
    } catch (e) {
      console.error("[test_bg] step4 FAILED:", e.message)
    }
  })())
}
