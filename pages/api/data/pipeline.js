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
    const todayStr = now.toISOString().slice(0, 10)
    const _qm   = req.query.month ? parseInt(req.query.month) - 1 : null  // 1-12 → 0-11
    const _qy   = req.query.year  ? parseInt(req.query.year)      : null
    const month = (_qm !== null && !isNaN(_qm)) ? _qm : now.getMonth()
    const year  = (_qy !== null && !isNaN(_qy)) ? _qy : now.getFullYear()
    // When a specific month is selected, filter ALL data by Created On
    const monthFiltered = _qm !== null

    const leads = await queryDB(LEADS_DB, null, notionToken)

    const stages      = Object.fromEntries(ALL_STAGES.map(s => [s, 0]))
    const stageValues = Object.fromEntries(ALL_STAGES.map(s => [s, 0]))
    const boardGroups   = {}
    const monthly       = {}
    for (let i = 5; i >= 0; i--) {
      const d = new Date(year, month - i, 1)
      monthly[d.toLocaleString("default", { month: "short" })] = 0
    }

    let thisMonthLeads         = 0
    let thisMonthConverted     = 0
    let thisMonthLost          = 0
    let lostLeadsValueThisMonth = 0
    let leadsPotentialValue    = 0
    let followUpsDueToday      = 0
    let followUpsOverdue       = 0
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
      const _lrField = p["Lost Reason"] || p["Why Not Closing?"] || null
      const lostReason = _lrField?.multi_select?.map(x => x.name).join(", ") || _lrField?.select?.name || _lrField?.rich_text?.[0]?.plain_text || null
      const pageUrl    = `https://www.notion.so/${lead.id.replace(/-/g, "")}`
      const created = new Date(lead.created_time)
      const isThisMonth = created.getMonth() === month && created.getFullYear() === year

      // When month filter is active, only count leads created in that month
      // When no filter (live view), count all leads for the funnel
      const inScope = monthFiltered ? isThisMonth : true

      if (inScope && stage in stages) stages[stage]++
      if (inScope && stage in stageValues) stageValues[stage] += leadVal

      if (inScope && ACTIVE_STAGES.includes(stage)) {
        if (!boardGroups[stage]) boardGroups[stage] = []
        boardGroups[stage].push({ name, pkg })
        leadsPotentialValue += leadVal
        // Follow-up tracking
        const followUpDate = p["Next Follow-up"]?.date?.start || p["Follow Up Date"]?.date?.start || null
        if (followUpDate === todayStr) followUpsDueToday++
        else if (followUpDate && followUpDate < todayStr) followUpsOverdue++
      }

      if (inScope && stage === lostLabel) lostLeads.push({ name, value: leadVal, pkg, stage, lostReason, url: pageUrl, created: lead.created_time })

      if (isThisMonth) {
        thisMonthLeads++
        if (stage === wonLabel)  thisMonthConverted++
        if (stage === lostLabel) { thisMonthLost++; lostLeadsValueThisMonth += leadVal; }
      }

      const mKey  = created.toLocaleString("default", { month: "short" })
      const mDate = new Date(year, month - 5, 1)
      if (created >= mDate && mKey in monthly) monthly[mKey]++

      // Sources — also scoped to selected month when filtered
      if (inScope) {
        const srcs = p.Source?.multi_select || (p.Source?.select ? [p.Source.select] : [])
        if (srcs.length) {
          for (const s of srcs) sourceCounts[s.name] = (sourceCounts[s.name] || 0) + 1
        } else {
          sourceCounts["Other"] = (sourceCounts["Other"] || 0) + 1
        }
      }
    }

    const board = ACTIVE_STAGES
      .filter(s => boardGroups[s])
      .map(s => ({ stage: s, leads: boardGroups[s] }))

    // totalActive: when month-filtered, count only leads created that month in active stages
    // when live, count all current active leads
    const totalActive = leads.filter(l => {
      const s = l.properties[stageField]?.status?.name || l.properties[stageField]?.select?.name || ""
      if (!ACTIVE_STAGES.includes(s)) return false
      if (!monthFiltered) return true
      const created = new Date(l.created_time)
      return created.getMonth() === month && created.getFullYear() === year
    }).length

    const convTotal = thisMonthConverted + thisMonthLost
    const convRate  = convTotal > 0 ? Math.round((thisMonthConverted / convTotal) * 100) : null

    const totalLostLeads  = stages[lostLabel] || 0
    const lostLeadsValue  = lostLeads.reduce((s, d) => s + (d.value || 0), 0)

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
      lostLeadsValue,
      lostLeadsValueThisMonth,
      lostLeads,
      followUpsDueToday,
      followUpsOverdue,
      stageValues,
      sources: Object.entries(sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ label, count })),
    })
  } catch (err) {
    console.error("pipeline:", err)
    res.status(500).json({ error: err.message })
  }
}
