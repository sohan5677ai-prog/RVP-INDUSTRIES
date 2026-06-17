import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Party, Purchase } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Scale, Wallet, Loader2, ArrowLeftRight, ArrowLeft } from 'lucide-react';

type PurchaseRow = Purchase & {
  stockIn?: {
    arrivalDate: string;
    invoiceNumber: string;
    lorryNumber: string;
    billingWeightKg: number;
    partyKataKg: number;
    purchaseOrder: {
      poNumber: string;
      pricePerKg: string;
      partyId: string;
    };
  };
};

export default function PartyLedger() {
  const [partyId, setPartyId] = useState<string>('ALL');

  const { data: parties, isLoading: loadingParties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });

  const suppliers = parties?.filter((p) => p.type !== 'BUYER') ?? [];

  // Filter transactions
  const partyPurchases = purchases?.filter((p) => {
    if (partyId === 'ALL') return true;
    return p.stockIn?.purchaseOrder?.partyId === partyId;
  }) ?? [];

  // Calculate Party Payout summary details
  const allSummaries = suppliers.map((sup) => {
    const supPurchases = purchases?.filter((p) => p.stockIn?.purchaseOrder?.partyId === sup.id) ?? [];
    const totalNetWeight = supPurchases.reduce((acc, p) => acc + p.netWeightKg, 0);
    const totalVerifiedWeight = supPurchases.reduce((acc, p) => acc + (p.verification?.finalWeightKg ?? 0), 0);
    const totalPayable = supPurchases.reduce((acc, p) => acc + (p.verification ? Number(p.verification.totalAmount) : 0), 0);
    const pendingVerifications = supPurchases.filter((p) => !p.verification).length;

    return {
      party: sup,
      totalNetWeight,
      totalVerifiedWeight,
      totalPayable,
      pendingVerifications,
    };
  });

  // Calculate active selected party details
  const activeParty = suppliers.find((s) => s.id === partyId);
  const activePurchases = partyPurchases;
  const activeTotalNet = activePurchases.reduce((acc, p) => acc + p.netWeightKg, 0);
  const activeTotalFinal = activePurchases.reduce((acc, p) => acc + (p.verification?.finalWeightKg ?? 0), 0);
  const activeTotalPayable = activePurchases.reduce((acc, p) => acc + (p.verification ? Number(p.verification.totalAmount) : 0), 0);
  const activePending = activePurchases.filter((p) => !p.verification).length;

  const isLoading = loadingParties || loadingPurchases;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Party Ledger</h1>
          <p className="text-muted-foreground">Detailed account statement and financial summaries per supplier</p>
        </div>
        <div className="flex items-center gap-3 w-72">
          <Label className="shrink-0 font-medium text-sm">Select Supplier</Label>
          <Select value={partyId} onValueChange={setPartyId}>
            <SelectTrigger>
              <SelectValue placeholder="All Suppliers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Suppliers (Summary)</SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : partyId === 'ALL' ? (
        // Master summary table for all suppliers
        <div className="grid gap-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Tonnage</CardTitle>
                <Scale className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{kg(purchases?.reduce((acc, p) => acc + p.netWeightKg, 0) ?? 0)}</div>
                <p className="text-[10px] text-muted-foreground mt-1">Sum of all RVP Net weights recorded</p>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Approved Payable</CardTitle>
                <Wallet className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">
                  {rupees(purchases?.reduce((acc, p) => acc + (p.verification ? Number(p.verification.totalAmount) : 0), 0) ?? 0)}
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">Sum of all approved weight payouts</p>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pending Approval</CardTitle>
                <ArrowLeftRight className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-amber-600 dark:text-amber-500">
                  {purchases?.filter((p) => !p.verification).length ?? 0} loads
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">Awaiting weight cross-verification</p>
              </CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b font-semibold text-sm">Supplier Accounts Overview</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier Name</TableHead>
                  <TableHead className="text-right">Net Weight (RVP)</TableHead>
                  <TableHead className="text-right">Verified Weight</TableHead>
                  <TableHead className="text-right">Balance Payable</TableHead>
                  <TableHead className="text-center">Pending Verifications</TableHead>
                  <TableHead className="w-36 text-center">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allSummaries.map(({ party, totalNetWeight, totalVerifiedWeight, totalPayable, pendingVerifications }) => (
                  <TableRow key={party.id}>
                    <TableCell className="font-semibold">{party.name}</TableCell>
                    <TableCell className="text-right font-medium">{kg(totalNetWeight)}</TableCell>
                    <TableCell className="text-right">{totalVerifiedWeight > 0 ? kg(totalVerifiedWeight) : '—'}</TableCell>
                    <TableCell className="text-right font-bold text-primary">{rupees(totalPayable)}</TableCell>
                    <TableCell className="text-center">
                      {pendingVerifications > 0 ? (
                        <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-500 font-semibold bg-amber-50/50 dark:bg-amber-950/20">
                          {pendingVerifications} Awaiting
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-green-500/50 text-green-600 dark:text-green-500 bg-green-50/50 dark:bg-green-950/20">
                          Clear
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Button size="sm" variant="outline" onClick={() => setPartyId(party.id)}>
                        Detailed Ledger
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        // Detailed ledger list for the selected party
        <div className="grid gap-6">
          <div className="flex justify-between items-center">
            <Button variant="ghost" size="sm" onClick={() => setPartyId('ALL')} className="gap-1.5 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> Back to Summary Overview
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card className="bg-muted/30 border shadow-sm">
              <CardHeader className="pb-1 pt-3">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Total Tonnage</span>
              </CardHeader>
              <CardContent className="pb-3">
                <span className="text-xl font-bold">{kg(activeTotalNet)}</span>
              </CardContent>
            </Card>
            <Card className="bg-muted/30 border shadow-sm">
              <CardHeader className="pb-1 pt-3">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Verified Tonnage</span>
              </CardHeader>
              <CardContent className="pb-3">
                <span className="text-xl font-bold">{kg(activeTotalFinal)}</span>
              </CardContent>
            </Card>
            <Card className="bg-muted/30 border shadow-sm">
              <CardHeader className="pb-1 pt-3">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Total Credit</span>
              </CardHeader>
              <CardContent className="pb-3">
                <span className="text-xl font-bold text-primary">{rupees(activeTotalPayable)}</span>
              </CardContent>
            </Card>
            <Card className="bg-muted/30 border shadow-sm">
              <CardHeader className="pb-1 pt-3">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Awaiting Verification</span>
              </CardHeader>
              <CardContent className="pb-3">
                <span className={`text-xl font-bold ${activePending > 0 ? 'text-amber-500' : 'text-green-500'}`}>
                  {activePending} load{activePending !== 1 && 's'}
                </span>
              </CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b flex justify-between items-center bg-muted/20">
              <span className="font-semibold text-sm">Account Ledger: <span className="text-primary">{activeParty?.name}</span></span>
              {activeParty?.address && <span className="text-xs text-muted-foreground">{activeParty.address}</span>}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>PO Reference</TableHead>
                  <TableHead>Invoice / Lorry</TableHead>
                  <TableHead className="text-right">RVP Net Wt</TableHead>
                  <TableHead className="text-right">Reference Wt</TableHead>
                  <TableHead className="text-right">Final Wt</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Credit Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activePurchases.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      No purchase transactions recorded for this supplier.
                    </TableCell>
                  </TableRow>
                ) : (
                  activePurchases.map((p) => {
                    const v = p.verification;
                    return (
                      <TableRow key={p.id}>
                        <TableCell>{shortDate(p.createdAt)}</TableCell>
                        <TableCell className="font-mono text-xs font-semibold">
                          {p.stockIn?.purchaseOrder?.poNumber ?? '—'}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">Inv {p.stockIn?.invoiceNumber}</div>
                          <div className="text-xs text-muted-foreground">{p.stockIn?.lorryNumber}</div>
                        </TableCell>
                        <TableCell className="text-right font-medium">{kg(p.netWeightKg)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {v ? kg(v.referenceKg) : '—'}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {v ? kg(v.finalWeightKg) : '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          {rupees(v ? v.pricePerKg : p.stockIn?.purchaseOrder?.pricePerKg ?? '0')}
                        </TableCell>
                        <TableCell>
                          {v ? (
                            <Badge variant={v.exempt ? 'default' : 'secondary'} className="text-[10px]">
                              {v.exempt ? 'Exempt' : 'Deducted'}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">Awaiting</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-bold text-primary">
                          {v ? rupees(v.totalAmount) : '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
