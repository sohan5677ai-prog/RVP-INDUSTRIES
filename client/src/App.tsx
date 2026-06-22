import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from '@/components/Layout';
import ProtectedRoute from '@/components/ProtectedRoute';

const Login = lazy(() => import('@/pages/Login'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Parties = lazy(() => import('@/pages/Parties'));
const Brokers = lazy(() => import('@/pages/Brokers'));
const PurchaseOrders = lazy(() => import('@/pages/PurchaseOrders'));
const StockIn = lazy(() => import('@/pages/StockIn'));
const Purchases = lazy(() => import('@/pages/Purchases'));
const Verification = lazy(() => import('@/pages/Verification'));
const Processing = lazy(() => import('@/pages/Processing'));
const ProcessingOutput = lazy(() => import('@/pages/ProcessingOutput'));
const PappuCalculator = lazy(() => import('@/pages/PappuCalculator'));
const StockLocation = lazy(() => import('@/pages/StockLocation'));
const StockTransfer = lazy(() => import('@/pages/StockTransfer'));
const BlackSeedStock = lazy(() => import('@/pages/BlackSeedStock'));
const StockByDate = lazy(() => import('@/pages/StockByDate'));
const StockByParty = lazy(() => import('@/pages/StockByParty'));
const BankLoans = lazy(() => import('@/pages/BankLoans'));
const StockByState = lazy(() => import('@/pages/StockByState'));
const SaleOrders = lazy(() => import('@/pages/SaleOrders'));
const InvoiceView = lazy(() => import('@/pages/InvoiceView'));
const SalesProduct = lazy(() => import('@/pages/SalesProduct'));
const TamarindShell = lazy(() => import('@/pages/TamarindShell'));
const PurchaseStatement = lazy(() => import('@/pages/PurchaseStatement'));
const PartyLedger = lazy(() => import('@/pages/PartyLedger'));
const HamaliLedger = lazy(() => import('@/pages/HamaliLedger'));
const KataFeeLedger = lazy(() => import('@/pages/KataFeeLedger'));
const SuryaRoadTransport = lazy(() => import('@/pages/SuryaRoadTransport'));
const BrokerageLedger = lazy(() => import('@/pages/BrokerageLedger'));
const Ledgers = lazy(() => import('@/pages/Ledgers'));
const JournalEntries = lazy(() => import('@/pages/JournalEntries'));
const Settings = lazy(() => import('@/pages/Settings'));
const Payments = lazy(() => import('@/pages/Payments'));
const Receipts = lazy(() => import('@/pages/Receipts'));
const SaleDues = lazy(() => import('@/pages/SaleDues'));
const PurchaseDues = lazy(() => import('@/pages/PurchaseDues'));
const BrokerageDues = lazy(() => import('@/pages/BrokerageDues'));
const FreightDues = lazy(() => import('@/pages/FreightDues'));

function Fallback() {
  return <div className="p-8 text-muted-foreground">Loading…</div>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Fallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/sale-orders/:id/invoice" element={<InvoiceView />} />
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/parties" element={<Parties />} />
              <Route path="/brokers" element={<Brokers />} />
              <Route path="/purchase-orders" element={<PurchaseOrders />} />
              <Route path="/stock-in" element={<StockIn />} />
              <Route path="/purchases" element={<Purchases />} />
              <Route path="/verification" element={<Verification />} />
              <Route path="/purchases/:purchaseId/statement" element={<PurchaseStatement />} />
              <Route path="/processing" element={<Processing />} />
              <Route path="/processing/pappu" element={<ProcessingOutput product="pappu" />} />
              <Route path="/processing/husk" element={<ProcessingOutput product="husk" />} />
              <Route path="/processing/waste" element={<ProcessingOutput product="waste" />} />
              <Route path="/pappu-calculator" element={<PappuCalculator />} />
              <Route path="/stock/overview" element={<BlackSeedStock />} />
              <Route path="/stock/location" element={<StockLocation />} />
              <Route path="/stock/transfer" element={<StockTransfer />} />
              <Route path="/stock/date" element={<StockByDate />} />
              <Route path="/stock/party" element={<StockByParty />} />
              <Route path="/stock/state" element={<StockByState />} />
              <Route path="/loans" element={<BankLoans />} />
              <Route path="/sale-orders" element={<SaleOrders />} />
              <Route path="/sales/pappu" element={<SalesProduct product="PAPPU" />} />
              <Route path="/sales/husk" element={<SalesProduct product="HUSK" />} />
              <Route path="/sales/waste" element={<SalesProduct product="WASTE" />} />
              <Route path="/sales/tps" element={<SalesProduct product="TPS" />} />
              <Route path="/sales/shell" element={<TamarindShell />} />
              <Route path="/accounts/party-ledger" element={<PartyLedger />} />
              <Route path="/accounts/hamali-ledger" element={<HamaliLedger />} />
              <Route path="/accounts/kata-fee-ledger" element={<KataFeeLedger />} />
              <Route path="/accounts/surya-road-transport" element={<SuryaRoadTransport />} />
              <Route path="/accounts/brokerage-ledger" element={<BrokerageLedger />} />
              <Route path="/accounts/chart-of-accounts" element={<Ledgers />} />
              <Route path="/accounts/journal-entries" element={<JournalEntries />} />
              <Route path="/transactions/payments" element={<Payments />} />
              <Route path="/transactions/receipts" element={<Receipts />} />
              <Route path="/reports/sale-dues" element={<SaleDues />} />
              <Route path="/reports/purchase-dues" element={<PurchaseDues />} />
              <Route path="/reports/brokerage-dues" element={<BrokerageDues />} />
              <Route path="/reports/freight-dues" element={<FreightDues />} />
              <Route path="/settings/freight-rates" element={<Settings />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
