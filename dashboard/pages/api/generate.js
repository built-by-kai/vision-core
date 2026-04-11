// ─── generate.js ───────────────────────────────────────────────────────────
// GET /api/generate?page_id=<id>&type=quotation|invoice|receipt
// Generates PDF, uploads to Vercel Blob, writes URL back to Notion page.
// Triggered by Notion button "Generate PDF".

import {
  fetchQuotationData, fetchInvoiceData,
  generateQuotationPdf, generateInvoicePdf, generateReceiptPdf
} from "../../lib/pdf"
import { uploadBlob } from "../../lib/blob"
import { patchPage, getPage, plain } from "../../lib/notion"

const TOKEN = process.env.NOTION_API_KEY

// Increase default body size limit is not needed for GET, but set timeout via config
export const config = {
  api: { responseLimit: false },
}

function detectType(req) {
  // Explicit ?type= param
  if (req.query.type) return req.query.type.toLowerCase()
  // Fallback: look at the referer or path
  return "quotation"
}

async function handleQuotation(pageId, res) {
  const data     = await fetchQuotationData(pageId, TOKEN)
  const pdfBuf   = await generateQuotationPdf(data)
  const filename = `quotations/${data.quotation_no || pageId}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)

  // Write back to Notion
  const total = (data.line_items || []).reduce((s, i) => s + (i.qty || 1) * (i.unit_price || 0), 0)
  await patchPage(pageId, {
    "PDF":        { url },
    "Status":     { select: { name: "Draft" } },
    "Issue Date": { date: { start: new Date().toISOString().split("T")[0] } },
    ...(total > 0 ? { "Amount": { number: total } } : {}),
    ...(data.quotation_no && data.title_prop_name
      ? { [data.title_prop_name]: { title: [{ text: { content: data.quotation_no } }] } }
      : {}),
  }, TOKEN)

  return res.json({
    status:       "success",
    type:         "quotation",
    quotation_no: data.quotation_no,
    pdf_url:      url,
    total,
  })
}

async function handleInvoice(pageId, res) {
  const data   = await fetchInvoiceData(pageId, TOKEN)
  const pdfBuf = await generateInvoicePdf(data)
  const suffix = data.invoice_type === "Deposit" ? "-D" : data.invoice_type === "Final Payment" ? "-F" : ""
  const filename = `invoices/${data.invoice_no || pageId}${suffix}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)

  await patchPage(pageId, {
    "PDF": { url },
    "Invoice No.": { title: [{ text: { content: data.invoice_no } }] },
  }, TOKEN)

  return res.json({
    status:      "success",
    type:        "invoice",
    invoice_no:  data.invoice_no,
    invoice_type: data.invoice_type,
    pdf_url:     url,
  })
}

async function handleReceipt(pageId, res) {
  // Fetch receipt page
  const page   = await getPage(pageId, TOKEN)
  const props  = page.properties

  let receiptNo = plain(props["Receipt No."]?.title || [])
  const issueDate  = props["Issue Date"]?.date?.start || new Date().toISOString().split("T")[0]
  const amtPaid    = props["Amount Paid"]?.number || props["Total Amount"]?.number || 0
  const payMethod  = props["Payment Method"]?.select?.name || "Bank Transfer"

  // Company
  let companyName = "", companyAddress = "", companyPhone = ""
  const compRels  = props.Company?.relation || []
  if (compRels.length) {
    try {
      const { getPage: gp } = await import("../../lib/notion")
      const cp   = await gp(compRels[0].id.replace(/-/g, ""), TOKEN)
      const cprops = cp.properties
      for (const [, v] of Object.entries(cprops)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }

  // Invoice ref
  let invoiceNo = ""
  const invRels = props.Invoice?.relation || []
  if (invRels.length) {
    try {
      const { getPage: gp } = await import("../../lib/notion")
      const ip = await gp(invRels[0].id.replace(/-/g, ""), TOKEN)
      invoiceNo = plain(ip.properties["Invoice No."]?.title || [])
    } catch {}
  }

  const { fetchCompanyDetails } = await import("../../lib/notion")
  const ourCompany = await fetchCompanyDetails(TOKEN)

  const data = {
    receipt_no:    receiptNo || `RCP-${Date.now()}`,
    issue_date:    issueDate,
    invoice_no:    invoiceNo,
    company_name:  companyName,
    company_address: companyAddress,
    company_phone: companyPhone,
    amount_paid:   amtPaid,
    payment_method: payMethod,
    our_company:   ourCompany,
  }

  const pdfBuf = await generateReceiptPdf(data)
  const filename = `receipts/${data.receipt_no}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)

  await patchPage(pageId, { "PDF": { url } }, TOKEN)

  return res.json({ status: "success", type: "receipt", receipt_no: data.receipt_no, pdf_url: url })
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  const rawId = req.query.page_id || req.query.id || req.body?.page_id
  if (!rawId) return res.status(400).json({ error: "Missing page_id" })

  const pageId = rawId.replace(/-/g, "")
  const type   = detectType(req)

  try {
    if (type === "invoice")  return await handleInvoice(pageId, res)
    if (type === "receipt")  return await handleReceipt(pageId, res)
    return await handleQuotation(pageId, res)
  } catch (e) {
    console.error(`[generate:${type}]`, e)
    return res.status(500).json({ error: e.message })
  }
}
