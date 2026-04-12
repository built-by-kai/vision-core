// pages/api/generate_proposal.js
// Generates PDF proposals from Notion data or direct POST request
// Handles both Notion webhook automation and direct API calls

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { renderProposal, mapNotionPayload } from '../../lib/proposal_template.js';
import { uploadBlob } from '../../lib/blob.js';

export const config = {
  api: { responseLimit: false }
};

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let proposalData = null;
    let notionPageId = null;
    const isNotionMode = req.query.source === 'notion';

    if (isNotionMode) {
      // Notion webhook mode: map payload from Notion
      notionPageId = req.body.data?.id || req.body.id;
      proposalData = mapNotionPayload(req.body);
    } else {
      // Direct POST mode: use provided data
      proposalData = req.body;
    }

    // Validate required fields
    const requiredFields = ['company_name', 'contact_name', 'os_type', 'fee', 'modules'];
    for (const field of requiredFields) {
      if (!proposalData[field]) {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }

    // Generate HTML from proposal data
    const html = renderProposal(proposalData);

    // Generate PDF using Puppeteer + Chromium
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
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

      // Patch the Notion page PDF property with the blob URL
      const notionApiKey = process.env.NOTION_API_KEY;
      await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${notionApiKey}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            'PDF': { url: pdfUrl }
          }
        })
      });

      return res.status(200).json({
        success: true,
        filename,
        pdf_url: pdfUrl
      });
    } else {
      // Direct mode: return PDF as download
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
