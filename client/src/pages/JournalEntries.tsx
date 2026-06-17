import { useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, RefreshCcw, Tag } from 'lucide-react';
import { api } from '@/lib/api';
import type { JournalEntry } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export default function JournalEntries() {
  const { data: entries, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['journal-entries'],
    queryFn: () => api<JournalEntry[]>('/ledger/entries'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">General Journal Vouchers</h1>
          <p className="text-muted-foreground">Audit log of all double-entry transaction journals posted by the system</p>
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

      {isLoading && (
        <div className="text-center text-muted-foreground py-12">Loading audit logs…</div>
      )}

      {!isLoading && entries?.length === 0 && (
        <div className="text-center border rounded-lg bg-card text-muted-foreground py-16">
          <FileSpreadsheet className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
          <p>No journal entries have been recorded yet.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Verify a purchase or complete a milling run to trigger automatic postings.</p>
        </div>
      )}

      <div className="space-y-4">
        {entries?.map((entry) => (
          <div key={entry.id} className="border rounded-lg bg-card overflow-hidden shadow-sm">
            {/* Header info */}
            <div className="bg-muted/40 p-4 border-b flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-sm">
              <div className="space-y-1">
                <span className="font-semibold text-foreground">{entry.description}</span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Entry Date: <span className="font-medium text-foreground">{shortDate(entry.date)}</span></span>
                  <span>System ID: <span className="font-mono">{entry.id}</span></span>
                </div>
              </div>
              <div className="text-left sm:text-right shrink-0">
                {entry.reference && (
                  <Badge variant="outline" className="font-mono text-[10px] uppercase bg-card">
                    Ref: {entry.reference}
                  </Badge>
                )}
              </div>
            </div>

            {/* Account ledger breakdown table */}
            <div className="p-0 overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-card text-xs font-semibold text-muted-foreground border-b text-left uppercase tracking-wider">
                    <th className="p-3 pl-4 w-32">Account Code</th>
                    <th className="p-3">Account Name</th>
                    <th className="p-3 w-40">Cost Center</th>
                    <th className="p-3 text-right w-32">Debit (Dr)</th>
                    <th className="p-3 pr-4 text-right w-32">Credit (Cr)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entry.lines.map((line) => {
                    const isDebit = Number(line.debit) > 0;
                    return (
                      <tr key={line.id} className="hover:bg-muted/10 font-medium">
                        <td className="p-3 pl-4 font-mono text-xs text-muted-foreground">{line.account?.code}</td>
                        <td className="p-3 text-foreground font-semibold">
                          {isDebit ? '' : '\u00A0\u00A0\u00A0\u00A0To\u00A0'}
                          {line.account?.name}
                        </td>
                        <td className="p-3">
                          {line.costCenter ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-muted-foreground uppercase border rounded px-1.5 py-0.5 bg-muted/40">
                              <Tag className="h-2.5 w-2.5" />
                              {line.costCenter}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/30">—</span>
                          )}
                        </td>
                        <td className="p-3 text-right font-mono text-xs text-emerald-600 dark:text-emerald-500">
                          {isDebit ? rupees(Number(line.debit)) : ''}
                        </td>
                        <td className="p-3 pr-4 text-right font-mono text-xs text-indigo-500">
                          {!isDebit ? rupees(Number(line.credit)) : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
