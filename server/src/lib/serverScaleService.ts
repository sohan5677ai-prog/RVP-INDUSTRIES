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
}

type ScaleListener = (reading: ScaleReading) => void;

class ServerScaleService {
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
  };

  private buffer: string = '';
  private recentWeights: number[] = [];

  constructor() {
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

  public start() {
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

      logger.info(`[scale] Attempting connection to ${this.portName} at ${this.baudRate} 8N1...`);
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
          this.currentReading.isConnected = false;
          this.currentReading.error = `Could not open ${this.portName}: ${err.message}`;
          
          try {
            const ports = await SerialPort.list();
            this.currentReading.availablePorts = ports.map((p: any) => ({
              path: p.path,
              manufacturer: p.manufacturer,
              friendlyName: p.friendlyName || p.path,
            }));
          } catch {}

          this.notifyListeners();
          this.scheduleReconnect(4000);
          return;
        }

        logger.info(`[scale] Successfully opened ${this.portName}! Streaming live weight in background.`);
        this.serialPort = port;
        this.currentReading.isConnected = true;
        this.currentReading.error = null;
        this.notifyListeners();

        port.on('data', (chunk: Buffer) => {
          this.handleDataChunk(chunk.toString('ascii'));
        });

        port.on('error', (portErr) => {
          logger.warn(`[scale] Port ${this.portName} error: ${portErr.message}`);
          this.currentReading.isConnected = false;
          this.currentReading.error = portErr.message;
          this.notifyListeners();
          this.scheduleReconnect(3000);
        });

        port.on('close', () => {
          logger.info(`[scale] Port ${this.portName} closed.`);
          this.currentReading.isConnected = false;
          this.notifyListeners();
          this.scheduleReconnect(3000);
        });
      });
    } catch (e: any) {
      this.isConnecting = false;
      this.currentReading.isConnected = false;
      this.currentReading.error = e.message;
      this.notifyListeners();
      this.scheduleReconnect(4000);
    }
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

    // Check for hardware faults or power surge error codes (e.g. "no dLs", "no dls", "oL", "Err 02")
    const upper = clean.toUpperCase();
    if (
      upper.includes('NO DLS') ||
      upper.includes('NODLS') ||
      upper.includes('NO DL') ||
      upper.includes('NO-DL') ||
      upper.includes('ERR') ||
      upper.includes('OVERLOAD') ||
      upper.includes('------') ||
      upper === 'OL'
    ) {
      logger.warn(`[scale] Hardware fault indicator received: "${clean}"`);
      this.currentReading = {
        ...this.currentReading,
        rawText: clean,
        lastUpdated: Date.now(),
        error: upper.includes('DLS') || upper.includes('DL') ? 'NO DLS (Load Cell Signal Lost / Power Cut)' : `Scale Fault: ${clean}`,
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

    // Extract numeric weight
    // Indicators output formats like: "+  14170", "014170 kg", "ST,GS,+14170kg", "14170"
    const match = clean.match(/[-+]?\s*(\d+(?:\.\d+)?)/);
    if (match) {
      const parsedWeight = parseFloat(match[1]);
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

        this.currentReading = {
          liveWeight: Math.round(parsedWeight),
          isStable,
          rawText: clean,
          lastUpdated: Date.now(),
          isConnected: true,
          port: this.portName,
          baudRate: this.baudRate,
          error: null,
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
