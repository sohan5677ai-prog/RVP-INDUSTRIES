import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Recycle } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import SalesProduct from './SalesProduct';
import PreCleanerDust from './PreCleanerDust';

/** Which tab to open first, based on the route the user arrived from. */
function defaultTabFor(pathname: string): string {
  if (pathname.includes('waste')) return 'waste';
  return 'precleaner-dust';
}

export default function ByproductSales() {
  const { pathname } = useLocation();
  const [tab, setTab] = useState(() => defaultTabFor(pathname));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Recycle}
        title="Tamarind Byproducts"
        description="Waste and the pre-cleaner byproducts all sell from the single 10% pool. Every sale here draws that pool down."
      />

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList>
          <TabsTrigger value="precleaner-dust">Pre Cleaner Dust</TabsTrigger>
          <TabsTrigger value="waste">Tamarind Waste</TabsTrigger>
          <TabsTrigger value="nalla-pokkulu">Nalla Pokkulu</TabsTrigger>
          <TabsTrigger value="nalla-chintapandu">Nalla Chintapandu</TabsTrigger>
        </TabsList>

        <TabsContent value="precleaner-dust">
          <PreCleanerDust />
        </TabsContent>
        <TabsContent value="waste">
          <SalesProduct product="WASTE" hideHeader />
        </TabsContent>
        <TabsContent value="nalla-pokkulu">
          <SalesProduct product="NALLA_POKKULU" hideHeader />
        </TabsContent>
        <TabsContent value="nalla-chintapandu">
          <SalesProduct product="NALLA_CHINTAPANDU" hideHeader />
        </TabsContent>
      </Tabs>
    </div>
  );
}
