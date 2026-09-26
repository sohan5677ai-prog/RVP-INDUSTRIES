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
