import { prisma } from '../lib/prisma.js';
import { AllocationStatus } from '@prisma/client';

/** Variance threshold (2%) — below this, stock-in differences are ignored. */
const VARIANCE_THRESHOLD_PCT = 0.02;

export class AllocationService {
  /**
   * Performs Soft Allocation for a given SaleOrder.
   * It attempts to find pending/arrived POs that have expected yield capacity,
   * respecting the company's bufferStockPct rule.
   *
   * Uses `actualTonnageKg` (real arrived weight) when available, otherwise
   * falls back to `tonnageKg` (the original PO estimate).
   *
   * @returns The total weight that was successfully allocated (in kg).
   */
  static async allocateSaleOrder(saleOrderId: string, requiredWeight: number): Promise<number> {
    const saleOrder = await prisma.saleOrder.findUnique({
      where: { id: saleOrderId },
    });

    if (!saleOrder || saleOrder.product !== 'PAPPU') return 0;

    // Fetch the company buffer setting
    const profile = await prisma.companyProfile.findUnique({
      where: { id: 'default' },
    });
    const bufferPct = 0.80; // Hardcoded to 80% to override existing database value

    // Order by oldest first (FIFO), but we will filter by price ceiling
    const activePOs = await prisma.purchaseOrder.findMany({
      where: {
        status: { in: ['PENDING', 'ARRIVED'] },
      },
      include: {
        allocations: true,
      },
      orderBy: {
        pricePerKg: 'desc',
      },
    });

    const saleRate = Number(saleOrder.ratePerKg);
    const ceilingCost = saleRate * 0.6; // Assuming 60% outturn as default

    let remainingWeightToAllocate = requiredWeight;
    const originalRequired = requiredWeight;

    for (const po of activePOs) {
      if (remainingWeightToAllocate <= 0) break;
      
      const poCost = Number(po.pricePerKg);
      if (poCost > ceilingCost) {
        // Skip POs that are too expensive for this sale price
        continue;
      }

      // Use actualTonnageKg if set (lorry has arrived), else use original estimate
      const effectiveTonnageKg = po.actualTonnageKg ?? po.tonnageKg;
      const expectedYield = effectiveTonnageKg * (Number(po.expectedYieldPct) / 100);
      const isArrived = po.status === 'ARRIVED' || po.actualTonnageKg !== null;
      const allowedYield = isArrived ? expectedYield : expectedYield * bufferPct;

      const currentlyAllocated = po.allocations.reduce((sum, alloc) => sum + alloc.allocatedWeight, 0);
      const availableCapacity = allowedYield - currentlyAllocated;

      if (availableCapacity > 0) {
        const allocateAmount = Math.min(availableCapacity, remainingWeightToAllocate);
        
        await prisma.saleAllocation.create({
          data: {
            saleOrderId: saleOrder.id,
            purchaseOrderId: po.id,
            allocatedWeight: Math.round(allocateAmount),
            status: 'SOFT',
          },
        });

        remainingWeightToAllocate -= allocateAmount;
      }
    }

    // Return how much was actually allocated
    return originalRequired - remainingWeightToAllocate;
  }

