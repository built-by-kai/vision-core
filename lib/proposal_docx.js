// lib/proposal_docx.js — Opxio Proposal Word Document Generator v2
// Matches the HTML template (proposal_template.js) section-for-section:
//   Cover → Context → Install Overview → Modules → Live Dashboards → Investment → Add-Ons → Next Steps

import {
  Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
  PageBreak, AlignmentType, BorderStyle, WidthType, ShadingType,
  VerticalAlign, HeightRule, convertInchesToTwip,
} from 'docx'

// ── Colours (hex, no #) ──────────────────────────────────────────────────────
const C = {
  black:   '0A0A0A',
  gray800: '333333',
  gray600: '666666',
  gray400: 'AAAAAA',
  gray200: 'E8E8E8',
  gray100: 'F4F4F4',
  lime:    'C6F135',   // bright lime — on black bg (cover)
  limeDim: 'A8D420',   // slightly darker — on white bg (eyebrows)
  white:   'FFFFFF',
}

// ── Module library ───────────────────────────────────────────────────────────
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
}

// ── Widget map ───────────────────────────────────────────────────────────────
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
}

// ── Add-on library ───────────────────────────────────────────────────────────
const ADDON_LIBRARY = {
  'Marketing OS':          { price_label: 'RM 3,800', cadence: 'one-time',              timing: 'Anytime',    desc: 'Campaign tracking, content production workflow, and ads performance — connected to your CRM so leads from campaigns land directly in the pipeline.' },
  'People OS':             { price_label: 'RM 3,200', cadence: 'one-time',              timing: 'Month 3–6',  desc: 'Hiring pipeline, team onboarding, performance goals, leave tracking, and compensation log — structured HR in Notion.' },
  'Client Success OS':     { price_label: 'RM 3,200', cadence: 'one-time',              timing: 'Month 3–6',  desc: 'Client health scores, NPS tracking, renewal pipeline, and upsell opportunity tracker — built for retainer-heavy agencies.' },
  'Document Generation':   { price_label: 'RM 800',   cadence: 'setup + RM 150/mo',    timing: 'Anytime',    desc: 'Branded PDF quotes and invoices auto-generated from your Notion data. Button in Notion generates and emails the document.' },
  'Lead Capture System':   { price_label: 'RM 1,200', cadence: 'from',                 timing: 'Anytime',    desc: 'WhatsApp or form inquiries auto-populate your CRM pipeline without manual entry. Every lead captured, structured, and visible immediately.' },
  'Agency Command Centre': { price_label: 'RM 2,500', cadence: 'from',                 timing: 'Anytime',    desc: 'One cross-OS dashboard pulling pipeline, projects, campaigns, and team load into a single screen.' },
  'Ads Live API Integration': { price_label: 'RM 1,500', cadence: 'from',              timing: 'Anytime',    desc: 'Real-time spend and performance data pulled automatically from Meta, Google, and TikTok into your Ads Tracker — no manual entry.' },
  'Employee Dashboard':    { price_label: 'RM 1,500', cadence: 'from',                 timing: 'Anytime',    desc: 'Per-employee view showing active tasks, assigned projects, leave status, and quarterly goals.' },
  'Client Portal View':    { price_label: 'RM 350',   cadence: 'from',                 timing: 'Anytime',    desc: 'Read-only Notion view for clients to track project progress, delivery milestones, and shared assets without full workspace access.' },
}

const RETAINER_LABELS = {
  hosting:     { label: 'Hosting Only',    fee: 150 },
  maintenance: { label: 'Maintenance',     fee: 400 },
  active:      { label: 'Active Retainer', fee: 900 },
}

