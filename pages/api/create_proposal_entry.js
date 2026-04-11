// pages/api/create_proposal_entry.js
// Creates a new proposal entry in Notion Proposal CRM database

import { getPage } from '../../lib/notion.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract from either data.properties or properties at root level
    const props = req.body.data?.properties || req.body.properties || {};
    const pageId = req.body.data?.id || req.body.id;

    // Extract fields from Notion webhook payload
    function extractText(key) {
      const p = props[key];
      if (!p) return '';
      if (p.title)        return p.title.map(t => t.plain_text).join('');
      if (p.rich_text)    return p.rich_text.map(t => t.plain_text).join('');
      if (p.select)       return p.select.name;
      if (p.number !== undefined) return p.number;
      if (p.phone_number) return p.phone_number;
      if (p.email)        return p.email;
      return '';
    }

    function extractRelation(key) {
      const p = props[key];
      if (!p || !p.relation) return [];
      return p.relation.map(r => r.id);
    }

    const leadName = extractText('Lead Name');
    const packageType = extractText('Package Type');
    const estValue = Number(extractText('Estimated Value')) || 0;
    const overview = extractText('Overview');
    const companyIds = extractRelation('Company');
    const picIds = extractRelation('PIC Name');

    if (!leadName || !packageType || !companyIds.length || !picIds.length) {
      return res.status(400).json({
        error: 'Missing required fields: Lead Name, Package Type, Company, or PIC Name'
      });
    }

    const companyId = companyIds[0];
    const picId = picIds[0];

    // Fetch Company page to get Company name, Phone, Email
    const companyPage = await getPage(companyId, process.env.NOTION_API_KEY);
    const companyProps = companyPage.properties || {};

    function extractPageText(props, key) {
      const p = props[key];
      if (!p) return '';
      if (p.title)        return p.title.map(t => t.plain_text).join('');
      if (p.rich_text)    return p.rich_text.map(t => t.plain_text).join('');
      if (p.select)       return p.select.name;
      if (p.phone_number) return p.phone_number;
      if (p.email)        return p.email;
      return '';
    }

    const companyName = extractPageText(companyProps, 'Company');
    const companyPhone = extractPageText(companyProps, 'Phone');
    const companyEmail = extractPageText(companyProps, 'Email');

    // Fetch PIC page to get Name, Role, Phone
    const picPage = await getPage(picId, process.env.NOTION_API_KEY);
    const picProps = picPage.properties || {};

    const picName = extractPageText(picProps, 'Name');
    const picRole = extractPageText(picProps, 'Role');
    const picPhone = extractPageText(picProps, 'Phone');

    // Auto-generate ref number: PRO-YYMM-001
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const refNumber = `PRO-${yy}${mm}-001`;

    // Calculate dates
    const todayStr = now.toISOString().split('T')[0];
    const validUntil = new Date(now);
    validUntil.setDate(validUntil.getDate() + 14);
    const validUntilStr = validUntil.toISOString().split('T')[0];

    // Extract first sentence from Overview
    const overviewFirstLine = overview.split('\n')[0] || overview.split('.')[0] || '';

    // Use PIC phone if available, otherwise company phone
    const contactPhone = picPhone || companyPhone;

    // Create new page in Proposal CRM database
    const notionApiKey = process.env.NOTION_API_KEY;
    const databaseId = '1ad661f2679047749d16d2767291a30f';

    const notionBody = {
      parent: { database_id: databaseId },
      properties: {
        'Ref Number': {
          title: [{ text: { content: refNumber } }]
        },
        'Status': {
          select: { name: 'Draft' }
        },
        'Company Name': {
          rich_text: [{ text: { content: companyName } }]
        },
        'Contact Name': {
          rich_text: [{ text: { content: picName || leadName } }]
        },
        'Contact Role': {
          rich_text: [{ text: { content: picRole } }]
        },
        'Date': {
          date: { start: todayStr }
        },
        'Valid Until': {
          date: { start: validUntilStr }
        },
        'WhatsApp': {
          phone_number: contactPhone
        },
        'OS Type': {
          select: { name: packageType }
        },
        'Fee': {
          number: estValue
        },
        'Situation Line 1': {
          rich_text: [{ text: { content: overviewFirstLine } }]
        }
      }
    };

    const notionResponse = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionApiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(notionBody)
    });

    if (!notionResponse.ok) {
      const errorData = await notionResponse.json();
      return res.status(500).json({
        error: 'Failed to create Notion page',
        details: errorData
      });
    }

    const newPage = await notionResponse.json();

    return res.status(200).json({
      success: true,
      url: newPage.url,
      message: `Proposal entry created with ref number ${refNumber}`,
      refNumber
    });

  } catch (error) {
    console.error('Error in create_proposal_entry:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
}
