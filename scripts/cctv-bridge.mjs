#!/usr/bin/env node
/**
 * RVP Industries - Kata Cabin CCTV Dual-Camera Bridge Daemon
 * 
 * Bridges local CP PLUS CCTV cameras (IP/RTSP on 192.168.1.101 & 192.168.1.102)
 * to both:
 * 1) Local zero-latency HTTP stream on http://127.0.0.1:4000
 * 2) Cloud ERP on Render (https://rvp-server.onrender.com) so all screens anywhere see live cameras!
 */

import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';

const CONFIG = {
  cloudApiUrl: process.env.CLOUD_API_URL || 'https://rvp-server.onrender.com/api',
  localPort: Number(process.env.BRIDGE_LOCAL_PORT || 4000),
  pollIntervalMs: 800, // ~1.2 FPS per camera (optimal balance of smoothness & network efficiency)
  cameras: {
    1: {
      label: 'CAM 1: ENTRY',
      ip: process.env.CCTV_CAM1_IP || '192.168.1.101',
      port: 80,
      user: process.env.CCTV_CAM1_USER || 'admin',
      pass: process.env.CCTV_CAM1_PASS || 'admin@123',
      channel: 1,
      rtspUrl: process.env.CCTV_CAM1_RTSP || 'rtsp://admin:admin@123@192.168.1.101:554/cam/realmonitor?channel=1&subtype=1',
    },
    2: {
      label: 'CAM 2: EXIT',
      ip: process.env.CCTV_CAM2_IP || '192.168.1.102',
      port: 80,
      user: process.env.CCTV_CAM2_USER || 'admin',
      pass: process.env.CCTV_CAM2_PASS || 'admin@123',
      channel: 1,
      rtspUrl: process.env.CCTV_CAM2_RTSP || 'rtsp://admin:admin@123@192.168.1.102:554/cam/realmonitor?channel=1&subtype=1',
    },
  },
};

// Locate ffmpeg if available
const FFMPEG_CANDIDATES = [
  'C:\\Program Files (x86)\\T.O.P\\FFmpeg\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  'ffmpeg',
];
let foundFfmpeg = null;
for (const cand of FFMPEG_CANDIDATES) {
  if (cand === 'ffmpeg') {
    foundFfmpeg = cand;
    break;
  }
  if (fs.existsSync(cand)) {
    foundFfmpeg = cand;
    break;
  }
}

// In-memory latest frames
const latestFrames = {
  1: { buffer: null, timestamp: 0, method: null },
  2: { buffer: null, timestamp: 0, method: null },
};

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function parseDigestHeader(header) {
  const params = {};
  const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2] || match[3];
  }
  return params;
}

/**
 * Capture frame using CP PLUS native HTTP Digest snapshot
 */
