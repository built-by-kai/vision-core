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

import { waitUntil } from "@vercel/functions"
import { getPage, patchPage, createPage, queryDB, plain, DB, hdrs } from "../../lib/notion"

// ── Default phases per package tier ─────────────────────────────────────────
// Full OS installs get 5 phases; micro installs get 3.
const PHASES_FULL = [
  { no: 1, name: "Phase 1 — Discovery & Setup",         deliverables: "Kickoff meeting, scope confirmation, access & workspace setup" },
  { no: 2, name: "Phase 2 — Core Build",                deliverables: "Database architecture, core modules, relations & automations" },
  { no: 3, name: "Phase 3 — Advanced Build & Expansion", deliverables: "Dashboards, advanced automations, integrations, add-on modules" },
  { no: 4, name: "Phase 4 — Client Review & Revisions",  deliverables: "Walkthrough session, client feedback, revisions & refinements" },
  { no: 5, name: "Phase 5 — QA & Handover",              deliverables: "Final QA, documentation, training session, handover" },
]

const PHASES_MICRO = [
  { no: 1, name: "Phase 1 — Discovery & Setup",          deliverables: "Kickoff, scope confirmation, workspace access" },
  { no: 2, name: "Phase 2 — Build & Configure",          deliverables: "Module build, relations, automations" },
  { no: 3, name: "Phase 3 — Review & Handover",          deliverables: "Client walkthrough, revisions, handover" },
]

const MICRO_PACKAGES = new Set(["Micro Install — 1 Module", "Micro Install — 2 Modules", "Micro Install — 3 Modules"])

// ── Find inline Products & Services DB on a page (checks callouts too) ──
async function findLineItemsDB(pageId, token) {
  try {
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
      headers: hdrs(token),
    })
    if (!r.ok) return null
    const blocks = (await r.json()).results || []

    const direct = blocks.find(b => b.type === "child_database")
    if (direct) return direct.id.replace(/-/g, "")

    const containers = blocks.filter(b =>
      ["callout", "column", "column_list", "toggle"].includes(b.type)
    )
    const inner = await Promise.all(
      containers.map(async b => {
        try {
          const nb = await fetch(`https://api.notion.com/v1/blocks/${b.id}/children?page_size=50`, {
            headers: hdrs(token),
          })
          return nb.ok ? (await nb.json()).results || [] : []
        } catch { return [] }
      })
    )
    const nested = inner.flat().find(b => b.type === "child_database")
    if (nested) return nested.id.replace(/-/g, "")
  } catch (e) {
    console.warn("[create_invoice] findLineItemsDB:", e.message)
  }
  return null
}

// ── Create inline Products & Services DB on a page (if it doesn't exist) ──
// Uses POST /v1/databases with is_inline:true — the only supported way to
// programmatically create an inline database on a Notion page.
async function ensureLineItemsDB(pageId, token) {
  // Check if it already exists
  let dbId = await findLineItemsDB(pageId, token)
  if (dbId) return dbId

  // Create inline database with the correct schema in one call
  const r = await fetch("https://api.notion.com/v1/databases", {
    method:  "POST",
    headers: hdrs(token),
    body:    JSON.stringify({
      parent:    { type: "page_id", page_id: pageId },
      is_inline: true,
      title: [{ type: "text", text: { content: "Products & Services" } }],
      properties: {
        "Notes":      { title: {} },
        "Qty":        { number: { format: "number" } },
        "Unit Price": { number: { format: "number" } },
        "Product":    { relation: { database_id: DB.CATALOGUE, single_property: {} } },
      },
    }),
  })
  if (!r.ok) {
    console.warn("[create_invoice] ensureLineItemsDB:", await r.text())
    return null
  }
  const db = await r.json()
  dbId = db.id.replace(/-/g, "")
  console.log("[create_invoice] created inline Products & Services DB:", dbId)
  return dbId
}

