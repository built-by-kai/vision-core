import styles from '@/styles/widgets.module.css'

const STAGE_ORDER = [
  'New Lead', 'Contacted', 'Discovery Call', 'Proposal Sent',
  'Negotiation', 'Won – Pending Deposit', 'Won', 'Lost'
]

export default function PipelineChart({ stageMap, labels }) {
  const stages  = STAGE_ORDER.filter(s => stageMap[s])
  const maxVal  = Math.max(...stages.map(s => stageMap[s]), 1)

  if (!stages.length) return null

  return (
    <div className={styles.widgetBlock}>
      <h3 className={styles.widgetTitle}>{labels.pipeline || 'Pipeline by Stage'}</h3>
      <div className={styles.barChart}>
        {stages.map(stage => (
          <div key={stage} className={styles.barRow}>
            <span className={styles.barLabel}>{stage}</span>
            <div className={styles.barTrack}>
              <div
                className={styles.barFill}
                style={{ width: `${(stageMap[stage] / maxVal) * 100}%` }}
              />
            </div>
            <span className={styles.barCount}>{stageMap[stage]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