async function captureViaHttpDigest(cfg) {
  const uri = `/cgi-bin/snapshot.cgi?channel=${cfg.channel}`;

  // Step 1: Probe to obtain 401 challenge
  const challenge = await new Promise((resolve) => {
    const req = http.get({ host: cfg.ip, port: cfg.port, path: uri, timeout: 2000 }, (res) => {
      resolve(res.headers['www-authenticate'] || null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });

  if (!challenge) {
    throw new Error(`Device at ${cfg.ip} unreachable`);
  }

  const parsed = parseDigestHeader(challenge);
  const realm = parsed.realm;
  const nonce = parsed.nonce;
  const qop = parsed.qop;
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${cfg.user}:${realm}:${cfg.pass}`);
  const ha2 = md5(`GET:${uri}`);

  let response;
  if (qop && qop.includes('auth')) {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  let authHeader = `Digest username="${cfg.user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) authHeader += `, qop="auth", nc=${nc}, cnonce="${cnonce}"`;

  // Step 2: Fetch authenticated JPEG
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: cfg.ip,
        port: cfg.port,
        path: uri,
        headers: { Authorization: authHeader },
        timeout: 3000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length > 500) resolve(buf);
          else reject(new Error('Invalid image payload'));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Capture frame using FFmpeg RTSP stream
 */
async function captureViaFfmpeg(rtspUrl) {
  if (!foundFfmpeg) throw new Error('FFmpeg not found');

  return new Promise((resolve, reject) => {
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-f', 'image2',
      'pipe:1',
    ];

    const proc = spawn(foundFfmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];

    proc.stdout.on('data', (c) => chunks.push(c));

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('FFmpeg RTSP timeout'));
    }, 4000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length > 500) {
        resolve(buf);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Grab single frame using primary (HTTP Digest) or secondary (FFmpeg RTSP)
 */
async function captureCameraFrame(camNum) {
  const cfg = CONFIG.cameras[camNum];
  try {
    const buf = await captureViaHttpDigest(cfg);
    return { buffer: buf, method: 'HTTP-DIGEST' };
  } catch (httpErr) {
    try {
      const buf = await captureViaFfmpeg(cfg.rtspUrl);
      return { buffer: buf, method: 'RTSP-FFMPEG' };
    } catch (rtspErr) {
      throw new Error(`Both methods failed: HTTP (${httpErr.message}) / RTSP (${rtspErr.message})`);
    }
  }
}

/**
 * Push captured JPEG frame to cloud server broadcast endpoint
 */
async function broadcastToCloud(camNum, buffer) {
  const cloudUrl = `${CONFIG.cloudApiUrl}/weighbridge/cctv/broadcast`;
  const base64 = buffer.toString('base64');
  const payload = JSON.stringify({ cam: camNum, image: base64 });

  return new Promise((resolve, reject) => {
    const isHttps = cloudUrl.startsWith('https:');
    const lib = isHttps ? https : http;
    const urlObj = new URL(cloudUrl);

    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 4000,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(true);
          } else {
            reject(new Error(`Broadcast failed with status ${res.statusCode}: ${body.slice(0, 100)}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Broadcast timeout'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Continuous polling loop for a camera
 */
async function startCameraLoop(camNum) {
  const cfg = CONFIG.cameras[camNum];
  let consecutiveErrors = 0;
  let lastLoggedSuccess = 0;

  while (true) {
    try {
      const result = await captureCameraFrame(camNum);
      latestFrames[camNum] = {
        buffer: result.buffer,
        timestamp: Date.now(),
        method: result.method,
      };

      // Push to cloud asynchronously
      broadcastToCloud(camNum, result.buffer).catch((err) => {
        // Cloud broadcast dropped (e.g. cloud sleeping or network glitch)
      });

      if (Date.now() - lastLoggedSuccess > 10000 || consecutiveErrors > 0) {
        console.log(`[CCTV-BRIDGE] Cam ${camNum} (${cfg.label}): Live (${(result.buffer.length / 1024).toFixed(1)} KB via ${result.method})`);
        lastLoggedSuccess = Date.now();
      }
      consecutiveErrors = 0;

      await new Promise((r) => setTimeout(r, CONFIG.pollIntervalMs));
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
        console.warn(`[CCTV-BRIDGE] Cam ${camNum} (${cfg.label}) warning: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/**
 * Start embedded local HTTP server
 */
function startLocalServer() {
  const server = http.createServer((req, res) => {
    // Enable CORS for web browsers & Vercel
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${CONFIG.localPort}`);

    if (url.pathname === '/api/weighbridge/cctv/snapshot') {
      const camNum = url.searchParams.get('cam') === '2' ? 2 : 1;
      const frame = latestFrames[camNum];

      if (frame && frame.buffer) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Content-Length': frame.buffer.length,
          'X-Frame-Timestamp': String(frame.timestamp),
          'X-Frame-Method': frame.method || 'UNKNOWN',
        });
        return res.end(frame.buffer);
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Camera ${camNum} not yet ready` }));
      }
    }

    if (url.pathname === '/api/weighbridge/cctv/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          cam1: {
            online: Date.now() - latestFrames[1].timestamp < 10000,
            lastSeen: latestFrames[1].timestamp || null,
            sizeBytes: latestFrames[1].buffer?.length || 0,
            method: latestFrames[1].method,
            ip: CONFIG.cameras[1].ip,
            rtsp: CONFIG.cameras[1].rtspUrl,
          },
          cam2: {
            online: Date.now() - latestFrames[2].timestamp < 10000,
            lastSeen: latestFrames[2].timestamp || null,
            sizeBytes: latestFrames[2].buffer?.length || 0,
            method: latestFrames[2].method,
            ip: CONFIG.cameras[2].ip,
            rtsp: CONFIG.cameras[2].rtspUrl,
          },
        })
      );
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('RVP CCTV Bridge Running');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[CCTV-BRIDGE] Local port ${CONFIG.localPort} in use (possibly main server running). Bridge continues in background broadcast mode.`);
    } else {
      console.error('[CCTV-BRIDGE] Local server error:', err.message);
    }
  });

  server.listen(CONFIG.localPort, '0.0.0.0', () => {
    console.log(`[CCTV-BRIDGE] Local HTTP snapshot server listening on http://127.0.0.1:${CONFIG.localPort}`);
  });
}

console.log('====================================================');
console.log('  RVP Industries - Kata Cabin CCTV Bridge Daemon    ');
console.log(`  CAM 1: ${CONFIG.cameras[1].ip} (${CONFIG.cameras[1].label})`);
console.log(`  CAM 2: ${CONFIG.cameras[2].ip} (${CONFIG.cameras[2].label})`);
console.log(`  Cloud Relay: ${CONFIG.cloudApiUrl}`);
console.log(`  FFmpeg engine: ${foundFfmpeg || 'NOT FOUND (using HTTP digest)'}`);
console.log('====================================================');

startLocalServer();
startCameraLoop(1);
startCameraLoop(2);
