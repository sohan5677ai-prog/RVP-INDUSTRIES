import { createContext, useContext, useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import { toast } from 'sonner';
import { getScaleApiUrl } from '@/lib/api';

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

// Minimal Web Serial API TypeScript declarations
interface WebSerialPort {
  open(options: {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: 'none' | 'even' | 'odd';
    bufferSize?: number;
    flowControl?: 'none' | 'hardware';
  }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<any> | null;
  writable: WritableStream<any> | null;
  getInfo(): SerialPortInfo;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export type ScaleConnectionMode = 'LOCAL_USB' | 'NETWORK_STREAM' | 'OFFLINE';

export interface ScaleContextType {
  isSupported: boolean;
  isConnected: boolean; // local or remote connection is active
  isLocalConnected: boolean; // true if USB cable is directly plugged into this PC
  isScaleOnline: boolean; // true if ANY live scale feed is online
  connectionMode: ScaleConnectionMode;
  isConnecting: boolean;
  liveWeight: number | null; // in kg (e.g. 80)
  rawText: string;
  isStable: boolean;
  lastUpdated: Date | null;
  error: string | null;
  baudRate: number;
  setBaudRate: (rate: number) => void;
  autoConnect: boolean;
  setAutoConnect: (enable: boolean) => void;
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  isServerStreaming: boolean;
  hardwareConnected: boolean;
  serverPort: string;
  availablePorts: Array<{ path: string; manufacturer?: string; friendlyName?: string }>;
  switchServerPort: (port: string, baudRate?: number) => Promise<boolean>;
}

const ScaleContext = createContext<ScaleContextType | undefined>(undefined);

const STORAGE_AUTO_CONNECT = 'rvp_scale_auto_connect';
const STORAGE_BAUD_RATE = 'rvp_scale_baud_rate';
const DEFAULT_BAUD_RATE = 2400;

export function ScaleProvider({ children }: { children: ReactNode }) {
  const [isSupported, setIsSupported] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isLocalConnected, setIsLocalConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [liveWeight, setLiveWeight] = useState<number | null>(null);
  const [rawText, setRawText] = useState<string>('');
  const [isStable, setIsStable] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Universal Server Network Broadcast states
  const [isServerStreaming, setIsServerStreaming] = useState<boolean>(false);
  const [hardwareConnected, setHardwareConnected] = useState<boolean>(false);
  const [serverPort, setServerPort] = useState<string>('COM4');
  const [availablePorts, setAvailablePorts] = useState<Array<{ path: string; manufacturer?: string; friendlyName?: string }>>([]);

  const [baudRate, setBaudRateState] = useState<number>(() => {
    const saved = localStorage.getItem(STORAGE_BAUD_RATE);
    return saved ? parseInt(saved, 10) || DEFAULT_BAUD_RATE : DEFAULT_BAUD_RATE;
  });

  const [autoConnect, setAutoConnectState] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_AUTO_CONNECT);
    return saved !== 'false'; // Default to true
  });

  const portRef = useRef<WebSerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const keepReadingRef = useRef<boolean>(false);
  const recentReadingsRef = useRef<number[]>([]);

  // Throttle broadcast to universal server hub
  const lastBroadcastRef = useRef<{
    time: number;
    weight: number | null;
    isStable: boolean;
  }>({ time: 0, weight: null, isStable: false });
  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setBaudRate = (rate: number) => {
    setBaudRateState(rate);
    localStorage.setItem(STORAGE_BAUD_RATE, String(rate));
  };

  const setAutoConnect = (enable: boolean) => {
    setAutoConnectState(enable);
    localStorage.setItem(STORAGE_AUTO_CONNECT, enable ? 'true' : 'false');
  };

  useEffect(() => {
    const supported = typeof navigator !== 'undefined' && 'serial' in navigator;
    setIsSupported(supported);
  }, []);

  /**
   * Broadcast live scale reading from this PC to the universal server stream.
   * This transmits live weight to all other computers on the factory/mill network!
   */
  const broadcastReading = useCallback((weight: number, stable: boolean, raw: string) => {
    const now = Date.now();
    const last = lastBroadcastRef.current;
    const weightChanged = last.weight !== weight || last.isStable !== stable;
    const timeElapsed = now - last.time;

    const doSend = async () => {
      lastBroadcastRef.current = { time: Date.now(), weight, isStable: stable };
      try {
        const url = getScaleApiUrl('/weighbridge/scale/broadcast');
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            liveWeight: weight,
            isStable: stable,
            rawText: raw,
            port: serverPort || 'COM4',
            isConnected: true,
          }),
        });
      } catch {
        /* ignore network hiccups during high frequency streaming */
      }
    };

    if (weightChanged && timeElapsed >= 150) {
      if (broadcastTimerRef.current) {
        clearTimeout(broadcastTimerRef.current);
        broadcastTimerRef.current = null;
      }
      doSend();
    } else if (weightChanged) {
      if (!broadcastTimerRef.current) {
        broadcastTimerRef.current = setTimeout(() => {
          broadcastTimerRef.current = null;
          doSend();
        }, Math.max(20, 150 - timeElapsed));
      }
    } else if (timeElapsed >= 800) {
      doSend();
    }
  }, [serverPort]);

  const reportDisconnect = useCallback(async () => {
    try {
      const url = getScaleApiUrl('/weighbridge/scale/broadcast');
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isConnected: false,
          error: 'USB scale disconnected from Kata Cabin terminal',
        }),
      });
    } catch {}
  }, []);

  /**
   * Process and parse raw serial stream from scale indicator.
   * Weighbridge format: packets ending in ETX (♥ / 0x03), CR, or LF containing digits (e.g. "000080♥" or "0000000♥")
   */
  const processChunk = useCallback((textChunk: string, bufferRef: { current: string }) => {
    bufferRef.current += textChunk;

    // Show friendly preview in UI (render \x03 as ♥ and newlines as ↵)
    const preview = bufferRef.current.slice(-25).replace(/\x03/g, '♥').replace(/[\r\n]+/g, '↵');
    setRawText(preview);

    // Split accumulated buffer into frames by ETX (\x03), STX (\x02), CR, or LF
    const frames = bufferRef.current.split(/[\x02\x03\r\n\x04]+/);

    let parsedWeight: number | null = null;

    // If we have completed frames (frames before the current open tail)
    if (frames.length > 1) {
      for (let i = frames.length - 2; i >= 0; i--) {
        const frame = frames[i].trim();
        const numMatch = frame.match(/\d{2,8}/);
        if (numMatch) {
          const val = parseInt(numMatch[0], 10);
          if (!isNaN(val)) {
            parsedWeight = val;
            break;
          }
        }
      }
      // Retain only the incomplete tail
      bufferRef.current = frames[frames.length - 1];
    }

    // Fallback: If no delimiter was found, match any sequence of 4-8 digits
    if (parsedWeight == null) {
      const directMatches = bufferRef.current.match(/\d{4,8}/g);
      if (directMatches && directMatches.length > 0) {
        const latest = directMatches[directMatches.length - 1];
        const val = parseInt(latest, 10);
        if (!isNaN(val)) {
          parsedWeight = val;
          const idx = bufferRef.current.lastIndexOf(latest);
          if (idx !== -1) {
            bufferRef.current = bufferRef.current.slice(idx + latest.length);
          }
        }
      }
    }

    if (parsedWeight != null) {
      setLiveWeight(parsedWeight);
      setLastUpdated(new Date());

      // Track stability (last 4 readings within +/- 2 kg)
      const recent = recentReadingsRef.current;
      recent.push(parsedWeight);
      if (recent.length > 5) recent.shift();

      let stable = false;
      if (recent.length >= 3) {
        const min = Math.min(...recent);
        const max = Math.max(...recent);
        stable = max - min <= 2;
        setIsStable(stable);
      }

      // Broadcast universally to server for all other PCs!
      broadcastReading(parsedWeight, stable, preview);
    }

    // Prevent buffer memory leak
    if (bufferRef.current.length > 150) {
      bufferRef.current = bufferRef.current.slice(-30);
    }
  }, [broadcastReading]);

  /**
   * Continuous read loop directly on Uint8Array to avoid TransformStream buffering/stalls.
   */
  const startReading = useCallback(async (port: WebSerialPort) => {
    if (!port.readable) return;

    keepReadingRef.current = true;
    const reader = port.readable.getReader();
    readerRef.current = reader;
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const bufferRef = { current: '' };

    try {
      // Assert DTR and RTS signals so the RS232-USB bridge continuously streams
      try {
        await (port as any).setSignals?.({ dataTerminalReady: true, requestToSend: true });
      } catch {
        /* ignore if device doesn't support signal manipulation */
      }

      while (keepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          const textChunk = decoder.decode(value, { stream: true });
          processChunk(textChunk, bufferRef);
        }
      }
    } catch (err: any) {
      if (keepReadingRef.current) {
        console.error('Scale reading error:', err);
        setError(err?.message || 'Error reading scale data');
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }, [processChunk]);

  /**
   * Internal helper to open an existing or selected port.
   */
  const openPort = useCallback(async (port: WebSerialPort): Promise<boolean> => {
    try {
      setIsConnecting(true);
      setError(null);

      await port.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
      });

      portRef.current = port;
      setIsConnected(true);
      setIsLocalConnected(true);
      setIsConnecting(false);

      // Handle device disconnect event (unplugged USB)
      const onDisconnect = () => {
        disconnect();
        reportDisconnect();
        toast.info('Scale disconnected');
      };
      port.addEventListener('disconnect', onDisconnect);

      startReading(port);

      // Immediately notify server that terminal is online
      broadcastReading(0, true, '000000');

      return true;
    } catch (err: any) {
      console.error('Failed to open scale port:', err);
      setIsConnected(false);
      setIsLocalConnected(false);
      setIsConnecting(false);
      const msg = err?.message || String(err);
      if (msg.includes('already open')) {
        setIsConnected(true);
        setIsLocalConnected(true);
        return true;
      }
      setError(msg);
      return false;
    }
  }, [baudRate, startReading, reportDisconnect, broadcastReading]);

  /**
   * Connect to scale. Prompts user if not previously granted, or uses existing port.
   */
  const connect = useCallback(async (): Promise<boolean> => {
    if (!isSupported) {
      toast.error('Web Serial is not supported in this browser. Please use Chrome or Edge.');
      return false;
    }

    try {
      setIsConnecting(true);
      setError(null);

      // Check if we already have a granted port
      const serial = (navigator as any).serial;
      const existingPorts: WebSerialPort[] = await serial.getPorts();

      let targetPort: WebSerialPort;
      if (existingPorts.length > 0) {
        targetPort = existingPorts[0];
      } else {
        // Request port permission from user (shows browser COM port picker)
        targetPort = await serial.requestPort();
      }

      if (!targetPort) {
        setIsConnecting(false);
        return false;
      }

      const success = await openPort(targetPort);
      if (success) {
        toast.success(`Scale connected at ${baudRate} baud`);
      }
      return success;
    } catch (err: any) {
      setIsConnecting(false);
      if (err?.name === 'NotFoundError') {
        // User cancelled port selection dialog
        return false;
      }
      console.error('Scale connection failed:', err);
      setError(err?.message || 'Failed to connect to scale');
      toast.error(err?.message || 'Failed to connect to scale');
      return false;
    }
  }, [isSupported, baudRate, openPort]);

  /**
   * Disconnect and release the serial port.
   */
  const disconnect = useCallback(async () => {
    keepReadingRef.current = false;

    try {
      if (readerRef.current) {
        await readerRef.current.cancel().catch(() => {});
        readerRef.current = null;
      }
      if (portRef.current) {
        await portRef.current.close().catch(() => {});
        portRef.current = null;
      }
    } catch (err) {
      console.error('Error closing scale port:', err);
    } finally {
      setIsConnected(false);
      setIsLocalConnected(false);
      setIsConnecting(false);
      setLiveWeight(null);
      setIsStable(false);
      reportDisconnect();
    }
  }, [reportDisconnect]);

  /**
   * Auto-connect on startup if previously granted permission.
   */
  useEffect(() => {
    if (!isSupported || !autoConnect) return;

    let mounted = true;
    const tryAutoConnect = async () => {
      try {
        const serial = (navigator as any).serial;
        const ports: WebSerialPort[] = await serial.getPorts();
        if (ports.length > 0 && mounted && !portRef.current) {
          // Previously authorized port detected, automatically open it
          await openPort(ports[0]);
        }
      } catch (err) {
        console.warn('Scale auto-connect skipped:', err);
      }
    };

    tryAutoConnect();

    return () => {
      mounted = false;
    };
  }, [isSupported, autoConnect, openPort]);

  // Clean up port on window unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (portRef.current) {
        keepReadingRef.current = false;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  /**
   * Background Network Stream: Automatically receive live scale weight from server broadcast.
   * Dual-Sync Architecture:
   * 1. Continuous 600ms polling guarantees reliable updates across all devices, mobile phones, and proxies.
   * 2. SSE provides instantaneous sub-50ms push updates where supported.
   */
  useEffect(() => {
    let es: EventSource | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let isCancelled = false;

    const streamUrl = getScaleApiUrl('/weighbridge/scale/stream');
    const liveUrl = getScaleApiUrl('/weighbridge/scale/live');

    const fetchLiveScale = async () => {
      if (portRef.current || isCancelled) return;
      try {
        const res = await fetch(liveUrl, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setIsServerStreaming(true);
          if (data.port) setServerPort(data.port);
          if (Array.isArray(data.availablePorts)) setAvailablePorts(data.availablePorts);
          setHardwareConnected(!!data.isConnected);

          if (!portRef.current) {
            if (data.isConnected) {
              setLiveWeight(data.liveWeight != null ? Number(data.liveWeight) : 0);
              setIsStable(!!data.isStable);
              setRawText(data.rawText || `${data.liveWeight ?? 0} kg`);
              setLastUpdated(new Date(data.lastUpdated || Date.now()));
              setIsConnected(true);
              setError(null);
            } else {
              if (data.error) setError(data.error);
              setIsConnected(false);
            }
          }
        }
      } catch {}
    };

    // Immediate initial sync
    fetchLiveScale();

    // Fast polling every 600ms to guarantee network updates across all client machines
    pollInterval = setInterval(fetchLiveScale, 600);

    // Parallel Server-Sent Events (SSE) for low latency
    try {
      es = new EventSource(streamUrl);

      es.onmessage = (event) => {
        if (isCancelled || portRef.current) return;
        try {
          const data = JSON.parse(event.data);
          setIsServerStreaming(true);
          if (data.port) setServerPort(data.port);
          if (Array.isArray(data.availablePorts)) setAvailablePorts(data.availablePorts);
          setHardwareConnected(!!data.isConnected);

          if (!portRef.current) {
            if (data.isConnected) {
              setLiveWeight(data.liveWeight != null ? Number(data.liveWeight) : 0);
              setIsStable(!!data.isStable);
              setRawText(data.rawText || `${data.liveWeight ?? 0} kg`);
              setLastUpdated(new Date(data.lastUpdated || Date.now()));
              setIsConnected(true);
              setError(null);
            } else {
              if (data.error) setError(data.error);
              setIsConnected(false);
            }
          }
        } catch {}
      };

      es.onerror = () => {
        // SSE error (e.g. proxy timeout) - fast polling interval handles updates seamlessly!
      };
    } catch {}

    return () => {
      isCancelled = true;
      if (es) es.close();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, []);

  const switchServerPort = useCallback(async (port: string, rate?: number): Promise<boolean> => {
    try {
      const url = getScaleApiUrl('/weighbridge/scale/config');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, baudRate: rate || baudRate }),
      });
      if (res.ok) {
        toast.success(`Server scale port switched to ${port}`);
        return true;
      }
    } catch {}
    return false;
  }, [baudRate]);

  // Unified status: Online if either local USB is connected OR universal network stream is receiving live weight
  const isScaleOnline = isLocalConnected || hardwareConnected;
  const connectionMode: ScaleConnectionMode = isLocalConnected
    ? 'LOCAL_USB'
    : hardwareConnected
    ? 'NETWORK_STREAM'
    : 'OFFLINE';

  return (
    <ScaleContext.Provider
      value={{
        isSupported,
        isConnected: isConnected || isLocalConnected,
        isLocalConnected,
        isScaleOnline,
        connectionMode,
        isConnecting,
        liveWeight,
        rawText,
        isStable,
        lastUpdated,
        error,
        baudRate,
        setBaudRate,
        autoConnect,
        setAutoConnect,
        connect,
        disconnect,
        isServerStreaming,
        hardwareConnected,
        serverPort,
        availablePorts,
        switchServerPort,
      }}
    >
      {children}
    </ScaleContext.Provider>
  );
}

export function useScale(): ScaleContextType {
  const context = useContext(ScaleContext);
  if (!context) {
    throw new Error('useScale must be used within a ScaleProvider');
  }
  return context;
}
