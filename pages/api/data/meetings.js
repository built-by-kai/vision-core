// /api/data/meetings — token-authenticated
import { queryDB, plain, DB } from "../../../lib/notion"
import { getClientByToken, getNotionToken, resolveDB, resolveField } from "../../../lib/supabase"

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=240")

  try {
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })

    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })

    const notionToken = getNotionToken(client)
    const MEETINGS_DB  = resolveDB(client, "MEETINGS", DB.MEETINGS)
    const typeField    = resolveField(client, "TYPE_FIELD", "Type")

    const now = new Date()
    const all = await queryDB(MEETINGS_DB, null, notionToken)

    const meetings = []
    let discoveryCount = 0, followupCount = 0, thisWeek = 0, thisMonth = 0
    const weekEnd  = new Date(now); weekEnd.setDate(now.getDate() + 7)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)

    for (const m of all) {
      const p       = m.properties
      const dateStr = p.Date?.date?.start || p["Meeting Date"]?.date?.start || ""
      if (!dateStr) continue
      const d = new Date(dateStr)
      if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) continue

      const clientName = plain(p.Client || p["Lead"] || p.Name || p.Title) || "—"
      const project    = plain(p.Project || p["Project Name"]) || ""
      const type       = p[typeField]?.select?.name || plain(p[typeField]) || "Meeting"
      const today      = d.toDateString() === now.toDateString()
      const dateLabel  = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      const timeLabel  = dateStr.includes("T") ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""

      meetings.push({ date: dateLabel, time: timeLabel, client: clientName, project, type, today })

      if (d <= weekEnd)  thisWeek++
      if (d <= monthEnd) thisMonth++
      if (["Discovery","Discovery Call"].includes(type)) discoveryCount++
      if (["Follow-up","Follow Up"].includes(type))      followupCount++
    }

    meetings.sort((a, b) => new Date(a.date) - new Date(b.date))

    res.status(200).json({
      meetings: meetings.slice(0, 20),
      stats: { week: thisWeek, month: thisMonth, discovery: discoveryCount, followup: followupCount },
    })
  } catch (err) {
    console.error("meetings:", err)
    res.status(500).json({ error: err.message })
  }
}
