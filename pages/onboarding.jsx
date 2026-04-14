// pages/onboarding.jsx
// Opxio Client Implementation Form
// Pre-fills from URL params: ?client=Creaitors+Official&package=Business+OS&addons=Enhanced+Dashboard,Lead+Capture+System&deal=DEAL_ID
// On submit: POSTs to /api/onboarding which writes to Notion

import { useState, useEffect } from 'react';
import Head from 'next/head';

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const OS_PACKAGES = [
  'Revenue OS', 'Operations OS', 'Business OS',
  'Marketing OS', 'Agency OS', 'Team OS', 'Retention OS', 'Micro Install',
];

const ALL_ADDONS = [
  'Enhanced Dashboard', 'Lead Capture System', 'Document Generation',
  'Project Kickoff Automation', 'Campaign Kickoff Automation',
  'Client Onboarding Kickoff', 'Renewal Kickoff Automation',
  'Hiring Kickoff Automation', 'Ads Platform Integration',
  'API Integration', 'Make / N8N Workflow',
];

const STEPS = [
  { id: 0, label: 'Welcome' },
  { id: 1, label: 'Your business' },
  { id: 2, label: 'Revenue OS' },
  { id: 3, label: 'Operations OS' },
  { id: 4, label: 'Add-ons' },
  { id: 5, label: 'Preferences' },
  { id: 6, label: 'Done' },
];

// Which steps to show based on OS package
function getRelevantSteps(pkg, addons) {
  const steps = [0, 1]; // always show welcome + business
  const hasRevenue = ['Revenue OS', 'Business OS', 'Agency OS'].includes(pkg);
  const hasOps = ['Operations OS', 'Business OS', 'Agency OS'].includes(pkg);
  const hasAddons = addons.length > 0;
  if (hasRevenue) steps.push(2);
  if (hasOps) steps.push(3);
  if (hasAddons) steps.push(4);
  steps.push(5, 6);
  return steps;
}

// ── FORM STATE DEFAULTS ────────────────────────────────────────────────────
const defaultForm = {
  // Business
  businessDesc: '',
  teamSize: '',
  teamMembers: [{ name: '', role: '' }],
  industry: '',
  notionUrl: '',
  notionPlan: '',
  notionUsage: '',
  notionAccess: '',
  notionPermissions: [],
  existingData: '',
  existingDataLinks: [''],
  comms: '',

  // Revenue OS
  leadSources: [],
  leadTracking: '',
  leadVolume: '',
  leadInfo: [],
  pipelineStages: 'default',
  customStages: [{ value: '' }, { value: '' }, { value: '' }],
  salesSteps: [{ value: '' }, { value: '' }, { value: '' }, { value: '' }],
  activeDeals: '',
  dealTracking: [],
  dealStuck: [],
  dealCurrency: '',
  proposalMethod: '',
  proposalTracking: [],
  contractType: '',
  invoiceMethod: '',
  paymentTerms: '',
  paymentTermsOther: '',
  paymentMethods: [],
  invoiceTracking: [],
  paymentProblems: [],
  paymentWhatsapp: '',
  paymentWhatsappType: '',
  invoiceOwner: '',

  // Operations OS
  projectTypes: [],
  servicesList: '',
  typicalProjectLength: '',
  deliverySteps: [{ value: '' }, { value: '' }, { value: '' }, { value: '' }],
  projectStages: 'default',
  customProjectStages: [{ value: '' }],
  activeProjects: '',
  projectStuck: [],
  taskTracking: '',
  taskStages: 'default',
  taskStagesCustom: '',
  taskFields: [],
  taskProblems: [],
  taskOwner: '',
  onboardingSteps: [{ value: '' }, { value: '' }, { value: '' }, { value: '' }],
  onboardingCollect: [],
  onboardingProblems: [],
  existingChecklist: '',
  checklistLinks: [''],
  onboardingConsistency: '',
  existingSOPs: '',
  sopLinks: [''],
  prioritySOPs: [],

  // Add-ons
  dashboardViewers: '',
  dashboardKPIs: [],
  dashboardKPIother: '',
  addonLeadSources: [],
  addonLeadFields: [],
  leadAlertMethod: '',
  leadAlertNumber: '',
  leadAlertType: '',
  brandKit: '',
  brandKitLink: '',
  brandKitFiles: null,
  brandColor1: '#000000',
  brandColor1Name: '',
  brandColor2: '#C6F135',
  brandColor2Name: '',
  brandFonts: '',
  logoLink: '',

  // Preferences
  setupLinks: ['', ''],
  automationWishes: '',
  businessTerms: '',
  anythingElse: '',
};

// ── UTILITY COMPONENTS ─────────────────────────────────────────────────────

