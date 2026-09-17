#!/usr/bin/env node
/**
 * RVP Industries - Kata Cabin Printer Diagnostic & Verification Tool
 */

import { execFile } from 'child_process';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(SCRIPT_DIR, 'cctv-bridge.config.json');

let config = {
  CLOUD_API_URL: 'https://rvp-server.onrender.com/api',
  CABIN_PRINTER_NAME: 'Canon LBP2900',
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    config = { ...config, ...JSON.parse(raw) };
  } catch {}
}

const targetPrinter = config.CABIN_PRINTER_NAME || 'Canon LBP2900';

function runPowerShell(command) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 10000 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
        });
      }
    );
  });
}

function checkCloudQueue() {
  return new Promise((resolve) => {
    const url = `${config.CLOUD_API_URL}/weighbridge/print-queue/status`;
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(body) });
        } catch {
          resolve({ ok: false, data: null });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
  });
}

async function main() {
  console.log('================================================================');
  console.log('  RVP Industries - Kata Cabin Printer Diagnostic Tool           ');
  console.log('================================================================');
  console.log(`Hostname     : ${os.hostname()}`);
  console.log(`Platform     : ${os.platform()} (${os.arch()})`);
  console.log(`Target Model : ${targetPrinter}`);
  console.log(`Cloud API    : ${config.CLOUD_API_URL}`);
  console.log('----------------------------------------------------------------\n');

  // Step 1: Check Windows Print Spooler Service
  console.log('1. Checking Windows Print Spooler service...');
  const spoolerRes = await runPowerShell('(Get-Service -Name Spooler).Status');
  const spoolerRunning = spoolerRes.stdout.toLowerCase() === 'running';
  if (spoolerRunning) {
    console.log('   [OK] Print Spooler service is RUNNING.');
  } else {
    console.log(`   [FAIL] Print Spooler service status: ${spoolerRes.stdout || 'STOPPED'}.`);
    console.log('   Fix: Run PowerShell as Admin: Start-Service -Name Spooler');
  }

  // Step 2: List Installed Printers
  console.log('\n2. Inspecting Installed Printers in Windows...');
  const listPrintersRes = await runPowerShell(
    'Get-Printer | Select-Object Name, PortName, DriverName, PrinterStatus, WorkOffline | ConvertTo-Json -Compress'
  );
  let printers = [];
  try {
    const parsed = JSON.parse(listPrintersRes.stdout || '[]');
    printers = Array.isArray(parsed) ? parsed : [parsed];
  } catch {}

  const foundPrinter = printers.find(p => p.Name.toLowerCase() === targetPrinter.toLowerCase());
  if (foundPrinter) {
    console.log(`   [OK] Found configured printer "${foundPrinter.Name}"`);
    console.log(`      - Port       : ${foundPrinter.PortName}`);
    console.log(`      - Driver     : ${foundPrinter.DriverName}`);
    console.log(`      - Status     : ${foundPrinter.PrinterStatus}`);
    console.log(`      - Offline    : ${foundPrinter.WorkOffline}`);
  } else {
    console.log(`   [FAIL] Configured printer "${targetPrinter}" is NOT installed on this PC!`);
    console.log('   Installed printers on this machine:');
    printers.forEach(p => console.log(`      - "${p.Name}" (Port: ${p.PortName})`));
  }

  // Step 3: Check USB Physical Hardware Connection
  console.log('\n3. Checking Physical USB Hardware Connection...');
  const isUsbPort = foundPrinter ? String(foundPrinter.PortName).toUpperCase().startsWith('USB') : true;
  let usbHardwareConnected = false;

  if (isUsbPort) {
    const usbHwRes = await runPowerShell(
      '@(Get-PnpDevice -Class Printer -PresentOnly -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.FriendlyName -like "*Canon*" -or $_.FriendlyName -like "*LBP*" -or $_.InstanceId -like "*USBPRINT*" }).Count'
    );
    const count = parseInt(usbHwRes.stdout, 10) || 0;
    usbHardwareConnected = count > 0;

    if (usbHardwareConnected) {
      console.log(`   [OK] Canon LBP2900 USB hardware DETECTED (${count} active PnP device).`);
    } else {
      console.log('   [FAIL] No active USB printer hardware detected in Windows!');
      console.log('   Possible causes:');
      console.log('      a) The printer power switch is OFF.');
      console.log('      b) The USB cable is unplugged or loose.');
      console.log('      c) The USB cable is plugged into a different computer.');
    }
  } else {
    console.log(`   Printer uses port ${foundPrinter?.PortName || 'unknown'} (not USB).`);
  }

  // Step 4: Check Print Jobs in Windows Spooler
  console.log('\n4. Checking Windows Print Queue for stuck jobs...');
  const queueRes = await runPowerShell(
    `Get-PrintJob -PrinterName "${targetPrinter}" -ErrorAction SilentlyContinue | ` +
    `Select-Object Id, DocumentName, JobStatus | ConvertTo-Json -Compress`
  );
  let jobs = [];
  try {
    const parsed = JSON.parse(queueRes.stdout || '[]');
    jobs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {}

  const badJobs = jobs.filter(j => /error|offline|paperout|blocked/i.test(String(j.JobStatus || '')));
  if (badJobs.length > 0) {
    console.log(`   [WARN] Found ${badJobs.length} stuck/errored job(s) blocking the queue:`);
    badJobs.forEach(j => console.log(`      - Job #${j.Id} "${j.DocumentName}": ${j.JobStatus}`));
    console.log('   Purging stuck jobs now...');
    await runPowerShell(
      `Get-PrintJob -PrinterName "${targetPrinter}" -ErrorAction SilentlyContinue | ` +
      `Where-Object { [string]$_.JobStatus -match "Error|Offline|PaperOut|Blocked" } | Remove-PrintJob -ErrorAction SilentlyContinue`
    );
    console.log('   [OK] Stuck jobs cleared.');
  } else if (jobs.length > 0) {
    console.log(`   [INFO] ${jobs.length} normal job(s) currently in queue.`);
  } else {
    console.log('   [OK] Windows print queue is clean (0 stuck jobs).');
  }

  // Step 5: Check Cloud Queue
  console.log('\n5. Checking Cloud Server Print Queue...');
  const cloud = await checkCloudQueue();
  if (cloud.ok && cloud.data) {
    console.log(`   [OK] Cloud API reachable.`);
    console.log(`      - Pending jobs   : ${cloud.data.pendingCount}`);
    console.log(`      - Agent online   : ${cloud.data.agentOnline}`);
    console.log(`      - Printer ready  : ${cloud.data.printerReady}`);
    console.log(`      - Reported error : ${cloud.data.printerError || 'None'}`);
  } else {
    console.log(`   [WARN] Could not query cloud queue: ${cloud.error || 'HTTP error'}`);
  }

  // Step 6: Summary & Next Actions
  console.log('\n================================================================');
  console.log('  DIAGNOSTIC SUMMARY & RECOMMENDATIONS                          ');
  console.log('================================================================');

  const ready = spoolerRunning && Boolean(foundPrinter) && (!isUsbPort || usbHardwareConnected) && badJobs.length === 0;

  if (ready) {
    console.log('SUCCESS: All checks passed! The printer is ready for silent printing.');
    console.log('\nTo start automatic silent printing permanently:');
    console.log('Run: node scripts/cabin-supervisor.mjs');
    console.log('(or double-click scripts/start-cabin-services.cmd)');
  } else {
    console.log('PRINTER IS NOT READY FOR SILENT PRINTING.');
    if (!foundPrinter) {
      console.log('ACTION: Install the Canon LBP2900 driver on this PC.');
    } else if (isUsbPort && !usbHardwareConnected) {
      console.log('ACTION: Turn ON the Canon LBP2900 power switch and plug the USB cable firmly into this PC.');
    } else if (!spoolerRunning) {
      console.log('ACTION: Start the Windows Spooler service (Start-Service Spooler).');
    }
  }
  console.log('\nDone.\n');
}

main().catch(console.error);
