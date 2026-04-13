// pages/api/onboarding.js
// Receives onboarding form submission
// Writes to Notion Client Implementation Form database
// Updates the linked Deal row with Client Intake relation
// Sends WhatsApp notification to Opxio team

// ── ENV VARS NEEDED IN .env.local + Vercel dashboard ──────────────────────
// NOTION_API_KEY=ntn_...
// NOTION_CLIENT_INTAKE_DB=b6167b39-b1b4-40a7-bd98-cd74e2d95458
// NOTION_DEALS_DB=088fe600-97f6-8307-9c70-87cfbfe6dab7
// WHATSAPP_API_URL=https://... (your WA Business API or Wati/Twilio endpoint)
// WHATSAPP_API_TOKEN=...
// OPXIO_NOTIFY_NUMBER=60... (your number to receive notification)

import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const DB = process.env.NOTION_CLIENT_INTAKE_DB || 'b6167b39-b1b4-40a7-bd98-cd74e2d95458';

// ── HELPERS ────────────────────────────────────────────────────────────────

function richText(str) {
  return [{ type: 'text', text: { content: String(str || '').slice(0, 2000) } }];
}

function selectProp(val) {
  if (!val) return null;
  return { select: { name: String(val) } };
}

function multiSelectProp(arr) {
  if (!arr || !arr.length) return null;
  const options = arr.filter(Boolean).map(v => ({ name: String(v).slice(0, 100) }));
  return options.length ? { multi_select: options } : null;
}

function textProp(val) {
  if (!val) return null;
  return { rich_text: richText(val) };
}

function urlProp(val) {
  if (!val) return null;
  try { new URL(val); return { url: val }; } catch { return null; }
}

function buildSteps(items) {
  if (!items || !items.length) return '';
  return items
    .map((item, i) => `${i + 1}. ${item.value || ''}`)
    .filter(s => s.trim() !== `${s[0]}.`)
    .join('\n');
}

function buildStages(items) {
  if (!items || !items.length) return '';
  return items.map(i => i.value || '').filter(Boolean).join(' → ');
}

