export type Role = 'ADMIN' | 'MANAGER' | 'OPERATOR';
export type PartyType = 'SUPPLIER' | 'BUYER' | 'BOTH';

export interface User {
  id: string;
  name: string;
  email: string;
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
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  createdAt: string;
}

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
  pappuPrice?: PappuPrice | null;
  purchase?: (Purchase & {
    stockIn?: (StockIn & {
      purchaseOrder?: (PurchaseOrder & {
        party?: Party;
      }) | null;
    }) | null;
  }) | null;
}

export interface PappuPrice {
  id: string;
  processingId: string;
  pricePerKg: string;
  pricedDate: string;
}

export interface Purchase {
  id: string;
  stockInId: string;
  netWeightKg: number;
  hamaliRate: string;
  hamaliCharge: string;
  kataFee: string;
  discountType?: DiscountType | null;
  discountValue?: string;
  createdAt: string;
  verification?: WeightVerification | null;
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

export type SaleStatus = 'PENDING' | 'DISPATCHED' | 'COMPLETED' | 'CANCELLED';

export interface SaleDispatch {
  id: string;
  saleOrderId: string;
  invoiceFileUrl: string;
  dispatchWeightKg: number;
  buyerWeightKg?: number | null;
  creditNoteAmount?: string | null;
  creditNoteReason?: string | null;
  dispatchDate: string;
  createdAt: string;
}

export interface SaleOrder {
  id: string;
  saleDate: string;
  buyerId: string;
  buyer?: Party;
  brokerId: string | null;
  broker?: Broker | null;
  tonnageKg: number;
  ratePerKg: string;
  status: SaleStatus;
  marginOverride: boolean;
  createdAt: string;
  dispatch?: SaleDispatch | null;
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

export interface SiloInventory {
  id: string;
  itemType: string;
  location: string;
  weightKg: number;
  totalValue: string;
  updatedAt: string;
}
