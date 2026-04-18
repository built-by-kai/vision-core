// /api/data/catalogue — token-authenticated
// Returns all active Catalogue items from the Opxio master Notion workspace
// Token must resolve to a valid client via Supabase (Opxio internal token works)

import { queryDB, plain } from "../../../lib/notion"
import { getClientByToken } from "../../../lib/supabase"

const CATALOGUE_DB = "0acfe60097f682568935013f42a876f9"

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600")

  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })
    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })

    // Catalogue always lives in Opxio's own workspace — use server-side key
    const notionToken = process.env.NOTION_API_KEY
    const rows = await queryDB(CATALOGUE_DB, {
      property: "Status", select: { equals: "Active" }
    }, notionToken)

    const items = rows
      .map(p => {
        const pp = p.properties
        const name     = plain(pp["Product Name"]?.title || [])
        const tier     = pp["Tier"]?.select?.name || ""
        const order    = pp["Order"]?.number ?? 999
        const price    = pp["Price"]?.number ?? null
        const priceMax = pp["Price Max"]?.number ?? null
        const monthly  = pp["Monthly Fee (MYR)"]?.number ?? null
        const model    = pp["Pricing Model"]?.select?.name || "One-Time"
        const term     = pp["Subscription Term"]?.select?.name || null
        const quoteType= pp["Quote Type"]?.select?.name || "New Business"
        const avail    = (pp["Available To"]?.multi_select || []).map(x => x.name)
        const requires = (pp["Requires"]?.relation || []).map(x => x.id.replace(/-/g,""))
        const slug     = plain(pp["Slug"]?.rich_text || [])
        const desc     = plain(pp["Description"]?.rich_text || [])
        const avail2   = pp["Availability"]?.select?.name || "Public"
        const buildDays= pp["Build Days"]?.number ?? null
        return { id: p.id.replace(/-/g,""), name, tier, order, price, priceMax, monthly, model, term, quoteType, avail, requires, slug, desc, visibility: avail2, buildDays }
      })
      .filter(x => x.name)
      .sort((a, b) => a.order - b.order)

    // Resolve Requires IDs → names (for display)
    const idToName = {}
    items.forEach(x => { idToName[x.id] = x.name })
    items.forEach(x => {
      x.requiresNames = x.requires.map(id => idToName[id]).filter(Boolean)
    })

    res.status(200).json({ items, ts: new Date().toISOString() })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
}