// ── NOTION PROPERTY MAP ────────────────────────────────────────────────────
function buildNotionProperties(data) {
  const {
    clientName, osPackage, addons, dealId,
    businessDesc, teamSize, teamMembers, industry,
    notionUrl, notionPlan, notionUsage,
    notionAccess, notionPermissions, existingData, existingDataLinks, comms,
    leadSources, leadTracking, leadVolume, leadInfo,
    pipelineStages, customStages, salesSteps, activeDeals,
    dealTracking, dealStuck, dealCurrency,
    proposalMethod, proposalTracking, contractType,
    invoiceMethod, paymentTerms, paymentTermsOther, paymentMethods,
    invoiceTracking, paymentProblems, paymentWhatsapp, paymentWhatsappType, invoiceOwner,
    projectTypes, deliverySteps, projectStages, customProjectStages, activeProjects, projectStuck,
    taskTracking, taskStages, taskStagesCustom, taskFields, taskProblems, taskOwner,
    onboardingSteps, onboardingCollect, onboardingProblems,
    existingChecklist, checklistLinks, onboardingConsistency,
    existingSOPs, sopLinks, prioritySOPs,
    dashboardViewers, dashboardKPIs, dashboardKPIother,
    addonLeadSources, addonLeadFields, leadAlertMethod, leadAlertNumber, leadAlertType,
    brandKit, brandKitLink, brandColor1, brandColor1Name, brandColor2, brandColor2Name, brandFonts, logoLink,
    setupLinks, automationWishes, businessTerms, anythingElse,
  } = data;

  const props = {
    'Client Name': { title: richText(clientName || 'Unknown') },
    'Intake Status': { select: { name: 'Submitted' } },
  };

  // OS Package
  if (osPackage) props['OS Package'] = selectProp(osPackage);
  // Add-ons
  if (addons?.length) props['Add-ons'] = multiSelectProp(addons);
  // Deal relation
  if (dealId) props['Deal'] = { relation: [{ id: dealId }] };

  // Business
  if (teamSize) props['Team Size'] = selectProp(teamSize);
  if (industry) props['Main User'] = textProp(
    teamMembers?.filter(m => m.name).map(m => `${m.name} — ${m.role}`).join(', ')
  );
  if (notionUrl) props['Notion Workspace URL'] = urlProp(notionUrl);
  if (notionPlan) props['Notion Plan'] = selectProp(notionPlan);
  if (notionUsage) props['Uses Notion'] = selectProp(
    notionUsage === 'Daily' ? 'Daily' :
    notionUsage === 'Sometimes' ? 'Sometimes' : 'New to it'
  );
  if (existingData) props['Has Existing Data'] = selectProp(
    existingData === 'Yes — I have data' ? 'Yes' : 'No'
  );
  if (comms) props['Comms Preference'] = selectProp(comms);

  // Revenue OS
  if (leadSources?.length) props['Lead Sources'] = multiSelectProp(leadSources);
  if (leadTracking) props['Pipeline Tracked How'] = selectProp(
    leadTracking === 'WhatsApp threads' ? 'WhatsApp' :
    leadTracking === 'A CRM tool' ? 'CRM tool' :
    leadTracking === 'Notion already' ? 'CRM tool' : leadTracking
  );
  if (activeDeals) props['Active Leads Volume'] = selectProp(
    activeDeals === '1–3' ? 'Under 10' :
    activeDeals === '3–10' ? '10–30' :
    activeDeals === '10–20' ? '30–50' : '50+'
  );
  if (dealCurrency) props['Invoice Currency'] = selectProp(
    dealCurrency === 'MYR' ? 'MYR' :
    dealCurrency === 'USD' ? 'USD' :
    dealCurrency === 'SGD' ? 'SGD' : 'Other'
  );

  // Pipeline stages
  if (pipelineStages === 'I have my own stages' && customStages?.length) {
    props['Custom Pipeline Stages'] = textProp(buildStages(customStages));
    props['Pipeline Stages'] = selectProp('Custom');
  } else {
    props['Pipeline Stages'] = selectProp('Use default');
  }

  // Sales stages as delivery process
  if (salesSteps?.length) props['Delivery Process'] = textProp(buildSteps(salesSteps));

  // Proposals
  if (proposalMethod) props['Has Document Template'] = selectProp(
    ['PDF via WhatsApp', 'Email attachment', 'Google Docs link', 'Notion page'].includes(proposalMethod)
      ? 'Yes — will share PDF' : 'No — design for me'
  );
  if (contractType) props['Payment Terms Default'] = selectProp(
    contractType === 'Standard template always' ? '50% Deposit' : 'Custom'
  );

  // Invoices
  if (paymentTerms) {
    const termMap = {
      '50% deposit, 50% on delivery': '50% Deposit',
      'Full upfront': 'Full Upfront',
      'Other': 'Custom',
    };
    props['Payment Terms Default'] = selectProp(termMap[paymentTerms] || 'Custom');
  }
  if (paymentMethods?.length) props['Invoice Payment Terms'] = textProp(
    `Methods: ${paymentMethods.join(', ')}${paymentTermsOther ? ` | Notes: ${paymentTermsOther}` : ''}`
  );
  if (invoiceOwner) props['Sales Owner'] = textProp(invoiceOwner);
  if (paymentWhatsapp) props['Kickoff Notification Number'] = textProp(
    `${paymentWhatsapp} (${paymentWhatsappType || 'Personal'})`
  );

  // Operations OS
  if (projectTypes?.length) props['Project Types'] = multiSelectProp(projectTypes.map(p => {
    const map = { 'Monthly retainer': 'Retainer', 'One-off project': 'One-off', 'Campaign-based': 'Campaign-based' };
    return map[p] || 'Other';
  }));

  if (deliverySteps?.length) props['Project Kickoff Tasks'] = textProp(buildSteps(deliverySteps));

  if (projectStages === 'I have my own stages' && customProjectStages?.length) {
    props['Custom Pipeline Stages'] = textProp(buildStages(customProjectStages));
  }
  if (activeProjects) props['Active Campaigns Volume'] = selectProp(
    activeProjects === '1–5' ? '1–3' :
    activeProjects === '5–15' ? '4–10' : '10+'
  );
  if (taskTracking) props['Task Tracking Method'] = selectProp(
    taskTracking === 'ClickUp / Asana' ? 'Other tool' :
    taskTracking === 'Nothing formal' ? 'Nothing' : taskTracking
  );
  if (taskOwner) props['Delivery Owner'] = textProp(taskOwner);
  if (onboardingSteps?.length) props['Onboarding Kickoff Tasks'] = textProp(buildSteps(onboardingSteps));

  // Checklist / SOPs
  if (existingChecklist) props['Has Onboarding Checklist'] = selectProp(
    existingChecklist === "Yes — I'll share it" ? 'Yes — will share' : 'No'
  );
  if (existingSOPs) props['Has SOPs'] = selectProp(
    existingSOPs === "Yes — I'll share them" ? 'Yes — will share' : 'No'
  );
  if (prioritySOPs?.length) props['Priority SOPs'] = textProp(prioritySOPs.join(', '));
  if (onboardingConsistency) props['Client Issue Channel'] = textProp(onboardingConsistency);

  // Dashboard add-on
  if (dashboardViewers) props['Dashboard Viewers'] = selectProp(
    dashboardViewers === 'Founder only' ? 'Founder only' :
    dashboardViewers === 'Management only' ? 'Management only' : 'Whole team'
  );
  const kpis = [...(dashboardKPIs || [])];
  if (dashboardKPIother) kpis.push(dashboardKPIother);
  if (kpis.length) props['Key KPIs'] = textProp(kpis.join(', '));

  // Lead Capture add-on
  if (addonLeadSources?.length) props['Lead Sources'] = multiSelectProp(addonLeadSources);
  if (addonLeadFields?.length) props['Lead Capture Fields'] = multiSelectProp(addonLeadFields);
  if (leadAlertMethod) props['Lead Notification Method'] = selectProp(
    leadAlertMethod === 'Both' ? 'Both' : leadAlertMethod
  );
  if (leadAlertNumber) props['Lead Notification Number'] = textProp(
    `${leadAlertNumber} (${leadAlertType || 'Personal'})`
  );

  // Brand Assets
  if (brandKit) props['Has Brand Kit'] = selectProp(
    brandKit === "Yes — I'll share a link" ? 'Yes — will share link' : 'No — design for me'
  );
  if (brandKitLink) props['Logo URL'] = urlProp(brandKitLink);
  if (logoLink) props['Logo URL'] = urlProp(logoLink);
  const colors = [brandColor1Name, brandColor2Name].filter(Boolean);
  if (colors.length) props['Brand Colors'] = textProp(
    `${brandColor1} ${brandColor1Name ? `(${brandColor1Name})` : ''}, ${brandColor2} ${brandColor2Name ? `(${brandColor2Name})` : ''}`.trim()
  );
  if (brandFonts) props['Fonts'] = textProp(brandFonts);

  // Preferences
  const allSetupLinks = (setupLinks || []).filter(Boolean);
  if (allSetupLinks.length) props['Notion Workspace URL'] = urlProp(allSetupLinks[0]);
  if (automationWishes) props['Notes'] = textProp(
    `AUTOMATION WISHES:\n${automationWishes}\n\nBUSINESS TERMS:\n${businessTerms || 'N/A'}\n\nANYTHING ELSE:\n${anythingElse || 'N/A'}\n\nSETUP LINKS:\n${allSetupLinks.join('\n')}`
  );

  // Clean up nulls
  Object.keys(props).forEach(k => props[k] === null && delete props[k]);

  return props;
}

