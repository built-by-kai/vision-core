import styles from '@/styles/dashboard.module.css'

const OS_LABELS = {
  sales:        'Sales OS',
  operations:   'Operations OS',
  business:     'Business OS',
  marketing:    'Marketing OS',
  intelligence: 'Intelligence OS',
  starter:      'Starter OS',
}

export default function Header({ clientName, osType }) {
  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <span className={styles.logo}>Opxio</span>
        <span className={styles.divider}>·</span>
        <span className={styles.clientName}>{clientName}</span>
      </div>
      <div className={styles.osTag}>{OS_LABELS[osType] ?? osType}</div>
    </header>
  )
}
