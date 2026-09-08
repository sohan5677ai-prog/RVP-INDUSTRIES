import { describe, it, expect } from 'vitest';
import { searchPartiesFuzzy, executeTool } from './chatTools.js';

describe('JARVIS Voice Recognition & Party Matching', () => {
  it('fuzzy matches "spectermum" to Spectrum Auxi Chem Private Limited', async () => {
    const matches = await searchPartiesFuzzy('spectermum', 3);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toContain('Spectrum');
  });

  it('matches exact "spectrum"', async () => {
    const matches = await searchPartiesFuzzy('spectrum', 3);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toContain('Spectrum');
  });

  it('executes open_party_ledger with fuzzy name "spectermum" and returns autoExecute navigation', async () => {
    const res = await executeTool('open_party_ledger', { partyName: 'spectermum' });
    expect(res.success).toBe(true);
    expect(res.action).toBe('navigate');
    expect(res.route).toContain('/accounts/party-ledger?partyId=');
    expect(res.autoExecute).toBe(true);
    expect(res.pageLabel).toContain('Spectrum');
  });

  it('executes get_dispatches_for_einvoice for Spectrum', async () => {
    const res = await executeTool('get_dispatches_for_einvoice', { buyerName: 'spectermum' });
    expect(res.dispatches).toBeDefined();
    expect(Array.isArray(res.dispatches)).toBe(true);
    if (res.dispatches.length > 0) {
      expect(res.dispatches[0].buyerName).toContain('Spectrum');
    }
  });
});