// ── Copy line items from Quotation's inline DB to Invoice's inline DB ────
// Creates the inline DB on the Invoice page if it doesn't exist yet.
async function copyLineItems(quotId, invId, token) {
  try {
    // Find source (Quotation) inline DB
    const srcDbId = await findLineItemsDB(quotId, token)
    if (!srcDbId) { console.log("[create_invoice] no source line items DB on quotation"); return }

    // Read source rows first — nothing to copy if empty
    const srcRows = await queryDB(srcDbId, undefined, token)
    if (!srcRows.length) { console.log("[create_invoice] quotation line items empty"); return }

    // Ensure Invoice has an inline DB (create one if missing)
    const tgtDbId = await ensureLineItemsDB(invId, token)
    if (!tgtDbId) { console.log("[create_invoice] could not create target line items DB on invoice"); return }

    // Always insert Base OS as the first line item (included with every install, price 0)
    try {
      await createPage({
        parent: { database_id: tgtDbId },
        properties: {
          "Notes":      { title: [{ type: "text", text: { content: "Base OS" } }] },
          "Qty":        { number: 1 },
          "Unit Price": { number: 0 },
        },
      }, token)
    } catch (e) {
      console.warn("[create_invoice] Base OS row failed:", e.message)
    }

    // Write each row to the target DB
    let written = 0
    for (const row of srcRows) {
      const rp          = row.properties
      const productRels = rp.Product?.relation || []
      const qty         = rp.Qty?.number || 1
      const unitPrice   = rp["Unit Price"]?.number ?? 0
      // Notes title may be blank — fall back to Product Description rollup
      const notesText = (rp.Notes?.title || []).map(t => t.plain_text || "").join("").trim()
        || (rp["Product Description"]?.rollup?.array || [])
            .flatMap(r => [...(r.title || []), ...(r.rich_text || [])])
            .map(t => t.plain_text || "").join("").trim()
        || ""
      const notesArr = notesText ? [{ type: "text", text: { content: notesText } }] : []

      try {
        await createPage({
          parent: { database_id: tgtDbId },
          properties: {
            "Notes":      { title: notesArr },
            "Qty":        { number: qty },
            "Unit Price": { number: unitPrice },
            ...(productRels.length ? { "Product": { relation: [{ id: productRels[0].id }] } } : {}),
          },
        }, token)
        written++
      } catch (e) {
        console.warn("[create_invoice] line item write failed:", e.message)
      }
    }
    console.log(`[create_invoice] copied ${written}/${srcRows.length} line items to invoice`)
  } catch (e) {
    console.warn("[create_invoice] copyLineItems:", e.message)
  }
}

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
  const amount       = props["Amount (MYR)"]?.number || props.Amount?.number || 0
  const packageName  = derivePackage(props) || null  // null if no OS detected — don't use quoteType as package

  // Linked IDs
  // Quotation has two separate relation fields:
  //   "Lead Source"  → Leads DB   (set by create_quotation.js when source is a Lead)
  //   "Deal Source"  → Deals DB   (set after Lead → Deal conversion)
  let companyId = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
  const picId     = props["Primary Contact"]?.relation?.[0]?.id?.replace(/-/g, "") || null
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

  // ── 1. Find or use the Invoice page created by Notion automation ────────────
  // The automation (Quotation → Approved) creates the Invoice page from template
  // (giving it the inline Products & Services DB), then fires this webhook.
  // We find that page first; fall back to creating one ourselves if not found.

  const invPatch = {
    "Invoice Type":   { select: { name: invType } },
    "Status":         { select: { name: "Deposit Pending" } },
    "Issue Date":     { date: { start: today } },
    "Amount (MYR)":   { number: amount },
    "Payment Terms":  { select: { name: paymentTerms } },
    "Quotation":      { relation: [{ id: quotId }] },
    ...(deposit50  ? { "Deposit (50%)": { number: deposit50 } } : {}),
    ...(isDeposit  ? { "Deposit Due":   { date: { start: dueDate } } } : {}),
    ...(companyId ? { "Company":         { relation: [{ id: companyId }] } } : {}),
    ...(picId     ? { "Primary Contact": { relation: [{ id: picId }] } } : {}),
    ...(dealId    ? { "Deal Source":     { relation: [{ id: dealId }] } } : {}),
  }

  // Try to find the page the automation just added to the Invoices DB.
  // Priority: (1) already linked on Quotation.Invoice, (2) query by Quotation relation,
  // (3) most recently created blank Invoice page (created in last 60 s).
  let invId = props.Invoice?.relation?.[0]?.id?.replace(/-/g, "") || null

  if (!invId) {
    try {
      const rows = await queryDB(DB.INVOICE, {
        property: "Quotation", relation: { contains: quotId }
      }, token)
      if (rows.length) invId = rows[0].id.replace(/-/g, "")
    } catch {}
  }

  if (!invId) {
    // Last resort: most recently created Invoice with no Invoice Type set yet
    try {
      const rows = await queryDB(DB.INVOICE, {
        property: "Invoice Type", select: { is_empty: true }
      }, token)
      if (rows.length) invId = rows[0].id.replace(/-/g, "")
    } catch {}
  }

  if (invId) {
    console.log("[create_invoice] Found automation-created Invoice:", invId)
    await patchPage(invId, invPatch, token)
  } else {
    // Fallback: create the Invoice page ourselves (no template, inline DB created later)
    const invPage = await createPage({
      parent: { database_id: DB.INVOICE },
      properties: { "Invoice No.": { title: [{ text: { content: "" } }] }, ...invPatch },
    }, token)
    invId = invPage.id.replace(/-/g, "")
    console.log("[create_invoice] Invoice created (fallback):", invId)
  }

  // Ensure Quotation links back to this Invoice
  await patchPage(quotId, { "Invoice": { relation: [{ id: invId }] } }, token)
    .catch(e => console.warn("[create_invoice] link invoice→quotation:", e.message))

  // ── 1b. Copy line items from Quotation → Invoice inline table ────────────
  // Must be awaited — if fire-and-forget, Vercel cuts it off when run() returns.
  await copyLineItems(quotId, invId, token)

  // ── 2. Create or Link Project ──────────────────────────────────────────────
  let projectId = existingProjectId

  if (!projectId) {
    // Fallback: pull Company from Lead if Quotation doesn't have one
    if (!companyId && leadId) {
      try {
        const lead = await getPage(leadId, token)
        companyId = lead.properties.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
      } catch {}
    }
    // Also try pulling Company from Lead Name (format: "CompanyName — ...")
    let companyName = ""
    if (companyId) {
      try {
        const co = await getPage(companyId, token)
        for (const v of Object.values(co.properties || {})) {
          if (v.type === "title") { companyName = plain(v.title); break }
        }
      } catch {}
    }
    // Last resort: extract company name from Lead Name if it has " — " separator
    if (!companyName && leadId) {
      try {
        const lead = await getPage(leadId, token)
        for (const v of Object.values(lead.properties || {})) {
          if (v.type === "title") {
            const leadTitle = plain(v.title)
            if (leadTitle.includes(" — ")) companyName = leadTitle.split(" — ")[0].trim()
            else if (leadTitle.includes(" - ")) companyName = leadTitle.split(" - ")[0].trim()
            break
          }
        }
      } catch {}
    }
    // If package isn't resolved from Quotation, try Proposal's OS Type via Related Proposal
    let resolvedPackage = packageName
    if (!resolvedPackage && props["Related Proposal"]?.relation?.length) {
      try {
        const propPage = await getPage(props["Related Proposal"].relation[0].id.replace(/-/g, ""), token)
        const propOsType = propPage.properties["OS Type"]?.select?.name
        if (propOsType) resolvedPackage = propOsType
      } catch {}
    }
    const projectName = companyName
      ? `${companyName} — ${resolvedPackage || quoteType} Build`
      : `${resolvedPackage || quoteType} Build`

    const projProps = {
      "Project Name": { title: [{ text: { content: projectName } }] },
      "Status":       { status: { name: "Pending Start" } },
      "Quotation":    { relation: [{ id: quotId }] },
      "Invoice":      { relation: [{ id: invId }] },
      ...(companyId ? { "Company": { relation: [{ id: companyId }] } } : {}),
      ...(dealId    ? { "Deals":   { relation: [{ id: dealId }] } } : {}),
    }

    const projPage = await createPage({ parent: { database_id: DB.PROJECTS }, properties: projProps }, token)
    projectId = projPage.id.replace(/-/g, "")
    console.log("[create_invoice] Project created:", projectId)

    // Back-link Project on Quotation
    // Note: Invoice → Client Account is linked later in deposit_paid when the
    // Client Account record is actually created. Don't link here.
    await patchPage(quotId, { "Project": { relation: [{ id: projectId }] } }, token)
      .catch(e => console.warn("[create_invoice] link project→quotation:", e.message))

    // ── 2b. Create default Phases for the new project ──────────────────────
    const phaseList = MICRO_PACKAGES.has(packageName) ? PHASES_MICRO : PHASES_FULL
    const phaseIds  = []

    for (const ph of phaseList) {
      try {
        const phPage = await createPage({
          parent: { database_id: DB.PHASES },
          properties: {
            "Phase Name":   { title: [{ text: { content: ph.name } }] },
            "Phase No.":    { number: ph.no },
            "Status":       { select: { name: "Not Started" } },
            "Project":      { relation: [{ id: projectId }] },
            "Deliverables": { rich_text: [{ text: { content: ph.deliverables } }] },
          },
        }, token)
        phaseIds.push(phPage.id.replace(/-/g, ""))
      } catch (e) {
        console.warn(`[create_invoice] phase ${ph.no} creation failed:`, e.message)
      }
    }

    // Link all phases back to the project's Phases relation
    if (phaseIds.length) {
      await patchPage(projectId, {
        "Phases": { relation: phaseIds.map(id => ({ id })) },
      }, token).catch(e => console.warn("[create_invoice] link phases:", e.message))
    }
    console.log(`[create_invoice] Created ${phaseIds.length} phases for project:`, projectId)
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

export const config = { api: { responseLimit: false } }

export default function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Create Invoice", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body = req.body || {}
  console.log("[create_invoice] payload:", JSON.stringify(body).slice(0, 300))

  // Respond immediately so Notion automation doesn't time out (10s limit)
  res.status(200).json({ status: "accepted" })

  // Do all the heavy work in the background via waitUntil
  waitUntil(
    run(body).catch(e =>
      console.error("[create_invoice]", e.message, e.stack?.slice(0, 300))
    )
  )
}
