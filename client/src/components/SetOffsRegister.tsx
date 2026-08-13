import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeftRight, Pencil, Trash2, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Party, SetOff } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { invalidateReceiptQueries } from '@/lib/receiptCache';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';
import { SetOffDialog } from '@/components/SetOffDialog';

/**
 * Register of every knock-off recorded between a party's own payable and
 * receivable. These are deliberately absent from the Payments register beside
 * it: no cash left the bank, so counting them as payments would overstate what
 * was actually spent. Both sides of each one are spelled out here instead.
 */

const legLabel = (n: string | null, fallback: string) => n ?? fallback;

const SET_OFF_EXPORT_COLUMNS: ExportColumn<SetOff>[] = [
  { header: 'Date', value: (s) => shortDate(s.date) },
  { header: 'Party', value: (s) => s.party.name },
  {
    header: 'Purchase Bills Cleared',
    value: (s) => s.purchases.map((p) => `${legLabel(p.invoiceNumber, 'no invoice')} ${rupees(p.amount)}`).join('; '),
  },
  {
    header: 'Sale Invoices Cleared',
    value: (s) => s.sales.map((d) => `${legLabel(d.invoiceNumber, 'no invoice')} ${rupees(d.amount)}`).join('; '),
  },
  { header: 'Note', value: (s) => s.note ?? '' },
  {
    header: 'Amount Set Off',
    value: (s) => rupees(s.amount),
    excel: (s) => Number(s.amount),
    numFmt: '#,##0.00',
    align: 'right',
  },
];

export function SetOffsRegister({ parties }: { parties: Party[] | undefined }) {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SetOff | null>(null);

  const { data: setOffs, isLoading } = useQuery({
    queryKey: ['set-offs'],
    queryFn: () => api<SetOff[]>('/set-offs'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/set-offs/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Set-off reversed - both bills are open again');
      // Reversing re-opens a purchase bill AND a sale invoice, so both cache
      // families have to go, same as when one is recorded.
      invalidateReceiptQueries(qc);
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['party-ledgers'] });
      qc.invalidateQueries({ queryKey: ['set-offs'] });
      qc.invalidateQueries({ queryKey: ['set-off-open'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Failed to reverse the set-off'),
  });

  const total = (setOffs ?? []).reduce((s, x) => s + Number(x.amount), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Knock-offs between a party's purchase payable and its own sale receivable. No cash
          moved on any of these, which is why they are kept out of the Payments register -
          each one clears a purchase bill and a sale invoice at the same time and leaves the
          party's ledger balance untouched.
        </p>
        <div className="flex items-center gap-2">
          <ExportButtons
            filename="Set_Offs"
            title="Set-off Register"
            subtitle={`${setOffs?.length ?? 0} set-off(s) · ${rupees(total)} knocked off`}
            columns={SET_OFF_EXPORT_COLUMNS}
            rows={setOffs ?? []}
          />
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="h-4 w-4" /> Record Set-off
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Purchase bills cleared</TableHead>
              <TableHead>Sale invoices cleared</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {!isLoading && (setOffs?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No set-offs recorded yet. Use this when a party you buy from also owes you for
                  a sale - it settles both without a payment.
                </TableCell>
              </TableRow>
            )}
            {(setOffs ?? []).map((s) => (
              <TableRow key={s.id}>
                <TableCell>{shortDate(s.date)}</TableCell>
                <TableCell className="font-medium">{s.party.name}</TableCell>
                <TableCell>
                  <div className="space-y-0.5">
                    {s.purchases.map((p) => (
                      <div key={p.legId} className="whitespace-nowrap text-xs">
                        <span className="font-mono">{legLabel(p.invoiceNumber, p.kind === 'DUST' ? 'Dust bill' : 'No invoice')}</span>
                        <span className="ml-2 text-rose-600 dark:text-rose-400">{rupees(p.amount)}</span>
                      </div>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="space-y-0.5">
                    {s.sales.map((d) => (
                      <div key={d.legId} className="whitespace-nowrap text-xs">
                        <span className="font-mono">{legLabel(d.invoiceNumber, 'No invoice')}</span>
                        <span className="ml-2 text-emerald-600 dark:text-emerald-400">{rupees(d.amount)}</span>
                      </div>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">{s.note ?? '-'}</TableCell>
                <TableCell className="text-right font-bold text-sky-600 dark:text-sky-400">{rupees(s.amount)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Edit this set-off"
                      onClick={() => { setEditing(s); setDialogOpen(true); }}
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Reverse this set-off"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (
                          confirm(
                            `Reverse this ${rupees(s.amount)} set-off with ${s.party.name}? ` +
                              'Both the purchase bill and the sale invoice go back to outstanding, ' +
                              'and the contra journal entry is removed.'
                          )
                        ) {
                          deleteMutation.mutate(s.id);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {(setOffs?.length ?? 0) > 0 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <ArrowLeftRight className="h-4 w-4 text-sky-600 dark:text-sky-400" />
          <span className="text-muted-foreground">Total knocked off (no cash):</span>
          <span className="font-bold text-sky-600 dark:text-sky-400">{rupees(total)}</span>
        </div>
      )}

      <SetOffDialog
        open={dialogOpen}
        onOpenChange={(o) => { setDialogOpen(o); if (!o) setEditing(null); }}
        parties={parties}
        editing={editing}
      />
    </div>
  );
}
