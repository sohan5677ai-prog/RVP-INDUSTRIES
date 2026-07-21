export type Role = 'ADMIN' | 'USER' | 'OWNER' | 'DEVELOPER';
export type PartyType = 'SUPPLIER' | 'BUYER' | 'BOTH' | 'HAMALI_TEAM';

export interface User {
  id: string;
  name: string;
  username: string;
  role: Role;
  createdAt?: string;
}

export interface Party {
  id: string;
  name: string;
  nickname?: string | null;
  type: PartyType;
  phone: string | null;
  email?: string | null;
  address: string | null;
  state: string | null;
  pincode?: string | null;
  gstin: string | null;
  destination: string | null;
  locationLink?: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  commodities: Commodity[];
  createdAt: string;
}

export type Commodity = 'BLACK_SEED' | 'PAPPU' | 'HUSK' | 'TAMARIND_SHELL' | 'TAMARIND_WASTE' | 'TPS_BROKENS' | 'PRECLEANER_DUST' | 'NALLA_POKKULU' | 'NALLA_CHINTAPANDU';

export interface Broker {
  id: string;
  name: string;
  phone: string | null;
}

export type POStatus = 'PENDING' | 'ARRIVED' | 'COMPLETED' | 'CANCELLED';

export interface WeightVerification {
  id: string;
  purchaseId: string;
  billingWeightKg: number;
  partyKataKg: number;
  rvpKataKg: number;
  referenceKg: number;
  diffKg: number;
  exempt: boolean;
  finalWeightKg: number;
  pricePerKg: string;
  totalAmount: string;
  selfVehicleHamali?: string;
  selfVehicleKata?: string;
  createdAt: string;
}


export interface Purchase {
  id: string;
  stockInId: string;
  netWeightKg: number;
  hamaliRate: string;
  hamaliCharge: string;
  kataFee: string;

  freightCharge?: string;
  discountType?: DiscountType | null;
  discountValue?: string;
  purchaseDate?: string;
  createdAt: string;
  verification?: WeightVerification | null;
}

export interface StockTransfer {
  id: string;
  fromLocation: string;
  toLocation: string;
  weightKg: number;
  lorryNumber: string | null;
  transportCharge: string;
  loadingHamali: string;
  unloadingHamali: string;

  hamaliMargin: string;
  interestCharge: string;
  interestDays: number;
  interestRatePct: string;
  seedCostMoved: string;
  movedValue: string;
  transferDate: string;
  createdAt: string;
}

export type LoanStatus = 'OPEN' | 'CLOSED';

export interface LoanRepayment {
  id: string;
  loanId: string;
  amount: string;
  date: string;
  reference: string | null;
  createdAt: string;
}

export interface BankLoan {
  id: string;
  name: string | null;
  personName: string | null;
  loanRef: string | null;
  bankName: string | null;
  location?: string | null;
  principal: string;
  drawdownDate: string;
  interestRatePct: string;
  status: LoanStatus;
  closedDate: string | null;
  notes: string | null;
  createdAt: string;
  repayments: LoanRepayment[];
  // Server-computed
  repaidAmount: number;
  outstanding: number;
  accruedInterestToDate: number;
}

export interface LoanSummary {
  rate: number;
  totalOutstanding: number;
  totalAccruedInterest: number;
  interestCapitalised: number;
  earliestOpenLoanDate: string | null;
}

export interface LoansResponse {
  loans: BankLoan[];
  summary: LoanSummary;
}

export interface ShellTransfer {
  id: string;
  fromLocation: string;
  toLocation: string;
  weightKg: number;
  lorryNumber: string | null;
  hamaliCharge: string;
  transportCharge: string;
  totalCost: string;
  transferDate: string;
  createdAt: string;
}

export interface HuskTransfer {
  id: string;
  fromLocation: string;
  toLocation: string;
  weightKg: number;
  lorryNumber: string | null;
  hamaliCharge: string;
  transportCharge: string;
  totalCost: string;
  transferDate: string;
  createdAt: string;
}

export interface DustPurchase {
  id: string;
  partyId: string;
  party: { id: string; name: string } | null;
  purchaseDate: string;
  weightKg: number;
  pricePerKg: string;
  amount: string;
  lorryNumber: string | null;
  invoiceNumber: string | null;
  createdAt: string;
}

