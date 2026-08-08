import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IST_TZ } from './istDate.js';

/**
 * Surya Road Lines' printed stationery fixed details - mirrors the constant of
 * the same name in client/src/pages/LorryReceiptView.tsx. Keep the two in step;
 * this is the same physical GC book rendered as a real PDF instead of a browser
 * print, so it can be merged into the WhatsApp dispatch bundle.
 */
const SRL = {
  name: 'SURYA ROAD LINES',
  tagline: 'Transport Contractors & Commission Agents',
  address: 'M.B.T. Road, PUNGANUR - 517 247, Chittoor Dist., A.P.,',
  phones: 'Jagan : 9440216173, 8019152521, Resi.: 9490830413.',
  pan: 'AACBS0915N',
  labourReg: 'AP-10-37-015-0242317',
  udyam: 'UDAYAM AP-02-0002343',
};

/** Goods description per product, worded as the transporter's book expects it -
 *  mirrors client/src/lib/productNames.ts (PRODUCT_DESCRIPTION). */
const PRODUCT_DESCRIPTION: Record<string, string> = {
  PAPPU: 'Tamarind Seed Pappu',
  HUSK: 'Tamarind Husk',
  WASTE: 'Tamarind Waste',
  TPS: 'Tamarind Seed Brokens',
  SHELL: 'Tamarind Shell',
  PRECLEANER_DUST: 'Pre Cleaner Dust',
  NALLA_POKKULU: 'Nalla Pokkulu',
  NALLA_CHINTAPANDU: 'Nalla Chintapandu',
};

export function lorryReceiptProductDescription(product?: string | null): string {
  return PRODUCT_DESCRIPTION[product ?? 'PAPPU'] ?? 'Tamarind Seed Pappu';
}

export interface LorryReceiptPdfData {
  company: { name: string; address?: string | null; dispatchFromPlace?: string | null; stateName?: string | null };
  buyer: { name: string; address?: string | null; city?: string | null; state?: string | null; pincode?: string | null };
  destination?: string | null;
  product?: string | null;
  invoiceNumber?: string | null;
  vehicleNumber?: string | null;
  driverName?: string | null;
  weightKg: number;
  gcNo: string;
  gcDate: Date;
  bags?: number | null;
  kgPerBag?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Masthead artwork                                                            */
/*                                                                            */
/* Resolved against server/src/assets from both src/lib (tsx, dev) and         */
/* dist/lib (tsc output on Render) - the build only emits .js, so a plain      */
/* '../assets' hop would find nothing in production and print the sheet with   */
/* an empty masthead.                                                          */
/* -------------------------------------------------------------------------- */
const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/assets');
let assetCache: { ganesha: Buffer | null; balaji: Buffer | null } | undefined;
function masthead(): { ganesha: Buffer | null; balaji: Buffer | null } {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(ASSET_DIR, name));
    } catch {
      return null;
    }
  };
  if (!assetCache) assetCache = { ganesha: read('ganesha.png'), balaji: read('balaji.png') };
  return assetCache;
}

const NAVY = '#1a4a99';
/** Navy at ~40% on white - the sheet's faint hairlines (its border-…/40 rules). */
const NAVY_FAINT = '#a3b7db';
const RED = '#cc1111';
const SAFFRON = '#b7410e';

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/*                                                                            */
/* The whole sheet is laid out in CSS pixels so the numbers can be read off    */
/* LorryReceiptView.tsx one for one, then scaled to points on the way out      */
/* (1 px at 96 dpi = 0.75 pt). At A4 with the page's own 9mm x 14mm print      */
/* margin that leaves a 688 x 1054 px sheet - the same box the browser prints. */
/* -------------------------------------------------------------------------- */
const mm = (v: number) => (v * 72) / 25.4;
const S = 0.75;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MX = mm(14);
const MY = mm(9);
const SHEET_W = (PAGE_W - MX * 2) / S;
const SHEET_H = (PAGE_H - MY * 2) / S;

/** Section heights, top to bottom; the footer takes whatever is left. */
const MAST_H = 152;
const MID_H = 106;
const ADDR_H = 190;
const GOODS_H = 106;
const CHARGE_H = 80;

const B_THICK = 2.5;
const B_MED = 2;
const B_THIN = 1;

/** Serif for the printed matter, grotesque for the filled-in values - the same
 *  split the sheet makes between "Times New Roman" and Arial (.lr-fill). */
