/**
 * Which of the 52 Prisma models belong to a financial year, and how each one is
 * scoped to it. See docs/fy-archive-spec.md for the reasoning behind the classes.
 *
 * Until Phase 0 adds an `fyStart` column, scoping is expressed as a business-date
 * range (`dateField`) or a relation path to the parent that owns the date
 * (`scopeVia`). Both collapse to `where: { fyStart }` once the column exists, so
 * this registry is the only file that has to change then.
 */
import { fyLabelLong, fyLabelShort } from '../lib/istDate.js';

export type ModelClass =
  /** Shared across every FY. Snapshotted into `masters/` for FK resolution. */
  | 'MASTER'
  /** Owns a business date; the FY is derived from it. */
  | 'TXN'
  /** Inherits its parent document's FY - never computes its own. */
  | 'DERIVED'
  /** Ops audit trail. Archived, but excluded from accounting reconciliation. */
  | 'LOG'
  /** Current state or a multi-year entity. Snapshotted whole, never date-sliced. */
  | 'SPANNING'
  /** Already FY-keyed by a label string. */
  | 'COUNTER'
  /** Never archived. */
  | 'EXCLUDED';

export interface ArchiveModel {
  /** Prisma model name (PascalCase). Also the archive entry's base filename. */
  name: string;
  /** PrismaClient delegate key (camelCase). */
  delegate: string;
  cls: ModelClass;
  /**
   * Position in the archive's FK-safe insert order. Written into the filename as
   * a zero-padded prefix so an importer can insert in filename order without
   * knowing the schema. Gaps are deliberate - new models slot in between.
   */
  order: number;
  /** Business-date column, for TXN and LOG models. */
  dateField?: string;
  /**
   * Prisma `where` fragment scoping a DERIVED model through its parent's date.
   * Receives the FY's half-open UTC range.
   */
  scopeVia?: (range: { from: Date; to: Date }) => Record<string, unknown>;
  /** COUNTER models: the FY label column and which label format it stores. */
  counter?: { field: string; format: 'short' | 'long' };
  /**
   * Columns stripped on export. Secrets and credentials that must never leave
   * the building in a file (see spec §2.6).
   */
  omit?: string[];
  /** Why this model is excluded / handled unusually. Surfaces in the docs. */
  note?: string;
}

const between = (range: { from: Date; to: Date }) => ({ gte: range.from, lt: range.to });

// ── Class M: Master ─────────────────────────────────────────────────────────
// No fyStart, ever. Shared across years so party ledgers and the chart of
// accounts stay continuous. Ordered so self-referential and cross-master FKs
// resolve on insert (AccountGroup's tree before Account; Party before the map).
const MASTERS: ArchiveModel[] = [
  { name: 'User', delegate: 'user', cls: 'MASTER', order: 10, omit: ['password'],
    note: 'Password hashes never leave the building; mount re-links users by username.' },
  { name: 'Party', delegate: 'party', cls: 'MASTER', order: 20 },
  { name: 'Broker', delegate: 'broker', cls: 'MASTER', order: 30 },
  { name: 'AccountGroup', delegate: 'accountGroup', cls: 'MASTER', order: 40,
    note: 'Self-referential tree - insert parents before children on mount.' },
  { name: 'Account', delegate: 'account', cls: 'MASTER', order: 50,
    note: 'openingBalance is FY-specific data on a shared master; moves to AccountOpening in Phase 0.' },
  { name: 'FreightRate', delegate: 'freightRate', cls: 'MASTER', order: 60 },
  { name: 'HamaliRate', delegate: 'hamaliRate', cls: 'MASTER', order: 70 },
  { name: 'SubscriptionPlanConfig', delegate: 'subscriptionPlanConfig', cls: 'MASTER', order: 75,
    note: 'generatedThrough is a live cursor, not FY data - it carries forward untouched.' },
  { name: 'CompanyProfile', delegate: 'companyProfile', cls: 'MASTER', order: 80,
    omit: ['taxproGspId', 'taxproGspSecret', 'taxproGstUser', 'taxproGstPass'],
    note: 'GSP credentials stripped on export, preserved on the live row.' },
  { name: 'ProductTaxInfo', delegate: 'productTaxInfo', cls: 'MASTER', order: 90 },
  { name: 'TallyLedgerMap', delegate: 'tallyLedgerMap', cls: 'MASTER', order: 100 },
];

