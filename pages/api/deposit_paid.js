// ─── deposit_paid.js ───────────────────────────────────────────────────────
// POST /api/deposit_paid   { "page_id": "<invoice_page_id>" }
// Triggered by Notion button "Mark Deposit Paid" on Invoice page.

import { getPage, patchPage, createPage, queryDB, plain, DB, createLedgerEntry } from "../../lib/notion"

function cleanPhone(phone = "") {
  const digits = phone.replace(/\D/g, "")
  return digits.startsWith("0") ? "6" + digits : digits
}

async function getPicPhone(companyId, token) {
  try {
    const cp   = await getPage(companyId, token)
    const rels = cp.properties.People?.relation || cp.properties.Clients?.relation || []
    for (const rel of rels) {
      const pp = await getPage(rel.id.replace(/-/g, ""), token)
      if (pp.properties["Primary Contact"]?.checkbox) {
        for (const [, prop] of Object.entries(pp.properties)) {
          if (prop.type === "phone_number" && prop.phone_number) return prop.phone_number
        }
      }
    }
    if (rels.length) {
      const pp = await getPage(rels[0].id.replace(/-/g, ""), token)
      for (const [, prop] of Object.entries(pp.properties)) {
        if (prop.type === "phone_number" && prop.phone_number) return prop.phone_number
      }
    }
  } catch (e) {
    console.warn("[deposit_paid] getPicPhone:", e.message)
  }
  return ""
}

function buildWaUrl(phone, companyName, formUrl) {
  const phoneClean = cleanPhone(phone)
  if (!phoneClean) return ""
  const lines = [
    `Hi ${companyName}! 👋`, "",
    "Your deposit has been received — thank you!", "",
    "To kick off your onboarding, please fill in our Implementation Intake Form:",
    "", `📋 ${formUrl}`, "",
    "Looking forward to building with you!",
    "— Opxio",
  ]
  return `https://wa.me/${phoneClean}?text=${encodeURIComponent(lines.join("\n"))}`
}

async function triggerSetupProject(projectId) {
  try {
    const apiUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://api.opxio.io"
    const r = await fetch(`${apiUrl}/api/setup_project`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ page_id: projectId }),
    })
    if (r.ok) {
      const d = await r.json()
      return [d.phases_created || 0, d.tasks_created || 0]
    }
  } catch (e) {
    console.warn("[deposit_paid] setup_project:", e.message)
  }
  return [0, 0]
}

