// proposal_template.js — Opxio Proposal Template Engine v3
// CommonJS module — used by the Vercel serverless function
// Exports: renderProposal(data), mapNotionPayload(body)

'use strict';

// ─── MODULE LIBRARY ────────────────────────────────────────────────────────
const MODULE_LIBRARY = {
  'CRM & Pipeline':              'Lead tracking, stage management, deal visibility, follow-up log',
  'Product & Pricing Catalogue': 'Services and packages structured for reuse in proposals',
  'Proposal & Deal Tracker':     'Tracks every proposal per deal — status, version, outcome',
  'Payment Tracker':             'Expected vs. received payments, invoice reference, overdue flags',
  'Finance & Expense Tracker':   'Income and expense logging, project categorisation, monthly P&L',
  'Project Tracker':             'Active projects with phases, milestones, and client-facing delivery view',
  'Task Management':             'Team task assignment, due dates, ownership, status — by person and project',
  'SOP & Process Library':       'Documented operating procedures, searchable and linked to projects',
  'Client Onboarding Tracker':   'Structured checklist per client — no more verbal walkthroughs',
  'Team Responsibility Matrix':  'Who owns what, across every function and every client',
  'Retainer Management':         'Recurring clients, scope, billing cycle, and renewal tracking',
  'Campaign Tracker':            'Campaign overview, status, objectives, budget, timeline',
  'Ads Tracker':                 'Platform spend by channel, ROAS, CPL, CPC, creative performance',
  'Content Calendar':            'Planned posts by platform, publish date, status, assignee',
  'Content Production Tracker':  'Full asset workflow from brief through revision and approval to publish',
  'Brand & Asset Library':       'Brand guidelines, logos, templates, approved creative assets',
  'Hiring Pipeline':             'Open roles, applicant stages, interview notes, offer tracking',
  'Team Onboarding Tracker':     'Step-by-step onboarding checklist per new hire, with ownership',
  'Performance & Goals':         'Quarterly goals, check-ins, review notes, ratings',
  'Leave & Availability':        'Time-off requests, approval status, team calendar visibility',
  'Role & Compensation Log':     'Role history, salary records, increments — internal only',
  'Client Health Tracker':       'Health scores, satisfaction signals, last contact date, risk flags',
  'NPS & Feedback Log':          'Survey results, recurring themes, satisfaction trend',
  'Renewal Pipeline':            'Contract end dates, renewal probability, action items',
  'Upsell Opportunity Tracker':  'Expansion signals, upsell ideas, status per client',
  'Support & Issue Log':         'Client-raised issues, response time, resolution, escalation',
};

// ─── ADD-ON LIBRARY ────────────────────────────────────────────────────────
const ADDON_LIBRARY = {
  'Marketing OS': {
    desc:        'Campaign tracking, content production workflow, and ads performance — connected to your CRM so leads from campaigns land directly in the pipeline.',
    price_label: 'RM 3,800', price_num: 3800, cadence: 'one-time', type: 'once', timing: 'Anytime',
  },
  'People OS': {
    desc:        'Hiring pipeline, team onboarding, performance goals, leave tracking, and compensation log — structured HR in Notion.',
    price_label: 'RM 3,200', price_num: 3200, cadence: 'one-time', type: 'once', timing: 'Month 3–6',
  },
  'Client Success OS': {
    desc:        'Client health scores, NPS tracking, renewal pipeline, and upsell opportunity tracker — built for retainer-heavy agencies.',
    price_label: 'RM 3,200', price_num: 3200, cadence: 'one-time', type: 'once', timing: 'Month 3–6',
  },
  'Document Generation': {
    desc:        'Branded PDF quotes and invoices auto-generated from your Notion data. Button in Notion generates and emails the document. Runs on Opxio\'s server.',
    price_label: 'RM 600', price_num: 600, monthly: 60, cadence: 'setup + RM 60/mo', type: 'setup+monthly', timing: 'Anytime',
  },
  'Lead Capture System': {
    desc:        'WhatsApp or form inquiries auto-populate your CRM pipeline without manual entry. Every lead captured, structured, and visible to the team immediately.',
    price_label: 'RM 1,200', price_num: 1200, cadence: 'from', type: 'once', timing: 'Anytime',
  },
  'Agency Command Centre': {
    desc:        'One cross-OS dashboard pulling pipeline, projects, campaigns, and team load into a single screen. Built once Business OS is running.',
    price_label: 'RM 2,500', price_num: 2500, cadence: 'from', type: 'once', timing: 'Anytime',
  },
  'Ads Live API Integration': {
    desc:        'Real-time spend and performance data pulled automatically from Meta, Google, and TikTok into your Ads Tracker — no manual entry.',
    price_label: 'RM 1,500', price_num: 1500, cadence: 'from', type: 'once', timing: 'Anytime',
  },
  'Employee Dashboard': {
    desc:        'Per-employee view showing active tasks, assigned projects, leave status, and quarterly goals. Requires People OS + Operations OS.',
    price_label: 'RM 1,500', price_num: 1500, cadence: 'from', type: 'once', timing: 'Anytime',
  },
  'Client Portal View': {
    desc:        'Read-only Notion view for clients to track project progress, delivery milestones, and shared assets without full workspace access.',
    price_label: 'RM 350', price_num: 350, cadence: 'from', type: 'once', timing: 'Anytime',
  },
};

