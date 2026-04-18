// ─── pdf.js — Opxio PDF Generator (pdfkit + Satoshi) ──────────────────────
// Generates Quotation, Invoice, and Receipt PDFs with the Opxio B&W theme.
// Mirrors the visual design of generate.py (ReportLab Python original).

import PDFDocument from "pdfkit"
import path from "path"
import fs from "fs"
import QRCode from "qrcode"
import { getPage, queryDB, patchPage, plain, DB, fetchCompanyDetails } from "./notion"

// ── Fonts ──────────────────────────────────────────────────────────────────
const FONT_DIR = path.join(process.cwd(), "public", "fonts")
const FONTS = {
  reg:  path.join(FONT_DIR, "Satoshi-Regular.ttf"),
  med:  path.join(FONT_DIR, "Satoshi-Medium.ttf"),
  bold: path.join(FONT_DIR, "Satoshi-Bold.ttf"),
  blk:  path.join(FONT_DIR, "Satoshi-Black.ttf"),
  it:   path.join(FONT_DIR, "Satoshi-Italic.ttf"),
}

function fontsExist() {
  return Object.values(FONTS).every(f => fs.existsSync(f))
}

// ── Colours ────────────────────────────────────────────────────────────────
const C = {
  ink:    "#0D0D0D",
  body:   "#1A1A1A",
  muted:  "#6B7280",
  subtle: "#9CA3AF",
  rule:   "#D1D5DB",
  alt:    "#F7F8FA",
  white:  "#FFFFFF",
}

// ── Layout constants (points, 1pt = 1/72 inch) ─────────────────────────────
const PG_W = 595.28  // A4 width
const PG_H = 841.89  // A4 height
const MARGIN = 56.69 // 20mm in points
const USABLE = PG_W - MARGIN * 2

// ── Helper: mm to points ───────────────────────────────────────────────────
const mm = v => v * 2.8346

// ── Format date ───────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit", month: "long", year: "numeric"
    })
  } catch { return iso }
}

