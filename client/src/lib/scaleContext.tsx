import { createContext, useContext, useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import { toast } from 'sonner';

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

interface ScaleContextType {
  isSupported: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  liveWeight: number | null; // in kg (e.g. 20)
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
}

const ScaleContext = createContext<ScaleContextType | undefined>(undefined);

const STORAGE_AUTO_CONNECT = 'rvp_scale_auto_connect';
const STORAGE_BAUD_RATE = 'rvp_scale_baud_rate';
const DEFAULT_BAUD_RATE = 2400;

export function ScaleProvider({ children }: { children: ReactNode }) {
  const [isSupported, setIsSupported] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [liveWeight, setLiveWeight] = useState<number | null>(null);
  const [rawText, setRawText] = useState<string>('');
  const [isStable, setIsStable] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [baudRate, setBaudRateState] = useState<number>(() => {
    const saved = localStorage.getItem(STORAGE_BAUD_RATE);
    return saved ? parseInt(saved, 10) || DEFAULT_BAUD_RATE : DEFAULT_BAUD_RATE;
  });

  const [autoConnect, setAutoConnectState] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_AUTO_CONNECT);
    return saved !== 'false'; // Default to true
  });

  const portRef = useRef<WebSerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const keepReadingRef = useRef<boolean>(false);
  const recentReadingsRef = useRef<number[]>([]);

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
   * Process and parse raw serial stream from scale indicator.
   * Weighbridge format tested: 7 digits zero-padded + ETX (♥), e.g. "0000000♥" (0kg) or "0000020♥" (20kg)
   */
  const processChunk = useCallback((textChunk: string, bufferRef: { current: string }) => {
    bufferRef.current += textChunk;
    setRawText(textChunk.slice(-20));

    // Look for 7-digit pattern (e.g. 0000020, 0015420)
    const matches = bufferRef.current.match(/\d{7}/g);
    if (matches && matches.length > 0) {
      const latestMatch = matches[matches.length - 1];
      const parsed = parseInt(latestMatch, 10);

      if (!isNaN(parsed)) {
        setLiveWeight(parsed);
        setLastUpdated(new Date());

        // Track stability (last 4 readings within +/- 2 kg)
        const recent = recentReadingsRef.current;
        recent.push(parsed);
        if (recent.length > 5) recent.shift();

        if (recent.length >= 3) {
          const min = Math.min(...recent);
          const max = Math.max(...recent);
          setIsStable(max - min <= 2);
        }
      }

      // Truncate buffer up to the latest match to prevent unbounded memory growth
      const lastIndex = bufferRef.current.lastIndexOf(latestMatch);
      if (lastIndex !== -1) {
        bufferRef.current = bufferRef.current.slice(lastIndex + 7);
      }
    }

    // Keep buffer reasonably small if no 7-digit patterns are finding boundaries
    if (bufferRef.current.length > 200) {
      bufferRef.current = bufferRef.current.slice(-60);
    }
  }, []);

  /**
   * Continuous read loop from Web Serial port.
   */
  const startReading = useCallback(async (port: WebSerialPort) => {
    if (!port.readable) return;

    keepReadingRef.current = true;
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = (port.readable as any).pipeTo(textDecoder.writable).catch(() => {
      /* stream closed */
    });
    const reader = textDecoder.readable.getReader();
    readerRef.current = reader;

    const bufferRef = { current: '' };

    try {
      while (keepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          processChunk(value, bufferRef);
        }
      }
    } catch (err: any) {
      if (keepReadingRef.current) {
        console.error('Scale reading error:', err);
        setError(err?.message || 'Error reading scale data');
      }
    } finally {
      reader.releaseLock();
      await readableStreamClosed;
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
      setIsConnecting(false);

      // Handle device disconnect event (unplugged USB)
      const onDisconnect = () => {
        disconnect();
        toast.info('Scale disconnected');
      };
      port.addEventListener('disconnect', onDisconnect);

      startReading(port);
      return true;
    } catch (err: any) {
      console.error('Failed to open scale port:', err);
      setIsConnected(false);
      setIsConnecting(false);
      const msg = err?.message || String(err);
      if (msg.includes('already open')) {
        setIsConnected(true);
        return true;
      }
      setError(msg);
      return false;
    }
  }, [baudRate, startReading]);

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
      setIsConnecting(false);
      setLiveWeight(null);
      setIsStable(false);
    }
  }, []);

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

  return (
    <ScaleContext.Provider
      value={{
        isSupported,
        isConnected,
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