// ─── WIDGET MAP ────────────────────────────────────────────────────────────
const WIDGET_MAP = {
  'Revenue OS': [
    { name: 'Pipeline Overview',          page: 'CRM & Pipeline page',            answers: 'How healthy is my pipeline right now?' },
    { name: 'Payment Status',             page: 'Payment Tracker page',            answers: 'Where does money stand this month?' },
    { name: 'Finance Snapshot',           page: 'Finance & Expense page',          answers: 'Am I profitable this month?' },
  ],
  'Operations OS': [
    { name: 'Project Health',             page: 'Project Tracker page',            answers: 'What is the state of every active project?' },
    { name: 'Task Load',                  page: 'Task Management page',            answers: 'Who has what open, and what is overdue?' },
    { name: 'Delivery & Retainer Health', page: 'Retainer Management page',        answers: 'Are we delivering on time?' },
  ],
  'Marketing OS': [
    { name: 'Campaign Status',            page: 'Campaign Tracker page',           answers: 'What campaigns are running and where are they?' },
    { name: 'Ads Performance',            page: 'Ads Tracker page',                answers: 'How is paid spend performing?' },
    { name: 'Content Pipeline',           page: 'Content Production Tracker page', answers: 'What content is due, in production, or overdue?' },
  ],
  'People OS': [
    { name: 'Team Overview',              page: 'Team & Staff Directory page',     answers: 'Who is available and what does headcount look like?' },
    { name: 'Hiring Pipeline',            page: 'Hiring Pipeline page',            answers: 'Where are we in filling open roles?' },
  ],
  'Client Success OS': [
    { name: 'Client Health Board',        page: 'Client Health Tracker page',      answers: 'Which clients are healthy and which need attention?' },
    { name: 'Renewal Pipeline',           page: 'Renewal Pipeline page',           answers: 'What is expiring and what is the risk?' },
  ],
};

const RETAINER_LABELS = {
  hosting:     { label: 'Hosting Only',    fee: 150 },
  maintenance: { label: 'Maintenance',     fee: 400 },
  active:      { label: 'Active Retainer', fee: 900 },
};

