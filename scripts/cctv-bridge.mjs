#!/usr/bin/env node
/**
 * RVP Industries - Kata Cabin CCTV Dual-Camera Bridge Daemon
 * 
 * Bridges local CP PLUS CCTV cameras (IP/RTSP on 192.168.1.101 & 192.168.1.102)
 * using high-performance persistent RTSP FFmpeg pipes for ultra-low latency (<100ms).
 * 
 * Features:
 * 1) Continuous zero-latency RTSP streaming via FFmpeg image2pipe
 * 2) Local HTTP snapshot endpoint: http://127.0.0.1:4000/api/weighbridge/cctv/snapshot?cam=1
 * 3) Local MJPEG live stream endpoint: http://127.0.0.1:4000/api/weighbridge/cctv/stream?cam=1
 * 4) Automatic cloud relay to Render ERP (https://rvp-server.onrender.com)
 */

import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';

const CONFIG = {
  cloudApiUrl: process.env.CLOUD_API_URL || 'https://rvp-server.onrender.com/api',
  localPort: Number(process.env.BRIDGE_LOCAL_PORT || 4000),
  cloudBroadcastIntervalMs: 600, // broadcast to cloud every 600ms
  cameras: {
    1: {
      label: 'CAM 1: ENTRY',
      ip: process.env.CCTV_CAM1_IP || '192.168.1.101',
      port: 80,
      user: process.env.CCTV_CAM1_USER || 'admin',
      pass: process.env.CCTV_CAM1_PASS || 'admin@123',
      channel: 1,
      rtspUrl: process.env.CCTV_CAM1_RTSP || 'rtsp://admin:admin%40123@192.168.1.101:554/cam/realmonitor?channel=1&subtype=1',
      rtspHdUrl: process.env.CCTV_CAM1_RTSP_HD || 'rtsp://admin:admin%40123@192.168.1.101:554/cam/realmonitor?channel=1&subtype=0',
    },
    2: {
      label: 'CAM 2: EXIT',
      ip: process.env.CCTV_CAM2_IP || '192.168.1.102',
      port: 80,
      user: process.env.CCTV_CAM2_USER || 'admin',
      pass: process.env.CCTV_CAM2_PASS || 'admin@123',
      channel: 1,
      rtspUrl: process.env.CCTV_CAM2_RTSP || 'rtsp://admin:admin%40123@192.168.1.102:554/cam/realmonitor?channel=1&subtype=1',
      rtspHdUrl: process.env.CCTV_CAM2_RTSP_HD || 'rtsp://admin:admin%40123@192.168.1.102:554/cam/realmonitor?channel=1&subtype=0',
    },
  },
};

// Locate FFmpeg
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

// In-memory latest frames and active MJPEG listeners
const latestFrames = {
  1: { buffer: null, timestamp: 0, method: null, count: 0 },
  2: { buffer: null, timestamp: 0, method: null, count: 0 },
};

