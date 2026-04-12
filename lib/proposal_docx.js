// lib/proposal_docx.js — Opxio Proposal Word Document Generator
// Uses the `docx` npm package to create a clean, editable .docx proposal
// No PDF pagination issues — Word handles layout perfectly

import {
  Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun,
  PageBreak, AlignmentType, BorderStyle, WidthType, ShadingType,
  convertInchesToTwip,
} from 'docx'

// ── Colours (hex strings, no #) ─────────────────────────────────────────────
const C = {
  black:   '0A0A0A',
  gray800: '333333',
  gray600: '666666',
  gray400: 'AAAAAA',
  gray200: 'E8E8E8',
  gray100: 'F4F4F4',
  lime:    '6AAD00',   // darker lime — readable on white
  white:   'FFFFFF',
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function fmtRM(n) {
  return 'RM ' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
const THIN      = (c = C.gray200) => ({ style: BorderStyle.SINGLE, size: 2, color: c })
const THICK     = (c = C.black)   => ({ style: BorderStyle.SINGLE, size: 8, color: c })

function allNoBorder() {
  return { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER }
}
function bottomOnly(thick = false) {
  const b = thick ? THICK() : THIN()
  return { top: NO_BORDER, bottom: b, left: NO_BORDER, right: NO_BORDER }
}

// ── Text builders ────────────────────────────────────────────────────────────
function run(text, opts = {}) {
  return new TextRun({ text: String(text || ''), font: 'Arial', size: 22, color: C.gray800, ...opts })
}

function para(children, opts = {}) {
  const content = Array.isArray(children) ? children : [run(children, opts.run || {})]
  return new Paragraph({
    children: content,
    spacing: { after: 100, ...(opts.spacing || {}) },
    alignment: opts.alignment,
    border: opts.border,
  })
}

function eyebrow(text) {
  return para([run(text.toUpperCase(), { color: C.lime, size: 16, bold: true })], { spacing: { before: 280, after: 80 } })
}

function heading(text, size = 48) {
  return para([run(text, { size, bold: true, color: C.black })], { spacing: { before: 80, after: 160 } })
}

function lead(text) {
  return para([run(text, { color: C.gray600 })], { spacing: { after: 120 } })
}

function labelLine(label, value) {
  return para([
    run(label.toUpperCase() + '  ', { size: 18, color: C.gray400, bold: true }),
    run(value, { size: 20, color: C.black, bold: true }),
  ], { spacing: { before: 80, after: 40 } })
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()], spacing: { after: 0 } })
}

function divider() {
  return para([''], { spacing: { before: 200, after: 200 }, border: { bottom: THIN() } })
}

// ── Simple 2-col table: label | value ─────────────────────────────────────
function kv2Table(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideH: NO_BORDER, insideV: NO_BORDER },
    rows: rows.map(([label, value, isTotal]) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: 38, type: WidthType.PERCENTAGE },
            borders: isTotal ? bottomOnly(true) : bottomOnly(),
            shading: !isTotal ? { fill: C.gray100, type: ShadingType.CLEAR, color: C.gray100 } : undefined,
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [para([run(label, { size: isTotal ? 22 : 20, bold: isTotal, color: isTotal ? C.black : C.gray600 })], { spacing: { after: 0 } })],
          }),
          new TableCell({
            width: { size: 62, type: WidthType.PERCENTAGE },
            borders: isTotal ? bottomOnly(true) : bottomOnly(),
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [para([run(value, { size: isTotal ? 22 : 20, bold: isTotal, color: isTotal ? C.black : C.black })], { spacing: { after: 0 } })],
          }),
        ],
      })
    ),
  })
}

// ── Investment table ─────────────────────────────────────────────────────────
function investmentTable(rows, totalLabel, totalAmount) {
  const headerRow = new TableRow({
    children: ['ITEM', 'TYPE', 'AMOUNT'].map((h, i) => new TableCell({
      width: { size: [55, 20, 25][i], type: WidthType.PERCENTAGE },
      borders: bottomOnly(true),
      shading: { fill: C.gray100, type: ShadingType.CLEAR, color: C.gray100 },
      margins: { top: 80, bottom: 80, left: 80, right: 80 },
      children: [para([run(h, { size: 16, bold: true, color: C.gray400 })], { spacing: { after: 0 }, alignment: i === 2 ? AlignmentType.RIGHT : undefined })],
    })),
  })

  const bodyRows = rows.map(([item, type, amount]) =>
    new TableRow({
      children: [
        new TableCell({ width: { size: 55, type: WidthType.PERCENTAGE }, borders: bottomOnly(), margins: { top: 80, bottom: 80, left: 80, right: 80 }, children: [para([run(item, { size: 22, color: C.black })], { spacing: { after: 0 } })] }),
        new TableCell({ width: { size: 20, type: WidthType.PERCENTAGE }, borders: bottomOnly(), margins: { top: 80, bottom: 80, left: 80, right: 80 }, children: [para([run(type, { size: 20, color: C.gray600 })], { spacing: { after: 0 } })] }),
        new TableCell({ width: { size: 25, type: WidthType.PERCENTAGE }, borders: bottomOnly(), margins: { top: 80, bottom: 80, left: 80, right: 80 }, children: [para([run(amount, { size: 22, bold: true, color: C.black })], { spacing: { after: 0 }, alignment: AlignmentType.RIGHT })] }),
      ],
    })
  )

  const totalRow = new TableRow({
    children: [
      new TableCell({ columnSpan: 2, width: { size: 75, type: WidthType.PERCENTAGE }, borders: allNoBorder(), margins: { top: 120, bottom: 80, left: 80, right: 80 }, children: [para([run(totalLabel, { size: 22, bold: true, color: C.black })], { spacing: { after: 0 } })] }),
      new TableCell({ width: { size: 25, type: WidthType.PERCENTAGE }, borders: allNoBorder(), margins: { top: 120, bottom: 80, left: 80, right: 80 }, children: [para([run(totalAmount, { size: 22, bold: true, color: C.black })], { spacing: { after: 0 }, alignment: AlignmentType.RIGHT })] }),
    ],
  })

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideH: NO_BORDER, insideV: NO_BORDER },
    rows: [headerRow, ...bodyRows, totalRow],
  })
}

