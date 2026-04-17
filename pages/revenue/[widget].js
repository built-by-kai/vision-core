import fs from 'fs'
import path from 'path'

export default function WidgetPage() { return null }

export async function getServerSideProps({ params, res }) {
  const name = params.widget
  const filePath = path.join(process.cwd(), 'public', 'widgets', 'revenue', `${name}.html`)

  if (!fs.existsSync(filePath)) return { notFound: true }

  const html = fs.readFileSync(filePath, 'utf8')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.setHeader('X-Frame-Options', 'ALLOWALL')
  res.setHeader('Content-Security-Policy', 'frame-ancestors *')
  res.write(html)
  res.end()

  return { props: {} }
}
