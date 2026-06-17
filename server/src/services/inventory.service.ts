import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

export class InventoryService {
  /**
   * Add raw black seed to a specific location silo and update its MAP valuation.
   */
  static async updateBlackSeedInventory(
    tx: Prisma.TransactionClient,
    location: string,
    weightKg: number,
    cost: number
  ) {
    const silo = await tx.siloInventory.findFirst({
      where: { itemType: 'BLACK_SEED', location },
    });

    if (silo) {
      const newWeight = silo.weightKg + weightKg;
      const newValue = new Prisma.Decimal(silo.totalValue).plus(cost);
      return await tx.siloInventory.update({
        where: { id: silo.id },
        data: {
          weightKg: newWeight,
          totalValue: newValue,
        },
      });
    } else {
      return await tx.siloInventory.create({
        data: {
          itemType: 'BLACK_SEED',
          location,
          weightKg,
          totalValue: cost,
        },
      });
    }
  }

  /**
   * Consume raw black seed from a location silo, calculating consumed cost using the silo's MAP.
   * Returns the exact cost of raw seed consumed.
   */
  static async consumeBlackSeedInventory(
    tx: Prisma.TransactionClient,
    location: string,
    weightKg: number
  ): Promise<number> {
    const silo = await tx.siloInventory.findFirst({
      where: { itemType: 'BLACK_SEED', location },
    });

    if (!silo || silo.weightKg <= 0) {
      return 0; // No stock available, raw material cost is 0 (or fallback)
    }

    const currentWeight = silo.weightKg;
    const currentValue = Number(silo.totalValue);
    const currentMAP = currentValue / currentWeight;

    const consumedCost = Math.round(weightKg * currentMAP * 100) / 100;

    const remainingWeight = Math.max(0, currentWeight - weightKg);
    const remainingValue = remainingWeight > 0 ? Math.max(0, currentValue - consumedCost) : 0;

    await tx.siloInventory.update({
      where: { id: silo.id },
      data: {
        weightKg: remainingWeight,
        totalValue: remainingValue,
      },
    });

    return consumedCost;
  }

  /**
   * Add finished White Pappu to finished goods silo and recalculate its MAP valuation.
   */
  static async updateFinishedPappuInventory(
    tx: Prisma.TransactionClient,
    weightKg: number,
    cost: number
  ) {
    const silo = await tx.siloInventory.findFirst({
      where: { itemType: 'WHITE_PAPPU', location: 'Finished Silo' },
    });

    if (silo) {
      const newWeight = silo.weightKg + weightKg;
      const newValue = new Prisma.Decimal(silo.totalValue).plus(cost);
      return await tx.siloInventory.update({
        where: { id: silo.id },
        data: {
          weightKg: newWeight,
          totalValue: newValue,
        },
      });
    } else {
      return await tx.siloInventory.create({
        data: {
          itemType: 'WHITE_PAPPU',
          location: 'Finished Silo',
          weightKg,
          totalValue: cost,
        },
      });
    }
  }

  /**
   * Consume finished White Pappu during dispatches. Calculates COGS based on current finished MAP.
   */
  static async consumeFinishedPappuInventory(
    tx: Prisma.TransactionClient,
    weightKg: number
  ): Promise<number> {
    const silo = await tx.siloInventory.findFirst({
      where: { itemType: 'WHITE_PAPPU', location: 'Finished Silo' },
    });

    if (!silo || silo.weightKg <= 0) {
      return 0;
    }

    const currentWeight = silo.weightKg;
    const currentValue = Number(silo.totalValue);
    const currentMAP = currentValue / currentWeight;

    const consumedCOGS = Math.round(weightKg * currentMAP * 100) / 100;

    const remainingWeight = Math.max(0, currentWeight - weightKg);
    const remainingValue = remainingWeight > 0 ? Math.max(0, currentValue - consumedCOGS) : 0;

    await tx.siloInventory.update({
      where: { id: silo.id },
      data: {
        weightKg: remainingWeight,
        totalValue: remainingValue,
      },
    });

    return consumedCOGS;
  }

  /**
   * Fetch current Moving Average Price per kg for any item/location.
   */
  static async getMAP(itemType: string, location: string): Promise<number> {
    const silo = await prisma.siloInventory.findFirst({
      where: { itemType, location },
    });
    if (!silo || silo.weightKg <= 0) return 0;
    return Number(silo.totalValue) / silo.weightKg;
  }

  /**
   * Helper to retrieve all inventory silos.
   */
  static async listSilos() {
    return await prisma.siloInventory.findMany();
  }
}
