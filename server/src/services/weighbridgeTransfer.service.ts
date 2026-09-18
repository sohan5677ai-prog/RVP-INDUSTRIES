import { HttpError } from '../lib/httpError.js';
import { recordStockTransfer } from '../controllers/stockTransfer.controller.js';
import { recordHuskTransfer } from '../controllers/huskTransfer.controller.js';
import { recordShellTransfer } from '../controllers/shellTransfer.controller.js';

type CompletedTransferTicket = {
  id: string;
  vehicleNumber: string;
  material: string | null;
  netWeightKg: number | null;
  isStorageTransfer: boolean;
  storageLocation: string | null;
  secondWeighedAt: Date | null;
};

const BYPRODUCT_MATERIALS = new Set([
  'TAMARIND',
  'TAMARIND SHELL',
  'TAMARIND WASTE',
  'TPS (BROKENS)',
  'PRE CLEANER DUST',
  'NALLA POKKULU',
]);

/**
 * Turn a completed internal Kata ticket into the corresponding ERP movement.
 * Each transfer table has a unique weighbridgeTicketId, so retries after a slow
 * response or double-click return the existing movement instead of moving stock twice.
 */
export async function recordAutomaticTransfer(ticket: CompletedTransferTicket) {
  if (!ticket.isStorageTransfer) return null;

  const material = String(ticket.material ?? '').trim().toUpperCase();
  const weightKg = Number(ticket.netWeightKg ?? 0);
  const storageLocation = String(ticket.storageLocation ?? '').trim();
  const transferDate = ticket.secondWeighedAt ?? new Date();

  if (!storageLocation) throw new HttpError(400, 'Storage location is required for an internal transfer');
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new HttpError(400, 'Complete both weights before creating the stock transfer');
  }

  if (material === 'TAMARIND SEED' || material === 'BLACK SEED') {
    return recordStockTransfer({
      fromLocation: storageLocation,
      toLocation: 'RVP',
      weightKg,
      lorryNumber: ticket.vehicleNumber,
      transferDate,
    }, ticket.id);
  }

  if (material === 'HUSK') {
    return recordHuskTransfer({
      toLocation: storageLocation,
      weightKg,
      lorryNumber: ticket.vehicleNumber,
      transferDate,
    }, ticket.id);
  }

  if (BYPRODUCT_MATERIALS.has(material)) {
    return recordShellTransfer({
      toLocation: storageLocation,
      material,
      weightKg,
      lorryNumber: ticket.vehicleNumber,
      transferDate,
    }, ticket.id);
  }

  throw new HttpError(
    400,
    `Automatic internal transfer is not configured for ${material || 'this material'}. Select tamarind seed, husk, or a byproduct.`,
  );
}
