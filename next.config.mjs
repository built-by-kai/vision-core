/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Don't bundle native/binary packages — let Node.js require() them at runtime
      config.externals = [
        ...((config.externals) || []),
        "puppeteer-core",
        "@sparticuz/chromium",
      ]
    }
    return config
  },
}

export default nextConfig
