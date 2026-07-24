import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Receipt, Landmark, Scale } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import GstReport from '@/pages/reports/GstReport';
import TdsReport from '@/pages/reports/TdsReport';

export default function TaxesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') === 'tds' ? 'tds' : 'gst';
  const [tab, setTab] = useState(initialTab);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Scale}
        title="Taxes"
        description="GST output/input tax credit reconciliation and TDS 194Q receivable reports."
      />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v);
          setSearchParams({ tab: v });
        }}
        className="space-y-6"
      >
        <TabsList className="bg-card border shadow-sm">
          <TabsTrigger value="gst" className="gap-2 text-sm font-semibold">
            <Receipt className="h-4 w-4" /> GST Report
          </TabsTrigger>
          <TabsTrigger value="tds" className="gap-2 text-sm font-semibold">
            <Landmark className="h-4 w-4" /> TDS Report
          </TabsTrigger>
        </TabsList>

        <TabsContent value="gst">
          <GstReport embedded />
        </TabsContent>

        <TabsContent value="tds">
          <TdsReport embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
