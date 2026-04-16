// /api/data/finance — token-authenticated
// Resolves client by access_token → uses their Notion key + DB IDs
// Called by widgets: revenue.html, earnings.html, monthly.html, topproducts.html

import { queryDB, plain, getProp, DB } from "../../../lib/notion"
import { getClientByToken, getNotionToken, resolveDB, resolveField } from "../../../lib/supabase"

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })

    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })

    const notionToken  = getNotionToken(client)
    const QUOTATIONS_DB    = resolveDB(client, "QUOTATIONS", DB.QUOTATIONS)
    const INVOICE_DB       = resolveDB(client, "INVOICE",    DB.INVOICE)
    const PROPOSALS_DB     = resolveDB(client, "PROPOSALS",  DB.PROPOSALS)
    const statusField      = resolveField(client, "STATUS_FIELD",       "Status")
    const packageField     = resolveField(client, "PACKAGE_FIELD",      "Package Type")
    const invoiceTypeField = resolveField(client, "INVOICE_TYPE_FIELD", "Invoice Type")

    const now   = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth()

    // ── Fetch ────────────────────────────────────────────────────────────────
    const [quotes, invoices, proposals] = await Promise.all([
      queryDB(QUOTATIONS_DB, null, notionToken),
      queryDB(INVOICE_DB,    null, notionToken),
      queryDB(PROPOSALS_DB,  null, notionToken).catch(() => []),
    ])

    // ── Quotations by status ─────────────────────────────────────────────────
    const qStatus  = { Draft: 0, Issued: 0, Approved: 0, Rejected: 0 }

    for (const q of quotes) {
      const p = q.properties
      const s = p[statusField]?.status?.name || p[statusField]?.select?.name || ""
      if (s in qStatus) qStatus[s]++
    }

    // ── Top products from Proposals (has OS Type) + Quotation fallback ────────
    const pkgCount = {}
    const osTypeField = resolveField(client, "OS_TYPE_FIELD", "OS Type")

    // Primary: count from proposals (Accepted, Quotation Issued, etc.)
    for (const pr of proposals) {
      const s = getProp(pr, statusField) || ""
      // Count proposals that converted (Accepted, Quotation Issued, or any non-Draft/Rejected)
      if (s === "Accepted" || s === "Quotation Issued" || s === "Won") {
        const raw = getProp(pr, osTypeField) || getProp(pr, packageField) || ""
        const pkg = normalisePkg(String(raw))
        if (pkg) pkgCount[pkg] = (pkgCount[pkg] || 0) + 1
      }
    }

    // Fallback: if quotations DB has Package Type, count Approved quotes too
    for (const q of quotes) {
      const s = getProp(q, statusField) || ""
      if (s === "Approved") {
        const raw = getProp(q, packageField) || getProp(q, osTypeField) || ""
        const pkg = normalisePkg(String(raw))
        if (pkg) pkgCount[pkg] = (pkgCount[pkg] || 0) + 1
      }
    }

    // ── Invoices ─────────────────────────────────────────────────────────────
    let depositPendingAmt = 0, depositPendingCount = 0
    let balancePendingAmt = 0, balancePendingCount = 0
    let paidAmt = 0, paidCount = 0

    const monthlyPaid = {}
    for (let i = 2; i >= 0; i--) {
      const d   = new Date(year, month - i, 1)
      const key = d.toLocaleString("default", { month: "short", year: "2-digit" })
      monthlyPaid[key] = 0
    }

    let thisMonthRev = 0, thisMonthOrders = 0, thisMonthInstalls = 0
    let lastMonthRev = 0, lastMonthInstalls = 0, wonThisMonth = 0, wonLastMonth = 0

    for (const inv of invoices) {
      const p   = inv.properties
      const s   = p[statusField]?.select?.name || ""
      const amt = p["Total Amount"]?.number || 0
      const typ = p[invoiceTypeField]?.select?.name || ""
      const d   = new Date(inv.created_time)
      const cm  = d.getMonth(), cy = d.getFullYear()
      const lm  = month === 0 ? 11 : month - 1
      const ly  = month === 0 ? year - 1 : year

      if (typ === "Deposit" && (s === "Pending" || s === "Sent")) {
        depositPendingAmt += amt; depositPendingCount++
      }
      if ((typ === "Final Payment" || typ === "Full Payment") && (s === "Pending" || s === "Sent")) {
        balancePendingAmt += amt; balancePendingCount++
      }
      if (s === "Paid" || s === "Deposit Received") {
        paidAmt += amt; paidCount++
        const mKey = d.toLocaleString("default", { month: "short", year: "2-digit" })
        if (mKey in monthlyPaid) monthlyPaid[mKey] += amt
        if (cm === month && cy === year) { thisMonthRev += amt; thisMonthOrders++ }
        if (cm === lm    && cy === ly)   { lastMonthRev += amt }
        if ((typ === "Deposit" || typ === "Full Payment")) {
          if (cm === month && cy === year) { thisMonthInstalls++; wonThisMonth++ }
          if (cm === lm    && cy === ly)   { lastMonthInstalls++; wonLastMonth++ }
        }
      }
    }

    const totalApproved = Object.values(pkgCount).reduce((s, v) => s + v, 0) || 1
    const topProducts   = Object.entries(pkgCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({
        name, sub: pkgSubtitle(name), cat: pkgCategory(name), count,
        pct: Math.round((count / totalApproved) * 100),
        barPct: 0, // set below after normalization
      }))
    // Normalize bar widths so the top product = 100%
    if (topProducts.length > 0) {
      const maxPct = topProducts[0].pct || 1
      topProducts.forEach(p => { p.barPct = Math.round((p.pct / maxPct) * 100) })
    }

    // ── Proposals CRM by status ───────────────────────────────────────────────
    const propStatus = { Draft: 0, Sent: 0, Accepted: 0, Rejected: 0 }
    let propTotal = 0, propValue = 0
    for (const pr of proposals) {
      const p = pr.properties
      const s = p[statusField]?.select?.name || ""
      propTotal++
      const fee = p.Fee?.number || 0
      propValue += fee
      if (s === "Draft" || s === "Send Proposal") propStatus.Draft++
      else if (s === "Sent") propStatus.Sent++
      else if (s === "Accepted") propStatus.Accepted++
      else if (s === "Rejected") propStatus.Rejected++
    }

    res.status(200).json({
      quotations: qStatus,
      proposals: { ...propStatus, total: propTotal, pipelineValue: propValue },
      invoices: {
        depositPending: { count: depositPendingCount, total: depositPendingAmt },
        balancePending: { count: balancePendingCount, total: balancePendingAmt },
        paid:           { count: paidCount,           total: paidAmt },
      },
      monthly:    Object.entries(monthlyPaid).map(([m, v]) => ({ m, v })),
      thisMonth:  {
        revenue: thisMonthRev, orders: thisMonthOrders,
        installs: thisMonthInstalls, wonClients: wonThisMonth,
        prevRevenue: lastMonthRev, prevInstalls: lastMonthInstalls, prevWon: wonLastMonth,
      },
      topProducts,
    })
  } catch (err) {
    console.error("finance:", err)
    res.status(500).json({ error: err.message })
  }
}

