// ─── create_invoice.js ─────────────────────────────────────────────────────
// POST /api/create_invoice   { "page_id": "<quotation_page_id>" }
// Triggered by Notion automation when Quotation Status → Approved.
//
// 1. Reads Quotation → Company, Lead, Package, Amount, Payment Terms
// 2. Creates Invoice (Deposit or Full Payment depending on terms)
// 3. Creates Project hub in Projects DB (or links to existing for add-ons)
// 4. Links: Invoice ↔ Quotation ↔ Project ↔ Lead
// 5. Advances Lead/Deal stage → "Awaiting Deposit"
// 6. Returns { invoice_id, project_id }

import { getPage, patchPage, createPage, plain, DB } from "../../lib/notion"

// ── Package slug → human-readable OS name (for Projects DB Package select) ─
const SLUG_TO_PACKAGE = {
  "revenue-os":       "Revenue OS",
  "operations-os":    "Operations OS",
  "marketing-os":     "Marketing OS",
  "business-os":      "Business OS",
  "full-platform-os": "Agency OS",
  "team-os":          "Team OS",
  "retention-os":     "Retention OS",
  "intelligence-os":  "Intelligence OS",
  "starter-os":       "Starter OS",
  "micro-install-1":  "Micro Install — 1 Module",
  "micro-install-2":  "Micro Install — 2 Modules",
  "micro-install-3":  "Micro Install — 3 Modules",
}

