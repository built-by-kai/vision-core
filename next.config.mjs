/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const widgets = [
      'revenue', 'deals', 'projects', 'active', 'meetings', 'schedule',
      'earnings', 'monthly', 'topproducts', 'potential', 'board',
      'visitors', 'combined',
    ]
    return widgets.map(name => ({
      source:      `/widgets/${name}`,
      destination: `/widgets/${name}.html`,
    }))
  },
};

export default nextConfig;