// ── Formatters ───────────────────────────────────────────────────────────────
function fmtRM(n) {
  return 'RM ' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ── Border helpers ───────────────────────────────────────────────────────────
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' }
const THIN      = (c = C.gray200) => ({ style: BorderStyle.SINGLE, size: 4,  color: c })
const THICK     = (c = C.black)   => ({ style: BorderStyle.SINGLE, size: 12, color: c })

function allNoBorder() {
  return { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER }
}
function bottomBorder(thick = false) {
  const b = thick ? THICK() : THIN()
  return { top: NO_BORDER, bottom: b, left: NO_BORDER, right: NO_BORDER }
}

// ── Text run ─────────────────────────────────────────────────────────────────
function run(text, opts = {}) {
  return new TextRun({
    text:  String(text ?? ''),
    font:  opts.font  || 'DM Sans',
    size:  opts.size  || 22,
    color: opts.color || C.gray800,
    bold:  opts.bold  || false,
    italics: opts.italics || false,
    ...opts,
  })
}

function syne(text, opts = {}) {
  return run(text, { font: 'Syne', ...opts })
}

// ── Paragraph builders ───────────────────────────────────────────────────────
function para(children, opts = {}) {
  const kids = Array.isArray(children) ? children : [run(String(children), opts.run || {})]
  return new Paragraph({
    children: kids,
    spacing:   { after: opts.after ?? 100, before: opts.before ?? 0, ...(opts.spacing || {}) },
    alignment: opts.alignment,
    border:    opts.border,
    indent:    opts.indent,
  })
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()], spacing: { after: 0 } })
}

// A lime-coloured eyebrow label with a thin line extending right
function eyebrow(text) {
  return para(
    [run(text.toUpperCase(), { font: 'DM Sans', size: 17, bold: true, color: C.limeDim })],
    { before: 320, after: 120 }
  )
}

// Big Syne heading (black)
function heading(text, size = 52) {
  return para(
    [syne(text, { size, bold: true, color: C.black })],
    { before: 0, after: 180 }
  )
}

// Lead paragraph (gray)
function lead(text) {
  return para(
    [run(text, { color: C.gray600 })],
    { after: 140 }
  )
}

// Small label line  LABEL   value
function labelValue(label, value, opts = {}) {
  return para([
    run(label.toUpperCase() + '    ', { size: 17, color: C.gray400, bold: true }),
    run(value, { size: 20, color: C.black, bold: opts.bold }),
  ], { before: 80, after: 40 })
}

// Divider — thin gray line underneath empty paragraph
function divider(color = C.gray200) {
  return para([''], {
    spacing: { before: 240, after: 240 },
    border:  { bottom: THIN(color) },
  })
}

// ── 2-col key/value table ────────────────────────────────────────────────────
function kv2Table(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideH: NO_BORDER, insideV: NO_BORDER },
    rows: rows.map(([label, value, isTotal]) =>
      new TableRow({
        children: [
          new TableCell({
            width:   { size: 38, type: WidthType.PERCENTAGE },
            borders: isTotal ? bottomBorder(true) : bottomBorder(),
            shading: !isTotal ? { fill: C.gray100, type: ShadingType.CLEAR, color: C.gray100 } : undefined,
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [para(
              [run(label, { size: isTotal ? 22 : 19, bold: isTotal, color: isTotal ? C.black : C.gray600 })],
              { after: 0 }
            )],
          }),
          new TableCell({
            width:   { size: 62, type: WidthType.PERCENTAGE },
            borders: isTotal ? bottomBorder(true) : bottomBorder(),
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [para(
              [run(value, { size: isTotal ? 22 : 20, bold: isTotal, color: C.black })],
              { after: 0 }
            )],
          }),
        ],
      })
    ),
  })
}

