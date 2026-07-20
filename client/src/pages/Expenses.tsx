import { Wallet } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import GunnyBags from '@/pages/GunnyBags';
import Electricity from '@/pages/Electricity';
import Maintenance from '@/pages/Maintenance';
import Drawings from '@/pages/Drawings';
import Interest from '@/pages/Interest';
import StorageMaintenance from '@/pages/StorageMaintenance';

/**
 * Unified Expenses workspace. Clubs the standalone operating-expense reports
 * (Gunny Bags, Electricity, Maintenance, Drawings, Interest) plus the new
 * Storage Maintenance tab into a single tabbed page. Every tab feeds the husk
 * recovery pool and the Profit & Loss.
 */
export default function Expenses() {
  return (
    <div className="space-y-7">
      <PageHeader
        icon={Wallet}
        title="Expenses"
        description="All operating expenses in one place. Each entry is deducted from the husk recovery pool and posts to the Profit & Loss."
      />
      <Tabs defaultValue="gunny" className="gap-5">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="gunny">Gunny Bags</TabsTrigger>
          <TabsTrigger value="electricity">Electricity</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="drawings">Drawings</TabsTrigger>
          <TabsTrigger value="interest">Interest</TabsTrigger>
          <TabsTrigger value="storage">Storage Maintenance</TabsTrigger>
        </TabsList>

        <TabsContent value="gunny"><GunnyBags embedded /></TabsContent>
        <TabsContent value="electricity"><Electricity embedded /></TabsContent>
        <TabsContent value="maintenance"><Maintenance embedded /></TabsContent>
        <TabsContent value="drawings"><Drawings embedded /></TabsContent>
        <TabsContent value="interest"><Interest embedded /></TabsContent>
        <TabsContent value="storage"><StorageMaintenance /></TabsContent>
      </Tabs>
    </div>
  );
}