  /**
   * Checks whether there is enough PO capacity to accept a new PAPPU sale order.
   * Used to BLOCK sale order creation when there are zero available POs.
   *
   * @returns An object with `canAllocate`, `totalAvailableKg`, and a human-readable `reason`.
   */
  static async checkAllocationCapacity(requiredWeightKg: number, saleRatePerKg: number, excludeSaleOrderId?: string): Promise<{
    canAllocate: boolean;
    totalAvailableKg: number;
    reason: string | null;
  }> {
    const profile = await prisma.companyProfile.findUnique({
      where: { id: 'default' },
    });
    const bufferPct = 0.80; // Hardcoded to 80% to override existing database value
    const ceilingCost = saleRatePerKg * 0.6;

    const activePOs = await prisma.purchaseOrder.findMany({
      where: {
        status: { in: ['PENDING', 'ARRIVED'] },
      },
      include: {
        allocations: true,
      },
    });

    let totalAvailableKg = 0;

    for (const po of activePOs) {
      const poCost = Number(po.pricePerKg);
      if (poCost > ceilingCost) continue;

      const effectiveTonnageKg = po.actualTonnageKg ?? po.tonnageKg;
      const expectedYield = effectiveTonnageKg * (Number(po.expectedYieldPct) / 100);
      const isArrived = po.status === 'ARRIVED' || po.actualTonnageKg !== null;
      const allowedYield = isArrived ? expectedYield : expectedYield * bufferPct;
      const currentlyAllocated = po.allocations.reduce((sum, alloc) => sum + (alloc.saleOrderId === excludeSaleOrderId ? 0 : alloc.allocatedWeight), 0);
      const available = allowedYield - currentlyAllocated;

      if (available > 0) {
        totalAvailableKg += available;
      }
    }

    if (totalAvailableKg <= 0) {
      return {
        canAllocate: false,
        totalAvailableKg: 0,
        reason: `No purchase orders available with enough capacity to back this sale. Create a new PO first, or wait for pending POs to arrive.`,
      };
    }

    if (totalAvailableKg < requiredWeightKg) {
      return {
        canAllocate: false,
        totalAvailableKg: Math.round(totalAvailableKg),
        reason: `Not enough PO capacity. Only ${Math.round(totalAvailableKg / 1000).toLocaleString()}T of pappu is available across all POs, but this sale needs ${Math.round(requiredWeightKg / 1000).toLocaleString()}T. Create more POs or reduce the sale quantity.`,
      };
    }

    return { canAllocate: true, totalAvailableKg: Math.round(totalAvailableKg), reason: null };
  }

