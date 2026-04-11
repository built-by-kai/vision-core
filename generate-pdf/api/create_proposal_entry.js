// create_proposal_entry.js — Opxio Proposal CRM Entry Creator
// Vercel serverless function (Node.js runtime)
//
// Called by a Notion button on a Deals CRM page.
// Reads deal data + looks up Company/Contact, creates a pre-filled Proposal CRM entry.
//
// Notion button webhook → POST /api/create_proposal_entry
// Body: standard Notion button webhook payload (data.id + data.properties)

'use strict';

const NOTION_KEY  = process.env.NOTION_API_KEY || '';
const NOTION_VER  = '2022-06-28';
const PROPOSAL_DB = '1ad661f2679047749d16d2767291a30f'; // Proposal CRM database ID

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!NOTION_KEY) {
    return res.status(500).json({ error: 'NOTION_API_KEY not configured' });
  }

  try {
    const body  = req.body;
    const props = body.data?.properties || body.properties || {};
    const pageId = body.data?.id || body.id;

    // ── Read deal fields ─────────────────────────────────────────────────────
    const leadName    = titleText(props['Lead Name']);
    const packageType = selectText(props['Package Type']);
    const estValue    = props['Estimated Value']?.number || null;
    const overview    = props['Overview']?.rich_text?.map(t => t.plain_text).join('') || '';
    const notes       = props['Notes']?.rich_text?.map(t => t.plain_text).join('') || '';

    // Company and PIC are relations — fetch the first linked page each
    const companyId  = firstRelationId(props['Company']);
    const picIds     = relationIds(props['PIC Name']);

    const [company, pic] = await Promise.all([
      companyId ? fetchPage(companyId) : null,
      picIds.length ? fetchPage(picIds[0]) : null,
    ]);

    const companyName  = company ? titleText(company.properties['Company']) : '';
    const companyPhone = company?.properties['Phone']?.phone_number || '';
    const companyEmail = company?.properties['Email']?.email || '';

    const contactName  = pic ? titleText(pic.properties['Name']) : '';
    const contactRole  = pic?.properties['Role']?.select?.name || '';
    const contactPhone = pic?.properties['Phone']?.phone_number || '';

    // ── Build Proposal CRM entry ─────────────────────────────────────────────
    // Auto-generate ref number: PRO-YYMM-XXX
    const now    = new Date();
    const yymm   = String(now.getFullYear()).slice(2) + String(now.getMonth() + 1).padStart(2, '0');
    const refNum = `PRO-${yymm}-001`;

    const today     = now.toISOString().split('T')[0];
    const validDate = new Date(now.setDate(now.getDate() + 14)).toISOString().split('T')[0];

    // Situation Line 1 from Overview if present
    const situation1 = overview
      ? overview.split(/[.\n]/)[0].trim()
      : '';

    const newPage = await createProposalEntry({
      refNum,
      companyName,
      contactName,
      contactRole,
      whatsapp:    contactPhone || companyPhone,
      email:       companyEmail,
      osType:      packageType || '',
      fee:         estValue,
      today,
      validDate,
      situation1,
    });

    return res.status(200).json({
      success: true,
      url: newPage.url,
      message: `Proposal CRM entry created for ${companyName || leadName}`,
    });

  } catch (err) {
    console.error('[create_proposal_entry] error:', err.message);
    return res.status(400).json({ error: err.message });
  }
};

// ─── NOTION HELPERS ────────────────────────────────────────────────────────
async function notionRequest(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VER,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function fetchPage(pageId) {
  return notionRequest('GET', `/pages/${pageId}`);
}

async function createProposalEntry({ refNum, companyName, contactName, contactRole,
  whatsapp, email, osType, fee, today, validDate, situation1 }) {

  const properties = {
    'Ref Number':   { title: [{ text: { content: refNum } }] },
    'Status':       { select: { name: 'Draft' } },
    'Company Name': { rich_text: [{ text: { content: companyName || '' } }] },
    'Contact Name': { rich_text: [{ text: { content: contactName || '' } }] },
    'Contact Role': { rich_text: [{ text: { content: contactRole || '' } }] },
    'Date':         { date: { start: today } },
    'Valid Until':  { date: { start: validDate } },
  };

  if (whatsapp)    properties['WhatsApp']        = { phone_number: whatsapp };
  if (osType)      properties['OS Type']         = { select: { name: osType } };
  if (fee != null) properties['Fee']             = { number: fee };
  if (situation1)  properties['Situation Line 1']= { rich_text: [{ text: { content: situation1 } }] };

  return notionRequest('POST', '/pages', {
    parent: { database_id: PROPOSAL_DB },
    properties,
  });
}

// ─── PROPERTY HELPERS ──────────────────────────────────────────────────────
function titleText(prop) {
  if (!prop) return '';
  if (prop.title) return prop.title.map(t => t.plain_text).join('');
  return '';
}

function selectText(prop) {
  return prop?.select?.name || '';
}

function firstRelationId(prop) {
  const ids = prop?.relation;
  return ids?.length ? ids[0].id : null;
}

function relationIds(prop) {
  return (prop?.relation || []).map(r => r.id);
}
