import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('serialport', () => ({
  SerialPort: class {
    static list = mocks.list;
    isOpen = false;
    open = mocks.open;
    on = vi.fn();
  },
}));
vi.mock('./logger.js', () => ({ logger: mocks }));

describe('scale connection logging', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv('SCALE_LOCAL_ENABLED', 'true');
    mocks.open.mockImplementation((callback) => callback(new Error('Port unavailable')));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('keeps retrying but warns only once during a continuous outage', async () => {
    const { getServerScaleService } = await import('./serverScaleService.js');
    getServerScaleService();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.open).toHaveBeenCalledTimes(13);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.debug).toHaveBeenCalledTimes(13);
  });

  it('reports recovery and warns again if a later connection fails', async () => {
    const { getServerScaleService } = await import('./serverScaleService.js');
    const service = getServerScaleService();
    mocks.open.mockImplementationOnce((callback) => callback(null));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(service.getReading().isConnected).toBe(true);
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('Successfully opened'));
    service.start();
    expect(mocks.warn).toHaveBeenCalledTimes(2);
  });

  it('treats a connection error as offline, never as NO DLC', async () => {
    vi.stubEnv('SCALE_LOCAL_ENABLED', 'false');
    const { getServerScaleService } = await import('./serverScaleService.js');
    const service = getServerScaleService();
    service.updateClientReading({ liveWeight: 0, isStable: false, error: 'Failed to open COM4', fault: null });
    expect(service.getReading().fault).toBeNull();
    service.reportClientDisconnect('Could not open COM4: Error');
    expect(service.getReading()).toMatchObject({ isConnected: false, fault: null });
  });

  it('uses the terminal fault field and clears it on the next good reading', async () => {
    vi.stubEnv('SCALE_LOCAL_ENABLED', 'false');
    const { getServerScaleService } = await import('./serverScaleService.js');
    const service = getServerScaleService();
    service.updateClientReading({ liveWeight: 0, isStable: false, rawText: 'NO DLC', fault: 'NO DLC' });
    expect(service.getReading()).toMatchObject({ fault: 'NO DLC', liveWeight: 0 });
    service.updateClientReading({ liveWeight: 14170, isStable: true, rawText: '014170', fault: null });
    expect(service.getReading()).toMatchObject({ fault: null, liveWeight: 14170, recentFault: true });
  });

  it('disables serial attempts while retaining remote readings and timeout detection', async () => {
    vi.stubEnv('SCALE_LOCAL_ENABLED', 'false');
    const { getServerScaleService } = await import('./serverScaleService.js');
    const service = getServerScaleService();
    await service.setConfig('COM5');
    service.updateClientReading({ liveWeight: 1234, isStable: true });
    expect(service.getReading()).toMatchObject({ liveWeight: 1234, isConnected: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.getReading().isConnected).toBe(false);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