// ── Product catalogue mapping ────────────────────────────────────────────────

// Normalise raw "Package Type" values from Notion into known product names.
// Returns null for values that should be excluded (empty, garbage, unknown).
function normalisePkg(raw) {
  if (!raw || !raw.trim()) return null
  const t = raw.trim()

  // Direct match first
  if (PRODUCT_CATALOGUE[t]) return t

  // Case-insensitive / partial match
  const lower = t.toLowerCase()
  for (const key of Object.keys(PRODUCT_CATALOGUE)) {
    if (key.toLowerCase() === lower) return key
  }

  // Common aliases — old names, shorthand, and Notion slug variants
  const aliases = {
    // OS aliases
    "sales os":              "Revenue OS",
    "full os":               "Business OS (Revenue OS + Operations OS)",
    "business os":           "Business OS (Revenue OS + Operations OS)",
    "ops os":                "Operations OS",
    "content os":            "Marketing OS",
    "team os":               "Team OS",
    "retention os":          "Retention OS",
    "agency os":             "Agency OS (Business OS + Marketing OS)",
    "intelligence os":       "Intelligence OS",
    "micro install":         "Micro Install — 1 Module",
    "starter os":            "Micro Install — 1 Module",
    "micro":                 "Micro Install — 1 Module",
    "micro 1":               "Micro Install — 1 Module",
    "micro 2":               "Micro Install — 2 Modules",
    "micro 3":               "Micro Install — 3 Modules",
    // Widgets
    "dashboard":             "Enhanced Dashboard",
    "custom widget":         "Custom Widget",
    "performance dashboard": "Performance Dashboard Database",
    // Kickoff automations (old names)
    "project kickoff":           "Project Kickoff Automation",
    "campaign kickoff":          "Campaign Kickoff Automation",
    "client onboarding kickoff": "Client Onboarding Kickoff",
    "renewal kickoff":           "Renewal Kickoff Automation",
    "hiring kickoff":            "Hiring Kickoff Automation",
    // Add-ons (old names)
    "document generation":    "Document Generation Suite",
    "doc gen":                "Document Generation Suite",
    "lead capture":           "Lead Capture System",
    "module expansion":       "Additional System Module",
    "additional module":      "Additional System Module",
    "client portal":          "Client Portal View",
    "ads platform":           "Ads Platform Integration",
    "ai agent":               "AI Agent Integration",
    "api integration":        "API / External Integration",
    "workflow integration":   "Automation & Workflow Integration (Make/N8N)",
    "make automation":        "Automation & Workflow Integration (Make/N8N)",
    "n8n automation":         "Automation & Workflow Integration (Make/N8N)",
    "automation within":      "Automation — Within Database",
    "automation cross":       "Automation — Cross-Database",
  }
  if (aliases[lower]) return aliases[lower]

  return null // skip unknown values — don't show "Other"
}

