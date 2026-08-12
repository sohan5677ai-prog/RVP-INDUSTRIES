import { Wallet } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import GunnyBags from '@/pages/GunnyBags';
import Electricity from '@/pages/Electricity';
import Maintenance from '@/pages/Maintenance';
import Miscellaneous from '@/pages/Miscellaneous';
import Drawings from '@/pages/Drawings';
import Interest from '@/pages/Interest';
import StorageMaintenance from '@/pages/StorageMaintenance';
import SubscriptionExpense from '@/pages/SubscriptionExpense';
import KataFeeLedger from '@/pages/KataFeeLedger';
import HamaliCompanyProfit from '@/pages/HamaliCompanyProfit';
import GunnySales from '@/pages/GunnySales';
import OtherIncome from '@/pages/OtherIncome';

/**
 * Unified Income & Expenses workspace.
 *
 * Expenses tab: the standalone operating-expense reports (Feroz Ledger/Gunny Bags,
 * Electricity, Maintenance, Miscellaneous, Drawings, Interest) plus Storage
 * Maintenance and Subscription. Every tab feeds the husk recovery pool and the
 * Profit & Loss. Subscription is the one that fills itself in: its charges are
 * generated on their renewal dates rather than typed in.
 *
 * Income tab: Kata Income, Hamali Company Profit, Gunny Sales and Other Income -
 * all four are added to the husk recovery pool as income and to the Profit &
 * Loss (Accounts section) as profit, alongside byproduct sales.
 */
export default function Expenses() {
  return (
    <div className="space-y-7">
      <PageHeader
        icon={Wallet}
        title="Income & Expenses"
        description="Every operating expense and every income stream in one place - both feed the husk recovery pool and the Profit & Loss."
      />
      <Tabs defaultValue="expenses" className="gap-5">
        <TabsList>
          <TabsTrigger value="income">Income</TabsTrigger>
          <TabsTrigger value="expenses">Expenses</TabsTrigger>
        </TabsList>

        <TabsContent value="income">
          <Tabs defaultValue="kata" className="gap-5">
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="kata">Kata Income</TabsTrigger>
              <TabsTrigger value="hamali">Hamali Company Profit</TabsTrigger>
              <TabsTrigger value="gunny-sales">Gunny Sales</TabsTrigger>
              <TabsTrigger value="other">Other Income</TabsTrigger>
            </TabsList>

            <TabsContent value="kata"><KataFeeLedger embedded /></TabsContent>
            <TabsContent value="hamali"><HamaliCompanyProfit /></TabsContent>
            <TabsContent value="gunny-sales"><GunnySales /></TabsContent>
            <TabsContent value="other"><OtherIncome embedded /></TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="expenses">
          <Tabs defaultValue="gunny" className="gap-5">
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="gunny">Feroz Ledger</TabsTrigger>
              <TabsTrigger value="electricity">Electricity</TabsTrigger>
              <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
              <TabsTrigger value="misc">Miscellaneous</TabsTrigger>
              <TabsTrigger value="drawings">Drawings</TabsTrigger>
              <TabsTrigger value="interest">Interest</TabsTrigger>
              <TabsTrigger value="storage">Storage Maintenance</TabsTrigger>
              <TabsTrigger value="subscription">Subscription</TabsTrigger>
            </TabsList>

            <TabsContent value="gunny"><GunnyBags embedded /></TabsContent>
            <TabsContent value="electricity"><Electricity embedded /></TabsContent>
            <TabsContent value="maintenance"><Maintenance embedded /></TabsContent>
            <TabsContent value="misc"><Miscellaneous embedded /></TabsContent>
            <TabsContent value="drawings"><Drawings embedded /></TabsContent>
            <TabsContent value="interest"><Interest embedded /></TabsContent>
            <TabsContent value="storage"><StorageMaintenance /></TabsContent>
            <TabsContent value="subscription"><SubscriptionExpense /></TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}