// ── Format currency ───────────────────────────────────────────────────────
function fmtRM(n) {
  return `RM ${Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ── Tracked text (letter-spacing simulation) ───────────────────────────────
function tracked(s) {
  return s.split("").join(" ")
}

// ── QR code buffer ────────────────────────────────────────────────────────
async function makeQrBuffer(url, sizePx = 100) {
  if (!url) return null
  try {
    return await QRCode.toBuffer(url, {
      type:  "png",
      width: sizePx,
      margin: 1,
      color: { dark: "#000000", light: "#FFFFFF" },
    })
  } catch (e) {
    console.warn("[pdf] QR code failed:", e.message)
    return null
  }
}

// ── Build PDF document ────────────────────────────────────────────────────
function makeDoc() {
  const hasFonts = fontsExist()
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: mm(12), bottom: mm(12), left: MARGIN, right: MARGIN },
    autoFirstPage: true,
    info: { Author: "Opxio" },
  })
  if (hasFonts) {
    doc.registerFont("Reg",  FONTS.reg)
    doc.registerFont("Med",  FONTS.med)
    doc.registerFont("Bold", FONTS.bold)
    doc.registerFont("Blk",  FONTS.blk)
    doc.registerFont("It",   FONTS.it)
  }
  const F = hasFonts
    ? { reg: "Reg", med: "Med", bold: "Bold", blk: "Blk", it: "It" }
    : { reg: "Helvetica", med: "Helvetica", bold: "Helvetica-Bold", blk: "Helvetica-Bold", it: "Helvetica-Oblique" }
  return { doc, F }
}

// ── Collect PDF into Buffer ───────────────────────────────────────────────
function collectBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = []
    doc.on("data",  c => chunks.push(c))
    doc.on("end",   () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)
    doc.end()
  })
}

// ═══════════════════════════════════════════════════════════════════════════
//  SHARED LAYOUT HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Draw a filled rectangle
 */
function fillRect(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color).restore()
}

/**
 * Draw a horizontal rule
 */
function hrule(doc, x, y, w, color = C.rule, thickness = 0.5) {
  doc.save()
    .moveTo(x, y).lineTo(x + w, y)
    .lineWidth(thickness).stroke(color)
    .restore()
}

/**
 * Draw the dark header block common to all PDF types
 */
async function drawHeader(doc, F, { logoUrl, coName, coContact, docTitle }) {
  const headerH = mm(28)
  const y0 = doc.y

  // Dark background
  fillRect(doc, MARGIN, y0, USABLE, headerH, C.ink)

  // Logo or company name
  let logoDrawn = false
  if (logoUrl) {
    try {
      const resp = await fetch(logoUrl)
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer())
        const imgW = mm(42), imgH = mm(14)
        doc.image(buf, MARGIN + mm(6), y0 + (headerH - imgH) / 2,
          { width: imgW, height: imgH, fit: [imgW, imgH], align: "left", valign: "center" })
        logoDrawn = true
      }
    } catch {}
  }
  if (!logoDrawn) {
    doc.font(F.bold).fontSize(14).fillColor(C.white)
      .text(coName, MARGIN + mm(5), y0 + mm(6), { width: USABLE * 0.5 })
  }

  // Contact line under logo/name
  if (coContact) {
    doc.font(F.reg).fontSize(8).fillColor(C.subtle)
      .text(coContact, MARGIN + mm(5), y0 + mm(18), { width: USABLE * 0.5, lineBreak: false })
  }

  // "Quotation" / "Invoice" title — right aligned
  doc.font(F.blk).fontSize(32).fillColor(C.white)
    .text(docTitle, MARGIN, y0 + mm(5), { width: USABLE - mm(5), align: "right", lineBreak: false })

  doc.y = y0 + headerH
}

/**
 * Draw the meta bar (Quote No / Date / Valid Until)
 */
function drawMetaBar(doc, F, cells) {
  const barH = mm(18)
  const y0   = doc.y
  const colW = USABLE / cells.length

  fillRect(doc, MARGIN, y0, USABLE, barH, C.alt)

  cells.forEach(({ label, value }, i) => {
    const x = MARGIN + i * colW + mm(4)
    // Divider
    if (i > 0) {
      doc.save().moveTo(MARGIN + i * colW, y0 + mm(2)).lineTo(MARGIN + i * colW, y0 + barH - mm(2))
        .lineWidth(0.5).stroke(C.rule).restore()
    }
    doc.font(F.med).fontSize(7).fillColor(C.subtle)
      .text(tracked(label), x, y0 + mm(3), { width: colW - mm(8), lineBreak: false })
    doc.font(F.bold).fontSize(11).fillColor(C.body)
      .text(value || "—", x, y0 + mm(8), { width: colW - mm(8), lineBreak: false })
  })

  doc.y = y0 + barH + mm(8)
}

/**
 * Draw Bill To / Attention block
 */
function drawBillTo(doc, F, { companyName, companyAddress, companyPhone, picName, picEmail }) {
  doc.font(F.med).fontSize(7).fillColor(C.subtle)
    .text(tracked("BILL TO"), MARGIN, doc.y)
  doc.moveDown(0.4)
  doc.font(F.bold).fontSize(12).fillColor(C.body).text(companyName || "N/A")
  if (companyAddress) {
    doc.moveDown(0.2)
    doc.font(F.reg).fontSize(9).fillColor(C.muted)
      .text(companyAddress.replace(/\n/g, ", "))
  }
  if (companyPhone) {
    doc.font(F.reg).fontSize(9).fillColor(C.muted).text(companyPhone)
  }
  if (picName) {
    const attn = picEmail ? `Attn: ${picName}  ·  ${picEmail}` : `Attn: ${picName}`
    doc.font(F.reg).fontSize(9).fillColor(C.muted).text(attn)
  }
  doc.moveDown(1)
}

/**
 * Draw the line items table
 * Columns: ITEM (product name) | DESCRIPTION | QTY | UNIT PRICE | AMOUNT
 */
function drawLineItems(doc, F, lineItems) {
  // 5 columns: item name | description | qty | unit price | amount
  const cw = [USABLE * 0.22, USABLE * 0.32, USABLE * 0.09, USABLE * 0.19, USABLE * 0.18]
  const headerH = mm(10)
  const y0 = doc.y

  // Header background
  fillRect(doc, MARGIN, y0, USABLE, headerH, C.ink)

  const headers = ["ITEM", "DESCRIPTION", "QTY", "UNIT PRICE", "AMOUNT"]
  const aligns  = ["left", "left", "center", "right", "right"]
  let xOff = MARGIN

  headers.forEach((h, i) => {
    doc.font(F.med).fontSize(7).fillColor(C.white)
      .text(tracked(h), xOff + mm(3), y0 + mm(2.5), { width: cw[i] - mm(6), align: aligns[i], lineBreak: false })
    xOff += cw[i]
  })

  doc.y = y0 + headerH
  let total = 0

  lineItems.forEach((item, idx) => {
    const qty   = Number(item.qty || 1)
    const price = Number(item.unit_price || 0)
    const amt   = qty * price
    total += amt

    const rowY = doc.y
    const alt  = idx % 2 === 1

    const itemX = MARGIN + mm(3)
    const descX = MARGIN + cw[0] + mm(3)
    const TOP   = mm(3.5)  // top padding inside row
    const BOT   = mm(3.5)  // bottom padding inside row

    // Measure row height — MUST set font first; heightOfString uses the current font state
    doc.font(F.bold).fontSize(9)
    const itemTextH = doc.heightOfString(item.name || "", { width: cw[0] - mm(6) })
    doc.font(F.reg).fontSize(8)
    const descTextH = item.desc ? doc.heightOfString(item.desc, { width: cw[1] - mm(6) }) : 0

    const rowBottom = Math.max(
      rowY + TOP + itemTextH + BOT,
      rowY + TOP + descTextH + BOT,
      rowY + mm(11)
    )

    // Fill alt row background
    if (alt) fillRect(doc, MARGIN, rowY, USABLE, rowBottom - rowY, C.alt)

    // ITEM column — product name (bold)
    doc.font(F.bold).fontSize(9).fillColor(C.body)
      .text(item.name || "", itemX, rowY + TOP, { width: cw[0] - mm(6), lineBreak: true })

    // DESCRIPTION column — description text
    if (item.desc) {
      doc.font(F.reg).fontSize(8).fillColor(C.muted)
        .text(item.desc, descX, rowY + TOP, { width: cw[1] - mm(6), lineBreak: true })
    }

    const midY = rowY + (rowBottom - rowY) / 2 - mm(2)

    // QTY
    doc.font(F.reg).fontSize(9).fillColor(C.body)
      .text(`${qty}`, MARGIN + cw[0] + cw[1] + mm(1), midY, { width: cw[2] - mm(2), align: "center", lineBreak: false })

    // Unit Price
    const isDisc = item.is_discounted && Number(item.catalog_price || 0) > 0
    if (isDisc) {
      doc.font(F.reg).fontSize(7).fillColor(C.subtle)
        .text(fmtRM(item.catalog_price), MARGIN + cw[0] + cw[1] + cw[2] + mm(1), midY - mm(3),
          { width: cw[3] - mm(4), align: "right", lineBreak: false, strike: true })
      doc.font(F.reg).fontSize(9).fillColor(C.body)
        .text(fmtRM(price), MARGIN + cw[0] + cw[1] + cw[2] + mm(1), midY + mm(1),
          { width: cw[3] - mm(4), align: "right", lineBreak: false })
    } else {
      doc.font(F.reg).fontSize(9).fillColor(C.body)
        .text(fmtRM(price), MARGIN + cw[0] + cw[1] + cw[2] + mm(1), midY,
          { width: cw[3] - mm(4), align: "right", lineBreak: false })
    }

    // Amount
    doc.font(F.reg).fontSize(9).fillColor(C.body)
      .text(fmtRM(amt), MARGIN + cw[0] + cw[1] + cw[2] + cw[3] + mm(1), midY,
        { width: cw[4] - mm(4), align: "right", lineBreak: false })

    // Row divider
    hrule(doc, MARGIN, rowBottom, USABLE)
    doc.y = rowBottom
  })

  return total
}

/**
 * Draw totals block
 */
// depositAmt  = the 50% deposit figure (shown as "Deposit Due" on deposit invoices,
//               shown as "Deposit Received" deduction on final invoices)
function drawTotals(doc, F, { total, hasDeposit, depositAmt, invoiceType, depositPaid, paymentBalance }) {
  doc.moveDown(0.5)
  const totW  = USABLE * 0.35
  const labW  = USABLE * 0.65
  const totX  = MARGIN + labW

  const rows = []

  // Subtotal
  rows.push({ label: "Subtotal", value: fmtRM(total), bold: false })

  // Deposit invoice: show how much is due now (50%)
  if (hasDeposit && depositAmt > 0) {
    rows.push({ label: "Deposit Due (50%)", value: fmtRM(depositAmt), bold: false })
  }
  // Final invoice: show deposit already received as a deduction
  if (!hasDeposit && depositPaid > 0) {
    rows.push({ label: "Deposit Received", value: `– ${fmtRM(depositPaid)}`, bold: false })
    const balance = paymentBalance || Math.max(0, total - depositPaid)
    if (balance > 0) {
      rows.push({ label: "Balance Due", value: fmtRM(balance), bold: false })
    }
  }

  // Black total bar — for deposit invoices show the deposit amount, not the full total
  const totalLabel = invoiceType === "Final Payment" ? "Final Payment"
    : invoiceType === "Deposit"     ? "Deposit"
    : (invoiceType || "Total")
  const displayTotal = invoiceType === "Final Payment"
    ? (paymentBalance || Math.max(0, total - depositPaid) || total)
    : hasDeposit
      ? (depositAmt || total * 0.5)   // show the deposit amount due, not the full contract value
      : total
  rows.push({ label: totalLabel, value: fmtRM(displayTotal), bold: true })

  rows.forEach((row, i) => {
    const isTotalRow = i === rows.length - 1
    const rowH = isTotalRow ? mm(14) : mm(10)
    const y0   = doc.y

    if (isTotalRow) fillRect(doc, MARGIN, y0, USABLE, rowH, C.ink)

    const textY = y0 + (rowH - mm(5)) / 2
    doc.font(isTotalRow ? F.bold : F.reg)
      .fontSize(isTotalRow ? 11 : 9)
      .fillColor(isTotalRow ? C.white : (i === rows.length - 2 ? C.body : C.muted))
      .text(row.label, MARGIN + mm(4), textY, { width: labW - mm(8), align: "right", lineBreak: false })
    doc.font(isTotalRow ? F.bold : F.reg)
      .fontSize(isTotalRow ? 11 : 9)
      .fillColor(isTotalRow ? C.white : C.body)
      .text(row.value, totX + mm(2), textY, { width: totW - mm(6), align: "right", lineBreak: false })

    doc.y = y0 + rowH
  })
}

/**
 * Draw bottom section: T&C QR  |  Payment Details
 */
async function drawBottom(doc, F, { termsUrl, coBank, coHolder, coAcc, coPay }) {
  doc.moveDown(1)

  // Need at least mm(65) for QR/terms + payment details + footer.
  // If not enough room left on the page, start a new page.
  const spaceLeft = PG_H - doc.page.margins.bottom - doc.y
  if (spaceLeft < mm(65)) {
    doc.addPage()
    doc.moveDown(0.5)
  }

  hrule(doc, MARGIN, doc.y, USABLE, C.rule, 0.5)
  doc.moveDown(0.8)

  const qrBuf = await makeQrBuffer(termsUrl, 90)
  const leftW = USABLE * 0.55
  const rightW = USABLE * 0.45
  const startY = doc.y

  // Left column — T&C QR or terms text
  if (qrBuf) {
    doc.font(F.med).fontSize(7).fillColor(C.subtle)
      .text(tracked("TERMS & CONDITIONS"), MARGIN, startY)
    doc.moveDown(0.4)
    const qrY = doc.y
    doc.image(qrBuf, MARGIN, qrY, { width: mm(28), height: mm(28) })
    doc.font(F.reg).fontSize(7).fillColor(C.muted)
      .text(
        "Scan to read our full Terms & Conditions. By proceeding with this quotation, the client acknowledges and agrees to the terms therein.",
        MARGIN, qrY + mm(30), { width: leftW - mm(8) }
      )
  } else {
    const TERMS = [
      "This quotation is valid for 30 days from the issue date.",
      "All prices are in Malaysian Ringgit (MYR) and exclusive of applicable taxes.",
      "A signed acceptance or purchase order is required to commence work.",
      "50% deposit required upon acceptance; balance upon completion.",
    ]
    doc.font(F.med).fontSize(7).fillColor(C.subtle)
      .text(tracked("NOTES & TERMS"), MARGIN, startY)
    doc.moveDown(0.3)
    TERMS.forEach(t => {
      doc.font(F.reg).fontSize(8).fillColor(C.muted)
        .text(`• ${t}`, MARGIN, doc.y, { width: leftW - mm(6) })
      doc.moveDown(0.2)
    })
  }

  // Vertical divider
  const divX = MARGIN + leftW
  doc.save().moveTo(divX, startY).lineTo(divX, Math.max(doc.y, startY + mm(40)))
    .lineWidth(0.5).stroke(C.rule).restore()

  // Right column — Payment Details
  const payX = divX + mm(6)
  const payW = rightW - mm(8)
  doc.y = startY
  doc.font(F.med).fontSize(7).fillColor(C.subtle)
    .text(tracked("PAYMENT DETAILS"), payX, startY)
  doc.moveDown(0.6)

  const payFields = [
    coPay    && { label: "METHOD",       value: coPay },
    coBank   && { label: "BANK",         value: coBank },
    coHolder && { label: "ACCOUNT NAME", value: coHolder },
    coAcc    && { label: "ACCOUNT NO.",  value: coAcc },
  ].filter(Boolean)

  payFields.forEach(f => {
    const labelY = doc.y
    // Draw label at explicit Y; value sits mm(4.5) below it so they never overlap
    doc.font(F.med).fontSize(7).fillColor(C.subtle)
      .text(tracked(f.label), payX, labelY, { width: payW, lineBreak: false })
    doc.font(F.reg).fontSize(9).fillColor(C.body)
      .text(f.value, payX, labelY + mm(4.5), { width: payW })
    doc.moveDown(0.5)
  })
}

/**
 * Draw footer line
 */
function drawFooter(doc, F, { coName, coEmail, coPhone }) {
  doc.moveDown(0.8)
  hrule(doc, MARGIN, doc.y, USABLE, C.ink, 1.5)
  doc.moveDown(0.4)
  const parts = [coName, coEmail, coPhone].filter(Boolean)
  doc.font(F.reg).fontSize(7).fillColor(C.subtle)
    .text(parts.join("  ·  "), MARGIN, doc.y, { width: USABLE, align: "center" })
}

// ═══════════════════════════════════════════════════════════════════════════
//  QUOTATION PDF
// ═══════════════════════════════════════════════════════════════════════════

export async function generateQuotationPdf(data) {
  const { doc, F } = makeDoc()

  const co      = data.our_company || {}
  const coTerms = co.termsUrl || ""
  const logoUrl = co.logoUrl || ""
  const coName  = co.name || "Opxio"
  const coContact = [co.phone, co.email].filter(Boolean).join("  ·  ")

  const issueDate  = data.issue_date
  const validDate  = issueDate
    ? new Date(new Date(issueDate).getTime() + 30 * 86400000).toISOString().split("T")[0]
    : ""

  // docType: "Quotation" (default) or "Proposal"
  const isProposal = (data.doc_type || "").toLowerCase() === "proposal"
  const docTitle   = isProposal ? "Proposal" : "Quotation"
  const refLabel   = isProposal ? "PROPOSAL NO." : "QUOTE NO."
  const refNo      = data.quotation_no || data.proposal_no || "—"

  // Header
  await drawHeader(doc, F, { logoUrl, coName, coContact, docTitle })

  // Thin black accent line
  doc.moveDown(0.3)
  hrule(doc, MARGIN, doc.y, USABLE, C.ink, 3)
  doc.moveDown(0.8)

  // Meta bar
  drawMetaBar(doc, F, [
    { label: refLabel,      value: refNo },
    { label: "DATE",        value: fmtDate(issueDate) },
    { label: "VALID UNTIL", value: fmtDate(validDate) },
  ])

  // Bill To
  drawBillTo(doc, F, {
    companyName:    data.company_name,
    companyAddress: data.company_address,
    companyPhone:   data.company_phone,
    picName:        data.pic_name,
    picEmail:       data.pic_email,
  })

  // Line Items
  const total = drawLineItems(doc, F, data.line_items || [])

  // Totals
  const hasDeposit = data.payment_terms === "50% Deposit"
  drawTotals(doc, F, {
    total,
    hasDeposit,
    depositAmt:     hasDeposit ? Math.round(total * 0.5 * 100) / 100 : 0,
    invoiceType:    hasDeposit ? "Deposit" : null,
    depositPaid:    0,
    paymentBalance: 0,
  })

  // Bottom: QR + payment details
  await drawBottom(doc, F, {
    termsUrl: coTerms,
    coBank:   co.bankName || "",
    coHolder: co.bankAccountHolder || "",
    coAcc:    co.bankNumber || "",
    coPay:    co.paymentMethod || "",
  })

  // Footer
  drawFooter(doc, F, { coName, coEmail: co.email || "", coPhone: co.phone || "" })

  return collectBuffer(doc)
}

// ═══════════════════════════════════════════════════════════════════════════
//  INVOICE PDF
// ═══════════════════════════════════════════════════════════════════════════

export async function generateInvoicePdf(data) {
  const { doc, F } = makeDoc()

  const co      = data.our_company || {}
  const coTerms = co.termsUrl || ""
  const logoUrl = co.logoUrl || ""
  const coName  = co.name || "Opxio"
  const coContact = [co.phone, co.email].filter(Boolean).join("  ·  ")
  const invType = data.invoice_type || ""

  // Header
  await drawHeader(doc, F, { logoUrl, coName, coContact, docTitle: "Invoice" })

  doc.moveDown(0.3)
  hrule(doc, MARGIN, doc.y, USABLE, C.ink, 3)
  doc.moveDown(0.8)

  // Meta bar
  drawMetaBar(doc, F, [
    { label: "INVOICE NO.",  value: data.invoice_no || "—" },
    { label: "DATE",         value: fmtDate(data.issue_date) },
    { label: "DUE DATE",     value: fmtDate(data.due_date) || "On Receipt" },
  ])

  // Bill To
  drawBillTo(doc, F, {
    companyName:    data.company_name,
    companyAddress: data.company_address,
    companyPhone:   data.company_phone,
    picName:        data.pic_name,
    picEmail:       data.pic_email,
  })

  // Invoice type badge
  if (invType) {
    doc.font(F.med).fontSize(9).fillColor(C.muted)
      .text(`Type: ${invType}`, MARGIN, doc.y)
    doc.moveDown(0.5)
  }

  // Line Items
  const lineItems = data.line_items || []
  const total = lineItems.length > 0
    ? drawLineItems(doc, F, lineItems)
    : data.total_amount || 0

  // Totals
  // data.deposit_paid = "Deposit (50%)" field = the 50% figure
  // For deposit invoices: it's the amount DUE now (hasDeposit=true, depositPaid=0)
  // For final invoices:   it's the amount RECEIVED already (hasDeposit=false, depositPaid=amt)
  const isDepositInv = invType === "Deposit"
  const isFinalInv   = invType === "Final Payment"
  const depositAmt   = data.deposit_paid || 0

  drawTotals(doc, F, {
    total:          data.total_amount || total,
    hasDeposit:     isDepositInv,
    depositAmt:     isDepositInv ? depositAmt : 0,
    invoiceType:    invType,
    depositPaid:    isFinalInv  ? depositAmt : 0,
    paymentBalance: isFinalInv  ? (data.payment_balance || Math.max(0, (data.total_amount || total) - depositAmt)) : 0,
  })

  // Bottom: QR + payment details
  await drawBottom(doc, F, {
    termsUrl: coTerms,
    coBank:   co.bankName || "",
    coHolder: co.bankAccountHolder || "",
    coAcc:    co.bankNumber || "",
    coPay:    co.paymentMethod || "",
  })

  // Footer
  drawFooter(doc, F, { coName, coEmail: co.email || "", coPhone: co.phone || "" })

  return collectBuffer(doc)
}

// ═══════════════════════════════════════════════════════════════════════════
//  RECEIPT PDF
// ═══════════════════════════════════════════════════════════════════════════

export async function generateReceiptPdf(data) {
  const { doc, F } = makeDoc()

  const co      = data.our_company || {}
  const coName  = co.name || "Opxio"
  const coContact = [co.phone, co.email].filter(Boolean).join("  ·  ")

  // Header
  await drawHeader(doc, F, { logoUrl: co.logoUrl || "", coName, coContact, docTitle: "Receipt" })

  doc.moveDown(0.3)
  hrule(doc, MARGIN, doc.y, USABLE, C.ink, 3)
  doc.moveDown(0.8)

  drawMetaBar(doc, F, [
    { label: "RECEIPT NO.", value: data.receipt_no || "—" },
    { label: "DATE",        value: fmtDate(data.issue_date) },
    { label: "INVOICE REF", value: data.invoice_no || "—" },
  ])

  drawBillTo(doc, F, {
    companyName:    data.company_name,
    companyAddress: data.company_address,
    companyPhone:   data.company_phone,
    picName:        data.pic_name,
    picEmail:       data.pic_email,
  })

  // Payment confirmed block
  const rcptY = doc.y
  fillRect(doc, MARGIN, rcptY, USABLE, mm(20), C.alt)
  doc.font(F.med).fontSize(9).fillColor(C.subtle)
    .text(tracked("PAYMENT RECEIVED"), MARGIN + mm(6), rcptY + mm(4))
  doc.font(F.blk).fontSize(22).fillColor(C.body)
    .text(fmtRM(data.amount_paid || data.total_amount || 0), MARGIN + mm(6), rcptY + mm(9),
      { width: USABLE - mm(12), align: "left", lineBreak: false })
  doc.font(F.reg).fontSize(9).fillColor(C.muted)
    .text(`via ${data.payment_method || "Bank Transfer"}`,
      MARGIN + USABLE * 0.5, rcptY + mm(11), { width: USABLE * 0.5 - mm(6), align: "right", lineBreak: false })
  doc.y = rcptY + mm(20) + mm(6)

  drawFooter(doc, F, { coName, coEmail: co.email || "", coPhone: co.phone || "" })

  return collectBuffer(doc)
}

// ═══════════════════════════════════════════════════════════════════════════
//  DATA FETCHERS  (shared with generate.js API route)
// ═══════════════════════════════════════════════════════════════════════════

const QUO_PATTERN = /^QUO-(\d{4})-(\d{4})$/
const INV_PATTERN = /^INV-\d{4}-\d{4}(-[DSFR])?$/

const INV_SUFFIX = {
  "Deposit":       "-D",
  "Final Payment": "-F",
  "Full Payment":  "",
  "Retainer":      "-R",
}

async function nextQuotationNumber(year, token) {
  let maxSeq = 0
  try {
    const pages = await queryDB(DB.QUOTATIONS, undefined, token)
    for (const page of pages) {
      for (const prop of Object.values(page.properties)) {
        if (prop.type === "title") {
          const title = plain(prop.title)
          const m = QUO_PATTERN.exec(title)
          if (m && parseInt(m[1]) === year) maxSeq = Math.max(maxSeq, parseInt(m[2]))
        }
      }
    }
  } catch (e) {
    console.warn("[pdf] nextQuotationNumber:", e.message)
  }
  return `QUO-${year}-${String(maxSeq + 1).padStart(4, "0")}`
}

async function assignQuotationNumber(issueDate, currentNo, token) {
  if (QUO_PATTERN.test(currentNo)) return currentNo
  const year = issueDate ? new Date(issueDate).getFullYear() : new Date().getFullYear()
  return nextQuotationNumber(year, token)
}

async function fetchLineItems(pageId, token) {
  const items = []
  try {
    const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      headers: {
        Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28",
      }
    })
    if (!blocksRes.ok) return items
    const allBlocks = [...(await blocksRes.json()).results]

    // Expand callout/column blocks in parallel
    const expandable = allBlocks.filter(b => ["callout", "column_list", "column"].includes(b.type))
    const expanded = await Promise.all(expandable.map(async b => {
      try {
        const nb = await fetch(`https://api.notion.com/v1/blocks/${b.id}/children`, {
          headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" }
        })
        return nb.ok ? (await nb.json()).results : []
      } catch { return [] }
    }))
    allBlocks.push(...expanded.flat())

    for (const block of allBlocks) {
      if (block.type !== "child_database") continue
      const dbId = block.id.replace(/-/g, "")
      try {
        const rows = await queryDB(dbId, undefined, token)
        if (!rows.length) continue

        // Fetch all product pages in parallel (one per row) instead of sequentially
        const resolved = await Promise.all(rows.map(async row => {
          const rp   = row.properties
          const item = {}

          // Product name via relation — parallel fetch
          const productRels = (rp.Product?.relation || []).slice(0, 1)
          if (productRels.length) {
            try {
              const prod = await getPage(productRels[0].id.replace(/-/g, ""), token)
              const np = prod.properties["Product Name"]
              if (np?.type === "title") item.name = plain(np.title)
            } catch {}
          }

          // Description rollup
          const pdProp = rp["Product Description"]
          if (pdProp?.type === "rollup") {
            for (const arr of (pdProp.rollup?.array || [])) {
              if (arr.type === "rich_text") { item.desc = plain(arr.rich_text); break }
              if (arr.type === "title")     { item.desc = plain(arr.title); break }
            }
          }

          // Notes as name fallback
          if (!item.name) item.name = plain(rp.Notes?.title || [])

          item.qty = rp.Qty?.number || 1

          // Catalog price
          const cpProp = rp["Catalog Price"]
          let catalogPrice = 0
          if (cpProp?.type === "rollup") {
            catalogPrice = cpProp.rollup?.number
              ?? (cpProp.rollup?.array || []).find(a => a.type === "number")?.number
              ?? 0
          } else if (cpProp?.type === "number") {
            catalogPrice = cpProp.number ?? 0
          }

          const manualPrice = rp["Unit Price"]?.number ?? 0
          item.catalog_price  = Number(catalogPrice)
          item.unit_price     = manualPrice > 0 ? manualPrice : catalogPrice
          item.is_discounted  = manualPrice > 0 && manualPrice !== catalogPrice

          return item
        }))

        // Filter out items with no name, then sort: Base OS always first
        const named = resolved.filter(i => i.name)
        named.sort((a, b) => {
          const aBase = a.name.toLowerCase() === "base os" ? 0 : 1
          const bBase = b.name.toLowerCase() === "base os" ? 0 : 1
          return aBase - bBase
        })
        for (const item of named) items.push(item)

        if (items.length) break
      } catch {}
    }
  } catch (e) {
    console.warn("[pdf] fetchLineItems:", e.message)
  }
  return items
}

