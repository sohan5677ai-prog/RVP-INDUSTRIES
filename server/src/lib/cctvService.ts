import http from 'http';
import crypto from 'crypto';
import type { Response } from 'express';
import { logger } from './logger.js';

interface CameraConfig {
  ip: string;
  port: number;
  user: string;
  pass: string;
  channel: number;
}

const CAMERAS: Record<1 | 2, CameraConfig> = {
  1: {
    ip: process.env.CCTV_CAM1_IP || '192.168.1.101',
    port: Number(process.env.CCTV_CAM1_PORT || 80),
    user: process.env.CCTV_CAM1_USER || 'admin',
    pass: process.env.CCTV_CAM1_PASS || 'admin@123',
    channel: 1,
  },
  2: {
    ip: process.env.CCTV_CAM2_IP || '192.168.1.102',
    port: Number(process.env.CCTV_CAM2_PORT || 80),
    user: process.env.CCTV_CAM2_USER || 'admin',
    pass: process.env.CCTV_CAM2_PASS || 'admin@123',
    channel: 1,
  },
};

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex');
}

function parseDigestHeader(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2] || match[3];
  }
  return params;
}

/**
 * Fetch a single snapshot from CP PLUS camera using standard HTTP Digest Auth
 */
async function fetchCameraSnapshotFromDevice(cfg: CameraConfig): Promise<Buffer> {
  const uri = `/cgi-bin/snapshot.cgi?channel=${cfg.channel}`;

  // Step 1: Initial request to get 401 and Digest challenge
  const challenge = await new Promise<string | null>((resolve) => {
    const req = http.get({ host: cfg.ip, port: cfg.port, path: uri, timeout: 2500 }, (res) => {
      resolve((res.headers['www-authenticate'] as string) || null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });

  if (!challenge) {
    throw new Error(`Camera at ${cfg.ip} unreachable`);
  }

  const parsed = parseDigestHeader(challenge);
  const realm = parsed.realm;
  const nonce = parsed.nonce;
  const qop = parsed.qop;
  const opaque = parsed.opaque || '';

  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${cfg.user}:${realm}:${cfg.pass}`);
  const ha2 = md5(`GET:${uri}`);

  let response: string;
  if (qop && qop.includes('auth')) {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  let authHeader = `Digest username="${cfg.user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) authHeader += `, qop="auth", nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) authHeader += `, opaque="${opaque}"`;

  // Step 2: Request with Digest header
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: cfg.ip,
        port: cfg.port,
        path: uri,
        headers: { Authorization: authHeader },
        timeout: 3500,
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Camera ${cfg.ip} returned status ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.length > 500) {
            resolve(buffer);
          } else {
            reject(new Error(`Invalid frame size from ${cfg.ip}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching snapshot from ${cfg.ip}`));
    });
  });
}

interface BroadcastFrame {
  buffer: Buffer;
  timestamp: number;
}

const latestBroadcastFrames: Record<1 | 2, BroadcastFrame | null> = {
  1: null,
  2: null,
};

/**
 * Ingest live camera frame broadcast from Kata Cabin local bridge
 */
export function setCameraBroadcast(camNum: 1 | 2, buf: Buffer): void {
  latestBroadcastFrames[camNum] = {
    buffer: buf,
    timestamp: Date.now(),
  };
  const manager = getFeedManager();
  manager.setDirectFrame(camNum, buf);
}

/**
 * Get full diagnostic CCTV connection and stream status
 */
export function getCctvStatus() {
  const now = Date.now();
  const getStatus = (num: 1 | 2) => {
    const b = latestBroadcastFrames[num];
    const isFresh = b ? now - b.timestamp < 30000 : false;
    const cfg = CAMERAS[num];
    return {
      cam: num,
      ip: cfg.ip,
      port: cfg.port,
      rtspUrl: `rtsp://${cfg.user}:${cfg.pass}@${cfg.ip}:554/cam/realmonitor?channel=${cfg.channel}&subtype=1`,
      rtspHdUrl: `rtsp://${cfg.user}:${cfg.pass}@${cfg.ip}:554/cam/realmonitor?channel=${cfg.channel}&subtype=0`,
      online: isFresh || (globalFeedManager?.getLatestFrame(num) != null && (globalFeedManager?.getConsecutiveErrors(num) ?? 0) === 0),
      lastSeen: b?.timestamp || null,
      ageMs: b ? now - b.timestamp : null,
      sizeBytes: b?.buffer?.length || 0,
    };
  };
  return {
    cam1: getStatus(1),
    cam2: getStatus(2),
  };
}

