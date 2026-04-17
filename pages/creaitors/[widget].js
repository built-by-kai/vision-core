// pages/creaitors/[widget].js
// Flat routing for Creaitors custom widgets — no OS segment needed.
// Lookup order:
//   1. public/widgets/creaitors/[widget].html  (custom override)
//   2. public/widgets/marketing/[widget].html  (standard fallback)
//   3. public/widgets/operations/[widget].html
//   4. public/widgets/revenue/[widget].html
// Pattern for all future custom clients: pages/[slug]/[widget].js

import fs from 'fs'
import path from 'path'

export default function WidgetPage() { return null }

// Maps clean short names → actual file names in standard OS folders
const WIDGET_ALIASES = {
  'content': 'content-production',
  'staff':   'staff-breakdown',
}

export async function getServerSideProps({ params, res }) {
  const { widget } = params
  const fileWidget = WIDGET_ALIASES[widget] || widget
  const publicDir = path.join(process.cwd(), 'public', 'widgets')

  const candidates = [
    path.join(publicDir, 'creaitors',   `${widget}.html`),     // exact match override first
    path.join(publicDir, 'creaitors',   `${fileWidget}.html`), // aliased override
    path.join(publicDir, 'marketing',   `${fileWidget}.html`),
    path.join(publicDir, 'operations',  `${fileWidget}.html`),
    path.join(publicDir, 'revenue',     `${fileWidget}.html`),
  ]

  let html = null
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      html = fs.readFileSync(candidate, 'utf8')
      break
    }
  }

  if (!html) return { notFound: true }

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.setHeader('X-Frame-Options', 'ALLOWALL')
  res.setHeader('Content-Security-Policy', 'frame-ancestors *')
  res.write(html)
  res.end()

  return { props: {} }
}