async function fetchPersonInfo(pageId, token) {
  const info = { name: "", email: "", phone: "" }
  try {
    const page  = await getPage(pageId, token)
    const props = page.properties
    for (const k of ["Name", "Full Name", "name"]) {
      if (props[k]?.type === "title") { info.name = plain(props[k].title); break }
    }
    for (const k of ["Email", "email"]) {
      if (props[k]?.type === "email") { info.email = props[k].email || ""; break }
    }
    for (const [, prop] of Object.entries(props)) {
      if (prop.type === "phone_number" && prop.phone_number) { info.phone = prop.phone_number; break }
    }
  } catch {}
  return info
}

async function fetchCompanyInfo(companyId, token) {
  const info = { name: "", address: "", phone: "" }
  try {
    const page  = await getPage(companyId, token)
    const props = page.properties
    for (const k of ["Company", "Name", "Company Name", "name"]) {
      if (props[k]?.type === "title") { info.name = plain(props[k].title); break }
    }
    for (const k of ["Address", "Company Address", "Billing Address", "address"]) {
      if (props[k]?.type === "rich_text") {
        const v = plain(props[k].rich_text)
        if (v) { info.address = v; break }
      }
    }
    for (const [, prop] of Object.entries(props)) {
      if (prop.type === "phone_number" && prop.phone_number) { info.phone = prop.phone_number; break }
    }
  } catch {}
  return info
}