const streamSubscribers = {
  1: new Set(),
  2: new Set(),
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
 * Fallback: Capture frame using CP PLUS HTTP Digest snapshot
 */
async function captureViaHttpDigest(cfg) {
  const uri = `/cgi-bin/snapshot.cgi?channel=${cfg.channel}`;
  const challenge = await new Promise((resolve) => {
    const req = http.get({ host: cfg.ip, port: cfg.port, path: uri, timeout: 1500 }, (res) => {
      resolve(res.headers['www-authenticate'] || null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });

  if (!challenge) throw new Error(`Device at ${cfg.ip} unreachable`);

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

  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: cfg.ip,
        port: cfg.port,
        path: uri,
        headers: { Authorization: authHeader },
        timeout: 2500,
      },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
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
 * High-Performance Persistent RTSP Worker using FFmpeg image2pipe
 * Streams JPEGs in real-time (~10 FPS, <100ms latency)
 */
function startRtspWorker(camNum) {
  const cfg = CONFIG.cameras[camNum];
  if (!foundFfmpeg) {
    console.log(`[CCTV-BRIDGE] FFmpeg not found, falling back to HTTP Digest for Cam ${camNum}`);
    startHttpPollingFallback(camNum);
    return;
  }

  console.log(`[CCTV-BRIDGE] Launching low-latency RTSP stream worker for Cam ${camNum} (${cfg.label})...`);

  const args = [
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', cfg.rtspUrl,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '5',
    '-an',
    'pipe:1'
  ];

  const proc = spawn(foundFfmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let buffer = Buffer.alloc(0);
  let framesThisSec = 0;
  let lastFpsLog = Date.now();

  proc.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Parse JPEG frames (Starts 0xFF 0xD8, Ends 0xFF 0xD9)
    while (true) {
      const startIndex = buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (startIndex === -1) {
        buffer = Buffer.alloc(0);
        break;
      }
      const endIndex = buffer.indexOf(Buffer.from([0xff, 0xd9]), startIndex + 2);
      if (endIndex === -1) {
        if (startIndex > 0) buffer = buffer.subarray(startIndex);
        break;
      }
      const frame = buffer.subarray(startIndex, endIndex + 2);
      buffer = buffer.subarray(endIndex + 2);

      latestFrames[camNum] = {
        buffer: frame,
        timestamp: Date.now(),
        method: 'RTSP-LIVE',
        count: latestFrames[camNum].count + 1,
      };

      framesThisSec++;

      // Dispatch to active MJPEG stream subscribers
      const subs = streamSubscribers[camNum];
      if (subs.size > 0) {
        const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
        const footer = `\r\n`;
        for (const res of subs) {
          try {
            res.write(header);
            res.write(frame);
            res.write(footer);
          } catch {
            subs.delete(res);
          }
        }
      }
    }

    if (Date.now() - lastFpsLog >= 10000) {
      const fps = (framesThisSec / 10).toFixed(1);
      console.log(`[CCTV-BRIDGE] Cam ${camNum} (${cfg.label}): Live streaming at ${fps} FPS (ultra-low latency)`);
      framesThisSec = 0;
      lastFpsLog = Date.now();
    }
  });

  proc.on('close', (code) => {
    console.warn(`[CCTV-BRIDGE] RTSP worker for Cam ${camNum} stopped (exit code: ${code}). Reconnecting in 2.5s...`);
    setTimeout(() => startRtspWorker(camNum), 2500);
  });

  proc.on('error', (err) => {
    console.error(`[CCTV-BRIDGE] Cam ${camNum} worker error: ${err.message}. Retrying...`);
  });
}

/**
 * Fallback polling if FFmpeg is not available
 */
async function startHttpPollingFallback(camNum) {
  const cfg = CONFIG.cameras[camNum];
  while (true) {
    try {
      const buf = await captureViaHttpDigest(cfg);
      latestFrames[camNum] = {
        buffer: buf,
        timestamp: Date.now(),
        method: 'HTTP-DIGEST',
        count: latestFrames[camNum].count + 1,
      };
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

/**
 * Push latest frame to cloud server broadcast endpoint
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
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          reject(new Error(`Broadcast HTTP ${res.statusCode}`));
        }
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Cloud upload timer (pushes to Render cloud every 600ms)
 */
setInterval(() => {
  for (const num of [1, 2]) {
    const frame = latestFrames[num];
    if (frame && frame.buffer && Date.now() - frame.timestamp < 3000) {
      broadcastToCloud(num, frame.buffer).catch(() => {});
    }
  }
}, CONFIG.cloudBroadcastIntervalMs);

/**
 * Start embedded local HTTP server
 */
function startLocalServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${CONFIG.localPort}`);

    // 1. Instant Single Snapshot (Serves from RAM in <1ms)
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
        return res.end(JSON.stringify({ error: `Camera ${camNum} not ready yet` }));
      }
    }

    // 2. Continuous Native MJPEG Live Stream
    if (url.pathname === '/api/weighbridge/cctv/stream') {
      const camNum = url.searchParams.get('cam') === '2' ? 2 : 1;
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=--frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'close',
        'Pragma': 'no-cache',
      });

      const frame = latestFrames[camNum];
      if (frame && frame.buffer) {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buffer.length}\r\n\r\n`);
        res.write(frame.buffer);
        res.write('\r\n');
      }

      streamSubscribers[camNum].add(res);
      req.on('close', () => {
        streamSubscribers[camNum].delete(res);
      });
      return;
    }

    // 3. Status & Diagnostic API
    if (url.pathname === '/api/weighbridge/cctv/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          cam1: {
            online: Date.now() - latestFrames[1].timestamp < 8000,
            lastSeen: latestFrames[1].timestamp || null,
            sizeBytes: latestFrames[1].buffer?.length || 0,
            method: latestFrames[1].method,
            ip: CONFIG.cameras[1].ip,
            rtsp: CONFIG.cameras[1].rtspUrl,
            rtspHd: CONFIG.cameras[1].rtspHdUrl,
          },
          cam2: {
            online: Date.now() - latestFrames[2].timestamp < 8000,
            lastSeen: latestFrames[2].timestamp || null,
            sizeBytes: latestFrames[2].buffer?.length || 0,
            method: latestFrames[2].method,
            ip: CONFIG.cameras[2].ip,
            rtsp: CONFIG.cameras[2].rtspUrl,
            rtspHd: CONFIG.cameras[2].rtspHdUrl,
          },
        })
      );
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('RVP CCTV Bridge Running');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[CCTV-BRIDGE] Local port ${CONFIG.localPort} in use. Continuing RTSP capture & background broadcast.`);
    } else {
      console.error('[CCTV-BRIDGE] Local server error:', err.message);
    }
  });

  server.listen(CONFIG.localPort, '0.0.0.0', () => {
    console.log(`[CCTV-BRIDGE] Local HTTP snapshot server listening on http://127.0.0.1:${CONFIG.localPort}`);
  });
}

console.log('================================================================');
console.log('  RVP Industries - Kata Cabin CCTV Dual RTSP Stream Bridge      ');
console.log(`  CAM 1: ${CONFIG.cameras[1].ip} -> ${CONFIG.cameras[1].rtspUrl}`);
console.log(`  CAM 2: ${CONFIG.cameras[2].ip} -> ${CONFIG.cameras[2].rtspUrl}`);
console.log(`  Local Endpoint: http://127.0.0.1:${CONFIG.localPort}/api/weighbridge/cctv/snapshot?cam=1`);
console.log(`  Cloud Relay: ${CONFIG.cloudApiUrl}`);
console.log(`  FFmpeg engine: ${foundFfmpeg || 'NOT FOUND'}`);
console.log('================================================================');

startLocalServer();
startRtspWorker(1);
startRtspWorker(2);
