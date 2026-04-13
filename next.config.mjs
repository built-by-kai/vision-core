/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {},
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
  async redirects() {
    return [
      // /onboarding on dashboard.opxio.io redirects permanently to opxio.io/onboarding
      {
        source: '/onboarding',
        has: [{ type: 'host', value: 'dashboard.opxio.io' }],
        destination: 'https://opxio.io/onboarding',
        permanent: true,
      },
      // catch query strings too
      {
        source: '/onboarding',
        has: [{ type: 'host', value: 'dashboard.opxio.io' }],
        destination: 'https://opxio.io/onboarding',
        permanent: true,
      },
    ]
  },
}

export default nextConfig
