import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Receipt, Landmark, Scale, FileCheck2 } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import GstReport from '@/pages/Reports/GstReport';
import TdsReport from '@/pages/Reports/TdsReport';
import Gstr2bReconciliation from '@/pages/Reports/Gstr2bReconciliation';

export default function TaxesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') === 'tds' ? 'tds' : searchParams.get('tab') === 'gstr2b' ? 'gstr2b' : 'gst';
  const [tab, setTab] = useState(initialTab);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Scale}
        title="Taxes & Statutory Filings"
        description="GST output/input tax credit reconciliation, GSTR-2B purchase matching, and TDS 194Q receivable reports."
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
          <TabsTrigger value="gstr2b" className="gap-2 text-sm font-semibold">
            <FileCheck2 className="h-4 w-4 text-emerald-600" /> GSTR-2B Reconciliation
          </TabsTrigger>
          <TabsTrigger value="tds" className="gap-2 text-sm font-semibold">
            <Landmark className="h-4 w-4" /> TDS Report
          </TabsTrigger>
        </TabsList>

        <TabsContent value="gst">
          <GstReport embedded />
        </TabsContent>

        <TabsContent value="gstr2b">
          <Gstr2bReconciliation />
        </TabsContent>

        <TabsContent value="tds">
          <TdsReport embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