// ── WHATSAPP NOTIFICATION ──────────────────────────────────────────────────
async function sendWhatsApp(to, message) {
  const url = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_API_TOKEN;
  if (!url || !token) {
    console.log('[onboarding] WhatsApp not configured, skipping notification');
    return;
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, message }),
    });
  } catch (err) {
    console.error('[onboarding] WhatsApp notification failed:', err.message);
  }
}

// ── HANDLER ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const data = req.body;

  if (!data?.clientName) {
    return res.status(400).json({ error: 'Missing client name' });
  }

  try {
    // 1. Build Notion properties
    const properties = buildNotionProperties(data);

    // 2. Create Notion page in Client Implementation Form database
    const page = await notion.pages.create({
      parent: { database_id: DB },
      properties,
    });

    console.log(`[onboarding] Created intake page: ${page.id} for ${data.clientName}`);

    // 3. Update the Deal row with Client Intake relation (if dealId provided)
    if (data.dealId) {
      try {
        const dealPage = await notion.pages.retrieve({ page_id: data.dealId });
        const existingIntake = dealPage.properties['Client Intake']?.relation || [];
        await notion.pages.update({
          page_id: data.dealId,
          properties: {
            'Client Intake': {
              relation: [...existingIntake, { id: page.id }],
            },
          },
        });
        console.log(`[onboarding] Updated deal ${data.dealId} with intake ${page.id}`);
      } catch (err) {
        // Non-fatal — log but don't fail the submission
        console.error('[onboarding] Failed to update deal relation:', err.message);
      }
    }

    // 4. Send WhatsApp notification to Opxio team
    const notifyNumber = process.env.OPXIO_NOTIFY_NUMBER;
    if (notifyNumber) {
      const addonList = data.addons?.length ? ` + ${data.addons.join(', ')}` : '';
      const notionLink = `https://notion.so/${page.id.replace(/-/g, '')}`;
      await sendWhatsApp(
        notifyNumber,
        `✅ Intake received\n\nClient: ${data.clientName}\nPackage: ${data.osPackage || 'N/A'}${addonList}\n\nReview: ${notionLink}`
      );
    }

    return res.status(200).json({
      success: true,
      pageId: page.id,
      pageUrl: `https://notion.so/${page.id.replace(/-/g, '')}`,
    });

  } catch (err) {
    console.error('[onboarding] Error:', err);
    return res.status(500).json({
      error: 'Failed to submit form',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
}
