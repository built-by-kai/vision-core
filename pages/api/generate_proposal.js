// pages/api/generate_proposal.js
// Generates PDF proposals from Notion data or direct POST request
// Handles both Notion webhook automation and direct API calls
//
// Note: Uses dynamic imports for @sparticuz/chromium to ensure the env var
// trick is applied BEFORE the module is first loaded (required for Node 24+
// on Vercel, where @sparticuz/chromium's auto-detection only handles Node ≤22).

import { renderProposal, mapNotionPayload, getPrefillPayload } from '../../lib/proposal_template.js';
import { uploadBlob } from '../../lib/blob.js';

export const config = {
  api: { responseLimit: false }
};

export const maxDuration = 60;

// Lazily loaded — called once per cold start
let _chromium = null;
let _puppeteer = null;

async function getChromium() {
  if (_chromium) return { chromium: _chromium, puppeteer: _puppeteer };

  // Trick @sparticuz/chromium into treating this runtime as Node 22/AL2023.
  // Without this, the package skips extracting the AL2023 shared libs bundle
  // (al2023.tar.br) and never sets LD_LIBRARY_PATH — causing libnss3.so errors
  // on Vercel's Node 24 runtime.
  if (!process.env.CODEBUILD_BUILD_IMAGE) {
    process.env.CODEBUILD_BUILD_IMAGE = 'nodejs22';
  }

  const chromiumMod = await import('@sparticuz/chromium');
  const puppeteerMod = await import('puppeteer-core');

  _chromium = chromiumMod.default;
  _puppeteer = puppeteerMod.default;

  return { chromium: _chromium, puppeteer: _puppeteer };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ─── PREFILL MODE ──────────────────────────────────────────────────────
    // ?action=prefill — patches Notion page with OS-type defaults so the user
    // can review/edit module and add-on fields before generating the PDF.
    if (req.query.action === 'prefill') {
      const notionPageId = req.body.data?.id || req.body.id;
      const props = req.body.data?.properties || req.body.properties || {};
      const osType = props['OS Type']?.select?.name || '';

      if (!notionPageId || !osType) {
        return res.status(400).json({ error: 'Missing page ID or OS Type — set OS Type first, then pre-fill.' });
      }

      const patchProperties = getPrefillPayload(osType);

      const notionRes = await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ properties: patchProperties }),
      });

      if (!notionRes.ok) {
        const err = await notionRes.json();
        return res.status(500).json({ error: 'Notion patch failed', details: err });
      }

      return res.status(200).json({ success: true, prefilled: true, os_type: osType });
    }

    // ─── GENERATE PDF MODE ────────────────────────────────────────────────
    let proposalData = null;
    let notionPageId = null;
    const isNotionMode = req.query.source === 'notion';

    if (isNotionMode) {
      notionPageId = req.body.data?.id || req.body.id;
      proposalData = mapNotionPayload(req.body);
    } else {
      proposalData = req.body;
    }

    // Validate required fields
    const requiredFields = ['company_name', 'contact_name', 'os_type', 'fee', 'modules'];
    for (const field of requiredFields) {
      if (!proposalData[field]) {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }

    const html = renderProposal(proposalData);

    // Load chromium + puppeteer with env fix applied
    const { chromium, puppeteer } = await getChromium();

    const executablePath = await chromium.executablePath();

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true,
    });

    await browser.close();

    if (isNotionMode) {
      // Upload to Vercel Blob — returns { url, pathname }
      const filename = `proposal-${proposalData.ref_number || 'draft'}.pdf`;
      const { url: pdfUrl } = await uploadBlob(filename, pdfBuffer);

      // Patch Notion page PDF property with the blob URL
      const notionApiKey = process.env.NOTION_API_KEY;
      await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${notionApiKey}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: { 'PDF': { url: pdfUrl } }
        })
      });

      return res.status(200).json({ success: true, filename, pdf_url: pdfUrl });
    } else {
      const filename = `proposal-${proposalData.ref_number || 'draft'}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(pdfBuffer);
    }

  } catch (error) {
    console.error('Error in generate_proposal:', error);
    return res.status(500).json({
      error: 'Failed to generate proposal',
      details: error.message
    });
  }
}

