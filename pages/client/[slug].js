import { useRouter }        from 'next/router'
import { useEffect, useState } from 'react'
import SalesDashboard      from '@/components/revenue/SalesDashboard'
import OperationsDashboard from '@/components/operations/OperationsDashboard'
import MarketingDashboard  from '@/components/marketing/MarketingDashboard'
import IntelligenceDashboard from '@/components/shared/IntelligenceDashboard'
import Header              from '@/components/shared/Header'
import styles              from '@/styles/dashboard.module.css'

export default function ClientDashboard() {
  const router = useRouter()
  const { slug, token } = router.query

  const [config,  setConfig]  = useState(null)
  const [loading, setLoading] = useState(true)
  const [denied,  setDenied]  = useState(false)

  useEffect(() => {
    if (!slug || !token) return

    fetch(`/api/client/${slug}?token=${token}&module=meta`)
      .then(r => r.json())
      .then(res => {
        if (!res.authorized) {
          setDenied(true)
        } else {
          setConfig(res.clientConfig)
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [slug, token])

  // Blank screen on invalid token — never explain why
  if (denied || (!loading && !config)) return null
  if (loading) return <div className={styles.loading}><span>Loading…</span></div>

  return (
    <div className={styles.shell}>
      <Header clientName={config.client_name} osType={config.os_type} />
      <main className={styles.main}>
        {renderDashboard(config, slug, token)}
      </main>
    </div>
  )
}

function renderDashboard(config, slug, token) {
  const props = { config, slug, token }

  switch (config.os_type) {
    case 'sales':
      return <SalesDashboard {...props} />
    case 'operations':
      return <OperationsDashboard {...props} />
    case 'business':
      return (
        <>
          <SalesDashboard {...props} />
          <OperationsDashboard {...props} />
        </>
      )
    case 'marketing':
      return <MarketingDashboard {...props} />
    case 'intelligence':
      return <IntelligenceDashboard {...props} />
    case 'starter':
      // Starter: render only what's in custom_widgets
      return <OperationsDashboard {...props} starterMode />
    default:
      return null
  }
}
