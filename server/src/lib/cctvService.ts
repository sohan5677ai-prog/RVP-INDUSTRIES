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

function buildDigestAuthHeader(
  username: string,
  realm: string,
  password: string,
  uri: string,
  method: string,
  nonce: string,
  qop?: string,
  opaque?: string
): string {
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  let response: string;
  if (qop && qop.includes('auth')) {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) authHeader += `, qop="auth", nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) authHeader += `, opaque="${opaque}"`;
  return authHeader;
}

/**
 * Fetch a single high-resolution JPEG snapshot from CP PLUS camera
 */
export async function getCameraSnapshot(camNum: 1 | 2): Promise<Buffer> {
  const cfg = CAMERAS[camNum];
  const uri = `/cgi-bin/snapshot.cgi?channel=${cfg.channel}`;

  // Step 1: Probe to get 401 challenge
  const challenge = await new Promise<string | null>((resolve) => {
    const req = http.get(
      { host: cfg.ip, port: cfg.port, path: uri, timeout: 3500 },
      (res) => {
        resolve((res.headers['www-authenticate'] as string) || null);
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });

  if (!challenge) {
    throw new Error(`Camera ${camNum} (${cfg.ip}) unreachable`);
  }

  const parsed = parseDigestHeader(challenge);
  const authHeader = buildDigestAuthHeader(
    cfg.user,
    parsed.realm,
    cfg.pass,
    uri,
    'GET',
    parsed.nonce,
    parsed.qop,
    parsed.opaque
  );

  // Step 2: Request image with Digest Authorization
  return new Promise<Buffer>((resolve, reject) => {
    const req = http.get(
      {
        host: cfg.ip,
        port: cfg.port,
        path: uri,
        headers: { Authorization: authHeader },
        timeout: 4000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Camera ${camNum} returned HTTP ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Camera ${camNum} snapshot timeout`));
    });
  });
}

/**
 * Stream continuous live MJPEG video from CP PLUS camera to client response
 */
export async function streamCameraMjpeg(camNum: 1 | 2, clientRes: Response): Promise<void> {
  const cfg = CAMERAS[camNum];
  const uri = `/cgi-bin/mjpg/video.cgi?channel=${cfg.channel}&subtype=1`;

  // Step 1: Challenge
  const challenge = await new Promise<string | null>((resolve) => {
    const req = http.get(
      { host: cfg.ip, port: cfg.port, path: uri, timeout: 3500 },
      (res) => {
        resolve((res.headers['www-authenticate'] as string) || null);
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });

  if (!challenge) {
    clientRes.status(502).send(`Camera ${camNum} at ${cfg.ip} unreachable`);
    return;
  }

  const parsed = parseDigestHeader(challenge);
  const authHeader = buildDigestAuthHeader(
    cfg.user,
    parsed.realm,
    cfg.pass,
    uri,
    'GET',
    parsed.nonce,
    parsed.qop,
    parsed.opaque
  );

  // Step 2: Open live stream
  const camReq = http.get(
    {
      host: cfg.ip,
      port: cfg.port,
      path: uri,
      headers: { Authorization: authHeader },
    },
    (camRes) => {
      if (camRes.statusCode !== 200) {
        clientRes.status(502).send(`Camera stream returned status ${camRes.statusCode}`);
        return;
      }

      clientRes.writeHead(200, {
        'Content-Type': camRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=myboundary',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Connection': 'close',
      });

      camRes.pipe(clientRes);

      clientRes.on('close', () => {
        camReq.destroy();
      });
    }
  );

  camReq.on('error', (err) => {
    logger.error(`[cctv] Cam ${camNum} stream error:`, err);
    if (!clientRes.headersSent) {
      clientRes.status(502).send(`Camera stream error: ${err.message}`);
    }
  });
}
