// /api/data/pipeline — token-authenticated
// Queries the Leads DB (early-stage funnel: Incoming → Converted)
// Stages: Incoming, Contacted, Qualified, Converted, Lost

import { queryDB, plain, DB } from "../../../lib/notion"
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
    const LEADS_DB    = resolveDB(client, "LEADS", DB.LEADS)

    const now   = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth()

    const leads = await queryDB(LEADS_DB, null, notionToken)

    // Leads funnel stages
    const FUNNEL_STAGES = ["Incoming", "Contacted", "Qualified"]
    const stages = { Incoming: 0, Contacted: 0, Qualified: 0, Converted: 0, Lost: 0 }
    const boardGroups = {}
    const monthly = {}
    for (let i = 5; i >= 0; i--) {
      const d = new Date(year, month - i, 1)
      monthly[d.toLocaleString("default", { month: "short" })] = 0
    }

    let pipelineValue   = 0
    let thisMonthLeads  = 0
    let thisMonthConverted = 0
    let thisMonthLost   = 0
    const sourceCounts  = {}

    for (const lead of leads) {
      const p     = lead.properties
      const stage = p.Stage?.status?.name || p.Stage?.select?.name || "Unknown"
      const name  = plain(p["Lead Name"]?.title || p.Name?.title || p.Title?.title || []) || "Untitled"
      const value = p["Estimated Value"]?.number || 0
      const pkg   = p["OS Interest"]?.select?.name || p["Package Type"]?.select?.name || ""
      const created = new Date(lead.created_time)
      const isThisMonth = created.getMonth() === month && created.getFullYear() === year

      if (stage in stages) stages[stage]++

      if (FUNNEL_STAGES.includes(stage)) {
        pipelineValue += value
        if (!boardGroups[stage]) boardGroups[stage] = []
        boardGroups[stage].push({ name, value, pkg })
      }

      if (isThisMonth) {
        thisMonthLeads++
        if (stage === "Converted") thisMonthConverted++
        if (stage === "Lost")      thisMonthLost++
      }

      const mKey  = created.toLocaleString("default", { month: "short" })
      const mDate = new Date(year, month - 5, 1)
      if (created >= mDate && mKey in monthly) monthly[mKey]++

      const srcs = p.Source?.multi_select || []
      if (srcs.length) {
        for (const s of srcs) sourceCounts[s.name] = (sourceCounts[s.name] || 0) + 1
      } else {
        sourceCounts["Other"] = (sourceCounts["Other"] || 0) + 1
      }
    }

    const board = FUNNEL_STAGES
      .filter(s => boardGroups[s])
      .map(s => ({ stage: s, leads: boardGroups[s] }))

    const totalActive = leads.filter(l => {
      const s = l.properties.Stage?.status?.name || l.properties.Stage?.select?.name || ""
      return FUNNEL_STAGES.includes(s)
    }).length

    const convTotal = thisMonthConverted + thisMonthLost
    const convRate  = convTotal > 0 ? Math.round((thisMonthConverted / convTotal) * 100) : null

    res.status(200).json({
      stages,
      board,
      monthly:        Object.entries(monthly).map(([m, v]) => ({ m, v })),
      totalActive,
      pipelineValue,
      convRate,
      thisMonthLeads,
      thisMonthConverted,
      thisMonthLost,
      // legacy compat
      winRate:        convRate,
      thisMonthWon:   thisMonthConverted,
      sources: Object.entries(sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ label, count })),
    })
  } catch (err) {
    console.error("pipeline:", err)
    res.status(500).json({ error: err.message })
  }
}
