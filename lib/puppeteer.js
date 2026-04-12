// lib/puppeteer.js — Serverless Puppeteer helper for Vercel
// Uses @sparticuz/chromium + puppeteer-core (no full Chrome install needed)

import chromium from "@sparticuz/chromium"
import puppeteer from "puppeteer-core"

let _browser = null

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser
  _browser = await puppeteer.launch({
    args:            chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath:  await chromium.executablePath(),
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
    // Give fonts a moment to load before rendering
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
