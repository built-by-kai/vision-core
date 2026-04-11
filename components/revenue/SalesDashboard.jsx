import { useData }    from '@/components/shared/useData'
import DataCard       from '@/components/shared/DataCard'
import PipelineChart  from './PipelineChart'
import styles         from '@/styles/widgets.module.css'

export default function SalesDashboard({ config, slug, token }) {
  const labels = config.labels || {}
  const { data: deals,  loading: l1 } = useData(slug, token, 'pipeline')
  const { data: quotes, loading: l2 } = useData(slug, token, 'quotations')
  const { data: invoices, loading: l3 } = useData(slug, token, 'invoices')

  const loading = l1 || l2 || l3

  // ── KPIs ────────────────────────────────────────────────
  const activeDeals = deals?.filter(d => !['Won', 'Lost'].includes(d.dealStage)) || []
  const wonDeals    = deals?.filter(d => d.dealStage === 'Won') || []
  const totalPipeline = activeDeals.reduce((s, d) => s + (d.dealValue || 0), 0)
  const totalWon      = wonDeals.reduce((s, d) => s + (d.dealValue || 0), 0)

  const pendingQuotes = quotes?.filter(q => q.quoteStatus === 'Draft') || []
  const approvedQuotes = quotes?.filter(q => q.quoteStatus === 'Approved') || []

  const totalCollected = invoices
    ?.filter(i => i.invoiceStatus === 'Paid')
    .reduce((s, i) => s + (i.invoiceAmount || 0), 0) || 0

  // ── Stage breakdown for pipeline chart ──────────────────
  const stageMap = {}
  for (const d of (deals || [])) {
    const stage = d.dealStage || 'Unknown'
    stageMap[stage] = (stageMap[stage] || 0) + 1
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        {labels.salesSection || 'Sales Overview'}
      </h2>

      {loading ? (
        <div className={styles.skeletonRow}>
          {[1,2,3,4].map(i => <div key={i} className={styles.cardSkeleton} />)}
        </div>
      ) : (
        <>
          <div className={styles.kpiRow}>
            <DataCard
              label={labels.deals || 'Active Deals'}
              value={activeDeals.length}
              sub={`RM ${totalPipeline.toLocaleString()} pipeline`}
            />
            <DataCard
              label={labels.won || 'Deals Won'}
              value={wonDeals.length}
              sub={`RM ${totalWon.toLocaleString()} closed`}
              accent
            />
            <DataCard
              label={labels.quotes || 'Pending Quotes'}
              value={pendingQuotes.length}
              sub={`${approvedQuotes.length} approved`}
            />
            <DataCard
              label={labels.collected || 'Revenue Collected'}
              value={`RM ${totalCollected.toLocaleString()}`}
            />
          </div>

          <PipelineChart stageMap={stageMap} labels={labels} />

          {/* Add-on widgets */}
          {config.custom_widgets?.includes('meetings_log') && (
            <MeetingsLog slug={slug} token={token} labels={labels} />
          )}
        </>
      )}
    </section>
  )
}

function MeetingsLog({ slug, token, labels }) {
  const { data, loading } = useData(slug, token, 'meetings')
  if (loading) return <div className={styles.cardSkeleton} />
  const upcoming = data?.filter(m => m.meetingDate >= new Date().toISOString().split('T')[0]) || []
  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{labels.meetings || 'Upcoming Meetings'}</h3>
      <DataCard label="Scheduled" value={upcoming.length} />
    </div>
  )
}
