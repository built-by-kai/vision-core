import styles from '@/styles/widgets.module.css'

const STATUS_COLOR = {
  'Not Started': '#9CA3AF',
  'In Progress':  '#3B82F6',
  'Done':         '#10B981',
  'Blocked':      '#EF4444',
}

export default function PhaseTracker({ phases, labels }) {
  if (!phases?.length) return null

  const active = phases
    .filter(p => p.phaseStatus !== 'Done')
    .sort((a, b) => (a.phaseDue || '').localeCompare(b.phaseDue || ''))
    .slice(0, 8)

  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{labels.phases || 'Active Phases'}</h3>
      <div className={styles.phaseList}>
        {active.map(ph => (
          <div key={ph._id} className={styles.phaseRow}>
            <span
              className={styles.phaseStatus}
              style={{ background: STATUS_COLOR[ph.phaseStatus] || '#9CA3AF' }}
            />
            <span className={styles.phaseName}>{ph.phaseName || '—'}</span>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressFill}
                style={{ width: `${ph.phaseProgress || 0}%` }}
              />
            </div>
            <span className={styles.phaseProgress}>{ph.phaseProgress || 0}%</span>
            <span className={styles.phaseDue}>{ph.phaseDue || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