// ── Investment table ─────────────────────────────────────────────────────────
function investmentTable(rows, totalLabel, totalAmount) {
  const headerRow = new TableRow({
    children: ['ITEM', 'TYPE', 'AMOUNT'].map((h, i) =>
      new TableCell({
        width:   { size: [52, 24, 24][i], type: WidthType.PERCENTAGE },
        borders: bottomBorder(true),
        shading: { fill: C.gray100, type: ShadingType.CLEAR, color: C.gray100 },
        margins: { top: 80, bottom: 80, left: 80, right: 80 },
        children: [para(
          [run(h, { size: 16, bold: true, color: C.gray400 })],
          { after: 0, alignment: i === 2 ? AlignmentType.RIGHT : undefined }
        )],
      })
    ),
  })

  const bodyRows = rows.map(([item, type, amount]) =>
    new TableRow({
      children: [
        new TableCell({ width: { size: 52, type: WidthType.PERCENTAGE }, borders: bottomBorder(), margins: { top: 100, bottom: 100, left: 80, right: 80 }, children: [para([run(item, { color: C.black })], { after: 0 })] }),
        new TableCell({ width: { size: 24, type: WidthType.PERCENTAGE }, borders: bottomBorder(), margins: { top: 100, bottom: 100, left: 80, right: 80 }, children: [para([run(type, { color: C.gray600, size: 19 })], { after: 0 })] }),
        new TableCell({ width: { size: 24, type: WidthType.PERCENTAGE }, borders: bottomBorder(), margins: { top: 100, bottom: 100, left: 80, right: 80 }, children: [para([run(amount, { bold: true, color: C.black })], { after: 0, alignment: AlignmentType.RIGHT })] }),
      ],
    })
  )

  const totalRow = new TableRow({
    children: [
      new TableCell({ columnSpan: 2, width: { size: 76, type: WidthType.PERCENTAGE }, borders: { top: THICK(), bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER }, margins: { top: 140, bottom: 80, left: 80, right: 80 }, children: [para([run(totalLabel, { bold: true, color: C.black })], { after: 0 })] }),
      new TableCell({ width: { size: 24, type: WidthType.PERCENTAGE }, borders: { top: THICK(), bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER }, margins: { top: 140, bottom: 80, left: 80, right: 80 }, children: [para([run(totalAmount, { bold: true, color: C.black })], { after: 0, alignment: AlignmentType.RIGHT })] }),
    ],
  })

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideH: NO_BORDER, insideV: NO_BORDER },
    rows: [headerRow, ...bodyRows, totalRow],
  })
}

// ── Widget / dashboard table ─────────────────────────────────────────────────
function dashboardTable(osTypes) {
  const headerRow = new TableRow({
    children: ['DASHBOARD', 'LIVES ON', 'ANSWERS'].map((h, i) =>
      new TableCell({
        width:   { size: [30, 35, 35][i], type: WidthType.PERCENTAGE },
        borders: bottomBorder(true),
        shading: { fill: C.gray100, type: ShadingType.CLEAR, color: C.gray100 },
        margins: { top: 80, bottom: 80, left: 80, right: 80 },
        children: [para([run(h, { size: 15, bold: true, color: C.gray400 })], { after: 0 })],
      })
    ),
  })

  const widgetRows = []
  let shade = false
  for (const os of osTypes) {
    for (const w of (WIDGET_MAP[os] || [])) {
      const bg = shade ? C.gray100 : C.white
      widgetRows.push(new TableRow({
        children: [w.name, w.page, w.answers].map((text, i) =>
          new TableCell({
            width:   { size: [30, 35, 35][i], type: WidthType.PERCENTAGE },
            borders: bottomBorder(),
            shading: { fill: bg, type: ShadingType.CLEAR, color: bg },
            margins: { top: 80, bottom: 80, left: 80, right: 80 },
            children: [para([run(text, { size: 19, color: i === 0 ? C.gray800 : C.gray600 })], { after: 0 })],
          })
        ),
      }))
      shade = !shade
    }
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideH: NO_BORDER, insideV: NO_BORDER },
    rows: [headerRow, ...widgetRows],
  })
}

