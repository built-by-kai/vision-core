import { useData }   from '@/components/shared/useData'
import DataCard      from '@/components/shared/DataCard'
import styles        from '@/styles/widgets.module.css'

// Intelligence OS — fully custom per client.
// Renders only what's listed in custom_widgets.
export default function IntelligenceDashboard({ config, slug, token }) {
  const widgets = config.custom_widgets || []
  const labels  = config.labels || {}

  return (
    <div className={styles.grid}>
      {widgets.length === 0 && (
        <p className={styles.empty}>No widgets configured for this dashboard.</p>
      )}
      {widgets.map(w => (
        <CustomWidget key={w} widgetKey={w} slug={slug} token={token}
          label={labels[w] || w} config={config} />
      ))}
    </div>
  )
}

function CustomWidget({ widgetKey, slug, token, label, config }) {
  const dbKey = config.databases[widgetKey] ? widgetKey : null
  const { data, loading } = useData(slug, token, dbKey)

  if (!dbKey) return null
  if (loading) return <div className={styles.cardSkeleton} />

  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{label}</h3>
      <DataCard label="Total Records" value={data?.length ?? 0} />
    </div>
  )
}
