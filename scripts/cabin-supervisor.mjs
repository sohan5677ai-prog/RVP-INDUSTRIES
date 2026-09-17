#!/usr/bin/env node
/**
 * RVP Industries - Kata Cabin Permanent Services Supervisor
 * 
 * Automatically starts, monitors, and restarts:
 * 1) cctv-bridge.mjs (Dual CCTV camera RTSP streams and cloud relay)
 * 2) cabin-print-agent.mjs (Silent weighment slip auto-printing)
 * 
 * If either worker crashes, network drops, or the PC sleeps and wakes,
 * the supervisor revives it immediately (<2s).
 * Also performs health checks on http://127.0.0.1:4000/api/weighbridge/cctv/status.
 */

import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import util from 'util';
import net from 'net';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const LOG_DIR = path.resolve(ROOT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'cabin-supervisor.log');
const SUPERVISOR_PORT = 4005; // Lock port to ensure only 1 supervisor runs

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(level, ...args) {
  const msg = `${new Date().toISOString()} [${level.toUpperCase()}] [SUPERVISOR] ${util.format(...args)}\n`;
  try {
    process.stdout.write(msg);
    fs.appendFileSync(LOG_FILE, msg, 'utf8');
  } catch {}
}

process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection:', reason?.message || reason);
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-Instance Lock
// ─────────────────────────────────────────────────────────────────────────────
const lockServer = net.createServer();
lockServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('warn', `Supervisor is already running on port ${SUPERVISOR_PORT}. Exiting duplicate instance.`);
    process.exit(0);
  } else {
    log('error', 'Lock server error:', err.message);
  }
});
lockServer.listen(SUPERVISOR_PORT, '127.0.0.1', () => {
  log('log', `Single-instance lock acquired on 127.0.0.1:${SUPERVISOR_PORT}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Managed Services Definitions
// ─────────────────────────────────────────────────────────────────────────────
const services = {
  cctv: {
    name: 'CCTV Bridge',
    script: path.join(SCRIPT_DIR, 'cctv-bridge.mjs'),
    proc: null,
    restartTimer: null,
    restartCount: 0,
    lastStarted: 0,
    healthConsecutiveFailures: 0,
    enabled: true,
  },
  printer: {
    name: 'Cabin Print Agent',
    script: path.join(SCRIPT_DIR, 'cabin-print-agent.mjs'),
    proc: null,
    restartTimer: null,
    restartCount: 0,
    lastStarted: 0,
    healthConsecutiveFailures: 0,
    enabled: true,
  },
};

let isShuttingDown = false;

function startService(key) {
  if (isShuttingDown) return;
  const svc = services[key];
  if (!svc || !svc.enabled) return;

  if (svc.restartTimer) {
    clearTimeout(svc.restartTimer);
    svc.restartTimer = null;
  }

  // Kill existing if still hanging
  if (svc.proc) {
    try { svc.proc.kill('SIGKILL'); } catch {}
    svc.proc = null;
  }

  svc.lastStarted = Date.now();
  log('log', `Starting ${svc.name} (${path.basename(svc.script)})...`);

  const child = spawn(process.execPath, [svc.script], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });

  svc.proc = child;

  child.on('exit', (code, signal) => {
    svc.proc = null;
    if (isShuttingDown) return;

    svc.restartCount += 1;
    const uptimeSec = Math.round((Date.now() - svc.lastStarted) / 1000);
    log('warn', `${svc.name} exited (code: ${code}, signal: ${signal}) after ${uptimeSec}s uptime. Total restarts: ${svc.restartCount}`);

    // The print agent deliberately exits with code 0 when another healthy
    // instance already owns port 4001. Do not create an endless restart loop;
    // the periodic health check below will start a replacement if that owner
    // later disappears.
    if (key === 'printer' && code === 0) {
      log('log', 'An existing Cabin Print Agent owns port 4001; monitoring that instance.');
      return;
    }

    // Restart in 2 seconds
    svc.restartTimer = setTimeout(() => {
      startService(key);
    }, 2000);
  });

  child.on('error', (err) => {
    log('error', `${svc.name} process error: ${err.message}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Health Check Routine (Checks CCTV Bridge status every 15s)
// ─────────────────────────────────────────────────────────────────────────────
setInterval(() => {
  if (isShuttingDown) return;
  const cctv = services.cctv;
  if (!cctv.proc) return;

  // Only check health after the process has had at least 10s to start up
  if (Date.now() - cctv.lastStarted < 10000) return;

  const req = http.get('http://127.0.0.1:4000/api/weighbridge/cctv/status', { timeout: 5000 }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        cctv.healthConsecutiveFailures = 0;
      } else {
        cctv.healthConsecutiveFailures += 1;
        log('warn', `CCTV health check returned HTTP ${res.statusCode} (failures: ${cctv.healthConsecutiveFailures})`);
      }
    });
  });

  req.on('error', (err) => {
    cctv.healthConsecutiveFailures += 1;
    if (cctv.healthConsecutiveFailures >= 3) {
      log('warn', `CCTV Bridge unresponsive on http://127.0.0.1:4000 (${err.message}). Restarting...`);
      cctv.healthConsecutiveFailures = 0;
      startService('cctv');
    }
  });

  req.on('timeout', () => {
    req.destroy();
    cctv.healthConsecutiveFailures += 1;
    if (cctv.healthConsecutiveFailures >= 3) {
      log('warn', `CCTV Bridge health check timed out 3 times. Restarting...`);
      cctv.healthConsecutiveFailures = 0;
      startService('cctv');
    }
  });

  // Also check Cabin Print Agent health on port 4001
  const printer = services.printer;
  if (Date.now() - printer.lastStarted >= 10000) {
    const reqPrint = http.get('http://127.0.0.1:4001/status', { timeout: 5000 }, (res) => {
      let pData = '';
      res.on('data', (c) => { pData += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          printer.healthConsecutiveFailures = 0;
        } else {
          printer.healthConsecutiveFailures += 1;
        }
      });
    });

    reqPrint.on('error', (err) => {
      printer.healthConsecutiveFailures += 1;
      if (printer.healthConsecutiveFailures >= 3) {
        log('warn', `Cabin Print Agent unresponsive on http://127.0.0.1:4001 (${err.message}). Restarting...`);
        printer.healthConsecutiveFailures = 0;
        startService('printer');
      }
    });

    reqPrint.on('timeout', () => {
      reqPrint.destroy();
      printer.healthConsecutiveFailures += 1;
      if (printer.healthConsecutiveFailures >= 3) {
        log('warn', `Cabin Print Agent health check timed out 3 times. Restarting...`);
        printer.healthConsecutiveFailures = 0;
        startService('printer');
      }
    });
  }
}, 15000);

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────
function shutdown(sig) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('log', `Received ${sig}. Terminating child processes...`);

  for (const key of Object.keys(services)) {
    const svc = services[key];
    if (svc.restartTimer) clearTimeout(svc.restartTimer);
    if (svc.proc) {
      try { svc.proc.kill('SIGTERM'); } catch {}
    }
  }

  try { lockServer.close(); } catch {}
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log('log', '================================================================');
log('log', '  RVP Industries - Kata Cabin Permanent Services Supervisor    ');
log('log', '  Auto-monitors and recovers CCTV Bridge and Print Agent        ');
log('log', '================================================================');

// Start all services
startService('cctv');
startService('printer');
