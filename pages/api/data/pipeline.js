// /api/data/pipeline — token-authenticated
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

    const stages = { Incoming: 0, Contacted: 0, Qualified: 0, "Discovery Call": 0, Proposed: 0, Won: 0, Lost: 0 }
    const boardGroups = {}
    const monthly = {}
    for (let i = 5; i >= 0; i--) {
      const d = new Date(year, month - i, 1)
      monthly[d.toLocaleString("default", { month: "short" })] = 0
    }

    let pipelineValue   = 0  // sum of Estimated Value for active (non-Won/Lost) leads
    let thisMonthWon    = 0
    let thisMonthLost   = 0

    for (const lead of leads) {
      const p     = lead.properties
      const stage = p.Stage?.status?.name || p.Stage?.select?.name || "Unknown"
      const name  = plain(p["Lead Name"] || p.Name || p.Title) || "Untitled"
      const value = p["Estimated Value"]?.number || 0
      const pkg   = plain(p["Package Type"]?.select?.name || p["Package Type"] || "") || ""
      const created = new Date(lead.created_time)
      const isThisMonth = created.getMonth() === month && created.getFullYear() === year

      if (stage in stages) stages[stage]++

      if (!["Won", "Lost"].includes(stage)) {
        pipelineValue += value
        if (!boardGroups[stage]) boardGroups[stage] = []
        boardGroups[stage].push({ name, value, pkg })
      }

      if (isThisMonth && stage === "Won")  thisMonthWon++
      if (isThisMonth && stage === "Lost") thisMonthLost++

      const mKey  = created.toLocaleString("default", { month: "short" })
      const mDate = new Date(year, month - 5, 1)
      if (created >= mDate && mKey in monthly) monthly[mKey]++
    }

    const stageOrder = ["Incoming", "Contacted", "Qualified", "Discovery Call", "Proposed"]
    const board = stageOrder.filter(s => boardGroups[s]).map(s => ({ stage: s, leads: boardGroups[s] }))

    const totalActive    = leads.filter(l => !["Won","Lost"].includes(l.properties.Stage?.status?.name || l.properties.Stage?.select?.name || "")).length
    const winRateTotal   = thisMonthWon + thisMonthLost
    const winRate        = winRateTotal > 0 ? Math.round((thisMonthWon / winRateTotal) * 100) : null

    const thisMonthLeads = leads.filter(l => {
      const d = new Date(l.created_time)
      return d.getMonth() === month && d.getFullYear() === year
    }).length

    res.status(200).json({
      stages,
      board,
      monthly:        Object.entries(monthly).map(([m, v]) => ({ m, v })),
      totalActive,
      pipelineValue,
      winRate,
      thisMonthWon,
      thisMonthLost,
      thisMonthLeads,
    })
  } catch (err) {
    console.error("pipeline:", err)
    res.status(500).json({ error: err.message })
  }
}