// ── Classes T / D / L / S: the year's own rows ──────────────────────────────
// Insert order follows the FK graph: a row's referents always come first.
const TABLES: ArchiveModel[] = [
  { name: 'PurchaseOrder', delegate: 'purchaseOrder', cls: 'TXN', order: 10, dateField: 'poDate' },
  { name: 'StockIn', delegate: 'stockIn', cls: 'TXN', order: 20, dateField: 'arrivalDate' },

  // Purchase is 1:1 with StockIn and is its accounting face. It has its own
  // operator-settable purchaseDate, but scoping on that would let the seed value
  // and the supplier payable fall into different years.
  { name: 'Purchase', delegate: 'purchase', cls: 'DERIVED', order: 30,
    scopeVia: (r) => ({ stockIn: { arrivalDate: between(r) } }) },
  { name: 'WeightVerification', delegate: 'weightVerification', cls: 'DERIVED', order: 40,
    scopeVia: (r) => ({ purchase: { stockIn: { arrivalDate: between(r) } } }) },

  // Milling is its own event: seed bought in March and milled in April is FY N+1
  // production. The purchaseId FK may therefore point at the previous year - see
  // spec §1.7 mechanism (d).
  { name: 'Processing', delegate: 'processing', cls: 'TXN', order: 50, dateField: 'processDate' },

  { name: 'SaleOrder', delegate: 'saleOrder', cls: 'TXN', order: 60, dateField: 'saleDate' },
  { name: 'SaleDispatch', delegate: 'saleDispatch', cls: 'TXN', order: 70, dateField: 'dispatchDate' },
  { name: 'SaleAllocation', delegate: 'saleAllocation', cls: 'DERIVED', order: 80,
    scopeVia: (r) => ({ saleOrder: { saleDate: between(r) } }) },

  { name: 'JournalEntry', delegate: 'journalEntry', cls: 'TXN', order: 90, dateField: 'date' },
  { name: 'JournalLine', delegate: 'journalLine', cls: 'DERIVED', order: 100,
    scopeVia: (r) => ({ journalEntry: { date: between(r) } }) },

  { name: 'CreditNote', delegate: 'creditNote', cls: 'TXN', order: 110, dateField: 'noteDate' },
  { name: 'DebitNote', delegate: 'debitNote', cls: 'TXN', order: 120, dateField: 'noteDate' },

  // A drawdown spans years by design - stamping it would hide an open loan from
  // the new year. Snapshotted whole; only its repayments are date-sliced.
  { name: 'BankLoan', delegate: 'bankLoan', cls: 'SPANNING', order: 130 },
  { name: 'LoanRepayment', delegate: 'loanRepayment', cls: 'TXN', order: 140, dateField: 'date' },

  { name: 'HamaliVerification', delegate: 'hamaliVerification', cls: 'TXN', order: 150, dateField: 'asOfDate' },
  { name: 'Payment', delegate: 'payment', cls: 'TXN', order: 160, dateField: 'date' },
  { name: 'Receipt', delegate: 'receipt', cls: 'TXN', order: 170, dateField: 'date' },

  { name: 'DustPurchase', delegate: 'dustPurchase', cls: 'TXN', order: 180, dateField: 'purchaseDate' },
  { name: 'StockTransfer', delegate: 'stockTransfer', cls: 'TXN', order: 190, dateField: 'transferDate' },
  { name: 'ShellTransfer', delegate: 'shellTransfer', cls: 'TXN', order: 200, dateField: 'transferDate' },
  { name: 'HuskTransfer', delegate: 'huskTransfer', cls: 'TXN', order: 210, dateField: 'transferDate' },
  { name: 'ManualHamaliCost', delegate: 'manualHamaliCost', cls: 'TXN', order: 220, dateField: 'date' },

  { name: 'GunnyBagEntry', delegate: 'gunnyBagEntry', cls: 'TXN', order: 230, dateField: 'date' },
  { name: 'GunnySaleEntry', delegate: 'gunnySaleEntry', cls: 'TXN', order: 240, dateField: 'date' },
  { name: 'OtherIncomeEntry', delegate: 'otherIncomeEntry', cls: 'TXN', order: 250, dateField: 'date' },
  { name: 'ElectricityBill', delegate: 'electricityBill', cls: 'TXN', order: 260, dateField: 'date' },
  { name: 'MaintenanceExpense', delegate: 'maintenanceExpense', cls: 'TXN', order: 270, dateField: 'date' },
  { name: 'MiscExpense', delegate: 'miscExpense', cls: 'TXN', order: 280, dateField: 'date' },
  { name: 'SubscriptionCharge', delegate: 'subscriptionCharge', cls: 'TXN', order: 285, dateField: 'date' },
  { name: 'InterestCharge', delegate: 'interestCharge', cls: 'TXN', order: 290, dateField: 'date' },
  { name: 'TermLoanPrincipal', delegate: 'termLoanPrincipal', cls: 'TXN', order: 300, dateField: 'date' },
  { name: 'Drawing', delegate: 'drawing', cls: 'TXN', order: 310, dateField: 'date' },
  { name: 'StorageMaintenanceExpense', delegate: 'storageMaintenanceExpense', cls: 'TXN', order: 320, dateField: 'date' },
  { name: 'TallyUnmappedVoucher', delegate: 'tallyUnmappedVoucher', cls: 'TXN', order: 330, dateField: 'date' },

  // One mutable row per item/location - a balance, not an event. Captured whole
  // as a point-in-time snapshot; the immutable per-FY close snapshot arrives with
  // FyClosingStock in Phase 3.
  { name: 'SiloInventory', delegate: 'siloInventory', cls: 'SPANNING', order: 340 },

  { name: 'EmailLog', delegate: 'emailLog', cls: 'LOG', order: 350, dateField: 'sentAt' },
  { name: 'WhatsAppLog', delegate: 'whatsAppLog', cls: 'LOG', order: 360, dateField: 'createdAt' },
  { name: 'TransportConfirmation', delegate: 'transportConfirmation', cls: 'LOG', order: 370, dateField: 'createdAt' },
];

