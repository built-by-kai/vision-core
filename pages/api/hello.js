// Debug endpoint to check deployed package versions
export default function handler(req, res) {
  try {
    const chromiumPkg = require('@sparticuz/chromium/package.json');
    const puppeteerPkg = require('puppeteer-core/package.json');
    res.status(200).json({
      chromium_version: chromiumPkg.version,
      puppeteer_version: puppeteerPkg.version,
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    });
  } catch (e) {
    res.status(200).json({ error: e.message, node_version: process.version });
  }
}
