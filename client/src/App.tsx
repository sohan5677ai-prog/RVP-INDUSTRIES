import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from '@/components/Layout';
import ProtectedRoute from '@/components/ProtectedRoute';
import { registerPreload } from '@/lib/preload';

function lazyWithPreload(paths: string | string[], importFn: () => Promise<any>) {
  if (Array.isArray(paths)) {
    paths.forEach((p) => registerPreload(p, importFn));
  } else {
    registerPreload(paths, importFn);
  }
  return lazy(importFn);
}

const Login = lazyWithPreload('/login', () => import('@/pages/Login'));
const Home = lazyWithPreload('/', () => import('@/pages/Home'));
const Dashboard = lazyWithPreload('/dashboard', () => import('@/pages/Dashboard'));
const Parties = lazyWithPreload('/parties', () => import('@/pages/Parties'));
const Brokers = lazyWithPreload('/brokers', () => import('@/pages/Brokers'));
const PurchaseOrders = lazyWithPreload('/purchase-orders', () => import('@/pages/PurchaseOrders'));
const StockIn = lazyWithPreload('/stock-in', () => import('@/pages/StockIn'));
const Purchases = lazyWithPreload('/purchases', () => import('@/pages/Purchases'));
const Verification = lazyWithPreload('/verification', () => import('@/pages/Verification'));

const PappuCalculator = lazyWithPreload('/pappu-calculator', () => import('@/pages/PappuCalculator'));
const StockLocation = lazyWithPreload('/stock/location', () => import('@/pages/StockLocation'));
const StockTransfer = lazyWithPreload('/stock/transfer', () => import('@/pages/StockTransfer'));
const BlackSeedStock = lazyWithPreload('/stock/overview', () => import('@/pages/BlackSeedStock'));
const StockByDate = lazyWithPreload('/stock/date', () => import('@/pages/StockByDate'));
const StockByParty = lazyWithPreload('/stock/party', () => import('@/pages/StockByParty'));
const StockByPrice = lazyWithPreload('/stock/price', () => import('@/pages/StockByPrice'));
const BankLoans = lazyWithPreload('/loans', () => import('@/pages/BankLoans'));
const StockByState = lazyWithPreload('/stock/state', () => import('@/pages/StockByState'));
const SaleOrders = lazyWithPreload('/sale-orders', () => import('@/pages/SaleOrders'));
const InvoiceView = lazyWithPreload('/sale-dispatches/:id/invoice', () => import('@/pages/InvoiceView'));
const EWayBillView = lazyWithPreload('/sale-dispatches/:id/ewaybill', () => import('@/pages/EWayBillView'));
const SalesProduct = lazyWithPreload(
  ['/sales/pappu', '/sales/tps'],
  () => import('@/pages/SalesProduct')
);
const Husk = lazyWithPreload('/sales/husk', () => import('@/pages/Husk'));
const ByproductSales = lazyWithPreload(
  ['/sales/byproducts', '/sales/shell', '/sales/waste'],
  () => import('@/pages/ByproductSales')
);
const PappuProfitLoss = lazyWithPreload('/sales/profit-loss', () => import('@/pages/PappuProfitLoss'));
const PurchaseStatement = lazyWithPreload('/purchases/:purchaseId/statement', () => import('@/pages/PurchaseStatement'));
const PartyLedger = lazyWithPreload('/accounts/party-ledger', () => import('@/pages/PartyLedger'));
const HamaliLedger = lazyWithPreload('/accounts/hamali-ledger', () => import('@/pages/HamaliLedger'));
const KataFeeLedger = lazyWithPreload('/accounts/kata-fee-ledger', () => import('@/pages/KataFeeLedger'));
const SuryaRoadTransport = lazyWithPreload('/accounts/surya-road-transport', () => import('@/pages/SuryaRoadTransport'));
const BrokerageLedger = lazyWithPreload('/accounts/brokerage-ledger', () => import('@/pages/BrokerageLedger'));
const Ledgers = lazyWithPreload('/accounts/chart-of-accounts', () => import('@/pages/Ledgers'));
const BalanceSheet = lazyWithPreload('/accounts/balance-sheet', () => import('@/pages/BalanceSheet'));
const ProfitLoss = lazyWithPreload('/accounts/profit-loss', () => import('@/pages/ProfitLoss'));
const JournalEntries = lazyWithPreload('/accounts/journal-entries', () => import('@/pages/JournalEntries'));
const Settings = lazyWithPreload('/settings', () => import('@/pages/Settings'));
const IrnEwbReport = lazyWithPreload('/reports/irn-ewb', () => import('@/pages/Reports/IrnEwbReport'));
const Payments = lazyWithPreload('/transactions/payments', () => import('@/pages/Payments'));
const Receipts = lazyWithPreload('/transactions/receipts', () => import('@/pages/Receipts'));
const SaleDues = lazyWithPreload('/reports/sale-dues', () => import('@/pages/SaleDues'));
const PurchaseDues = lazyWithPreload('/reports/purchase-dues', () => import('@/pages/PurchaseDues'));
const PaymentPlanner = lazyWithPreload('/reports/payment-planner', () => import('@/pages/PaymentPlanner'));
const InternalWeightLedger = lazyWithPreload('/reports/internal-weight-ledger', () => import('@/pages/InternalWeightLedger'));
const BrokerageDues = lazyWithPreload('/reports/brokerage-dues', () => import('@/pages/BrokerageDues'));
const FreightDues = lazyWithPreload('/reports/freight-dues', () => import('@/pages/FreightDues'));
const GunnyBags = lazyWithPreload('/reports/gunny-bags', () => import('@/pages/GunnyBags'));
const Electricity = lazyWithPreload('/reports/electricity', () => import('@/pages/Electricity'));
const Maintenance = lazyWithPreload('/reports/maintenance', () => import('@/pages/Maintenance'));
const Drawings = lazyWithPreload('/reports/drawings', () => import('@/pages/Drawings'));
const Interest = lazyWithPreload('/reports/interest', () => import('@/pages/Interest'));
const Users = lazyWithPreload('/users', () => import('@/pages/Users'));

function Fallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1b1510] text-[#c8bba6]">
      <div className="flex flex-col items-center space-y-4">
        <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center shadow-lg shadow-black/50 ring-1 ring-amber-300/20 animate-pulse">
          <span className="font-display font-semibold text-lg text-amber-50 leading-none">R</span>
        </div>
        <p className="text-xs uppercase tracking-[0.2em] text-[#c8bba6]/60 animate-pulse">
          RVP Industries
        </p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Fallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/sale-dispatches/:id/invoice" element={<InvoiceView />} />
            <Route path="/sale-dispatches/:id/ewaybill" element={<EWayBillView />} />
            <Route element={<Layout />}>
              <Route path="/" element={<Home />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/parties" element={<Parties />} />
              <Route path="/brokers" element={<Brokers />} />
              <Route path="/purchase-orders" element={<PurchaseOrders />} />
              <Route path="/stock-in" element={<StockIn />} />
              <Route path="/purchases" element={<Purchases />} />
              <Route path="/verification" element={<Verification />} />
              <Route path="/purchases/:purchaseId/statement" element={<PurchaseStatement />} />

              <Route path="/pappu-calculator" element={<PappuCalculator />} />
              <Route path="/stock/overview" element={<BlackSeedStock />} />
              <Route path="/stock/location" element={<StockLocation />} />
              <Route path="/stock/transfer" element={<StockTransfer />} />
              <Route path="/stock/date" element={<StockByDate />} />
              <Route path="/stock/party" element={<StockByParty />} />
              <Route path="/stock/price" element={<StockByPrice />} />
              <Route path="/stock/state" element={<StockByState />} />
              <Route path="/loans" element={<BankLoans />} />
              <Route path="/sale-orders" element={<SaleOrders />} />
              <Route path="/sales/pappu" element={<SalesProduct product="PAPPU" />} />
              <Route path="/sales/husk" element={<Husk />} />
              <Route path="/sales/tps" element={<SalesProduct product="TPS" />} />
              <Route path="/sales/byproducts" element={<ByproductSales />} />
              <Route path="/sales/shell" element={<ByproductSales />} />
              <Route path="/sales/waste" element={<ByproductSales />} />
              <Route path="/sales/profit-loss" element={<PappuProfitLoss />} />
              <Route path="/accounts/party-ledger" element={<PartyLedger />} />
              <Route path="/accounts/hamali-ledger" element={<HamaliLedger />} />
              <Route path="/accounts/kata-fee-ledger" element={<KataFeeLedger />} />
              <Route path="/accounts/surya-road-transport" element={<SuryaRoadTransport />} />
              <Route path="/accounts/brokerage-ledger" element={<BrokerageLedger />} />
              <Route path="/accounts/chart-of-accounts" element={<Ledgers />} />
              <Route path="/accounts/balance-sheet" element={<BalanceSheet />} />
              <Route path="/accounts/profit-loss" element={<ProfitLoss />} />
              <Route path="/accounts/journal-entries" element={<JournalEntries />} />
              <Route path="/transactions/payments" element={<Payments />} />
              <Route path="/transactions/receipts" element={<Receipts />} />
              <Route path="/reports/sale-dues" element={<SaleDues />} />
              <Route path="/reports/internal-weight-ledger" element={<InternalWeightLedger />} />
              <Route path="/reports/purchase-dues" element={<PurchaseDues />} />
              <Route path="/reports/payment-planner" element={<PaymentPlanner />} />
              <Route path="/reports/brokerage-dues" element={<BrokerageDues />} />
              <Route path="/reports/freight-dues" element={<FreightDues />} />
              <Route path="/reports/gunny-bags" element={<GunnyBags />} />
              <Route path="/reports/electricity" element={<Electricity />} />
              <Route path="/reports/maintenance" element={<Maintenance />} />
              <Route path="/reports/drawings" element={<Drawings />} />
              <Route path="/reports/interest" element={<Interest />} />
              <Route path="/reports/irn-ewb" element={<IrnEwbReport />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/users" element={<Users />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
