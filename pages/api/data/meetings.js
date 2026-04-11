// /api/data/meetings
// Returns upcoming meetings from Meetings DB
// Called by widgets: meetings.html, schedule.html

import { queryDB, plain, DB } from "../../../lib/notion"

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=240")

  try {
    const token = process.env.NOTION_API_KEY
    const now   = new Date()

    // Fetch all meetings, filter upcoming in JS (simpler than Notion filter)
    const all = await queryDB(DB.MEETINGS, null, token)

    const meetings = []
    let discoveryCount = 0, followupCount = 0, thisWeek = 0, thisMonth = 0

    const weekEnd  = new Date(now); weekEnd.setDate(now.getDate() + 7)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)

    for (const m of all) {
      const p    = m.properties
      const dateStr = p.Date?.date?.start || p["Meeting Date"]?.date?.start || ""
      if (!dateStr) continue
      const d = new Date(dateStr)
      if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) continue // skip past

      const client  = plain(p.Client || p["Lead"] || p.Name || p.Title) || "—"
      const project = plain(p.Project || p["Project Name"]) || ""
      const type    = p.Type?.select?.name || p.Type?.status?.name || plain(p.Type) || "Meeting"
      const today   = d.toDateString() === now.toDateString()

      // Format date
      const dateLabel = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      const timeLabel = dateStr.includes("T")
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : ""

      meetings.push({ date: dateLabel, time: timeLabel, client, project, type, today })

      if (d <= weekEnd)  thisWeek++
      if (d <= monthEnd) thisMonth++
      if (type === "Discovery" || type === "Discovery Call") discoveryCount++
      if (type === "Follow-up" || type === "Follow Up")     followupCount++
    }

    // Sort ascending by date
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