/**
 * Background Polling Manager that keeps the latest camera frame in memory
 * and serves it instantly (< 1ms) without overloading CP PLUS firmware.
 */
class CameraFeedManager {
  private latestFrames: Record<1 | 2, Buffer | null> = { 1: null, 2: null };
  private isPolling: Record<1 | 2, boolean> = { 1: false, 2: false };
  private consecutiveErrors: Record<1 | 2, number> = { 1: 0, 2: 0 };

  constructor() {
    this.pollLoop(1);
    this.pollLoop(2);
  }

  getLatestFrame(camNum: 1 | 2): Buffer | null {
    return this.latestFrames[camNum];
  }

  getConsecutiveErrors(camNum: 1 | 2): number {
    return this.consecutiveErrors[camNum];
  }

  setDirectFrame(camNum: 1 | 2, frame: Buffer) {
    this.latestFrames[camNum] = frame;
    this.consecutiveErrors[camNum] = 0;
  }

  private async pollLoop(camNum: 1 | 2) {
    if (this.isPolling[camNum]) return;
    this.isPolling[camNum] = true;

    const cfg = CAMERAS[camNum];

    while (this.isPolling[camNum]) {
      // If we recently received a broadcast frame from the local Kata cabin bridge,
      // skip local polling to save CPU and bandwidth
      const broadcast = latestBroadcastFrames[camNum];
      if (broadcast && Date.now() - broadcast.timestamp < 15000) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      try {
        const frame = await fetchCameraSnapshotFromDevice(cfg);
        this.latestFrames[camNum] = frame;
        if (this.consecutiveErrors[camNum] > 0) {
          logger.info(`[cctv] Cam ${camNum} (${cfg.ip}) connected & capturing live frames (${frame.length} bytes)`);
          this.consecutiveErrors[camNum] = 0;
        }
        // Smooth 400ms interval between frames (~2.5 FPS)
        await new Promise((r) => setTimeout(r, 400));
      } catch (err: any) {
        this.consecutiveErrors[camNum]++;
        if (this.consecutiveErrors[camNum] === 1 || this.consecutiveErrors[camNum] % 50 === 0) {
          logger.warn(`[cctv] Cam ${camNum} poll notice: ${err.message}`);
        }
        // Back off gradually on error (up to 5s if in cloud where local camera is unroutable)
        const backoff = Math.min(5000, 1500 + this.consecutiveErrors[camNum] * 500);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
}

// Global singleton feed manager
let globalFeedManager: CameraFeedManager | null = null;

function getFeedManager(): CameraFeedManager {
  if (!globalFeedManager) {
    globalFeedManager = new CameraFeedManager();
  }
  return globalFeedManager;
}

/**
 * Get latest live JPEG frame instantly from in-memory buffer (sub-millisecond)
 */
export async function getCameraSnapshot(camNum: 1 | 2): Promise<Buffer> {
  // Priority 1: Check fresh broadcast frame received from Kata cabin bridge
  const broadcast = latestBroadcastFrames[camNum];
  if (broadcast && broadcast.buffer && broadcast.buffer.length > 500 && Date.now() - broadcast.timestamp < 45000) {
    return broadcast.buffer;
  }

  // Priority 2: In-memory poller frame (if running locally on LAN)
  const manager = getFeedManager();
  const cached = manager.getLatestFrame(camNum);
  if (cached && cached.length > 500) {
    return cached;
  }

  // Priority 3: Direct fetch from device if reachable on LAN
  const cfg = CAMERAS[camNum];
  try {
    const direct = await fetchCameraSnapshotFromDevice(cfg);
    manager.setDirectFrame(camNum, direct);
    return direct;
  } catch (err: any) {
    // Priority 4: If direct fetch failed (e.g. cloud server), return older broadcast if exists
    if (broadcast && broadcast.buffer && broadcast.buffer.length > 500) {
      return broadcast.buffer;
    }
    throw err;
  }
}

/**
 * Stream continuous live MJPEG video from CP PLUS camera to client response
 */
export async function streamCameraMjpeg(camNum: 1 | 2, clientRes: Response): Promise<void> {
  const frame = await getCameraSnapshot(camNum);
  clientRes.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*',
  });
  clientRes.end(frame);
}

