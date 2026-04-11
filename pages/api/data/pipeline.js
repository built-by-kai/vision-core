// /api/data/pipeline
// Returns aggregated CRM/pipeline data from Leads DB
// Called by widgets: deals.html, board.html, potential.html, visitors.html

import { queryDB, plain, DB } from "../../../lib/notion"

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  try {
    const token = process.env.NOTION_API_KEY
    const leads = await queryDB(DB.LEADS, null, token)

    const now   = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth()

    // ── Stage counts ──────────────────────────────────────────────────────
    const stages = {
      Incoming: 0, Contacted: 0, Qualified: 0,
      "Discovery Call": 0, Proposed: 0, Won: 0, Lost: 0,
    }
    // Board groups — all active (not won/lost)
    const boardGroups = {}
    // Monthly new leads (last 6 months)
    const monthly = {}
    for (let i = 5; i >= 0; i--) {
      const d   = new Date(year, month - i, 1)
      const key = d.toLocaleString("default", { month: "short" })
      monthly[key] = 0
    }

    for (const lead of leads) {
      const p     = lead.properties
      const stage = p.Stage?.status?.name || p.Stage?.select?.name || "Unknown"
      const name  = plain(p["Lead Name"] || p.Name || p.Title) || "Untitled"
      const value = p["Estimated Value"]?.number || 0
      const pkg   = plain(p["Package Type"]) || ""
      const created = new Date(lead.created_time)
      const cm    = created.getMonth(), cy = created.getFullYear()

      if (stage in stages) stages[stage]++

      // Board — exclude Won/Lost
      if (!["Won", "Lost"].includes(stage)) {
        if (!boardGroups[stage]) boardGroups[stage] = []
        boardGroups[stage].push({ name, value, pkg })
      }

      // Monthly (last 6 months)
      const mKey = created.toLocaleString("default", { month: "short" })
      const mDate = new Date(year, month - 5, 1)
      if (created >= mDate && mKey in monthly) monthly[mKey]++
    }

    // ── Board array ───────────────────────────────────────────────────────
    const stageOrder = ["Incoming", "Contacted", "Qualified", "Discovery Call", "Proposed"]
    const board = stageOrder
      .filter(s => boardGroups[s])
      .map(s => ({ stage: s, leads: boardGroups[s] }))

    // ── Monthly array ─────────────────────────────────────────────────────
    const monthlyArr = Object.entries(monthly).map(([m, v]) => ({ m, v }))

    // ── This month stats ──────────────────────────────────────────────────
    const thisMonthLeads = leads.filter(l => {
      const d = new Date(l.created_time)
      return d.getMonth() === month && d.getFullYear() === year
    }).length

    res.status(200).json({
      stages,
      board,
      monthly:        monthlyArr,
      totalActive:    leads.filter(l => {
        const s = l.properties.Stage?.status?.name || ""
        return !["Won", "Lost"].includes(s)
      }).length,
      thisMonthLeads,
    })
  } catch (err) {
    console.error("pipeline:", err)
    res.status(500).json({ error: err.message })
  }
}
