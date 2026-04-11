// ─── wa_redirect.js ────────────────────────────────────────────────────────
// GET /api/wa_redirect?page_id=<quotation_page_id>
// Fetches quotation PIC phone + PDF URL, builds wa.me link, HTTP 302 redirects.

import { getPage, queryDB, plain, getProp, DB } from "../../lib/notion"

const TOKEN = process.env.NOTION_API_KEY

function cleanPhone(phone = "") {
  const digits = phone.replace(/\D/g, "")
  return digits.startsWith("0") ? "6" + digits : digits
}

async function searchClientsByName(name, token) {
  if (!name) return ""
  try {
    const pages = await queryDB(
      DB.CLIENTS,
      { property: "Name", title: { equals: name } },
      token
    )
    for (const page of pages.slice(0, 1)) {
      const props = page.properties
      for (const [, prop] of Object.entries(props)) {
        if (prop.type === "phone_number" && prop.phone_number) {
          return prop.phone_number
        }
        if (prop.type === "rich_text") {
          const val = plain(prop.rich_text)
          if (/\d{6,}/.test(val)) return val
        }
      }
    }
  } catch (e) {
    console.warn("[wa_redirect] clients lookup:", e.message)
  }
  return ""
}

async function buildWaUrl(pageId, token) {
  const page  = await getPage(pageId, token)
  const props = page.properties

  // quotation number (title prop)
  let quotationNo = ""
  for (const v of Object.values(props)) {
    if (v.type === "title") { quotationNo = plain(v.title); break }
  }

  const pdfUrl     = getProp(page, "PDF") || ""
  const companyRels = props.Company?.relation || []

  // company name
  let companyName = ""
  for (const rel of companyRels.slice(0, 1)) {
    try {
      const cp = await getPage(rel.id.replace(/-/g, ""), token)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }

  // PIC phone
  let picName = "", picPhone = ""
  const picProp = props.PIC || {}

  if (picProp.type === "relation") {
    for (const rel of (picProp.relation || []).slice(0, 1)) {
      try {
        const pp = await getPage(rel.id.replace(/-/g, ""), token)
        for (const [, prop] of Object.entries(pp.properties)) {
          if (prop.type === "phone_number" && prop.phone_number) {
            picPhone = prop.phone_number; break
          }
          if (prop.type === "rich_text") {
            const val = plain(prop.rich_text)
            if (/\d{6,}/.test(val)) { picPhone = val; break }
          }
        }
        for (const [, prop] of Object.entries(pp.properties)) {
          if (prop.type === "title") { picName = plain(prop.title); break }
        }
      } catch {}
    }
  } else if (picProp.type === "rollup") {
    for (const item of (picProp.rollup?.array || [])) {
      if (item.type === "title") { picName = plain(item.title); break }
      if (item.type === "rich_text") { picName = plain(item.rich_text); break }
    }
    if (picName) picPhone = await searchClientsByName(picName, token)
  } else if (picProp.type === "people") {
    const people = picProp.people || []
    if (people.length) {
      picName  = people[0].name || ""
      picPhone = await searchClientsByName(picName, token)
    }
  }

  const phone = cleanPhone(picPhone)
  if (!phone) return null

  const greeting = picName ? `Hi ${picName},` : "Hi,"
  const subject  = quotationNo ? `Quotation ${quotationNo}` : "our quotation"
  const forWhom  = companyName ? ` for ${companyName}` : ""

  const lines = [
    greeting, "",
    `Please find attached ${subject}${forWhom}.`,
    ...(pdfUrl ? ["", `View PDF: ${pdfUrl}`] : []),
    "",
    "Do let us know if you have any questions.",
    "Looking forward to working with you!",
    "",
    "Best regards,",
    "Opxio",
  ]

  return `https://wa.me/${phone}?text=${encodeURIComponent(lines.join("\n"))}`
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" })

  const rawId = req.query.page_id || req.query.id
  if (!rawId) return res.status(400).send("<h2>Missing page_id</h2>")

  const pageId = rawId.replace(/-/g, "")

  try {
    const waUrl = await buildWaUrl(pageId, TOKEN)
    if (!waUrl) return res.status(400).send("<h2>No phone number found for PIC</h2>")

    res.writeHead(302, { Location: waUrl })
    res.end()
  } catch (e) {
    console.error("[wa_redirect]", e)
    res.status(500).send(`<h2>Error</h2><pre>${e.message}</pre>`)
  }
}
