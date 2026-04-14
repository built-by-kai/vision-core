// pages/api/onboarding.js
// Receives onboarding form submission → writes to Notion Client Implementation Form database
// Fully mapped against actual DB schema b6167b39-b1b4-40a7-bd98-cd74e2d95458

// ENV VARS NEEDED:
// NOTION_API_KEY
// NOTION_CLIENT_INTAKE_DB  (default: b6167b39-b1b4-40a7-bd98-cd74e2d95458)
// NOTION_DEALS_DB          (default: 088fe600-97f6-8307-9c70-87cfbfe6dab7)
// OPXIO_NOTIFY_NUMBER      (e.g. 601xxxxxxxx)
// WHATSAPP_API_URL
// WHATSAPP_API_TOKEN

// Uses Notion REST API directly — no npm package required
const NOTION_TOKEN = process.env.NOTION_API_KEY;
const DB = process.env.NOTION_CLIENT_INTAKE_DB || 'b4fb844d-9433-492b-bafe-63841bea913a';

const notionHeaders = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28',
};

const notion = {
  pages: {
    create: async (body) => {
      const res = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: notionHeaders, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(`Notion create failed: ${JSON.stringify(err)}`);
      }
      return res.json();
    },
    retrieve: async ({ page_id }) => {
      const res = await fetch(`https://api.notion.com/v1/pages/${page_id}`, {
        headers: notionHeaders,
      });
      if (!res.ok) throw new Error(`Notion retrieve failed: ${res.status}`);
      return res.json();
    },
    update: async ({ page_id, properties }) => {
      const res = await fetch(`https://api.notion.com/v1/pages/${page_id}`, {
        method: 'PATCH', headers: notionHeaders,
        body: JSON.stringify({ properties }),
      });
      if (!res.ok) throw new Error(`Notion update failed: ${res.status}`);
      return res.json();
    },
  },
};

// ── HELPERS ────────────────────────────────────────────────────────────────

const rt = (str) => [{ type: 'text', text: { content: String(str || '').slice(0, 2000) } }];
const sel = (val) => val ? { select: { name: String(val) } } : null;
const msel = (arr) => {
  const opts = (arr || []).filter(Boolean).map(v => ({ name: String(v).slice(0, 100) }));
  return opts.length ? { multi_select: opts } : null;
};
const txt = (val) => val ? { rich_text: rt(val) } : null;
const url = (val) => {
  if (!val) return null;
  try { new URL(val); return { url: val }; } catch { return null; }
};
const steps = (items) => (items || []).map((it, i) => `${i + 1}. ${it.value || ''}`).filter(s => s.trim().length > 3).join('\n');
const stages = (items) => (items || []).map(i => i.value || '').filter(Boolean).join(' → ');

// ── TEAM SIZE: map form options to DB options ──────────────────────────────
// DB options: "1–5", "6–10", "10–20", "20+"
// Form options: "Just me", "2–5", "6–10", "11–15", "15+"
function mapTeamSize(val) {
  const map = {
    'Just me': '1–5',
    '2–5': '1–5',
    '6–10': '6–10',
    '11–15': '10–20',
    '15+': '20+',
  };
  return map[val] || null;
}

// ── LEAD SOURCES: map form options to DB options ───────────────────────────
// DB: Instagram DM, WhatsApp, Form, Website, Ads, Other
// Form has extra: Referral, LinkedIn, Existing client, Cold outreach, Events → all map to Other or filter
function mapLeadSources(arr) {
  const direct = new Set(['Instagram DM', 'WhatsApp', 'Form', 'Website', 'Ads', 'Other']);
  const toOther = new Set(['Referral', 'LinkedIn', 'Existing client', 'Cold outreach', 'Events']);
  const result = new Set();
  (arr || []).forEach(s => {
    if (direct.has(s)) result.add(s);
    else if (toOther.has(s)) result.add('Other');
  });
  return [...result];
}

// ── LEAD CAPTURE FIELDS: map form options to DB options ────────────────────
// DB: Name, Phone, Email, Interest, Budget, Other
// Form: "What they need" → Interest, "Company name" → Other
function mapLeadFields(arr) {
  const map = {
    'Name': 'Name',
    'Phone': 'Phone',
    'Email': 'Email',
    'What they need': 'Interest',
    'Budget': 'Budget',
    'Company name': 'Other',
  };
  const result = new Set();
  (arr || []).forEach(f => { if (map[f]) result.add(map[f]); });
  return [...result];
}

