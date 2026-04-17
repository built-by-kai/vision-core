// ─── convert_to_deal.js ────────────────────────────────────────────────────
// POST /api/convert_to_deal   { "page_id": "<lead_page_id>" }
// Triggered by Notion button "Convert to Deal" on a Lead page.
//
// 1. Reads Lead: Company, Primary Contact, OS Interest, Source, Situation,
//    Discovery Call, Potential Value, Team Size, Industry, Budget Range,
//    Monthly Revenue Range, Country, Notes
// 2. Fetches Company name for Deal title
// 3. Creates Deal in Deals DB  ── Deal Name: "Company Name — Product"
// 4. Stitches: Deal["Origin Lead"] → Lead, Lead["Deal"] → Deal
// 5. Updates Lead Stage → "Discovery Done"

import { getPage, patchPage, createPage, plain, DB } from "../../lib/notion"

// ─── Safe relation append ──────────────────────────────────────────────────
async function appendRelation(pageId, property, newId, token) {
  const page     = await getPage(pageId, token)
  const existing = (page.properties?.[property]?.relation || []).map(r => ({ id: r.id }))
  if (existing.some(r => r.id === newId)) return
  await patchPage(pageId, {
    [property]: { relation: [...existing, { id: newId }] },
  }, token)
}

// ─── Main run ─────────────────────────────────────────────────────────────
async function run(payload) {
  const rawId = payload.page_id
    || payload.data?.id
    || payload.data?.page_id
    || payload.source?.page_id
    || payload.source?.id
  if (!rawId) throw new Error("Missing page_id")

  const leadId = rawId.replace(/-/g, "")
  const token  = process.env.NOTION_API_KEY

  // ── 1. Read Lead ──────────────────────────────────────────────────────────
  const lead  = await getPage(leadId, token)
  const lp    = lead.properties

  const companyRel = lp.Company?.relation?.[0]?.id?.replace(/-/g, "") || null

  // Primary Contact — try current and legacy field names
  const contactRel = (
    lp["Primary Contact"]?.relation ||
    lp["PIC Name"]?.relation ||
    []
  )[0]?.id?.replace(/-/g, "") || null

  const osInterest    = lp["OS Interest"]?.select?.name || null
  const situation     = plain(lp.Situation?.rich_text || [])
  const discoveryCall = lp["Discovery Call"]?.date?.start || null
  const potentialVal  = lp["Potential Value (MYR)"]?.number
                     ?? lp["Potential Value"]?.number
                     ?? null
  const teamSize      = lp["Team Size"]?.select?.name || null
  const industry      = lp.Industry?.select?.name || null
  const budgetRange   = lp["Budget Range"]?.select?.name || null
  const monthlyRev    = lp["Monthly Revenue Range"]?.select?.name || null
  const country       = lp.Country?.select?.name || null
  const notes         = plain(lp.Notes?.rich_text || [])

  // Source: Lead uses multi_select → Deal uses select (take first)
  const sourceArr = lp.Source?.multi_select || []
  const source    = sourceArr[0]?.name || null

  // ── 2. Fetch Company name ─────────────────────────────────────────────────
  let companyName = ""
  if (companyRel) {
    try {
      const cp = await getPage(companyRel, token)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch (e) {
      console.warn("[convert_to_deal] company fetch:", e.message)
    }
  }

  // ── 3. Build Deal Name: "Company Name — Product" ──────────────────────────
  // Format: Company Name — OS Interest  (e.g. "Kreativ Studio — Business OS")
  const product  = osInterest || "System OS"
  const dealName = companyName
    ? `${companyName} — ${product}`
    : `New Deal — ${product}`

  // ── 4. Create Deal ────────────────────────────────────────────────────────
  const dealProps = {
    "Deal Name":   { title: [{ text: { content: dealName } }] },
    "Stage":       { status: { name: "Discovery Done" } },
    "Origin Lead": { relation: [{ id: leadId }] },
  }

  // ── Only set properties that exist in the Deals DB ───────────────────────
  if (companyRel)    dealProps["Company"]          = { relation: [{ id: companyRel }] }
  if (contactRel)    dealProps["Primary Contact"]  = { relation: [{ id: contactRel }] }
  if (osInterest)    dealProps["Packages"]         = { multi_select: [{ name: osInterest }] }
  if (situation)     dealProps["Situation"]        = { rich_text: [{ text: { content: situation } }] }
  if (discoveryCall) dealProps["Discovery Call"]   = { date: { start: discoveryCall } }
  if (country)       dealProps["Country"]          = { select: { name: country } }
  if (potentialVal)  dealProps["Deal Value (MYR)"] = { number: potentialVal }
  if (notes)         dealProps["Notes"]            = { rich_text: [{ text: { content: notes } }] }
  // Source: skipped — Lead uses raw channel values (Instagram, LinkedIn etc.)
  // while Deals uses intent-based categories. Map manually in Notion after creation.
  // Team Size, Industry, Budget Range, Monthly Revenue — not in Deals DB schema.

  const dealPage = await createPage({
    parent:     { database_id: DB.DEALS },
    properties: dealProps,
  }, token)
  const dealId = dealPage.id.replace(/-/g, "")
  console.log("[convert_to_deal] Deal created:", dealId, dealName)

  // ── 5. Stitch: Lead["Deal"] → Deal ────────────────────────────────────────
  try {
    await appendRelation(leadId, "Deal", dealId, token)
  } catch (e) {
    console.warn("[convert_to_deal] stitch Lead→Deal:", e.message)
  }

  // ── 6. Update Lead Stage → Discovery Done ─────────────────────────────────
  try {
    await patchPage(leadId, { "Stage": { status: { name: "Discovery Done" } } }, token)
  } catch (e) {
    console.warn("[convert_to_deal] lead stage update:", e.message)
  }

  return {
    status:     "success",
    lead_id:    leadId,
    deal_id:    dealId,
    deal_name:  dealName,
    deal_url:   dealPage.url || `https://notion.so/${dealId}`,
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Convert to Deal", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const result = await run(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[convert_to_deal]", e)
    return res.status(500).json({ error: e.message })
  }
}
