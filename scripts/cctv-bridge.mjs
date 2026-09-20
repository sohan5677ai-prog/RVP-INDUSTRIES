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
import path from 'path';
import util from 'util';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(SCRIPT_DIR, '../logs');
const LOG_FILE = path.join(LOG_DIR, 'cctv-bridge.log');
const LOCAL_CONFIG_FILE = process.env.CCTV_BRIDGE_CONFIG || path.join(SCRIPT_DIR, 'cctv-bridge.config.json');

fs.mkdirSync(LOG_DIR, { recursive: true });
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.previous`);
  }
} catch {}

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

// Global safety guards so network drops or closed sockets never terminate this process
process.on('uncaughtException', (err) => {
  console.error('[CCTV-BRIDGE] Uncaught exception (prevented crash):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CCTV-BRIDGE] Unhandled rejection (prevented crash):', reason?.message || reason);
});

function loadLocalConfig() {
  if (!fs.existsSync(LOCAL_CONFIG_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8'));
    console.log(`[CCTV-BRIDGE] Loaded local configuration: ${LOCAL_CONFIG_FILE}`);
    return parsed;
  } catch (err) {
    console.error(`[CCTV-BRIDGE] Cannot read ${LOCAL_CONFIG_FILE}: ${err.message}`);
    return {};
  }
}

const LOCAL_CONFIG = loadLocalConfig();
const setting = (name, fallback = '') => process.env[name] || LOCAL_CONFIG[name] || fallback;

function getDefaultBridgeKey() {
  const secret = process.env.JWT_SECRET || 'e4e783e85d137a23b282370d8dc67fd2a002425843a69ab32200fc5173040508';
  return crypto.createHmac('sha256', secret).update('rvp-cctv-bridge-v1').digest('hex');
}

const CONFIG = {
  cloudApiUrl: setting('CLOUD_API_URL', 'https://rvp-server.onrender.com/api').replace(/\/+$/, ''),
  localPort: Number(setting('BRIDGE_LOCAL_PORT', 4004)),
  // One fresh frame per second is enough for a remote operating console and
  // avoids piling up uploads while Render is waking or the internet is slow.
  cloudBroadcastIntervalMs: Number(setting('CCTV_CLOUD_FRAME_INTERVAL_MS', 1000)),
  bridgeKey: setting('CCTV_BRIDGE_KEY') || getDefaultBridgeKey(),
  cameras: {
    1: {
      label: 'CAM 1: ENTRY',
      ip: setting('CCTV_CAM1_IP', '192.168.1.101'),
      port: 80,
      user: setting('CCTV_CAM1_USER', 'admin'),
      pass: setting('CCTV_CAM1_PASS', 'admin@123'),
      channel: 1,
      rtspUrl: setting('CCTV_CAM1_RTSP', 'rtsp://admin:admin%40123@192.168.1.101:554/cam/realmonitor?channel=1&subtype=1'),
      rtspHdUrl: setting('CCTV_CAM1_RTSP_HD', 'rtsp://admin:admin%40123@192.168.1.101:554/cam/realmonitor?channel=1&subtype=0'),
    },
    2: {
      label: 'CAM 2: EXIT',
      ip: setting('CCTV_CAM2_IP', '192.168.1.102'),
      port: 80,
      user: setting('CCTV_CAM2_USER', 'admin'),
      pass: setting('CCTV_CAM2_PASS', 'admin@123'),
      channel: 1,
      rtspUrl: setting('CCTV_CAM2_RTSP', 'rtsp://admin:admin%40123@192.168.1.102:554/cam/realmonitor?channel=1&subtype=1'),
      rtspHdUrl: setting('CCTV_CAM2_RTSP_HD', 'rtsp://admin:admin%40123@192.168.1.102:554/cam/realmonitor?channel=1&subtype=0'),
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

const cloudUpload = {
  1: { inFlight: false, lastAttemptAt: 0, lastSuccessAt: 0, lastErrorAt: 0, lastError: null, consecutiveErrors: 0 },
  2: { inFlight: false, lastAttemptAt: 0, lastSuccessAt: 0, lastErrorAt: 0, lastError: null, consecutiveErrors: 0 },
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

// Reusable Keep-Alive Agents for ultra-low latency & connection persistence
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  keepAliveMsecs: 15000,
  timeout: 8000,
});
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 6,
  keepAliveMsecs: 15000,
  timeout: 8000,
});

function dispatchToSubscribers(camNum, frame) {
  const subs = streamSubscribers[camNum];
  if (subs.size > 0) {
    const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
    const footer = `\r\n`;
    for (const res of Array.from(subs)) {
      try {
        if (!res.writableEnded && !res.destroyed && res.writable) {
          res.write(header);
          res.write(frame);
          res.write(footer);
        } else {
          subs.delete(res);
        }
      } catch {
        subs.delete(res);
      }
    }
  }
}

/**
 * High-Performance Persistent RTSP Worker using FFmpeg image2pipe
 * Streams JPEGs in real-time (~25 FPS, <50ms latency)
 */
function startRtspWorker(camNum, useHd = false) {
  const cfg = CONFIG.cameras[camNum];
  if (!foundFfmpeg) {
    console.log(`[CCTV-BRIDGE] FFmpeg not found, falling back to HTTP Digest for Cam ${camNum}`);
    startHttpPollingFallback(camNum);
    return;
  }

  const streamUrl = useHd ? cfg.rtspHdUrl : cfg.rtspUrl;
  const streamType = useHd ? 'Main-Stream (subtype=0)' : 'Sub-Stream (subtype=1)';
  console.log(`[CCTV-BRIDGE] Launching RTSP worker for Cam ${camNum} (${cfg.label}) using ${streamType}...`);

  const args = [
    '-rtsp_transport', 'tcp',
    '-probesize', '65536',          // Fast probe to prevent FFmpeg hanging 5-10s
    '-analyzeduration', '1000000',  // 1s max analysis
    '-stimeout', '5000000',         // 5s RTSP socket timeout
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', streamUrl,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '5',
    '-r', '15',                    // Limit to 15 FPS to avoid CPU overload
    '-an',
    'pipe:1'
  ];

  const proc = spawn(foundFfmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  let framesThisSec = 0;
  let lastFpsLog = Date.now();
  let lastFrameTime = Date.now();
  let hasReceivedAnyFrames = false;
  let stderrBuffer = '';

  proc.stderr.on('data', (d) => {
    stderrBuffer = (stderrBuffer + d.toString()).slice(-800);
  });

  // Watchdog: 12 seconds grace for initial handshake/I-frame, 6 seconds once streaming
  const watchdog = setInterval(() => {
    const timeoutMs = hasReceivedAnyFrames ? 6000 : 12000;
    if (Date.now() - lastFrameTime > timeoutMs) {
      console.warn(`[CCTV-BRIDGE] Cam ${camNum} RTSP watchdog: No frames for ${timeoutMs / 1000}s. Restarting worker...`);
      if (stderrBuffer) {
        console.warn(`[CCTV-BRIDGE] Cam ${camNum} FFmpeg last log:\n${stderrBuffer.trim()}`);
      }
      clearInterval(watchdog);
      try { proc.kill('SIGKILL'); } catch {}
    }
  }, 2000);

  proc.stdout.on('data', (chunk) => {
    lastFrameTime = Date.now();
    hasReceivedAnyFrames = true;
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
      dispatchToSubscribers(camNum, frame);
    }

    if (Date.now() - lastFpsLog >= 10000) {
      const fps = (framesThisSec / 10).toFixed(1);
      console.log(`[CCTV-BRIDGE] Cam ${camNum} (${cfg.label}): Live streaming at ${fps} FPS (ultra-low latency)`);
      framesThisSec = 0;
      lastFpsLog = Date.now();
    }
  });

  proc.on('close', (code) => {
    clearInterval(watchdog);
    console.warn(`[CCTV-BRIDGE] RTSP worker for Cam ${camNum} stopped (exit code: ${code}).`);
    if (!hasReceivedAnyFrames && !useHd) {
      console.warn(`[CCTV-BRIDGE] Sub-stream failed for Cam ${camNum}. Trying Main-stream (subtype=0) in 2s...`);
      setTimeout(() => startRtspWorker(camNum, true), 2000);
    } else {
      setTimeout(() => startRtspWorker(camNum, false), 2000);
    }
  });

  proc.on('error', (err) => {
    clearInterval(watchdog);
    console.error(`[CCTV-BRIDGE] Cam ${camNum} worker error: ${err.message}. Retrying...`);
  });
}

// Safety net: if RTSP ever stalls or drops (>2s), HTTP Digest immediately fills the gap
setInterval(async () => {
  for (const num of [1, 2]) {
    const frame = latestFrames[num];
    if (!frame || !frame.buffer || Date.now() - frame.timestamp > 2000) {
      try {
        const buf = await captureViaHttpDigest(CONFIG.cameras[num]);
        if (buf && buf.length > 500) {
          latestFrames[num] = {
            buffer: buf,
            timestamp: Date.now(),
            method: 'HTTP-DIGEST-BACKUP',
            count: (latestFrames[num]?.count || 0) + 1,
          };
          dispatchToSubscribers(num, buf);
        }
      } catch {}
    }
  }
}, 1000);

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
  if (!CONFIG.bridgeKey || CONFIG.bridgeKey.length < 24) {
    throw new Error('CCTV_BRIDGE_KEY is missing or too short');
  }
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
        agent: isHttps ? httpsAgent : httpAgent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-CCTV-Bridge-Key': CONFIG.bridgeKey,
          'Connection': 'keep-alive',
        },
        timeout: 6000,
      },
      (res) => {
        res.on('error', (err) => {
          reject(err);
        });
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          reject(new Error(`Broadcast HTTP ${res.statusCode}`));
        }
      }
    );

    req.on('error', (err) => {
      reject(err);
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
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
    const upload = cloudUpload[num];
    if (frame && frame.buffer && Date.now() - frame.timestamp < 3000 && !upload.inFlight) {
      upload.inFlight = true;
      upload.lastAttemptAt = Date.now();
      broadcastToCloud(num, frame.buffer)
        .then(() => {
          upload.lastSuccessAt = Date.now();
          upload.lastError = null;
          upload.consecutiveErrors = 0;
        })
        .catch((err) => {
          upload.lastError = err.message;
          upload.consecutiveErrors += 1;
          // Log at most once every 30s: a temporary network outage must not
          // fill the terminal's log or hide the useful RTSP diagnostics.
          if (Date.now() - upload.lastErrorAt > 30000) {
            upload.lastErrorAt = Date.now();
            console.warn(`[CCTV-BRIDGE] Cloud relay Cam ${num}: ${err.message}`);
          }
        })
        .finally(() => {
          upload.inFlight = false;
        });
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
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
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
        try {
          res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buffer.length}\r\n\r\n`);
          res.write(frame.buffer);
          res.write('\r\n');
        } catch {
          // ignore initial write errors
        }
      }

      streamSubscribers[camNum].add(res);
      res.on('error', () => {
        streamSubscribers[camNum].delete(res);
      });
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
            cloudRelayOnline: Date.now() - cloudUpload[1].lastSuccessAt < 10000,
            cloudRelayConfigured: CONFIG.bridgeKey.length >= 24,
            cloudRelayLastAttempt: cloudUpload[1].lastAttemptAt || null,
            cloudRelayLastSuccess: cloudUpload[1].lastSuccessAt || null,
            cloudRelayError: cloudUpload[1].lastError,
          },
          cam2: {
            online: Date.now() - latestFrames[2].timestamp < 8000,
            lastSeen: latestFrames[2].timestamp || null,
            sizeBytes: latestFrames[2].buffer?.length || 0,
            method: latestFrames[2].method,
            ip: CONFIG.cameras[2].ip,
            cloudRelayOnline: Date.now() - cloudUpload[2].lastSuccessAt < 10000,
            cloudRelayConfigured: CONFIG.bridgeKey.length >= 24,
            cloudRelayLastAttempt: cloudUpload[2].lastAttemptAt || null,
            cloudRelayLastSuccess: cloudUpload[2].lastSuccessAt || null,
            cloudRelayError: cloudUpload[2].lastError,
          },
        })
      );
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('RVP CCTV Bridge Running');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[CCTV-BRIDGE] Local port ${CONFIG.localPort} already in use by an active bridge instance. Exiting duplicate process.`);
      process.exit(0);
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
console.log(`  CAM 1: ${CONFIG.cameras[1].ip} -> RTSP configured`);
console.log(`  CAM 2: ${CONFIG.cameras[2].ip} -> RTSP configured`);
console.log(`  Local Endpoint: http://127.0.0.1:${CONFIG.localPort}/api/weighbridge/cctv/snapshot?cam=1`);
console.log(`  Cloud Relay: ${CONFIG.cloudApiUrl}`);
console.log(`  Cloud Relay Key: ${CONFIG.bridgeKey.length >= 24 ? 'configured' : 'MISSING / TOO SHORT'}`);
console.log(`  FFmpeg engine: ${foundFfmpeg || 'NOT FOUND'}`);
console.log(`  Log file: ${LOG_FILE}`);
console.log('================================================================');

if (CONFIG.bridgeKey.length < 24) {
  console.error('[CCTV-BRIDGE] REMOTE SNAPSHOTS ARE DISABLED: configure CCTV_BRIDGE_KEY in scripts/cctv-bridge.config.json or as a Windows environment variable, then restart this bridge.');
}

startLocalServer();
startRtspWorker(1);
startRtspWorker(2);
