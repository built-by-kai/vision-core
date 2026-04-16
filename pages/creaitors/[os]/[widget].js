// pages/creaitors/[os]/[widget].js
// Serves Creaitors-specific widgets at /creaitors/[os]/[widget].
// Checks public/widgets/creaitors/[widget].html first (custom override),
// then falls back to public/widgets/[os]/[widget].html (standard template).
// No file duplication needed — creaitors/ folder is the override layer.

import fs from 'fs'
import path from 'path'

export default function WidgetPage() { return null }

export async function getServerSideProps({ params, res }) {
  const { os, widget } = params
  const publicDir = path.join(process.cwd(), 'public', 'widgets')

  const candidates = [
    path.join(publicDir, 'creaitors', `${widget}.html`), // custom override
    path.join(publicDir, os, `${widget}.html`),          // standard fallback
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
