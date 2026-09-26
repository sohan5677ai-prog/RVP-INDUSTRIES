import { SerialPort } from 'serialport';
import { logger } from './logger.js';
import type { Response } from 'express';

export interface ScaleReading {
  liveWeight: number;
  isStable: boolean;
  rawText: string;
  lastUpdated: number;
  isConnected: boolean;
  port: string;
  baudRate: number;
  error?: string | null;
  availablePorts?: Array<{ path: string; manufacturer?: string; friendlyName?: string }>;
  /** True when a DLC/hardware fault was detected recently but the scale has since recovered */
  recentFault?: boolean;
  /** Human-readable label for the recent fault (e.g. 'NO DLC') */
  recentFaultLabel?: string | null;
  /** Timestamp (ms) of the last DLC/hardware fault detection */
  lastFaultTime?: number | null;
}

type ScaleListener = (reading: ScaleReading) => void;

/** How long (ms) after a DLC/hardware fault clears before we stop showing the warning */
const DLC_COOLDOWN_MS = 30_000;

class ServerScaleService {
  private localEnabled = process.env.SCALE_LOCAL_ENABLED?.toLowerCase() !== 'false';
  private connectionFailureReported = false;
  private portName: string = process.env.SCALE_COM_PORT || 'COM4';
  private baudRate: number = Number(process.env.SCALE_BAUD_RATE || 2400);
  private serialPort: SerialPort | null = null;
  private isConnecting: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private listeners: Set<ScaleListener> = new Set();

  private currentReading: ScaleReading = {
    liveWeight: 0,
    isStable: false,
    rawText: '',
    lastUpdated: Date.now(),
    isConnected: false,
    port: process.env.SCALE_COM_PORT || 'COM4',
    baudRate: Number(process.env.SCALE_BAUD_RATE || 2400),
    error: null,
    availablePorts: [],
    recentFault: false,
    recentFaultLabel: null,
    lastFaultTime: null,
  };

  private buffer: string = '';
  private recentWeights: number[] = [];
  private lastFaultTime: number = 0;
  private lastFaultLabel: string = '';

  constructor() {
    if (!this.localEnabled) {
      logger.info('[scale] Local serial access disabled; waiting for terminal readings.');
    }
    this.start();
  }

  public getReading(): ScaleReading {
    return { ...this.currentReading };
  }

  public getPortName(): string {
    return this.portName;
  }

  public getBaudRate(): number {
    return this.baudRate;
  }

  public subscribe(listener: ScaleListener): () => void {
    this.listeners.add(listener);
    // Immediately emit latest cached reading
    listener(this.getReading());
    return () => this.listeners.delete(listener);
  }

  public async setConfig(port: string, baudRate?: number): Promise<boolean> {
    this.connectionFailureReported = false;
    logger.info(`[scale] Switching config to port=${port}, baud=${baudRate || this.baudRate}`);
    this.portName = port;
    if (baudRate) this.baudRate = baudRate;
    this.currentReading.port = this.portName;
    this.currentReading.baudRate = this.baudRate;

    if (this.serialPort && this.serialPort.isOpen) {
      await new Promise<void>((r) => this.serialPort?.close(() => r()));
    }
    this.start();
    return true;
  }

  public async listPorts() {
    return await SerialPort.list();
  }

  private remoteWatchdogTimer: NodeJS.Timeout | null = null;
  private isRemoteActive: boolean = false;