export interface StockIn {
  id: string;
  purchaseOrderId: string;
  arrivalDate: string;
  lorryNumber: string;
  invoiceNumber: string;
  rvpFirstWeightKg: number;
  rvpSecondWeightKg: number;
  rvpKataKg: number;
  // Net typed straight in (spot/URP, no tare weighment): rvpFirstWeightKg = net.
  directNet?: boolean;
  billingWeightKg: number;
  partyKataKg: number;
  invoiceFileUrl: string;
  loadingLocation: 'RVP' | 'PGR COLD' | 'Murugan' | 'KNM Multi';
  freightCharge: string;
  selfVehicle: boolean;
  createdAt: string;
  purchase?: Purchase | null;
  purchaseOrder?: (PurchaseOrder & { party?: Party }) | null;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  poDate: string;
  partyId: string;
  party?: Party;
  pricePerKg: string;
  priceType?: 'BASE' | 'DELIVERY';
  plannedLocation?: 'RVP' | 'STOCK';
  hasGst?: boolean;
  gstAmount?: string;
  tonnageKg: number;
  lorryCount?: number | null;
  poGroupId?: string | null;
  status: POStatus;
  createdBy: string;
  createdAt: string;
  stockIn?: StockIn | null;
  stockIns?: { id: string }[] | null;
  poSeriesKey?: string | null;
  poSerial?: number | null;
  poFy?: string | null;
}

// Order-level: PENDING → PARTIAL (some dispatched) → DISPATCHED (fully).
// Dispatch-level: DISPATCHED → DELIVERED.
export type SaleStatus = 'PENDING' | 'PARTIAL' | 'DISPATCHED' | 'DELIVERED';
export type SaleProduct = 'PAPPU' | 'HUSK' | 'WASTE' | 'TPS' | 'SHELL' | 'PRECLEANER_DUST' | 'NALLA_POKKULU' | 'NALLA_CHINTAPANDU';

// A single physical dispatch (one lorry) shipped against a SaleOrder.
export interface SaleDispatch {
  id: string;
  saleOrderId: string;
  saleOrder?: SaleOrder;
  dispatchDate: string;
  weightKg: number; // actual dispatched weight, per RVP kata (kg)
  gstAmount: string;
  freightCharge: string;
  status: SaleStatus; // DISPATCHED | DELIVERED
  vehicleNumber: string | null;
  kataFileUrl?: string | null;
  transportProvider?: string | null; // 'SURYA' | 'KNM' | 'OTHER'
  customRetention?: string | number | null;
  receivedDate?: string | null;
  deliveredDate?: string | null;
  buyerKataKg?: number | null;
  internalWeightKg?: number | null;
  internalWeightProfitAmount?: string | number | null;
  shortageKg?: number | null;
  creditNoteAmount?: string | number | null;
  tdsAmount?: string | number | null;
  buyerKataFileUrl?: string | null;
  invoiceNumber: string | null;
  invoiceSeq?: number | null;
  invoiceFy?: string | null;
  invoiceDate?: string | null;
  createdAt: string;
  // Buyer receipts linked to this shipment (embedded by the sales list so the
  // page can show it as Paid once cleared).
  receipts?: Receipt[];

  // E-Invoice (IRN) details
  irn?: string | null;
  irnAckNo?: string | null;
  irnAckDate?: string | null;
  irnSignedQr?: string | null;
  irnStatus?: string | null;
  irnCancelledDate?: string | null;

  // E-Way Bill details
  ewbNumber?: string | null;
  ewbDate?: string | null;
  ewbValidUpto?: string | null;
  ewbStatus?: string | null;
  ewbCancelledDate?: string | null;
  ewbDistance?: number | null;
}

export interface SaleOrder {
  id: string;
  saleDate: string;
  product: SaleProduct;
  buyerId: string;
  buyer?: Party;
  brokerId: string | null;
  broker?: Broker | null;
  tonnageKg: number; // total weight ORDERED, per RVP kata (kg)
  ratePerKg: string;
  gstAmount: string;
  gstExempt: boolean;
  brokerageRatePerKg: string;
  destination: string | null;
  freightCharge: string;
  status: SaleStatus;
  marginOverride: boolean;
  dueDays?: number | null;
  reminderDate?: string | null;
  // Dispatches (shipments) + server-computed fulfilment fields.
  dispatches?: SaleDispatch[];
  dispatchedKg?: number;
  remainingKg?: number;
  createdAt: string;
}

