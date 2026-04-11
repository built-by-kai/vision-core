import { Client } from '@notionhq/client'

// Returns a Notion client scoped to a specific client's integration token.
// Each client has their own token — rate limits are fully isolated.
export function getNotionClient(token) {
  return new Client({ auth: token })
}

// Query a Notion database and return all pages (handles pagination)
export async function queryDatabase(notion, databaseId, filter = undefined) {
  const pages = []
  let cursor  = undefined

  do {
    const res = await notion.databases.query({
      database_id: databaseId,
      filter,
      start_cursor: cursor,
      page_size: 100,
    })
    pages.push(...res.results)
    cursor = res.has_more ? res.next_cursor : undefined
  } while (cursor)

  return pages
}

// Extract a plain value from a Notion property
export function getProp(page, propName) {
  const prop = page.properties?.[propName]
  if (!prop) return null

  switch (prop.type) {
    case 'title':       return prop.title?.map(t => t.plain_text).join('') || null
    case 'rich_text':   return prop.rich_text?.map(t => t.plain_text).join('') || null
    case 'number':      return prop.number ?? null
    case 'select':      return prop.select?.name ?? null
    case 'multi_select':return prop.multi_select?.map(s => s.name) ?? []
    case 'status':      return prop.status?.name ?? null
    case 'date':        return prop.date?.start ?? null
    case 'checkbox':    return prop.checkbox ?? null
    case 'url':         return prop.url ?? null
    case 'email':       return prop.email ?? null
    case 'phone_number':return prop.phone_number ?? null
    case 'formula':     return prop.formula?.[prop.formula.type] ?? null
    case 'rollup': {
      const r = prop.rollup
      if (r.type === 'number')   return r.number ?? null
      if (r.type === 'array')    return r.array ?? []
      return null
    }
    case 'relation':    return prop.relation?.map(r => r.id) ?? []
    default:            return null
  }
}

// Apply field_map: translate raw Notion page into standard schema
export function applyFieldMap(pages, fieldMap) {
  return pages.map(page => {
    const row = { _id: page.id }
    for (const [standardKey, notionProp] of Object.entries(fieldMap)) {
      row[standardKey] = getProp(page, notionProp)
    }
    return row
  })
}
