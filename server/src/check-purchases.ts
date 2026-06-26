import { prisma } from './lib/prisma.js';
import fs from 'fs';

async function main() {
  const purchases = await prisma.purchase.findMany({
    include: {
      verification: true,
      stockIn: { include: { purchaseOrder: true } }
    }
  });
  
  let out = '';
  for (const p of purchases) {
    out += `Purchase ID: ${p.id}\n`;
    out += `  Arrival Date: ${p.stockIn.arrivalDate}\n`;
    out += `  PO Price: ${p.stockIn.purchaseOrder.pricePerKg}, Type: ${p.stockIn.purchaseOrder.priceType}\n`;
    out += `  RVP Net Weight: ${p.netWeightKg} kg\n`;
    out += `  Freight: ${p.freightCharge}\n`;
    out += `  Bag cutting: ${p.bagCuttingCharge}\n`;
    out += `  Hamali: ${p.hamaliCharge}\n`;
    if (p.verification) {
      out += `  Verified Price: ${p.verification.pricePerKg}\n`;
      out += `  Verified Total: ${p.verification.totalAmount}\n`;
      out += `  Billing Weight: ${p.verification.billingWeightKg} kg\n`;
      out += `  Final Weight: ${p.verification.finalWeightKg} kg\n`;
    }
    out += '\n';
  }

  fs.writeFileSync('c:\\Users\\SOHAN\\Desktop\\RVP-ERP\\server\\check-purchases.txt', out);
  console.log('Done!');
}
main();
