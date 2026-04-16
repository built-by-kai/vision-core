// pages/marketing/[widget].js
// Serves widget HTML from /public/widgets/marketing/ first,
// falls back to /public/widgets/creaitors/ if not found there.
// This lets all OS widgets live under /marketing/:name regardless of client folder.

import fs from 'fs'
import path from 'path'

export default function WidgetPage() {
  // Rendered server-side — component is never used
  return null
}

export async function getServerSideProps({ params, req, res, query }) {
  const name = params.widget
  const publicDir = path.join(process.cwd(), 'public', 'widgets')

  const candidates = [
    path.join(publicDir, 'marketing', `${name}.html`),
    path.join(publicDir, 'creaitors', `${name}.html`),
  ]

  let html = null
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      html = fs.readFileSync(candidate, 'utf8')
      break
    }
  }

  if (!html) {
    return { notFound: true }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('X-Frame-Options', 'ALLOWALL')
  res.setHeader('Content-Security-Policy', 'frame-ancestors *')
  res.write(html)
  res.end()

  return { props: {} }
}
