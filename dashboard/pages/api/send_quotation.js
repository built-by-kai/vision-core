// ─── send_quotation.js ─────────────────────────────────────────────────────
// POST /api/send_quotation   { "page_id": "<quotation_page_id>" }
// Triggered by Notion button "Send to Client".
// Builds WA URL, writes it to Quotation.WA Link, sets Status → Issued.

import { getPage, queryDB, patchPage, plain, DB } from "../../lib/notion"

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
      for (const [, prop] of Object.entries(page.properties)) {
        if (prop.type === "phone_number" && prop.phone_number) return prop.phone_number
        if (prop.type === "rich_text") {
          const val = plain(prop.rich_text)
          if (/\d{6,}/.test(val)) return val
        }
      }
    }
  } catch (e) {
    console.warn("[send_quotation] clients lookup:", e.message)
  }
  return ""
}

async function fetchQuotationData(pageId, token) {
  const page  = await getPage(pageId, token)
  const props = page.properties

  // title = quotation number
  let quotationNo = ""
  for (const v of Object.values(props)) {
    if (v.type === "title") { quotationNo = plain(v.title); break }
  }

  const pdfUrl = props.PDF?.url || ""
  const status = props.Status?.select?.name || ""

  // company name
  let companyName = ""
  for (const rel of (props.Company?.relation || []).slice(0, 1)) {
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
          if (prop.type === "title") { picName = plain(prop.title); break }
        }
        for (const [, prop] of Object.entries(pp.properties)) {
          if (prop.type === "phone_number" && prop.phone_number) {
            picPhone = prop.phone_number; break
          }
          if (prop.type === "rich_text") {
            const val = plain(prop.rich_text)
            if (/\d{6,}/.test(val)) { picPhone = val; break }
          }
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

  return { quotationNo, pdfUrl, status, companyName, picName, picPhone }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Send Quotation", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const body   = req.body || {}
    const rawId  = body.page_id || body.source?.page_id || body.data?.page_id
    if (!rawId) return res.status(400).json({ error: "Missing page_id" })

    const pageId = rawId.replace(/-/g, "")
    const { quotationNo, pdfUrl, companyName, picName, picPhone } =
      await fetchQuotationData(pageId, TOKEN)

    const phone = cleanPhone(picPhone)
    let waUrl   = null

    if (phone) {
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

      waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(lines.join("\n"))}`

      // Write WA Link → Notion, Status → Issued
      await patchPage(pageId, {
        "WA Link": { url: waUrl },
        "Status":  { select: { name: "Issued" } },
      }, TOKEN)
    } else {
      // Still update status even without phone
      await patchPage(pageId, {
        "Status": { select: { name: "Issued" } },
      }, TOKEN)
    }

    return res.json({
      status:       "success",
      quotation_no: quotationNo,
      wa_url:       waUrl,
      company_name: companyName,
      pic_name:     picName,
      pic_phone:    phone || null,
    })
  } catch (e) {
    console.error("[send_quotation]", e)
    return res.status(500).json({ error: e.message })
  }
}
