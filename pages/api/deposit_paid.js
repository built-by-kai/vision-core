// ─── deposit_paid.js ───────────────────────────────────────────────────────
// POST /api/deposit_paid   { "page_id": "<invoice_page_id>" }
// Triggered by Notion button "Mark Deposit Paid" on Invoice page.

import { getPage, patchPage, queryDB, plain, DB, createLedgerEntry } from "../../lib/notion"

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
    const cp   = await getPage(companyId, token)
    const rels = cp.properties.People?.relation || cp.properties.Clients?.relation || []
    for (const rel of rels) {
      const pp = await getPage(rel.id.replace(/-/g, ""), token)
      if (pp.properties["Current PIC?"]?.checkbox) {
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
      : "https://dashboard.opxio.io"
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

async function process(payload) {
  const token  = process.env.NOTION_API_KEY
  const rawId  = payload.page_id || payload.source?.page_id || payload.data?.page_id
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
  let   leadId      = props["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null

  if (!leadId && quotationId) {
    try {
      const qp = await getPage(quotationId, token)
      leadId   = qp.properties["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null
    } catch {}
  }
  if (!leadId && quotationId) {
    try {
      const rows = await queryDB(DB.LEADS, {
        property: "Quotation", relation: { contains: quotationId }
      }, token)
      if (rows.length) leadId = rows[0].id.replace(/-/g, "")
    } catch {}
  }

  if (leadId) {
    try {
      const lp = await getPage(leadId, token)
      const currentStage = lp.properties.Stage?.status?.name || ""
      const doneStages   = ["Building", "Balance Due", "Delivered", "Active", "Closed – Paid"]
      if (!doneStages.includes(currentStage)) {
        await patchPage(leadId, { "Stage": { status: { name: "Building" } } }, token)
      }
    } catch {}
  }

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
    }, token)
    try {
      await patchPage(pageId, { "Implementation": { relation: [{ id: projectId }] } }, token)
    } catch {}
    ;[phasesCount, tasksCount] = await triggerSetupProject(projectId)
  }

  let pkgSlug = "full-agency-os"
  if (projectId) {
    try {
      const pp    = await getPage(projectId, token)
      const pkgRaw = (pp.properties.Package?.select?.name || "").toLowerCase()
      for (const [key, slug] of Object.entries(QUOTE_TYPE_TO_SLUG)) {
        if (pkgRaw.includes(key)) { pkgSlug = slug; break }
      }
    } catch {}
  }

  let companyName = ""
  if (companyId) {
    try {
      const cp = await getPage(companyId, token)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }

  const implFormBase = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/implementation_form`
    : "https://dashboard.opxio.io/api/implementation_form"
  const formUrl  = `${implFormBase}?c=${companyId || ""}&pkg=${pkgSlug}`
  const picPhone = companyId ? await getPicPhone(companyId, token) : ""
  const waUrl    = buildWaUrl(picPhone, companyName || "there", formUrl)

  if (waUrl) {
    try { await patchPage(pageId, { "WA Link": { url: waUrl } }, token) } catch {}
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
