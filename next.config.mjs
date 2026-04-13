/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {},
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
  async rewrites() {
    return []
  },
  async redirects() {
    return [
      // Block /onboarding on dashboard subdomain — redirect to main domain
      {
        source: '/onboarding',
        has: [{ type: 'host', value: 'dashboard.opxio.io' }],
        destination: 'https://opxio.io/onboarding',
        permanent: false,
      },
      {
        source: '/onboarding/:path*',
        has: [{ type: 'host', value: 'dashboard.opxio.io' }],
        destination: 'https://opxio.io/onboarding',
        permanent: false,
      },
    ]
  },
}

export default nextConfig
