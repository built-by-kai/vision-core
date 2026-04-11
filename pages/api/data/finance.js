// /api/data/finance
// Returns aggregated finance data from Quotations + Invoice DBs
// Called by widgets: revenue.html, earnings.html, monthly.html, topproducts.html

import { queryDB, plain, DB } from "../../../lib/notion"

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  try {
    const token = process.env.NOTION_API_KEY
    const now   = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth() // 0-indexed

    // ── Fetch all quotations ──────────────────────────────────────────────
    const quotes = await queryDB(DB.QUOTATIONS, null, token)

    const qStatus = { Draft: 0, Issued: 0, Approved: 0, Rejected: 0 }
    const pkgCount = {}

    for (const q of quotes) {
      const p = q.properties
      // Status is a Notion "status" type
      const s = p.Status?.status?.name || p.Status?.select?.name || ""
      if (s in qStatus) qStatus[s]++
      // Package type for top products
      if (s === "Approved") {
        const pkg = plain(p["Package Type"]) || "Unknown"
        pkgCount[pkg] = (pkgCount[pkg] || 0) + 1
      }
    }

    // ── Fetch all invoices ────────────────────────────────────────────────
    const invoices = await queryDB(DB.INVOICE, null, token)

    let depositPendingAmt = 0, depositPendingCount = 0
    let balancePendingAmt = 0, balancePendingCount = 0
    let paidAmt = 0, paidCount = 0

    // Monthly paid totals — last 3 months
    const monthlyPaid = {}
    for (let i = 2; i >= 0; i--) {
      const d = new Date(year, month - i, 1)
      const key = d.toLocaleString("default", { month: "short", year: "2-digit" })
      monthlyPaid[key] = 0
    }

    // This month stats
    let thisMonthRev = 0, thisMonthOrders = 0, thisMonthInstalls = 0, lastMonthRev = 0, lastMonthInstalls = 0

    for (const inv of invoices) {
      const p   = inv.properties
      const s   = p.Status?.select?.name || ""
      const amt = p["Total Amount"]?.number || 0
      const typ = p["Invoice Type"]?.select?.name || ""
      const createdStr = inv.created_time || ""
      const created = new Date(createdStr)
      const cm = created.getMonth(), cy = created.getFullYear()

      // Deposit pending: type=Deposit, status=Pending
      if (typ === "Deposit" && (s === "Pending" || s === "Sent")) {
        depositPendingAmt += amt; depositPendingCount++
      }
      // Balance pending: type=Final Payment or Full Payment, status=Pending
      if ((typ === "Final Payment" || typ === "Full Payment") && (s === "Pending" || s === "Sent")) {
        balancePendingAmt += amt; balancePendingCount++
      }
      // Paid
      if (s === "Paid" || s === "Deposit Received") {
        paidAmt += amt; paidCount++

        // Monthly breakdown
        const mKey = created.toLocaleString("default", { month: "short", year: "2-digit" })
        if (mKey in monthlyPaid) monthlyPaid[mKey] += amt

        // This month
        if (cm === month && cy === year) {
          thisMonthRev += amt
          thisMonthOrders++
          if (typ === "Deposit" || typ === "Full Payment") thisMonthInstalls++
        }
        // Last month
        const lastM = month === 0 ? 11 : month - 1
        const lastY = month === 0 ? year - 1 : year
        if (cm === lastM && cy === lastY) {
          lastMonthRev += amt
          if (typ === "Deposit" || typ === "Full Payment") lastMonthInstalls++
        }
      }
    }

    // ── Top products ──────────────────────────────────────────────────────
    const totalApproved = Object.values(pkgCount).reduce((s, v) => s + v, 0) || 1
    const topProducts = Object.entries(pkgCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => ({
        name,
        sub: pkgSubtitle(name),
        count,
        pct: Math.round((count / totalApproved) * 100),
      }))

    // ── Monthly array ─────────────────────────────────────────────────────
    const monthlyArr = Object.entries(monthlyPaid).map(([m, amt]) => ({ m, v: amt }))

    // ── Won clients this month (Deposit invoices paid this month) ─────────
    const wonThisMonth = invoices.filter(inv => {
      const p = inv.properties
      const typ = p["Invoice Type"]?.select?.name || ""
      const s   = p.Status?.select?.name || ""
      const d   = new Date(inv.created_time)
      return (typ === "Deposit" || typ === "Full Payment") &&
             (s === "Paid" || s === "Deposit Received") &&
             d.getMonth() === month && d.getFullYear() === year
    }).length

    const wonLastMonth = invoices.filter(inv => {
      const p   = inv.properties
      const typ = p["Invoice Type"]?.select?.name || ""
      const s   = p.Status?.select?.name || ""
      const d   = new Date(inv.created_time)
      const lm  = month === 0 ? 11 : month - 1
      const ly  = month === 0 ? year - 1 : year
      return (typ === "Deposit" || typ === "Full Payment") &&
             (s === "Paid" || s === "Deposit Received") &&
             d.getMonth() === lm && d.getFullYear() === ly
    }).length

    res.status(200).json({
      quotations: qStatus,
      invoices: {
        depositPending: { count: depositPendingCount, total: depositPendingAmt },
        balancePending: { count: balancePendingCount, total: balancePendingAmt },
        paid:           { count: paidCount,           total: paidAmt },
      },
      monthly: monthlyArr,
      thisMonth: {
        revenue:    thisMonthRev,
        orders:     thisMonthOrders,
        installs:   thisMonthInstalls,
        wonClients: wonThisMonth,
        prevRevenue:  lastMonthRev,
        prevInstalls: lastMonthInstalls,
        prevWon:      wonLastMonth,
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
    "Business OS":    "Operations + Sales",
    "Operations OS":  "Full ops system",
    "Sales OS":       "Revenue pipeline",
    "Starter OS":     "Entry package",
    "Marketing OS":   "Campaigns & content",
    "Intelligence OS":"Prospect intelligence",
  }
  return map[name] || "Add-on / Custom"
}