// ── MAIN PROPERTY BUILDER ──────────────────────────────────────────────────
function buildProps(d) {
  const p = {};

  // ── CORE ──
  p['Client Name'] = { title: rt(d.clientName || 'Unknown') };
  p['Intake Status'] = { select: { name: 'Submitted' } };
  if (d.osPackage) p['OS Package'] = sel(d.osPackage);
  if (d.addons?.length) p['Add-ons'] = msel(d.addons);
  if (d.dealId) p['Deal'] = { relation: [{ id: d.dealId }] };

  // ── BUSINESS / WORKSPACE ──
  const tsize = mapTeamSize(d.teamSize);
  if (tsize) p['Team Size'] = sel(tsize);

  // Main user = first team member
  const mainMember = d.teamMembers?.find(m => m.name);
  if (mainMember) p['Main User'] = txt(`${mainMember.name}${mainMember.role ? ` — ${mainMember.role}` : ''}`);

  // Other users = rest
  const otherMembers = (d.teamMembers || []).slice(1).filter(m => m.name);
  if (otherMembers.length) p['Other Users'] = txt(otherMembers.map(m => `${m.name}${m.role ? ` — ${m.role}` : ''}`).join(', '));

  if (d.notionUrl) p['Notion Workspace URL'] = url(d.notionUrl);
  if (d.notionPlan) p['Notion Plan'] = sel(d.notionPlan);
  if (d.notionUsage) p['Uses Notion'] = sel(
    d.notionUsage === "We're new to it" ? 'New to it' : d.notionUsage
  );
  if (d.existingData) p['Has Existing Data'] = sel(
    d.existingData === 'Yes — I have data' ? 'Yes' : 'No'
  );
  if (d.comms) p['Comms Preference'] = sel(d.comms);

  // ── REVENUE OS ──
  const mappedSources = mapLeadSources(d.leadSources);
  if (mappedSources.length) p['Lead Sources'] = msel(mappedSources);

  if (d.leadTracking) p['Pipeline Tracked How'] = sel(
    d.leadTracking === 'WhatsApp threads' ? 'WhatsApp' :
    d.leadTracking === 'A CRM tool' || d.leadTracking === 'Notion already' ? 'CRM tool' :
    d.leadTracking === 'Nothing formal' ? 'Nothing' : d.leadTracking
  );

  // leadVolume (leads per month) → Active Leads Volume
  // DB options: Under 10, 10–30, 30–50, 50+
  if (d.leadVolume) p['Active Leads Volume'] = sel(
    d.leadVolume === 'Under 5' ? 'Under 10' :
    d.leadVolume === '5–15' ? '10–30' :
    d.leadVolume === '15–30' ? '30–50' :
    d.leadVolume === '30+' ? '50+' : null
  );

  if (d.pipelineStages) p['Pipeline Stages'] = sel(
    d.pipelineStages === 'I have my own stages' ? 'Custom' : 'Use default'
  );
  if (d.pipelineStages === 'I have my own stages' && d.customStages?.length) {
    p['Custom Pipeline Stages'] = txt(stages(d.customStages));
  }

  // Sales steps → Delivery Process
  if (d.salesSteps?.length) p['Delivery Process'] = txt(steps(d.salesSteps));

  if (d.dealCurrency) p['Invoice Currency'] = sel(
    ['MYR', 'USD', 'SGD'].includes(d.dealCurrency) ? d.dealCurrency : 'Other'
  );

  // Payment terms
  if (d.paymentTerms) p['Payment Terms Default'] = sel(
    d.paymentTerms === '50% deposit, 50% on delivery' ? '50% Deposit' :
    d.paymentTerms === 'Full upfront' ? 'Full Upfront' : 'Custom'
  );

  const paymentNotes = [
    d.paymentMethods?.length ? `Methods: ${d.paymentMethods.join(', ')}` : '',
    d.paymentTermsOther ? `Terms: ${d.paymentTermsOther}` : '',
  ].filter(Boolean).join(' | ');
  if (paymentNotes) p['Invoice Payment Terms'] = txt(paymentNotes);

  // Sales owner (who manages sales) vs invoice owner
  // Form field: sales is managed by the sales team member (from team members)
  // invoiceOwner field from form → Sales Owner in DB (closest match)
  if (d.invoiceOwner) p['Sales Owner'] = txt(d.invoiceOwner);

  if (d.paymentWhatsapp) p['Kickoff Notification Number'] = txt(
    `${d.paymentWhatsapp}${d.paymentWhatsappType ? ` (${d.paymentWhatsappType})` : ''}`
  );

  // Pricing model
  if (d.dealTracking?.includes('Deal value')) {
    // Infer from context — or map from proposalMethod
  }
  // Direct pricing model mapping if we have it
  // Form has: Fixed prices / Sometimes negotiated / Always custom per client
  // DB has: Fixed / Sometimes negotiated / Always custom
  // proposalMethod is the closest proxy — but these don't overlap
  // We store via Notes instead

  // ── OPERATIONS OS ──
  if (d.projectTypes?.length) p['Project Types'] = msel(
    d.projectTypes.map(t =>
      t === 'Monthly retainer' ? 'Retainer' :
      t === 'One-off project' ? 'One-off' :
      t === 'Campaign-based' ? 'Campaign-based' : 'Other'
    )
  );

  if (d.deliverySteps?.length) p['Project Kickoff Tasks'] = txt(steps(d.deliverySteps));

  if (d.projectStages === 'I have my own stages' && d.customProjectStages?.length) {
    p['Custom Pipeline Stages'] = txt(stages(d.customProjectStages));
  }

  // Active projects → Active Campaigns Volume (closest field)
  // DB: 1–3, 4–10, 10+
  if (d.activeProjects) p['Active Campaigns Volume'] = sel(
    d.activeProjects === '1–5' ? '1–3' :
    d.activeProjects === '5–15' ? '4–10' : '10+'
  );

  if (d.taskTracking) p['Task Tracking Method'] = sel(
    d.taskTracking === 'ClickUp / Asana' ? 'Other tool' :
    d.taskTracking === 'Nothing formal' ? 'Nothing' : d.taskTracking
  );

  if (d.taskOwner) p['Delivery Owner'] = txt(d.taskOwner);

  if (d.typicalProjectLength) p['Typical Project Length'] = sel(
    d.typicalProjectLength === 'Under 2 weeks' ? 'Under 2 weeks' :
    d.typicalProjectLength === '2–4 weeks' ? '2–4 weeks' :
    d.typicalProjectLength === '1–3 months' ? '1–3 months' : '3+ months'
  );

  if (d.onboardingSteps?.length) p['Onboarding Kickoff Tasks'] = txt(steps(d.onboardingSteps));

  if (d.onboardingCollect?.length) {
    // Store as text since no direct field
    p['Document Header Info'] = txt(d.onboardingCollect.join(', '));
  }

  // Has Onboarding Checklist — DB expects exact: "Yes — will share" or "No"
  if (d.existingChecklist) p['Has Onboarding Checklist'] = sel(
    d.existingChecklist.startsWith('Yes') ? 'Yes — will share' : 'No'
  );

  // Has SOPs — DB expects exact: "Yes — will share" or "No"
  if (d.existingSOPs) p['Has SOPs'] = sel(
    d.existingSOPs.startsWith('Yes') ? 'Yes — will share' : 'No'
  );

  if (d.prioritySOPs?.length) p['Priority SOPs'] = txt(d.prioritySOPs.join(', '));

  // Onboarding consistency → stored in Notes (no matching field)
  // Services list
  if (d.servicesList) p['Services List'] = txt(d.servicesList);

  // ── ADD-ONS: ENHANCED DASHBOARD ──
  if (d.dashboardViewers) p['Dashboard Viewers'] = sel(d.dashboardViewers);
  const kpis = [...(d.dashboardKPIs || [])].filter(k => k !== 'Something else');
  if (d.dashboardKPIother) kpis.push(d.dashboardKPIother);
  if (kpis.length) p['Key KPIs'] = txt(kpis.join(', '));

  // ── ADD-ONS: LEAD CAPTURE ──
  const addonSources = mapLeadSources(d.addonLeadSources);
  if (addonSources.length) p['Lead Sources'] = msel(addonSources); // overrides if set
  const addonFields = mapLeadFields(d.addonLeadFields);
  if (addonFields.length) p['Lead Capture Fields'] = msel(addonFields);
  if (d.leadAlertMethod) p['Lead Notification Method'] = sel(
    d.leadAlertMethod === 'Both' ? 'Both' : d.leadAlertMethod
  );
  if (d.leadAlertNumber) p['Lead Notification Number'] = txt(
    `${d.leadAlertNumber}${d.leadAlertType ? ` (${d.leadAlertType})` : ''}`
  );

  // ── ADD-ONS: BRAND ASSETS ──
  // DB expects exact: "Yes — will share link" or "No — design for me"
  if (d.brandKit) p['Has Brand Kit'] = sel(
    d.brandKit.startsWith('Yes') ? 'Yes — will share link' : 'No — design for me'
  );
  if (d.brandKitLink) p['Logo URL'] = url(d.brandKitLink);
  if (d.logoLink) p['Logo URL'] = url(d.logoLink);
  const colorParts = [
    d.brandColor1 && d.brandColor1 !== '#000000' ? `${d.brandColor1}${d.brandColor1Name ? ` (${d.brandColor1Name})` : ''}` : null,
    d.brandColor2 && d.brandColor2 !== '#C6F135' ? `${d.brandColor2}${d.brandColor2Name ? ` (${d.brandColor2Name})` : ''}` : null,
  ].filter(Boolean);
  if (colorParts.length) p['Brand Colors'] = txt(colorParts.join(', '));
  if (d.brandFonts) p['Fonts'] = txt(d.brandFonts);

  // ── PREFERENCES ──
  const setupLinks = (d.setupLinks || []).filter(Boolean);
  if (setupLinks.length) {
    // First link goes to Notion Workspace URL if not already set
    if (!d.notionUrl && setupLinks[0]) p['Notion Workspace URL'] = url(setupLinks[0]);
  }

  // Build comprehensive Notes field
  const notesParts = [
    d.automationWishes ? `AUTOMATION WISHES:\n${d.automationWishes}` : '',
    d.businessTerms ? `BUSINESS TERMINOLOGY:\n${d.businessTerms}` : '',
    d.onboardingConsistency ? `ONBOARDING CONSISTENCY: ${d.onboardingConsistency}` : '',
    d.taskStagesCustom ? `CUSTOM TASK STAGES: ${d.taskStagesCustom}` : '',
    d.anythingElse ? `ANYTHING ELSE:\n${d.anythingElse}` : '',
    setupLinks.length ? `SETUP LINKS:\n${setupLinks.join('\n')}` : '',
    d.existingDataLinks?.filter(Boolean).length ? `EXISTING DATA LINKS:\n${d.existingDataLinks.filter(Boolean).join('\n')}` : '',
    d.checklistLinks?.filter(Boolean).length ? `ONBOARDING CHECKLIST LINKS:\n${d.checklistLinks.filter(Boolean).join('\n')}` : '',
    d.sopLinks?.filter(Boolean).length ? `SOP LINKS:\n${d.sopLinks.filter(Boolean).join('\n')}` : '',
  ].filter(Boolean);
  if (notesParts.length) p['Notes'] = txt(notesParts.join('\n\n').slice(0, 2000));

  // Remove nulls
  Object.keys(p).forEach(k => p[k] === null && delete p[k]);

  return p;
}