const OS_MODULE_GROUPS = {
  'Revenue OS':        { badge: 'badge-revenue',    subtitle: 'Pipeline · Proposals · Payments · Finance' },
  'Operations OS':     { badge: 'badge-operations', subtitle: 'Projects · Tasks · SOPs · Retainers' },
  'Marketing OS':      { badge: 'badge-marketing',  subtitle: 'Campaigns · Ads · Content · Assets' },
  'People OS':         { badge: 'badge-people',     subtitle: 'Hiring · Onboarding · Performance · Leave' },
  'Client Success OS': { badge: 'badge-cs',         subtitle: 'Health · NPS · Renewals · Upsell' },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────
function fmt(n) { return 'RM ' + Number(n).toLocaleString('en-MY'); }
function escape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function moduleItems(modules) {
  return modules.map(name => {
    const desc = MODULE_LIBRARY[name] || '';
    return `<div class="module-item">
        <div class="module-dot"></div>
        <div>
          <div class="module-item-name">${escape(name)}</div>
          <div class="module-item-desc">${escape(desc)}</div>
        </div>
      </div>`;
  }).join('');
}

function moduleGroups(groupedModules) {
  return Object.entries(groupedModules).map(([osName, mods]) => {
    const meta = OS_MODULE_GROUPS[osName] || { badge: 'badge-operations', subtitle: '' };
    return `<div class="module-group">
        <div class="module-group-header">
          <div class="module-group-badge ${meta.badge}">${escape(osName)}</div>
          <div class="module-group-title">${escape(meta.subtitle)}</div>
        </div>
        <div class="module-list">${moduleItems(mods)}</div>
      </div>`;
  }).join('');
}

function widgetRows(osTypes) {
  const rows = []; let shade = false;
  for (const os of osTypes) {
    for (const w of (WIDGET_MAP[os] || [])) {
      rows.push(`<tr${shade ? ' class="shaded"' : ''}>
          <td>${escape(w.name)}</td><td>${escape(w.page)}</td><td>${escape(w.answers)}</td>
        </tr>`);
      shade = !shade;
    }
  }
  return rows.join('');
}

function addonCard(name) {
  const a = ADDON_LIBRARY[name];
  if (!a) return '';
  return `<div class="phase2-item">
      <div>
        <div class="phase2-name">${escape(name)}</div>
        <div class="phase2-timing">${escape(a.timing)}</div>
      </div>
      <div class="phase2-desc">${escape(a.desc)}</div>
      <div class="phase2-price">
        <span class="amount">${escape(a.price_label)}</span>
        <span class="cadence">${escape(a.cadence)}</span>
      </div>
    </div>`;
}

// ─── CSS ──────────────────────────────────────────────────────────────────
const CSS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --black:#0A0A0A;--lime:#C6F135;--lime-dim:#A8D420;--lime-bg:#F5FFD6;
    --white:#FFFFFF;--g100:#F4F4F4;--g200:#E8E8E8;--g400:#AAAAAA;--g600:#666666;--g800:#333333;
    --fd:'Syne',sans-serif;--fb:'DM Sans',sans-serif;
  }
  html{font-size:15px;background:#F0F0F0}
  body{font-family:var(--fb);color:var(--g800);background:#F0F0F0;-webkit-font-smoothing:antialiased}
  .page{width:860px;background:var(--white);margin:32px auto;position:relative;overflow:hidden}
  @media print{
    body{background:white}
    .page{margin:0;box-shadow:none;width:100%;page-break-after:always}
    .page:last-child{page-break-after:avoid}
    @page{margin:0;size:A4}
  }
  @media screen{.page{box-shadow:0 4px 40px rgba(0,0,0,.12)}}
  .cover{background:var(--black);min-height:100vh;display:flex;flex-direction:column;padding:56px 64px;position:relative;overflow:hidden}
  .cover::before{content:'';position:absolute;top:-180px;right:-180px;width:520px;height:520px;border-radius:50%;border:1px solid rgba(198,241,53,.08);pointer-events:none}
  .cover::after{content:'';position:absolute;top:-80px;right:-80px;width:300px;height:300px;border-radius:50%;border:1px solid rgba(198,241,53,.12);pointer-events:none}
  .cover-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:auto}
  .logo-mark{font-family:var(--fd);font-size:13px;font-weight:700;letter-spacing:.18em;color:var(--lime);text-transform:uppercase}
  .cover-ref{font-size:11px;color:var(--g400);letter-spacing:.08em;text-align:right;line-height:1.8}
  .cover-content{padding:80px 0 48px}
  .cover-eyebrow{font-size:11px;font-weight:500;letter-spacing:.16em;color:var(--lime);text-transform:uppercase;margin-bottom:24px}
  .cover-title{font-family:var(--fd);font-size:68px;font-weight:800;line-height:1.0;color:var(--white);margin-bottom:8px;letter-spacing:-.02em}
  .cover-title span{color:var(--lime);display:block}
  .cover-subtitle{font-size:17px;font-weight:300;color:var(--g400);margin-top:24px;line-height:1.6}
  .cover-divider{width:48px;height:2px;background:var(--lime);margin:32px 0}
  .cover-meta{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding-top:32px;border-top:1px solid rgba(255,255,255,.08)}
  .cover-meta-item label{display:block;font-size:10px;font-weight:500;letter-spacing:.14em;color:var(--g400);text-transform:uppercase;margin-bottom:6px}
  .cover-meta-item span{display:block;font-size:14px;font-weight:400;color:var(--white)}
  .page-header-strip{display:flex;justify-content:space-between;align-items:center;padding:18px 64px;border-bottom:1px solid var(--g200)}
  .page-header-strip .logo{font-family:var(--fd);font-size:12px;font-weight:700;letter-spacing:.14em;color:var(--black);text-transform:uppercase}
  .page-header-strip .doc-label{font-size:10px;font-weight:500;letter-spacing:.12em;color:var(--g400);text-transform:uppercase}
  .inner{padding:56px 64px 64px}
  .section-block{margin-bottom:52px}
  .section-eyebrow{font-size:10px;font-weight:600;letter-spacing:.18em;color:var(--lime-dim);text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:10px}
  .section-eyebrow::after{content:'';flex:1;height:1px;background:var(--g200);max-width:120px}
  .section-title{font-family:var(--fd);font-size:38px;font-weight:800;color:var(--black);line-height:1.1;letter-spacing:-.02em;margin-bottom:20px}
  .section-lead{font-size:15px;font-weight:300;color:var(--g600);line-height:1.75;max-width:600px}
  .section-lead+.section-lead{margin-top:14px}
  .section-lead strong{font-weight:500;color:var(--g800)}
  .summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--g200);margin:36px 0;border-radius:4px;overflow:hidden}
  .summary-item{padding:20px 24px;border-bottom:1px solid var(--g200);border-right:1px solid var(--g200)}
  .summary-item:nth-child(even){border-right:none}
  .summary-item:nth-last-child(-n+2){border-bottom:none}
  .summary-item label{display:block;font-size:10px;font-weight:600;letter-spacing:.12em;color:var(--g400);text-transform:uppercase;margin-bottom:6px}
  .summary-item span{font-size:14px;font-weight:400;color:var(--black);line-height:1.4}
  .summary-item span.hl{font-weight:600}
  .module-group{margin-bottom:28px}
  .module-group-header{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .module-group-badge{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:4px 10px;border-radius:2px}
  .badge-revenue{background:var(--black);color:var(--lime)}
  .badge-operations{background:var(--g100);color:var(--g800)}
  .badge-marketing{background:#1a1a2e;color:#7EB8FF}
  .badge-people{background:#1a2e1a;color:#7EFF9A}
  .badge-cs{background:#2e1a1a;color:#FF9A7E}
  .module-group-title{font-family:var(--fd);font-size:13px;font-weight:700;color:var(--g800)}
  .module-list{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .module-item{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;background:var(--g100);border-radius:3px}
  .module-dot{width:6px;height:6px;border-radius:50%;background:var(--lime-dim);margin-top:5px;flex-shrink:0}
  .module-item-name{font-size:13px;font-weight:500;color:var(--black);margin-bottom:2px}
  .module-item-desc{font-size:11.5px;font-weight:300;color:var(--g600);line-height:1.5}
  .widget-table{width:100%;border-collapse:collapse;margin:24px 0;font-size:13px}
  .widget-table thead tr{background:var(--black)}
  .widget-table thead th{padding:12px 16px;text-align:left;font-family:var(--fd);font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--lime)}
  .widget-table tr.shaded{background:var(--g100)}
  .widget-table tbody tr{border-bottom:1px solid var(--g200)}
  .widget-table tbody td{padding:13px 16px;color:var(--g600);font-weight:300;line-height:1.5}
  .widget-table tbody td:first-child{font-weight:500;color:var(--black)}
  .ownership-box{border-left:4px solid var(--lime);background:var(--lime-bg);padding:20px 24px;margin:28px 0;border-radius:0 4px 4px 0}
  .ownership-box .ob-label{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--lime-dim);margin-bottom:8px}
  .ownership-box p{font-size:13px;font-weight:300;color:var(--g800);line-height:1.7}
  .investment-table{width:100%;border-collapse:collapse;margin:24px 0}
  .investment-table thead tr{border-bottom:2px solid var(--black)}
  .investment-table thead th{padding:10px 16px 10px 0;text-align:left;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--g400)}
  .investment-table thead th:last-child{text-align:right;padding-right:0}
  .investment-table tbody td{padding:14px 16px 14px 0;border-bottom:1px solid var(--g200);font-size:14px;color:var(--g600);font-weight:300}
  .investment-table tbody td:last-child{text-align:right;font-weight:500;color:var(--black);padding-right:0}
  .investment-table tfoot td{padding:14px 16px 0 0;font-size:14px;font-weight:600;color:var(--black)}
  .investment-table tfoot td:last-child{text-align:right;padding-right:0}
  .investment-table tfoot tr:first-child td{border-top:2px solid var(--black)}
  .type-pill{display:inline-block;font-size:10px;font-weight:600;letter-spacing:.08em;padding:3px 8px;border-radius:2px;text-transform:uppercase}
  .pill-once{background:var(--black);color:var(--lime)}
  .pill-monthly{background:var(--g200);color:var(--g800)}
  .pill-addon{background:#1a1a2e;color:#7EB8FF}
  .pill-client{background:var(--g100);color:var(--g600)}
  .investment-note{font-size:12px;font-weight:300;color:var(--g400);font-style:italic;margin-top:12px}
  .phase2-grid{display:grid;grid-template-columns:1fr;gap:12px;margin:28px 0}
  .phase2-item{display:grid;grid-template-columns:200px 1fr auto;gap:24px;align-items:start;padding:20px 24px;border:1px solid var(--g200);border-radius:4px}
  .phase2-name{font-family:var(--fd);font-size:14px;font-weight:700;color:var(--black);margin-bottom:4px}
  .phase2-timing{font-size:11px;font-weight:500;letter-spacing:.08em;color:var(--g400);text-transform:uppercase}
  .phase2-desc{font-size:13px;font-weight:300;color:var(--g600);line-height:1.6}
  .phase2-price{text-align:right;white-space:nowrap}
  .phase2-price .amount{font-family:var(--fd);font-size:15px;font-weight:700;color:var(--black);display:block}
  .phase2-price .cadence{font-size:11px;color:var(--g400);font-weight:300}
  .steps-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:28px 0}
  .step-item{padding:24px;border:1px solid var(--g200);border-radius:4px}
  .step-number{font-family:var(--fd);font-size:48px;font-weight:800;color:var(--g200);line-height:1;margin-bottom:12px;letter-spacing:-.02em}
  .step-title{font-family:var(--fd);font-size:14px;font-weight:700;color:var(--black);margin-bottom:8px}
  .step-desc{font-size:12.5px;font-weight:300;color:var(--g600);line-height:1.65}
  .cta-block{background:var(--black);margin:52px -64px -64px;padding:56px 64px;display:grid;grid-template-columns:1fr auto;align-items:center;gap:32px}
  .cta-block h2{font-family:var(--fd);font-size:28px;font-weight:800;color:var(--white);line-height:1.2;letter-spacing:-.01em}
  .cta-block h2 span{color:var(--lime)}
  .cta-block p{font-size:13px;font-weight:300;color:var(--g400);margin-top:8px;line-height:1.6}
  .cta-contacts{display:flex;flex-direction:column;gap:10px;align-items:flex-end}
  .cta-contact-item{font-size:13px;color:var(--white);font-weight:400;text-align:right}
  .cta-contact-item label{display:block;font-size:9px;font-weight:600;letter-spacing:.14em;color:var(--lime);text-transform:uppercase;margin-bottom:2px}
  .validity{font-size:11.5px;font-weight:300;color:var(--g400);font-style:italic;text-align:center;padding:20px 64px;border-top:1px solid var(--g200);background:var(--white)}
  .addon-group-label{font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--g400);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--g200)}
  .addon-now-grid{display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:8px}
  .addon-now-item{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:start;padding:18px 20px;background:var(--g100);border-radius:4px;border-left:3px solid var(--lime)}
  .addon-now-name{font-family:var(--fd);font-size:13px;font-weight:700;color:var(--black);margin-bottom:4px}
  .addon-now-desc{font-size:12px;font-weight:300;color:var(--g600);line-height:1.55}
  .addon-now-price{text-align:right;white-space:nowrap;flex-shrink:0}
  .addon-now-amount{font-family:var(--fd);font-size:14px;font-weight:700;color:var(--black);display:block}
  .addon-now-cadence{font-size:11px;color:var(--g400);font-weight:300}
