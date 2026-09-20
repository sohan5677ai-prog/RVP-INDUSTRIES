import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { logger } from './logger.js';

const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/assets');

let ganeshaImgBuffer: Buffer | null = null;
try {
  ganeshaImgBuffer = fs.readFileSync(path.join(ASSET_DIR, 'kata-ganesha.jpg'));
} catch {
  try {
    ganeshaImgBuffer = fs.readFileSync(path.join(ASSET_DIR, 'ganesha.jpg'));
  } catch {}
}

let stampImgBuffer: Buffer | null = null;
try {
  stampImgBuffer = fs.readFileSync(path.join(ASSET_DIR, 'company-stamp.png'));
} catch {}

let signImgBuffer: Buffer | null = null;
try {
  signImgBuffer = fs.readFileSync(path.join(ASSET_DIR, 'authorised-sign.png'));
} catch {}

export interface SlipTicketData {
  ticketNo: number;
  vehicleNumber: string;
  partyName?: string | null;
  material?: string | null;
  loadType?: string | null;
  tripType?: string | null;
  firstWeightKg?: number | null;
  secondWeightKg?: number | null;
  netWeightKg?: number | null;
  amount?: unknown;
  paidAmount?: unknown;
  paidAt?: Date | string | null;
  createdAt?: Date | string | null;
  secondWeighedAt?: Date | string | null;
  firstWeighedAt?: Date | string | null;
  isStorageTransfer?: boolean;
  storageLocation?: string | null;
  transferDirection?: string | null;
  cam1PhotoUrl?: string | null;
  cam2PhotoUrl?: string | null;
  secondCam1PhotoUrl?: string | null;
  secondCam2PhotoUrl?: string | null;
}

function escapeXml(unsafe: string | number | null | undefined): string {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatTicketNo(no: number | string | undefined | null): string {
  if (no == null) return '01';
  const n = Number(no);
  if (isNaN(n)) return String(no);
  return n < 10 ? `0${n}` : `${n}`;
}

async function fetchOrReadImage(urlOrPath: string | null | undefined): Promise<Buffer | null> {
  if (!urlOrPath) return null;
  try {
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(urlOrPath, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const ab = await res.arrayBuffer();
        return Buffer.from(ab);
      }
    } else if (urlOrPath.startsWith('data:image/')) {
      const base64Part = urlOrPath.split(',')[1];
      if (base64Part) return Buffer.from(base64Part, 'base64');
    } else {
      // Local snapshot filename or path
      const candidatePaths = [
        urlOrPath,
        path.join(process.cwd(), 'snapshots', path.basename(urlOrPath)),
        path.join(process.cwd(), 'server', 'snapshots', path.basename(urlOrPath)),
      ];
      for (const cp of candidatePaths) {
        if (fs.existsSync(cp)) {
          return fs.readFileSync(cp);
        }
      }
    }
  } catch (err) {
    logger.warn(`[slip-image] failed to fetch/read image (${urlOrPath}):`, err);
  }
  return null;
}

/**
 * Generates the official stamped Weighbridge Kata Certificate as a high-resolution JPEG image.
 * Matching the exact layout of media_1789913564371.png:
 * - Lord Ganesha circular emblem (top left)
 * - RVP WEIGH BRIDGE header with GOVT APPROVED badge, address, phone
 * - 24 HRS SERVICE badge (top right)
 * - OFFICIAL INKED "RECEIVED" STAMP in top-right blank space (Consignment Received)
 * - S. No., DATE, TIME yellow badges and values
 * - Dual CP PLUS CCTV camera pictures side-by-side with date/time stamps
 * - Vehicle No., 1st Weight, 2nd Weight, Net Weight
 * - Party Name, Material, Charges, Signature with official RVP seal & sign
 * - 100 TON bottom footer
 */