export type NoteStatus = 'ISSUED' | 'CANCELLED';

interface NoteBase {
  id: string;
  noteNumber: string;
  noteSeq: number;
  noteFy: string;
  noteDate: string;
  partyId: string;
  party?: Party;
  saleDispatchId?: string | null;
  saleDispatch?: SaleDispatch | null;
  reason: string;
  taxableValue: string;
  gstRate: string;
  gstAmount: string;
  totalAmount: string;
  status: NoteStatus;
  createdAt: string;
}

export type CreditNote = NoteBase;
export type DebitNote = NoteBase;

// A shortage already posted to the party ledger (dispatch or receipt level) with
// no formal CreditNote raised yet — surfaced on the Credit/Debit Notes page so it
// can be turned into an actual document.
export interface PendingCreditNote {
  saleDispatchId: string;
  invoiceNumber: string | null;
  date: string;
  partyId: string;
  partyName: string;
  shortageKg: number | null;
  taxableValue: number;
  gstRate: number;
  totalAmount: number;
  source: 'DISPATCH' | 'RECEIPT';
}

export type EmailDocumentType = 'INVOICE' | 'EWB' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
export type EmailStatus = 'SENT' | 'FAILED';

export interface EmailLog {
  id: string;
  partyId: string;
  party?: Party;
  documentType: EmailDocumentType;
  saleDispatchId?: string | null;
  creditNoteId?: string | null;
  debitNoteId?: string | null;
  referenceLabel: string;
  recipientEmail: string;
  subject: string;
  resendMessageId?: string | null;
  status: EmailStatus;
  errorMessage?: string | null;
  sentAt: string;
}

export interface CompanyProfile {
  id: string;
  name: string;
  address: string | null;
  gstin: string | null;
  stateName: string | null;
  stateCode: string | null;
  pincode?: string | null;
  contact: string | null;
  bankAccountName: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranchIfsc: string | null;
  invoicePrefix: string;
  companyVehicles?: string | null;
  ownerWhatsappNumber?: string | null;
  whatsappTestMode?: boolean;
  whatsappTestNumber?: string | null;
  freightRetentionPerTrip?: string | number;
  invoiceLayout?: string | null;

  // TaxPro GSP Config
  taxproGspId?: string | null;
  taxproGspSecret?: string | null;
  taxproGstUser?: string | null;
  taxproGstPass?: string | null;
  taxproSandbox?: boolean;
}

export interface ProductionCostComponent {
  id?: string;
  name: string;
  ratePerKg: string | number;
  sortOrder?: number;
}

export interface ProductTaxInfo {
  id: string;
  product: SaleProduct;
  hsn: string | null;
  hsnExempt: string | null;
  description: string | null;
  gstRate: number | string | null; // GST % (Prisma Decimal serializes as string)
}

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type DiscountType = 'WEIGHT' | 'PRICE' | 'AMOUNT';

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  debits: number;
  credits: number;
  balance: number;
}

export interface JournalEntry {
  id: string;
  date: string;
  reference: string | null;
  description: string;
  createdAt: string;
  lines: JournalLine[];
}

export interface JournalLine {
  id: string;
  journalEntryId: string;
  accountId: string;
  account?: Account;
  debit: string;
  credit: string;
  costCenter: string | null;
}

// ── Tally-style grouped chart of accounts ──
export type GroupNature = 'ASSETS' | 'LIABILITIES' | 'INCOME' | 'EXPENSES';
export type StatementType = 'BALANCE_SHEET' | 'PROFIT_LOSS';

export interface LedgerNode {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  openingBalance: number;
  debits: number;
  credits: number;
  closing: number; // signed: +Dr / −Cr
}

export interface GroupNode {
  id: string;
  name: string;
  nature: GroupNature;
  statement: StatementType;
  sortOrder: number;
  ledgers: LedgerNode[];
  children: GroupNode[];
  subtotal: number; // signed
}

