// ─── expansion_invoice.js ─────────────────────────────────────────────────
// POST /api/expansion_invoice   { "page_id": "<expansion_page_id>" }
// Triggered by Notion button "Create Invoice" on the Expansions page.
//
// 1. Reads Expansion → Name, Value, Type, Client, Implementation, Deal
// 2. Determines payment terms (Micro → Full Upfront; else 50% Deposit)
// 3. Creates Supplementary invoice in Invoices DB
// 4. Links Invoice back to Expansion page
// 5. Auto-generates Supplementary Invoice PDF
// 6. Updates Expansion status → Proposal Sent

import { getPage, patchPage, createPage, plain, DB } from "../../lib/notion"

const API_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://widgets.opxio.io"

async function run(payload) {
  const rawId = payload.page_id
    || payload.data?.id           // Notion automation format
    || payload.data?.page_id
    || payload.source?.page_id
    || payload.source?.id
  if (!rawId) throw new Error("No page_id in payload")
  const expansionId = rawId.replace(/-/g, "")

  const exp   = await getPage(expansionId, process.env.NOTION_API_KEY)
  const props = exp.properties

  const expName   = plain(props.Name?.title || [])
  const expValue  = props.Value?.number || 0
  const expType   = props.Type?.select?.name || ""
  const expStatus = props.Status?.select?.name || ""

  const activeStatuses = ["Deposit Pending", "Deposit Paid", "In Progress", "Final Pending", "Closed – Paid"]
  if (activeStatuses.includes(expStatus)) {
    throw new Error(`Expansion already has an active invoice (status: ${expStatus})`)
  }

  const companyId = props.Client?.relation?.[0]?.id?.replace(/-/g, "") || null
  const implId    = props.Implementation?.relation?.[0]?.id?.replace(/-/g, "") || null
  const leadId    = props.Deal?.relation?.[0]?.id?.replace(/-/g, "") || null

  // Payment logic
  const isMicro       = expType.toLowerCase().includes("micro")
  const paymentTerms  = isMicro ? "Full Upfront" : "50% Deposit"
  const depositAmt    = isMicro ? 0 : Math.round(expValue * 0.5 * 100) / 100
  const finalPayAmt   = isMicro ? 0 : Math.round(expValue * 0.5 * 100) / 100
  const invStatus     = isMicro ? "Balance Pending" : "Deposit Pending"

  const today = new Date().toISOString().split("T")[0]

  // ── Create Supplementary Invoice ──────────────────────────────────────
  const invProps = {
    "Invoice No.":   { title: [{ text: { content: "" } }] },
    "Invoice Type":  { select: { name: "Supplementary" } },
    "Status":        { select: { name: invStatus } },
    "Issue Date":    { date: { start: today } },
    "Total Amount":  { number: expValue },
    "Payment Terms": { select: { name: paymentTerms } },
    ...(depositAmt  ? { "Deposit (50%)": { number: depositAmt  } } : {}),
    ...(finalPayAmt ? { "Final Payment": { number: finalPayAmt } } : {}),
    ...(companyId ? { "Company":         { relation: [{ id: companyId }] } } : {}),
    ...(implId    ? { "Implementation":  { relation: [{ id: implId    }] } } : {}),
    ...(leadId    ? { "Deal Source":     { relation: [{ id: leadId    }] } } : {}),
  }

  const invPage = await createPage({ parent: { database_id: DB.INVOICE }, properties: invProps }, process.env.NOTION_API_KEY)
  const invId   = invPage.id.replace(/-/g, "")
  console.log("[expansion_invoice] Invoice created:", invId)

  // Link invoice back to Expansion
  try {
    await patchPage(expansionId, {
      "Invoice": { relation: [{ id: invId }] },
      "Status":  { select: { name: "Proposal Sent" } },
    }, process.env.NOTION_API_KEY)
  } catch (e) {
    console.warn("[expansion_invoice] expansion update:", e.message)
  }

  // ── Auto-generate PDF ─────────────────────────────────────────────────
  let pdfUrl = ""
  try {
    const gr = await fetch(`${API_URL}/api/generate?page_id=${invId}&type=invoice`, {
      headers: { "Content-Type": "application/json" }
    })
    if (gr.ok) {
      const gd = await gr.json()
      pdfUrl = gd.pdf_url || ""
    } else {
      console.warn("[expansion_invoice] PDF gen failed:", gr.status)
    }
  } catch (e) {
    console.warn("[expansion_invoice] PDF gen:", e.message)
  }

  return {
    status:        "success",
    expansion_id:  expansionId,
    expansion_name: expName,
    invoice_id:    invId,
    invoice_type:  "Supplementary",
    payment_terms: paymentTerms,
    total_amount:  expValue,
    deposit_amt:   depositAmt,
    pdf_url:       pdfUrl || null,
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Expansion Invoice", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const result = await run(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[expansion_invoice]", e)
    return res.status(500).json({ error: e.message })
  }
}