async function run(payload) {
  const token  = process.env.NOTION_API_KEY
  const rawId  = payload.page_id
    || payload.data?.id           // Notion automation format
    || payload.data?.page_id
    || payload.source?.page_id
    || payload.source?.id
  if (!rawId) throw new Error("No page_id in payload")
  const pageId = rawId.replace(/-/g, "")

  const inv   = await getPage(pageId, token)
  const props = inv.properties

  const invType = props["Invoice Type"]?.select?.name || ""
  const status  = props.Status?.select?.name || ""
  if (invType === "Final Payment") throw new Error("This is a Final Payment invoice")
  if (status === "Deposit Received") throw new Error("Deposit already marked as received")

  const today = new Date().toISOString().split("T")[0]

  await patchPage(pageId, {
    "Status":       { select: { name: "Deposit Received" } },
    "Deposit Paid": { date: { start: today } },
  }, token)

  const companyId   = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
  let   quotationId = props.Quotation?.relation?.[0]?.id?.replace(/-/g, "") || null
  const implIdRaw   = props.Implementation?.relation?.[0]?.id?.replace(/-/g, "") || null
  // Invoice.Deal Source → Deals DB only (not Leads). Start null; set after conversion.
  let   leadId      = null  // will be resolved via Quotation.Lead Source or other fallbacks

  // ── Fallback 1: Check Quotation's "Lead Source" (Quotation → Leads DB) ────
  // NOTE: Quotation has two relation fields:
  //   "Lead Source"  → Leads DB  (set by create_quotation.js)
  //   "Deal Source"  → Deals DB  (set after Lead → Deal conversion)
  if (!leadId && quotationId) {
    try {
      const qp = await getPage(quotationId, token)
      leadId   = qp.properties["Lead Source"]?.relation?.[0]?.id?.replace(/-/g, "")
                 || qp.properties["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "")
                 || null
    } catch {}
  }
  // ── Fallback 2: Query Leads DB for Lead linked to this Quotation ─────────
  // NOTE: Leads DB uses "Quotations" (plural) as the relation field name
  if (!leadId && quotationId) {
    try {
      const rows = await queryDB(DB.LEADS, {
        property: "Quotations", relation: { contains: quotationId }
      }, token)
      if (rows.length) leadId = rows[0].id.replace(/-/g, "")
    } catch {}
  }
  // ── Fallback 3: Check Project's "Deal Source" (for manually-created invoices)
  if (!leadId && implIdRaw) {
    try {
      const pj = await getPage(implIdRaw, token)
      leadId   = pj.properties["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null
    } catch {}
  }

  // ── Fetch Quotation amount (for Deal Value) ──────────────────────────────
  let quotationAmount = props["Total Amount"]?.number || 0  // from Invoice
  if (!quotationAmount && quotationId) {
    try {
      const qp = await getPage(quotationId, token)
      quotationAmount = qp.properties.Amount?.number || 0
    } catch {}
  }

  // ── Detect Lead vs Deal and advance stage / create Deal ─────────────────
  // leadId at this point is resolved from: Quotation.Lead Source → Leads DB
  // OR from: Quotation.Deal Source → Deals DB (existing Deal)
  // • Lead  → mark Lead "Converted", spin up a new Deal at "Building"
  // • Deal  → advance Deal to "Building" directly
  let dealId      = null  // will be set if we create or find a Deal
  let formPackage = ""    // OS package name for onboarding form URL
  let formAddons  = []    // add-on names for onboarding form URL

  if (leadId) {
    try {
      const sourcePage  = await getPage(leadId, token)
      const sourceDbId  = (sourcePage.parent?.database_id || "").replace(/-/g, "")
      const isLead      = sourceDbId === DB.LEADS.replace(/-/g, "")

      if (isLead) {
        // ── New client: Lead → Converted, create Deal at Building ─────────────
        const lp = sourcePage.properties
        const leadName      = plain(lp["Lead Name"]?.title || []) || "New Deal"
        const compIds       = (lp.Company?.relation       || []).map(r => r.id.replace(/-/g, ""))
        const picIds        = (lp["Primary Contact"]?.relation || lp["PIC Name"]?.relation || []).map(r => r.id.replace(/-/g, ""))
        const osInterest    = lp["OS Interest"]?.select?.name || ""
        const addons        = (lp["Add-ons"]?.multi_select || []).map(a => ({ name: a.name }))
        const situation     = plain(lp.Situation?.rich_text || [])
        const notes         = plain(lp.Notes?.rich_text     || [])
        const discoveryCall = lp["Discovery Call"]?.date?.start || null

        // Capture for onboarding form URL
        formPackage = osInterest
        formAddons  = addons.map(a => a.name)

        // ── Check if a Deal was already created (e.g., via "Convert to Deal") ──
        // If so, reuse it instead of creating a duplicate.
        const existingDealId = lp.Deal?.relation?.[0]?.id?.replace(/-/g, "") || null

        if (existingDealId) {
          // Deal already exists — advance its stage to Building and fill missing fields
          dealId = existingDealId
          try {
            const existingDeal = await getPage(existingDealId, token)
            const currentStage = existingDeal.properties.Stage?.status?.name || ""
            const doneStages   = ["Building", "Balance Due", "Delivered"]
            const dealPatches  = {
              ...(!doneStages.includes(currentStage) ? { "Stage": { status: { name: "Building" } } } : {}),
              // Fill Deal Value if not already set
              ...(quotationAmount && !existingDeal.properties["Deal Value"]?.number
                ? { "Deal Value": { number: quotationAmount } } : {}),
              // Link Quotation and Invoice to Deal
              ...(quotationId ? { "Quotation": { relation: [{ id: quotationId }] } } : {}),
              ...(pageId      ? { "Invoices":  { relation: [{ id: pageId }] } } : {}),
            }
            await patchPage(dealId, dealPatches, token)
            // Capture package info from the existing Deal for onboarding form
            if (!formPackage) formPackage = existingDeal.properties["Package Type"]?.select?.name || ""
            if (!formAddons.length) formAddons = (existingDeal.properties["Add-ons"]?.multi_select || []).map(a => a.name)
          } catch (e) {
            console.warn("[deposit_paid] existing deal advance:", e.message)
          }
          console.log(`[deposit_paid] lead has existing deal → advancing to Building: ${dealId}`)

          // Ensure Lead is marked Converted
          const leadStage = lp.Stage?.status?.name || ""
          if (leadStage !== "Converted") {
            await patchPage(leadId, { "Stage": { status: { name: "Converted" } } }, token).catch(() => {})
          }
          // Link Quotation back to Deal on Quotation side
          if (quotationId) {
            await patchPage(quotationId, { "Deal Source": { relation: [{ id: dealId }] } }, token).catch(() => {})
          }
          // Re-point Invoice Deal Source to the Deal
          await patchPage(pageId, { "Deal Source": { relation: [{ id: dealId }] } }, token).catch(() => {})

        } else {
          // No existing Deal — create a new one at Building
          const dealPage = await createPage({
            parent: { database_id: DB.DEALS },
            properties: {
              "Lead Name":   { title: [{ text: { content: leadName } }] },
              "Stage":       { status: { name: "Building" } },
              "Client Type": { select: { name: "New Client" } },
              "Lead Source": { relation: [{ id: leadId }] },
              ...(compIds.length       ? { "Company":       { relation: [{ id: compIds[0] }] } } : {}),
              ...(picIds.length        ? { "Primary Contact": { relation: [{ id: picIds[0] }] } } : {}),
              ...(osInterest           ? { "Package Type":  { select:   { name: osInterest } } } : {}),
              ...(addons.length        ? { "Add-ons":       { multi_select: addons } } : {}),
              ...(quotationAmount      ? { "Deal Value":    { number: quotationAmount } } : {}),
              ...(quotationId          ? { "Quotation":     { relation: [{ id: quotationId }] } } : {}),
              ...(pageId               ? { "Invoices":      { relation: [{ id: pageId }] } } : {}),
              ...(situation            ? { "Situation":     { rich_text: [{ text: { content: situation } }] } } : {}),
              ...(notes                ? { "Notes":         { rich_text: [{ text: { content: notes } }] } } : {}),
              ...(discoveryCall        ? { "Discovery Call":{ date: { start: discoveryCall } } } : {}),
            },
          }, token)
          dealId = dealPage.id.replace(/-/g, "")
          console.log(`[deposit_paid] lead converted → new deal: ${dealId}`)

          // Mark Lead as Converted + link Deal
          await patchPage(leadId, {
            "Stage": { status: { name: "Converted" } },
            "Deal":  { relation: [{ id: dealId }] },
          }, token)

          // Link Quotation's Deal Source → new Deal
          if (quotationId) {
            await patchPage(quotationId, { "Deal Source": { relation: [{ id: dealId }] } }, token).catch(() => {})
          }
          // Re-point Invoice Deal Source to the new Deal
          await patchPage(pageId, { "Deal Source": { relation: [{ id: dealId }] } }, token).catch(() => {})
        }

      } else {
        // ── Existing client: Deal → Building ─────────────────────────────────
        dealId = leadId
        const currentStage = sourcePage.properties.Stage?.status?.name || ""
        const doneStages   = ["Building", "Balance Due", "Delivered"]
        if (!doneStages.includes(currentStage)) {
          await patchPage(dealId, { "Stage": { status: { name: "Building" } } }, token)
          console.log(`[deposit_paid] deal stage → Building: ${dealId}`)
        }

        // Capture for onboarding form URL
        formPackage = sourcePage.properties["Package Type"]?.select?.name || ""
        formAddons  = (sourcePage.properties["Add-ons"]?.multi_select || []).map(a => a.name)
      }
    } catch (e) {
      console.warn("[deposit_paid] stage advance:", e.message)
    }
  }

  // ── Resolve company name EARLY (needed for onboarding form URL) ─────────
  let companyName = ""
  if (companyId) {
    try {
      const cp = await getPage(companyId, token)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }

  // ── Build onboarding form URL and save to Deal BEFORE heavy project work ──
  // This runs early to avoid Vercel timeout (10s Hobby plan) cutting it off.
  // Form lives at /onboarding and uses these params to conditionally show/hide steps:
  //   client=  — company name (pre-fills sidebar label)
  //   package= — OS package e.g. "Business OS", "Revenue OS" (controls which OS steps appear)
  //   addons=  — comma-separated add-on names (controls Add-ons step content)
  //   deal=    — Notion Deal page ID (linked on form submission)
  const baseUrl = "https://widgets.opxio.io"
  const onboardingParams = new URLSearchParams()
  if (companyName)       onboardingParams.set("client",  companyName)
  if (formPackage)       onboardingParams.set("package", formPackage)
  if (formAddons.length) onboardingParams.set("addons",  formAddons.join(","))
  if (dealId)            onboardingParams.set("deal",    dealId)
  const formUrl  = `${baseUrl}/onboarding?${onboardingParams.toString()}`
  const picPhone = companyId ? await getPicPhone(companyId, token) : ""
  const waUrl    = buildWaUrl(picPhone, companyName || "there", formUrl)

  // Save form link + WA message to the Deal page (Onboarding Form & WA Link fields)
  // These fields live on the Deal, not the Invoice — that's where the team manages the client
  if (dealId) {
    const dealPatches = {
      "Onboarding Form": { url: formUrl },
      ...(waUrl ? { "WA Link": { url: waUrl } } : {}),
    }
    await patchPage(dealId, dealPatches, token).catch(e =>
      console.warn("[deposit_paid] deal form link patch:", e.message)
    )
  }

  // ── Project setup (heavy — may take multiple seconds) ─────────────────────
  let projectId = props.Implementation?.relation?.[0]?.id?.replace(/-/g, "") || null
  let phasesCount = 0, tasksCount = 0

  if (!projectId && quotationId) {
    try {
      const rows = await queryDB(DB.PROJECTS, {
        property: "Quotation", relation: { contains: quotationId }
      }, token)
      if (rows.length) projectId = rows[0].id.replace(/-/g, "")
    } catch {}
  }

  if (projectId) {
    await patchPage(projectId, {
      "Status":     { select: { name: "Build Started" } },
      "Start Date": { date: { start: today } },
      // If we created a new Deal (from Lead conversion), link it to the Project
      ...(dealId && dealId !== leadId ? { "Deals": { relation: [{ id: dealId }] } } : {}),
    }, token)
    try {
      await patchPage(pageId, { "Implementation": { relation: [{ id: projectId }] } }, token)
    } catch {}
    ;[phasesCount, tasksCount] = await triggerSetupProject(projectId)
  }

  // ── Finance Ledger — auto-create Deposit entry ───────────────────────────
  const depositAmt = props["Deposit (50%)"]?.number || props["Amount"]?.number || 0
  createLedgerEntry({
    title:     companyName ? `Deposit — ${companyName}` : "Client Deposit",
    amount:    depositAmt,
    category:  "Client Deposit",
    source:    "Client Payment",
    payment:   "Bank Transfer",
    status:    "Received",
    date:      today,
    invoiceId: pageId,
    projectId: projectId || null,
    notes:     "Auto-created when deposit marked received",
  }, token).catch(() => {})

  return {
    status:         "success",
    invoice_id:     pageId,
    lead_id:        leadId,
    deal_id:        dealId,
    project_id:     projectId,
    company_id:     companyId,
    form_url:       formUrl,
    wa_url:         waUrl || null,
    form_package:   formPackage,
    form_addons:    formAddons,
    phases_created: phasesCount,
    tasks_created:  tasksCount,
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Deposit Paid", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })
  try {
    const result = await run(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[deposit_paid]", e)
    return res.status(500).json({ error: e.message })
  }
}


