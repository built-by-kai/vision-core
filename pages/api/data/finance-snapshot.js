// /api/data/finance-snapshot — token-authenticated
// Queries Finance & Expense Tracker DB
// Returns: Income/Expenses/P&L KPIs, category breakdown, 6-month trend

import { queryDB, plain, DB } from "../../../lib/notion"
import { getClientByToken, getNotionToken, resolveDB } from "../../../lib/supabase"

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })

    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })

    const notionToken = getNotionToken(client)
    const FINANCE_DB  = resolveDB(client, "FINANCE", DB.FINANCE)

    const now   = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth() // 0-indexed

    // ── Fetch all entries ──────────────────────────────────────────────────────
    const entries = await queryDB(FINANCE_DB, null, notionToken)

    // ── Aggregation helpers ────────────────────────────────────────────────────
    let totalIncome   = 0
    let totalExpenses = 0
    const categoryMap = {}
    const monthlyMap  = {}

    // Build 6-month keys
    for (let i = 5; i >= 0; i--) {
      const d   = new Date(year, month - i, 1)
      const key = d.toLocaleString("default", { month: "short", year: "2-digit" })
      monthlyMap[key] = { income: 0, expense: 0 }
    }

    for (const entry of entries) {
      const p      = entry.properties
      const type   = p.Type?.select?.name || ""
      const status = p.Status?.select?.name || ""
      const amount = p["Amount (RM)"]?.number || 0
      const cat    = p.Category?.select?.name || "Uncategorised"

      // Skip cancelled entries
      if (status === "Cancelled") continue

      // Date: prefer Date property, fall back to created_time
      const rawDate = p.Date?.date?.start || entry.created_time
      const date    = rawDate ? new Date(rawDate) : new Date()
      const mKey    = date.toLocaleString("default", { month: "short", year: "2-digit" })

      if (type === "Income") {
        totalIncome += amount
        if (mKey in monthlyMap) monthlyMap[mKey].income += amount
      } else if (type === "Expense") {
        totalExpenses += amount
        if (mKey in monthlyMap) monthlyMap[mKey].expense += amount
        categoryMap[cat] = (categoryMap[cat] || 0) + amount
      }
      // Transfer: excluded from P&L
    }

    // ── Category breakdown ─────────────────────────────────────────────────────
    const totalExpCat = Object.values(categoryMap).reduce((s, v) => s + v, 0) || 1
    const categoryBreakdown = Object.entries(categoryMap)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amount]) => ({
        cat,
        amount,
        pct: Math.round((amount / totalExpCat) * 100),
      }))

    // ── Monthly trend ──────────────────────────────────────────────────────────
    const monthlyTrend = Object.entries(monthlyMap).map(([m, v]) => ({
      m,
      income:  v.income,
      expense: v.expense,
      pl:      v.income - v.expense,
    }))

    res.status(200).json({
      kpi: {
        totalIncome,
        totalExpenses,
        netPL: totalIncome - totalExpenses,
      },
      categoryBreakdown,
      monthlyTrend,
    })
  } catch (err) {
    console.error("finance-snapshot:", err)
    res.status(500).json({ error: err.message })
  }
}