async function resolvePic(props, token) {
  let picIds = []
  const picProp = props.PIC || {}

  if (picProp.type === "rollup") {
    for (const item of (picProp.rollup?.array || [])) {
      if (item.type === "relation") { picIds = item.relation.map(r => r.id); break }
    }
  } else if (picProp.type === "relation") {
    picIds = (picProp.relation || []).map(r => r.id)
  }

  if (!picIds.length) return { name: "", email: "", phone: "" }
  return fetchPersonInfo(picIds[0].replace(/-/g, ""), token)
}

export async function fetchQuotationData(pageId, token) {
  const page   = await getPage(pageId, token)
  const props  = page.properties

  let titleKey = "Quotation No."
  for (const [k, v] of Object.entries(props)) {
    if (v.type === "title") { titleKey = k; break }
  }

  const currentNo    = plain(props[titleKey]?.title || [])
  const issueDate    = props["Issue Date"]?.date?.start || ""
  const paymentTerms = props["Payment Terms"]?.select?.name || ""
  const quoteType    = props["Quote Type"]?.select?.name || ""
  const amount       = props.Amount?.number || 0

  // Run all fetches in parallel — assignQuotationNumber, company, PIC,
  // line items, and Opxio company details all kick off at the same time.
  const companyRels = props.Company?.relation || []
  const [quotationNo, company, pic, lineItemsRaw, ourCompany] = await Promise.all([
    assignQuotationNumber(issueDate, currentNo, token),
    companyRels.length
      ? fetchCompanyInfo(companyRels[0].id.replace(/-/g, ""), token)
      : Promise.resolve({ name: "", address: "", phone: "" }),
    resolvePic(props, token),
    fetchLineItems(pageId, token),
    fetchCompanyDetails(token),
  ])

  // Patch quotation number if it changed (fire-and-forget — don't block response)
  if (quotationNo !== currentNo) {
    patchPage(pageId, { [titleKey]: { title: [{ text: { content: quotationNo } }] } }, token)
      .catch(e => console.warn("[pdf] patchQuotationNo:", e.message))
  }

  let lineItems = lineItemsRaw
  if (!lineItems.length && amount) {
    lineItems = [{ name: "Professional Services", desc: "", qty: 1, unit_price: amount }]
  }

  return {
    quotation_no:    quotationNo,
    title_prop_name: titleKey,
    issue_date:      issueDate,
    payment_terms:   paymentTerms,
    quote_type:      quoteType,
    amount,
    company_name:    company.name,
    company_address: company.address,
    company_phone:   company.phone,
    pic_name:        pic.name,
    pic_email:       pic.email,
    pic_phone:       pic.phone,
    line_items:      lineItems,
    our_company:     ourCompany,
  }
}