// ── WHATSAPP ───────────────────────────────────────────────────────────────
async function sendWhatsApp(to, message) {
  const apiUrl = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_API_TOKEN;
  if (!apiUrl || !token) return;
  try {
    await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, message }),
    });
  } catch (err) {
    console.error('[onboarding] WhatsApp failed:', err.message);
  }
}

// ── HANDLER ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const data = req.body;
  if (!data?.clientName) return res.status(400).json({ error: 'Missing clientName' });

  try {
    const properties = buildProps(data);

    // Create intake page in Notion
    const page = await notion.pages.create({
      parent: { database_id: DB },
      properties,
    });

    console.log(`[onboarding] Created ${page.id} for ${data.clientName}`);

    // Link back to Deal row
    if (data.dealId) {
      try {
        const deal = await notion.pages.retrieve({ page_id: data.dealId });
        const existing = deal.properties['Client Intake']?.relation || [];
        await notion.pages.update({
          page_id: data.dealId,
          properties: { 'Client Intake': { relation: [...existing, { id: page.id }] } },
        });
      } catch (err) {
        console.error('[onboarding] Deal link failed:', err.message);
      }
    }

    // Notify team via WhatsApp
    const notify = process.env.OPXIO_NOTIFY_NUMBER;
    if (notify) {
      const addons = data.addons?.length ? ` + ${data.addons.join(', ')}` : '';
      const link = `https://notion.so/${page.id.replace(/-/g, '')}`;
      await sendWhatsApp(notify, `✅ Intake received\n\nClient: ${data.clientName}\nPackage: ${data.osPackage || 'N/A'}${addons}\n\nReview: ${link}`);
    }

    return res.status(200).json({ success: true, pageId: page.id });

  } catch (err) {
    console.error('[onboarding] Error:', err);
    return res.status(500).json({
      error: 'Submission failed',
      detail: err.message,
    });
  }
}