`;

// ─── RENDER ────────────────────────────────────────────────────────────────
function renderProposal(data) {
  const {
    ref_number    = 'PRO-0000-001',
    date          = new Date().toLocaleDateString('en-MY', { month: 'long', year: 'numeric' }),
    valid_until,
    company_name,
    contact_name,
    contact_role  = 'Director',
    whatsapp,
    email         = 'hello@opxio.io',
    website       = 'opxio.io',
    os_type,
    install_tier  = 'Standard',
    notion_plan   = 'Plus',
    timeline      = '3–4 weeks',
    fee,
    retainer      = 'maintenance',
    situation     = [],
    modules       = {},
    addons_now    = [],
    addons_later  = [],
    cover_subtitle,
  } = data;

  const retainerInfo = RETAINER_LABELS[retainer] || RETAINER_LABELS.maintenance;

  const validUntilText = valid_until || (() => {
    const d = new Date(); d.setDate(d.getDate() + 14);
    return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'long', year: 'numeric' });
  })();

  const osTypes      = Object.keys(modules);
  const totalModules = Object.values(modules).reduce((s, a) => s + a.length, 0);
  const totalWidgets = osTypes.reduce((s, os) => s + (WIDGET_MAP[os] || []).length, 0);
  const subtitle     = cover_subtitle || `A structured operational system built on Notion.<br>${osTypes.join(' · ')}. Full visibility.`;
  const headerLabel  = `Proposal · ${escape(ref_number)} · ${escape(company_name)}`;
  const situationHTML = situation.map(s => `<p class="section-lead">${escape(s)}</p>`).join('\n');

  const coreFee  = Number(fee) || 0;
  const deposit  = Math.round(coreFee / 2);

  const addonNowRows = addons_now.map(name => {
    const a = ADDON_LIBRARY[name];
    if (!a) return '';
    return `<div class="addon-now-item">
        <div class="addon-now-left">
          <div class="addon-now-name">${escape(name)}</div>
          <div class="addon-now-desc">${escape(a.desc)}</div>
        </div>
        <div class="addon-now-price">
          <span class="addon-now-amount">${escape(a.price_label)}</span>
          <span class="addon-now-cadence">${escape(a.cadence)}</span>
        </div>
      </div>`;
  }).join('');

  const hasAddonsNow   = addons_now.length > 0;
  const hasAddonsLater = addons_later.length > 0;
  const hasAnyAddons   = hasAddonsNow || hasAddonsLater;
  const nextStepNum    = hasAnyAddons ? '04' : '03';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Opxio — ${escape(os_type)} Proposal · ${escape(company_name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>

<!-- COVER -->
<div class="page">
  <div class="cover">
    <div class="cover-top">
      <div class="logo-mark">Opxio</div>
      <div class="cover-ref">Ref: ${escape(ref_number)}<br>${escape(date)}<br>Confidential</div>
    </div>
    <div class="cover-content">
      <div class="cover-eyebrow">System Installation Proposal</div>
      <div class="cover-title">${escape(os_type)}<span>for ${escape(company_name)}.</span></div>
      <div class="cover-divider"></div>
      <div class="cover-subtitle">${subtitle}</div>
    </div>
    <div class="cover-meta">
      <div class="cover-meta-item"><label>Prepared for</label><span>${escape(company_name)}</span></div>
      <div class="cover-meta-item"><label>Contact</label><span>${escape(contact_name)}${contact_role ? ' — ' + escape(contact_role) : ''}</span></div>
      <div class="cover-meta-item"><label>Prepared by</label><span>Kai — Opxio</span></div>
      <div class="cover-meta-item"><label>Valid until</label><span>${escape(validUntilText)}</span></div>
    </div>
  </div>
</div>

<!-- PAGE 2 — CONTEXT + SUMMARY -->
<div class="page">
  <div class="page-header-strip"><span class="logo">Opxio</span><span class="doc-label">${headerLabel}</span></div>
  <div class="inner">
    <div class="section-block">
      <div class="section-eyebrow">01 — Context</div>
      <div class="section-title">What we heard.</div>
      ${situationHTML}
    </div>
    <div class="section-block">
      <div class="section-eyebrow">02 — The Install</div>
      <div class="section-title">${escape(os_type)}.</div>
      <p class="section-lead">A structured operational system built on Notion — designed around how ${escape(company_name)} actually runs.</p>
      <div class="summary-grid">
        <div class="summary-item"><label>Install</label><span class="hl">${escape(os_type)} — ${escape(install_tier)} Install</span></div>
        <div class="summary-item"><label>Notion Plan Required</label><span>${escape(notion_plan)} — ~RM 50/month, billed to your workspace</span></div>
        <div class="summary-item"><label>Total Modules</label><span class="hl">${totalModules} modules across ${osTypes.join(' + ')}</span></div>
        <div class="summary-item"><label>Live Dashboards</label><span>${totalWidgets} widgets embedded inside Notion pages</span></div>
        <div class="summary-item"><label>Delivery Timeline</label><span class="hl">${escape(timeline)} from deposit</span></div>
        <div class="summary-item"><label>Handover</label><span>Walkthrough session + widget orientation</span></div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE 3 — MODULES -->
<div class="page">
  <div class="page-header-strip"><span class="logo">Opxio</span><span class="doc-label">${headerLabel}</span></div>
  <div class="inner">
    <div class="section-block">
      <div class="section-eyebrow">02 — The Install</div>
      <div class="section-title">Modules included.</div>
      ${moduleGroups(modules)}
    </div>
  </div>
</div>

<!-- PAGE 4 — WIDGETS + INVESTMENT -->
<div class="page">
  <div class="page-header-strip"><span class="logo">Opxio</span><span class="doc-label">${headerLabel}</span></div>
  <div class="inner">
    <div class="section-block">
      <div class="section-eyebrow">02 — The Install</div>
      <div class="section-title">Live dashboards.</div>
      <p class="section-lead">${totalWidgets} visual dashboards embedded inside your Notion pages — connected to your live data via Opxio's server. They replace the manual checking. Tasks, records, and editing stay in Notion where they belong.</p>
      <table class="widget-table">
        <thead><tr><th>Dashboard</th><th>Lives on</th><th>Answers</th></tr></thead>
        <tbody>${widgetRows(osTypes)}</tbody>
      </table>
      <div class="ownership-box">
        <div class="ob-label">Ownership</div>
        <p>Your Notion workspace and all databases are yours permanently. Dashboards run on Opxio's infrastructure, covered by the monthly service fee. If the service is paused, your system keeps running — the live dashboards stop.</p>
      </div>
    </div>

    <div class="section-block">
      <div class="section-eyebrow">02 — The Install</div>
      <div class="section-title">Investment.</div>
      <table class="investment-table">
        <thead><tr><th style="width:50%">Item</th><th>Type</th><th>Amount</th></tr></thead>
        <tbody>
          <tr>
            <td>${escape(os_type)} — ${escape(install_tier)} Install</td>
            <td><span class="type-pill pill-once">One-time</span></td>
            <td>${fmt(coreFee)}</td>
          </tr>
          <tr>
            <td>Widget ${escape(retainerInfo.label)} Retainer</td>
            <td><span class="type-pill pill-monthly">Monthly</span></td>
            <td>${fmt(retainerInfo.fee)} / mo</td>
          </tr>
          <tr>
            <td>Notion ${escape(notion_plan)} Plan <em style="font-size:11px;color:#aaa">(your workspace)</em></td>
            <td><span class="type-pill pill-client">Client's cost</span></td>
            <td>~RM 50 / mo</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2">Installation fee</td>
            <td>${fmt(coreFee)}</td>
          </tr>
        </tfoot>
      </table>
      <p class="investment-note">50% deposit (${fmt(deposit)}) required to begin. Balance on delivery.</p>
    </div>
  </div>
</div>

<!-- PAGE 5 — ADD-ONS + NEXT STEPS -->
<div class="page">
  <div class="page-header-strip"><span class="logo">Opxio</span><span class="doc-label">${headerLabel}</span></div>
  <div class="inner">

    ${hasAnyAddons ? `
    <div class="section-block">
      <div class="section-eyebrow">03 — Add-Ons</div>
      <div class="section-title">Optional extras.</div>
      <p class="section-lead">Add-ons are independent of the core install. Take them now or any time after. Each one is priced and scoped separately.</p>

      ${hasAddonsNow ? `
      <div class="addon-group-label">Included in this proposal</div>
      <div class="addon-now-grid">${addonNowRows}</div>
      ` : ''}

      ${hasAddonsLater ? `
      ${hasAddonsNow ? '<div class="addon-group-label" style="margin-top:28px">Available any time</div>' : ''}
      <div class="phase2-grid" style="margin-top:12px">${addons_later.map(addonCard).join('')}</div>
      ` : ''}
    </div>` : ''}

    <div class="section-block">
      <div class="section-eyebrow">${nextStepNum} — How to Proceed</div>
      <div class="section-title">Next steps.</div>
      <div class="steps-grid">
        <div class="step-item">
          <div class="step-number">01</div>
          <div class="step-title">Confirm scope</div>
          <div class="step-desc">Reply to this proposal or message Kai on WhatsApp to confirm the install scope and ask any questions.</div>
        </div>
        <div class="step-item">
          <div class="step-number">02</div>
          <div class="step-title">Pay deposit</div>
          <div class="step-desc">50% (${fmt(deposit)}) to secure your implementation slot and begin the build.</div>
        </div>
        <div class="step-item">
          <div class="step-number">03</div>
          <div class="step-title">Onboarding call</div>
          <div class="step-desc">30-minute call to map your existing data, confirm workspace access, and align on the delivery timeline.</div>
        </div>
        <div class="step-item">
          <div class="step-number">04</div>
          <div class="step-title">Build &amp; handover</div>
          <div class="step-desc">${escape(timeline)} to full installation. Handover walkthrough and widget orientation included.</div>
        </div>
      </div>
    </div>

    <div class="cta-block">
      <div>
        <h2>Ready to install<br><span>clarity into your business?</span></h2>
        <p>Message Kai directly to confirm scope and secure your slot.</p>
      </div>
      <div class="cta-contacts">
        ${whatsapp ? `<div class="cta-contact-item"><label>WhatsApp</label>${escape(whatsapp)}</div>` : ''}
        <div class="cta-contact-item"><label>Email</label>${escape(email)}</div>
        <div class="cta-contact-item"><label>Website</label>${escape(website)}</div>
      </div>
    </div>
  </div>
</div>

<div class="validity">
  This proposal is confidential and prepared exclusively for ${escape(company_name)}. Valid until ${escape(validUntilText)}.
</div>

</body>
</html>`;
}