// ── MAIN EXPORT ──────────────────────────────────────────────────────────────
export async function generateProposalDocx(data) {
  const {
    ref_number    = 'PRO-0000-001',
    date          = new Date().toLocaleDateString('en-MY', { month: 'long', year: 'numeric' }),
    valid_until,
    company_name  = 'Client',
    contact_name  = '',
    contact_role  = '',
    whatsapp,
    email         = 'hello@opxio.io',
    website       = 'opxio.io',
    os_type       = '',
    install_tier  = 'Standard',
    notion_plan   = 'Plus',
    timeline      = '3–4 weeks',
    fee           = 0,
    retainer      = 'maintenance',
    situation     = [],
    modules       = {},
    addons_now    = [],
    addons_later  = [],
  } = data

  const RETAINER_LABELS = { hosting: { label: 'Hosting Only', fee: 150 }, maintenance: { label: 'Maintenance', fee: 400 }, active: { label: 'Active Retainer', fee: 900 } }
  const coreFee     = Number(fee) || 0
  const deposit     = Math.round(coreFee / 2)
  const retInfo     = RETAINER_LABELS[retainer] || RETAINER_LABELS.maintenance
  const osTypes     = Object.keys(modules)
  const totalMods   = Object.values(modules).reduce((s, a) => s + a.length, 0)
  const validText   = valid_until || (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'long', year: 'numeric' }) })()

  const children = []

  // ────────────────────────────────────────────────────────────────────────────
  // COVER
  // ────────────────────────────────────────────────────────────────────────────
  children.push(
    para([run('OPXIO', { size: 24, bold: true, color: C.black })], { spacing: { before: 0, after: 800 } }),
    para([run('SYSTEM INSTALLATION PROPOSAL', { size: 16, bold: true, color: C.gray400 })], { spacing: { after: 120 } }),
    para([run(os_type, { size: 64, bold: true, color: C.black })], { spacing: { after: 60 } }),
    para([run(`for ${company_name}.`, { size: 48, color: C.black })], { spacing: { after: 600 } }),
    divider(),
  )
  children.push(kv2Table([
    ['Prepared for', company_name],
    ['Contact',      `${contact_name}${contact_role ? ' — ' + contact_role : ''}`],
    ['Reference',    ref_number],
    ['Date',         date],
    ['Valid until',  validText],
  ]))
  children.push(pageBreak())

  // ────────────────────────────────────────────────────────────────────────────
  // CONTEXT
  // ────────────────────────────────────────────────────────────────────────────
  if (situation.length > 0) {
    children.push(eyebrow('01 — Context'), heading('What we heard.', 36))
    for (const s of situation) {
      const isObj = typeof s === 'object' && s !== null
      const label = isObj ? s.label : null
      const text  = isObj ? s.text  : s
      if (label) children.push(para([run(label.toUpperCase(), { size: 16, bold: true, color: C.lime })], { spacing: { before: 240, after: 80 } }))
      if (text)  children.push(lead(text))
    }
    children.push(pageBreak())
  }

  // ────────────────────────────────────────────────────────────────────────────
  // THE INSTALL — OVERVIEW
  // ────────────────────────────────────────────────────────────────────────────
  children.push(eyebrow('02 — The Install'), heading(os_type + '.', 36))
  children.push(lead(`A structured operational system built on Notion — designed around how ${company_name} actually runs.`))
  children.push(
    kv2Table([
      ['Install',                `${os_type} — ${install_tier} Install`],
      ['Notion Plan Required',   `${notion_plan} — ~RM 50/month (billed to your workspace)`],
      ['Total Modules',          `${totalMods} modules across ${osTypes.join(' + ')}`],
      ['Delivery Timeline',      `${timeline} from deposit`],
      ['Handover',               'Walkthrough session + widget orientation'],
    ])
  )
  children.push(pageBreak())

  // ────────────────────────────────────────────────────────────────────────────
  // MODULES INCLUDED
  // ────────────────────────────────────────────────────────────────────────────
  children.push(eyebrow('02 — The Install'), heading('Modules included.', 36))
  for (const [osName, mods] of Object.entries(modules)) {
    children.push(para([run(osName, { size: 22, bold: true, color: C.black })], { spacing: { before: 240, after: 80 } }))
    for (const mod of mods) {
      children.push(new Paragraph({
        children: [run('• ' + mod, { size: 20, color: C.gray600 })],
        spacing: { after: 60 },
        indent: { left: convertInchesToTwip(0.2) },
      }))
    }
  }
  children.push(pageBreak())

  // ────────────────────────────────────────────────────────────────────────────
  // INVESTMENT
  // ────────────────────────────────────────────────────────────────────────────
  children.push(eyebrow('02 — The Install'), heading('Investment.', 36))
  children.push(
    investmentTable(
      [
        [`${os_type} — ${install_tier} Install`, 'One-time', fmtRM(coreFee)],
        [`Widget ${retInfo.label} Retainer`, 'Monthly', `${fmtRM(retInfo.fee)} / mo`],
        [`Notion ${notion_plan} Plan (your workspace)`, "Client's cost", '~RM 50 / mo'],
      ],
      'Installation fee',
      fmtRM(coreFee)
    )
  )
  children.push(
    para([run(`50% deposit (${fmtRM(deposit)}) required to begin. Balance on delivery.`, { size: 18, color: C.gray400, italics: true })], { spacing: { before: 160, after: 200 } })
  )

  // ────────────────────────────────────────────────────────────────────────────
  // ADD-ONS (if any)
  // ────────────────────────────────────────────────────────────────────────────
  const hasAddons = addons_now.length > 0 || addons_later.length > 0
  if (hasAddons) {
    children.push(pageBreak())
    children.push(eyebrow('03 — Add-Ons'), heading('Optional extras.', 36))
    children.push(lead('Add-ons are independent of the core install. Take them now or any time after. Each one is priced and scoped separately.'))

    const allAddons = [...addons_now, ...addons_later]
    for (const item of allAddons) {
      const isObj  = typeof item === 'object' && item !== null
      const name   = isObj ? (item.name || String(item)) : String(item)
      const price  = isObj ? (item.price_label || '') : ''
      const desc   = isObj ? (item.desc || '') : ''
      children.push(para([
        run(name, { size: 22, bold: true, color: C.black }),
        price ? run('   ' + price, { size: 20, color: C.gray600 }) : run(''),
      ], { spacing: { before: 200, after: 60 } }))
      if (desc) children.push(lead(desc))
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // NEXT STEPS
  // ────────────────────────────────────────────────────────────────────────────
  children.push(pageBreak())
  children.push(eyebrow(`${hasAddons ? '04' : '03'} — How to Proceed`), heading('Next steps.', 36))

  const steps = [
    { n: '01', title: 'Confirm scope',    desc: 'Reply to this proposal or message Kai on WhatsApp to confirm the install scope and ask any questions.' },
    { n: '02', title: 'Pay deposit',       desc: `50% (${fmtRM(deposit)}) to secure your implementation slot and begin the build.` },
    { n: '03', title: 'Onboarding call',  desc: '30-minute call to map your existing data, confirm workspace access, and align on the delivery timeline.' },
    { n: '04', title: 'Build & handover', desc: `${timeline} to full installation. Handover walkthrough and widget orientation included.` },
  ]

  for (const step of steps) {
    children.push(para([
      run(step.n + '  ', { size: 28, color: C.gray200, bold: true }),
      run(step.title,    { size: 22, color: C.black,   bold: true }),
    ], { spacing: { before: 240, after: 80 } }))
    children.push(lead(step.desc))
  }

  // ── CONTACT FOOTER ──
  children.push(divider())
  children.push(para([run('Kai Khairul — Opxio', { size: 22, bold: true, color: C.black })], { spacing: { before: 200, after: 80 } }))
  if (whatsapp) children.push(para([run('WhatsApp: ' + whatsapp, { size: 20, color: C.gray600 })], { spacing: { after: 40 } }))
  children.push(para([run('Email: ' + email, { size: 20, color: C.gray600 })], { spacing: { after: 40 } }))
  children.push(para([run('Website: ' + website, { size: 20, color: C.gray600 })], { spacing: { after: 200 } }))
  children.push(para([run(`This proposal is confidential and prepared exclusively for ${company_name}. Valid until ${validText}.`, { size: 16, color: C.gray400, italics: true })]))

  // ────────────────────────────────────────────────────────────────────────────
  // BUILD DOCUMENT
  // ────────────────────────────────────────────────────────────────────────────
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Arial', size: 22, color: C.gray800 } },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: { top: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1.1), right: convertInchesToTwip(1.1) },
        },
      },
      children,
    }],
  })

  return Packer.toBuffer(doc)
}
