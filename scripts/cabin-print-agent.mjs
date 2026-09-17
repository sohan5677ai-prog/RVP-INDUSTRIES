#!/usr/bin/env node
/**
 * RVP Industries - Kata Cabin Print Agent
 * 
 * Runs on the Kata Cabin Windows PC alongside cctv-bridge.mjs.
 * Polls the cloud ERP server for pending print jobs and prints weighbridge
 * slips on the cabin's physical printer using Puppeteer (headless Chrome).
 * 
 * Features:
 * 1) Polls POST /weighbridge/print-queue/pending every 5 seconds
 * 2) For each pending job, generates the weighment slip HTML
 * 3) Prints to the system default printer via Puppeteer
 * 4) Reports completion/failure back to the cloud
 * 
 * Setup:
 *   cd scripts
 *   npm install puppeteer
 *   node cabin-print-agent.mjs
 * 
 * Or run as a Windows service with pm2:
 *   pm2 start cabin-print-agent.mjs --name "RVP-Print-Agent"
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import ptp from 'pdf-to-printer';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(SCRIPT_DIR, '../logs');
const LOG_FILE = path.join(LOG_DIR, 'cabin-print-agent.log');
const LOCAL_CONFIG_FILE = process.env.PRINT_AGENT_CONFIG || path.join(SCRIPT_DIR, 'cctv-bridge.config.json');

fs.mkdirSync(LOG_DIR, { recursive: true });
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.previous`);
  }
} catch {}

// Logging
import util from 'util';
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      fs.appendFileSync(
        LOG_FILE,
        `${new Date().toISOString()} [${level.toUpperCase()}] ${util.format(...args)}\n`,
        'utf8'
      );
    } catch {}
  };
}

function loadLocalConfig() {
  if (!fs.existsSync(LOCAL_CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8'));
  } catch { return {}; }
}

const LOCAL_CONFIG = loadLocalConfig();
const setting = (name, fallback = '') => process.env[name] || LOCAL_CONFIG[name] || fallback;

function getDefaultBridgeKey() {
  const secret = process.env.JWT_SECRET || 'e4e783e85d137a23b282370d8dc67fd2a002425843a69ab32200fc5173040508';
  return crypto.createHmac('sha256', secret).update('rvp-cctv-bridge-v1').digest('hex');
}

const CONFIG = {
  cloudApiUrl: setting('CLOUD_API_URL', 'https://rvp-server.onrender.com/api').replace(/\/+$/, ''),
  pollIntervalMs: Number(setting('PRINT_POLL_INTERVAL_MS', 3000)),
  printMode: setting('PRINT_MODE', 'stationery'), // 'stationery' or 'plain'
  bridgeKey: setting('CCTV_BRIDGE_KEY') || getDefaultBridgeKey(),
  printerName: setting('CABIN_PRINTER_NAME', ''), // Optional specific printer name
  localPort: Number(setting('PRINT_LOCAL_PORT', 4001)),
};

console.log('================================================================');
console.log('  RVP Industries - Kata Cabin Print Agent                       ');
console.log(`  Cloud API: ${CONFIG.cloudApiUrl}`);
console.log(`  Poll Interval: ${CONFIG.pollIntervalMs}ms`);
console.log(`  Print Mode: ${CONFIG.printMode}`);
console.log(`  Printer: ${CONFIG.printerName || '(System Default)'}`);
console.log(`  Local Port: ${CONFIG.localPort}`);
console.log(`  Log file: ${LOG_FILE}`);
console.log('================================================================');

function getKataCabinAccessKey() {
  const configured = setting('KATA_CABIN_ACCESS_KEY');
  if (configured && configured.length >= 24) return configured;
  const secret = process.env.JWT_SECRET || 'e4e783e85d137a23b282370d8dc67fd2a002425843a69ab32200fc5173040508';
  return crypto.createHmac('sha256', secret)
    .update('rvp-kata-cabin-activation-v1')
    .digest('base64url');
}

let cachedCabinToken = null;
let lastCabinTokenFetch = 0;

async function getCabinAuthToken() {
  if (cachedCabinToken && Date.now() - lastCabinTokenFetch < 3600000) {
    return cachedCabinToken;
  }
  try {
    const key = getKataCabinAccessKey();
    const res = await new Promise((resolve, reject) => {
      const url = new URL(`${CONFIG.cloudApiUrl}/auth/kiosk`);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kata-Cabin-Key': key,
        },
        timeout: 10000,
      }, (res) => {
        let text = '';
        res.on('data', c => { text += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(text)); } catch { resolve({}); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });

    if (res && res.token) {
      cachedCabinToken = res.token;
      lastCabinTokenFetch = Date.now();
      return cachedCabinToken;
    }
  } catch {}
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────────────────────────────

async function httpRequest(method, urlStr, body = null) {
  const token = await getCabinAuthToken();

  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-CCTV-Bridge-Key': CONFIG.bridgeKey,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 15000,
    };

    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, data: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, data: text });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────
// Slip HTML Generator (matches WeighbridgeSlipModal exactly)
// ──────────────────────────────────────────────────────────────────────

function generateSlipHtml(ticket) {
  const firstWeight = ticket.firstWeightKg ?? null;
  const secondWeight = ticket.secondWeightKg ?? null;
  let grossWeight = null, tareWeight = null, netWeight = ticket.netWeightKg ?? null;

  if (firstWeight != null && secondWeight != null) {
    grossWeight = Math.max(firstWeight, secondWeight);
    tareWeight = Math.min(firstWeight, secondWeight);
    netWeight = grossWeight - tareWeight;
  } else if (firstWeight != null && netWeight == null) {
    netWeight = firstWeight;
  }

  const ticketDate = new Date(ticket.createdAt);
  const day = String(ticketDate.getDate()).padStart(2, '0');
  const month = String(ticketDate.getMonth() + 1).padStart(2, '0');
  const year = ticketDate.getFullYear();
  const formattedDate = `${day}-${month}-${year}`;
  const formattedTime = ticketDate.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  }).toUpperCase();

  const formatWeight = (val) => {
    if (val == null || isNaN(val)) return '';
    return `${Math.round(val)}-Kg`;
  };

  const material = ticket.material ? ticket.material.trim().toUpperCase() : '';
  const charges = `₹ ${Number(ticket.amount || 0).toFixed(2)}`;

  // Resolve camera URLs to absolute cloud URLs
  const resolveCamUrl = (url, cam) => {
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/api/')) return `https://rvp-server.onrender.com${url}`;
    return url;
  };

  // Use second-weight photos if available (completed ticket), else first-weight photos
  const cam1Url = resolveCamUrl(ticket.secondCam1PhotoUrl || ticket.cam1PhotoUrl, 1);
  const cam2Url = resolveCamUrl(ticket.secondCam2PhotoUrl || ticket.cam2PhotoUrl, 2);

  const isStationery = CONFIG.printMode === 'stationery';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Weighment Slip #${ticket.ticketNo}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 0mm;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 210mm; height: 297mm; max-width: 210mm; max-height: 297mm;
      margin: 0; padding: 0; overflow: hidden;
      background: #ffffff; color: #000000;
      font-family: Arial, 'Helvetica Neue', Helvetica, 'Segoe UI', sans-serif;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .sheet {
      position: absolute; top: 0; left: 0;
      width: 210mm; height: 150mm; max-width: 210mm; max-height: 150mm;
      overflow: hidden;
    }
    .val {
      position: absolute; display: flex; align-items: center; justify-content: center;
      text-align: center; font-family: Arial, sans-serif; font-weight: 800;
      color: #000000; line-height: 1; white-space: nowrap; letter-spacing: 0.3px;
    }
    .val-sans {
      position: absolute; display: flex; align-items: center; justify-content: center;
      text-align: center; font-family: Arial, sans-serif; font-weight: 800;
      color: #000000; line-height: 1; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.2px;
    }
    .cam-box {
      position: absolute; overflow: hidden; border-radius: 2px;
      display: flex; align-items: center; justify-content: center; background: #f5f5f5;
    }
    .cam-box img { width: 100%; height: 100%; object-fit: cover; }
    .cam-stamp {
      position: absolute; bottom: 2px; right: 4px;
      background: rgba(0,0,0,0.65); color: #ffffff;
      font-family: Arial, sans-serif; font-size: 8.5px; font-weight: 700;
      padding: 1px 4px; border-radius: 2px;
    }
  </style>
</head>
<body>
  <div class="sheet">
    ${!isStationery ? `
      <div style="position: absolute; inset: 3mm; border: 2px solid #dc2626; border-radius: 8px; pointer-events: none;">
        <div style="position: absolute; top: 2mm; left: 0; right: 0; text-align: center;">
          <h1 style="font-size: 23px; font-weight: 900; color: #b91c1c; font-family: Arial, sans-serif; text-transform: uppercase;">RVP WEIGH BRIDGE</h1>
          <div style="display: inline-block; background: #facc15; font-size: 9px; font-weight: 900; padding: 1px 10px; border-radius: 10px;">GOVT APPROVED</div>
          <p style="font-size: 9.5px; font-weight: 700; color: #27272a; margin-top: 2px;">3/86, New By-Pass Road, Near Rajuluru, BG Palli, PUNGANUR - 517 247, Chittoor Dist., A.P.</p>
          <p style="font-size: 9.5px; font-weight: 800; color: #18181b;">Ph : 91215 53909, 94909 21002</p>
        </div>
        <div style="position: absolute; top: 36mm; left: 2mm; width: 64mm; height: 8.5mm; border: 2px solid #f59e0b; border-radius: 6px; display: flex; align-items: center;">
          <div style="background: #fde047; color: #7f1d1d; font-size: 10px; font-weight: 900; padding: 0 8px; height: 100%; display: flex; align-items: center; border-right: 1px solid #f59e0b;">S. No.</div>
        </div>
        <div style="position: absolute; top: 36mm; left: 69mm; width: 60mm; height: 8.5mm; border: 2px solid #f59e0b; border-radius: 6px; display: flex; align-items: center;">
          <div style="background: #fde047; color: #7f1d1d; font-size: 10px; font-weight: 900; padding: 0 8px; height: 100%; display: flex; align-items: center; border-right: 1px solid #f59e0b;">DATE</div>
        </div>
        <div style="position: absolute; top: 36mm; left: 132mm; width: 63.5mm; height: 8.5mm; border: 2px solid #f59e0b; border-radius: 6px; display: flex; align-items: center;">
          <div style="background: #fde047; color: #7f1d1d; font-size: 10px; font-weight: 900; padding: 0 8px; height: 100%; display: flex; align-items: center; border-right: 1px solid #f59e0b;">TIME</div>
        </div>
        <div style="position: absolute; top: 46.5mm; left: 2mm; width: 95mm; height: 49mm; border: 2px solid #ef4444; border-radius: 8px;"></div>
        <div style="position: absolute; top: 46.5mm; left: 100.5mm; width: 95mm; height: 49mm; border: 2px solid #ef4444; border-radius: 8px;"></div>
        <div style="position: absolute; top: 97.5mm; left: 2mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">VEHICLE NO.</div>
        <div style="position: absolute; top: 97.5mm; left: 51mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">1ST WEIGHT</div>
        <div style="position: absolute; top: 97.5mm; left: 100mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">2ND WEIGHT</div>
        <div style="position: absolute; top: 97.5mm; left: 149mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">NET WEIGHT</div>
        <div style="position: absolute; top: 102mm; left: 2mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 102mm; left: 51mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 102mm; left: 100mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 102mm; left: 149mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 113.5mm; left: 2mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">PARTY NAME</div>
        <div style="position: absolute; top: 113.5mm; left: 51mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">MATERIAL</div>
        <div style="position: absolute; top: 113.5mm; left: 100mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">CHARGES</div>
        <div style="position: absolute; top: 113.5mm; left: 149mm; width: 46.5mm; height: 4.5mm; background: #dc2626; color: white; font-size: 8.5px; font-weight: bold; text-align: center; line-height: 4.5mm;">SIGNATURE</div>
        <div style="position: absolute; top: 118mm; left: 2mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 118mm; left: 51mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 118mm; left: 100mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 118mm; left: 149mm; width: 46.5mm; height: 9.5mm; border: 1px solid #ef4444; border-radius: 0 0 6px 6px;"></div>
        <div style="position: absolute; top: 130mm; left: 2mm; right: 2mm; display: flex; justify-content: space-between; font-size: 8.5px;">
          <div><span style="background: #b91c1c; color: white; font-weight: 900; padding: 2px 6px; font-size: 10px;">100 TON</span> <span style="font-size: 7.5px; color: #3f3f46; font-weight: 700;">Weigh Bridge Manufactured by : Sri Modern Weigh System. Cell 98430 55760</span></div>
          <div style="font-weight: 900; color: #b91c1c; font-size: 10px;">THANK YOU! VISIT AGAIN!!</div>
        </div>
      </div>
    ` : ''}

    <!-- Dynamic Values -->
    <div class="val" style="top: 43.5mm; left: 23mm; width: 45mm; height: 8mm; font-size: 16px;">${ticket.ticketNo}</div>
    <div class="val" style="top: 43.5mm; left: 89mm; width: 44mm; height: 8mm; font-size: 14px;">${formattedDate}</div>
    <div class="val" style="top: 43.5mm; left: 154mm; width: 48mm; height: 8mm; font-size: 14px;">${formattedTime}</div>

    <div class="cam-box" style="top: 53.5mm; left: 4mm; width: 96mm; height: 52mm;">
      ${cam1Url ? `<img src="${cam1Url}" alt="CAM 1" /><div class="cam-stamp">${formattedDate} ${formattedTime}</div>` : ''}
    </div>
    <div class="cam-box" style="top: 53.5mm; left: 106mm; width: 96mm; height: 52mm;">
      ${cam2Url ? `<img src="${cam2Url}" alt="CAM 2" /><div class="cam-stamp">${formattedDate} ${formattedTime}</div>` : ''}
    </div>

    <div class="val" style="top: 113.5mm; left: 4mm; width: 48mm; height: 7.5mm; font-size: 16px;">${ticket.vehicleNumber}</div>
    <div class="val" style="top: 113.5mm; left: 55mm; width: 48mm; height: 7.5mm; font-size: 16px;">${firstWeight != null ? formatWeight(firstWeight) : ''}</div>
    <div class="val" style="top: 113.5mm; left: 106mm; width: 48mm; height: 7.5mm; font-size: 16px;">${secondWeight != null ? formatWeight(secondWeight) : ''}</div>
    <div class="val" style="top: 113.5mm; left: 157mm; width: 48mm; height: 7.5mm; font-size: 16px;">${netWeight != null ? formatWeight(netWeight) : ''}</div>

    <div class="val-sans" style="top: 128.5mm; left: 4mm; width: 48mm; height: 7.5mm; font-size: 13px; padding: 0 2px;">${ticket.partyName || ''}</div>
    <div class="val-sans" style="top: 128.5mm; left: 55mm; width: 48mm; height: 7.5mm; font-size: 14px; padding: 0 2px;">${material}</div>
    <div class="val" style="top: 128.5mm; left: 106mm; width: 48mm; height: 7.5mm; font-size: 15px;">${charges}</div>
  </div>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────────────────
// Puppeteer Print Function
// ──────────────────────────────────────────────────────────────────────

let browser = null;

async function ensureBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }

  // 1. Try Playwright (included in repository dependencies)
  try {
    const pw = await import('playwright');
    browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    console.log('[PRINT-AGENT] Playwright Chromium launched for printing.');
    return browser;
  } catch {}

  // 2. Try Puppeteer (if installed)
  try {
    const puppeteer = (await import('puppeteer')).default;
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    console.log('[PRINT-AGENT] Puppeteer Chromium launched for printing.');
    return browser;
  } catch {}

  console.warn('[PRINT-AGENT] Headless browser not found. Falling back to HTML file generation.');
  return null;
}

async function printSlipHtml(html, ticketNo) {
  const b = await ensureBrowser();
  
  if (!b) {
    const tempFile = path.join(SCRIPT_DIR, `temp_slip_${ticketNo}.html`);
    fs.writeFileSync(tempFile, html, 'utf8');
    console.warn(`[PRINT-AGENT] Headless browser not found. Saved slip to ${tempFile}`);
    throw new Error('Headless browser unavailable for PDF generation');
  }

  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
    
    // Wait a brief moment for images/fonts to render
    await new Promise(r => setTimeout(r, 1500));
    
    // Render exact 210mm x 150mm PDF
    const pdfBuffer = await page.pdf({
      width: '210mm',
      height: '150mm',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });

    const pdfFile = path.join(SCRIPT_DIR, `temp_slip_${ticketNo}_${Date.now()}.pdf`);
    fs.writeFileSync(pdfFile, pdfBuffer);

    // Silent print directly to physical printer via SumatraPDF in pdf-to-printer
    const printOptions = {
      silent: true,
    };
    if (CONFIG.printerName) {
      printOptions.printer = CONFIG.printerName;
    }

    console.log(`[PRINT-AGENT] 🖨️  Sending Ticket #${ticketNo} directly to ${CONFIG.printerName || 'default printer'} (silent print)...`);
    await ptp.print(pdfFile, printOptions);
    console.log(`[PRINT-AGENT] ✅ Ticket #${ticketNo} successfully printed.`);

    // Cleanup temp file after 15 seconds
    setTimeout(() => {
      try { fs.unlinkSync(pdfFile); } catch {}
    }, 15000);
  } finally {
    await page.close();
  }
}

// Local HTTP Server for instant zero-latency print requests from local browser
const localServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/status' && req.method === 'GET') {
    let defaultPrinter = 'Unknown';
    try {
      const p = await ptp.getDefaultPrinter();
      defaultPrinter = p?.name || 'Default';
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', printer: defaultPrinter, configPrinter: CONFIG.printerName || null }));
    return;
  }

  if (req.url === '/print' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const ticket = payload.ticket;
        if (!ticket) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ticket is required' }));
          return;
        }
        console.log(`[PRINT-AGENT] Direct local print request for Ticket #${ticket.ticketNo}`);
        const html = payload.html || generateSlipHtml(ticket);
        await printSlipHtml(html, ticket.ticketNo);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ticketNo: ticket.ticketNo }));
      } catch (err) {
        console.error('[PRINT-AGENT] Direct local print failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

localServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[PRINT-AGENT] Port ${CONFIG.localPort} already in use. Another instance is already running.`);
    process.exit(0);
  } else {
    console.error('[PRINT-AGENT] Local server error:', err.message);
  }
});

localServer.listen(CONFIG.localPort, '127.0.0.1', () => {
  console.log(`[PRINT-AGENT] Local instant print server listening at http://127.0.0.1:${CONFIG.localPort}`);
});

// ──────────────────────────────────────────────────────────────────────
// Main Poll Loop
// ──────────────────────────────────────────────────────────────────────

let isProcessing = false;
let consecutiveErrors = 0;

async function pollAndPrint() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // 1. Fetch pending print jobs from cloud
    const { status, data } = await httpRequest('GET', `${CONFIG.cloudApiUrl}/weighbridge/print-queue/pending`);
    
    if (status !== 200 || !Array.isArray(data)) {
      throw new Error(`Unexpected response: HTTP ${status}`);
    }

    if (consecutiveErrors > 0) {
      console.log(`[PRINT-AGENT] Cloud connection restored after ${consecutiveErrors} errors.`);
    }
    consecutiveErrors = 0;

    if (data.length === 0) {
      // No pending jobs — normal idle
      isProcessing = false;
      return;
    }

    console.log(`[PRINT-AGENT] 📋 Found ${data.length} pending print job(s).`);

    // 2. Process each job
    for (const job of data) {
      const ticket = job.ticket;
      if (!ticket) {
        console.warn(`[PRINT-AGENT] Job ${job.id} has no ticket data. Marking as failed.`);
        await httpRequest('PATCH', `${CONFIG.cloudApiUrl}/weighbridge/print-queue/${job.id}/complete`, {
          status: 'FAILED',
          error: 'Ticket data not found',
        }).catch(() => {});
        continue;
      }

      console.log(`[PRINT-AGENT] 🖨️  Printing Ticket #${ticket.ticketNo} (${ticket.vehicleNumber})...`);

      try {
        const html = generateSlipHtml(ticket);
        await printSlipHtml(html, ticket.ticketNo);

        // Mark as completed
        await httpRequest('PATCH', `${CONFIG.cloudApiUrl}/weighbridge/print-queue/${job.id}/complete`, {
          status: 'COMPLETED',
        });
        console.log(`[PRINT-AGENT] ✅ Ticket #${ticket.ticketNo} printed and marked complete.`);
      } catch (printErr) {
        console.error(`[PRINT-AGENT] ❌ Failed to print Ticket #${ticket.ticketNo}:`, printErr.message);
        await httpRequest('PATCH', `${CONFIG.cloudApiUrl}/weighbridge/print-queue/${job.id}/complete`, {
          status: 'FAILED',
          error: printErr.message,
        }).catch(() => {});
      }
    }
  } catch (err) {
    consecutiveErrors++;
    if (consecutiveErrors === 1 || consecutiveErrors % 30 === 0) {
      console.warn(`[PRINT-AGENT] Cloud poll error (×${consecutiveErrors}):`, err.message);
    }
  } finally {
    isProcessing = false;
  }
}

// Start polling
console.log('[PRINT-AGENT] Starting print queue polling...');
setInterval(pollAndPrint, CONFIG.pollIntervalMs);
pollAndPrint(); // Initial poll

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[PRINT-AGENT] Shutting down...');
  if (browser) {
    try { await browser.close(); } catch {}
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  process.exit(0);
});
