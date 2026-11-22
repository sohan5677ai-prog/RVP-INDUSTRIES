import { describe, expect, it } from 'vitest';
import { createFaultTracker, detectScaleFault } from './scaleFault.js';

describe('detectScaleFault (one indicator frame)', () => {
  it('classifies real indicator fault frames', () => {
    expect(detectScaleFault('no dlc')).toBe('NO DLC');
    expect(detectScaleFault('NODLC')).toBe('NO DLC');
    expect(detectScaleFault('  No-DLS ')).toBe('NO DLS');
    expect(detectScaleFault('oL')).toBe('OVERLOAD');
    expect(detectScaleFault('------')).toBe('OVERLOAD');
    expect(detectScaleFault('Err 02')).toBe('SCALE ERROR');
    expect(detectScaleFault('???')).toBe('SCALE ERROR');
  });

  it('leaves normal weight frames alone', () => {
    for (const frame of ['+  14170', '014170 kg', 'ST,GS,+14170kg', '-  00020', '000080', '12?40', 'DLCX']) {
      expect(detectScaleFault(frame)).toBeNull();
    }
  });
});

describe('createFaultTracker (debounce)', () => {
  it('ignores a single noisy fault frame between good weights', () => {
    const t = createFaultTracker();
    expect(t.push(null)).toBeNull();
    expect(t.push('SCALE ERROR')).toBeNull();
    expect(t.push(null)).toBeNull();
  });

  it('raises after consecutive fault frames and clears after consecutive good ones', () => {
    const t = createFaultTracker();
    t.push('NO DLC');
    expect(t.push('NO DLC')).toBe('NO DLC');
    expect(t.push(null)).toBe('NO DLC'); // one good frame is not enough
    expect(t.push(null)).toBeNull();
  });
});
