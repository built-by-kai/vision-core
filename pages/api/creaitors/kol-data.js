// Vercel Serverless Function — KOL Data
// Fetches KOL & Talent Directory + Influencer Campaign records
// Used by the HOM (Head of Marketing) view in the enhanced dashboard

import { getClientByToken, getNotionToken, resolveDB } from "../../../lib/supabase"

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  const NOTION_KEY = getNotionToken(client)
  const KOL_DB      = resolveDB(client, 'KOL_DIRECTORY',       'b14fe60097f6839db100812a72f16420')
  const CAMPAIGN_DB = resolveDB(client, 'INFLUENCER_CAMPAIGN',  'ca6fe60097f683318bb5817bbaee66aa')

  const headers = {
    'Authorization': `Bearer ${NOTION_KEY}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  }

  async function queryAll(dbId) {
    let all = [], hasMore = true, cursor
    while (hasMore) {
      const body = { page_size: 100 }
      if (cursor) body.start_cursor = cursor
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST', headers, body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(`DB query error (${r.status}): ${await r.text()}`)
      const d = await r.json()
      all = all.concat(d.results)
      hasMore = d.has_more
      cursor = d.next_cursor
    }
    return all
  }

  function txt(prop) {
    return prop?.title?.[0]?.plain_text || prop?.rich_text?.[0]?.plain_text || null
  }
  function sel(prop)  { return prop?.select?.name || null }
  function stat(prop) { return prop?.status?.name || null }
  function ms(prop)   { return (prop?.multi_select || []).map(x => x.name) }
  function num(prop)  { return prop?.number ?? null }
  function dt(prop)   { return prop?.date?.start || null }

  try {
    const [kolRows, campaignRows] = await Promise.all([
      queryAll(KOL_DB),
      queryAll(CAMPAIGN_DB),
    ])

    // ── KOL Directory ──────────────────────────────────────────────────────────
    const byKolStatus   = {}
    const byKolPlatform = {}

    const kolList = kolRows.map(r => {
      const p = r.properties
      const status    = stat(p['KOL Status'])    || 'Unknown'
      const platforms = ms(p['Platform'])
      const followers = num(p['Tiktok Followers Count'])
      const avgViews  = num(p['Average Views'])
      const category  = sel(p['Category / Niche'])
      const rate      = txt(p['Average Rate'])

      byKolStatus[status] = (byKolStatus[status] || 0) + 1
      platforms.forEach(pl => { byKolPlatform[pl] = (byKolPlatform[pl] || 0) + 1 })

      return {
        id:        r.id,
        name:      txt(p['KOL Name']) || 'Unnamed',
        status,
        platforms,
        followers,
        avgViews,
        category,
        rate,
        email:     p['Email']?.email || null,
        tikTokUrl: p['Tiktok URL']?.url || null,
      }
    }).sort((a, b) => (b.followers || 0) - (a.followers || 0))

    // ── Influencer Campaigns ───────────────────────────────────────────────────
    const byCampaignStatus  = {}
    const byPaymentStatus   = {}
    let totalFee    = 0
    let unpaidFee   = 0
    let totalViews  = 0
    let totalLikes  = 0

    const campaignList = campaignRows.map(r => {
      const p = r.properties
      const status        = stat(p['Status'])          || 'Unknown'
      const paymentStatus = sel(p['Payment Status'])   || 'Unknown'
      const fee           = num(p['KOL Fee'])          || 0
      const platforms     = ms(p['Platform'])
      const views         = num(p['Views'])
      const likes         = num(p['Likes'])
      const engagement    = num(p['Engagement'])
      const postingDate   = dt(p['Posting Date'])
      const shipment      = sel(p['Shipment Status'])

      byCampaignStatus[status]       = (byCampaignStatus[status] || 0) + 1
      byPaymentStatus[paymentStatus] = (byPaymentStatus[paymentStatus] || 0) + 1
      totalFee += fee
      if (paymentStatus !== 'Paid') unpaidFee += fee
      if (views)      totalViews  += views
      if (likes)      totalLikes  += likes

      return {
        id: r.id,
        title:          txt(p['Title']) || 'Untitled',
        status,
        paymentStatus,
        shipmentStatus: shipment,
        fee,
        platforms,
        views,
        likes,
        engagement,
        postingDate,
        contentType:    sel(p['Content Type']),
        postingLinkIG:  p['Posting Link (IG)']?.url    || null,
        postingLinkTT:  p['Posting Link (TikTok)']?.url || null,
      }
    }).sort((a, b) => {
      // Sort: active/in-progress first, then by date desc
      const order = { 'In Progress': 0, 'Listing': 1, 'Posted': 2, 'Done': 3 }
      const oa = order[a.status] ?? 99
      const ob = order[b.status] ?? 99
      if (oa !== ob) return oa - ob
      if (a.postingDate && b.postingDate) return b.postingDate.localeCompare(a.postingDate)
      return 0
    })

    return res.status(200).json({
      kols: {
        total:      kolList.length,
        byStatus:   byKolStatus,
        byPlatform: byKolPlatform,
        list:       kolList,
      },
      campaigns: {
        total:          campaignList.length,
        byStatus:       byCampaignStatus,
        byPayment:      byPaymentStatus,
        totalFee,
        unpaidFee,
        totalViews,
        totalLikes,
        list:           campaignList,
      },
    })

  } catch (err) {
    console.error('[kol-data]', err)
    return res.status(500).json({ error: err.message })
  }
}
