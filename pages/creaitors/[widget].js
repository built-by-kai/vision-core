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

export async function getServerSideProps({ params, res }) {
  const { widget } = params
  const publicDir = path.join(process.cwd(), 'public', 'widgets')

  const candidates = [
    path.join(publicDir, 'creaitors',   `${widget}.html`),
    path.join(publicDir, 'marketing',   `${widget}.html`),
    path.join(publicDir, 'operations',  `${widget}.html`),
    path.join(publicDir, 'revenue',     `${widget}.html`),
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
  res.setHeader('X-Frame-Options', 'ALLOWALL')
  res.setHeader('Content-Security-Policy', 'frame-ancestors *')
  res.write(html)
  res.end()

  return { props: {} }
}
