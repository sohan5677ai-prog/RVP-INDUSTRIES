import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import { companyHamaliShare } from '../lib/calc.js';

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
      where: { itemType: 'BLACK_SEED', weightKg: { gt: 0 }, location: 'RVP' },
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

  /**
   * Reverse a pappu sale's black-seed consumption (undo a dispatch made by
   * mistake). Adds the black-seed-equivalent weight (`pappuKg / 0.60`) back to the
   * pool together with the cost that was relieved, restoring the pool's total
   * weight and value. The seed is returned to the largest existing black-seed silo
   * (or a fresh pool silo if none remain), since the original per-silo split is not
   * recorded; this keeps the pool totals and blended MAP correct.
   */
  static async restoreBlackSeedForSale(
    tx: Prisma.TransactionClient,
    pappuKg: number,
    totalCost: number
  ): Promise<void> {
    const weightKg = Math.round(pappuKg / this.PAPPU_OUTTURN);

    const silo = await tx.siloInventory.findFirst({
      where: { itemType: 'BLACK_SEED' },
      orderBy: { weightKg: 'desc' },
    });

    if (silo) {
      await tx.siloInventory.update({
        where: { id: silo.id },
        data: {
          weightKg: silo.weightKg + weightKg,
          totalValue: new Prisma.Decimal(silo.totalValue).plus(totalCost),
        },
      });
    } else {
      await tx.siloInventory.create({
        data: { itemType: 'BLACK_SEED', location: 'Black Seed Pool', weightKg, totalValue: totalCost },
      });
    }
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

  /**
   * Detailed black seed stock rows: one per recorded purchase (lorry), PLUS synthetic
   * transferred-in rows at RVP for seed moved from storage. Milling does NOT remove
   * seed from this list - raw black seed is only depleted when the finished pappu is
   * sold. Shared by getBlackSeedStock and the per-order pappu margin so both read the
   * same arrived-at-process seed timeline. Value = seed cost + the company's half of
   * the hamali.
   */
  static async computeBlackSeedRows() {
    const purchases = await prisma.purchase.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        verification: true,
        stockIn: { include: { purchaseOrder: { include: { party: true } } } },
      },
    });

    const rows = purchases.map((p) => {
      const price = p.verification ? Number(p.verification.pricePerKg) : Number(p.stockIn.purchaseOrder.pricePerKg);
      const ourHamali = companyHamaliShare(Number(p.hamaliCharge));
      const freight = Number(p.freightCharge);
      // RVP net (kata) weight of black seed received.
      const rvpNetWeightKg = p.netWeightKg;

      // Stock is valued EXCLUDING GST - the input IGST paid on a purchase is claimable
      // tax credit, not a cost of the stock. Use physical weight × price so a shortage
      // can't inflate the unit price.
      const seedCostWithoutGst = rvpNetWeightKg * price;

      const value = Math.round((seedCostWithoutGst + ourHamali + freight) * 100) / 100;

      const priceType = p.stockIn.purchaseOrder.priceType || 'BASE';
      const isBasePrice = priceType === 'BASE';
      const addedFreight = isBasePrice ? freight : 0;

      const valueExclGstAndHamali = Math.round((seedCostWithoutGst + addedFreight) * 100) / 100;
      const valueExclHamali = Math.round((seedCostWithoutGst + addedFreight) * 100) / 100;

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
        bunkerPlace: p.bunkerPlace,
        value,
        valueExclGstAndHamali,
        valueExclHamali,
        verified: !!p.verification,
        isTransferredIn: false as boolean,
        fromLocation: null as string | null,
      };
    });

    // Storage-location seed that has since moved to RVP via a StockTransfer (Stock
    // Transfer page) is physically at the process now, so it should show up here too
    // - as a synthetic row (location 'RVP') for the transferred portion, dated on the
    // TRANSFER date (not the original arrival date), since that's when it actually
    // reached the process. Depletes storage by BAND PRICE (most-expensive seed first,
    // oldest lot within a band), matching the Stock by Location / Order Planner
    // allocation engine - a transfer draws down the priciest seed first, NOT FIFO by
    // arrival date. Transfers are applied oldest-transfer-first. The original row is
    // left untouched; any untransferred remainder is still sitting in storage and stays
    // excluded, same as before.
    const storageRowsByLocation = new Map<string, typeof rows>();
    for (const row of rows) {
      if (row.location === 'RVP' || row.location === 'At process') continue;
      const list = storageRowsByLocation.get(row.location) ?? [];
      list.push(row);
      storageRowsByLocation.set(row.location, list);
    }
    for (const list of storageRowsByLocation.values()) {
      // Highest price first; oldest lot first within the same price band.
      list.sort((a, z) => (z.pricePerKg - a.pricePerKg) || (a.date.getTime() - z.date.getTime()));
    }
    // Remaining (undepleted) kg per storage row, drawn down across transfers in date order.
    const remainingByPurchaseId = new Map<string, number>();
    for (const list of storageRowsByLocation.values()) {
      for (const row of list) remainingByPurchaseId.set(row.purchaseId, row.rvpNetWeightKg);
    }

    const transfersToRvp = await prisma.stockTransfer.findMany({
      where: { toLocation: 'RVP' },
      orderBy: { transferDate: 'asc' },
    });
    for (const t of transfersToRvp) {
      let remainingTransferKg = t.weightKg;
      if (remainingTransferKg <= 0) continue;

      const addedCostPerKg = t.weightKg > 0 ? (Number(t.loadingHamali) + Number(t.unloadingHamali) + Number(t.transportCharge)) / t.weightKg : 0;

      const sourceRows = storageRowsByLocation.get(t.fromLocation) ?? [];

      for (const row of sourceRows) {
        if (remainingTransferKg <= 0) break;
        const availableKg = remainingByPurchaseId.get(row.purchaseId) ?? 0;
        if (availableKg <= 0) continue;
        const takenKg = Math.min(remainingTransferKg, availableKg);
        if (takenKg <= 0) continue;
        remainingTransferKg -= takenKg;
        remainingByPurchaseId.set(row.purchaseId, availableKg - takenKg);
        const frac = takenKg / row.rvpNetWeightKg;

        rows.push({
          ...row,
          purchaseId: `${row.purchaseId}-transfer-${t.id}`,
          date: t.transferDate,
          rvpNetWeightKg: takenKg,
          location: 'RVP',
          pricePerKg: Math.round((row.pricePerKg + addedCostPerKg) * 100) / 100,
          hamaliCharge: Math.round(row.hamaliCharge * frac * 100) / 100,
          companyHamali: Math.round(row.companyHamali * frac * 100) / 100,
          value: Math.round((row.value * frac + (takenKg * addedCostPerKg)) * 100) / 100,
          valueExclGstAndHamali: Math.round((row.valueExclGstAndHamali * frac + (takenKg * addedCostPerKg)) * 100) / 100,
          valueExclHamali: Math.round((row.valueExclHamali * frac + (takenKg * addedCostPerKg)) * 100) / 100,
          isTransferredIn: true,
          fromLocation: t.fromLocation,
        });
      }
    }

    return rows;
  }
}
