// /api/data/projects — token-authenticated
import { queryDB, getPage, plain, DB, hdrs } from "../../../lib/notion"
import { getClientByToken, getNotionToken, resolveDB } from "../../../lib/supabase"

// Fetch a single page title from Notion (for company name lookup)
async function fetchPageTitle(pageId, token) {
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: hdrs(token) })
    if (!res.ok) return ""
    const data = await res.json()
    const p    = data.properties || {}
    // Try common title property names
    for (const key of ["Name", "Company Name", "Title"]) {
      const prop = p[key]
      if (prop?.type === "title" && prop.title?.length) return plain(prop.title)
    }
    // Fallback: find whichever property is title type
    for (const prop of Object.values(p)) {
      if (prop?.type === "title" && prop.title?.length) return plain(prop.title)
    }
    return ""
  } catch { return "" }
}

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
      const phaseName = plain(p["Phase Name"]?.title || p.Name?.title || p.Title?.title || []) || ""
      const rollup    = p["Task Progress"]?.rollup
      const pct       = rollup?.type === "number" ? (rollup.number ?? 0) : (p["Progress"]?.number ?? 0)
      const status    = p.Status?.select?.name || p.Status?.status?.name || ""
      if (!phaseMap[projRel] || status === "In Progress") {
        phaseMap[projRel] = { name: phaseName, pct: Math.round(pct * 100) || pct }
      }
    }

    // Collect unique company page IDs for batch lookup
    const companyIds = new Set()
    for (const proj of projects) {
      const rel = proj.properties.Company?.relation?.[0]?.id
      if (rel) companyIds.add(rel)
    }
    const companyNames = {}
    await Promise.all([...companyIds].map(async id => {
      companyNames[id.replace(/-/g, "")] = await fetchPageTitle(id, notionToken)
    }))

    const counts = { active: 0, review: 0, done: 0, hold: 0 }
    const builds = []

    for (const proj of projects) {
      const p        = proj.properties
      const status   = p.Status?.select?.name || ""
      const name     = plain(p["Project Name"]?.title || p.Name?.title || p.Title?.title || []) || "Untitled"
      const progress = p["Overall Progress"]?.rollup?.number ?? 0
      const compRel  = p.Company?.relation?.[0]?.id?.replace(/-/g, "")
      const company  = compRel ? (companyNames[compRel] || "") : ""
      const pkg      = p["Package"]?.select?.name || p["Package Type"]?.select?.name || ""
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
