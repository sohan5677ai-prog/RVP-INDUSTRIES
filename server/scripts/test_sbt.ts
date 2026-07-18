import { computeUnifiedStockEngine } from '../src/services/stockEngine.js';

async function main() {
  const { allLots, totalStorageKg } = await computeUnifiedStockEngine('MOST_EXPENSIVE_FIRST');
  
  const stateMap = new Map();
  for (const lot of allLots) {
    if (lot.partyName.toLowerCase().includes('sbt')) {
        console.log(`SBT Lot: ${lot.kind} in ${lot.partyState} receivedKg=${lot.receivedKg} orderedKg=${lot.orderedKg}`);
    }
  }
}

main().catch(console.error);
