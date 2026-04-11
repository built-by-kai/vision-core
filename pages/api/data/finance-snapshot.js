// /api/data/finance-snapshot — token-authenticated
// Widget 3 — Finance Snapshot (v5 spec)
// KPIs: income this month, expenses this month, net P&L this month
// Charts: expense breakdown by category (donut), 6-month net P&L trend (single line)

import { queryDB, DB } from "../../../lib/notion"
import { getClientByToken, getNotionToken, resolveDB } from "../../../lib/supabase"

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  try {
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })

    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })

    const notionToken = getNotionToken(client)
    const FINANCE_DB  = resolveDB(client, "FINANCE", DB.FINANCE)

    const now   = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth() // 0-indexed

    const entries = await queryDB(FINANCE_DB, null, notionToken)

    // Build 6-month bucket keys
    const monthlyPL = {}
    for (let i = 5; i >= 0; i--) {
      const d   = new Date(year, month - i, 1)
      const key = d.toLocaleString("default", { month: "short", year: "2-digit" })
      monthlyPL[key] = { income: 0, expense: 0 }
    }

    let thisMonthIncome   = 0
    let thisMonthExpenses = 0
    const categoryMap     = {}

    for (const entry of entries) {
      const p      = entry.properties
      const type   = p.Type?.select?.name || ""
      const status = p.Status?.select?.name || ""
      const amount = p["Amount (RM)"]?.number || 0
      const cat    = p.Category?.select?.name || "Uncategorised"

      if (status === "Cancelled") continue

      const rawDate  = p.Date?.date?.start || entry.created_time
      const date     = rawDate ? new Date(rawDate) : new Date()
      const isThisMo = date.getMonth() === month && date.getFullYear() === year
      const mKey     = date.toLocaleString("default", { month: "short", year: "2-digit" })

      if (type === "Income") {
        if (isThisMo) thisMonthIncome += amount
        if (mKey in monthlyPL) monthlyPL[mKey].income += amount
      } else if (type === "Expense") {
        if (isThisMo) thisMonthExpenses += amount
        if (mKey in monthlyPL) monthlyPL[mKey].expense += amount
        // Category breakdown: all-time expenses for the donut
        categoryMap[cat] = (categoryMap[cat] || 0) + amount
      }
    }

    const totalExpCat = Object.values(categoryMap).reduce((s, v) => s + v, 0) || 1
    const categoryBreakdown = Object.entries(categoryMap)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amount]) => ({
        cat,
        amount,
        pct: Math.round((amount / totalExpCat) * 100),
      }))

    // Single net P&L per month for the line chart
    const monthlyTrend = Object.entries(monthlyPL).map(([m, v]) => ({
      m,
      pl: v.income - v.expense,
    }))

    res.status(200).json({
      kpi: {
        thisMonthIncome,
        thisMonthExpenses,
        thisMonthPL: thisMonthIncome - thisMonthExpenses,
      },
      categoryBreakdown,
      monthlyTrend,
    })
  } catch (err) {
    console.error("finance-snapshot:", err)
    res.status(500).json({ error: err.message })
  }
}