// ── COVER PAGE (black background table) ─────────────────────────────────────
function buildCover({ ref_number, date, os_type, company_name, contact_name, contact_role, validText, subtitle }) {

  function bCell(children, opts = {}) {
    return new TableCell({
      shading:       { fill: C.black, type: ShadingType.CLEAR, color: C.black },
      borders:       { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
      verticalAlign: opts.valign || VerticalAlign.TOP,
      margins:       opts.margins || { top: 0, bottom: 0, left: convertInchesToTwip(0.6), right: convertInchesToTwip(0.6) },
      columnSpan:    opts.span,
      children,
    })
  }

  function bPara(kids, opts = {}) {
    return new Paragraph({ children: kids, spacing: { before: opts.before || 0, after: opts.after || 0 }, alignment: opts.align })
  }

  // ROW 1 — Logo left, Ref right (2 cols)
  const row1 = new TableRow({
    height: { value: convertInchesToTwip(0.5), rule: HeightRule.ATLEAST },
    children: [
      bCell(
        [bPara([syne('Opxio', { size: 28, bold: true, color: C.white })], { before: 0, after: 0 })],
        { margins: { top: convertInchesToTwip(0.5), bottom: 0, left: convertInchesToTwip(0.6), right: convertInchesToTwip(0.2) } }
      ),
      bCell(
        [
          bPara([run(`Ref: ${ref_number}`, { size: 17, color: C.gray400 })], { after: 40, align: AlignmentType.RIGHT }),
          bPara([run(date, { size: 17, color: C.gray400 })], { after: 40, align: AlignmentType.RIGHT }),
          bPara([run('Confidential', { size: 17, color: C.gray400 })], { after: 0, align: AlignmentType.RIGHT }),
        ],
        { margins: { top: convertInchesToTwip(0.5), bottom: 0, left: convertInchesToTwip(0.2), right: convertInchesToTwip(0.6) } }
      ),
    ],
  })

  // ROW 2 — Spacer
  const row2 = new TableRow({
    height: { value: convertInchesToTwip(2.4), rule: HeightRule.ATLEAST },
    children: [bCell([bPara([run('')])], { span: 2 })],
  })

  // ROW 3 — Eyebrow + big title + subtitle
  const row3 = new TableRow({
    height: { value: convertInchesToTwip(1.8), rule: HeightRule.ATLEAST },
    children: [
      bCell(
        [
          bPara([run('SYSTEM INSTALLATION PROPOSAL', { size: 16, bold: true, color: C.gray400, font: 'DM Sans' })], { after: 280 }),
          bPara([syne(os_type, { size: 72, bold: true, color: C.white })], { after: 60 }),
          bPara([syne(`for ${company_name}.`, { size: 44, color: C.lime })], { after: 0 }),
        ],
        { span: 2, margins: { top: 0, bottom: convertInchesToTwip(0.3), left: convertInchesToTwip(0.6), right: convertInchesToTwip(0.6) } }
      ),
    ],
  })

  // ROW 4 — Lime divider line
  const row4 = new TableRow({
    height: { value: convertInchesToTwip(0.08), rule: HeightRule.EXACT },
    children: [
      new TableCell({
        shading: { fill: C.lime, type: ShadingType.CLEAR, color: C.lime },
        borders: allNoBorder(),
        columnSpan: 2,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        width: { size: 100, type: WidthType.PERCENTAGE },
        children: [bPara([run('')])],
      }),
    ],
  })

  // ROW 5 — Subtitle (OS type summary)
  const row5 = new TableRow({
    height: { value: convertInchesToTwip(0.45), rule: HeightRule.ATLEAST },
    children: [
      bCell(
        [bPara([run(subtitle, { size: 19, color: C.gray400, font: 'DM Sans' })], { after: 0 })],
        { span: 2, margins: { top: convertInchesToTwip(0.2), bottom: 0, left: convertInchesToTwip(0.6), right: convertInchesToTwip(0.6) } }
      ),
    ],
  })

  // ROW 6 — Spacer before metadata
  const row6 = new TableRow({
    height: { value: convertInchesToTwip(0.4), rule: HeightRule.ATLEAST },
    children: [bCell([bPara([run('')])], { span: 2 })],
  })

  // ROW 7 — Metadata (2x2 grid using 4 cells)
  function metaCell(label, value) {
    return bCell(
      [
        bPara([run(label.toUpperCase(), { size: 15, bold: true, color: C.gray400, font: 'DM Sans' })], { after: 60 }),
        bPara([run(value, { size: 20, color: C.white, font: 'DM Sans' })], { after: 0 }),
      ],
      { margins: { top: convertInchesToTwip(0.2), bottom: convertInchesToTwip(0.3), left: convertInchesToTwip(0.6), right: convertInchesToTwip(0.3) } }
    )
  }
  const row7 = new TableRow({
    height: { value: convertInchesToTwip(0.8), rule: HeightRule.ATLEAST },
    children: [
      metaCell('Prepared for', company_name),
      metaCell('Contact', `${contact_name}${contact_role ? ' — ' + contact_role : ''}`),
    ],
  })
  const row8 = new TableRow({
    height: { value: convertInchesToTwip(0.8), rule: HeightRule.ATLEAST },
    children: [
      metaCell('Prepared by', 'Kai — Opxio'),
      metaCell('Valid until', validText),
    ],
  })

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideH: NO_BORDER, insideV: NO_BORDER },
    rows: [row1, row2, row3, row4, row5, row6, row7, row8],
  })
}

