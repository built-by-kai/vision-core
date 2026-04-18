// /api/data/catalogue-update — Opxio internal only
// Updates a Catalogue item in Notion. Only callable with the Opxio master token.
// Supports updating: Price, Price Max, Monthly Fee, Description, Status, Tier, Available To, Order

import { getClientByToken } from "../../../lib/supabase"

const CATALOGUE_DB = "0acfe60097f682568935013f42a876f9"
const OPXIO_TOKEN  = "04524d18e8ef8f862b64d497e4c6cc52a7991d96029c71546939b5e3ec428edf"

const NOTION_API = "https://api.notion.com/v1"
const NOTION_VERSION = "2022-06-28"

function notionHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "no-store")

  if (req.method !== "POST" && req.method !== "PATCH") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  try {
    // ── Auth — Opxio master token only ────────────────────────────────────────
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })
    if (accessToken !== OPXIO_TOKEN) return res.status(403).json({ error: "Not authorised — internal use only" })

    const { pageId, fields } = req.body
    if (!pageId || !fields) return res.status(400).json({ error: "Missing pageId or fields" })

    const notionToken = process.env.NOTION_API_KEY

    // ── Build Notion properties patch ─────────────────────────────────────────
    const properties = {}

    if (fields.name !== undefined) {
      properties["Product Name"] = { title: [{ text: { content: fields.name } }] }
    }
    if (fields.price !== undefined) {
      properties["Price"] = fields.price === null ? { number: null } : { number: Number(fields.price) }
    }
    if (fields.priceMax !== undefined) {
      properties["Price Max"] = fields.priceMax === null ? { number: null } : { number: Number(fields.priceMax) }
    }
    if (fields.monthly !== undefined) {
      properties["Monthly Fee (MYR)"] = fields.monthly === null ? { number: null } : { number: Number(fields.monthly) }
    }
    if (fields.desc !== undefined) {
      properties["Description"] = { rich_text: [{ text: { content: fields.desc } }] }
    }
    if (fields.tier !== undefined) {
      properties["Tier"] = { select: { name: fields.tier } }
    }
    if (fields.status !== undefined) {
      properties["Status"] = { select: { name: fields.status } }
    }
    if (fields.order !== undefined) {
      properties["Order"] = { number: Number(fields.order) }
    }
    if (fields.avail !== undefined) {
      // avail is array of OS names
      properties["Available To"] = { multi_select: fields.avail.map(name => ({ name })) }
    }
    if (fields.model !== undefined) {
      properties["Pricing Model"] = { select: { name: fields.model } }
    }
    if (fields.visibility !== undefined) {
      properties["Availability"] = { select: { name: fields.visibility } }
    }

    if (Object.keys(properties).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" })
    }

    // ── PATCH Notion page ─────────────────────────────────────────────────────
    const pageIdDashed = pageId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")
    const r = await fetch(`${NOTION_API}/pages/${pageIdDashed}`, {
      method: "PATCH",
      headers: notionHeaders(notionToken),
      body: JSON.stringify({ properties }),
    })

    if (!r.ok) {
      const err = await r.json()
      return res.status(r.status).json({ error: err.message || "Notion API error" })
    }

    const updated = await r.json()
    return res.status(200).json({ ok: true, pageId: updated.id })

  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: e.message })
  }
}
