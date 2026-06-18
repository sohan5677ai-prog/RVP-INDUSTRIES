import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { companyHamaliShare } from '../lib/calc.js';

/**
 * Detailed black seed stock on hand: one row per recorded purchase (lorry) that
 * has not yet been milled. Value = seed cost + the company's half of the hamali.
 */
export async function getBlackSeedStock(_req: Request, res: Response) {
  const purchases = await prisma.purchase.findMany({
    where: { processing: { is: null } },
    orderBy: { createdAt: 'desc' },
    include: {
      verification: true,
      stockIn: { include: { purchaseOrder: { include: { party: true } } } },
    },
  });

  const rows = purchases.map((p) => {
    const price = Number(p.stockIn.purchaseOrder.pricePerKg);
    const ourHamali = companyHamaliShare(Number(p.hamaliCharge));
    // RVP net (kata) weight of black seed received.
    const rvpNetWeightKg = p.netWeightKg;
    // Seed cost: verified payable if approved, else weight x price.
    const seedCost = p.verification ? Number(p.verification.totalAmount) : rvpNetWeightKg * price;
    const value = Math.round((seedCost + ourHamali) * 100) / 100;

    return {
      purchaseId: p.id,
      date: p.stockIn.arrivalDate,
      invoiceNumber: p.stockIn.invoiceNumber,
      partyName: p.stockIn.purchaseOrder.party.name,
      poNumber: p.stockIn.purchaseOrder.poNumber,
      lorryNumber: p.stockIn.lorryNumber,
      rvpNetWeightKg,
      location: p.stockIn.loadingLocation,
      pricePerKg: price,
      hamaliCharge: Number(p.hamaliCharge),
      companyHamali: ourHamali,
      value,
      verified: !!p.verification,
    };
  });

  res.json(rows);
}

/**
 * Helper to parse state from address.
 * Matches common patterns or extracts trailing two-letter words.
 */
export function parseState(address: string | null): string {
  if (!address) return 'Unknown / Other';
  const cleanAddress = address.trim().toUpperCase();

  if (/\b(AP|ANDHRA|ANDHRA\s+PRADESH)\b/.test(cleanAddress)) return 'Andhra Pradesh';
  if (/\b(TN|TAMIL|TAMIL\s+NADU)\b/.test(cleanAddress)) return 'Tamil Nadu';
  if (/\b(TS|TG|TELANGANA)\b/.test(cleanAddress)) return 'Telangana';
  if (/\b(KA|KARNATAKA)\b/.test(cleanAddress)) return 'Karnataka';
  if (/\b(KL|KERALA)\b/.test(cleanAddress)) return 'Kerala';
  if (/\b(MH|MAHARASHTRA)\b/.test(cleanAddress)) return 'Maharashtra';
  if (/\b(OD|ORISSA|ODISHA)\b/.test(cleanAddress)) return 'Odisha';

  const words = cleanAddress.split(/[\s,]+/);
  if (words.length > 0) {
    const lastWord = words[words.length - 1];
    if (lastWord.length === 2 && /^[A-Z]{2}$/.test(lastWord)) {
      return lastWord;
    }
  }

  return 'Unknown / Other';
}

/**
 * Get remaining raw black seed stock aggregated by supplier party.
 */
export async function getStockByParty(req: Request, res: Response) {
  const parties = await prisma.party.findMany({
    where: {
      type: { in: ['SUPPLIER', 'BOTH'] },
    },
    include: {
      purchaseOrders: {
        include: {
          stockIns: {
            include: {
              purchase: {
                include: {
                  verification: true,
                  processing: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  const stockByParty = parties.map((party) => {
    let totalPurchasedKg = 0;
    let totalMilledKg = 0;

    for (const po of party.purchaseOrders) {
      for (const stockIn of po.stockIns) {
        if (stockIn.purchase) {
          const purchase = stockIn.purchase;
          const weight = purchase.verification
            ? purchase.verification.finalWeightKg
            : purchase.netWeightKg;

          totalPurchasedKg += weight;

          if (purchase.processing) {
            totalMilledKg += purchase.processing.blackWeightKg;
          }
        }
      }
    }

    const netStockKg = totalPurchasedKg - totalMilledKg;

    return {
      partyId: party.id,
      partyName: party.name,
      phone: party.phone || 'N/A',
      address: party.address || 'N/A',
      state: party.state || parseState(party.address),
      totalPurchasedKg,
      totalMilledKg,
      netStockKg,
    };
  });

  res.json(stockByParty);
}

/**
 * Get remaining raw black seed stock aggregated by state.
 */
export async function getStockByState(req: Request, res: Response) {
  const parties = await prisma.party.findMany({
    where: {
      type: { in: ['SUPPLIER', 'BOTH'] },
    },
    include: {
      purchaseOrders: {
        include: {
          stockIns: {
            include: {
              purchase: {
                include: {
                  verification: true,
                  processing: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const stateGroups: Record<
    string,
    {
      state: string;
      totalPurchasedKg: number;
      totalMilledKg: number;
      netStockKg: number;
      supplierCount: number;
    }
  > = {};

  for (const party of parties) {
    const state = party.state || parseState(party.address);
    if (!stateGroups[state]) {
      stateGroups[state] = {
        state,
        totalPurchasedKg: 0,
        totalMilledKg: 0,
        netStockKg: 0,
        supplierCount: 0,
      };
    }

    let totalPurchasedKg = 0;
    let totalMilledKg = 0;

    for (const po of party.purchaseOrders) {
      for (const stockIn of po.stockIns) {
        if (stockIn.purchase) {
          const purchase = stockIn.purchase;
          const weight = purchase.verification
            ? purchase.verification.finalWeightKg
            : purchase.netWeightKg;

          totalPurchasedKg += weight;

          if (purchase.processing) {
            totalMilledKg += purchase.processing.blackWeightKg;
          }
        }
      }
    }

    stateGroups[state].totalPurchasedKg += totalPurchasedKg;
    stateGroups[state].totalMilledKg += totalMilledKg;
    stateGroups[state].netStockKg += totalPurchasedKg - totalMilledKg;
    stateGroups[state].supplierCount += 1;
  }

  const result = Object.values(stateGroups).sort((a, b) => b.netStockKg - a.netStockKg);
  res.json(result);
}
