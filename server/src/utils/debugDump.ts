import { prisma } from '../lib/prisma.js';
import * as fs from 'fs';
import * as path from 'path';

export async function dumpDebugInfo() {
  try {
    const dispatches = await prisma.saleDispatch.findMany({
      select: { weightKg: true, saleOrder: { select: { product: true } } },
    });
    const soldKg = dispatches.filter((d) => d.saleOrder.product === 'PAPPU').reduce((s, d) => s + d.weightKg, 0);
    
    const purchases = await prisma.purchase.findMany();
    const purchasedKg = purchases.reduce((s, p) => s + p.netWeightKg, 0);
    
    const info = {
      totalDispatches: dispatches.length,
      pappuSoldKg: soldKg,
      totalPurchases: purchases.length,
      purchasedKg: purchasedKg,
    };
    
    fs.writeFileSync(path.resolve(process.cwd(), 'debug_dump.json'), JSON.stringify(info, null, 2));
    console.log('Debug info written to debug_dump.json');
  } catch (err) {
    console.error('Debug dump failed', err);
  }
}
