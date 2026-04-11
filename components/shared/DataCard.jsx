import styles from '@/styles/widgets.module.css'

export default function DataCard({ label, value, sub, accent }) {
  return (
    <div className={`${styles.card} ${accent ? styles.cardAccent : ''}`}>
      <p className={styles.cardLabel}>{label}</p>
      <p className={styles.cardValue}>{value ?? '—'}</p>
      {sub && <p className={styles.cardSub}>{sub}</p>}
    </div>
  )
}
