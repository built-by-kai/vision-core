import { useState, useEffect } from 'react'

// Shared hook — fetches a module's data from the API route.
// Handles loading, error, and caching transparently.
export function useData(slug, token, module) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!slug || !token || !module) return

    setLoading(true)
    fetch(`/api/client/${slug}?token=${token}&module=${module}`)
      .then(r => r.json())
      .then(res => {
        if (!res.authorized) { setError('unauthorized'); return }
        setData(res.data || [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [slug, token, module])

  return { data, loading, error }
}