// ── Class C: FY-keyed counters ──────────────────────────────────────────────
// Carried so a re-mounted year can still reprint documents with correct numbers.
// NB the two counters store DIFFERENT label formats - poNumber.computeFY yields
// "25-26" while invoice.indianFinancialYear yields "2025-26".
const COUNTERS: ArchiveModel[] = [
  { name: 'PoSerialCounter', delegate: 'poSerialCounter', cls: 'COUNTER', order: 10,
    counter: { field: 'fy', format: 'short' } },
  { name: 'NoteSerialCounter', delegate: 'noteSerialCounter', cls: 'COUNTER', order: 20,
    counter: { field: 'fy', format: 'long' } },
];

// ── Class X: never archived ─────────────────────────────────────────────────
export const EXCLUDED: ArchiveModel[] = [
  { name: 'SlackDraft', delegate: 'slackDraft', cls: 'EXCLUDED', order: 0,
    note: 'Ephemeral Slack flow state.' },
  { name: 'Subscription', delegate: 'subscription', cls: 'EXCLUDED', order: 0,
    note: 'Vendor billing, not the client’s books.' },
  { name: 'SubscriptionPayment', delegate: 'subscriptionPayment', cls: 'EXCLUDED', order: 0,
    note: 'Contains Razorpay identifiers; no place in a file handed to a CA.' },
  { name: 'SupportTicket', delegate: 'supportTicket', cls: 'EXCLUDED', order: 0,
    note: 'Bug reports about the software, not the client’s books. Carries screen captures that may show any year’s data, so it belongs to no single FY.' },
  { name: 'SupportTicketAck', delegate: 'supportTicketAck', cls: 'EXCLUDED', order: 0,
    note: 'Who has read which developer reply. Follows SupportTicket out of the archive.' },
  { name: 'UserSession', delegate: 'userSession', cls: 'EXCLUDED', order: 0,
    note: 'Live sign-in state for the device cap. Worthless once exported and it carries IP/user-agent, so it never leaves the building.' },
];

export const ARCHIVE_MASTERS = MASTERS;
export const ARCHIVE_TABLES = TABLES;
export const ARCHIVE_COUNTERS = COUNTERS;

/** Every model that appears in an archive, in insert order within its folder. */
export const ARCHIVE_MODELS: ArchiveModel[] = [...MASTERS, ...TABLES, ...COUNTERS];

/** Folder an entry lives in, which also decides how it is scoped. */
export function folderOf(m: ArchiveModel): 'masters' | 'tables' | 'counters' {
  if (m.cls === 'MASTER') return 'masters';
  if (m.cls === 'COUNTER') return 'counters';
  return 'tables';
}

/** Archive entry path, e.g. `tables/020_StockIn.ndjson`. */
export function entryPath(m: ArchiveModel): string {
  return `${folderOf(m)}/${String(m.order).padStart(3, '0')}_${m.name}.ndjson`;
}

/**
 * Prisma `where` selecting this model's rows for one financial year.
 * `null` means "no filter" - the whole table is snapshotted (masters, spanning).
 */
export function whereForFy(
  m: ArchiveModel,
  fyStart: number,
  range: { from: Date; to: Date },
): Record<string, unknown> | null {
  switch (m.cls) {
    case 'MASTER':
    case 'SPANNING':
      return null;
    case 'TXN':
    case 'LOG':
      if (!m.dateField) throw new Error(`${m.name}: ${m.cls} model needs a dateField`);
      return { [m.dateField]: between(range) };
    case 'DERIVED':
      if (!m.scopeVia) throw new Error(`${m.name}: DERIVED model needs a scopeVia`);
      return m.scopeVia(range);
    case 'COUNTER': {
      if (!m.counter) throw new Error(`${m.name}: COUNTER model needs a counter spec`);
      const label = m.counter.format === 'short' ? fyLabelShort(fyStart) : fyLabelLong(fyStart);
      return { [m.counter.field]: label };
    }
    case 'EXCLUDED':
      throw new Error(`${m.name} is excluded from archives`);
  }
}

/** Drops the columns this model must not export. */
export function stripOmitted(m: ArchiveModel, row: Record<string, unknown>): Record<string, unknown> {
  if (!m.omit?.length) return row;
  const out = { ...row };
  for (const key of m.omit) delete out[key];
  return out;
}
