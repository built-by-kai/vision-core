// ─── create_invoice.js ─────────────────────────────────────────────────────
// POST /api/create_invoice   { "page_id": "<quotation_page_id>" }
// Triggered by Notion automation when Quotation Status → Approved.
//
// 1. Reads Quotation → Company, Lead, Package, Amount, Payment Terms
// 2. Creates Invoice (Deposit or Full Payment depending on terms)
// 3. Creates Project hub in Projects DB
// 4. Links: Invoice ↔ Quotation ↔ Project ↔ Lead
// 5. Advances Lead stage → "Won – Pending Deposit"
// 6. Returns { invoice_id, project_id }

import { getPage, patchPage, createPage, plain, DB } from "../../lib/notion"

const TOKEN = process.env.NOTION_API_KEY

function hdrs() {
  return {
    Authorization:    `Bearer ${TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type":   "application/json",
  }
}

async function process(payload) {
  const rawId = payload.page_id || payload.source?.page_id || payload.data?.page_id
  if (!rawId) throw new Error("No page_id in payload")
  const quotId = rawId.replace(/-/g, "")

  const quot  = await getPage(quotId, TOKEN)
  const props = quot.properties

  // Quotation fields
  let quotNo = ""
  for (const v of Object.values(props)) {
    if (v.type === "title") { quotNo = plain(v.title); break }
  }
  const quoteType    = props["Quote Type"]?.select?.name || "New Business"
  const paymentTerms = props["Payment Terms"]?.select?.name || "50% Deposit"
  const amount       = props.Amount?.number || 0
  const packageType  = plain(props["Package Type"]?.rich_text || [])

  // Linked IDs
  const companyId = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
  let   leadId    = props["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "")
                    || props.Lead?.relation?.[0]?.id?.replace(/-/g, "")
                    || null

  // Check if project already exists (add-on quotation)
  const existingProjectId = props.Project?.relation?.[0]?.id?.replace(/-/g, "") || null

  const today     = new Date().toISOString().split("T")[0]
  const isDeposit = paymentTerms !== "Full Upfront"
  const invType   = isDeposit ? "Deposit" : "Full Payment"
  const deposit50 = isDeposit ? Math.round(amount * 0.5 * 100) / 100 : 0

  // ── 1. Create Invoice ─────────────────────────────────────────────────
  const invProps = {
    "Invoice No.":   { title: [{ text: { content: "" } }] },
    "Invoice Type":  { select: { name: invType } },
    "Status":        { select: { name: "Deposit Pending" } },
    "Issue Date":    { date: { start: today } },
    "Total Amount":  { number: amount },
    "Payment Terms": { select: { name: paymentTerms } },
    "Quotation":     { relation: [{ id: quotId }] },
    ...(deposit50 ? { "Deposit (50%)": { number: deposit50 } } : {}),
    ...(companyId ? { "Company": { relation: [{ id: companyId }] } } : {}),
    ...(leadId ? { "Deal Source": { relation: [{ id: leadId }] } } : {}),
  }

  const invPage = await createPage({ parent: { database_id: DB.INVOICE }, properties: invProps }, TOKEN)
  const invId   = invPage.id.replace(/-/g, "")
  console.log("[create_invoice] Invoice created:", invId)

  // Link Invoice ↔ Quotation
  try {
    await patchPage(quotId, { "Invoice": { relation: [{ id: invId }] } }, TOKEN)
  } catch {}

  // ── 2. Create or Link Project ─────────────────────────────────────────
  let projectId = existingProjectId

  if (!projectId) {
    const projectName = packageType || quoteType || "New Project"
    const projProps = {
      "Project Name":  { title: [{ text: { content: projectName } }] },
      "Status":        { select: { name: "Pending Start" } },
      "Package":       { select: { name: quoteType } },
      "Quotation":     { relation: [{ id: quotId }] },
      "Invoice":       { relation: [{ id: invId }] },
      ...(companyId ? { "Company": { relation: [{ id: companyId }] } } : {}),
      ...(leadId ? { "Deal Source": { relation: [{ id: leadId }] } } : {}),
    }
    const projPage = await createPage({ parent: { database_id: DB.PROJECTS }, properties: projProps }, TOKEN)
    projectId = projPage.id.replace(/-/g, "")
    console.log("[create_invoice] Project created:", projectId)
  } else {
    // Add-on: just link the supplementary invoice to the existing project
    try {
      const proj  = await getPage(projectId, TOKEN)
      const invs  = proj.properties.Invoice?.relation || []
      const newInvs = [...invs.map(r => ({ id: r.id })), { id: invId }]
      await patchPage(projectId, { "Invoice": { relation: newInvs } }, TOKEN)
    } catch {}
    console.log("[create_invoice] Linked supplementary invoice to existing project:", projectId)
  }

  // Link Project ↔ Invoice (if newly created)
  if (!existingProjectId) {
    try { await patchPage(invId, { "Implementation": { relation: [{ id: projectId }] } }, TOKEN) } catch {}
    try { await patchPage(quotId, { "Project": { relation: [{ id: projectId }] } }, TOKEN) } catch {}
  }

  // ── 3. Advance Lead → "Won – Pending Deposit" ─────────────────────────
  if (leadId) {
    try {
      await patchPage(leadId, {
        "Stage": { status: { name: "Won – Pending Deposit" } }
      }, TOKEN)
    } catch (e) {
      console.warn("[create_invoice] Lead stage:", e.message)
    }
  }

  // ── 4. Mark Quotation as Approved/Invoiced ────────────────────────────
  try {
    await patchPage(quotId, {
      "Status": { select: { name: "Approved" } }
    }, TOKEN)
  } catch {}

  return {
    status:       "success",
    quotation_id: quotId,
    invoice_id:   invId,
    invoice_type: invType,
    project_id:   projectId,
    lead_id:      leadId,
    company_id:   companyId,
    amount,
    deposit_50:   deposit50,
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Create Invoice", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const result = await process(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[create_invoice]", e)
    return res.status(500).json({ error: e.message })
  }
}
