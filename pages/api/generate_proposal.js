// pages/api/generate_proposal.js
// Generates PDF proposals from Notion data or direct POST request
// Handles both Notion webhook automation and direct API calls
//
// Note: Uses dynamic imports for @sparticuz/chromium to ensure the env var
// trick is applied BEFORE the module is first loaded (required for Node 24+
// on Vercel, where @sparticuz/chromium's auto-detection only handles Node ≤22).

import { renderProposal, mapNotionPayload, getPrefillPayload, OS_DEFAULT_MODULES, OS_DEFAULT_ADDONS_LATER } from '../../lib/proposal_template.js';
import { uploadBlob } from '../../lib/blob.js';

const NOTION_HDRS = () => ({
  'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
});

// ── mapQuotationPayload ───────────────────────────────────────────────────────
// Builds proposalData from a Quotation page instead of a Proposals CRM page.
// Fetches related Company and PIC pages to resolve names.
async function mapQuotationPayload(body) {
  const hdrs = NOTION_HDRS();
  const props = body.data?.properties || body.properties || {};

  // Helper: extract plain text from various Notion property types
  const txt = (p) => {
    if (!p) return '';
    if (p.title)   return p.title.map(t => t.plain_text).join('');
    if (p.rich_text) return p.rich_text.map(t => t.plain_text).join('');
    if (p.select)  return p.select?.name || '';
    if (p.number !== undefined) return p.number ?? '';
    if (p.phone_number) return p.phone_number;
    if (p.formula) return (p.formula?.string || p.formula?.number) ?? '';
    if (p.date)    return p.date?.start || '';
    return '';
  };

  // OS type — "Package Type" on Quotation is rich_text
  const osType = txt(props['Package Type']) || txt(props['OS Type']) || '';

  // Ref number from Notion unique_id
  const uid = props['Quotation No.']?.unique_id;
  const refNumber = uid
    ? `${uid.prefix || 'QUO'}-${String(uid.number).padStart(3, '0')}`
    : (txt(props['Ref Number']) || '');

  // Issue date + valid until (30 days)
  const issueDate = txt(props['Issue Date']) || new Date().toISOString().split('T')[0];
  const validDate = (() => {
    const d = new Date(issueDate);
    d.setDate(d.getDate() + 30);
    return d.toISOString().split('T')[0];
  })();

  // Fee — try several possible property names
  const fee = props['Total']?.formula?.number
    ?? props['Amount']?.formula?.number
    ?? props['Fee']?.number
    ?? props['Grand Total']?.formula?.number
    ?? 0;

  // Fetch Company page for company name
  let companyName = '';
  const companyIds = (props['Company']?.relation || []).map(r => r.id);
  if (companyIds.length > 0) {
    try {
      const r = await fetch(`https://api.notion.com/v1/pages/${companyIds[0]}`, { headers: hdrs });
      if (r.ok) {
        const pg = await r.json();
        for (const v of Object.values(pg.properties || {})) {
          if (v.type === 'title') { companyName = txt(v); break; }
        }
      }
    } catch (e) { console.error('Company fetch:', e.message); }
  }

  // Fetch PIC page for contact name + phone
  let contactName = '', contactRole = '', whatsapp = '';
  const picIds = (props['PIC']?.relation || []).map(r => r.id);
  if (picIds.length > 0) {
    try {
      const r = await fetch(`https://api.notion.com/v1/pages/${picIds[0]}`, { headers: hdrs });
      if (r.ok) {
        const pg = await r.json();
        const pp = pg.properties || {};
        for (const v of Object.values(pp)) {
          if (v.type === 'title') { contactName = txt(v); break; }
        }
        whatsapp = txt(pp['Phone'] || pp['WhatsApp'] || pp['Mobile'] || null);
        contactRole = txt(pp['Role'] || pp['Title'] || pp['Position'] || null);
      }
    } catch (e) { console.error('PIC fetch:', e.message); }
  }

  // Modules from OS defaults (same logic as Proposals CRM mode)
  const modules = OS_DEFAULT_MODULES[osType] || {};
  const addons_later = OS_DEFAULT_ADDONS_LATER[osType] || [];

  return {
    ref_number:   refNumber,
    date:         issueDate,
    valid_until:  validDate,
    company_name: companyName,
    contact_name: contactName,
    contact_role: contactRole,
    whatsapp,
    email:        'hello@opxio.io',
    website:      'opxio.io',
    os_type:      osType,
    install_tier: txt(props['Install Tier']) || 'Standard',
    fee,
    modules,
    addons_later,
    addons_now:   [],
  };
}

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
    const isNotionMode  = req.query.source === 'notion';
    const fromQuotation = req.query.from   === 'quotation';

    if (isNotionMode) {
      notionPageId = req.body.data?.id || req.body.id;

      if (fromQuotation) {
        // ── QUOTATION MODE ───────────────────────────────────────────────────
        // Triggered from the Quotation page. Fetches company + PIC from Notion
        // relations and builds modules from OS type defaults.
        proposalData = await mapQuotationPayload(req.body);
      } else {
        // ── PROPOSALS CRM MODE ───────────────────────────────────────────────
        proposalData = mapNotionPayload(req.body);
      }
    } else {
      proposalData = req.body;
    }

    // ─── AUTO-PREFILL (Proposals CRM mode only) ──────────────────────────────
    // Quotation mode already has correct modules from OS_DEFAULT_MODULES.
    // Apply OS-type defaults if the module fields are empty OR look like stale
    // test data (avg ≤ 1 module per group). Patches Notion in the background
    // so the user sees full content on the page after generating.
    if (isNotionMode && notionPageId && !fromQuotation) {
      const rawProps = req.body.data?.properties || req.body.properties || {};
      const osType = rawProps['OS Type']?.select?.name || proposalData.os_type || '';

      const modGroups = proposalData.modules ? Object.values(proposalData.modules) : [];
      const totalMods = modGroups.reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
      // "stale" = every group has exactly 1 module (test data) or everything is empty
      const looksStale = totalMods === 0 || (modGroups.length > 0 && totalMods <= modGroups.length);

      if (looksStale && osType && OS_DEFAULT_MODULES[osType]) {
        proposalData.modules = OS_DEFAULT_MODULES[osType];

        if (!proposalData.addons_later?.length && OS_DEFAULT_ADDONS_LATER[osType]) {
          proposalData.addons_later = OS_DEFAULT_ADDONS_LATER[osType];
        }

        // Fire-and-forget: patch the Notion page so fields show populated
        const patchProperties = getPrefillPayload(osType);
        fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ properties: patchProperties }),
        }).catch(err => console.error('Auto-prefill Notion patch error:', err));
      }
    }

    // Validate only the truly blocking fields — company name and OS type.
    // fee=0 is valid, contact_name can be blank (renders gracefully).
    if (!proposalData.company_name) {
      return res.status(400).json({ error: 'Missing required field: company_name' });
    }
    if (!proposalData.os_type) {
      return res.status(400).json({ error: 'Missing required field: os_type — set OS Type on the Notion page first.' });
    }
    // Modules must exist after auto-prefill
    if (!proposalData.modules || Object.keys(proposalData.modules).length === 0) {
      return res.status(400).json({ error: 'Missing required field: modules — set OS Type so defaults can be applied.' });
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

