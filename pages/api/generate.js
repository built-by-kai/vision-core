// ─── generate.js ───────────────────────────────────────────────────────────
// GET /api/generate?page_id=<id>&type=quotation|invoice|receipt
// Triggered by Notion button "Generate PDF".
//
// Responds 200 immediately, then runs PDF generation in the background via
// waitUntil() — Vercel's official API for post-response work in Node.js
// serverless functions.

import { waitUntil } from "@vercel/functions"
import {
  fetchQuotationData, fetchInvoiceData, fetchProposalData,
  generateQuotationPdf, generateInvoicePdf, generateReceiptPdf
} from "../../lib/pdf"
import { uploadBlob } from "../../lib/blob"
import { patchPage, getPage, plain, fetchCompanyDetails } from "../../lib/notion"

export const config = {
  api: { responseLimit: false },
}

function detectType(req) {
  const t = (req.query.type || "quotation").toLowerCase()
  return t
}

async function handleQuotation(pageId) {
  const data     = await fetchQuotationData(pageId, process.env.NOTION_API_KEY)
  const pdfBuf   = await generateQuotationPdf(data)
  const filename = `quotations/${data.quotation_no || pageId}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)

  const total  = (data.line_items || []).reduce((s, i) => s + (i.qty || 1) * (i.unit_price || 0), 0)
  // Append timestamp so Notion always opens a fresh PDF (Vercel Blob caches 1 year by default)
  const pdfUrl = `${url}?v=${Date.now()}`

  await patchPage(pageId, {
    "PDF":        { url: pdfUrl },
    "Status":     { select: { name: "Draft" } },
    "Issue Date": { date: { start: new Date().toISOString().split("T")[0] } },
    ...(total > 0 ? { "Amount": { number: total } } : {}),
    ...(data.quotation_no && data.title_prop_name
      ? { [data.title_prop_name]: { title: [{ text: { content: data.quotation_no } }] } }
      : {}),
  }, process.env.NOTION_API_KEY)

  console.log(`[generate:quotation] done — ${data.quotation_no} — ${pdfUrl}`)
  return { type: "quotation", quotation_no: data.quotation_no, pdf_url: pdfUrl, total }
}

async function handleProposal(pageId) {
  const data     = await fetchProposalData(pageId, process.env.NOTION_API_KEY)
  const pdfBuf   = await generateQuotationPdf(data)  // docType=Proposal handled inside
  const filename = `proposals/${data.proposal_no || pageId}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)
  const pdfUrl   = `${url}?v=${Date.now()}`

  await patchPage(pageId, {
    "PDF":    { url: pdfUrl },
    "Status": { select: { name: "Send Proposal" } },
    "Date":   { date: { start: new Date().toISOString().split("T")[0] } },
  }, process.env.NOTION_API_KEY)

  console.log(`[generate:proposal] done — ${data.proposal_no} — ${pdfUrl}`)
  return { type: "proposal", proposal_no: data.proposal_no, pdf_url: pdfUrl }
}

async function handleInvoice(pageId) {
  const data   = await fetchInvoiceData(pageId, process.env.NOTION_API_KEY)
  const pdfBuf = await generateInvoicePdf(data)
  const suffix = data.invoice_type === "Deposit" ? "-D" : data.invoice_type === "Final Payment" ? "-F" : ""
  const filename = `invoices/${data.invoice_no || pageId}${suffix}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)

  await patchPage(pageId, {
    "PDF":         { url },
    "Invoice No.": { title: [{ text: { content: data.invoice_no } }] },
  }, process.env.NOTION_API_KEY)

  console.log(`[generate:invoice] done — ${data.invoice_no} — ${url}`)
  return { type: "invoice", invoice_no: data.invoice_no, invoice_type: data.invoice_type, pdf_url: url }
}

async function handleReceipt(pageId) {
  const page  = await getPage(pageId, process.env.NOTION_API_KEY)
  const props = page.properties

  const receiptNo  = plain(props["Receipt No."]?.title || [])
  const issueDate  = props["Issue Date"]?.date?.start || new Date().toISOString().split("T")[0]
  const amtPaid    = props["Amount Paid"]?.number || props["Total Amount"]?.number || 0
  const payMethod  = props["Payment Method"]?.select?.name || "Bank Transfer"

  let companyName = ""
  const compRels  = props.Company?.relation || []
  if (compRels.length) {
    try {
      const cp = await getPage(compRels[0].id.replace(/-/g, ""), process.env.NOTION_API_KEY)
      const cprops = cp.properties
      for (const [, v] of Object.entries(cprops)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }

  let invoiceNo = ""
  const invRels = props.Invoice?.relation || []
  if (invRels.length) {
    try {
      const ip = await getPage(invRels[0].id.replace(/-/g, ""), process.env.NOTION_API_KEY)
      invoiceNo = plain(ip.properties["Invoice No."]?.title || [])
    } catch {}
  }

  const ourCompany = await fetchCompanyDetails(process.env.NOTION_API_KEY)

  const data = {
    receipt_no:      receiptNo || `RCP-${Date.now()}`,
    issue_date:      issueDate,
    invoice_no:      invoiceNo,
    company_name:    companyName,
    company_address: "",
    company_phone:   "",
    amount_paid:     amtPaid,
    payment_method:  payMethod,
    our_company:     ourCompany,
  }

  const pdfBuf   = await generateReceiptPdf(data)
  const filename = `receipts/${data.receipt_no}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)

  await patchPage(pageId, { "PDF": { url } }, process.env.NOTION_API_KEY)

  console.log(`[generate:receipt] done — ${data.receipt_no} — ${url}`)
  return { type: "receipt", receipt_no: data.receipt_no, pdf_url: url }
}

export default function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const rawId = req.query.page_id || req.query.id || req.body?.page_id
  if (!rawId) return res.status(400).json({ error: "Missing page_id" })

  const pageId = rawId.replace(/-/g, "")
  const type   = detectType(req)

  // ── Respond immediately so Notion's button doesn't time out ──────────────
  res.status(200).json({ status: "accepted", type, page_id: pageId })

  // ── waitUntil: Vercel keeps the function alive until this Promise settles ─
  // This is the ONLY reliable way to do post-response work in Vercel serverless.
  const work = (async () => {
    try {
      if (type === "invoice") {
        await handleInvoice(pageId)
      } else if (type === "receipt") {
        await handleReceipt(pageId)
      } else if (type === "proposal") {
        await handleProposal(pageId)
      } else {
        await handleQuotation(pageId)
      }
    } catch (e) {
      console.error(`[generate:${type}] error:`, e.message, e.stack)
    }
  })()

  waitUntil(work)
}
