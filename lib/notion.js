// ─── Notion API helpers ───────────────────────────────────────────────────

export const NOTION_VERSION = "2022-06-28"
export const NOTION_TOKEN   = process.env.NOTION_API_KEY

// ─── Database IDs ─────────────────────────────────────────────────────────
export const DB = {
  QUOTATIONS:    "f8167f0bda054307b90b17ad6b9c5cf8",
  LEADS:         "8690d55c4d0449068c51ef49d92a26a2",
  COMPANIES:     "33c8b289e31a80fe82d2ccd18bcaec68",
  CATALOGUE:     "33c8b289e31a80bebdf1ecd506e5ccc3",
  INVOICE:       "9227dda9c4be42a1a4c6b1bce4862f8c",
  PROJECTS:      "5719b2672d3442a29a22637a35398260",
  PHASES:        "33d8b289e31a81d896bfdb314521dc7b",
  RECEIPT:       "3b99088af86c48c598a6422d764b24ac",
  EXPANSIONS:    "47a500ac8dd4464d96a8e4d799485421",
  OPXIO_DETAILS: "33c8b289e31a80b1aa85fc1921cc0adc",
  CLIENT_IMPL:   "cb42a5f93aaf46e6bcafe39dde6aecba",
  CLIENTS:       "036622227fd244ad9a77633d5ae0a64b",
  MEETINGS:      "e283b9d542a34865bf518c3a0e43f1fe",
  PIC_HISTORY:   "3c870b0a06b647b3bc85c042d56cfb6f",
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
