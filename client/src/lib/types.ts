export type Role = 'ADMIN' | 'USER' | 'OWNER' | 'DEVELOPER';
export type PartyType = 'SUPPLIER' | 'BUYER' | 'BOTH';

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
  type: PartyType;
  phone: string | null;
  address: string | null;
  state: string | null;
  gstin: string | null;
  destination: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  commodities: Commodity[];
  createdAt: string;
}

export type Commodity = 'BLACK_SEED' | 'PAPPU' | 'HUSK' | 'TAMARIND_SHELL' | 'TAMARIND_WASTE' | 'TPS_BROKENS';

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
  createdAt: string;
}

export interface Processing {
  id: string;
  purchaseId?: string | null;
  blackWeightKg: number;
  outTurnPct: string;
  pappuWeightKg: number;
  huskWeightKg: number;
  wasteWeightKg: number;
  lostWeightKg: number;
  overheadElectricity: string;
  overheadWages: string;
  overheadMaintenance: string;
  loadingLocation: string;
  yieldAnomaly?: boolean;
  yieldAnomalyReason?: string | null;
  processDate: string;
  purchase?: (Purchase & {
    stockIn?: (StockIn & {
      purchaseOrder?: (PurchaseOrder & {
        party?: Party;
      }) | null;
    }) | null;
  }) | null;
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
  createdAt: string;
  verification?: WeightVerification | null;
  processing?: Processing | null;
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

export interface StockIn {
  id: string;
  purchaseOrderId: string;
  arrivalDate: string;
  lorryNumber: string;
  invoiceNumber: string;
  rvpFirstWeightKg: number;
  rvpSecondWeightKg: number;
  rvpKataKg: number;
  billingWeightKg: number;
  partyKataKg: number;
  invoiceFileUrl: string;
  loadingLocation: 'At process' | 'Rampalli' | 'Murgan' | 'Multi';
  freightCharge: string;
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
  tonnageKg: number;
  lorryCount?: number | null;
  poGroupId?: string | null;
  status: POStatus;
  createdBy: string;
  createdAt: string;
  stockIn?: StockIn | null;
  stockIns?: { id: string }[] | null;
}

// Order-level: PENDING → PARTIAL (some dispatched) → DISPATCHED (fully).
// Dispatch-level: DISPATCHED → DELIVERED.
export type SaleStatus = 'PENDING' | 'PARTIAL' | 'DISPATCHED' | 'DELIVERED';
export type SaleProduct = 'PAPPU' | 'HUSK' | 'WASTE' | 'TPS' | 'SHELL';

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
  receivedDate?: string | null;
  deliveredDate?: string | null;
  buyerKataKg?: number | null;
  shortageKg?: number | null;
  creditNoteAmount?: string | number | null;
  buyerKataFileUrl?: string | null;
  invoiceNumber: string | null;
  invoiceSeq?: number | null;
  invoiceFy?: string | null;
  invoiceDate?: string | null;
  createdAt: string;

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
  brokerageRatePerKg: string;
  destination: string | null;
  freightCharge: string;
  status: SaleStatus;
  marginOverride: boolean;
  dueDays?: number | null;
  // Dispatches (shipments) + server-computed fulfilment fields.
  dispatches?: SaleDispatch[];
  dispatchedKg?: number;
  remainingKg?: number;
  createdAt: string;
}

export interface CompanyProfile {
  id: string;
  name: string;
  address: string | null;
  gstin: string | null;
  stateName: string | null;
  stateCode: string | null;
  contact: string | null;
  bankAccountName: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranchIfsc: string | null;
  invoicePrefix: string;
  companyVehicles?: string | null;
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
  income: ReportGroup[];
  expenses: ReportGroup[];
  totals: { income: number; expenses: number; netProfit: number; isProfit: boolean };
}

export interface FreightRate {
  id: string;
  destination: string;
  ratePerTonne: string;
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

export interface Payment {
  id: string;
  date: string;
  amount: string;
  type: 'SUPPLIER' | 'TRANSPORTER' | 'BROKER' | 'OTHER';
  partyId: string | null;
  party?: Party | null;
  brokerId: string | null;
  broker?: Broker | null;
  lorryNumber: string | null;
  reference: string | null;
  description: string | null;
  journalEntryId: string | null;
  createdAt: string;
}

export interface Receipt {
  id: string;
  date: string;
  amount: string;
  type: 'BUYER' | 'OTHER';
  partyId: string | null;
  party?: Party | null;
  reference: string | null;
  description: string | null;
  journalEntryId: string | null;
  createdAt: string;
}

// --- Party Ledger -----------------------------------------------------------

export type LedgerKind = 'PURCHASE' | 'SALE' | 'PAYMENT' | 'RECEIPT' | 'CREDIT_NOTE';
export type BalanceType = 'DR' | 'CR';

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
