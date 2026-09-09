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
 * Background Stream Manager that keeps the latest camera frame in memory
 */
class CameraFeedManager {
  private latestFrames: Record<1 | 2, Buffer | null> = { 1: null, 2: null };
  private activeReqs: Record<1 | 2, http.ClientRequest | null> = { 1: null, 2: null };
  private reconnectTimers: Record<1 | 2, NodeJS.Timeout | null> = { 1: null, 2: null };

  constructor() {
    this.startFeed(1);
    this.startFeed(2);
  }

  getLatestFrame(camNum: 1 | 2): Buffer | null {
    return this.latestFrames[camNum];
  }

  startFeed(camNum: 1 | 2) {
    if (this.reconnectTimers[camNum]) {
      clearTimeout(this.reconnectTimers[camNum]!);
      this.reconnectTimers[camNum] = null;
    }

    const cfg = CAMERAS[camNum];
    const uri = `/cgi-bin/mjpg/video.cgi?channel=${cfg.channel}&subtype=1`;

    // Step 1: Probe to obtain 401 challenge
    const challengeReq = http.get(
      { host: cfg.ip, port: cfg.port, path: uri, timeout: 4000 },
      (res) => {
        const challenge = (res.headers['www-authenticate'] as string) || null;
        if (!challenge) {
          logger.warn(`[cctv] Cam ${camNum} (${cfg.ip}) returned no challenge`);
          this.scheduleReconnect(camNum);
          return;
        }

        const parsed = parseDigestHeader(challenge);
        const realm = parsed.realm;
        const nonce = parsed.nonce;
        const nc = '00000001';
        const cnonce = crypto.randomBytes(8).toString('hex');
        const ha1 = md5(`${cfg.user}:${realm}:${cfg.pass}`);
        const ha2 = md5(`GET:${uri}`);
        const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
        const authHeader = `Digest username="${cfg.user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", qop="auth", nc=${nc}, cnonce="${cnonce}"`;

        let streamBuffer = Buffer.alloc(0);

        // Step 2: Open persistent MJPEG stream
        const streamReq = http.get(
          {
            host: cfg.ip,
            port: cfg.port,
            path: uri,
            headers: { Authorization: authHeader },
          },
          (streamRes) => {
            if (streamRes.statusCode !== 200) {
              logger.warn(`[cctv] Cam ${camNum} stream status: ${streamRes.statusCode}`);
              this.scheduleReconnect(camNum);
              return;
            }

            logger.info(`[cctv] Cam ${camNum} (${cfg.ip}) connected & streaming`);

            streamRes.on('data', (chunk: Buffer) => {
              streamBuffer = Buffer.concat([streamBuffer, chunk]);

              // JPEG standard markers: SOI (0xFF, 0xD8) and EOI (0xFF, 0xD9)
              let startIdx = streamBuffer.indexOf(Buffer.from([0xff, 0xd8]));
              let endIdx = streamBuffer.indexOf(Buffer.from([0xff, 0xd9]), startIdx + 2);

              while (startIdx !== -1 && endIdx !== -1) {
                const jpegFrame = streamBuffer.subarray(startIdx, endIdx + 2);
                this.latestFrames[camNum] = jpegFrame;

                streamBuffer = streamBuffer.subarray(endIdx + 2);
                startIdx = streamBuffer.indexOf(Buffer.from([0xff, 0xd8]));
                endIdx = streamBuffer.indexOf(Buffer.from([0xff, 0xd9]), startIdx + 2);
              }

              // Prevent buffer growth if markers are somehow missing
              if (streamBuffer.length > 2 * 1024 * 1024) {
                streamBuffer = Buffer.alloc(0);
              }
            });

            streamRes.on('end', () => {
              logger.warn(`[cctv] Cam ${camNum} stream ended by camera`);
              this.scheduleReconnect(camNum);
            });

            streamRes.on('error', (err) => {
              logger.error(`[cctv] Cam ${camNum} stream error:`, err);
              this.scheduleReconnect(camNum);
            });
          }
        );

        streamReq.on('error', (err) => {
          logger.error(`[cctv] Cam ${camNum} connection error:`, err);
          this.scheduleReconnect(camNum);
        });

        this.activeReqs[camNum] = streamReq;
      }
    );

    challengeReq.on('error', (err) => {
      logger.warn(`[cctv] Cam ${camNum} challenge error: ${err.message}`);
      this.scheduleReconnect(camNum);
    });

    challengeReq.on('timeout', () => {
      challengeReq.destroy();
      this.scheduleReconnect(camNum);
    });
  }

  scheduleReconnect(camNum: 1 | 2) {
    if (this.activeReqs[camNum]) {
      try {
        this.activeReqs[camNum]?.destroy();
      } catch {}
      this.activeReqs[camNum] = null;
    }

    if (!this.reconnectTimers[camNum]) {
      this.reconnectTimers[camNum] = setTimeout(() => {
        this.reconnectTimers[camNum] = null;
        this.startFeed(camNum);
      }, 3000);
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
  const manager = getFeedManager();
  const cached = manager.getLatestFrame(camNum);
  if (cached && cached.length > 1000) {
    return cached;
  }

  // If memory buffer hasn't received first frame yet, wait up to 1.5s
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const interval = setInterval(() => {
      const frame = manager.getLatestFrame(camNum);
      if (frame && frame.length > 1000) {
        clearInterval(interval);
        return resolve(frame);
      }
      if (Date.now() - started > 2500) {
        clearInterval(interval);
        reject(new Error(`Camera ${camNum} frame not yet available`));
      }
    }, 50);
  });
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