  public updateClientReading(reading: {
    liveWeight: number;
    isStable: boolean;
    rawText?: string;
    port?: string;
    baudRate?: number;
    error?: string | null;
  }) {
    this.isRemoteActive = true;
    if (this.remoteWatchdogTimer) {
      clearTimeout(this.remoteWatchdogTimer);
    }
    // If no remote packet for 6 seconds and local serialPort isn't open, mark disconnected
    this.remoteWatchdogTimer = setTimeout(() => {
      this.isRemoteActive = false;
      this.remoteWatchdogTimer = null;
      if (!this.serialPort || !this.serialPort.isOpen) {
        this.currentReading.isConnected = false;
        this.currentReading.error = 'Remote scale stream timed out (Terminal offline)';
        this.notifyListeners();
      }
    }, 6000);

    const raw = reading.rawText || '';
    const upperRaw = raw.toUpperCase();
    let err = reading.error || null;
    if (
      !err &&
      (upperRaw.includes('DLC') ||
        upperRaw.includes('DLS') ||
        upperRaw.includes('NO DL') ||
        upperRaw.includes('NODL') ||
        upperRaw.includes('?'))
    ) {
      err =
        upperRaw.includes('DLS') && !upperRaw.includes('DLC')
          ? 'NO DLS (Load Cell Signal Lost)'
          : 'NO DLC (Load Cell Signal Lost)';
    }

    // Track fault timestamp for DLC cooldown
    if (err) {
      this.lastFaultTime = Date.now();
      this.lastFaultLabel = upperRaw.includes('DLS') && !upperRaw.includes('DLC') ? 'NO DLS' : 'NO DLC';
    }

    const weight = Math.round(Number(reading.liveWeight) || 0);
    const now = Date.now();
    const withinCooldown = !err && this.lastFaultTime > 0 && (now - this.lastFaultTime) < DLC_COOLDOWN_MS;

    this.currentReading = {
      ...this.currentReading,
      liveWeight: err ? 0 : weight,
      isStable: err ? false : !!reading.isStable,
      rawText: raw || `${weight} kg`,
      lastUpdated: now,
      isConnected: true,
      port: reading.port || this.portName,
      baudRate: reading.baudRate || this.baudRate,
      error: err,
      recentFault: !!err || withinCooldown,
      recentFaultLabel: err ? this.lastFaultLabel : (withinCooldown ? this.lastFaultLabel : null),
      lastFaultTime: this.lastFaultTime || null,
    };

    this.notifyListeners();
  }

  public reportClientDisconnect(err?: string) {
    if (this.remoteWatchdogTimer) {
      clearTimeout(this.remoteWatchdogTimer);
      this.remoteWatchdogTimer = null;
    }
    this.isRemoteActive = false;
    if (!this.serialPort || !this.serialPort.isOpen) {
      this.currentReading.isConnected = false;
      this.currentReading.error = err || 'Scale disconnected from terminal';
      this.notifyListeners();
    }
  }