const INV_SUFFIX_MAP = INV_SUFFIX

function formatInvoiceNumber(quotationNo, invoiceType) {
  const suffix = INV_SUFFIX_MAP[invoiceType] ?? ""
  const m = QUO_PATTERN.exec(quotationNo)
  if (m) return `INV-${m[1]}-${m[2]}${suffix}`
  const year = new Date().getFullYear()
  const ts   = new Date().toTimeString().slice(0, 5).replace(":", "")
  return `INV-${year}-${ts}${suffix}`
}

export async function fetchInvoiceData(pageId, token) {
  const page  = await getPage(pageId, token)
  const props = page.properties

  let invoiceNo      = plain(props["Invoice No."]?.title || [])
  const issueDate    = props["Issue Date"]?.date?.start || ""
  const invoiceType  = props["Invoice Type"]?.select?.name || ""
  const status       = props.Status?.select?.name || ""
  const totalAmount  = props["Total Amount"]?.number || 0
  const depositPaid  = props["Deposit (50%)"]?.number || 0
  const payBalance   = props["Final Payment"]?.number || 0
  const depDate      = props["Deposit Due"]?.date?.start || ""
  const balDate      = props["Final Payment Due"]?.date?.start || ""
  const dueDate      = invoiceType === "Deposit" ? depDate : (balDate || depDate)

  // Company
  const companyRels = props.Company?.relation || []
  let company = { name: "", address: "", phone: "" }, companyId = ""
  if (companyRels.length) {
    companyId = companyRels[0].id.replace(/-/g, "")
    company   = await fetchCompanyInfo(companyId, token)
  }

  // PIC
  const pic = await resolvePic(props, token)

  // Quotation — pull line items
  let lineItems = [], quotationNo = "", pkgSlug = ""
  const quotRels = props.Quotation?.relation || []
  if (quotRels.length) {
    const qid = quotRels[0].id.replace(/-/g, "")
    try {
      const qpage   = await getPage(qid, token)
      const qprops  = qpage.properties
      quotationNo   = plain(qprops["Quotation No."]?.title || [])
      const qt      = qprops["Quote Type"]?.select?.name || ""
      const slugMap = {
        "Workflow OS": "workflow-os", "Sales CRM": "sales-crm",
        "Full Agency OS": "full-agency-os", "Operations OS": "workflow-os",
        "Business OS": "full-agency-os", "Complete OS": "complete-os",
      }
      pkgSlug     = slugMap[qt] || ""
      lineItems   = await fetchLineItems(qid, token)
    } catch {}
  }

  if (!lineItems.length && totalAmount) {
    lineItems = [{ name: "Professional Services", desc: "", qty: 1, unit_price: totalAmount }]
  }

  // Auto-assign invoice number
  if (!INV_PATTERN.test(invoiceNo)) {
    invoiceNo = formatInvoiceNumber(quotationNo, invoiceType)
    try {
      await patchPage(pageId, {
        "Invoice No.": { title: [{ text: { content: invoiceNo } }] }
      }, token)
    } catch {}
  }

  // Activate invoice (set dates, status)
  const today = new Date().toISOString().split("T")[0]
  const activateProps = {
    "Issue Date":    { date: { start: today } },
    "Final Payment": { number: Math.max(0, totalAmount - depositPaid) },
  }
  if (invoiceType !== "Final Payment") {
    activateProps.Status = { select: { name: "Deposit Pending" } }
  }
  try {
    await patchPage(pageId, activateProps, token)
  } catch {}

  const ourCompany = await fetchCompanyDetails(token)

  return {
    invoice_no:      invoiceNo,
    issue_date:      today,
    due_date:        dueDate,
    invoice_type:    invoiceType,
    status,
    total_amount:    totalAmount,
    deposit_paid:    depositPaid,
    payment_balance: payBalance || Math.max(0, totalAmount - depositPaid),
    company_name:    company.name,
    company_address: company.address,
    company_phone:   company.phone,
    company_id:      companyId,
    pic_name:        pic.name,
    pic_email:       pic.email,
    pic_phone:       pic.phone,
    line_items:      lineItems,
    pkg_slug:        pkgSlug,
    our_company:     ourCompany,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROPOSAL DATA FETCHER
// ═══════════════════════════════════════════════════════════════════════════

export async function fetchProposalData(pageId, token) {
  const page  = await getPage(pageId, token)
  const props = page.properties

  // Title / ref number
  let titleKey = "Ref Number"
  for (const [k, v] of Object.entries(props)) {
    if (v.type === "title") { titleKey = k; break }
  }
  const proposalNo = plain(props[titleKey]?.title || []) || `PRO-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`

  const issueDate    = props["Date"]?.date?.start || new Date().toISOString().split("T")[0]
  const validUntil   = props["Valid Until"]?.date?.start || ""
  const paymentTerms = props["Payment Terms"]?.select?.name || "50% Deposit"
  const quoteType    = props["Quote Type"]?.select?.name || "New Business"
  // OS Type — try select field first, then derive from Packages multi_select
  const osTypeDirect = props["OS Type"]?.select?.name || ""
  const packageNames = (props["Packages"]?.multi_select || []).map(s => s.name)
  const OS_NAMES     = ["Agency OS","Business OS","Marketing OS","Operations OS","Revenue OS","Team OS","Retention OS","Intelligence OS"]
  const osTypeFromPkg = packageNames.find(n => OS_NAMES.includes(n)) || ""
  const osType       = osTypeDirect || osTypeFromPkg
  const fee          = props["Fee"]?.number || 0

  // Context fields — filled manually in Notion before generating PDF
  const situation      = plain(props["Situation"]?.rich_text       || [])
  const problemsSolved = plain(props["Problems Solved"]?.rich_text || [])
  const goals          = plain(props["Goals"]?.rich_text           || [])

  // Company — prefer relation, fallback to text field
  const companyRels = props.Company?.relation || []
  let company = { name: "", address: "", phone: "" }
  if (companyRels.length) {
    company = await fetchCompanyInfo(companyRels[0].id.replace(/-/g, ""), token)
  } else if (props["Company Name"]?.rich_text?.length) {
    company.name = plain(props["Company Name"].rich_text)
  }

  // PIC — try all known field names (renamed from PIC → Primary Contact in Apr 2026)
  const picRels = (props["Primary Contact"]?.relation || props["PIC"]?.relation || props["Contact"]?.relation || [])
  let pic = { name: "", email: "", phone: "" }
  if (picRels.length) {
    pic = await fetchPersonInfo(picRels[0].id.replace(/-/g, ""), token)
  } else {
    pic.name = plain(props["Contact Name"]?.rich_text || [])
    pic.email = props.Email?.email || ""
    pic.phone = props.WhatsApp?.phone_number || ""
  }

  // Line items — from inline Products & Services DB if it exists, else from Fee field
  const [lineItemsRaw, ourCompany] = await Promise.all([
    fetchLineItems(pageId, token),
    fetchCompanyDetails(token),
  ])

  let lineItems = lineItemsRaw
  if (!lineItems.length && fee) {
    lineItems = [{ name: osType || "Professional Services", desc: "", qty: 1, unit_price: fee }]
  }

  return {
    doc_type:        "Proposal",
    proposal_no:     proposalNo,
    quotation_no:    proposalNo, // alias so generateQuotationPdf works unchanged
    title_prop_name: titleKey,
    issue_date:      issueDate,
    valid_until:     validUntil,
    payment_terms:   paymentTerms,
    quote_type:      quoteType,
    os_type:         osType,
    fee,
    situation,
    problems_solved: problemsSolved,
    goals,
    company_name:    company.name,
    company_address: company.address,
    company_phone:   company.phone,
    pic_name:        pic.name,
    pic_email:       pic.email,
    pic_phone:       pic.phone,
    line_items:      lineItems,
    our_company:     ourCompany,
  }
}