function ChipGroup({ name, options, value, onChange, multi = false }) {
  const selected = Array.isArray(value) ? value : (value ? [value] : []);

  const toggle = (opt) => {
    if (multi) {
      const next = selected.includes(opt)
        ? selected.filter(s => s !== opt)
        : [...selected, opt];
      onChange(next);
    } else {
      onChange(opt === value ? '' : opt);
    }
  };

  return (
    <div className="chip-group">
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          className={`chip ${(multi ? selected.includes(opt) : value === opt) ? 'on' : ''}`}
          onClick={() => toggle(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function StepBuilder({ items, onChange, placeholder = 'Next step...' }) {
  const add = () => onChange([...items, { value: '' }]);
  const remove = (i) => items.length > 1 && onChange(items.filter((_, idx) => idx !== i));
  const update = (i, val) => onChange(items.map((item, idx) => idx === i ? { value: val } : item));

  return (
    <div className="step-builder">
      {items.map((item, i) => (
        <div key={i} className="step-row">
          <div className="step-num">{i + 1}</div>
          <input
            type="text"
            value={item.value}
            onChange={e => update(i, e.target.value)}
            placeholder={placeholder}
          />
          <button type="button" className="btn-rem" onClick={() => remove(i)}>×</button>
        </div>
      ))}
      <button type="button" className="btn-add" onClick={add}>+ Add step</button>
    </div>
  );
}

function StageBuilder({ items, onChange, placeholder = 'Stage name' }) {
  const add = () => onChange([...items, { value: '' }]);
  const remove = (i) => items.length > 1 && onChange(items.filter((_, idx) => idx !== i));
  const update = (i, val) => onChange(items.map((item, idx) => idx === i ? { value: val } : item));

  return (
    <div className="step-builder">
      {items.map((item, i) => (
        <div key={i} className="stage-row">
          <span className="drag-handle">⠿</span>
          <input
            type="text"
            value={item.value}
            onChange={e => update(i, e.target.value)}
            placeholder={placeholder}
          />
          <button type="button" className="btn-rem" onClick={() => remove(i)}>×</button>
        </div>
      ))}
      <button type="button" className="btn-add" onClick={add}>+ Add stage</button>
    </div>
  );
}

function TeamBuilder({ members, onChange }) {
  const add = () => onChange([...members, { name: '', role: '' }]);
  const remove = (i) => members.length > 1 && onChange(members.filter((_, idx) => idx !== i));
  const update = (i, field, val) => onChange(members.map((m, idx) => idx === i ? { ...m, [field]: val } : m));

  return (
    <div>
      <div className="col-labels" style={{ gridTemplateColumns: '1fr 1fr 32px' }}>
        <span className="col-label">Name</span>
        <span className="col-label">Role</span>
        <span />
      </div>
      {members.map((m, i) => (
        <div key={i} className="team-row">
          <input type="text" value={m.name} onChange={e => update(i, 'name', e.target.value)} placeholder="e.g. Azim" />
          <input type="text" value={m.role} onChange={e => update(i, 'role', e.target.value)} placeholder="e.g. Project Manager" />
          <button type="button" className="btn-rem" onClick={() => remove(i)}>×</button>
        </div>
      ))}
      <button type="button" className="btn-add" onClick={add}>+ Add person</button>
    </div>
  );
}

function LinkBuilder({ links, onChange, placeholder = 'https://...' }) {
  const add = () => onChange([...links, '']);
  const remove = (i) => links.length > 1 && onChange(links.filter((_, idx) => idx !== i));
  const update = (i, val) => onChange(links.map((l, idx) => idx === i ? val : l));

  return (
    <div className="link-builder">
      {links.map((l, i) => (
        <div key={i} className="link-row">
          <input type="url" value={l} onChange={e => update(i, e.target.value)} placeholder={placeholder} />
          {links.length > 1 && <button type="button" className="btn-rem" onClick={() => remove(i)}>×</button>}
        </div>
      ))}
      <button type="button" className="btn-add" onClick={add}>+ Add another link</button>
    </div>
  );
}

function AttachOrLink({ links, onChange, label = 'Share link', hint }) {
  return (
    <div className="attach-box">
      {hint && <p className="attach-hint">{hint}</p>}
      <LinkBuilder links={links} onChange={onChange} placeholder="Paste a link (Notion, Google Drive, Dropbox...)" />
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="field">
      <label className="fl">{label}</label>
      {hint && <span className="fh">{hint}</span>}
      {children}
    </div>
  );
}

function ModSection({ badge, badgeClass = 'b-os', title, children }) {
  return (
    <div className="mod-sec">
      <div className="mod-hdr">
        <span className={`mod-badge ${badgeClass}`}>{badge}</span>
        <span className="mod-title">{title}</span>
      </div>
      <div className="mod-body">{children}</div>
    </div>
  );
}

// ── MAIN PAGE ──────────────────────────────────────────────────────────────
export default function Onboarding() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(defaultForm);
  const [clientName, setClientName] = useState('');
  const [osPackage, setOsPackage] = useState('');
  const [addons, setAddons] = useState([]);
  const [dealId, setDealId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Parse URL params on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const client = params.get('client') || '';
    const pkg = params.get('package') || '';
    const addonsParam = params.get('addons') || '';
    const deal = params.get('deal') || '';

    setClientName(decodeURIComponent(client));
    setOsPackage(decodeURIComponent(pkg));
    setAddons(addonsParam ? decodeURIComponent(addonsParam).split(',').map(a => a.trim()) : []);
    setDealId(deal);
  }, []);

  const set = useCallback((key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
  }, []);

  const relevantSteps = getRelevantSteps(osPackage, addons);
  const currentStepIndex = relevantSteps.indexOf(step);

  const goNext = () => {
    const nextIdx = currentStepIndex + 1;
    if (nextIdx < relevantSteps.length) setStep(relevantSteps[nextIdx]);
  };

  const goPrev = () => {
    const prevIdx = currentStepIndex - 1;
    if (prevIdx >= 0) setStep(relevantSteps[prevIdx]);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName,
          osPackage,
          addons,
          dealId,
          ...form,
        }),
      });
      if (!res.ok) throw new Error('Submission failed');
      setStep(6);
    } catch (err) {
      setSubmitError('Something went wrong. Please try again or contact Kai on WhatsApp.');
    } finally {
      setSubmitting(false);
    }
  };

  const showRevenue = ['Revenue OS', 'Business OS', 'Agency OS'].includes(osPackage);
  const showOps = ['Operations OS', 'Business OS', 'Agency OS'].includes(osPackage);
  const showAddons = addons.length > 0;
  const hasDashboard = addons.includes('Enhanced Dashboard');
  const hasLeadCapture = addons.includes('Lead Capture System');

  return (
    <>
      <Head>
        <title>Client Implementation — Opxio</title>
        <meta name="robots" content="noindex,nofollow" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </Head>

      {/* NAV */}
      <nav>
        <a href="/" className="logo">
          <div className="logo-mark">〉〈</div>
          <span className="logo-name">Opxio</span>
        </a>
        <div className="nav-right">Client Implementation · opxio.io/onboarding</div>
      </nav>

      {/* MOBILE PROGRESS BAR */}
      <div className="mob-bar">
        <span className="mob-step-label">
          Step {currentStepIndex + 1} of {relevantSteps.length} — {STEPS[step]?.label}
        </span>
        <div className="mob-prog">
          <div className="mob-fill" style={{ width: `${((currentStepIndex) / (relevantSteps.length - 1)) * 100}%` }} />
        </div>
        <div className="mob-nav">
          <button className="mob-btn" onClick={goPrev} disabled={currentStepIndex === 0}>‹</button>
          <button className="mob-btn" onClick={goNext} disabled={currentStepIndex === relevantSteps.length - 1}>›</button>
        </div>
      </div>

      <div className="layout">
        {/* SIDEBAR */}
        <aside className="sidebar">
          <div className="sidebar-client">
            <div className="client-tag">Prepared for</div>
            <div className="client-name">{clientName || 'Your Business'}</div>
            <div className="pkg-tags">
              {osPackage && <span className="pkg-tag p">{osPackage}</span>}
              {addons.map(a => <span key={a} className="pkg-tag s">{a}</span>)}
            </div>
          </div>

          <div className="steps-label">Your progress</div>
          {relevantSteps.map((s, i) => (
            <div
              key={s}
              className={`si ${i < currentStepIndex ? 'done' : i === currentStepIndex ? 'active' : 'locked'}`}
              onClick={() => i <= currentStepIndex && setStep(s)}
            >
              <div className="sn">{i < currentStepIndex ? '✓' : i + 1}</div>
              <div>
                <div className="st">{STEPS[s].label}</div>
                {i < currentStepIndex && <div className="ss">Completed</div>}
                {i === currentStepIndex && s !== 6 && <div className="ss">In progress</div>}
                {i > currentStepIndex && <div className="ss">Locked</div>}
              </div>
            </div>
          ))}
        </aside>

        {/* MAIN */}
        <main className="main">
          {/* Progress bar */}
          {step !== 6 && (
            <div className="prog-wrap">
              {relevantSteps.filter(s => s !== 6).map((s, i) => (
                <div key={s} className={`ps ${i < currentStepIndex ? 'done' : i === currentStepIndex ? 'active' : ''}`} />
              ))}
            </div>
          )}

          {/* ── STEP 0: WELCOME ── */}
          {step === 0 && (
            <div className="sc">
              <div className="ey">Deposit confirmed</div>
              <h1 className="sec-title">Let's get your<br />system built right.</h1>
              <p className="sec-lead">This form takes 10–15 minutes. Only sections relevant to your purchase will appear — you won't see anything that doesn't apply to you.</p>

              <div className="pkg-sum">
                <div className="pkg-sum-label">What you purchased</div>
                <div className="pkg-pills">
                  {osPackage && <span className="pp m">{osPackage}</span>}
                  {addons.map(a => <span key={a} className="pp a">{a}</span>)}
                </div>
              </div>

              <div className="ibox">
                <p><strong>Before you start — do one of these first.</strong> It helps us more than a perfectly filled form.</p>
              </div>

              <div className="loom-box">
                <div className="loom-label">Optional but very helpful</div>
                <div className="loom-opts">
                  {[
                    ['🎥', 'Screen record your current setup', 'Walk through how you manage leads, projects, or tasks right now. 2–5 minutes. Send to Kai on WhatsApp after submitting.'],
                    ['🎙️', 'Voice memo', 'Record how a typical week runs — how leads come in, what happens after a client confirms, where things go wrong.'],
                    ['📸', 'Photo or whiteboard sketch', "Draw your current flow on paper. Doesn't need to be neat. Take a photo and send it over."],
                  ].map(([icon, title, desc]) => (
                    <div key={title} className="loom-opt">
                      <span className="loom-icon">{icon}</span>
                      <div className="loom-text">
                        <strong>{title}</strong>
                        <span>{desc}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="ibox"><p><strong>Build timeline — 3–4 weeks</strong> from when you submit this form.</p></div>
              <div className="btn-row">
                <button className="btn-p" onClick={goNext}>Start the form →</button>
              </div>
            </div>
          )}

          {/* ── STEP 1: BUSINESS ── */}
          {step === 1 && (
            <div className="sc">
              <div className="ey">01 — About your business</div>
              <h1 className="sec-title">Tell us about<br />your operation.</h1>
              <p className="sec-lead">A few basics so we can set everything up in the right workspace with the right people.</p>

              <div className="fs">
                <Field label="Business name">
                  <div className="pf">{clientName || 'Your Business'}<span className="pb">Pre-filled</span></div>
                </Field>

                <Field label="What does your business do?" hint="One sentence is enough.">
                  <textarea value={form.businessDesc} onChange={e => set('businessDesc', e.target.value)} placeholder="We are a..." rows={3} />
                </Field>

                <Field label="What services or products do you offer?" hint="List your main offerings — used to scope your build.">
                  <textarea value={form.servicesList} onChange={e => set('servicesList', e.target.value)} placeholder="e.g. Social media management, branding, paid ads" rows={2} />
                </Field>

                <Field label="Team size">
                  <ChipGroup name="size" options={['Just me', '2–5', '6–10', '11–15', '15+']} value={form.teamSize} onChange={v => set('teamSize', v)} />
                </Field>

                <Field label="Who needs access to this system?" hint="Add each person — name and role. Include yourself.">
                  <TeamBuilder members={form.teamMembers} onChange={v => set('teamMembers', v)} />
                </Field>

                <Field label="Industry">
                  <ChipGroup name="ind" options={['Marketing / Creative Agency', 'Consulting / Advisory', 'Education / Coaching', 'Events / Entertainment', 'F&B / Retail', 'Tech / Software', 'Property / Real Estate', 'Other']} value={form.industry} onChange={v => set('industry', v)} />
                </Field>

                <div className="divider" style={{margin:"-8px 0"}} />

                <Field label="Notion workspace URL" hint="Settings → Members → Copy invite link">
                  <input type="url" value={form.notionUrl} onChange={e => set('notionUrl', e.target.value)} placeholder="https://notion.so/invite/..." />
                </Field>

                <Field label="Notion plan">
                  <ChipGroup name="np" options={['Free', 'Plus', 'Business']} value={form.notionPlan} onChange={v => set('notionPlan', v)} />
                </Field>

                <Field label="Does your team use Notion already?">
                  <ChipGroup name="nu" options={['Daily', 'Sometimes', "We're new to it"]} value={form.notionUsage} onChange={v => set('notionUsage', v)} />
                </Field>

                <Field label="How should your team access the system?" hint="This affects whether we recommend upgrading to Notion Business plan with Teamspaces.">
                  <ChipGroup
                    name="naccess"
                    options={['Share 1 Notion account across the team', 'Each person logs in with their own account', 'Not sure — help me decide']}
                    value={form.notionAccess}
                    onChange={v => set('notionAccess', v)}
                  />
                  {form.notionAccess === 'Share 1 Notion account across the team' && (
                    <div className="ibox" style={{ marginTop: 10 }}>
                      <p>⚠️ <strong>Heads up</strong> — sharing one Notion login means no activity tracking and you can't assign tasks to individuals. Works best for solo operators.</p>
                    </div>
                  )}
                  {form.notionAccess === 'Not sure — help me decide' && (
                    <div className="info-card" style={{ marginTop: 10 }}>
                      <div className="info-row">
                        <span>👤</span>
                        <div>
                          <strong>Free / Plus — no Teamspace</strong>
                          <p>Everyone is a workspace member. Pages shared manually. No permission groups. Good for teams of 1–5 who see everything.</p>
                        </div>
                      </div>
                      <div className="info-row">
                        <span>🏢</span>
                        <div>
                          <strong>Business plan — Teamspaces (USD 24/member/month)</strong>
                          <p>Each person has their own login. Group by team (Sales, Ops, Creative). Control what each group sees. Best for 5+ people or when you need access permissions.</p>
                        </div>
                      </div>
                    </div>
                  )}
                </Field>

                <Field label="Do you need different people to see different things?" hint="e.g. Finance sees invoices but not HR data. Management has a private view.">
                  <ChipGroup
                    name="nperms"
                    options={['Yes — different roles see different things', 'No — everyone sees everything', 'Not sure']}
                    value={form.notionPermissions.join('')}
                    onChange={v => set('notionPermissions', [v])}
                  />
                  {(form.notionPermissions[0] === 'Yes — different roles see different things' || form.notionPermissions[0] === 'Not sure') && (
                    <div style={{ marginTop: 10 }}>
                      <p className="fh" style={{ marginBottom: 8 }}>Which areas need to stay private or restricted?</p>
                      <ChipGroup
                        multi
                        name="perms"
                        options={['Salary / compensation data', 'Deal values & pipeline', 'Invoice amounts', 'Client contacts', 'HR & hiring info', 'Management-only reports', 'Finance records']}
                        value={form.notionPermissions.slice(1)}
                        onChange={v => set('notionPermissions', [form.notionPermissions[0], ...v])}
                      />
                    </div>
                  )}
                </Field>

                <Field label="Do you have existing data to import?" hint="E.g. current client list, pipeline spreadsheet, project records">
                  <ChipGroup name="data" options={['Yes — I have data', 'No, start fresh']} value={form.existingData} onChange={v => set('existingData', v)} />
                  {form.existingData === 'Yes — I have data' && (
                    <div style={{ marginTop: 10 }}>
                      <LinkBuilder links={form.existingDataLinks} onChange={v => set('existingDataLinks', v)} placeholder="Google Sheets, Notion, Dropbox, or any link..." />
                    </div>
                  )}
                </Field>

                <Field label="Preferred comms during build">
                  <ChipGroup name="comms" options={['WhatsApp', 'Email']} value={form.comms} onChange={v => set('comms', v)} />
                </Field>
              </div>

              <div className="btn-row">
                <button className="btn-p" onClick={goNext}>Continue →</button>
                <button className="btn-g" onClick={goPrev}>Back</button>
              </div>
            </div>
          )}

          {/* ── STEP 2: REVENUE OS ── */}
          {step === 2 && showRevenue && (
            <div className="sc">
              <div className="ey">02 — Revenue OS</div>
              <h1 className="sec-title">Pipeline, deals<br />&amp; payments.</h1>
              <p className="sec-lead">Shapes how your CRM, deals flow, invoicing, and revenue tracking gets built.</p>

              <ModSection badge="Leads CRM" title="How leads come in">
                <div className="fs">
                  <Field label="Where do your leads come from?">
                    <ChipGroup multi name="ls" options={['Instagram DM', 'WhatsApp', 'Referral', 'LinkedIn', 'Website form', 'Ads', 'Existing client', 'Cold outreach', 'Events', 'Other']} value={form.leadSources} onChange={v => set('leadSources', v)} />
                  </Field>
                  <Field label="How do you currently track leads?">
                    <ChipGroup name="lt" options={['WhatsApp threads', 'Spreadsheet', 'A CRM tool', 'Notion already', 'Nothing formal']} value={form.leadTracking} onChange={v => set('leadTracking', v)} />
                  </Field>
                  <Field label="Roughly how many new leads per month?">
                    <ChipGroup name="lv" options={['Under 5', '5–15', '15–30', '30+']} value={form.leadVolume} onChange={v => set('leadVolume', v)} />
                  </Field>
                  <Field label="What info do you note about a lead?">
                    <ChipGroup multi name="li" options={['Name', 'What they need', 'Budget', 'Where they found us', 'When they messaged', 'Whether we followed up', 'Company name']} value={form.leadInfo} onChange={v => set('leadInfo', v)} />
                  </Field>
                  <Field label="Pipeline stages">
                    <ChipGroup name="ps" options={['Use default — Incoming → Contacted → Qualified → Converted → Lost', 'I have my own stages']} value={form.pipelineStages} onChange={v => set('pipelineStages', v)} />
                    {form.pipelineStages === 'I have my own stages' && (
                      <div style={{ marginTop: 10 }}>
                        <StageBuilder items={form.customStages} onChange={v => set('customStages', v)} placeholder="Stage name" />
                      </div>
                    )}
                  </Field>
                </div>
              </ModSection>

              <ModSection badge="Sales Pipeline" title="From lead to signed client">
                <div className="fs">
                  <Field label="Walk us through your sales stages" hint="Add each step in order — from first contact to signed client.">
                    <StepBuilder items={form.salesSteps} onChange={v => set('salesSteps', v)} placeholder="e.g. Lead comes in via Instagram DM" />
                  </Field>
                  <Field label="Active deals at any time">
                    <ChipGroup name="dv" options={['1–3', '3–10', '10–20', '20+']} value={form.activeDeals} onChange={v => set('activeDeals', v)} />
                  </Field>
                  <Field label="What do you track on each deal?">
                    <ChipGroup multi name="dt" options={['Client name', 'Deal value', 'Stage / status', "What they're buying", 'Follow-up date', 'Proposal status', 'Source', 'Notes']} value={form.dealTracking} onChange={v => set('dealTracking', v)} />
                  </Field>
                  <Field label="Where do deals usually get stuck or go cold?">
                    <ChipGroup multi name="ds" options={['After sending proposal — client ghosts', 'After discovery call — no follow-up', 'Price negotiation', 'Client goes quiet mid-review', 'No clear next step after meeting']} value={form.dealStuck} onChange={v => set('dealStuck', v)} />
                  </Field>
                  <Field label="Invoice currency">
                    <ChipGroup name="dc" options={['MYR', 'USD', 'SGD', 'Mixed']} value={form.dealCurrency} onChange={v => set('dealCurrency', v)} />
                  </Field>
                </div>
              </ModSection>

              <ModSection badge="Proposals & Quotations" title="How you pitch and quote">
                <div className="fs">
                  <Field label="How do you currently send proposals?">
                    <ChipGroup name="pm" options={['PDF via WhatsApp', 'Email attachment', 'Google Docs link', 'Notion page', 'No formal proposal', 'Other']} value={form.proposalMethod} onChange={v => set('proposalMethod', v)} />
                  </Field>
                  <Field label="What do you track on each proposal?">
                    <ChipGroup multi name="pt" options={['Client name', 'Proposal value', 'Status (sent, accepted, rejected)', 'Sent date', 'Valid until date', 'Which services are included', 'PDF link']} value={form.proposalTracking} onChange={v => set('proposalTracking', v)} />
                  </Field>
                  <Field label="Contract style">
                    <ChipGroup name="ct" options={['Standard template always', 'Mix of both', 'Always custom', 'No formal contract']} value={form.contractType} onChange={v => set('contractType', v)} />
                  </Field>
                </div>
              </ModSection>

              <ModSection badge="Invoices & Payments" title="How you get paid">
                <div className="fs">
                  <Field label="How do you currently create invoices?">
                    <ChipGroup name="im" options={['Word / Google Docs template', 'Accounting software', 'Spreadsheet', 'Manually written', 'No formal invoice']} value={form.invoiceMethod} onChange={v => set('invoiceMethod', v)} />
                  </Field>
                  <Field label="Standard payment terms">
                    <ChipGroup name="pterm" options={['50% deposit, 50% on delivery', 'Full upfront', 'Monthly retainer', 'Custom per client', 'Other']} value={form.paymentTerms} onChange={v => set('paymentTerms', v)} />
                    {form.paymentTerms === 'Other' && (
                      <input style={{ marginTop: 8 }} type="text" value={form.paymentTermsOther} onChange={e => set('paymentTermsOther', e.target.value)} placeholder="e.g. Milestone-based, 30 days net" />
                    )}
                  </Field>
                  <Field label="Payment methods your clients use">
                    <ChipGroup multi name="pmeth" options={['Bank transfer', 'Online banking', 'Stripe / PayPal', 'Cash', 'Cheque']} value={form.paymentMethods} onChange={v => set('paymentMethods', v)} />
                  </Field>
                  <Field label="What do you track on every invoice?">
                    <ChipGroup multi name="it" options={['Client name', 'Amount', 'Due date', 'Paid / unpaid status', 'Deposit vs balance', 'Invoice reference number', 'Payment date']} value={form.invoiceTracking} onChange={v => set('invoiceTracking', v)} />
                  </Field>
                  <Field label="Biggest payment tracking problem right now">
                    <ChipGroup multi name="pp" options={['Forget to follow up on overdue invoices', "No clear view of what's been paid vs pending", 'Manual reconciliation is slow', 'Clients pay late without us knowing', 'No record of payment receipts']} value={form.paymentProblems} onChange={v => set('paymentProblems', v)} />
                  </Field>
                  <Field label="WhatsApp for payment reminders & confirmations">
                    <div className="fr">
                      <input type="tel" value={form.paymentWhatsapp} onChange={e => set('paymentWhatsapp', e.target.value)} placeholder="+60 11-xxxx xxxx" />
                      <ChipGroup name="pwt" options={['Personal', 'WhatsApp Business']} value={form.paymentWhatsappType} onChange={v => set('paymentWhatsappType', v)} />
                    </div>
                  </Field>
                  <Field label="Who handles invoicing on your team?">
                    <input type="text" value={form.invoiceOwner} onChange={e => set('invoiceOwner', e.target.value)} placeholder="e.g. Ain — Finance / Yourself" />
                  </Field>
                </div>
              </ModSection>

              <div className="btn-row">
                <button className="btn-p" onClick={goNext}>Continue →</button>
                <button className="btn-g" onClick={goPrev}>Back</button>
              </div>
            </div>
          )}

          {/* ── STEP 3: OPERATIONS OS ── */}
          {step === 3 && showOps && (
            <div className="sc">
              <div className="ey">03 — Operations OS</div>
              <h1 className="sec-title">Projects, delivery<br />&amp; team ops.</h1>
              <p className="sec-lead">Shapes your project tracker, task structure, onboarding flow, and SOPs.</p>

              <ModSection badge="Project Tracker" title="How projects run">
                <div className="fs">
                  <Field label="Project types you run">
                    <ChipGroup multi name="pt" options={['Monthly retainer', 'One-off project', 'Campaign-based', 'Event', 'Consulting']} value={form.projectTypes} onChange={v => set('projectTypes', v)} />
                  </Field>
                  <Field label="After a client pays — what happens step by step?" hint="Add each step. This becomes your Phase Templates.">
                    <StepBuilder items={form.deliverySteps} onChange={v => set('deliverySteps', v)} placeholder="e.g. Send kick-off form" />
                  </Field>
                  <Field label="Project stages">
                    <ChipGroup name="pstages" options={['Use default — Kick-off → In Progress → Client Review → Revision → Final Delivery → Completed', 'I have my own stages']} value={form.projectStages} onChange={v => set('projectStages', v)} />
                    {form.projectStages === 'I have my own stages' && (
                      <div style={{ marginTop: 10 }}>
                        <StageBuilder items={form.customProjectStages} onChange={v => set('customProjectStages', v)} />
                      </div>
                    )}
                  </Field>
                  <Field label="Active projects at any time">
                    <ChipGroup name="ap" options={['1–5', '5–15', '15–30', '30+']} value={form.activeProjects} onChange={v => set('activeProjects', v)} />
                  </Field>
                  <Field label="How long does a typical project take?" hint="This sets your build timeline in the system.">
                    <ChipGroup name="tpl" options={['Under 2 weeks', '2–4 weeks', '1–3 months', '3+ months']} value={form.typicalProjectLength} onChange={v => set('typicalProjectLength', v)} />
                  </Field>
                  <Field label="Where do projects usually get stuck?">
                    <ChipGroup multi name="pstuck" options={['Waiting for client feedback', 'Unclear brief', 'Handover between team members', 'No clear deadline', 'Scope creep']} value={form.projectStuck} onChange={v => set('projectStuck', v)} />
                  </Field>
                </div>
              </ModSection>

              <ModSection badge="Task Management" title="How work gets assigned">
                <div className="fs">
                  <Field label="How does your team currently track tasks?">
                    <ChipGroup name="tm" options={['WhatsApp', 'Spreadsheet', 'ClickUp / Asana', 'Notion already', 'Nothing formal']} value={form.taskTracking} onChange={v => set('taskTracking', v)} />
                  </Field>
                  <Field label="Task stages">
                    <ChipGroup name="ts" options={['Use default — To Do → In Progress → In Review → Done', 'I have my own stages']} value={form.taskStages} onChange={v => set('taskStages', v)} />
                    {form.taskStages === 'I have my own stages' && (
                      <input style={{ marginTop: 8 }} type="text" value={form.taskStagesCustom} onChange={e => set('taskStagesCustom', e.target.value)} placeholder="e.g. Backlog, Doing, Blocked, Done — comma separated" />
                    )}
                  </Field>
                  <Field label="What every task needs to have">
                    <ChipGroup multi name="tf" options={['Task name', 'Assigned to', 'Due date', 'Which project it belongs to', 'Priority level', 'Notes / description']} value={form.taskFields} onChange={v => set('taskFields', v)} />
                  </Field>
                  <Field label="Why tasks usually fall through the cracks">
                    <ChipGroup multi name="tp" options={["Nobody knew who was responsible", 'Task only existed in WhatsApp', "Deadline wasn't set", 'Too many chats to track']} value={form.taskProblems} onChange={v => set('taskProblems', v)} />
                  </Field>
                  <Field label="Who assigns tasks?">
                    <input type="text" value={form.taskOwner} onChange={e => set('taskOwner', e.target.value)} placeholder="e.g. Project Manager / Founder / Team Leads" />
                  </Field>
                </div>
              </ModSection>

              <ModSection badge="Client Onboarding" title="From signed to work started">
                <div className="fs">
                  <Field label="After a client confirms — what happens until work begins?" hint="Add each step from payment to day one of work.">
                    <StepBuilder items={form.onboardingSteps} onChange={v => set('onboardingSteps', v)} placeholder="e.g. Client pays deposit" />
                  </Field>
                  <Field label="What info do you collect from every new client before starting?">
                    <ChipGroup multi name="oc" options={['Brand kit / logo', 'Login credentials / access', 'Brief / requirements doc', 'Reference materials', 'Contract / agreement', 'Payment receipt']} value={form.onboardingCollect} onChange={v => set('onboardingCollect', v)} />
                  </Field>
                  <Field label="What most commonly goes wrong during onboarding?">
                    <ChipGroup multi name="op" options={['Forgot to get the brand guide', 'Kick-off call not scheduled', 'Assets collected too late', 'No clear handover to the team', 'Client not sure what to send']} value={form.onboardingProblems} onChange={v => set('onboardingProblems', v)} />
                  </Field>
                  <Field label="Do you have an onboarding checklist or SOP already?">
                    <ChipGroup name="ec" options={["Yes — I'll share it", 'No — build from scratch']} value={form.existingChecklist} onChange={v => set('existingChecklist', v)} />
                    {form.existingChecklist === "Yes — I'll share it" && (
                      <div style={{ marginTop: 10 }}>
                        <AttachOrLink links={form.checklistLinks} onChange={v => set('checklistLinks', v)} hint="Notion page, Google Doc, PDF — anything works" />
                      </div>
                    )}
                  </Field>
                  <Field label="How consistent is your current onboarding?">
                    <ChipGroup name="ocon" options={['Very consistent — same every time', 'Somewhat — depends on the client', 'Inconsistent — founder does it ad hoc']} value={form.onboardingConsistency} onChange={v => set('onboardingConsistency', v)} />
                  </Field>
                </div>
              </ModSection>

              <ModSection badge="SOP & Process Library" title="Your documented processes">
                <div className="fs">
                  <Field label="Do you have existing SOPs or processes documented anywhere?">
                    <ChipGroup name="sop" options={["Yes — I'll share them", 'No — build from scratch']} value={form.existingSOPs} onChange={v => set('existingSOPs', v)} />
                    {form.existingSOPs === "Yes — I'll share them" && (
                      <div style={{ marginTop: 10 }}>
                        <AttachOrLink links={form.sopLinks} onChange={v => set('sopLinks', v)} hint="Notion, Google Drive, Confluence, Word docs" />
                      </div>
                    )}
                  </Field>
                  <Field label="Which processes most need to be documented first?">
                    <ChipGroup multi name="sops" options={['Client onboarding', 'Content approval flow', 'Invoice & payment collection', 'New team member onboarding', 'Campaign production', 'Lead follow-up process', 'Delivery & handover']} value={form.prioritySOPs} onChange={v => set('prioritySOPs', v)} />
                  </Field>
                </div>
              </ModSection>

              <div className="btn-row">
                <button className="btn-p" onClick={goNext}>Continue →</button>
                <button className="btn-g" onClick={goPrev}>Back</button>
              </div>
            </div>
          )}

          {/* ── STEP 4: ADD-ONS ── */}
          {step === 4 && showAddons && (
            <div className="sc">
              <div className="ey">04 — Add-ons</div>
              <h1 className="sec-title">Your add-on<br />configuration.</h1>
              <p className="sec-lead">Quick questions to configure your add-ons exactly right.</p>

              {hasDashboard && (
                <ModSection badge="Enhanced Dashboard" badgeClass="b-addon" title="Your live analytics">
                  <div className="fs">
                    <Field label="Who needs to see the dashboard?">
                      <ChipGroup name="dv" options={['Founder only', 'Management only', 'Whole team']} value={form.dashboardViewers} onChange={v => set('dashboardViewers', v)} />
                    </Field>
                    <Field label="Numbers you wish you could see at a glance" hint="Select all that matter to you">
                      <ChipGroup multi name="kpi" options={['Total revenue this month', 'Revenue vs last month', 'Deals closing this week', 'How many active clients', 'Invoices overdue', 'Pipeline value total', 'Win rate this month', 'Tasks overdue across team', 'Active project count', 'Something else']} value={form.dashboardKPIs} onChange={v => set('dashboardKPIs', v)} />
                      {form.dashboardKPIs.includes('Something else') && (
                        <input style={{ marginTop: 8 }} type="text" value={form.dashboardKPIother} onChange={e => set('dashboardKPIother', e.target.value)} placeholder="What else do you want to see?" />
                      )}
                    </Field>
                  </div>
                </ModSection>
              )}

              {hasLeadCapture && (
                <ModSection badge="Lead Capture" badgeClass="b-addon" title="How leads come in">
                  <div className="fs">
                    <Field label="Lead sources to capture from">
                      <ChipGroup multi name="als" options={['Instagram DM', 'WhatsApp', 'Web form', 'Paid ads', 'Website']} value={form.addonLeadSources} onChange={v => set('addonLeadSources', v)} />
                    </Field>
                    <Field label="Info to capture per lead">
                      <ChipGroup multi name="alf" options={['Name', 'Phone', 'Email', 'What they need', 'Budget', 'Company name']} value={form.addonLeadFields} onChange={v => set('addonLeadFields', v)} />
                    </Field>
                    <Field label="Lead alert notifications">
                      <ChipGroup name="lam" options={['WhatsApp', 'Email', 'Both']} value={form.leadAlertMethod} onChange={v => set('leadAlertMethod', v)} />
                      <div className="fr" style={{ marginTop: 10 }}>
                        <input type="tel" value={form.leadAlertNumber} onChange={e => set('leadAlertNumber', e.target.value)} placeholder="WhatsApp number for alerts +60..." />
                        <ChipGroup name="lat" options={['Personal', 'WhatsApp Business']} value={form.leadAlertType} onChange={v => set('leadAlertType', v)} />
                      </div>
                    </Field>
                  </div>
                </ModSection>
              )}

              <ModSection badge="Brand Assets" badgeClass="b-brand" title="For your dashboard design">
                <div className="fs">
                  <Field label="Do you have a brand kit?">
                    <ChipGroup name="bk" options={["Yes — I'll share a link", "No — I'll fill in details"]} value={form.brandKit} onChange={v => set('brandKit', v)} />
                    {form.brandKit === "Yes — I'll share a link" && (
                      <div style={{ marginTop: 10 }}>
                        <input type="url" value={form.brandKitLink} onChange={e => set('brandKitLink', e.target.value)} placeholder="Google Drive, Dropbox, Figma link..." />
                      </div>
                    )}
                    {form.brandKit === "No — I'll fill in details" && (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input type="color" value={form.brandColor1} onChange={e => set('brandColor1', e.target.value)} style={{ width: 40, height: 40, borderRadius: 6, padding: 2, cursor: 'pointer', flexShrink: 0 }} />
                          <input type="text" value={form.brandColor1Name} onChange={e => set('brandColor1Name', e.target.value)} placeholder="Primary color — e.g. #0A0A0A or Black" />
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input type="color" value={form.brandColor2} onChange={e => set('brandColor2', e.target.value)} style={{ width: 40, height: 40, borderRadius: 6, padding: 2, cursor: 'pointer', flexShrink: 0 }} />
                          <input type="text" value={form.brandColor2Name} onChange={e => set('brandColor2Name', e.target.value)} placeholder="Secondary color — e.g. #C6F135 or Lime Green" />
                        </div>
                        <input type="text" value={form.brandFonts} onChange={e => set('brandFonts', e.target.value)} placeholder="Fonts — e.g. Syne for headings, DM Sans for body" />
                      </div>
                    )}
                  </Field>
                  <Field label="Logo">
                    <input type="url" value={form.logoLink} onChange={e => set('logoLink', e.target.value)} placeholder="Google Drive, Dropbox link — PNG or SVG preferred" />
                  </Field>
                </div>
              </ModSection>

              <div className="btn-row">
                <button className="btn-p" onClick={goNext}>Continue →</button>
                <button className="btn-g" onClick={goPrev}>Back</button>
              </div>
            </div>
          )}

          {/* ── STEP 5: PREFERENCES ── */}
          {step === 5 && (
            <div className="sc">
              <div className="ey">05 — System preferences</div>
              <h1 className="sec-title">Final context<br />before we build.</h1>
              <p className="sec-lead">These answers shape how we name things, what we automate, and what we carry over from your current setup.</p>

              <div className="fs">
                <Field label="Share your current setup with us" hint="Paste links to anything relevant — Notion, Google Drive, ClickUp, Lark, spreadsheets. One link per field.">
                  <LinkBuilder links={form.setupLinks} onChange={v => set('setupLinks', v)} placeholder="https://notion.so/... or any link" />
                </Field>

                <div className="divider" style={{margin:"-8px 0"}} />

                <Field label="Are there repetitive tasks you wish happened automatically?" hint="e.g. When a new lead fills a form, it appears in your system. When a payment is overdue, a reminder goes out.">
                  <textarea value={form.automationWishes} onChange={e => set('automationWishes', e.target.value)} placeholder="e.g. When a client signs, their project is created automatically..." rows={3} />
                </Field>

                <Field label="Specific terms your business uses" hint="We'll use your language in the system. e.g. 'We call our clients Partners. We call proposals Decks.'">
                  <input type="text" value={form.businessTerms} onChange={e => set('businessTerms', e.target.value)} placeholder="e.g. We call leads Enquiries. We call projects Campaigns." />
                </Field>

                <Field label="Anything else we should know before we start building?">
                  <textarea value={form.anythingElse} onChange={e => set('anythingElse', e.target.value)} placeholder="Any special requirements, tools to connect, things that haven't worked before..." rows={3} />
                </Field>
              </div>

              {submitError && <p style={{ color: '#FF6B6B', fontSize: 14, marginBottom: 16 }}>{submitError}</p>}

              <div className="btn-row">
                <button className="btn-p" onClick={handleSubmit} disabled={submitting}>
                  {submitting ? 'Submitting...' : 'Submit form →'}
                </button>
                <button className="btn-g" onClick={goPrev}>Back</button>
              </div>
            </div>
          )}

          {/* ── STEP 6: DONE ── */}
          {step === 6 && (
            <div style={{ height: 'calc(100vh - 120px)', display: 'grid', gridTemplateColumns: '1fr 1fr', alignItems: 'stretch' }}>
              {/* LEFT */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 48px 48px 0', borderRight: '1px solid rgba(255,255,255,0.09)' }}>
                <div style={{ width: 72, height: 72, background: '#C6F135', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 10px rgba(198,241,53,0.1),0 0 0 22px rgba(198,241,53,0.05)', marginBottom: 28 }}>
                  <svg width="28" height="28" viewBox="0 0 38 38" fill="none"><path d="M8 19.5L15.5 27L30 12" stroke="#0A0A0A" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </div>
                <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 40, fontWeight: 800, letterSpacing: '-.03em', color: '#fff', lineHeight: 1.05, marginBottom: 16 }}>You're<br />all set.</div>
                <p style={{ fontSize: 15, color: '#A0A098', fontWeight: 300, lineHeight: 1.7, marginBottom: 28, maxWidth: 320 }}>Submitted. We'll review your answers and confirm your build timeline within 24 hours over WhatsApp.</p>
                <div style={{ background: '#161614', border: '1.5px solid rgba(255,255,255,0.09)', borderRadius: 9, padding: '14px 18px', width: '100%', maxWidth: 360 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase', color: '#606058', marginBottom: 12, fontFamily: 'DM Mono, monospace' }}>What we're building</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {osPackage && <span style={{ fontSize: 12, fontWeight: 500, fontFamily: 'DM Mono, monospace', color: '#C6F135', background: 'rgba(198,241,53,0.07)', border: '1px solid rgba(198,241,53,0.28)', padding: '5px 11px', borderRadius: 4 }}>{osPackage}</span>}
                    {addons.map(a => <span key={a} style={{ fontSize: 12, fontWeight: 500, fontFamily: 'DM Mono, monospace', color: '#A0A098', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,0.09)', padding: '5px 11px', borderRadius: 4 }}>{a}</span>)}
                  </div>
                </div>
                <div style={{ marginTop: 20, display: 'inline-flex', alignItems: 'center', gap: 10, background: '#161614', border: '1.5px solid rgba(255,255,255,0.09)', borderRadius: 8, padding: '10px 16px' }}>
                  <span style={{ fontSize: 11, color: '#606058', fontFamily: 'DM Mono, monospace', letterSpacing: '.08em', textTransform: 'uppercase' }}>Est. build time</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: '#C6F135', fontFamily: 'Syne, sans-serif' }}>3–4 weeks</span>
                </div>
              </div>

              {/* RIGHT */}
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '48px 0 48px 48px', gap: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.16em', textTransform: 'uppercase', color: '#606058', fontFamily: 'DM Mono, monospace', marginBottom: 4 }}>What happens next</div>
                {[
                  ['Review within 24 hours', 'We go through every answer before we build anything. Expect a WhatsApp from Kai confirming the plan.'],
                  ['Build begins', "We work directly in your Notion workspace. Your team won't be disrupted — we build around your current setup."],
                  ['Handover session', 'Live walkthrough with your team. Written sign-off. Your system, fully yours.'],
                ].map(([title, desc], i) => (
                  <div key={i} className="nstep">
                    <div className="ns-n">{i + 1}</div>
                    <div className="ns-t"><strong>{title}</strong><br />{desc}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      <style jsx global>{`
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        :root{
          --black:#080808;--surface:#161614;--surface2:#1F1F1D;--surface3:#2A2A27;
          --border:rgba(255,255,255,0.10);--border-md:rgba(255,255,255,0.18);
          --lime:#C6F135;--lime-dim:#A8D420;--lime-bg:rgba(198,241,53,0.06);--lime-border:rgba(198,241,53,0.32);
          --white:#FFFFFF;--text:#E8E8E1;--text-sub:#A8A8A0;--text-muted:#66665E;
          --chip-border:rgba(255,255,255,0.16);--chip-bg:rgba(255,255,255,0.05);
          --input-bg:#0E0E0C;--input-border:rgba(255,255,255,0.12);
        }
        html{font-size:15px;}
        body{font-family:'DM Sans',sans-serif;color:var(--text);background:var(--black);min-height:100vh;-webkit-font-smoothing:antialiased;}

        nav{display:flex;align-items:center;justify-content:space-between;padding:0 48px;height:58px;border-bottom:1px solid var(--border);background:rgba(8,8,8,0.96);backdrop-filter:blur(20px);position:sticky;top:0;z-index:100;}
        .logo{display:flex;align-items:center;gap:9px;text-decoration:none;}
        .logo-mark{width:32px;height:32px;background:var(--lime);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--black);font-family:'DM Mono',monospace;}
        .logo-name{font-family:'Syne',sans-serif;font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--lime);}
        .nav-right{font-size:12px;color:var(--text-muted);font-family:'DM Mono',monospace;letter-spacing:.04em;}

        .layout{display:grid;grid-template-columns:260px 1fr;min-height:calc(100vh - 58px);}
        .sidebar{border-right:1px solid var(--border);padding:32px 24px;position:sticky;top:58px;height:calc(100vh - 58px);overflow-y:auto;background:var(--surface);box-shadow:1px 0 0 rgba(255,255,255,0.03);}
        .sidebar-client{margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid var(--border);}
        .client-tag{font-size:10px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--lime-dim);margin-bottom:7px;font-family:'DM Mono',monospace;}
        .client-name{font-family:'Syne',sans-serif;font-size:17px;font-weight:700;color:var(--white);margin-bottom:10px;}
        .pkg-tags{display:flex;flex-direction:column;gap:5px;}
        .pkg-tag{display:inline-flex;font-size:11px;font-weight:500;font-family:'DM Mono',monospace;letter-spacing:.04em;padding:4px 10px;border-radius:4px;width:fit-content;}
        .pkg-tag.p{background:var(--lime-bg);border:1px solid var(--lime-border);color:var(--lime);}
        .pkg-tag.s{background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--text-sub);}
        .steps-label{font-size:10px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px;font-family:'DM Mono',monospace;margin-top:20px;}
        .si{display:flex;align-items:flex-start;gap:10px;padding:8px 9px;border-radius:7px;cursor:pointer;transition:background .13s;border:1px solid transparent;margin-bottom:2px;}
        .si:hover:not(.locked){background:var(--surface2);}
        .si.active{background:var(--lime-bg);border-color:var(--lime-border);}
        .si.locked{opacity:.28;cursor:default;pointer-events:none;}
        .sn{width:22px;height:22px;min-width:22px;border-radius:50%;border:1.5px solid var(--border-md);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:var(--text-muted);font-family:'DM Mono',monospace;transition:all .13s;margin-top:2px;}
        .si.active .sn{border-color:var(--lime);color:var(--lime);}
        .si.done .sn{background:var(--lime);border-color:var(--lime);color:var(--black);}
        .st{font-size:13px;font-weight:500;color:var(--text-sub);line-height:1.3;}
        .si.active .st{color:var(--white);}
        .si.done .st{color:var(--text-muted);}
        .ss{font-size:11px;color:var(--text-muted);margin-top:1px;font-family:'DM Mono',monospace;}
        .si.active .ss{color:var(--lime-dim);}

        .main{padding:44px 56px 80px;width:100%;}
        .sc{width:100%;max-width:640px;}

        .prog-wrap{display:flex;gap:5px;margin-bottom:40px;}
        .ps{height:3px;border-radius:2px;flex:1;background:var(--surface3);transition:background .3s;}
        .ps.done{background:var(--lime);}
        .ps.active{background:linear-gradient(90deg,var(--lime) 40%,var(--surface3) 100%);}

        .ey{font-size:10px;font-weight:600;letter-spacing:.18em;color:var(--lime-dim);text-transform:uppercase;margin-bottom:9px;font-family:'DM Mono',monospace;display:flex;align-items:center;gap:10px;}
        .ey::after{content:'';flex:1;height:1px;background:var(--border);max-width:120px;}
        .sec-title{font-family:'Syne',sans-serif;font-size:28px;font-weight:800;letter-spacing:-.025em;color:var(--white);line-height:1.1;margin-bottom:10px;}
        .sec-lead{font-size:14px;color:var(--text-sub);font-weight:300;line-height:1.75;max-width:520px;margin-bottom:32px;}

        .ibox{border-left:3px solid var(--lime);background:var(--lime-bg);padding:14px 18px;border-radius:0 7px 7px 0;margin-bottom:22px;}
        .ibox p{font-size:13.5px;color:var(--text-sub);font-weight:300;line-height:1.7;}
        .ibox strong{color:var(--white);font-weight:500;}

        .fs{display:flex;flex-direction:column;gap:20px;margin-bottom:24px;}
        .field{display:flex;flex-direction:column;gap:7px;}
        .fr{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
        label.fl,.fl{font-size:14.5px;font-weight:500;color:var(--text);}
        .fh{font-size:13px;color:var(--text-sub);font-weight:300;line-height:1.55;margin-top:-2px;}
        .divider{height:1px;background:var(--border);margin:8px 0;}

        input[type=text],input[type=url],input[type=tel],input[type=email],textarea,select{
          background:var(--input-bg);border:1.5px solid var(--input-border);border-radius:7px;
          color:var(--text);font-family:'DM Sans',sans-serif;font-size:14px;font-weight:400;
          padding:11px 14px;outline:none;transition:border-color .15s,box-shadow .15s;width:100%;
        }
        input:focus,textarea:focus,select:focus{border-color:var(--lime);box-shadow:0 0 0 3px rgba(198,241,53,.09);}
        input::placeholder,textarea::placeholder{color:var(--text-muted);font-weight:300;}
        textarea{resize:vertical;line-height:1.65;}

        .chip-group{display:flex;flex-wrap:wrap;gap:7px;}
        .chip{font-size:13.5px;font-weight:400;color:var(--text-sub);border:1.5px solid var(--chip-border);background:var(--chip-bg);padding:9px 16px;border-radius:6px;cursor:pointer;transition:all .12s;line-height:1;user-select:none;}
        .chip:hover{border-color:var(--border-md);color:var(--white);background:rgba(255,255,255,0.08);}
        .chip.on{color:var(--lime);border-color:rgba(198,241,53,0.5);background:rgba(198,241,53,0.08);font-weight:500;}

        .pf{background:var(--surface2);border:1.5px solid var(--border);border-radius:7px;padding:11px 14px;font-size:14px;color:var(--text);display:flex;align-items:center;justify-content:space-between;gap:12px;}
        .pb{font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--lime);background:var(--lime-bg);border:1px solid var(--lime-border);padding:3px 8px;border-radius:3px;font-family:'DM Mono',monospace;white-space:nowrap;}

        .col-labels{display:grid;gap:8px;margin-bottom:4px;}
        .col-label{font-size:11px;font-weight:500;color:var(--text-muted);font-family:'DM Mono',monospace;letter-spacing:.04em;}
        .team-row{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:center;}
        .step-builder{display:flex;flex-direction:column;}
        .step-row,.stage-row{display:grid;grid-template-columns:28px 1fr auto;gap:8px;align-items:center;margin-bottom:8px;}
        .stage-row{grid-template-columns:auto 1fr auto;}
        .step-num{width:28px;height:28px;min-width:28px;border-radius:50%;background:var(--surface3);border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--text-muted);font-family:'DM Mono',monospace;}
        .drag-handle{color:var(--text-muted);padding:0 4px;font-size:14px;cursor:grab;}
        .link-builder{display:flex;flex-direction:column;gap:8px;}
        .link-row{display:flex;gap:8px;align-items:center;}
        .link-row input{flex:1;}
        .btn-rem{width:32px;height:32px;min-width:32px;border-radius:6px;border:1.5px solid var(--border);background:transparent;color:var(--text-muted);cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .12s;}
        .btn-rem:hover{border-color:#FF6B6B;color:#FF6B6B;background:rgba(255,107,107,.08);}
        .btn-add{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:500;color:var(--text-sub);border:1.5px dashed var(--border);background:transparent;padding:8px 16px;border-radius:6px;cursor:pointer;transition:all .12s;font-family:'DM Sans',sans-serif;margin-top:4px;}
        .btn-add:hover{border-color:var(--lime);color:var(--lime);}

        .attach-box{border:1.5px dashed var(--border-md);border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;}
        .attach-hint{font-size:12px;color:var(--text-muted);font-weight:300;}

        .mod-sec{margin-bottom:28px;}
        .mod-hdr{display:flex;align-items:center;gap:8px;padding:0 0 14px 0;border-bottom:1px solid var(--border);margin-bottom:18px;}
        .mod-badge{font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;padding:3px 9px;border-radius:3px;font-family:'DM Mono',monospace;}
        .b-os{background:#0a1628;color:#7EB8FF;border:1px solid rgba(126,184,255,.25);}
        .b-addon{background:#1a0e00;color:#FF9A3C;border:1px solid rgba(255,154,60,.28);}
        .b-brand{background:#180B29;color:#C49BFF;border:1px solid rgba(196,155,255,.25);}
        .mod-title{font-family:'Syne',sans-serif;font-size:16px;font-weight:700;color:var(--white);letter-spacing:-.01em;}
        .mod-body{padding:0;}

        .btn-row{display:flex;align-items:center;gap:10px;margin-top:32px;}
        .btn-p{font-family:'DM Sans',sans-serif;font-size:14px;font-weight:500;color:var(--black);background:var(--lime);padding:12px 28px;border-radius:7px;border:none;cursor:pointer;transition:all .14s;}
        .btn-p:hover:not(:disabled){background:#B5E020;transform:translateY(-1px);}
        .btn-p:disabled{opacity:.5;cursor:not-allowed;}
        .btn-g{font-family:'DM Sans',sans-serif;font-size:14px;font-weight:400;color:var(--text-sub);padding:12px 20px;border-radius:7px;border:1.5px solid var(--border);background:transparent;cursor:pointer;transition:all .14s;}
        .btn-g:hover{color:var(--white);border-color:var(--border-md);}

        .pkg-sum{background:var(--surface);border:1.5px solid var(--border);border-radius:9px;padding:18px 20px;margin-bottom:24px;}
        .pkg-sum-label{font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted);margin-bottom:12px;font-family:'DM Mono',monospace;}
        .pkg-pills{display:flex;flex-wrap:wrap;gap:8px;}
        .pp{font-size:12px;font-weight:500;font-family:'DM Mono',monospace;letter-spacing:.04em;padding:6px 12px;border-radius:5px;}
        .pp.m{color:var(--lime);background:var(--lime-bg);border:1px solid var(--lime-border);}
        .pp.a{color:var(--text-sub);background:rgba(255,255,255,.04);border:1px solid var(--border);}

        .loom-box{background:var(--surface2);border:1.5px solid var(--border);border-radius:8px;padding:16px 18px;margin-bottom:24px;}
        .loom-label{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px;font-family:'DM Mono',monospace;}
        .loom-opts{display:flex;flex-direction:column;gap:8px;}
        .loom-opt{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border:1.5px solid var(--border);border-radius:7px;background:var(--surface);}
        .loom-icon{font-size:18px;flex-shrink:0;}
        .loom-text strong{display:block;font-size:13px;font-weight:500;color:var(--white);margin-bottom:2px;}
        .loom-text span{font-size:12px;color:var(--text-muted);font-weight:300;}

        .info-card{background:var(--surface2);border:1.5px solid var(--border);border-radius:8px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;}
        .info-row{display:flex;align-items:flex-start;gap:12px;}
        .info-row span{font-size:16px;flex-shrink:0;}
        .info-row strong{display:block;font-size:13.5px;font-weight:500;color:var(--white);margin-bottom:2px;}
        .info-row p{font-size:12.5px;color:var(--text-muted);font-weight:300;line-height:1.5;}

        .nstep{display:flex;align-items:flex-start;gap:12px;padding:13px 16px;background:var(--surface);border:1.5px solid var(--border);border-radius:7px;}
        .ns-n{width:24px;height:24px;min-width:24px;border-radius:50%;background:var(--lime);color:var(--black);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;font-family:'DM Mono',monospace;margin-top:2px;}
        .ns-t{font-size:14.5px;color:var(--text-sub);font-weight:300;line-height:1.6;}
        .ns-t strong{color:var(--white);font-weight:600;font-size:15px;}

        /* MOBILE */
        .mob-bar{display:none;align-items:center;gap:12px;padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:58px;z-index:90;}
        .mob-step-label{font-size:11px;font-weight:600;color:var(--lime);font-family:'DM Mono',monospace;letter-spacing:.08em;white-space:nowrap;}
        .mob-prog{flex:1;height:3px;background:var(--surface3);border-radius:2px;overflow:hidden;}
        .mob-fill{height:100%;background:var(--lime);border-radius:2px;transition:width .3s;}
        .mob-nav{display:flex;gap:6px;}
        .mob-btn{width:28px;height:28px;border-radius:6px;border:1.5px solid var(--border);background:transparent;color:var(--text-sub);cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:all .12s;}
        .mob-btn:hover:not(:disabled){border-color:var(--lime);color:var(--lime);}
        .mob-btn:disabled{opacity:.3;}

        @media (max-width:900px){
          nav{padding:0 24px;}
          .nav-right{display:none;}
          .layout{grid-template-columns:220px 1fr;}
          .main{padding:32px 28px 80px;}
        }
        @media (max-width:640px){
          nav{padding:0 16px;}
          .layout{grid-template-columns:1fr;}
          .sidebar{display:none;}
          .mob-bar{display:flex;}
          .main{padding:20px 16px 60px;}
          .sc{max-width:100%;}
          .sec-title{font-size:24px;}
          .fr{grid-template-columns:1fr;}
          .btn-row{flex-direction:column;}
          .btn-p,.btn-g{width:100%;text-align:center;}
        }
        @media (min-width:1200px){
          .layout{grid-template-columns:280px 1fr;}
          .main{padding:48px 64px 80px;}
          .sc{max-width:680px;}
        }
      `}</style>
    </>
  );
}

