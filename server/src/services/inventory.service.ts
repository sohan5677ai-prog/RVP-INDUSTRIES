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
   * Move black seed from one silo to another. Draws `weightKg` out of the source
   * at its MAP, then adds it to the destination valued at that drawn cost plus
   * `addedCost` (the transfer's capitalised hamali/transport).
   * Returns the seed value drawn from the source.
   */
  static async transferBlackSeed(
    tx: Prisma.TransactionClient,
    fromLocation: string,
    toLocation: string,
    weightKg: number,
    addedCost: number
  ): Promise<number> {
    const seedCostMoved = await this.consumeBlackSeedInventory(tx, fromLocation, weightKg);
    await this.updateBlackSeedInventory(tx, toLocation, weightKg, seedCostMoved + addedCost);
    return seedCostMoved;
  }

  /**
   * Standard milling out-turn: 1 kg pappu comes from (1 / 0.60) kg of black seed.
   */
  static readonly PAPPU_OUTTURN = 0.6;

  /**
   * Consume the black-seed-equivalent of a pappu sale across all BLACK_SEED silos.
   * Selling `pappuKg` of pappu depletes `pappuKg / 0.60` kg of black seed from the
   * pool (oldest-cost-agnostic: drained location by location at each silo's MAP).
   * Returns total COGS = cost of the black seed consumed.
   */
  static async consumeBlackSeedForSale(
    tx: Prisma.TransactionClient,
    pappuKg: number
  ): Promise<number> {
    let remainingKg = Math.round(pappuKg / this.PAPPU_OUTTURN);
    let totalCost = 0;

    const silos = await tx.siloInventory.findMany({
      where: { itemType: 'BLACK_SEED', weightKg: { gt: 0 } },
      orderBy: { weightKg: 'desc' },
    });

    for (const silo of silos) {
      if (remainingKg <= 0) break;
      const take = Math.min(silo.weightKg, remainingKg);
      const map = Number(silo.totalValue) / silo.weightKg;
      const cost = Math.round(take * map * 100) / 100;

      const remainingWeight = silo.weightKg - take;
      const remainingValue = remainingWeight > 0
        ? Math.max(0, Number(silo.totalValue) - cost)
        : 0;

      await tx.siloInventory.update({
        where: { id: silo.id },
        data: { weightKg: remainingWeight, totalValue: remainingValue },
      });

      totalCost += cost;
      remainingKg -= take;
    }

    return Math.round(totalCost * 100) / 100;
  }

  /** Sum of the user-defined per-kg production cost components. */
  static async getProductionCostPerKg(): Promise<number> {
    const rows = await prisma.productionCostComponent.findMany();
    return rows.reduce((sum, r) => sum + Number(r.ratePerKg), 0);
  }

  /**
   * Live cost per kg of pappu: black-seed pool's blended MAP ÷ 0.60, plus the
   * configured production cost per kg. Used for the sales margin check.
   */
  static async getBlackSeedPappuCostPerKg(): Promise<number> {
    const silos = await prisma.siloInventory.findMany({
      where: { itemType: 'BLACK_SEED' },
    });
    const totalWeight = silos.reduce((s, x) => s + x.weightKg, 0);
    const totalValue = silos.reduce((s, x) => s + Number(x.totalValue), 0);
    const productionCost = await this.getProductionCostPerKg();
    if (totalWeight <= 0) return productionCost;
    return (totalValue / totalWeight) / this.PAPPU_OUTTURN + productionCost;
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
   * Add tamarind shell to a storage silo (default Rampalli) and recompute its MAP.
   * The cost is the transfer's capitalised hamali + transport.
   */
  static async addShellInventory(
    tx: Prisma.TransactionClient,
    location: string,
    weightKg: number,
    cost: number
  ) {
    const silo = await tx.siloInventory.findFirst({
      where: { itemType: 'TAMARIND_SHELL', location },
    });
    if (silo) {
      return await tx.siloInventory.update({
        where: { id: silo.id },
        data: {
          weightKg: silo.weightKg + weightKg,
          totalValue: new Prisma.Decimal(silo.totalValue).plus(cost),
        },
      });
    }
    return await tx.siloInventory.create({
      data: { itemType: 'TAMARIND_SHELL', location, weightKg, totalValue: cost },
    });
  }

  /**
   * Consume tamarind shell from a storage silo on a sale, returning COGS at the
   * silo's current MAP. Returns 0 if the silo is empty.
   */
  static async consumeShellInventory(
    tx: Prisma.TransactionClient,
    location: string,
    weightKg: number
  ): Promise<number> {
    const silo = await tx.siloInventory.findFirst({
      where: { itemType: 'TAMARIND_SHELL', location },
    });
    if (!silo || silo.weightKg <= 0) return 0;

    const currentWeight = silo.weightKg;
    const currentValue = Number(silo.totalValue);
    const map = currentValue / currentWeight;
    const consumedCost = Math.round(weightKg * map * 100) / 100;

    const remainingWeight = Math.max(0, currentWeight - weightKg);
    const remainingValue = remainingWeight > 0 ? Math.max(0, currentValue - consumedCost) : 0;

    await tx.siloInventory.update({
      where: { id: silo.id },
      data: { weightKg: remainingWeight, totalValue: remainingValue },
    });

    return consumedCost;
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