const PRODUCT_CATALOGUE = {
  // ── OS Packages (Layer 1) ──────────────────────────────────────────────────
  "Revenue OS":                            { sub: "Lead to cash — full cycle",        cat: "os" },
  "Operations OS":                         { sub: "Workflow & delivery",              cat: "os" },
  "Business OS (Revenue OS + Operations OS)": { sub: "Revenue + Operations",         cat: "os" },
  "Marketing OS":                          { sub: "Campaigns, content & ads",        cat: "os" },
  "Agency OS (Business OS + Marketing OS)":   { sub: "Revenue + Ops + Marketing",    cat: "os" },
  "Team OS":                               { sub: "Hiring, onboarding & performance", cat: "os" },
  "Retention OS":                          { sub: "Client health & renewals",         cat: "os" },
  "Intelligence OS":                       { sub: "Prospect & market intelligence",   cat: "os" },
  "Micro Install — 1 Module":              { sub: "Base OS + 1 module",               cat: "os" },
  "Micro Install — 2 Modules":             { sub: "Base OS + 2 modules",              cat: "os" },
  "Micro Install — 3 Modules":             { sub: "Base OS + 3 modules",              cat: "os" },

  // ── Dashboard Widgets (Layer 2) ───────────────────────────────────────────
  "Enhanced Dashboard":            { sub: "Charts, trends & KPI cards",    cat: "widgets" },
  "Custom Widget":                 { sub: "Bespoke embeddable widget",      cat: "widgets" },
  "Performance Dashboard Database":{ sub: "Intelligence KPI infrastructure", cat: "widgets" },

  // ── Kickoff Automations ───────────────────────────────────────────────────
  "Project Kickoff Automation":    { sub: "Deal won → project auto-created",      cat: "automations" },
  "Campaign Kickoff Automation":   { sub: "Campaign active → tasks auto-created", cat: "automations" },
  "Client Onboarding Kickoff":     { sub: "New client → onboarding triggered",    cat: "automations" },
  "Renewal Kickoff Automation":    { sub: "Contract expiry → renewal tasks",       cat: "automations" },
  "Hiring Kickoff Automation":     { sub: "Role open → hiring tasks created",      cat: "automations" },

  // ── Integrations & Automation Add-Ons ────────────────────────────────────
  "Automation — Within Database":          { sub: "Single-DB trigger & action",    cat: "automations" },
  "Automation — Cross-Database":           { sub: "Multi-DB workflow automation",  cat: "automations" },
  "Automation & Workflow Integration (Make/N8N)": { sub: "External workflow via Make or N8N", cat: "automations" },
  "API / External Integration":            { sub: "REST API connection to any platform", cat: "automations" },
  "Ads Platform Integration":              { sub: "Meta / Google / TikTok Ads sync", cat: "automations" },
  "Lead Capture System":                   { sub: "Form or WhatsApp → CRM pipeline", cat: "automations" },
  "Document Generation Suite":             { sub: "Automated PDF quotes & invoices", cat: "automations" },
  "AI Agent Integration":                  { sub: "AI agent connected to Notion",    cat: "automations" },

  // ── Module Add-Ons ────────────────────────────────────────────────────────
  "Additional System Module":      { sub: "Extra database module",          cat: "os" },
  "Client Portal View":            { sub: "Client-facing read-only portal", cat: "os" },
}

function pkgSubtitle(name) {
  return PRODUCT_CATALOGUE[name]?.sub || "Custom install"
}

function pkgCategory(name) {
  return PRODUCT_CATALOGUE[name]?.cat || "os"
}
// cache bust Thu Apr 16 2026 v2
