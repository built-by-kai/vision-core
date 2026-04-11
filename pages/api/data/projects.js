// /api/data/projects — token-authenticated
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

    const notionToken  = getNotionToken(client)
    const PROJECTS_DB  = resolveDB(client, "PROJECTS", DB.PROJECTS)
    const PHASES_DB    = resolveDB(client, "PHASES",   DB.PHASES)

    const [projects, phases] = await Promise.all([
      queryDB(PROJECTS_DB, null, notionToken),
      queryDB(PHASES_DB,   null, notionToken),
    ])

    // Phase lookup by project ID
    const phaseMap = {}
    for (const ph of phases) {
      const p       = ph.properties
      const projRel = p.Project?.relation?.[0]?.id?.replace(/-/g, "")
      if (!projRel) continue
      const phaseName = plain(p.Name || p.Title) || ""
      const pct       = p["Task Progress"]?.number ?? p["Progress"]?.number ?? 0
      const status    = p.Status?.select?.name || p.Status?.status?.name || ""
      if (!phaseMap[projRel] || status === "In Progress") {
        phaseMap[projRel] = { name: phaseName, pct: Math.round(pct * 100) || pct }
      }
    }

    const counts = { active: 0, review: 0, done: 0, hold: 0 }
    const builds = []

    for (const proj of projects) {
      const p      = proj.properties
      const status = p.Status?.select?.name || ""
      const name   = plain(p.Name || p.Title) || "Untitled"
      const progress = p["Overall Progress"]?.number ?? 0
      const company  = plain(p.Company) || ""
      const pkg      = plain(p["Package Type"] || p.Type) || ""
      const projId   = proj.id.replace(/-/g, "")
      const phase    = phaseMap[projId] || { name: "—", pct: Math.round(progress * 100) || progress }

      let bucket = ""
      if (["Build Started","Building","In Progress","Active"].includes(status))  bucket = "active"
      else if (["In Review","Client Review","Review"].includes(status))           bucket = "review"
      else if (["Completed","Delivered","Done"].includes(status))                 bucket = "done"
      else if (["On Hold","Paused"].includes(status))                             bucket = "hold"

      if (bucket) counts[bucket]++
      if (["active","review","hold"].includes(bucket)) {
        builds.push({ name, client: company, type: pkg, phase: phase.name, phasePct: phase.pct, status: bucket })
      }
    }

    const order = { active: 0, review: 1, hold: 2 }
    builds.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))

    res.status(200).json({ counts, builds })
  } catch (err) {
    console.error("projects:", err)
    res.status(500).json({ error: err.message })
  }
}