// ── MAIN EXPORT ──────────────────────────────────────────────────────────────
export async function generateProposalDocx(data) {
  const {
    ref_number   = 'PRO-0000-001',
    date         = new Date().toLocaleDateString('en-MY', { month: 'long', year: 'numeric' }),
    valid_until,
    company_name = 'Client',
    contact_name = '',
    contact_role = '',
    whatsapp,
    email        = 'hello@opxio.io',
    website      = 'opxio.io',
    os_type      = '',
    install_tier = 'Standard',
    notion_plan  = 'Plus',
    timeline     = '3–4 weeks',
    fee          = 0,
    retainer     = 'maintenance',
    situation    = [],
    modules      = {},
    addons_now   = [],
    addons_later = [],
  } = data

  const coreFee    = Number(fee) || 0
  const deposit    = Math.round(coreFee / 2)
  const retInfo    = RETAINER_LABELS[retainer] || RETAINER_LABELS.maintenance
  const osTypes    = Object.keys(modules)
  const totalMods  = Object.values(modules).reduce((s, a) => s + a.length, 0)
  const totalWidgets = osTypes.reduce((s, os) => s + (WIDGET_MAP[os] || []).length, 0)
  const validText  = valid_until
    || (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'long', year: 'numeric' }) })()
  const subtitle   = osTypes.length > 0 ? osTypes.join(' · ') : os_type
  const headerLabel = `${os_type} Proposal`

  const hasAddonsNow   = addons_now.length > 0
  const hasAddonsLater = addons_later.length > 0
  const hasAnyAddons   = hasAddonsNow || hasAddonsLater
  const nextStepNum    = hasAnyAddons ? '04' : '03'

  const children = []

  // ────────────────────────────────────────────────────────────────────────────
  // COVER (black background)
  // ────────────────────────────────────────────────────────────────────────────
  children.push(buildCover({ ref_number, date, os_type, company_name, contact_name, contact_role, validText, subtitle }))
  children.push(pageBreak())

  // ────────────────────────────────────────────────────────────────────────────
  // PAGE 2 — CONTEXT
  // ────────────────────────────────────────────────────────────────────────────
  if (situation.length > 0) {
    children.push(eyebrow('01 — Context'))
    children.push(heading('What we heard.'))

    situation.forEach((s, idx) => {
      const isObj = typeof s === 'object' && s !== null
      const label = isObj ? s.label : null
      const text  = isObj ? s.text  : s
      if (label) {
        children.push(para(
          [run(label.toUpperCase(), { size: 16, bold: true, color: C.limeDim })],
          { before: idx === 0 ? 0 : 280, after: 80 }
        ))
      }
      if (text) children.push(lead(text))
    })

    children.push(pageBreak())
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PAGE 3 — INSTALL OVERVIEW
  // ────────────────────────────────────────────────────────────────────────────
  children.push(eyebrow('02 — The Install'))
  children.push(heading(`${os_type}.`))
  children.push(lead(`A structured operational system built on Notion — designed around how ${company_name} actually runs.`))
  children.push(
    kv2Table([
      ['Install',                `${os_type} — ${install_tier} Install`],
      ['Notion Plan Required',   `${notion_plan} — ~RM 50/month, billed to your workspace`],
      ['Total Modules',          `${totalMods} modules across ${osTypes.join(' + ')}`],
      ['Live Dashboards',        `${totalWidgets} widgets embedded inside your Notion pages`],
      ['Delivery Timeline',      `${timeline} from deposit`],
      ['Handover',               'Walkthrough session + widget orientation'],
    ])
  )
  children.push(pageBreak())

  // ────────────────────────────────────────────────────────────────────────────
  // PAGE 4 — MODULES INCLUDED
  // ────────────────────────────────────────────────────────────────────────────
  children.push(eyebrow('02 — The Install'))
  children.push(heading('Modules included.'))

  for (const [osName, mods] of Object.entries(modules)) {
    children.push(para(
      [run(osName, { bold: true, color: C.black, size: 22 })],
      { before: 280, after: 100 }
    ))
    for (const mod of mods) {
      const desc = MODULE_LIBRARY[mod] || ''
      children.push(new Paragraph({
        children: [
          run('•  ', { size: 19, color: C.limeDim, bold: true }),
          run(mod, { size: 21, color: C.black, bold: true }),
          ...(desc ? [run('   ' + desc, { size: 18, color: C.gray600 })] : []),
        ],
        spacing: { after: 80, before: 40 },
        indent:  { left: convertInchesToTwip(0.15) },
      }))
    }
  }

  children.push(pageBreak())

  // ────────────────────────────────────────────────────────────────────────────
  // PAGE 5 — LIVE DASHBOARDS
  // ────────────────────────────────────────────────────────────────────────────
  children.push(eyebrow('02 — The Install'))
  children.push(heading('Live dashboards.'))
  children.push(lead(
    `${totalWidgets} visual dashboards embedded inside your Notion pages — connected to your live data via Opxio's server. They replace the manual checking. Tasks, records, and editing stay in Notion where they belong.`
  ))
  children.push(dashboardTable(osTypes))

  // Ownership box
  children.push(para([''], { before: 320, after: 0 }))
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: NO_BORDER, bottom: NO_BORDER, left: THICK(C.limeDim), right: NO_BORDER, insideH: NO_BORDER, insideV: NO_BORDER },
      rows: [new TableRow({
        children: [new TableCell({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: NO_BORDER, bottom: NO_BORDER, left: THICK(C.limeDim), right: NO_BORDER },
          shading: { fill: 'F5FFD6', type: ShadingType.CLEAR, color: 'F5FFD6' },
          margins: { top: 140, bottom: 140, left: 200, right: 200 },
          children: [
            para([run('OWNERSHIP', { size: 16, bold: true, color: C.limeDim })], { after: 80 }),
            para([run('Your Notion workspace and all databases are yours permanently. Dashboards run on Opxio\'s infrastructure, covered by the monthly service fee. If the service is paused, your system keeps running — the live dashboards stop.', { size: 19, color: C.gray600 })], { after: 0 }),
          ],
        })],
      })],
    })
  )

  children.push(pageBreak())

  // ────────────────────────────────────────────────────────────────────────────
  // PAGE 6 — INVESTMENT
  // ────────────────────────────────────────────────────────────────────────────
  children.push(eyebrow('02 — The Install'))
  children.push(heading('Investment.'))
  children.push(
    investmentTable(
      [
        [`${os_type} — ${install_tier} Install`,          'One-time',      fmtRM(coreFee)],
        [`Widget ${retInfo.label} Retainer`,              'Monthly',       `${fmtRM(retInfo.fee)} / mo`],
        [`Notion ${notion_plan} Plan (your workspace)`,   "Client's cost", '~RM 50 / mo'],
      ],
      'Installation fee',
      fmtRM(coreFee)
    )
  )
  children.push(para(
    [run(`50% deposit (${fmtRM(deposit)}) required to begin. Balance on delivery.`, { size: 18, color: C.gray400, italics: true })],
    { before: 180, after: 0 }
  ))

  // ────────────────────────────────────────────────────────────────────────────
  // PAGE 7 — ADD-ONS (conditional)
  // ────────────────────────────────────────────────────────────────────────────
  if (hasAnyAddons) {
    children.push(pageBreak())
    children.push(eyebrow('03 — Add-Ons'))
    children.push(heading('Optional extras.'))
    children.push(lead('Add-ons are independent of the core install. Take them now or any time after. Each one is priced and scoped separately.'))

    function addonBlock(item, isNow) {
      const isObj       = typeof item === 'object' && item !== null
      const name        = isObj ? (item.name || String(item)) : String(item)
      const lib         = ADDON_LIBRARY[name] || {}
      const price_label = (isObj ? item.price_label : null) ?? lib.price_label ?? ''
      const cadence     = (isObj ? item.cadence     : null) ?? lib.cadence     ?? ''
      const desc        = (isObj ? item.desc        : null) ?? lib.desc        ?? ''

      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: NO_BORDER, bottom: NO_BORDER, left: isNow ? THICK(C.limeDim) : NO_BORDER, right: NO_BORDER, insideH: NO_BORDER, insideV: NO_BORDER },
        rows: [new TableRow({
          children: [new TableCell({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: { top: NO_BORDER, bottom: THIN(), left: isNow ? THICK(C.limeDim) : NO_BORDER, right: NO_BORDER },
            shading: isNow ? { fill: C.gray100, type: ShadingType.CLEAR, color: C.gray100 } : undefined,
            margins: { top: 140, bottom: 140, left: isNow ? 200 : 0, right: 0 },
            children: [
              para([
                run(name, { size: 22, bold: true, color: C.black }),
                price_label ? run('    ' + price_label, { size: 19, color: C.gray600 }) : run(''),
                cadence     ? run('  ' + cadence,       { size: 17, color: C.gray400, italics: true }) : run(''),
              ], { after: desc ? 80 : 0 }),
              ...(desc ? [para([run(desc, { size: 18, color: C.gray600 })], { after: 0 })] : []),
            ],
          })],
        })],
      })
    }

    if (hasAddonsNow) {
      children.push(para(
        [run('INCLUDED IN THIS PROPOSAL', { size: 16, bold: true, color: C.gray400 })],
        { before: 200, after: 120 }
      ))
      for (const item of addons_now) {
        children.push(addonBlock(item, true))
        children.push(para([''], { after: 40 }))
      }
    }

    if (hasAddonsLater) {
      children.push(para(
        [run('AVAILABLE ANY TIME', { size: 16, bold: true, color: C.gray400 })],
        { before: hasAddonsNow ? 240 : 120, after: 120 }
      ))
      for (const item of addons_later) {
        children.push(addonBlock(item, false))
        children.push(para([''], { after: 40 }))
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PAGE 8 — NEXT STEPS
  // ────────────────────────────────────────────────────────────────────────────
  children.push(pageBreak())
  children.push(eyebrow(`${nextStepNum} — How to Proceed`))
  children.push(heading('Next steps.'))

  const steps = [
    { n: '01', title: 'Confirm scope',    desc: 'Reply to this proposal or message Kai on WhatsApp to confirm the install scope and ask any questions.' },
    { n: '02', title: 'Pay deposit',       desc: `50% (${fmtRM(deposit)}) to secure your implementation slot and begin the build.` },
    { n: '03', title: 'Onboarding call',  desc: '30-minute call to map your existing data, confirm workspace access, and align on the delivery timeline.' },
    { n: '04', title: 'Build & handover', desc: `${timeline} to full installation. Handover walkthrough and widget orientation included.` },
  ]

  for (const step of steps) {
    children.push(new Paragraph({
      children: [
        syne(step.n + '  ', { size: 32, color: C.gray200, bold: true }),
        syne(step.title,    { size: 24, color: C.black,   bold: true }),
      ],
      spacing: { before: 260, after: 80 },
    }))
    children.push(lead(step.desc))
  }

  // CTA block
  children.push(divider())
  children.push(para(
    [syne('Ready to install clarity into your business?', { size: 30, bold: true, color: C.black })],
    { before: 200, after: 80 }
  ))
  children.push(lead('Message Kai directly to confirm scope and secure your slot.'))
  children.push(para([''], { after: 80 }))
  if (whatsapp) {
    children.push(labelValue('WhatsApp', whatsapp))
  }
  children.push(labelValue('Email', email))
  children.push(labelValue('Website', website))
  children.push(divider())
  children.push(para(
    [run(`This proposal is confidential and prepared exclusively for ${company_name}. Valid until ${validText}.`, { size: 16, color: C.gray400, italics: true })],
    { before: 0, after: 200 }
  ))

  // ────────────────────────────────────────────────────────────────────────────
  // BUILD
  // ────────────────────────────────────────────────────────────────────────────
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'DM Sans', size: 22, color: C.gray800 } },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top:    convertInchesToTwip(0.75),
            bottom: convertInchesToTwip(0.75),
            left:   convertInchesToTwip(1.0),
            right:  convertInchesToTwip(1.0),
          },
        },
      },
      children,
    }],
  })

  return Packer.toBuffer(doc)
}