  public start() {
    if (!this.localEnabled) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      if (this.serialPort && this.serialPort.isOpen) {
        this.serialPort.close();
      }

      logger.debug(`[scale] Attempting connection to ${this.portName} at ${this.baudRate} 8N1...`);
      const port = new SerialPort({
        path: this.portName,
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });

      port.open(async (err) => {
        this.isConnecting = false;
        if (err) {
          this.reportConnectionFailure(err.message);
          if (!this.isRemoteActive) {
            this.currentReading.isConnected = false;
            this.currentReading.error = `Could not open ${this.portName}: ${err.message}`;
          }
          
          try {
            const ports = await SerialPort.list();
            this.currentReading.availablePorts = ports.map((p: any) => ({
              path: p.path,
              manufacturer: p.manufacturer,
              friendlyName: p.friendlyName || p.path,
            }));
          } catch {}

          if (!this.isRemoteActive) {
            this.notifyListeners();
          }
          this.scheduleReconnect(5000);
          return;
        }

        logger.info(`[scale] Successfully opened ${this.portName}! Streaming live weight in background.`);
        this.connectionFailureReported = false;
        this.serialPort = port;
        this.currentReading.isConnected = true;
        this.currentReading.error = null;
        this.notifyListeners();

        port.on('data', (chunk: Buffer) => {
          this.handleDataChunk(chunk.toString('ascii'));
        });

        port.on('error', (portErr) => {
          logger.warn(`[scale] Port ${this.portName} error: ${portErr.message}`);
          if (!this.isRemoteActive) {
            this.currentReading.isConnected = false;
            this.currentReading.error = portErr.message;
            this.notifyListeners();
          }
          this.scheduleReconnect(4000);
        });

        port.on('close', () => {
          logger.info(`[scale] Port ${this.portName} closed.`);
          if (!this.isRemoteActive) {
            this.currentReading.isConnected = false;
            this.notifyListeners();
          }
          this.scheduleReconnect(4000);
        });
      });
    } catch (e: any) {
      this.isConnecting = false;
      this.reportConnectionFailure(e.message);
      if (!this.isRemoteActive) {
        this.currentReading.isConnected = false;
        this.currentReading.error = e.message;
        this.notifyListeners();
      }
      this.scheduleReconnect(5000);
    }
  }

  private reportConnectionFailure(message: string) {
    if (this.connectionFailureReported || this.isRemoteActive) return;
    this.connectionFailureReported = true;
    logger.warn(`[scale] Could not connect to ${this.portName}: ${message}. Retrying every 5 seconds; repeated attempts are logged at debug level. For terminal-only/cloud servers, set SCALE_LOCAL_ENABLED=false.`);
  }

  private scheduleReconnect(delayMs: number = 3000) {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delayMs);
  }

  private handleDataChunk(str: string) {
    this.buffer += str;

    // Check for delimiter (\r, \n, or \x03 ETX)
    let idx: number;
    while ((idx = this.buffer.search(/[\r\n\x03]/)) !== -1) {
      const line = this.buffer.substring(0, idx).trim();
      this.buffer = this.buffer.substring(idx + 1);

      if (line.length > 0) {
        this.parseScaleLine(line);
      }
    }

    // Keep buffer manageable
    if (this.buffer.length > 256) {
      this.buffer = this.buffer.slice(-64);
    }
  }

  private parseScaleLine(raw: string) {
    // Strip control characters
    const clean = raw.replace(/[^\x20-\x7E]/g, '').trim();
    if (!clean) return;

    // Check for hardware faults or power surge error codes (e.g. "no dlc", "no dls", "oL", "Err 02")
    const upper = clean.toUpperCase();
    if (
      upper.includes('NO DLC') ||
      upper.includes('NODLC') ||
      upper.includes('NO-DLC') ||
      upper.includes('NO DLS') ||
      upper.includes('NODLS') ||
      upper.includes('NO-DLS') ||
      upper.includes('NO DL') ||
      upper.includes('NO-DL') ||
      upper.includes('DLC') ||
      upper.includes('DLS') ||
      upper.includes('ERR') ||
      upper.includes('OVERLOAD') ||
      upper.includes('------') ||
      upper === 'OL'
    ) {
      const faultLabel =
        upper.includes('DLS') && !upper.includes('DLC') ? 'NO DLS' : 'NO DLC';
      logger.warn(`[scale] Hardware fault indicator received: "${clean}" (${faultLabel})`);
      this.lastFaultTime = Date.now();
      this.lastFaultLabel = faultLabel;
      this.currentReading = {
        ...this.currentReading,
        rawText: clean,
        lastUpdated: Date.now(),
        error: `${faultLabel} (Load Cell Signal Lost / Power Cut)`,
        recentFault: true,
        recentFaultLabel: faultLabel,
        lastFaultTime: this.lastFaultTime,
      };
      this.notifyListeners();
      return;
    }

    // Detect stability markers (e.g. ST = Stable, US/MO = Motion/Unstable)
    let isStable = false;
    if (clean.includes('ST') || clean.includes('S ')) {
      isStable = true;
    } else if (clean.includes('US') || clean.includes('MO') || clean.includes('M ')) {
      isStable = false;
    }

    // Extract numeric weight (preserve sign for negative readings)
    // Indicators output formats like: "+  14170", "014170 kg", "ST,GS,+14170kg", "14170", "-  00020"
    const match = clean.match(/([-+]?)\s*(\d+(?:\.\d+)?)/);
    if (match) {
      const sign = match[1] === '-' ? -1 : 1;
      const parsedWeight = sign * parseFloat(match[2]);
      if (!isNaN(parsedWeight)) {
        // Track recent readings to determine stability if indicator has no ST/US flag
        this.recentWeights.push(parsedWeight);
        if (this.recentWeights.length > 5) this.recentWeights.shift();

        if (this.recentWeights.length >= 4 && !clean.includes('US') && !clean.includes('MO')) {
          const max = Math.max(...this.recentWeights);
          const min = Math.min(...this.recentWeights);
          if (max - min <= 20) {
            isStable = true;
          }
        }

        // Check if we are within the DLC cooldown window
        const now = Date.now();
        const withinCooldown = this.lastFaultTime > 0 && (now - this.lastFaultTime) < DLC_COOLDOWN_MS;

        this.currentReading = {
          liveWeight: Math.round(parsedWeight),
          isStable,
          rawText: clean,
          lastUpdated: now,
          isConnected: true,
          port: this.portName,
          baudRate: this.baudRate,
          error: null,
          recentFault: withinCooldown,
          recentFaultLabel: withinCooldown ? this.lastFaultLabel : null,
          lastFaultTime: this.lastFaultTime || null,
        };

        this.notifyListeners();
      }
    }
  }

  private notifyListeners() {
    const reading = this.getReading();
    for (const listener of this.listeners) {
      try {
        listener(reading);
      } catch {}
    }
  }
}

// Global Singleton instance
let globalScaleService: ServerScaleService | null = null;

export function getServerScaleService(): ServerScaleService {
  if (!globalScaleService) {
    globalScaleService = new ServerScaleService();
  }
  return globalScaleService;
}
