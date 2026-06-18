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
const PappuPricing = lazy(() => import('@/pages/PappuPricing'));
const PappuCalculator = lazy(() => import('@/pages/PappuCalculator'));
const StockLocation = lazy(() => import('@/pages/StockLocation'));
const BlackSeedStock = lazy(() => import('@/pages/BlackSeedStock'));
const StockByParty = lazy(() => import('@/pages/StockByParty'));
const StockByState = lazy(() => import('@/pages/StockByState'));
const SaleOrders = lazy(() => import('@/pages/SaleOrders'));
const SaleDispatch = lazy(() => import('@/pages/SaleDispatch'));
const PurchaseStatement = lazy(() => import('@/pages/PurchaseStatement'));
const PartyLedger = lazy(() => import('@/pages/PartyLedger'));
const HamaliLedger = lazy(() => import('@/pages/HamaliLedger'));
const KataFeeLedger = lazy(() => import('@/pages/KataFeeLedger'));
const Ledgers = lazy(() => import('@/pages/Ledgers'));
const JournalEntries = lazy(() => import('@/pages/JournalEntries'));

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
              <Route path="/pappu-pricing" element={<PappuPricing />} />
              <Route path="/pappu-calculator" element={<PappuCalculator />} />
              <Route path="/stock/overview" element={<BlackSeedStock />} />
              <Route path="/stock/location" element={<StockLocation />} />
              <Route path="/stock/party" element={<StockByParty />} />
              <Route path="/stock/state" element={<StockByState />} />
              <Route path="/sale-orders" element={<SaleOrders />} />
              <Route path="/sale-dispatch/:saleOrderId" element={<SaleDispatch />} />
              <Route path="/accounts/party-ledger" element={<PartyLedger />} />
              <Route path="/accounts/hamali-ledger" element={<HamaliLedger />} />
              <Route path="/accounts/kata-fee-ledger" element={<KataFeeLedger />} />
              <Route path="/accounts/chart-of-accounts" element={<Ledgers />} />
              <Route path="/accounts/journal-entries" element={<JournalEntries />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
