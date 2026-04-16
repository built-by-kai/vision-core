import { useData } from '@/components/shared/useData'
import DataCard    from '@/components/shared/DataCard'
import styles      from '@/styles/widgets.module.css'

// ── Widget access helper ───────────────────────────────────────────────────
// Mirrors the server-side hasWidgetAccess() in lib/supabase.js.
// null / missing = no restriction; array = whitelist.
function hasAccess(labels, widgetSlug) {
  const list = labels?.allowed_widgets
  if (!list || !Array.isArray(list) || list.length === 0) return true
  return list.includes(widgetSlug)
}

// ── Widget embed sections ─────────────────────────────────────────────────
// Each entry maps a widget slug → display name + embed path.
// Only rendered if the client has access to that slug.
const WIDGET_EMBEDS = [
  { slug: 'marketing/campaigns',         label: 'Campaigns',          path: '/marketing/campaigns'         },
  { slug: 'marketing/content-production',label: 'Content Production', path: '/marketing/content-production'},
  { slug: 'marketing/staff-breakdown',   label: 'Staff Breakdown',    path: '/marketing/staff-breakdown'   },
  { slug: 'marketing/staff-performance', label: 'Staff Performance',  path: '/marketing/staff-performance' },
]

export default function MarketingDashboard({ config, slug, token }) {
  const labels = config.labels || {}
  const custom = config.custom_widgets || []

  const { data: campaigns, loading: l1 } = useData(slug, token, 'campaigns')
  const { data: content,   loading: l2 } = useData(slug, token, 'content')
  const loading = l1 || l2

  const activeCampaigns = campaigns?.filter(c => c.campaignStatus === 'Active') || []
  const inReview        = content?.filter(c => c.contentStatus === 'In Review')      || []
  const published       = content?.filter(c => c.contentStatus === 'Published')      || []
  const inProduction    = content?.filter(c => c.contentStatus === 'In Production')  || []

  // Which widget embeds this client can see
  const allowedEmbeds = WIDGET_EMBEDS.filter(w => hasAccess(labels, w.slug))

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        {labels.marketingSection || 'Marketing Overview'}
      </h2>

      {loading ? (
        <div className={styles.skeletonRow}>
          {[1,2,3].map(i => <div key={i} className={styles.cardSkeleton} />)}
        </div>
      ) : (
        <>
          <div className={styles.kpiRow}>
            <DataCard
              label={labels.campaigns || 'Active Campaigns'}
              value={activeCampaigns.length}
            />
            <DataCard
              label={labels.inProduction || 'In Production'}
              value={inProduction.length}
            />
            <DataCard
              label={labels.inReview || 'In Review'}
              value={inReview.length}
              accent={inReview.length > 0}
            />
            <DataCard
              label={labels.published || 'Published'}
              value={published.length}
            />
          </div>

          {/* Custom add-on widgets — gated by both custom_widgets list and allowed_widgets */}
          {custom.includes('kol_tracker') && hasAccess(labels, 'marketing/kol') && (
            <KOLTracker slug={slug} token={token} labels={labels} />
          )}
          {custom.includes('monthly_campaigns') && hasAccess(labels, 'marketing/campaigns') && (
            <MonthlyCampaigns slug={slug} token={token} labels={labels} />
          )}

          {/* Embedded widget panels — only shown if client has access */}
          {allowedEmbeds.length > 0 && (
            <div className={styles.widgetEmbedList}>
              {allowedEmbeds.map(w => (
                <WidgetEmbed key={w.slug} label={w.label} path={w.path} token={token} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

// ── Embedded HTML widget iframe ────────────────────────────────────────────
function WidgetEmbed({ label, path, token }) {
  const src = `${path}?token=${encodeURIComponent(token)}`
  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{label}</h3>
      <iframe
        src={src}
        title={label}
        className={styles.widgetIframe}
        loading="lazy"
        scrolling="no"
        frameBorder="0"
      />
    </div>
  )
}

function KOLTracker({ slug, token, labels }) {
  const { data, loading } = useData(slug, token, 'kol')
  if (loading) return <div className={styles.cardSkeleton} />
  const active = data?.filter(k => k.kolStatus === 'Active').length || 0
  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{labels.kol || 'KOL & Talent'}</h3>
      <DataCard label="Active KOLs" value={active} />
    </div>
  )
}

function MonthlyCampaigns({ slug, token, labels }) {
  const { data, loading } = useData(slug, token, 'monthly_campaigns')
  if (loading) return <div className={styles.cardSkeleton} />
  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{labels.monthlyCampaigns || 'Monthly Campaigns'}</h3>
      <DataCard label="Total" value={data?.length || 0} />
    </div>
  )
}
