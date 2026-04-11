// generate_proposal.js — Opxio Proposal Generator
// Vercel serverless function (Node.js runtime)
//
// POST /api/generate_proposal?key=SECRET
//   Body: direct proposal JSON → returns PDF
//
// POST /api/generate_proposal?key=SECRET&source=notion
//   Body: Notion automation webhook → maps properties → returns PDF

'use strict';

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { renderProposal, mapNotionPayload } = require('./proposal_template');

const SECRET = process.env.PROPOSAL_SECRET || '';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth — only enforced if PROPOSAL_SECRET env var is set
  if (SECRET) {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    // Map payload
    const isNotion = req.query.source === 'notion';
    const data = isNotion ? mapNotionPayload(req.body) : req.body;

    // Validate
    const required = ['company_name', 'contact_name', 'os_type', 'fee', 'modules'];
    for (const field of required) {
      if (!data[field]) throw new Error(`Missing required field: ${field}`);
    }
    if (typeof data.modules !== 'object' || Array.isArray(data.modules)) {
      throw new Error('modules must be an object: { "Revenue OS": ["CRM & Pipeline", ...] }');
    }

    // Render & convert
    const html = renderProposal(data);
    const pdf  = await htmlToPdf(html);

    const filename = `Opxio-Proposal-${sanitize(data.company_name)}-${data.ref_number || 'draft'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(pdf);

  } catch (err) {
    console.error('[generate_proposal] error:', err.message);
    return res.status(400).json({ error: err.message });
  }
};

async function htmlToPdf(html) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

function sanitize(str) {
  return String(str || '').replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-');
}
