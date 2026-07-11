import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer, ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import type { Purchase, WeightVerification, StockIn, PurchaseOrder, Party } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { shortDate } from '@/lib/format';

type PurchaseDetails = Purchase & {
  verification: WeightVerification;
  stockIn: StockIn & {
    purchaseOrder: PurchaseOrder & {
      party: Party;
    };
  };
};

// Formats a number with Indian style commas
function fmt(val: number | string | null | undefined): string {
  if (val == null) return '-';
  const num = typeof val === 'string' ? Number(val) : val;
  return num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export default function PurchaseStatement() {
  const { purchaseId } = useParams<{ purchaseId: string }>();

  const { data: purchase, isLoading, error } = useQuery({
    queryKey: ['purchases', purchaseId],
    queryFn: () => api<PurchaseDetails>(`/purchases/${purchaseId}`),
    enabled: !!purchaseId,
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        Loading purchase statement…
      </div>
    );
  }

  if (error || !purchase || !purchase.verification) {
    return (
      <div className="space-y-4 p-6 text-center">
        <p className="text-destructive font-semibold">Error loading purchase statement.</p>
        <Button asChild variant="outline">
          <Link to="/purchases">Back to Purchases</Link>
        </Button>
      </div>
    );
  }

  const { verification, stockIn } = purchase;
  const party = stockIn.purchaseOrder.party;

  // Invoice Math Calculations
  const rvpKata = verification.rvpKataKg;
  const clientKata = verification.referenceKg;
  const ratePerKg = Number(verification.pricePerKg);

  const hasGst = stockIn.purchaseOrder.hasGst ?? false;
  const baseAmount = Math.round(clientKata * ratePerKg);
  const igstAmount = hasGst ? Math.round(baseAmount * 0.05) : 0;
  const totalAmount = baseAmount + igstAmount;

  const diffKg = verification.diffKg;
  const deductKg = Math.max(0, diffKg - 80);
  const kataDiffAmount = Math.round(deductKg * ratePerKg);

  // Self-vehicle hamali recovered from the party (₹80/t on their own lorry).
  const selfVehicleHamali = Math.round(Number(verification.selfVehicleHamali ?? 0));
  // Self-vehicle kata (weighbridge fee) recovered from the party on their own lorry.
  const selfVehicleKata = Math.round(Number(verification.selfVehicleKata ?? 0));

  const balancePayable = Math.round(Number(verification.totalAmount));

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-4 md:p-6">
      {/* Action Bar (hidden when printing) */}
      <div className="flex items-center justify-between print:hidden">
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
          <Link to="/purchases">
            <ArrowLeft className="h-4 w-4" /> Back to Purchases
          </Link>
        </Button>
        <Button onClick={() => window.print()} className="gap-1.5 shadow-sm hover:scale-[1.02] transition-transform duration-200">
          <Printer className="h-4 w-4" /> Print Statement
        </Button>
      </div>

      {/* Styled Statement Sheet Container */}
      <div className="bg-white text-black border border-neutral-300 rounded-md shadow-lg overflow-hidden p-6 md:p-8 font-sans print:shadow-none print:border-none print:p-0">
        
        {/* Header styling to match clean paper report */}
        <div className="text-center space-y-1 mb-6 border-b border-black pb-4">
          <h2 className="text-xl font-bold uppercase tracking-wider text-neutral-800">RVP Industries</h2>
          <p className="text-xs text-neutral-600 tracking-wide uppercase">Tamarind Seed Processing · Purchase Statement Sheet</p>
        </div>

        {/* Invoice Info Grid Table */}
        <div className="grid grid-cols-1 md:grid-cols-2 border border-black border-collapse text-sm mb-6">
          <div className="flex flex-col border-b md:border-b-0 md:border-r border-black">
            <div className="flex border-b border-black">
              <span className="w-24 font-bold border-r border-black p-2 bg-neutral-50">Name</span>
              <span className="p-2 font-semibold flex-1">{party.name}</span>
            </div>
            <div className="flex border-b border-black">
              <span className="w-24 font-bold border-r border-black p-2 bg-neutral-50">Invoice</span>
              <span className="p-2 flex-1">{stockIn.invoiceNumber}</span>
            </div>
            <div className="flex">
              <span className="w-24 font-bold border-r border-black p-2 bg-neutral-50">Dated</span>
              <span className="p-2 flex-1">{shortDate(stockIn.arrivalDate)}</span>
            </div>
          </div>

          <div className="flex flex-col">
            <div className="flex border-b border-black">
              <span className="w-32 font-bold border-r border-black p-2 bg-neutral-50">Vehicle</span>
              <span className="p-2 font-semibold flex-1">{stockIn.lorryNumber}</span>
            </div>
            <div className="flex border-b border-black">
              <span className="w-32 font-bold border-r border-black p-2 bg-neutral-50">RVP Kata</span>
              <span className="p-2 font-semibold flex-1 text-right pr-4 bg-neutral-50/50">{fmt(rvpKata)} kg</span>
            </div>
            <div className="flex">
              <span className="w-32 font-bold border-r border-black p-2 bg-neutral-50">Party Kata</span>
              <span className="p-2 font-semibold flex-1 text-right pr-4 bg-neutral-50/50">{fmt(clientKata)} kg</span>
            </div>
          </div>
        </div>

        {/* Particulars Table */}
        <div className="border border-black text-sm">
          {/* Header Row */}
          <div className="grid grid-cols-12 font-bold bg-neutral-100 border-b border-black">
            <div className="col-span-6 border-r border-black p-2.5">Particulars</div>
            <div className="col-span-2 border-r border-black p-2.5 text-right">Kgs (Qty)</div>
            <div className="col-span-2 border-r border-black p-2.5 text-right">Rate</div>
            <div className="col-span-2 p-2.5 text-right">Amount</div>
          </div>

          {/* Seed Row */}
          <div className="grid grid-cols-12 border-b border-neutral-300">
            <div className="col-span-6 border-r border-black p-2.5 font-medium">Seed</div>
            <div className="col-span-2 border-r border-black p-2.5 text-right">{fmt(clientKata)}</div>
            <div className="col-span-2 border-r border-black p-2.5 text-right">{fmt(ratePerKg)}</div>
            <div className="col-span-2 p-2.5 text-right font-medium">{fmt(baseAmount)}</div>
          </div>

          {/* IGST Row - only for GST-invoice purchases */}
          {hasGst && (
            <div className="grid grid-cols-12 border-b border-black">
              <div className="col-span-10 border-r border-black p-2.5 pl-6 text-neutral-700">Add : IGST (5%)</div>
              <div className="col-span-2 p-2.5 text-right">{fmt(igstAmount)}</div>
            </div>
          )}

          {/* Total Row */}
          <div className="grid grid-cols-12 font-semibold border-b border-black bg-neutral-50/50">
            <div className="col-span-10 border-r border-black p-2.5 text-right uppercase tracking-wider text-xs">Total</div>
            <div className="col-span-2 p-2.5 text-right">{fmt(totalAmount)}</div>
          </div>

          {/* Kata Difference Row */}
          <div className="grid grid-cols-12 border-b border-neutral-300">
            <div className="col-span-6 border-r border-black p-2.5 pl-4 flex flex-col justify-center">
              <span>Less : Kata difference</span>
              {diffKg > 0 && (
                <span className="text-[11px] text-neutral-500 font-mono">Actual diff: {fmt(diffKg)} kg (80 kg exempt)</span>
              )}
            </div>
            <div className="col-span-2 border-r border-black p-2.5 text-right flex items-center justify-end">
              {deductKg > 0 ? fmt(deductKg) : '0'}
            </div>
            <div className="col-span-2 border-r border-black p-2.5 text-right flex items-center justify-end">
              {deductKg > 0 ? fmt(ratePerKg) : '-'}
            </div>
            <div className="col-span-2 p-2.5 text-right text-red-700 flex items-center justify-end">
              {deductKg > 0 ? `(${fmt(kataDiffAmount)})` : '-'}
            </div>
          </div>

          {/* Self-vehicle Hamali Row - only when the party used their own lorry */}
          {selfVehicleHamali > 0 && (
            <div className="grid grid-cols-12 border-b border-neutral-300">
              <div className="col-span-10 border-r border-black p-2.5 pl-4 flex items-center">
                Less : Self-vehicle hamali (₹80/t on party's own lorry)
              </div>
              <div className="col-span-2 p-2.5 text-right text-red-700 flex items-center justify-end">
                ({fmt(selfVehicleHamali)})
              </div>
            </div>
          )}

          {/* Self-vehicle Kata Row - weighbridge fee on the party's own lorry */}
          {selfVehicleKata > 0 && (
            <div className="grid grid-cols-12 border-b border-neutral-300">
              <div className="col-span-10 border-r border-black p-2.5 pl-4 flex items-center">
                Less : Self-vehicle kata (weighbridge fee on party's own lorry)
              </div>
              <div className="col-span-2 p-2.5 text-right text-red-700 flex items-center justify-end">
                ({fmt(selfVehicleKata)})
              </div>
            </div>
          )}

          {/* Balance Payable Row */}
          <div className="grid grid-cols-12 font-bold bg-neutral-100 text-base">
            <div className="col-span-10 border-r border-black p-3 text-right uppercase tracking-wider">Balance Payable</div>
            <div className="col-span-2 p-3 text-right text-green-800">{fmt(balancePayable)}</div>
          </div>
        </div>

        {/* Footer Signature */}
        <div className="mt-16 flex justify-end text-xs pt-8 border-t border-dotted border-neutral-400">
          <div className="space-y-12 text-right">
            <p className="font-semibold text-neutral-500">For RVP Industries:</p>
            <p className="border-t border-neutral-300 w-32 pt-1 font-medium text-neutral-700 text-center">Authorized Sign</p>
          </div>
        </div>

      </div>

      {/* Embedded CSS for Print Layout */}
      <style>{`
        @media print {
          body {
            background-color: white !important;
            color: black !important;
          }
          .print\\:hidden {
            display: none !important;
          }
          .print\\:shadow-none {
            box-shadow: none !important;
          }
          .print\\:border-none {
            border: none !important;
          }
          .print\\:p-0 {
            padding: 0 !important;
          }
          /* Hide main layout sidebars and headers */
          header, sidebar, nav, [data-sidebar], .sidebar, .layout-header, #sidebar-container {
            display: none !important;
          }
          main {
            padding: 0 !important;
            margin: 0 !important;
            border: none !important;
          }
        }
      `}</style>
    </div>
  );
}
