import { computeUnifiedStockEngine } from '../src/services/stockEngine.js';

async function main() {
  const { allLots } = await computeUnifiedStockEngine('MOST_EXPENSIVE_FIRST');
  
  let totalValue = 0;
  for (const lot of allLots) {
      if (lot.receivedKg > 0) {
          console.log(`Lot: ${lot.kind} ${lot.receivedKg}kg at ${lot.pricePerKg}/kg = ${lot.receivedKg * lot.pricePerKg}`);
          totalValue += lot.receivedKg * lot.pricePerKg;
      }
  }
  console.log(`Total Value: ${totalValue}`);
}

main().catch(console.error);
