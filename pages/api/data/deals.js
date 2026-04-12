// /api/data/deals — token-authenticated
// Returns Deals DB stage breakdown + Proposals + Quotations counts
// Used by: potential.html (pre-won stages), won.html (Building → Delivered)

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

    const notionToken   = getNotionToken(client)
    const DEALS_DB      = resolveDB(client, "DEALS",      DB.DEALS)
    const PROPOSALS_DB  = resolveDB(client, "PROPOSALS",  DB.PROPOSALS)
    const QUOTATIONS_DB = resolveDB(client, "QUOTATIONS", DB.QUOTATIONS)

    const now   = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth()

    const [deals, proposals, quotations] = await Promise.all([
      queryDB(DEALS_DB,      null, notionToken),
      queryDB(PROPOSALS_DB,  null, notionToken).catch(() => []),
      queryDB(QUOTATIONS_DB, null, notionToken).catch(() => []),
    ])

    // ── Deals stage breakdown ──────────────────────────────────────────────
    const POTENTIAL_STAGES = ["Discovery Done", "Quotation Issued", "Quotation Approved", "Deposit Due"]
    const WON_STAGES       = ["Building", "Balance Due", "Delivered"]

    const stages = {
      "Discovery Done":     0,
      "Quotation Issued":   0,
      "Quotation Approved": 0,
      "Deposit Due":        0,
      "Building":           0,
      "Balance Due":        0,
      "Delivered":          0,
      "Lost":               0,
    }

    let potentialValue     = 0
    let buildingValue      = 0
    let wonThisMonth       = 0
    let deliveredThisMonth = 0
    const boardGroups = {}

    for (const deal of deals) {
      const p     = deal.properties
      const stage = p.Stage?.status?.name || p.Stage?.select?.name || "Unknown"
      const name  = plain(p["Deal Name"]?.title || p.Name?.title || p.Title?.title || []) || "Untitled"
      const value = p["Total Value"]?.number || p["Estimated Value"]?.number || 0
      const pkg   = p["Package Type"]?.select?.name || ""
      const d     = new Date(deal.created_time)
      const isThisMonth = d.getMonth() === month && d.getFullYear() === year

      if (stage in stages) stages[stage]++

      if (POTENTIAL_STAGES.includes(stage)) {
        potentialValue += value
        if (!boardGroups[stage]) boardGroups[stage] = []
        boardGroups[stage].push({ name, value, pkg })
      }
      if (WON_STAGES.includes(stage)) buildingValue += value
      if (isThisMonth && stage === "Deposit Due") wonThisMonth++
      if (isThisMonth && stage === "Delivered")   deliveredThisMonth++
    }

    // ── Proposals ──────────────────────────────────────────────────────────
    const propStats = { total: proposals.length, Draft: 0, "Send Proposal": 0, Sent: 0, Accepted: 0, Rejected: 0 }
    let propValue = 0
    for (const p of proposals) {
      const pr = p.properties
      const s  = pr.Status?.select?.name || ""
      if (s === "Draft")            propStats.Draft++
      else if (s === "Send Proposal") propStats["Send Proposal"]++
      else if (s === "Sent")        propStats.Sent++
      else if (s === "Accepted")    propStats.Accepted++
      else if (s === "Rejected")    propStats.Rejected++
      propValue += pr.Fee?.number || pr["Total Fee"]?.number || 0
    }

    // ── Quotations ─────────────────────────────────────────────────────────
    const quotStats = { total: quotations.length, Draft: 0, Issued: 0, Approved: 0, Rejected: 0 }
    for (const q of quotations) {
      const qp = q.properties
      const s  = qp.Status?.status?.name || qp.Status?.select?.name || ""
      if (s === "Draft")          quotStats.Draft++
      else if (s === "Issued")    quotStats.Issued++
      else if (s === "Approved")  quotStats.Approved++
      else if (s === "Rejected")  quotStats.Rejected++
    }

    const board = POTENTIAL_STAGES
      .filter(s => boardGroups[s])
      .map(s => ({ stage: s, deals: boardGroups[s] }))

    res.status(200).json({
      stages,
      board,
      proposals: { ...propStats, pipelineValue: propValue },
      quotations: quotStats,
      potentialValue,
      buildingValue,
      wonThisMonth,
      deliveredThisMonth,
    })
  } catch (err) {
    console.error("deals:", err)
    res.status(500).json({ error: err.message })
  }
}