const SERIF = 'Times-Roman';
const SERIF_B = 'Times-Bold';
const SERIF_BI = 'Times-BoldItalic';
const SANS_B = 'Helvetica-Bold';

/** The book writes 7/8/26, not 07/08/26. IST, since Render runs on UTC. */
function fmtDmy(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ, day: 'numeric', month: 'numeric', year: '2-digit',
  }).formatToParts(d);
  const at = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${Number(at('day'))}/${Number(at('month'))}/${at('year')}`;
}

/** 30 t at 50 kg/bag = 600 bags - the default packing when none was recorded. */
function bagsFor(weightKg: number, kgPerBag: number): string {
  if (!weightKg || !kgPerBag) return '';
  return String(Math.round(weightKg / kgPerBag));
}

/**
 * Render the Surya Road Lines lorry receipt (GC note) as an A4 PDF page,
 * matching the on-screen printable copy at client/src/pages/LorryReceiptView.tsx
 * so the WhatsApp bundle, the download, and the physical printout all agree.
 *
 * The stamp and authorised signature are deliberately NOT drawn here - unlike
 * the tax invoice, this document carries no company seal; the transporter's own
 * mark goes on by hand (or a dedicated lorry-receipt signature image, once one
 * is supplied) rather than the invoice's authorised-sign.png/company-stamp.png.
 */
export function renderLorryReceiptPdf(data: LorryReceiptPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    /* ── px -> pt plumbing ───────────────────────────────────────────────── */
    const px = (v: number) => v * S;
    const ax = (v: number) => MX + v * S;
    const ay = (v: number) => MY + v * S;

    const line = (x1: number, y1: number, x2: number, y2: number, w = B_THIN, color = NAVY) =>
      doc.lineWidth(px(w)).strokeColor(color).moveTo(ax(x1), ay(y1)).lineTo(ax(x2), ay(y2)).stroke();
    const hl = (y: number, x1: number, x2: number, w = B_THIN, color = NAVY) => line(x1, y, x2, y, w, color);
    const vl = (x: number, y1: number, y2: number, w = B_THIN, color = NAVY) => line(x, y1, x, y2, w, color);
    const box = (x: number, y: number, w: number, h: number, lw = B_THIN, color = NAVY) =>
      doc.lineWidth(px(lw)).strokeColor(color).rect(ax(x), ay(y), px(w), px(h)).stroke();

    type TOpt = {
      size?: number;
      font?: string;
      color?: string;
      align?: 'left' | 'center' | 'right' | 'justify';
      underline?: boolean;
      lineGap?: number;
      charSpacing?: number;
      continued?: boolean;
    };
    /** Draws text at a px position/width and returns the px y just below it. */
    const T = (t: string, x: number, y: number, w: number, o: TOpt = {}): number => {
      doc.font(o.font ?? SERIF).fontSize(px(o.size ?? 9)).fillColor(o.color ?? NAVY);
      doc.text(t, ax(x), ay(y), {
        width: px(w),
        align: o.align ?? 'left',
        underline: o.underline ?? false,
        lineGap: px(o.lineGap ?? 0),
        characterSpacing: px(o.charSpacing ?? 0),
        continued: o.continued ?? false,
      });
      return (doc.y - MY) / S;
    };
    /**
     * Continues the run started by a `T(..., { continued: true })` - PDFKit
     * only picks up a continuation when the call carries no coordinates, and
     * inherits the width/alignment of the run's first segment.
     */
    const Tc = (t: string, o: TOpt = {}): number => {
      doc.font(o.font ?? SERIF).fontSize(px(o.size ?? 9)).fillColor(o.color ?? NAVY);
      doc.text(t, {
        underline: false,
        characterSpacing: px(o.charSpacing ?? 0),
        continued: o.continued ?? false,
        ...(o.align ? { align: o.align } : {}),
      });
      return (doc.y - MY) / S;
    };
    /** Same as `T`, vertically centred in a band of height `h`. */
    const Tmid = (t: string, x: number, y: number, w: number, h: number, o: TOpt = {}): number => {
      const size = o.size ?? 9;
      doc.font(o.font ?? SERIF).fontSize(px(size));
      const th = doc.heightOfString(t, { width: px(w) }) / S;
      return T(t, x, y + (h - th) / 2, w, o);
    };
    const textW = (t: string, size: number, font = SERIF, charSpacing = 0) => {
      doc.font(font).fontSize(px(size));
      return doc.widthOfString(t, { characterSpacing: px(charSpacing) }) / S;
    };

    /* ── data ────────────────────────────────────────────────────────────── */
    const kgPerBag = data.kgPerBag ?? 50;
    const bags = data.bags != null ? String(data.bags) : bagsFor(data.weightKg, kgPerBag);
    const fromPlace = (data.company.dispatchFromPlace || data.company.stateName || 'PUNGANUR').toUpperCase();
    const toPlace = (data.destination || data.buyer.city || data.buyer.state || '').toUpperCase();
    const description = lorryReceiptProductDescription(data.product).toUpperCase();
    const consignor = [data.company.name, data.company.address].filter(Boolean).join('\n').toUpperCase();
    const consignee = [
      data.buyer.name,
      data.buyer.address,
      [data.buyer.city, data.buyer.state, data.buyer.pincode].filter(Boolean).join(', '),
    ].filter(Boolean).join('\n').toUpperCase();
    const DASH = '----';

    /* ══ MASTHEAD ════════════════════════════════════════════════════════ */
    const { ganesha, balaji } = masthead();
    if (ganesha) doc.image(ganesha, ax(14.5), ay(37), { fit: [px(62), px(78)], align: 'center' });
    if (balaji) doc.image(balaji, ax(608), ay(41), { fit: [px(70), px(70)], align: 'center' });

    const cX = 95;
    const cW = 498;

    // The three devotional marks stamped above the logotype: Om roundel, a
    // Ganesha roundel, and a saffron swastika. Drawn as vector art - the base-14
    // PDF fonts carry no Devanagari or CJK glyph for them.
    const marksW = 15 + 8 + 16 + 8 + 13;
    let mx = cX + (cW - marksW) / 2;
    drawOm(mx + 7.5, 19.5, 15);
    mx += 15 + 8;
    doc.lineWidth(px(1)).strokeColor(NAVY).circle(ax(mx + 8), ay(19.5), px(8)).stroke();
    if (ganesha) doc.image(ganesha, ax(mx + 3), ay(13), { fit: [px(10), px(13)], align: 'center' });
    mx += 16 + 8;
    drawSwastika(mx + 6.5, 19.5, 12);

    // "SRL" oval + the jurisdiction line, centred as one unit.
    const jur = 'Subject to Punganur Jurisdiction';
    const jurW = textW(jur, 10, SERIF_B);
    let sx = cX + (cW - (36 + 6 + jurW)) / 2;
    doc.lineWidth(px(1.5)).strokeColor(NAVY).ellipse(ax(sx + 18), ay(39.5), px(18), px(9.5)).stroke();
    T('SRL', sx, 34.5, 36, { size: 11, font: SERIF_B, align: 'center', charSpacing: 0.5 });
    T(jur, sx + 42, 35, jurW + 2, { size: 10, font: SERIF_B });

    T(SRL.name, cX, 51, cW, { size: 32, font: SERIF_B, align: 'center', charSpacing: -0.3 });

    const tagW = textW(SRL.tagline, 10, SERIF_B) + 24;
    doc.lineWidth(px(1)).strokeColor(NAVY)
      .roundedRect(ax(cX + (cW - tagW) / 2), ay(90), px(tagW), px(15), px(7.5)).stroke();
    T(SRL.tagline, cX, 93.5, cW, { size: 10, font: SERIF_B, align: 'center' });

    T(SRL.address, cX, 110, cW, { size: 10, font: SERIF_B, align: 'center' });
    T(SRL.phones, cX, 123, cW, { size: 9.5, font: SERIF_B, align: 'center' });

    hl(MAST_H, 0, SHEET_W, B_THICK);

    /* ══ 3-COLUMN MIDDLE SECTION ═════════════════════════════════════════ */
    const midTop = MAST_H;
    const midBot = midTop + MID_H;
    const c1W = SHEET_W * 0.3;
    const c2W = SHEET_W * 0.32;
    const c1X = 0;
    const c2X = c1W;
    const c3X = c1W + c2W;
    const c3W = SHEET_W - c3X;

    // Col 1 - registrations, then the caution box.
    let y1 = midTop + 6;
    for (const l of [
      `PAN CARD : ${SRL.pan}`,
      `LABOUR Reg. No. : ${SRL.labourReg}`,
      `msme UDAYAM Reg. No.: ${SRL.udyam}`,
    ]) y1 = T(l, c1X + 6, y1, c1W - 12, { size: 8, font: SANS_B }) + 1;
    const cautTop = y1 + 3;
    T('CAUTION', c1X + 10, cautTop + 4, c1W - 20, { size: 8.5, font: SERIF_B, align: 'center', charSpacing: 0.5 });
    let cy = cautTop + 16;
    for (const l of [
      'This Consignment will not detained',
      'Re routed or booked without consignee',
      'Banks written promission will be',
      'delivered at the destinaltion',
    ]) cy = T(l, c1X + 10, cy, c1W - 20, { size: 8.5 });
    box(c1X + 6, cautTop, c1W - 12, cy - cautTop + 4, B_THIN);

    // Col 2 - consignor's copy / owner's risk / insurance blanks.
    let y2 = midTop + 6;
    for (const l of ["CONSIGNOR'S COPY", 'AT OWNERS RISK', 'INSURANCE']) {
      y2 = T(l, c2X + 6, y2, c2W - 12, { size: 9, font: SERIF_B, align: 'center' });
    }
    y2 += 4;
    hl(y2, c2X + 6, c2X + c2W - 6, B_THIN, NAVY_FAINT);
    y2 = T(
      'The Customer has stated that the has not insurance the consignment or he has insured the consignment.',
      c2X + 6, y2 + 4, c2W - 12, { size: 8, align: 'justify' },
    ) + 4;
    for (const l of [
      'Company:.........................................',
      'Policy No.:......................................',
      'Amount:..........................................',
      'Risk:............................................',
    ]) y2 = T(l, c2X + 6, y2, c2W - 12, { size: 8 }) + 0.5;

    // Col 3 - the carriage note, with the G.C. number pinned to the bottom.
    T('NOTE : ', c3X + 6, midTop + 6, c3W - 12, { size: 8.5, font: SERIF_B, align: 'justify', continued: true });
    // The gap after the bold lead-in rides on the lead-in itself - PDFKit's
    // justifier drops a leading space at the head of a continued run.
    Tc(
      'This Consignment covered by this of special lorry receipt from shall be stored at the destination under control of the Transport order and shall be delivered to order of then consignee bank whose name mentioned in the lorry receipt it will under no circumstance be delivered to any one without the written authority from the consignee copy or on a separate letter of Authority.',
      { size: 8.5 },
    );
    const gcTop = midBot - 24;
    hl(gcTop, c3X + 6, c3X + c3W - 6, B_THIN);
    T('G.C. No.', c3X + 6, gcTop + 7, c3W * 0.4, { size: 11, font: SERIF_B });
    T(data.gcNo || DASH, c3X + c3W * 0.45, gcTop + 3, c3W * 0.55 - 6, {
      size: 20, font: SANS_B, color: RED, align: 'right', charSpacing: 1,
    });

    vl(c2X, midTop, midBot, B_MED);
    vl(c3X, midTop, midBot, B_MED);
    hl(midBot, 0, SHEET_W, B_THICK);

    /* ══ ADDRESSES & ROUTE ═══════════════════════════════════════════════ */
    const addrTop = midBot;
    const addrBot = addrTop + ADDR_H;
    const leftW = SHEET_W * 0.62;
    const rightX = leftW;
    const rightW = SHEET_W - leftW;
    const half = addrTop + ADDR_H / 2;

    T('Consignors Name & Address :', 6, addrTop + 6, leftW - 12, { size: 9, font: SERIF_B, underline: true });
    T(consignor, 6, addrTop + 20, leftW - 12, { size: 10.5, font: SANS_B, lineGap: 1.5 });
    hl(half, 0, rightX, B_THIN);
    T('Consignee Name & Address :', 6, half + 6, leftW - 12, { size: 9, font: SERIF_B, underline: true });
    T(consignee, 6, half + 20, leftW - 12, { size: 10.5, font: SANS_B, lineGap: 1.5 });

    // Right column: five typed rows, then the freight-terms strip.
    const termsH = 34;
    const rowH = (ADDR_H - termsH) / 5;
    const rows: Array<[string, string]> = [
      ['Invoice No.:', data.invoiceNumber ?? ''],
      ['DATE:', fmtDmy(data.gcDate)],
      ['TRUCK NO.', (data.vehicleNumber ?? '').toUpperCase()],
      ['FROM', fromPlace],
      ['TO', toPlace],
    ];
    rows.forEach(([label, value], i) => {
      const ry = addrTop + rowH * i;
      Tmid(label, rightX + 8, ry, rightW * 0.42, rowH, { size: 9.5, font: SERIF_B });
      Tmid(value || DASH, rightX + rightW * 0.42, ry, rightW * 0.58 - 8, rowH, {
        size: 10.5, font: SANS_B, align: 'right',
      });
      hl(ry + rowH, rightX, SHEET_W, B_THIN);
    });

    const termsY = addrTop + rowH * 5;
    T('FREIGHT', rightX, termsY + 3, rightW, { size: 10, font: SERIF_B, align: 'center', charSpacing: 1.5 });
    hl(termsY + 17, rightX, SHEET_W, B_THIN);
    // RVP prepays the lorry, so the consignment always travels freight-paid -
    // the "Paid" side carries the tick, drawn rather than typed (no ✓ in the
    // base-14 encoding, which is what put a stray apostrophe on the sheet).
    const paidW = textW('Paid ', 9, SERIF_B);
    const pStart = rightX + rightW / 4 - (paidW + 7) / 2;
    T('Paid', pStart, termsY + 21, paidW, { size: 9, font: SERIF_B });
    drawTick(pStart + paidW + 1, termsY + 25.5, 6);
    T('To Pay', rightX + rightW / 2, termsY + 21, rightW / 2, { size: 9, font: SERIF_B, align: 'center' });
    vl(rightX + rightW / 2, termsY + 17, addrBot, B_THIN);

    vl(rightX, addrTop, addrBot, B_MED);
    hl(addrBot, 0, SHEET_W, B_THICK);

    /* ══ GOODS TABLE ═════════════════════════════════════════════════════ */
    const gTop = addrBot;
    const gBot = gTop + GOODS_H;
    const gW = [SHEET_W * 0.18, SHEET_W * 0.3, SHEET_W * 0.18, SHEET_W * 0.34];
    const gX = [0, gW[0], gW[0] + gW[1], gW[0] + gW[1] + gW[2]];

    T('Package', gX[0], gTop + 5, gW[0], { size: 10, font: SERIF_B, align: 'center' });
    hl(gTop + 20, gX[0], gX[1], B_THIN);
    T(bags || DASH, gX[0] + 6, gTop + 26, gW[0] - 12, { size: 11, font: SANS_B, continued: true });
    Tc(' Bags', { size: 9.5 });
    T('Each Bag', gX[0] + 6, gTop + 44, gW[0] - 12, { size: 9 });
    T(String(kgPerBag || DASH), gX[0] + 6, gTop + 60, gW[0] - 12, { size: 11, font: SANS_B, continued: true });
    Tc(' Kgs.', { size: 9.5 });

    T('Descriptions', gX[1], gTop + 5, gW[1], { size: 10, font: SERIF_B, align: 'center' });
    T('said to contain', gX[1], gTop + 17, gW[1], { size: 10, font: SERIF_B, align: 'center' });
    hl(gTop + 32, gX[1], gX[2], B_THIN);
    T(description, gX[1] + 6, gTop + 40, gW[1] - 12, { size: 11, font: SANS_B });

    T('Freight', gX[2], gTop + 5, gW[2], { size: 10, font: SERIF_B, align: 'center' });
    hl(gTop + 20, gX[2], gX[3], B_THIN);
    T('Per Bag', gX[2] + 6, gTop + 26, gW[2] - 12, { size: 9 });
    T('Lorry Freight', gX[2] + 6, gTop + 42, gW[2] - 12, { size: 9 });
    T('Rs. ________', gX[2] + 6, gTop + 58, gW[2] - 12, { size: 9 });

    const amtW = gW[3] / 2;
    ['Paid', 'To Pay'].forEach((col, i) => {
      const cx = gX[3] + amtW * i;
      T('Rs.', cx, gTop + 5, amtW * (2 / 3), { size: 8.5, font: SERIF_B, align: 'center' });
      T('Ps.', cx + amtW * (2 / 3), gTop + 5, amtW / 3, { size: 8.5, font: SERIF_B, align: 'center' });
      hl(gTop + 20, cx, cx + amtW, B_THIN);
      vl(cx + amtW * (2 / 3), gTop, gBot, B_THIN);
      if (i === 0) vl(cx + amtW, gTop, gBot, B_THIN);
      // The rubber-stamp impression struck across the Paid amount box.
      if (col === 'Paid') drawPaidStamp(cx + amtW / 2, gTop + 20 + (GOODS_H - 20) / 2);
    });

    vl(gX[1], gTop, gBot, B_THIN);
    vl(gX[2], gTop, gBot, B_THIN);
    vl(gX[3], gTop, gBot, B_THIN);
    hl(gBot, 0, SHEET_W, B_THICK);

    /* ══ RUPEES IN WORDS & CHARGES ═══════════════════════════════════════ */
    const chTop = gBot;
    const chBot = chTop + CHARGE_H;
    const wordsW = SHEET_W * 0.48;
    const labelW = SHEET_W * 0.18;
    const labelX = wordsW;
    const gridX = wordsW + labelW;
    const gridW = SHEET_W - gridX;

    T('To pay Lorry freight Rupees in words', 6, chTop + 6, wordsW - 12, { size: 9, font: SERIF_B });
    const dots = '.........................................................................';
    T(dots, 6, chTop + 20, wordsW - 12, { size: 8.5, color: NAVY_FAINT, charSpacing: 0.6 });
    T(dots, 6, chTop + 32, wordsW - 12, { size: 8.5, color: NAVY_FAINT, charSpacing: 0.6 });
    T('Unloading by Party', 6, chBot - 16, wordsW - 12, { size: 8.5, font: SERIF_BI });

    const chRowH = CHARGE_H / 3;
    ['Hamali', 'GC Charges', 'TOTAL'].forEach((label, i) => {
      const ry = chTop + chRowH * i;
      Tmid(label, labelX + 6, ry, labelW - 12, chRowH, {
        size: i === 2 ? 10 : 9.5, font: SERIF_B, charSpacing: i === 2 ? 0.5 : 0,
      });
      if (i < 2) hl(ry + chRowH, labelX, SHEET_W, B_THIN);
    });
    const amt2 = gridW / 2;
    vl(gridX + amt2 * (2 / 3), chTop, chBot, B_THIN);
    vl(gridX + amt2, chTop, chBot, B_THIN);
    vl(gridX + amt2 + amt2 * (2 / 3), chTop, chBot, B_THIN);
    vl(labelX, chTop, chBot, B_THIN);
    vl(gridX, chTop, chBot, B_THIN);
    hl(chBot, 0, SHEET_W, B_THICK);

    /* ══ FOOTER NOTES, SIGNATURE, DRIVER ═════════════════════════════════ */
    const fTop = chBot;
    const fBot = SHEET_H;
    const notesW = SHEET_W * 0.62;
    const sigX = SHEET_W * 0.68;
    const sigW = SHEET_W * 0.32 - 8;

    T('Note : ', 8, fTop + 8, notesW, {
      size: 8.5, font: SERIF_B, underline: true, align: 'justify', continued: true,
    });
    const fy = Tc(
      'Our leakage and damage we are not responsible. Insurance to be covered by the party. Any claim towards damage/shortage etc., should not settled with Driver at the unloading it self later date no complaint will be entertained by us.',
      { size: 8.5 },
    ) + 2;
    T('Note : ', 8, fy, notesW, { size: 8.5, font: SERIF_B, underline: true, continued: true });
    Tc('WE ARE NOT COLLECTING ANY GST AMOUNT TO PARTY.', { size: 8.5, font: SERIF_B });

    T('For Surya Road Lines', sigX, fTop + 8, sigW, { size: 11, font: SERIF_B, align: 'right' });
    const sigLineY = fTop + 46;
    hl(sigLineY, sigX, SHEET_W - 8, B_THIN, NAVY_FAINT);
    T('Authorised Signatory', sigX, sigLineY + 3, sigW, { size: 9, align: 'right' });

    const drvY = fBot - 22;
    hl(drvY, 8, SHEET_W - 8, B_THIN, NAVY_FAINT);
    T("Driver's Name : ", 8, drvY + 5, SHEET_W * 0.6, { size: 9.5, font: SERIF_B, continued: true });
    Tc((data.driverName ?? '').toUpperCase(), { size: 10.5, font: SANS_B });
    T('D.L. No. :', SHEET_W * 0.6, drvY + 5, SHEET_W * 0.4 - 26, { size: 9.5, font: SERIF_B, align: 'right' });

    // Outer border last, so nothing paints over it.
    box(0, 0, SHEET_W, SHEET_H, B_THICK);

    doc.end();

    /* ── vector marks ────────────────────────────────────────────────────── */

    /** The freight-paid tick, in place of a ✓ the base-14 fonts do not carry. */
    function drawTick(x: number, y: number, size: number) {
      doc.lineWidth(px(1.4)).strokeColor(RED).lineCap('round')
        .moveTo(ax(x), ay(y))
        .lineTo(ax(x + size * 0.35), ay(y + size * 0.45))
        .lineTo(ax(x + size), ay(y - size * 0.55))
        .stroke();
      doc.lineCap('butt');
    }

    /** Om roundel: navy disc with the mark knocked out in white. */
    function drawOm(cx: number, cy: number, d: number) {
      const r = d / 2;
      doc.circle(ax(cx), ay(cy), px(r)).fillColor(NAVY).fill();
      // Design space is a 100-unit square centred on the disc.
      const u = (v: number) => px((v / 100) * d);
      const X = (v: number) => ax(cx - r) + u(v);
      const Y = (v: number) => ay(cy - r) + u(v);
      doc.lineWidth(px(d * 0.075)).strokeColor('#ffffff').lineCap('round').lineJoin('round');
      // Lower bowl.
      doc.moveTo(X(46), Y(50))
        .bezierCurveTo(X(20), Y(48), X(14), Y(74), X(36), Y(82))
        .bezierCurveTo(X(54), Y(88), X(64), Y(70), X(52), Y(60))
        .bezierCurveTo(X(44), Y(54), X(34), Y(60), X(36), Y(68))
        .stroke();
      // Upper hook.
      doc.moveTo(X(46), Y(50))
        .bezierCurveTo(X(52), Y(40), X(46), Y(26), X(34), Y(28))
        .bezierCurveTo(X(24), Y(30), X(22), Y(42), X(32), Y(44))
        .stroke();
      // Tail to the crescent.
      doc.moveTo(X(53), Y(58)).bezierCurveTo(X(66), Y(52), X(74), Y(48), X(88), Y(48)).stroke();
      // Crescent and bindu.
      doc.moveTo(X(60), Y(26)).bezierCurveTo(X(68), Y(14), X(84), Y(16), X(88), Y(28)).stroke();
      doc.circle(X(78), Y(9), u(5)).fillColor('#ffffff').fill();
      doc.lineCap('butt').lineJoin('miter');
    }

    /** Saffron swastika (卐), four bars with counter-clockwise arms. */
    function drawSwastika(cx: number, cy: number, size: number) {
      const h = size / 2;
      const a = size * 0.42;
      doc.lineWidth(px(1.5)).strokeColor(SAFFRON).lineCap('square');
      doc.moveTo(ax(cx), ay(cy - h)).lineTo(ax(cx), ay(cy + h))
        .moveTo(ax(cx - h), ay(cy)).lineTo(ax(cx + h), ay(cy))
        .moveTo(ax(cx), ay(cy - h)).lineTo(ax(cx - a), ay(cy - h))
        .moveTo(ax(cx + h), ay(cy)).lineTo(ax(cx + h), ay(cy - a))
        .moveTo(ax(cx), ay(cy + h)).lineTo(ax(cx + a), ay(cy + h))
        .moveTo(ax(cx - h), ay(cy)).lineTo(ax(cx - h), ay(cy + a))
        .stroke();
      doc.lineCap('butt');
    }

    /** Double-ruled "PAID" stamp, struck at -12deg like the sheet's CSS one. */
    function drawPaidStamp(cx: number, cy: number) {
      const label = 'PAID';
      const size = 15;
      const spacing = size * 0.14;
      const w = textW(label, size, SANS_B, spacing) + 18;
      const h = size + 8;
      doc.save();
      doc.translate(ax(cx), ay(cy)).rotate(-12).translate(-ax(cx), -ay(cy));
      doc.opacity(0.85);
      doc.lineWidth(px(2)).strokeColor(RED)
        .roundedRect(ax(cx - w / 2), ay(cy - h / 2), px(w), px(h), px(3)).stroke();
      doc.lineWidth(px(1.6)).strokeColor(RED)
        .roundedRect(ax(cx - w / 2 - 3.5), ay(cy - h / 2 - 3.5), px(w + 7), px(h + 7), px(5)).stroke();
      doc.font(SANS_B).fontSize(px(size)).fillColor(RED)
        .text(label, ax(cx - w / 2), ay(cy - size * 0.52), {
          width: px(w), align: 'center', characterSpacing: px(spacing),
        });
      doc.opacity(1);
      doc.restore();
    }
  });
}