// ── Balance Sheet / Profit & Loss report payloads (display amounts: normal-positive) ──
export interface ReportLedger {
  code: string;
  name: string;
  amount: number;
}
export interface ReportGroup {
  name: string;
  amount: number;
  code?: string;
  ledgers?: ReportLedger[];
  children?: ReportGroup[];
}
export interface BalanceSheet {
  asOf: string;
  liabilities: ReportGroup[];
  assets: ReportGroup[];
  totals: { liabilities: number; assets: number; difference: number; balanced: boolean };
  profitAndLoss: { totalIncome: number; totalExpenses: number; netProfit: number };
}
export interface ProfitLoss {
  period: string;
  pappu: { profitLoss: number; orders: number };
  huskPool: {
    byproductIncome: number;
    byproducts: { product: string; amount: number }[];
    overheadExpenses: number;
    overheadLedgers: { code: string; name: string; amount: number }[];
    net: number;
    isDeficit: boolean;
  };
  totals: { netProfit: number; isProfit: boolean };
}

export interface FreightRate {
  id: string;
  destination: string;
  ratePerTonne: string;
  updatedAt: string;
}

export interface HamaliRate {
  id: string;
  key: string;
  label: string;
  ratePerTonne: string; // Total ₹/tonne
  lorryPerTonne: string; // collected from the driver (off freight)
  marginPerTonne: string; // company P/L benefit
  isCustom: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface SiloInventory {
  id: string;
  itemType: string;
  location: string;
  weightKg: number;
  totalValue: string;
  updatedAt: string;
}

export type PaymentType =
  | 'SUPPLIER'
  | 'TRANSPORTER_INWARD'
  | 'TRANSPORTER_OUTWARD'
  | 'BROKER'
  | 'TRANSPORT'
  | 'OTHER'
  | 'DIESEL'
  | 'ELECTRICITY'
  | 'HAMALI'
  | 'MAINTENANCE'
  | 'DRAWINGS'
  | 'GUNNY_BAGS';

export interface Payment {
  id: string;
  date: string;
  amount: string;
  type: PaymentType;
  partyId: string | null;
  purchaseId?: string | null;
  party?: Party | null;
  brokerId: string | null;
  broker?: Broker | null;
  lorryNumber?: string | null;
  payee?: string | null;
  reference?: string | null;
  description?: string | null;
  hamaliVerificationId?: string | null;
}

export interface OutstandingBalance {
  partyId: string;
  partyName: string;
  balance: number; // positive = they owe us, negative = we owe them
}

export interface BankAccount {
  id: string;
  bankName: string;
  accountNumber: string;
  ifscCode: string;
  branch?: string;
  holderName: string;
  balance: number;
}

export type ManualHamaliType =
  | 'BAG_CUTTING_NORMAL'
  | 'BAG_CUTTING_DISTANCE'
  | 'PAPPU_NET'
  | 'HUSK_PACKING'
  | 'TPS_BROKENS_PACKING'
  | 'TAMARIND_BYPRODUCTS_PACKING'
  | 'MISC'
  | 'PAID';

export interface ManualHamaliCost {
  id: string;
  date: string;
  type: ManualHamaliType;
  bags: number | null;
  ratePerBag: string | null;
  amount: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

// A reconciliation checkpoint on the Hamali Report: crew dues verified with the
// crew through `asOfDate`. Verify-only - no money movement.
export interface HamaliVerification {
  id: string;
  asOfDate: string;
  periodStart: string | null;
  crewTotal: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  // Crew-settlement payments booked against this squared-off period.
  payments?: { id: string; amount: string; date: string; reference: string | null }[];
}

export type ReceiptType =
  | 'BUYER'
  | 'GUNNY_BAGS_SALE'
  | 'SCRAP_SALE'
  | 'HAMALI_INCOME'
  | 'INTEREST_INCOME'
  | 'OTHER';

export interface Receipt {
  id: string;
  date: string;
  amount: string;
  tdsAmount: string | null;
  shortageAmount: string | null;
  type: ReceiptType;
  partyId: string | null;
  saleDispatchId?: string | null;
  party?: Party | null;
  payer: string | null;
  reference: string | null;
  description: string | null;
  journalEntryId: string | null;
  createdAt: string;
}

// --- Party Ledger -----------------------------------------------------------

export type LedgerKind = 'PURCHASE' | 'SALE' | 'PAYMENT' | 'RECEIPT' | 'CREDIT_NOTE' | 'TDS' | 'SHORTAGE';
export type BalanceType = 'DR' | 'CR';
export type BunkerPlace = 'A' | 'B';

export interface PartyLedgerSummary {
  totalDebit: number;
  totalCredit: number;
  balance: number; // absolute value
  balanceType: BalanceType;
  purchaseTotal: number;
  saleTotal: number;
  paidTotal: number;
  receivedTotal: number;
  totalBusiness: number;
  transactionCount: number;
  pendingCount: number;
  lastTxnDate: string | null;
}

export type PartyLedgerRow = Party & PartyLedgerSummary;

export interface PartyLedgerTxn {
  id: string;
  date: string;
  kind: LedgerKind;
  particulars: string;
  invoiceNumber: string | null;
  vehicleNumber: string | null;
  reference: string | null;
  utr: string | null;
  transferredDate: string | null;
  weightKg: number | null;
  ratePerKg: number | null;
  product: string | null;
  debit: number;
  credit: number;
  status: string;
  runningBalance: number;
}

export interface PartyLedgerDetail {
  party: Party;
  summary: PartyLedgerSummary;
  transactions: PartyLedgerTxn[];
}

// --- GST report -------------------------------------------------------------

export interface GstSalesLine {
  id: string;
  date: string;
  invoiceNumber: string | null;
  partyName: string;
  gstin: string | null;
  stateName: string | null;
  product: string;
  weightKg: number;
  taxableValue: number;
  gstRate: number;
  gstAmount: number;
  igst: number;
  cgst: number;
  sgst: number;
  invoiceTotal: number;
}

export interface GstNoteLine {
  id: string;
  date: string;
  noteNumber: string;
  partyName: string;
  gstin: string | null;
  reason: string;
  taxableValue: number;
  gstRate: number;
  gstAmount: number;
  igst: number;
  cgst: number;
  sgst: number;
  total: number;
}

export interface GstPurchaseLine {
  id: string;
  date: string;
  invoiceNumber: string;
  poNumber: string | null;
  partyName: string;
  gstin: string | null;
  stateName: string | null;
  weightKg: number;
  taxableValue: number;
  gstRate: number;
  gstAmount: number;
  igst: number;
  cgst: number;
  sgst: number;
  invoiceTotal: number;
}

export interface GstReport {
  period: { from: string; to: string; fy: string };
  company: { name: string; gstin: string | null; stateName: string | null; stateCode: string | null } | null;
  output: {
    sales: GstSalesLine[];
    creditNotes: GstNoteLine[];
    debitNotes: GstNoteLine[];
    taxableTotal: number;
    igstTotal: number;
    cgstTotal: number;
    sgstTotal: number;
    gstTotal: number;
    cnGstTotal: number;
    dnGstTotal: number;
    netOutputTax: number;
  };
  input: {
    purchases: GstPurchaseLine[];
    taxableTotal: number;
    igstTotal: number;
    cgstTotal: number;
    sgstTotal: number;
    gstTotal: number;
  };
  summary: {
    outputTax: number;
    creditNoteTax: number;
    debitNoteTax: number;
    netOutputTax: number;
    inputTaxCredit: number;
    netPayable: number;
  };
}

// --- TDS report -------------------------------------------------------------

export interface TdsEntry {
  id: string;
  date: string;
  deductorName: string;
  gstin: string | null;
  pan: string | null;
  invoiceNumber: string | null;
  section: string;
  saleValue: number;
  tdsRate: number;
  tdsAmount: number;
  source: 'RECEIPT' | 'DISPATCH';
}

export interface TdsDeductorSummary {
  deductorName: string;
  gstin: string | null;
  pan: string | null;
  entryCount: number;
  saleValue: number;
  tdsAmount: number;
}

export interface TdsReport {
  period: { from: string; to: string; fy: string };
  entries: TdsEntry[];
  byDeductor: TdsDeductorSummary[];
  summary: {
    totalSaleValue: number;
    totalTds: number;
    entryCount: number;
    deductorCount: number;
  };
}
