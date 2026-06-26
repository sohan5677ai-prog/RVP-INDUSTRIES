import { prisma } from "./lib/prisma.js";
import { Prisma } from "@prisma/client";
import { calcHamali, calcKataFee, companyHamaliShare, isVehicleExempt } from "./lib/calc.js";
import { InventoryService } from "./services/inventory.service.js";
import { LedgerService } from "./services/ledger.service.js";
import { getCompanyProfileRow } from "./controllers/settings.controller.js";
import fs from "fs";

const ENTRIES = [
  {
    dateStr: "2026-06-21",
    partyName: "Kamaraj Marthandam",
    partyId: "cmqt6xpsp00bms8h4um56tj73",
    lorryNumber: "AP39UX9108",
    weightKg: 15720,
    pricePerKg: 26.00
  },
  {
    dateStr: "2026-06-22",
    partyName: "Kamaraj Marthandam",
    partyId: "cmqt6xpsp00bms8h4um56tj73",
    lorryNumber: "AP39UX9105",
    weightKg: 14590,
    pricePerKg: 26.00
  },
  {
    dateStr: "2026-06-23",
    partyName: "DCS",
    partyId: "cmqroj7tk0000s8ekyxukhkug",
    lorryNumber: "TN30BU7477",
    weightKg: 25900,
    pricePerKg: 26.00
  },
  {
    dateStr: "2026-06-23",
    partyName: "Murali Marnalli",
    partyId: "cmqt6xp44006rs8h4ea8gbxkj",
    lorryNumber: "AP03T9630",
    weightKg: 10270,
    pricePerKg: 26.25
  }
];

export async function insertMissingStock() {
  try {
    const companyProfile = await getCompanyProfileRow();
    let log = "=== RUNNING STOCK INSERTION ===\n";

    for (const entry of ENTRIES) {
      const arrivalDate = new Date(`${entry.dateStr}T00:00:00.000Z`);
      
      // 1. Check if StockIn already exists
      const existingStockIn = await prisma.stockIn.findFirst({
        where: {
          lorryNumber: entry.lorryNumber,
          arrivalDate: arrivalDate
        }
      });

      if (existingStockIn) {
        log += `Skipping entry: Lorry ${entry.lorryNumber} on ${entry.dateStr} already exists.\n`;
        continue;
      }

      log += `Inserting entry: Lorry ${entry.lorryNumber} on ${entry.dateStr} (${entry.partyName})...\n`;

      const result = await prisma.$transaction(async (tx) => {
        // A. Create PurchaseOrder
        const poNumber = `PO-AUTO-${entry.lorryNumber}-${entry.dateStr}`;
        const po = await tx.purchaseOrder.create({
          data: {
            poNumber,
            poDate: arrivalDate,
            partyId: entry.partyId,
            pricePerKg: new Prisma.Decimal(entry.pricePerKg),
            tonnageKg: entry.weightKg,
            lorryCount: 1,
            status: "ARRIVED",
            createdBy: "System (Auto Insert)"
          }
        });

        // B. Create StockIn
        const stockIn = await tx.stockIn.create({
          data: {
            purchaseOrderId: po.id,
            arrivalDate,
            lorryNumber: entry.lorryNumber,
            invoiceNumber: `INV-${entry.lorryNumber}`,
            rvpFirstWeightKg: 25000 + entry.weightKg,
            rvpSecondWeightKg: 25000,
            rvpKataKg: entry.weightKg,
            billingWeightKg: entry.weightKg,
            partyKataKg: entry.weightKg,
            invoiceFileUrl: "",
            loadingLocation: "At process",
            freightCharge: 0
          }
        });

        // C. Create Purchase
        const isExempt = isVehicleExempt(entry.lorryNumber, companyProfile.companyVehicles);
        const hamaliCharge = calcHamali(entry.weightKg, 160, isExempt);
        const kataFee = calcKataFee(entry.weightKg, isExempt);

        const purchase = await tx.purchase.create({
          data: {
            stockInId: stockIn.id,
            netWeightKg: entry.weightKg,
            hamaliRate: 160,
            hamaliCharge: new Prisma.Decimal(hamaliCharge),
            kataFee: new Prisma.Decimal(kataFee),
            bunkerPlace: null,
            bagCount: 0,
            bagCuttingCharge: 0,
            freightCharge: 0
          }
        });

        // D. Create WeightVerification
        const baseCost = entry.weightKg * entry.pricePerKg;
        const igst = Math.round(baseCost * 0.05 * 100) / 100;
        const totalAmount = baseCost + igst;

        const verification = await tx.weightVerification.create({
          data: {
            purchaseId: purchase.id,
            billingWeightKg: entry.weightKg,
            partyKataKg: entry.weightKg,
            rvpKataKg: entry.weightKg,
            referenceKg: entry.weightKg,
            diffKg: 0,
            exempt: true,
            finalWeightKg: entry.weightKg,
            pricePerKg: new Prisma.Decimal(entry.pricePerKg),
            totalAmount: new Prisma.Decimal(totalAmount)
          }
        });

        // E. Update SiloInventory
        const ourHamali = companyHamaliShare(hamaliCharge);
        const totalInventoryCost = totalAmount + ourHamali;
        await InventoryService.updateBlackSeedInventory(
          tx,
          "At process",
          entry.weightKg,
          totalInventoryCost
        );

        // F. Post Ledger Entries
        await LedgerService.postPurchaseVerification(tx, purchase.id);

        return { po, stockIn, purchase, verification };
      });

      log += `Successfully inserted: PO ID=${result.po.id}, StockIn ID=${result.stockIn.id}, Purchase ID=${result.purchase.id}, Verification ID=${result.verification.id}\n`;
    }

    log += "=== STOCK INSERTION COMPLETE ===\n";
    fs.writeFileSync("scratch-output.txt", log);
    console.log("[AUTO-INSERT] Stock insertion complete. Details written to scratch-output.txt");
  } catch (e) {
    console.error("[AUTO-INSERT] Error during insertion:", e);
    fs.writeFileSync("scratch-output.txt", `ERROR: ${e instanceof Error ? e.message : e}`);
  }
}
