import { prisma } from './lib/prisma.js';
import fs from 'fs';

async function main() {
  const stockIns = await prisma.stockIn.findMany({
    include: {
      purchase: {
        include: {
          verification: true
        }
      },
      purchaseOrder: {
        include: {
          party: true
        }
      }
    },
    orderBy: {
      arrivalDate: 'desc'
    }
  });

  let output = `Found ${stockIns.length} StockIns:\n`;
  for (const s of stockIns) {
    output += `StockIn: ID=${s.id}, Date=${s.arrivalDate.toISOString().slice(0, 10)}, Lorry=${s.lorryNumber}, Party=${s.purchaseOrder?.party?.name}, Invoice=${s.invoiceNumber}\n`;
    output += `  Weight Info: Billing=${s.billingWeightKg}kg, Party=${s.partyKataKg}kg, RVP-1st=${s.rvpFirstWeightKg}kg, RVP-2nd=${s.rvpSecondWeightKg}kg, RVP-Kata=${s.rvpKataKg}kg\n`;
    output += `  Purchase: ${s.purchase ? 'Yes (ID=' + s.purchase.id + ')' : 'No'}\n`;
    if (s.purchase) {
      output += `    Verification: ${s.purchase.verification ? 'Yes (Amt=' + s.purchase.verification.totalAmount + ', FinalWeight=' + s.purchase.verification.finalWeightKg + 'kg)' : 'No'}\n`;
    }
  }

  fs.writeFileSync('scratch-output.txt', output);
  console.log('Done!');
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
