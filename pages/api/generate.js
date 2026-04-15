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
import { OS_DEFAULT_MODULES, OS_DEFAULT_ADDONS_LATER, renderProposal } from "../../lib/proposal_template"
import { htmlToPdf } from "../../lib/puppeteer"
import { uploadBlob } from "../../lib/blob"
import { patchPage, getPage, queryDB, plain, fetchCompanyDetails, DB } from "../../lib/notion"

export const config = {
  api: { responseLimit: false },
}

function detectType(req) {
  const t = (req.query.type || req.body?.type || "quotation").toLowerCase()
  return t
}

// ── Sequential proposal number generator: PRO-2026-001 ───────────────────
async function generateProposalNo() {
  try {
    const rows = await queryDB(DB.PROPOSALS, null, process.env.NOTION_API_KEY)
    const year = new Date().getFullYear()
    let maxNum = 0
    for (const row of rows) {
      for (const [, v] of Object.entries(row.properties)) {
        if (v.type === "title") {
          const t = plain(v.title)
          const m = t.match(/PRO-\d{4}-(\d+)/i)
          if (m) { const n = parseInt(m[1]); if (n > maxNum) maxNum = n }
        }
      }
    }
    return `PRO-${year}-${String(maxNum + 1).padStart(3, "0")}`
  } catch (e) {
    console.warn("[generateProposalNo]", e.message)
    return `PRO-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`
  }
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
  const data = await fetchProposalData(pageId, process.env.NOTION_API_KEY)

  // ── Generate sequential ref number if page title is still empty ─────────
  // fetchProposalData returns a timestamp fallback if title is blank — detect and replace
  const titleIsBlank = !data.proposal_no || /PRO-\d{4}-\d{10,}/.test(data.proposal_no)
  const proposalNo   = titleIsBlank ? await generateProposalNo() : data.proposal_no

  // ── Map fetched data → renderProposal format ────────────────────────────
  const osType    = data.os_type || ""
  const modules   = OS_DEFAULT_MODULES[osType] || {}
  const addonsLater = OS_DEFAULT_ADDONS_LATER[osType] || []

  // ── Split line items: core (Base OS + main OS) vs add-ons ─────────────
  // Core items are the OS packages — everything else is an add-on for this proposal
  // Match "Base OS" or any known OS package name (may have suffixes like "(Revenue OS + Operations OS)")
  const isCoreItem = name => /base\s*os/i.test(name) || /\b(revenue|operations|business|marketing|agency|team|retention|intelligence|starter)\s+os\b/i.test(name)
  const coreItems  = (data.line_items || []).filter(i => isCoreItem(i.name || ''))
  const addonItems = (data.line_items || []).filter(i => !isCoreItem(i.name || ''))

  // Derive fee from core items (Base OS + main OS), fall back to all items if none tagged
  const feeBase = coreItems.length
    ? coreItems.reduce((s, i) => s + (i.qty || 1) * (i.unit_price || 0), 0)
    : (data.line_items || []).reduce((s, i) => s + (i.qty || 1) * (i.unit_price || 0), 0)
  const fee = feeBase || data.fee || 0

  // Map add-on line items to the proposal template format
  const addonNowItems = addonItems.map(i => ({
    name:        i.name || '',
    desc:        i.desc || '',
    price_label: i.unit_price ? `RM ${Number(i.unit_price).toLocaleString('en-MY')}` : '',
    cadence:     'one-time',
  }))

  // Format dates for display
  function fmtDate(iso) {
    if (!iso) return ""
    const d = new Date(iso)
    return d.toLocaleDateString("en-MY", { day: "numeric", month: "long", year: "numeric" })
  }

  const templateData = {
    ref_number:    proposalNo,
    date:          fmtDate(data.issue_date) || new Date().toLocaleDateString("en-MY", { month: "long", year: "numeric" }),
    valid_until:   fmtDate(data.valid_until),
    company_name:  data.company_name || "Client",
    contact_name:  data.pic_name     || "",
    contact_role:  data.pic_role     || "",
    whatsapp:      data.pic_phone    || "",
    email:         "hello@opxio.io",
    website:       "opxio.io",
    os_type:       osType,
    install_tier:  "Standard",
    notion_plan:   "Plus",
    timeline:      "3–4 weeks",
    fee,
    retainer:      "maintenance",
    // Build situation blocks with labels from the three context fields on the Proposal page
    situation: [
      data.situation       ? { label: "Situation",       text: data.situation }       : null,
      data.problems_solved ? { label: "Problems Solved", text: data.problems_solved } : null,
      data.goals           ? { label: "Goals",           text: data.goals }           : null,
    ].filter(Boolean),
    modules,
    addons_now:    addonNowItems,
    addons_later:  addonsLater,
  }

  const html    = renderProposal(templateData)
  const pdfBuf  = await htmlToPdf(html)

  const filename = `proposals/${proposalNo || pageId}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)
  const pdfUrl   = `${url}?v=${Date.now()}`

  await patchPage(pageId, {
    "PDF":    { url: pdfUrl },
    "Status": { select: { name: "Send Proposal" } },
    "Date":   { date: { start: new Date().toISOString().split("T")[0] } },
    // Write the ref number back to the title field
    ...(proposalNo && data.title_prop_name
      ? { [data.title_prop_name]: { title: [{ text: { content: proposalNo } }] } }
      : {}),
  }, process.env.NOTION_API_KEY)

  console.log(`[generate:proposal] done — ${proposalNo} — ${pdfUrl}`)
  return { type: "proposal", proposal_no: proposalNo, pdf_url: pdfUrl }
}

async function handleInvoice(pageId) {
  const data   = await fetchInvoiceData(pageId, process.env.NOTION_API_KEY)
  const pdfBuf = await generateInvoicePdf(data)
  // Note: invoice_no already contains the type suffix (e.g. -D, -F) from formatInvoiceNumber
  const filename = `invoices/${data.invoice_no || pageId}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)
  // Append timestamp so Notion always opens a fresh PDF (Vercel Blob caches 1 year by default)
  const pdfUrl = `${url}?v=${Date.now()}`

  // Write PDF URL first — critical path. Separate from Invoice No. so one can't block the other.
  // Invoice DB field is "Invoice PDF" (URL property), NOT "PDF"
  await patchPage(pageId, {
    "Invoice PDF": { url: pdfUrl },
  }, process.env.NOTION_API_KEY)

  // Write Invoice No. back (fetchInvoiceData already assigned it, this confirms it)
  if (data.invoice_no) {
    patchPage(pageId, {
      "Invoice No.": { title: [{ text: { content: data.invoice_no } }] },
    }, process.env.NOTION_API_KEY).catch(e =>
      console.warn("[generate:invoice] invoice_no patch:", e.message)
    )
  }

  console.log(`[generate:invoice] done — ${data.invoice_no} — ${pdfUrl}`)
  return { type: "invoice", invoice_no: data.invoice_no, invoice_type: data.invoice_type, pdf_url: pdfUrl }
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

  // Notion webhooks send page ID in body.data.id — also accept query params for manual calls
  const rawId = req.body?.data?.id || req.body?.page_id || req.body?.data?.page_id ||
                req.query.page_id  || req.query.id

  // Reject unsubstituted Notion template literals like {{id}}
  if (!rawId || rawId.includes("{{")) {
    return res.status(400).json({
      error: "Missing or invalid page_id. Notion button config: do NOT put page_id in the URL — Notion sends it automatically in the request body.",
    })
  }

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