// ── Derive a sensible Package select value from quotation props ───────────
// Priority: explicit "OS Type" select → "Package Type" rich text → title slug
function derivePackage(props) {
  // 1. OS Type select (populated by convert_proposal / create_quotation)
  const osType = props["OS Type"]?.select?.name
  if (osType) return osType

  // 2. Package Type rich text
  const pkgText = plain(props["Package Type"]?.rich_text || []).trim()
  if (pkgText) return pkgText

  // 3. Derive from quotation title (e.g. "Revenue OS — Acme Corp")
  let title = ""
  for (const v of Object.values(props)) {
    if (v.type === "title") { title = plain(v.title); break }
  }
  for (const [slug, name] of Object.entries(SLUG_TO_PACKAGE)) {
    if (title.toLowerCase().includes(slug.replace(/-/g, " "))) return name
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
async function run(payload) {
  const token = process.env.NOTION_API_KEY

  // Extract quotation page ID — support all Notion webhook formats
  const rawId = payload.page_id
    || payload.data?.id          // ← Notion automation primary format
    || payload.data?.page_id
    || payload.source?.page_id
    || payload.source?.id
  if (!rawId) throw new Error("No page_id in payload")
  const quotId = rawId.replace(/-/g, "")

  const quot  = await getPage(quotId, token)
  const props = quot.properties

  // Quotation fields
  let quotNo = ""
  for (const v of Object.values(props)) {
    if (v.type === "title") { quotNo = plain(v.title); break }
  }

  const quoteType    = props["Quote Type"]?.select?.name || "New Business"
  const paymentTerms = props["Payment Terms"]?.select?.name || "50% Deposit"
  const amount       = props.Amount?.number || 0
  const packageName  = derivePackage(props) || quoteType

  // Linked IDs
  // Quotation has two separate relation fields:
  //   "Lead Source"  → Leads DB   (set by create_quotation.js when source is a Lead)
  //   "Deal Source"  → Deals DB   (set after Lead → Deal conversion)
  const companyId = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
  const picId     = props.PIC?.relation?.[0]?.id?.replace(/-/g, "") || null
  const leadId    = props["Lead Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null
  const dealId    = props["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null
  // sourceId: the Lead or Deal to advance stage on
  const sourceId  = dealId || leadId

  // Check if project already exists (add-on quotation)
  const existingProjectId = props.Project?.relation?.[0]?.id?.replace(/-/g, "") || null

  const today     = new Date().toISOString().split("T")[0]
  const isDeposit = paymentTerms !== "Full Upfront"
  const invType   = isDeposit ? "Deposit" : "Full Payment"
  const deposit50 = isDeposit ? Math.round(amount * 0.5 * 100) / 100 : 0

  // Due date: 7 days from today
  const dueDateObj = new Date(); dueDateObj.setDate(dueDateObj.getDate() + 7)
  const dueDate = dueDateObj.toISOString().split("T")[0]

  console.log("[create_invoice] quotId:", quotId, "| amount:", amount, "| terms:", paymentTerms, "| package:", packageName)

  // ── 1. Create Invoice ─────────────────────────────────────────────────────
  const invProps = {
    "Invoice No.":   { title: [{ text: { content: "" } }] },
    "Invoice Type":  { select: { name: invType } },
    "Status":        { select: { name: "Deposit Pending" } },
    "Issue Date":    { date: { start: today } },
    "Total Amount":  { number: amount },
    "Payment Terms": { select: { name: paymentTerms } },
    "Quotation":     { relation: [{ id: quotId }] },
    ...(deposit50  ? { "Deposit (50%)": { number: deposit50 } } : {}),
    ...(isDeposit  ? { "Deposit Due":   { date: { start: dueDate } } } : {}),
    ...(companyId ? { "Company": { relation: [{ id: companyId }] } } : {}),
    ...(picId     ? { "PIC":     { relation: [{ id: picId }] } } : {}),
    // Invoice.Deal Source → Deals DB only (not Leads). Only write if we have a Deal.
    ...(dealId    ? { "Deal Source": { relation: [{ id: dealId }] } } : {}),
  }

  const invPage = await createPage({ parent: { database_id: DB.INVOICE }, properties: invProps }, token)
  const invId   = invPage.id.replace(/-/g, "")
  console.log("[create_invoice] Invoice created:", invId)

  // Link Invoice ↔ Quotation
  await patchPage(quotId, { "Invoice": { relation: [{ id: invId }] } }, token).catch(() => {})

  // ── 2. Create or Link Project ──────────────────────────────────────────────
  let projectId = existingProjectId

  if (!projectId) {
    // Build project name: "Package — Company" or just package
    let projectName = packageName
    if (companyId) {
      try {
        const co = await getPage(companyId, token)
        const coName = plain(co.properties?.["Company Name"]?.title || co.properties?.Name?.title || [])
        if (coName) projectName = `${packageName} — ${coName}`
      } catch {}
    }

    const projProps = {
      "Project Name": { title: [{ text: { content: projectName } }] },
      "Status":       { select: { name: "Pending Start" } },
      "Quotation":    { relation: [{ id: quotId }] },
      "Invoice":      { relation: [{ id: invId }] },
      ...(packageName ? { "Package":     { select:   { name: packageName } } } : {}),
      ...(companyId   ? { "Company":     { relation: [{ id: companyId }] } } : {}),
      // Project.Deal Source → Deals DB. Only write if Deal already exists.
      ...(dealId      ? { "Deal Source": { relation: [{ id: dealId }] } } : {}),
    }

    const projPage = await createPage({ parent: { database_id: DB.PROJECTS }, properties: projProps }, token)
    projectId = projPage.id.replace(/-/g, "")
    console.log("[create_invoice] Project created:", projectId)

    // Back-link Project on Invoice and Quotation
    await Promise.allSettled([
      patchPage(invId,  { "Implementation": { relation: [{ id: projectId }] } }, token),
      patchPage(quotId, { "Project":         { relation: [{ id: projectId }] } }, token),
    ])
  } else {
    // Add-on: append supplementary invoice to existing project
    try {
      const proj    = await getPage(projectId, token)
      const existing = proj.properties.Invoice?.relation || []
      const merged   = [...existing.map(r => ({ id: r.id })), { id: invId }]
      await patchPage(projectId, { "Invoice": { relation: merged } }, token)
    } catch (e) {
      console.warn("[create_invoice] link add-on invoice:", e.message)
    }
    console.log("[create_invoice] Linked supplementary invoice to existing project:", projectId)
  }

  // ── 3. Advance Lead/Deal → "Awaiting Deposit" and populate Deal Value ───────
  if (sourceId) {
    // Advance stage to Awaiting Deposit (works on both Lead and Deal)
    await patchPage(sourceId, { "Stage": { status: { name: "Awaiting Deposit" } } }, token)
      .catch(e => console.warn("[create_invoice] stage advance:", e.message))
  }
  if (dealId && amount) {
    // Quotation approved → update Deal Value on the linked Deal
    await patchPage(dealId, {
      "Deal Value": { number: amount },
      "Quotation":  { relation: [{ id: quotId }] },
      "Invoices":   { relation: [{ id: invId }] },
    }, token).catch(e => console.warn("[create_invoice] deal value patch:", e.message))
  }
  if (leadId && !dealId) {
    // Lead not yet converted — link Quotation back to Invoice on Lead's Quotations rollup
    // (no Deal yet; Deal Value will be set in deposit_paid.js when deposit is received)
    await patchPage(quotId, { "Lead Source": { relation: [{ id: leadId }] } }, token).catch(() => {})
  }

  // ── 4. Mark Quotation → Approved ─────────────────────────────────────────
  await patchPage(quotId, { "Status": { select: { name: "Approved" } } }, token).catch(() => {})

  return {
    status:       "ok",
    quotation_id: quotId,
    invoice_id:   invId,
    invoice_type: invType,
    project_id:   projectId,
    lead_id:      leadId,
    deal_id:      dealId,
    source_id:    sourceId,
    company_id:   companyId,
    package:      packageName,
    amount,
    deposit_50:   deposit50,
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Create Invoice", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body = req.body || {}
  console.log("[create_invoice] payload:", JSON.stringify(body).slice(0, 300))

  try {
    const result = await run(body)
    return res.json(result)
  } catch (e) {
    console.error("[create_invoice]", e.message, e.stack?.slice(0, 300))
    return res.status(500).json({ error: e.message })
  }
}
