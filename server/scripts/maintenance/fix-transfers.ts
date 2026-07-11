import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const transfers = await prisma.stockTransfer.findMany({
    where: { toLocation: 'RVP' },
  });

  for (const t of transfers) {
    if (t.weightKg <= 0) continue;

    const addedCost = Number(t.loadingHamali) + Number(t.unloadingHamali) + Number(t.transportCharge);
    
    // We know the user's specific transfer of 10,000kg was valued at ~280,373.33
    // We want to force it back to exactly 280,000 (which is 28.00 base price).
    if (t.weightKg === 10000 && t.seedCostMoved.toNumber() > 280000 && t.seedCostMoved.toNumber() < 281000) {
       const newSeedCostMoved = 280000;
       const newMovedValue = newSeedCostMoved + addedCost; // 280000 + 3200 = 283200
       
       await prisma.stockTransfer.update({
         where: { id: t.id },
         data: {
           seedCostMoved: newSeedCostMoved,
           movedValue: newMovedValue
         }
       });
       console.log(`Updated Transfer ${t.id}: movedValue to ${newMovedValue}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
