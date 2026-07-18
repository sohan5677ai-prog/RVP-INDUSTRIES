import { computeUnifiedStockEngine } from '../src/services/stockEngine.js';

async function main() {
  const { allLots, totalStorageKg } = await computeUnifiedStockEngine('MOST_EXPENSIVE_FIRST');
  console.log(`Total lots: ${allLots.length}`);
  console.log(`Total storage Kg: ${totalStorageKg}`);
  let totalNet = 0;
  for (const l of allLots) {
    totalNet += l.receivedKg;
  }
  console.log(`Total net stock in allLots: ${totalNet}`);

  const stateMap = new Map();
  for (const lot of allLots) {
    stateMap.set(lot.partyState, (stateMap.get(lot.partyState) || 0) + lot.receivedKg);
  }
  console.log('State map:', Object.fromEntries(stateMap));
}

main().catch(console.error);
