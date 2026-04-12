// lib/puppeteer.js — Serverless Puppeteer helper for Vercel
// Uses @sparticuz/chromium + puppeteer-core via dynamic imports

let _browser = null

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser

  // @sparticuz/chromium checks AWS_EXECUTION_ENV to determine which shared libraries
  // to extract (libnss3 etc). Vercel doesn't set this, so we must set it before import
  // so the module init code runs setupLambdaEnvironment("/tmp/al2023/lib") correctly.
  if (!process.env.AWS_EXECUTION_ENV) {
    process.env.AWS_EXECUTION_ENV = "AWS_Lambda_nodejs20.x"
  }

  // Dynamic imports prevent Next.js from bundling these CJS packages
  const { default: chromium } = await import("@sparticuz/chromium")
  const { default: puppeteer } = await import("puppeteer-core")

  // Disable graphics mode to skip swiftshader extraction (saves time + /tmp space)
  chromium.setGraphicsMode = false

  const execPath = await chromium.executablePath()
  console.log("[puppeteer] executablePath:", execPath)

  _browser = await puppeteer.launch({
    args:            chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath:  execPath,
    headless:        chromium.headless,
  })
  return _browser
}

/**
 * Renders an HTML string to a PDF buffer.
 * @param {string} html — full HTML page
 * @param {object} opts — puppeteer page.pdf() options (merged with defaults)
 * @returns {Promise<Buffer>}
 */
export async function htmlToPdf(html, opts = {}) {
  const browser = await getBrowser()
  const page    = await browser.newPage()

  try {
    // "domcontentloaded" instead of "networkidle0" so we don't block on Google Fonts
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 })
    // Give fonts a moment to load before capturing
    await new Promise(r => setTimeout(r, 2000))

    const pdfBuffer = await page.pdf({
      format:           "A4",
      printBackground:  true,
      margin:           { top: 0, right: 0, bottom: 0, left: 0 },
      ...opts,
    })

    return pdfBuffer
  } finally {
    await page.close()
  }
}