// ─── NOTION PAYLOAD MAPPER ─────────────────────────────────────────────────
// Maps a Notion automation webhook body to proposal data
function mapNotionPayload(body) {
  const props = body.data?.properties || body.properties || {};

  function text(key) {
    const p = props[key];
    if (!p) return '';
    if (p.title)            return p.title.map(t => t.plain_text).join('');
    if (p.rich_text)        return p.rich_text.map(t => t.plain_text).join('');
    if (p.select)           return p.select.name;
    if (p.number !== undefined) return p.number;
    if (p.phone_number)     return p.phone_number;
    if (p.email)            return p.email;
    if (p.url)              return p.url;
    if (p.date)             return p.date.start;
    return '';
  }

  function multiSelect(key) {
    const p = props[key];
    if (!p || !p.multi_select) return [];
    return p.multi_select.map(s => s.name);
  }

  const modules = {};
  const rev  = multiSelect('Revenue Modules');
  const ops  = multiSelect('Operations Modules');
  const mkt  = multiSelect('Marketing Modules');
  const ppl  = multiSelect('People Modules');
  const cs   = multiSelect('Client Success Modules');

  if (rev.length)  modules['Revenue OS']        = rev;
  if (ops.length)  modules['Operations OS']     = ops;
  if (mkt.length)  modules['Marketing OS']      = mkt;
  if (ppl.length)  modules['People OS']         = ppl;
  if (cs.length)   modules['Client Success OS'] = cs;

  return {
    ref_number:   text('Ref Number'),
    date:         text('Date'),
    valid_until:  text('Valid Until'),
    company_name: text('Company Name'),
    contact_name: text('Contact Name'),
    contact_role: text('Contact Role'),
    whatsapp:     text('WhatsApp'),
    email:        'hello@opxio.io',
    website:      'opxio.io',
    os_type:      text('OS Type'),
    install_tier: text('Install Tier')  || 'Standard',
    notion_plan:  text('Notion Plan')   || 'Plus',
    timeline:     text('Timeline')      || '3–4 weeks',
    fee:          Number(text('Fee'))   || 0,
    retainer:     (text('Retainer Tier') || 'maintenance').toLowerCase(),
    situation:    [
      text('Situation Line 1'),
      text('Situation Line 2'),
      text('Situation Line 3'),
    ].filter(Boolean),
    modules,
    addons_now:   multiSelect('Add-Ons Now'),
    addons_later: multiSelect('Add-Ons Later'),
  };
}

module.exports = { renderProposal, mapNotionPayload };
