/** @type {import('next').NextConfig} */
const nextConfig = {
  // Empty turbopack config to silence Next.js 16 Turbopack warning
  turbopack: {},
  // serverExternalPackages: tells Next.js not to bundle these packages
  // for server-side code — lets Node.js require() them from node_modules at runtime.
  // This is the modern (Next.js 14.2+) way to handle native/binary packages.
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
}

export default nextConfig
