// /api/data/finance — token-authenticated
// Resolves client by access_token → uses their Notion key + DB IDs
// Called by widgets: revenue.html, earnings.html, monthly.html, topproducts.html

import { queryDB, plain, DB } from "../../../lib/notion"
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
    const pkgCount = {}

    for (const q of quotes) {
      const p = q.properties
      const s = p[statusField]?.status?.name || p[statusField]?.select?.name || ""
      if (s in qStatus) qStatus[s]++
      if (s === "Approved") {
        const pkg = plain(p[packageField]) || "Other"
        pkgCount[pkg] = (pkgCount[pkg] || 0) + 1
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
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([name, count]) => ({
        name, sub: pkgSubtitle(name), count,
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

function pkgSubtitle(name) {
  const map = {
    "Business OS":    "Revenue + Operations",
    "Agency OS":      "Revenue + Operations + Marketing",
    "Revenue OS":     "Pipeline & revenue",
    "Operations OS":  "Workflow & delivery",
    "Marketing OS":   "Campaigns & content",
    "Team OS":        "People & performance",
    "Retention OS":   "Health & renewals",
    "Intelligence OS":"Prospect intelligence",
    "Micro Install":  "Entry point · 1–3 modules",
    "Micro Install — 1 Module": "Entry point",
    "Micro Install — 2 Modules": "Entry point",
    "Micro Install — 3 Modules": "Entry point",
  }
  return map[name] || "Custom install"
}
// cache bust Sat Apr 11 12:34:03 +08 2026
