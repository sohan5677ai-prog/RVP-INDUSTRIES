import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Wallet, TrendingUp, TrendingDown, RefreshCcw } from 'lucide-react';
import { api } from '@/lib/api';
import type { Account } from '@/lib/types';
import { rupees } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function Ledgers() {
  const [activeTab, setActiveTab] = useState<string>('ALL');

  const { data: accounts, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['ledger-accounts'],
    queryFn: () => api<Account[]>('/ledger/accounts'),
  });

  const filteredAccounts = accounts?.filter((a) => activeTab === 'ALL' || a.type === activeTab) ?? [];

  // Calculate high-level financial summary cards
  const totalAssets = accounts?.filter(a => a.type === 'ASSET').reduce((sum, a) => sum + a.balance, 0) ?? 0;
  const totalLiabilities = accounts?.filter(a => a.type === 'LIABILITY').reduce((sum, a) => sum + a.balance, 0) ?? 0;
  const totalRevenue = accounts?.filter(a => a.type === 'REVENUE').reduce((sum, a) => sum + a.balance, 0) ?? 0;
  const totalExpense = accounts?.filter(a => a.type === 'EXPENSE').reduce((sum, a) => sum + a.balance, 0) ?? 0;
  const netEarnings = totalRevenue - totalExpense;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Chart of Accounts</h1>
          <p className="text-muted-foreground">General ledger balances and double-entry trial balance details</p>
        </div>
        <Button 
          variant="outline" 
          onClick={() => refetch()} 
          disabled={isLoading || isRefetching}
          className="gap-1.5"
        >
          <RefreshCcw className={`h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Financial Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border bg-card shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Assets</CardTitle>
            <Landmark className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-500">{rupees(totalAssets)}</div>
            <p className="text-[10px] text-muted-foreground mt-0.5">Inventory silos & receivables</p>
          </CardContent>
        </Card>

        <Card className="border bg-card shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Liabilities</CardTitle>
            <Wallet className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-rose-600 dark:text-rose-500">{rupees(totalLiabilities)}</div>
            <p className="text-[10px] text-muted-foreground mt-0.5">Supplier payables & accrued Hamali/Carter</p>
          </CardContent>
        </Card>

        <Card className="border bg-card shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Milling Revenues</CardTitle>
            <TrendingUp className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{rupees(totalRevenue)}</div>
            <p className="text-[10px] text-muted-foreground mt-0.5">Pappu sales revenue & byproduct resale</p>
          </CardContent>
        </Card>

        <Card className="border bg-card shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Earnings (P&L)</CardTitle>
            <TrendingDown className="h-4 w-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${netEarnings >= 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-rose-500'}`}>
              {rupees(netEarnings)}
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">Revenues minus factory labor & overheads</p>
          </CardContent>
        </Card>
      </div>

      {/* Chart of Accounts list */}
      <Tabs defaultValue="ALL" onValueChange={setActiveTab} className="space-y-4">
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="ALL">All Accounts</TabsTrigger>
            <TabsTrigger value="ASSET">Assets</TabsTrigger>
            <TabsTrigger value="LIABILITY">Liabilities</TabsTrigger>
            <TabsTrigger value="REVENUE">Revenues</TabsTrigger>
            <TabsTrigger value="EXPENSE">Expenses</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value={activeTab} className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Code</TableHead>
                <TableHead>Account Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Total Debits</TableHead>
                <TableHead className="text-right">Total Credits</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading general ledger balances…</TableCell></TableRow>
              )}
              {!isLoading && filteredAccounts.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No ledger accounts found.</TableCell></TableRow>
              )}
              {filteredAccounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono font-medium text-xs text-muted-foreground">{a.code}</TableCell>
                  <TableCell className="font-semibold text-foreground">{a.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-wider">
                      {a.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{rupees(a.debits)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{rupees(a.credits)}</TableCell>
                  <TableCell className="text-right font-semibold text-primary font-mono">{rupees(a.balance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
    </div>
  );
}