  static async checkAndRebalancePO(purchaseOrderId: string) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { stockIns: true },
    });
    if (!po) return;

    const lorryCount = po.lorryCount || Math.max(1, Math.round(po.tonnageKg / 25000));
    
    // Only proceed if all expected lorries have arrived
    if (po.stockIns.length < lorryCount) return;

    // Only proceed if all arrived lorries have been fully weighed (both weights entered)
    const allWeighed = po.stockIns.every(si => si.rvpKataKg > 0);
    if (!allWeighed) return;

    const actualTonnageKg = po.stockIns.reduce((sum, si) => sum + si.rvpKataKg, 0);

    // If actualTonnageKg is already set and hasn't changed, don't re-trigger
    if (po.actualTonnageKg === actualTonnageKg) return;

    await prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { actualTonnageKg },
    });

    try {
      await AllocationService.rebalanceOnArrival(purchaseOrderId, actualTonnageKg);
    } catch (err) {
      console.error('[rebalanceOnArrival] Non-fatal error:', err);
    }
  }

  // Early rebalance triggered when a lorry arrives at stock-in with a weight
  // that differs from the PO estimate by more than the VARIANCE_THRESHOLD_PCT.
  static async rebalanceOnArrival(purchaseOrderId: string, actualTonnageKg: number) {
    const profile = await prisma.companyProfile.findUnique({
      where: { id: 'default' },
    });
    const bufferPct = 0.80; // Hardcoded to 80% to override existing database value

    const po = await prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: {
        allocations: {
          where: { status: 'SOFT' },
          include: { saleOrder: true },
        },
      },
    });
    if (!po) return;

    const originalTonnageKg = po.tonnageKg;
    const diffPct = Math.abs(actualTonnageKg - originalTonnageKg) / originalTonnageKg;

    // Below 2% threshold — not worth rebalancing
    if (diffPct < VARIANCE_THRESHOLD_PCT) return;

    const newExpectedYield = actualTonnageKg * (Number(po.expectedYieldPct) / 100);
    const newAllowedYield = newExpectedYield; // ARRIVED POs have no buffer restriction
    const totalAllocated = po.allocations.reduce((sum, a) => sum + a.allocatedWeight, 0);

    if (actualTonnageKg >= originalTonnageKg) {
      // Excess arrival — more capacity available, nothing to trim
      return;
    }

    // Short arrival — check if we're over-committed
    if (totalAllocated <= newAllowedYield) {
      // Still fits even with reduced tonnage — no action needed
      return;
    }

    // OVER-COMMITTED: 
    // We intentionally DO NOT trim allocations here anymore!
    // The user prefers the Price Band to act as a "minus balance account" where
    // short POs carry a negative balance that is offset by excess POs in the same band.
    return;
  }

  /**
   * The Rebalancing Engine. Called when a PO is processed and actual yield is known.
   */
  static async rebalanceAfterProcessing(purchaseOrderId: string, actualYieldKg: number) {
    // 1. Fetch all SOFT and BUMPED allocations for this PO, in FIFO order of their SaleOrder dates
    const allocations = await prisma.saleAllocation.findMany({
      where: {
        purchaseOrderId,
        status: { in: ['SOFT', 'BUMPED'] },
      },
      include: {
        saleOrder: true,
      },
      orderBy: {
        saleOrder: {
          saleDate: 'asc',
        },
      },
    });

    let availableYield = actualYieldKg;

    for (const alloc of allocations) {
      if (availableYield >= alloc.allocatedWeight) {
        // We can fully fulfill this allocation
        await prisma.saleAllocation.update({
          where: { id: alloc.id },
          data: { status: 'HARD' },
        });
        availableYield -= alloc.allocatedWeight;
      } else if (availableYield > 0) {
        // Partial fulfillment
        await prisma.saleAllocation.update({
          where: { id: alloc.id },
          data: { 
            allocatedWeight: availableYield,
            status: 'HARD' 
          },
        });
        
        const deficit = alloc.allocatedWeight - availableYield;
        availableYield = 0;

        // The deficit needs to be bumped to the next PO
        await this.bumpDeficit(alloc.saleOrderId, deficit);
      } else {
        // No yield left, entire allocation is bumped
        await prisma.saleAllocation.delete({
          where: { id: alloc.id }
        });
        await this.bumpDeficit(alloc.saleOrderId, alloc.allocatedWeight);
      }
    }

    // Note: Any remaining `availableYield` goes into the "Unallocated Finished Stock"
    // which is automatically handled by the general inventory calculation.
  }

  /**
   * Handles reallocating a deficit from a downward variation or cancellation.
   */
  private static async bumpDeficit(saleOrderId: string, deficitWeight: number) {
    // Treat the deficit exactly like a new allocation request
    // This will naturally find the next available PO based on FIFO
    await this.allocateSaleOrder(saleOrderId, deficitWeight);
  }

  /**
   * Called when a PO is cancelled to re-queue all its allocations.
   */
  static async handlePoCancellation(purchaseOrderId: string) {
    const allocations = await prisma.saleAllocation.findMany({
      where: {
        purchaseOrderId,
      },
    });

    // Delete the old allocations and re-allocate them
    for (const alloc of allocations) {
      await prisma.saleAllocation.delete({
        where: { id: alloc.id },
      });
      // Try to re-allocate
      await this.bumpDeficit(alloc.saleOrderId, alloc.allocatedWeight);
    }
  }

  /**
   * Returns the allocation health summary for all active POs and sale orders.
   * Powers the Commitment Health Dashboard.
   */
  static async getAllocationHealth() {
    const profile = await prisma.companyProfile.findUnique({
      where: { id: 'default' },
    });
    const bufferPct = 0.80; // Hardcoded to 80% to override existing database value

    const activePOs = await prisma.purchaseOrder.findMany({
      where: { status: { in: ['PENDING', 'ARRIVED'] } },
      include: {
        party: true,
        allocations: { include: { saleOrder: { include: { buyer: true } } } },
        stockIns: { select: { id: true, rvpKataKg: true } },
      },
      orderBy: { poDate: 'asc' },
    });

    const poHealth = activePOs.map(po => {
      const effectiveTonnageKg = po.actualTonnageKg ?? po.tonnageKg;
      const expectedYieldKg = effectiveTonnageKg * (Number(po.expectedYieldPct) / 100);
      const isArrived = po.status === 'ARRIVED' || po.actualTonnageKg !== null;
      const allowedYieldKg = isArrived ? expectedYieldKg : expectedYieldKg * bufferPct;
      const softAllocated = po.allocations
        .filter(a => a.status === 'SOFT')
        .reduce((sum, a) => sum + a.allocatedWeight, 0);
      const hardAllocated = po.allocations
        .filter(a => a.status === 'HARD')
        .reduce((sum, a) => sum + a.allocatedWeight, 0);
      const bumpedAllocated = po.allocations
        .filter(a => a.status === 'BUMPED')
        .reduce((sum, a) => sum + a.allocatedWeight, 0);
      const totalAllocated = softAllocated + hardAllocated + bumpedAllocated;
      const uncommitted = Math.round(allowedYieldKg) - totalAllocated;
      const utilizationPct = allowedYieldKg > 0 ? (totalAllocated / allowedYieldKg) * 100 : 0;

      let risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      if (uncommitted < 0) risk = 'CRITICAL';
      else if (utilizationPct > 95) risk = 'HIGH';
      else if (utilizationPct > 80) risk = 'MEDIUM';
      else risk = 'LOW';

      // Variance tracking
      const hasArrived = po.actualTonnageKg !== null;
      const varianceKg = hasArrived ? (po.actualTonnageKg! - po.tonnageKg) : null;
      const variancePct = hasArrived ? ((po.actualTonnageKg! - po.tonnageKg) / po.tonnageKg) * 100 : null;

      return {
        poId: po.id,
        poNumber: po.poNumber,
        party: po.party.name,
        status: po.status,
        originalTonnageKg: po.tonnageKg,
        actualTonnageKg: po.actualTonnageKg,
        effectiveTonnageKg,
        varianceKg,
        variancePct: variancePct !== null ? Math.round(variancePct * 10) / 10 : null,
        expectedPappuKg: Math.round(expectedYieldKg),
        allowedPappuKg: Math.round(allowedYieldKg),
        softAllocatedKg: softAllocated,
        hardAllocatedKg: hardAllocated,
        bumpedAllocatedKg: bumpedAllocated,
        totalAllocatedKg: totalAllocated,
        uncommittedKg: uncommitted,
        utilizationPct: Math.round(utilizationPct),
        risk,
        allocations: po.allocations.map(a => ({
          id: a.id,
          saleOrderId: a.saleOrderId,
          buyer: a.saleOrder.buyer?.name ?? 'Unknown',
          weightKg: a.allocatedWeight,
          status: a.status,
          saleDate: a.saleOrder.saleDate,
        })),
      };
    });

    // Summary
    const totalSoftKg = poHealth.reduce((s, p) => s + p.softAllocatedKg, 0);
    const totalHardKg = poHealth.reduce((s, p) => s + p.hardAllocatedKg, 0);
    const totalBumpedKg = poHealth.reduce((s, p) => s + p.bumpedAllocatedKg, 0);
    const criticalPOs = poHealth.filter(p => p.risk === 'CRITICAL').length;
    const highRiskPOs = poHealth.filter(p => p.risk === 'HIGH').length;

    // Find unallocated / under-allocated PAPPU sale orders
    const allPappuSales = await prisma.saleOrder.findMany({
      where: { product: 'PAPPU', status: { in: ['PENDING', 'PARTIAL'] } },
      include: { allocations: true, buyer: true },
      orderBy: { saleDate: 'desc' },
    });

    const unallocatedSales = allPappuSales
      .map(so => {
        const allocated = so.allocations.reduce((s, a) => s + a.allocatedWeight, 0);
        const unallocated = so.tonnageKg - allocated;
        return {
          saleOrderId: so.id,
          buyer: so.buyer?.name ?? 'Unknown',
          saleDate: so.saleDate,
          orderedKg: so.tonnageKg,
          allocatedKg: allocated,
          unallocatedKg: unallocated,
        };
      })
      .filter(s => s.unallocatedKg > 0);

    return {
      summary: {
        totalSoftKg,
        totalHardKg,
        totalBumpedKg,
        totalCommittedKg: totalSoftKg + totalHardKg + totalBumpedKg,
        criticalPOs,
        highRiskPOs,
        unallocatedSaleOrders: unallocatedSales.length,
        bufferStockPct: Math.round(bufferPct * 100),
      },
      purchaseOrders: poHealth,
      unallocatedSales,
    };
  }
}
