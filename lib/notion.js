// ─── Notion API helpers ───────────────────────────────────────────────────

export const NOTION_VERSION = "2022-06-28"
export const NOTION_TOKEN   = process.env.NOTION_API_KEY

// ─── Database IDs ─────────────────────────────────────────────────────────
export const DB = {
  QUOTATIONS:    "b54fe60097f683e1930d012d635b14d5",
  LEADS:         "caafe60097f683398df40197eeedbffe",
  COMPANIES:     "725fe60097f682c09be901fe6ebb6b41",
  CATALOGUE:     "0acfe60097f682568935013f42a876f9",
  INVOICE:       "b02fe60097f6823b901e81d600093692",
  PROJECTS:      "842fe60097f68303b34e01a5432d24cc",
  PHASES:        "39ffe60097f682b4bf11814aadaf233f",
  RECEIPT:       "1b2fe60097f682ba85e8016fba51d654",
  EXPANSIONS:    "7c6fe60097f682fbbe9b81f828f6d3f8",
  OPXIO_DETAILS: "757fe60097f68222857f0146e495ffa0",
  CLIENT_IMPL:   "c1dfe60097f682f1b0f10142af6449d0",
  CLIENTS:       "b0afe60097f68265b93401fbc6f0fec4",
  MEETINGS:      "f9ffe60097f68389a09981dfece9e98f",
  PIC_HISTORY:   "36efe60097f682d2b3410198d11714c7",
}

// ─── Headers factory ───────────────────────────────────────────────────────
export function hdrs(token) {
  return {
    "Authorization":  `Bearer ${token || NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type":   "application/json",
  }
}

// ─── Plain text from rich_text/title array ─────────────────────────────────
export function plain(arr = []) {
  return arr.map(t => t.plain_text || "").join("")
}

// ─── Get a property value from a Notion page ──────────────────────────────
export function getProp(page, key) {
  const prop = page?.properties?.[key]
  if (!prop) return null
  switch (prop.type) {
    case "title":        return plain(prop.title)
    case "rich_text":    return plain(prop.rich_text)
    case "number":       return prop.number ?? null
    case "select":       return prop.select?.name ?? null
    case "multi_select": return prop.multi_select?.map(s => s.name) ?? []
    case "status":       return prop.status?.name ?? null
    case "date":         return prop.date?.start ?? null
    case "checkbox":     return prop.checkbox ?? false
    case "url":          return prop.url ?? null
    case "email":        return prop.email ?? null
    case "phone_number": return prop.phone_number ?? null
    case "relation":     return prop.relation?.map(r => r.id) ?? []
    case "formula":      return prop.formula?.[prop.formula.type] ?? null
    case "rollup": {
      const r = prop.rollup
      if (r.type === "number") return r.number ?? null
      if (r.type === "array")  return r.array ?? []
      return null
    }
    case "files": {
      const files = prop.files ?? []
      if (!files.length) return null
      const f = files[0]
      return f.type === "external" ? f.external?.url : f.file?.url
    }
    default: return null
  }
}

// ─── Fetch a single Notion page ────────────────────────────────────────────
export async function getPage(pageId, token) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: hdrs(token),
  })
  if (!res.ok) throw new Error(`Notion getPage ${pageId}: ${res.status} ${await res.text()}`)
  return res.json()
}

// ─── Patch a Notion page ───────────────────────────────────────────────────
export async function patchPage(pageId, properties, token) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method:  "PATCH",
    headers: hdrs(token),
    body:    JSON.stringify({ properties }),
  })
  if (!res.ok) throw new Error(`Notion patchPage ${pageId}: ${res.status} ${await res.text()}`)
  return res.json()
}

// ─── Create a Notion page ──────────────────────────────────────────────────
export async function createPage(body, token) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method:  "POST",
    headers: hdrs(token),
    body:    JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Notion createPage: ${res.status} ${await res.text()}`)
  return res.json()
}

// ─── Query a database (all pages, handles pagination) ─────────────────────
export async function queryDB(dbId, filter, token) {
  const pages = []
  let cursor  = undefined
  do {
    const body = { page_size: 100 }
    if (filter) body.filter = filter
    if (cursor) body.start_cursor = cursor
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method:  "POST",
      headers: hdrs(token),
      body:    JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Notion queryDB ${dbId}: ${res.status} ${await res.text()}`)
    const data = await res.json()
    pages.push(...data.results)
    cursor = data.has_more ? data.next_cursor : undefined
  } while (cursor)
  return pages
}

// ─── Rich text helper ──────────────────────────────────────────────────────
export function rt(text, opts = {}) {
  return {
    type: "text",
    text: { content: text || "" },
    annotations: opts,
  }
}

// ─── Format date DD MMM YYYY ───────────────────────────────────────────────
export function fmtDate(iso) {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit", month: "long", year: "numeric"
    })
  } catch { return iso }
}

// ─── Fetch Opxio company details ───────────────────────────────────────────
export async function fetchCompanyDetails(token) {
  try {
    const pages = await queryDB(DB.OPXIO_DETAILS, undefined, token)
    if (!pages.length) return {}
    const page = pages[0]
    const p    = page.properties

    // Logo: try page icon first, then files property
    let logoUrl = ""
    const icon  = page.icon || {}
    if (icon.type === "external") logoUrl = icon.external?.url || ""
    else if (icon.type === "file") logoUrl = icon.file?.url || ""

    if (!logoUrl) {
      for (const name of ["Logo", "Brand Logo", "logo", "Brand"]) {
        const prop = p[name]
        if (prop?.type === "files" && prop.files?.length) {
          const f = prop.files[0]
          logoUrl = f.type === "external" ? f.external?.url : f.file?.url
          if (logoUrl) break
        }
      }
    }

    return {
      name:               getProp(page, "Name"),
      email:              getProp(page, "Email"),
      phone:              getProp(page, "Phone"),
      bankName:           getProp(page, "Bank Name"),
      bankAccountHolder:  getProp(page, "Bank Account Holder Name"),
      bankNumber:         getProp(page, "Bank Number"),
      paymentMethod:      getProp(page, "Payment Method"),
      termsUrl:           getProp(page, "Terms URL"),
      logoUrl,
    }
  } catch (e) {
    console.warn("[company details]", e.message)
    return {}
  }
}