export async function generateWeighbridgeSlipJpeg(ticket: SlipTicketData): Promise<Buffer> {
  const WIDTH = 1050;
  const HEIGHT = 740;

  const dateObj = ticket.createdAt ? new Date(ticket.createdAt) : new Date();
  const day = String(dateObj.getDate()).padStart(2, '0');
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const year = dateObj.getFullYear();
  const formattedDate = `${day}-${month}-${year}`;

  const formattedTime = dateObj.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).toUpperCase();

  const firstWeight = ticket.firstWeightKg ?? null;
  const secondWeight = ticket.secondWeightKg ?? null;
  let grossWeight = firstWeight;
  let tareWeight = secondWeight;
  let netWeight = ticket.netWeightKg ?? null;

  if (firstWeight != null && secondWeight != null) {
    grossWeight = Math.max(firstWeight, secondWeight);
    tareWeight = Math.min(firstWeight, secondWeight);
    netWeight = grossWeight - tareWeight;
  }

  const partyOrRoute = ticket.isStorageTransfer && ticket.storageLocation
    ? ticket.transferDirection === 'STORAGE_TO_RVP'
      ? `${ticket.storageLocation} → RVP`
      : `RVP → ${ticket.storageLocation}`
    : ticket.partyName || '';

  const formattedCharges = `₹ ${Number(ticket.amount || 0).toFixed(2)}`;
  const formattedMaterial = (ticket.material || '').trim().toUpperCase();

  const svgXml = `
  <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="stampShadow" x="-10%" y="-10%" width="120%" height="120%">
        <feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#047857" flood-opacity="0.15" />
      </filter>
    </defs>

    <!-- Background -->
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff" />

    <!-- Outer Double/Solid Red Border -->
    <rect x="16" y="16" width="${WIDTH - 32}" height="${HEIGHT - 32}" rx="12" fill="#ffffff" stroke="#dc2626" stroke-width="3" />

    <!-- Ganesha Emblem Frame (Left: x=34, y=30, size=76x76) -->
    <circle cx="72" cy="68" r="37" fill="#ffffff" stroke="#dc2626" stroke-width="3" />
    <circle cx="72" cy="68" r="34" fill="none" stroke="#eab308" stroke-width="1.5" />

    <!-- Center Header -->
    <text x="525" y="52" text-anchor="middle" font-family="Arial, 'Helvetica Neue', sans-serif" font-weight="900" font-size="27" fill="#b91c1c" letter-spacing="0.5">RVP WEIGH BRIDGE</text>
    
    <!-- GOVT APPROVED Badge -->
    <rect x="445" y="60" width="160" height="18" rx="9" fill="#facc15" />
    <text x="525" y="73.5" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="10.5" fill="#000000" letter-spacing="0.5">GOVT APPROVED</text>

    <!-- Address & Phone -->
    <text x="525" y="93" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="11.5" fill="#27272a">3/86, New By-Pass Road, Near Rajuluru, BG Palli, PUNGANUR - 517 247, Chittoor Dist., A.P.</text>
    <text x="525" y="109" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="12" fill="#18181b">Ph : 91215 53909, 94909 21002</text>

    <!-- 24 HRS SERVICE Badge (Top Right: x=945, y=30) -->
    <circle cx="980" cy="68" r="35" fill="#fafafa" stroke="#18181b" stroke-width="2.5" />
    <text x="980" y="62" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="20" fill="#000000" line-height="1">24</text>
    <text x="980" y="75" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="11" fill="#000000">HRS</text>
    <rect x="955" y="80" width="50" height="13" rx="2" fill="#18181b" />
    <text x="980" y="89.5" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="8" fill="#ffffff" letter-spacing="0.5">SERVICE</text>

    <!-- TOP RIGHT BLANK SPACE: INKED "RECEIVED" STAMP (Consignment Received) -->
    <g transform="rotate(-3 890 135)" filter="url(#stampShadow)">
      <rect x="785" y="105" width="225" height="68" rx="6" fill="#f0fdf4" fill-opacity="0.9" stroke="#047857" stroke-width="2.5" />
      <rect x="789" y="109" width="217" height="60" rx="4" fill="none" stroke="#047857" stroke-width="1" stroke-dasharray="6,2" />
      <text x="897" y="126" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="10.5" fill="#047857" letter-spacing="1">✔ CONSIGNMENT</text>
      <text x="897" y="148" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="19" fill="#047857" letter-spacing="2.5">RECEIVED</text>
      <text x="897" y="163" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="8.5" fill="#065f46" letter-spacing="0.8">RVP WEIGH BRIDGE</text>
    </g>

    <!-- S. No., DATE, TIME Outlines (Top: y=180, Height: 42) -->
    <!-- S. No. Box -->
    <rect x="25" y="180" width="315" height="42" rx="6" fill="#ffffff" stroke="#f59e0b" stroke-width="2" />
    <rect x="25" y="180" width="75" height="42" rx="6" fill="#fde047" stroke="#f59e0b" stroke-width="1" />
    <text x="62" y="206" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="13" fill="#7f1d1d">S. No.</text>
    <text x="195" y="208" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="20" fill="#000000" letter-spacing="0.5">${escapeXml(formatTicketNo(ticket.ticketNo))}</text>

    <!-- DATE Box -->
    <rect x="365" y="180" width="315" height="42" rx="6" fill="#ffffff" stroke="#f59e0b" stroke-width="2" />
    <rect x="365" y="180" width="75" height="42" rx="6" fill="#fde047" stroke="#f59e0b" stroke-width="1" />
    <text x="402" y="206" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="13" fill="#7f1d1d">DATE</text>
    <text x="525" y="207" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="18" fill="#000000">${escapeXml(formattedDate)}</text>

    <!-- TIME Box -->
    <rect x="705" y="180" width="320" height="42" rx="6" fill="#ffffff" stroke="#f59e0b" stroke-width="2" />
    <rect x="705" y="180" width="75" height="42" rx="6" fill="#fde047" stroke="#f59e0b" stroke-width="1" />
    <text x="742" y="206" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="13" fill="#7f1d1d">TIME</text>
    <text x="880" y="207" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="18" fill="#000000">${escapeXml(formattedTime)}</text>

    <!-- Two Photo Frames Outline (y=232, height=260) -->
    <rect x="25" y="232" width="485" height="260" rx="8" fill="#f5f5f5" stroke="#ef4444" stroke-width="2.5" />
    <rect x="540" y="232" width="485" height="260" rx="8" fill="#f5f5f5" stroke="#ef4444" stroke-width="2.5" />

    <!-- CP PLUS Camera Stamps -->
    <rect x="360" y="468" width="140" height="20" rx="3" fill="rgba(0,0,0,0.65)" />
    <text x="430" y="482" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="11" fill="#ffffff">${escapeXml(formattedDate)} ${escapeXml(formattedTime)}</text>

    <rect x="875" y="468" width="140" height="20" rx="3" fill="rgba(0,0,0,0.65)" />
    <text x="945" y="482" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="11" fill="#ffffff">${escapeXml(formattedDate)} ${escapeXml(formattedTime)}</text>

    <!-- ROW 1 HEADERS (y=505, height=24) -->
    <rect x="25" y="505" width="235" height="24" rx="3" fill="#dc2626" />
    <text x="142" y="521" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="12" fill="#ffffff">VEHICLE NO.</text>

    <rect x="280" y="505" width="235" height="24" rx="3" fill="#dc2626" />
    <text x="397" y="521" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="12" fill="#ffffff">1ST WEIGHT</text>

    <rect x="535" y="505" width="235" height="24" rx="3" fill="#dc2626" />
    <text x="652" y="521" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="12" fill="#ffffff">2ND WEIGHT</text>

    <rect x="790" y="505" width="235" height="24" rx="3" fill="#dc2626" />
    <text x="907" y="521" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="12" fill="#ffffff">NET WEIGHT</text>

    <!-- ROW 1 BOXES & VALUES (y=529, height=48) -->
    <rect x="25" y="529" width="235" height="48" rx="4" fill="#ffffff" stroke="#ef4444" stroke-width="1.5" />
    <text x="142" y="561" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="20" fill="#000000" letter-spacing="0.5">${escapeXml(ticket.vehicleNumber)}</text>

    <rect x="280" y="529" width="235" height="48" rx="4" fill="#ffffff" stroke="#ef4444" stroke-width="1.5" />
    <text x="397" y="561" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="20" fill="#000000">${firstWeight != null ? `${firstWeight}-Kg` : ''}</text>

    <rect x="535" y="529" width="235" height="48" rx="4" fill="#ffffff" stroke="#ef4444" stroke-width="1.5" />
    <text x="652" y="561" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="20" fill="#000000">${secondWeight != null ? `${secondWeight}-Kg` : ''}</text>

    <rect x="790" y="529" width="235" height="48" rx="4" fill="#ffffff" stroke="#ef4444" stroke-width="1.5" />
    <text x="907" y="561" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="21" fill="#000000">${netWeight != null ? `${netWeight}-Kg` : ''}</text>

    <!-- ROW 2 HEADERS (y=585, height=24) -->
    <rect x="25" y="585" width="235" height="24" rx="3" fill="#dc2626" />
    <text x="142" y="601" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="12" fill="#ffffff">PARTY NAME</text>

    <rect x="280" y="585" width="235" height="24" rx="3" fill="#dc2626" />
    <text x="397" y="601" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="12" fill="#ffffff">MATERIAL</text>

    <rect x="535" y="585" width="235" height="24" rx="3" fill="#dc2626" />
    <text x="652" y="601" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="12" fill="#ffffff">CHARGES</text>

    <rect x="790" y="585" width="235" height="24" rx="3" fill="#dc2626" />
    <text x="907" y="601" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="12" fill="#ffffff">SIGNATURE</text>

    <!-- ROW 2 BOXES & VALUES (y=609, height=52) -->
    <rect x="25" y="609" width="235" height="52" rx="4" fill="#ffffff" stroke="#ef4444" stroke-width="1.5" />
    <text x="142" y="641" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="${partyOrRoute.length > 20 ? '13' : '16'}" fill="#000000">${escapeXml(partyOrRoute)}</text>

    <rect x="280" y="609" width="235" height="52" rx="4" fill="#ffffff" stroke="#ef4444" stroke-width="1.5" />
    <text x="397" y="641" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="15" fill="#000000">${escapeXml(formattedMaterial)}</text>

    <rect x="535" y="609" width="235" height="52" rx="4" fill="#ffffff" stroke="#ef4444" stroke-width="1.5" />
    <text x="652" y="641" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="18" fill="#000000">${escapeXml(formattedCharges)}</text>

    <rect x="790" y="609" width="235" height="52" rx="4" fill="#ffffff" stroke="#ef4444" stroke-width="1.5" />

    <!-- FOOTER STRIP (y=675) -->
    <rect x="25" y="675" width="65" height="20" rx="2" fill="#b91c1c" />
    <text x="57" y="689" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="11" fill="#ffffff">100 TON</text>

    <text x="100" y="689" font-family="Arial, sans-serif" font-weight="700" font-size="10.5" fill="#3f3f46">Weigh Bridge Manufactured by : Sri Modern Weigh System. Cell 98430 55760</text>
    <text x="1025" y="689" text-anchor="end" font-family="Arial, sans-serif" font-weight="900" font-size="13" fill="#b91c1c">THANK YOU! VISIT AGAIN!!</text>
  </svg>`;

  // Prepare images to composite onto the SVG canvas
  const composites: OverlayOptions[] = [];

  // 1. Lord Ganesha emblem (circular at x=38, y=34, size=68x68)
  if (ganeshaImgBuffer) {
    try {
      const ganeshaResized = await sharp(ganeshaImgBuffer)
        .resize(68, 68, { fit: 'cover' })
        .toBuffer();
      composites.push({ input: ganeshaResized, left: 38, top: 34 });
    } catch (e) {
      logger.warn('[slip-image] failed to resize ganesha image:', e);
    }
  }

  // 2. CAM 1 Photo (Left camera box: x=27, y=234, width=481, height=256)
  const cam1Src = ticket.secondCam1PhotoUrl || ticket.cam1PhotoUrl;
  const cam1Buf = await fetchOrReadImage(cam1Src);
  if (cam1Buf) {
    try {
      const cam1Resized = await sharp(cam1Buf)
        .resize(481, 256, { fit: 'cover' })
        .toBuffer();
      composites.push({ input: cam1Resized, left: 27, top: 234 });
    } catch (e) {
      logger.warn('[slip-image] failed to resize cam1 image:', e);
    }
  }

  // 3. CAM 2 Photo (Right camera box: x=542, y=234, width=481, height=256)
  const cam2Src = ticket.secondCam2PhotoUrl || ticket.cam2PhotoUrl;
  const cam2Buf = await fetchOrReadImage(cam2Src);
  if (cam2Buf) {
    try {
      const cam2Resized = await sharp(cam2Buf)
        .resize(481, 256, { fit: 'cover' })
        .toBuffer();
      composites.push({ input: cam2Resized, left: 542, top: 234 });
    } catch (e) {
      logger.warn('[slip-image] failed to resize cam2 image:', e);
    }
  }

  // 4. Official RVP Industries Blue Seal / Stamp (in Signature cell: left=820, top=612)
  if (stampImgBuffer) {
    try {
      const stampResized = await sharp(stampImgBuffer)
        .resize(175, 48, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      composites.push({ input: stampResized, left: 820, top: 611 });
    } catch (e) {
      logger.warn('[slip-image] failed to resize stamp image:', e);
    }
  }

  // 5. Authorised Signature (bottom right of signature cell: left=870, top=635)
  if (signImgBuffer) {
    try {
      const signResized = await sharp(signImgBuffer)
        .resize(110, 26, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      composites.push({ input: signResized, left: 865, top: 632 });
    } catch (e) {
      logger.warn('[slip-image] failed to resize signature image:', e);
    }
  }

  // Render SVG background and composite all images
  const baseImg = sharp(Buffer.from(svgXml));
  if (composites.length > 0) {
    baseImg.composite(composites);
  }

  return baseImg.jpeg({ quality: 92 }).toBuffer();
}
