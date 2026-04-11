// generate_proposal.js — Opxio Proposal Generator
// Vercel serverless function (Node.js runtime)
//
// POST /api/generate_proposal?source=notion
//   Body: Notion automation webhook → generates PDF → uploads back to Notion page
//
// POST /api/generate_proposal
//   Body: direct proposal JSON → returns PDF as download

'use strict';

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { renderProposal, mapNotionPayload } = require('./proposal_template');

const SECRET       = process.env.PROPOSAL_SECRET || '';
const NOTION_KEY   = process.env.NOTION_API_KEY  || '';
const NOTION_VER   = '2022-06-28';

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

  const isNotion = req.query.source === 'notion';

  try {
    const data   = isNotion ? mapNotionPayload(req.body) : req.body;
    const pageId = isNotion ? (req.body.data?.id || req.body.id || null) : null;

    // Validate
    const required = ['company_name', 'contact_name', 'os_type', 'fee', 'modules'];
    for (const field of required) {
      if (!data[field]) throw new Error(`Missing required field: ${field}`);
    }

    const html     = renderProposal(data);
    const pdf      = await htmlToPdf(html);
    const filename = `Opxio-Proposal-${sanitize(data.company_name)}-${data.ref_number || 'draft'}.pdf`;

    if (isNotion && pageId) {
      // Upload PDF back to the Notion page
      await uploadToNotion(pdf, filename, pageId);
      return res.status(200).json({ success: true, filename });
    }

    // Direct call — return PDF as download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(pdf);

  } catch (err) {
    console.error('[generate_proposal] error:', err.message);
    return res.status(400).json({ error: err.message });
  }
};

// ─── PDF GENERATION ────────────────────────────────────────────────────────
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

// ─── NOTION FILE UPLOAD ────────────────────────────────────────────────────
// 1. Init upload  →  2. Send file  →  3. Attach to page as a file block
async function uploadToNotion(pdf, filename, pageId) {
  if (!NOTION_KEY) throw new Error('NOTION_API_KEY env var not set');

  const authHeaders = {
    'Authorization': `Bearer ${NOTION_KEY}`,
    'Notion-Version': NOTION_VER,
  };

  // Step 1 — initialise upload
  const initRes = await fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content_type: 'application/pdf' }),
  });
  const init = await initRes.json();
  if (!init.id) throw new Error(`Notion file upload init failed: ${JSON.stringify(init)}`);

  // Step 2 — send file bytes
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), filename);

  const sendRes = await fetch(`https://api.notion.com/v1/file_uploads/${init.id}/send`, {
    method: 'POST',
    headers: authHeaders,
    body: form,
  });
  const sent = await sendRes.json();
  if (sent.status !== 'uploaded') throw new Error(`Notion file send failed: ${JSON.stringify(sent)}`);

  // Step 3 — attach as a file block on the proposal page
  await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      children: [{
        type: 'file',
        file: {
          type: 'file_upload',
          file_upload: { id: init.id },
          name: filename,
        },
      }],
    }),
  });
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function sanitize(str) {
  return String(str || '').replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-');
}
