// ─── deposit_paid.js ───────────────────────────────────────────────────────
// POST /api/deposit_paid   { "page_id": "<invoice_page_id>" }
// Triggered by Notion button "Mark Deposit Paid" on Invoice page.
//
// 1. Validates invoice type is not Final Payment
// 2. Invoice Status → Deposit Received, Deposit Paid → today
// 3. Project Status → Build Started, Start Date → today
// 4. Lead Stage → Building
// 5. Triggers setup_project for phases/tasks generation
// 6. Builds WA onboarding message + writes to Invoice.WA Link

import { getPage, patchPage, queryDB, plain, DB } from "../../lib/notion"

const TOKEN   = process.env.NOTION_API_KEY
const API_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://opxio.vercel.app"

const IMPL_FORM_BASE = `${API_URL}/api/implementation_form`

const QUOTE_TYPE_TO_SLUG = {
  "full agency os":  "full-agency-os",
  "business os":     "full-agency-os",
  "workflow os":     "workflow-os",
  "operations os":   "workflow-os",
  "sales os":        "sales-crm",
  "sales crm":       "sales-crm",
  "revenue os":      "revenue-os",
  "modular os":      "modular-os",
  "starter os":      "modular-os",
  "complete os":     "complete-os",
  "custom os":       "custom-os",
}

function cleanPhone(phone = "") {
  const digits = phone.replace(/\D/g, "")
  return digits.startsWith("0") ? "6" + digits : digits
}

async function getPicPhone(companyId, token) {
  try {
    const cp = await getPage(companyId, token)
    const rels = (cp.properties.People?.relation || cp.properties.Clients?.relation || [])
    for (const rel of rels) {
      const pp = await getPage(rel.id.replace(/-/g, ""), token)
      if (pp.properties["Current PIC?"]?.checkbox) {
        for (const [, prop] of Object.entries(pp.properties)) {
          if (prop.type === "phone_number" && prop.phone_number) return prop.phone_number
        }
      }
    }
    // fallback: first person
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

function buildFormUrl(companyId, pkgSlug) {
  return `${IMPL_FORM_BASE}?c=${companyId}&pkg=${pkgSlug}`
}

function buildWaUrl(phone, companyName, formUrl) {
  const phoneClean = cleanPhone(phone)
  if (!phoneClean) return ""
  const lines = [
    `Hi ${companyName}! 👋`, "",
    "Your deposit has been received — thank you!", "",
    "To kick off your onboarding, please fill in our Implementation Intake Form so we can tailor your system to your team:",
    "", `📋 ${formUrl}`, "",
    "This should take about 10–15 minutes. The more detail you provide, the faster we can build.", "",
    "Looking forward to building with you!",
    "— Opxio",
  ]
  return `https://wa.me/${phoneClean}?text=${encodeURIComponent(lines.join("\n"))}`
}

async function triggerSetupProject(projectId) {
  try {
    const r = await fetch(`${API_URL}/api/setup_project`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ page_id: projectId }),
    })
    if (r.ok) {
      const d = await r.json()
      return [d.phases_created || 0, d.tasks_created || 0]
    }
    console.warn("[deposit_paid] setup_project:", r.status)
  } catch (e) {
    console.warn("[deposit_paid] setup_project:", e.message)
  }
  return [0, 0]
}

async function process(payload) {
  const rawId = payload.page_id || payload.source?.page_id || payload.data?.page_id
  if (!rawId) throw new Error("No page_id in payload")
  const pageId = rawId.replace(/-/g, "")

  const inv   = await getPage(pageId, TOKEN)
  const props = inv.properties

  const invType = props["Invoice Type"]?.select?.name || ""
  const status  = props.Status?.select?.name || ""
  if (invType === "Final Payment") throw new Error("This is a Final Payment invoice")
  if (status === "Deposit Received") throw new Error("Deposit already marked as received")

  const today = new Date().toISOString().split("T")[0]

  // 1. Update Invoice
  await patchPage(pageId, {
    "Status":       { select: { name: "Deposit Received" } },
    "Deposit Paid": { date: { start: today } },
  }, TOKEN)

  // 2. Gather linked IDs
  const companyId    = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
  let   quotationId  = props.Quotation?.relation?.[0]?.id?.replace(/-/g, "") || null
  let   leadId       = props["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null

  // Try lead via Quotation → Deal Source
  if (!leadId && quotationId) {
    try {
      const qp = await getPage(quotationId, TOKEN)
      leadId = qp.properties["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null
    } catch {}
  }

  // Try lead via DB query on Quotation relation
  if (!leadId && quotationId) {
    try {
      const rows = await queryDB(DB.LEADS, {
        property: "Quotation", relation: { contains: quotationId }
      }, TOKEN)
      if (rows.length) leadId = rows[0].id.replace(/-/g, "")
    } catch {}
  }

  // 3. Advance Lead → Building
  if (leadId) {
    const lp = await getPage(leadId, TOKEN)
    const currentStage = lp.properties.Stage?.status?.name || ""
    const doneStages = ["Building", "Balance Due", "Delivered", "Active", "Closed – Paid"]
    if (!doneStages.includes(currentStage)) {
      await patchPage(leadId, { "Stage": { status: { name: "Building" } } }, TOKEN)
    }
  }

  // 4. Update Project → Build Started
  let projectId    = props.Implementation?.relation?.[0]?.id?.replace(/-/g, "") || null
  let phasesCount  = 0, tasksCount = 0

  if (!projectId && quotationId) {
    try {
      const rows = await queryDB(DB.PROJECTS, {
        property: "Quotation", relation: { contains: quotationId }
      }, TOKEN)
      if (rows.length) projectId = rows[0].id.replace(/-/g, "")
    } catch {}
  }

  if (projectId) {
    await patchPage(projectId, {
      "Status":     { select: { name: "Build Started" } },
      "Start Date": { date: { start: today } },
    }, TOKEN)
    await patchPage(pageId, {
      "Implementation": { relation: [{ id: projectId }] }
    }, TOKEN)

    ;[phasesCount, tasksCount] = await triggerSetupProject(projectId)
  }

  // 5. Package slug for form URL
  let pkgSlug = "full-agency-os"
  if (projectId) {
    try {
      const pp = await getPage(projectId, TOKEN)
      const pkgRaw = (pp.properties.Package?.select?.name || "").toLowerCase()
      for (const [key, slug] of Object.entries(QUOTE_TYPE_TO_SLUG)) {
        if (pkgRaw.includes(key)) { pkgSlug = slug; break }
      }
    } catch {}
  }

  // 6. Build WA onboarding message
  let companyName = ""
  if (companyId) {
    try {
      const cp = await getPage(companyId, TOKEN)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }

  const formUrl  = buildFormUrl(companyId || "", pkgSlug)
  const picPhone = companyId ? await getPicPhone(companyId, TOKEN) : ""
  const waUrl    = buildWaUrl(picPhone, companyName || "there", formUrl)

  if (waUrl) {
    await patchPage(pageId, { "WA Link": { url: waUrl } }, TOKEN)
  }

  return {
    status:         "success",
    invoice_id:     pageId,
    lead_id:        leadId,
    project_id:     projectId,
    company_id:     companyId,
    form_url:       formUrl,
    wa_url:         waUrl || null,
    pkg_slug:       pkgSlug,
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
    const result = await process(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[deposit_paid]", e)
    return res.status(500).json({ error: e.message })
  }
}
