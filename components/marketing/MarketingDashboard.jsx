import { useData } from '@/components/shared/useData'
import DataCard    from '@/components/shared/DataCard'
import styles      from '@/styles/widgets.module.css'

export default function MarketingDashboard({ config, slug, token }) {
  const labels = config.labels || {}
  const custom = config.custom_widgets || []

  const { data: campaigns, loading: l1 } = useData(slug, token, 'campaigns')
  const { data: content,   loading: l2 } = useData(slug, token, 'content')
  const loading = l1 || l2

  const activeCampaigns  = campaigns?.filter(c => c.campaignStatus === 'Active') || []
  const inReview         = content?.filter(c => c.contentStatus === 'In Review') || []
  const published        = content?.filter(c => c.contentStatus === 'Published') || []
  const inProduction     = content?.filter(c => c.contentStatus === 'In Production') || []

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

          {/* KOL tracker add-on */}
          {custom.includes('kol_tracker') && (
            <KOLTracker slug={slug} token={token} labels={labels} />
          )}
          {custom.includes('monthly_campaigns') && (
            <MonthlyCampaigns slug={slug} token={token} labels={labels} />
          )}
        </>
      )}
    </section>
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
