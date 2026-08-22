import { describe, it, expect } from 'vitest';
import { resolveOrderEffectiveDetails } from '../lib/orderAddress.js';

describe('Dispatch Phone Routing', () => {
  describe('resolveOrderEffectiveDetails for WhatsApp Bundles', () => {
    it('aggregates only Phone 1 in allBuyerPhones and excludes Phone 2', async () => {
      const order = {
        buyerId: 'buyer-1',
        buyerPhone: '9876543210',
        buyerPhone2: '9826464461',
        buyer: {
          id: 'buyer-1',
          name: 'Colourtex Industries',
          phone: '9876543210',
          phone2: '9826464461',
        },
      };

      const result = await resolveOrderEffectiveDetails(order);

      expect(result.effectivePhone).toBe('9876543210');
      expect(result.effectivePhone2).toBe('9826464461');
      // allBuyerPhones must contain ONLY Phone 1 so E-Way Bill / E-Invoice bundle goes to Phone 1 only
      expect(result.allBuyerPhones).toEqual(['9876543210']);
      expect(result.allBuyerPhones).not.toContain('9826464461');
    });

    it('collects branch Phone 1 and excludes branch Phone 2', async () => {
      const order = {
        buyerId: 'buyer-2',
        buyer: {
          id: 'buyer-2',
          name: 'Textile Mills',
          phone: '9111111111',
          phone2: '9222222222',
          addresses: [
            {
              id: 'addr-1',
              label: 'Surat Unit',
              phone: '9333333333',
              phone2: '9444444444',
              isDefault: true,
            },
          ],
        },
      };

      const result = await resolveOrderEffectiveDetails(order);

      expect(result.effectivePhone).toBe('9333333333');
      expect(result.effectivePhone2).toBe('9444444444');
      // allBuyerPhones must contain branch Phone 1 and buyer Phone 1, but NO Phone 2
      expect(result.allBuyerPhones).toContain('9333333333');
      expect(result.allBuyerPhones).toContain('9111111111');
      expect(result.allBuyerPhones).not.toContain('9444444444');
      expect(result.allBuyerPhones).not.toContain('9222222222');
    });
  });

  describe('Driver contact variable calculation', () => {
    it('uses Phone 2 (driver contact) when available', () => {
      const buyer: { name: string; phone: string | null; phone2: string | null } = {
        name: 'Colourtex Industries',
        phone: '9876543210',
        phone2: '9826464461', // Point of contact for driver
      };

      const buyerContact = buyer.phone2?.trim() || buyer.phone?.trim() || '-';
      expect(buyerContact).toBe('9826464461');
    });

    it('falls back to Phone 1 when Phone 2 is not set', () => {
      const buyer: { name: string; phone: string | null; phone2: string | null } = {
        name: 'Colourtex Industries',
        phone: '9876543210',
        phone2: null,
      };

      const buyerContact = buyer.phone2?.trim() || buyer.phone?.trim() || '-';
      expect(buyerContact).toBe('9876543210');
    });

    it('falls back to - when neither Phone 1 nor Phone 2 is set', () => {
      const buyer: { name: string; phone: string | null; phone2: string | null } = {
        name: 'Colourtex Industries',
        phone: null,
        phone2: null,
      };

      const buyerContact = buyer.phone2?.trim() || buyer.phone?.trim() || '-';
      expect(buyerContact).toBe('-');
    });
  });
});
