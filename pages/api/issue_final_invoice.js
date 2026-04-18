// ─── issue_final_invoice.js ────────────────────────────────────────────────
// POST /api/issue_final_invoice   { "page_id": "<project_page_id>" }
// Triggered by Notion button "Issue Final Invoice" on a Project page.
//
// 1. Reads Project → Company, Quotation, Deposit Invoice, Lead
// 2. Reads Quotation → Total Amount, Payment Terms
// 3. Creates Final Payment invoice in Invoices DB
// 4. Auto-generates Final Invoice PDF
// 5. Updates Project status → In Review
// 6. Advances Lead stage → Pending Final Payment

import { getPage, patchPage, createPage, plain, DB, createLedgerEntry } from "../../lib/notion"


const API_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://api.opxio.io"

async function run(payload) {
  const rawId = payload.page_id
    || payload.data?.id           // Notion automation format
    || payload.data?.page_id
    || payload.source?.page_id
    || payload.source?.id
  if (!rawId) throw new Error("No page_id in payload")
  const projectId = rawId.replace(/-/g, "")

  const proj  = await getPage(projectId, process.env.NOTION_API_KEY)
  const props = proj.properties

  const status = props.Status?.select?.name || ""
  if (status === "Completed") throw new Error("Project already completed")

  // Gather linked IDs from Project
  const companyId    = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
  const quotationId  = props.Quotation?.relation?.[0]?.id?.replace(/-/g, "") || null
  const depositInvId = props.Invoice?.relation?.[0]?.id?.replace(/-/g, "") || null

  // Lead — try multiple field names
  let leadId = null
  for (const field of ["Deals", "Deal Source", "Lead"]) {
    leadId = props[field]?.relation?.[0]?.id?.replace(/-/g, "") || null
    if (leadId) break
  }

  // Get amounts from Quotation
  let totalAmount = 0, paymentTerms = "50% Deposit"
  if (quotationId) {
    try {
      const qpage = await getPage(quotationId, process.env.NOTION_API_KEY)
      totalAmount  = qpage.properties["Amount (MYR)"]?.number || qpage.properties.Amount?.number || 0
      paymentTerms = qpage.properties["Payment Terms"]?.select?.name || "50% Deposit"
    } catch (e) {
      console.warn("[issue_final_invoice] quotation fetch:", e.message)
    }
  }

  if (paymentTerms === "Full Upfront") {
    throw new Error("This was a Full Upfront payment — no final invoice needed")
  }

  // Get deposit amount from deposit invoice
  let depositAmt = 0
  if (depositInvId) {
    try {
      const dp = await getPage(depositInvId, process.env.NOTION_API_KEY)
      depositAmt = dp.properties["Deposit (50%)"]?.number || 0
    } catch {}
  }

  const finalPayment = depositAmt ? totalAmount - depositAmt : totalAmount * 0.5
  const today = new Date().toISOString().split("T")[0]

  // ── Create Final Payment Invoice ───────────────────────────────────────
  const invProps = {
    "Invoice No.":    { title: [{ text: { content: "" } }] },
    "Invoice Type":   { select: { name: "Final Payment" } },
    "Status":         { select: { name: "Balance Pending" } },
    "Issue Date":     { date: { start: today } },
    "Total Amount":   { number: totalAmount },
    "Final Payment":  { number: Math.round(finalPayment * 100) / 100 },
    "Payment Terms":  { select: { name: paymentTerms } },
    "Implementation": { relation: [{ id: projectId }] },
    ...(companyId   ? { "Company":        { relation: [{ id: companyId   }] } } : {}),
    ...(quotationId ? { "Quotation":      { relation: [{ id: quotationId }] } } : {}),
    ...(depositInvId ? { "Deposit Invoice": { relation: [{ id: depositInvId }] } } : {}),
    ...(leadId       ? { "Deal Source":    { relation: [{ id: leadId      }] } } : {}),
  }

  const invPage = await createPage({ parent: { database_id: DB.INVOICE }, properties: invProps }, process.env.NOTION_API_KEY)
  const invId   = invPage.id.replace(/-/g, "")
  console.log("[issue_final_invoice] Final invoice created:", invId)

  // Link deposit invoice → this final invoice
  if (depositInvId) {
    try { await patchPage(depositInvId, { "Final Invoice": { relation: [{ id: invId }] } }, process.env.NOTION_API_KEY) } catch {}
  }

  // ── Auto-generate Final Invoice PDF ───────────────────────────────────
  let pdfUrl = ""
  try {
    const gr = await fetch(`${API_URL}/api/generate?page_id=${invId}&type=invoice`, {
      headers: { "Content-Type": "application/json" }
    })
    if (gr.ok) {
      const gd = await gr.json()
      pdfUrl = gd.pdf_url || ""
      console.log("[issue_final_invoice] PDF generated:", pdfUrl.slice(0, 60))
    } else {
      console.warn("[issue_final_invoice] PDF gen failed:", gr.status)
    }
  } catch (e) {
    console.warn("[issue_final_invoice] PDF gen:", e.message)
  }

  // ── Update Project → In Review ─────────────────────────────────────────
  try {
    await patchPage(projectId, {
      "Status":            { select: { name: "In Review" } },
      "Final Invoice":     { relation: [{ id: invId }] },
    }, process.env.NOTION_API_KEY)
  } catch (e) {
    console.warn("[issue_final_invoice] project update:", e.message)
  }

  // ── Advance Lead stage ─────────────────────────────────────────────────
  if (leadId) {
    try {
      await patchPage(leadId, { "Stage": { status: { name: "Balance Due" } } }, process.env.NOTION_API_KEY)
    } catch {}
  }

  // ── Finance Ledger — auto-create Final Payment entry (Pending) ──────────
  // Status is "Pending" because the invoice has been issued but not yet paid.
  // When the client pays, the user updates this entry to "Received".
  let companyName = ""
  if (companyId) {
    try {
      const cp = await getPage(companyId, process.env.NOTION_API_KEY)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }
  createLedgerEntry({
    title:     companyName ? `Final Payment — ${companyName}` : "Client Final Payment",
    amount:    Math.round(finalPayment * 100) / 100,
    category:  "Client Final Payment",
    source:    "Client Payment",
    payment:   "Bank Transfer",
    status:    "Pending",
    date:      today,
    invoiceId: invId,
    projectId: projectId,
    notes:     "Auto-created when final invoice issued — update to Received when paid",
  }, process.env.NOTION_API_KEY).catch(() => {})

  return {
    status:        "success",
    project_id:    projectId,
    invoice_id:    invId,
    invoice_type:  "Final Payment",
    final_payment: Math.round(finalPayment * 100) / 100,
    total_amount:  totalAmount,
    pdf_url:       pdfUrl || null,
    lead_id:       leadId,
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Issue Final Invoice", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const result = await run(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[issue_final_invoice]", e)
    return res.status(500).json({ error: e.message })
  }
}
