// /api/data/pipeline — token-authenticated
// Queries the Leads DB (client funnel)
// Stages are fully dynamic — driven by client.labels in Supabase

import { queryDB, plain, DB } from "../../../lib/notion"
import { getClientByToken, getNotionToken, resolveDB, resolveField } from "../../../lib/supabase"

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
    // Resolve LEADS DB — try uppercase key first, then lowercase fallback
    const LEADS_DB    = client?.databases?.["LEADS"] || client?.databases?.["leads"] || resolveDB(client, "LEADS", DB.LEADS)
    // LEAD_STAGE_FIELD takes priority (for clients where lead stage ≠ deal stage, e.g. Creaitors uses "Funnel")
    const stageField  = resolveField(client, "LEAD_STAGE_FIELD", null) || resolveField(client, "STAGE_FIELD", "Stage")

    // Stage config — from client labels or Opxio defaults
    const ALL_STAGES    = client.labels?.stages    || ["Incoming","Contacted","Discovery Done","Converted","Lost"]
    const ACTIVE_STAGES = client.labels?.activeStages || ["Incoming","Contacted","Discovery Done"]

    const now   = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth()

    const leads = await queryDB(LEADS_DB, null, notionToken)

    const stages = Object.fromEntries(ALL_STAGES.map(s => [s, 0]))
    const boardGroups   = {}
    const monthly       = {}
    for (let i = 5; i >= 0; i--) {
      const d = new Date(year, month - i, 1)
      monthly[d.toLocaleString("default", { month: "short" })] = 0
    }

    let thisMonthLeads     = 0
    let thisMonthConverted = 0
    let thisMonthLost      = 0
    let leadsPotentialValue = 0
    const sourceCounts     = {}
    const lostLeads        = []

    // Determine "converted" and "lost" labels — last two stages if not explicitly named
    const wonLabel  = ALL_STAGES.find(s => /won|convert/i.test(s))  || ALL_STAGES[ALL_STAGES.length - 2] || "Converted"
    const lostLabel = ALL_STAGES.find(s => /lost/i.test(s))         || ALL_STAGES[ALL_STAGES.length - 1] || "Lost"

    for (const lead of leads) {
      const p     = lead.properties
      const stage = p[stageField]?.status?.name || p[stageField]?.select?.name || "Unknown"
      const name  = plain(p["Lead Name"]?.title || p.Name?.title || []) || "Untitled"
      const pkg        = p["OS Interest"]?.select?.name || p["Interested In"]?.multi_select?.map(x => x.name).join(", ") || ""
      const leadVal    = p["Potential Value"]?.number || p["Estimated Value"]?.number || p["Value"]?.number || p["Deal Value"]?.number || 0
      const lostReason = p["Why Not Closing?"]?.select?.name || p["Lost Reason"]?.select?.name || null
      const pageUrl    = `https://www.notion.so/${lead.id.replace(/-/g, "")}`
      const created = new Date(lead.created_time)
      const isThisMonth = created.getMonth() === month && created.getFullYear() === year

      if (stage in stages) stages[stage]++

      if (ACTIVE_STAGES.includes(stage)) {
        if (!boardGroups[stage]) boardGroups[stage] = []
        boardGroups[stage].push({ name, pkg })
        leadsPotentialValue += leadVal
      }

      if (stage === lostLabel) lostLeads.push({ name, value: leadVal, pkg, stage, lostReason, url: pageUrl })

      if (isThisMonth) {
        thisMonthLeads++
        if (stage === wonLabel)  thisMonthConverted++
        if (stage === lostLabel) thisMonthLost++
      }

      const mKey  = created.toLocaleString("default", { month: "short" })
      const mDate = new Date(year, month - 5, 1)
      if (created >= mDate && mKey in monthly) monthly[mKey]++

      // Handle both multi_select and select Source field types
      const srcs = p.Source?.multi_select || (p.Source?.select ? [p.Source.select] : [])
      if (srcs.length) {
        for (const s of srcs) sourceCounts[s.name] = (sourceCounts[s.name] || 0) + 1
      } else {
        sourceCounts["Other"] = (sourceCounts["Other"] || 0) + 1
      }
    }

    const board = ACTIVE_STAGES
      .filter(s => boardGroups[s])
      .map(s => ({ stage: s, leads: boardGroups[s] }))

    const totalActive = leads.filter(l => {
      const s = l.properties[stageField]?.status?.name || l.properties[stageField]?.select?.name || ""
      return ACTIVE_STAGES.includes(s)
    }).length

    const convTotal = thisMonthConverted + thisMonthLost
    const convRate  = convTotal > 0 ? Math.round((thisMonthConverted / convTotal) * 100) : null

    const totalLostLeads = stages[lostLabel] || 0

    res.status(200).json({
      stages,
      stageOrder:   ALL_STAGES,
      activeStages: ACTIVE_STAGES,
      board,
      monthly:             Object.entries(monthly).map(([m, v]) => ({ m, v })),
      totalActive,
      convRate,
      thisMonthLeads,
      thisMonthConverted,
      thisMonthLost,
      winRate:             convRate,
      thisMonthWon:        thisMonthConverted,
      totalLostLeads,
      lostLabel,
      leadsPotentialValue,
      lostLeads,
      sources: Object.entries(sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ label, count })),
    })
  } catch (err) {
    console.error("pipeline:", err)
    res.status(500).json({ error: err.message })
  }
}
