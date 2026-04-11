import { useData }        from '@/components/shared/useData'
import DataCard           from '@/components/shared/DataCard'
import PhaseTracker       from './PhaseTracker'
import styles             from '@/styles/widgets.module.css'

export default function OperationsDashboard({ config, slug, token, starterMode }) {
  const labels = config.labels || {}
  const custom = config.custom_widgets || []

  const { data: projects, loading: l1 } = useData(slug, token, 'projects')
  const { data: phases,   loading: l2 } = useData(slug, token, 'phases')
  const loading = l1 || l2

  // ── KPIs ────────────────────────────────────────────────
  const active    = projects?.filter(p => p.projectStatus === 'Active') || []
  const completed = projects?.filter(p => p.projectStatus === 'Completed') || []
  const atRisk    = projects?.filter(p => p.projectStatus === 'At Risk') || []

  const avgProgress = active.length
    ? Math.round(active.reduce((s, p) => s + (p.projectProgress || 0), 0) / active.length)
    : 0

  const overduePhasesCount = phases?.filter(ph => {
    if (!ph.phaseDue || ph.phaseStatus === 'Done') return false
    return ph.phaseDue < new Date().toISOString().split('T')[0]
  }).length || 0

  // In starter mode, only show if ops databases are configured
  if (starterMode && !config.databases?.projects) return null

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        {labels.opsSection || 'Operations Overview'}
      </h2>

      {loading ? (
        <div className={styles.skeletonRow}>
          {[1,2,3,4].map(i => <div key={i} className={styles.cardSkeleton} />)}
        </div>
      ) : (
        <>
          <div className={styles.kpiRow}>
            <DataCard
              label={labels.activeProjects || 'Active Projects'}
              value={active.length}
              sub={`${avgProgress}% avg progress`}
            />
            <DataCard
              label={labels.completed || 'Completed'}
              value={completed.length}
            />
            <DataCard
              label={labels.atRisk || 'At Risk'}
              value={atRisk.length}
              accent={atRisk.length > 0}
            />
            <DataCard
              label={labels.overduePhases || 'Overdue Phases'}
              value={overduePhasesCount}
              accent={overduePhasesCount > 0}
            />
          </div>

          <PhaseTracker phases={phases} labels={labels} />

          {/* Add-on widgets */}
          {custom.includes('client_health') && (
            <ClientHealth slug={slug} token={token} labels={labels} />
          )}
          {custom.includes('team_capacity') && (
            <TeamCapacity slug={slug} token={token} labels={labels} />
          )}
          {custom.includes('vendor_tracker') && (
            <VendorTracker slug={slug} token={token} labels={labels} />
          )}
        </>
      )}
    </section>
  )
}

function ClientHealth({ slug, token, labels }) {
  const { data, loading } = useData(slug, token, 'client_health')
  if (loading) return <div className={styles.cardSkeleton} />
  const healthy  = data?.filter(c => c.healthStatus === 'Healthy').length || 0
  const atRisk   = data?.filter(c => c.healthStatus === 'At Risk').length || 0
  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{labels.clientHealth || 'Client Health'}</h3>
      <div className={styles.kpiRow}>
        <DataCard label="Healthy" value={healthy} />
        <DataCard label="At Risk"  value={atRisk}  accent={atRisk > 0} />
      </div>
    </div>
  )
}

function TeamCapacity({ slug, token, labels }) {
  const { data, loading } = useData(slug, token, 'team_capacity')
  if (loading) return <div className={styles.cardSkeleton} />
  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{labels.teamCapacity || 'Team Capacity'}</h3>
      <DataCard label="Team Members Tracked" value={data?.length || 0} />
    </div>
  )
}

function VendorTracker({ slug, token, labels }) {
  const { data, loading } = useData(slug, token, 'vendors')
  if (loading) return <div className={styles.cardSkeleton} />
  const active = data?.filter(v => v.vendorStatus === 'Active').length || 0
  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{labels.vendors || 'Vendors & Freelancers'}</h3>
      <DataCard label="Active" value={active} />
    </div>
  )
}
