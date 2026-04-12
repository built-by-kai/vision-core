/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prevent webpack from bundling binary-dependent packages
  // Required for @sparticuz/chromium + puppeteer-core to work in serverless functions
  serverExternalPackages: ['@sparticuz/chromium', 'puppeteer-core', 'pdfkit', 'fontkit', 'qrcode'],
  async rewrites() {
    const widgets = [
      // Revenue OS
      'proposals-payments', 'revenue-overview', 'deals', 'board',
      'potential', 'visitors', 'earnings', 'monthly', 'topproducts',
      'finance-snapshot',
      // Operations OS
      'projects', 'active',
      // Shared
      'meetings', 'schedule',
    ]
    return widgets.map(name => ({
      source:      `/widgets/${name}`,
      destination: `/widgets/${name}.html`,
    }))
  },
};

export default nextConfig;
