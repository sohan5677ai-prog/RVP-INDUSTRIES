import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeftRight, Loader2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Party, SetOff, SetOffOpenItems, SetOffOpenPurchase, SetOffOpenSale } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { invalidateReceiptQueries } from '@/lib/receiptCache';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';

/**
 * Knock a party's purchase payable off against its own sale receivable.
 *
 * For a party we both buy from and sell to, the two balances are routinely
 * squared instead of two bank transfers crossing. Recorded as a plain "payment
 * made" that would post only ONE side - Purchase Dues goes quiet while the sale
 * invoice stays open forever and the ledger keeps a receivable that will never
 * arrive. So this posts BOTH sides, for equal amounts and with no cash: the
 * purchase bills clear, the sale invoices clear, and the party's balance is
 * unchanged (netting settles documents, not the net position).
 */

type Alloc = Record<string, string>;

const purchaseKey = (p: SetOffOpenPurchase) => `${p.kind}:${p.id}`;

/** Fill oldest-first up to `budget`, the way a clerk would square the books. */
function fillOldestFirst(rows: { key: string; outstanding: number }[], budget: number): Alloc {
  const out: Alloc = {};
  let left = budget;
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(left, r.outstanding);
    if (take <= 0) continue;
    out[r.key] = String(take);
    left -= take;
  }
  return out;
}

const sum = (a: Alloc) =>
  Object.values(a).reduce((s, v) => s + (Number.parseFloat(v) || 0), 0);

export function SetOffDialog({
  open,
  onOpenChange,
  parties,
  initialPartyId,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parties: Party[] | undefined;
  /** Pre-selects the party when opened from a specific bill's row. */
  initialPartyId?: string;
  /** Correcting an existing knock-off rather than recording a new one. */
  editing?: SetOff | null;
}) {
  const qc = useQueryClient();
  const isEdit = !!editing;
  const [partyId, setPartyId] = useState(initialPartyId ?? '');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [purchaseAlloc, setPurchaseAlloc] = useState<Alloc>({});
  const [saleAlloc, setSaleAlloc] = useState<Alloc>({});
  // An edit seeds the panels from the saved allocation instead of the default
  // oldest-first fill, and only once - after that the user's edits stand.
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSeeded(false);
    if (editing) {
      setPartyId(editing.party.id);
      setDate(editing.date.slice(0, 10));
      setNote(editing.note ?? '');
    } else {
      setPartyId(initialPartyId ?? '');
      setDate(new Date().toISOString().slice(0, 10));
      setNote('');
      setPurchaseAlloc({});
      setSaleAlloc({});
    }
  }, [open, initialPartyId, editing]);

  const { data: openItems, isLoading } = useQuery({
    // While editing, the server must ignore this set-off's own legs - otherwise
    // the bills it currently clears read as settled and nothing is left to edit.
    queryKey: ['set-off-open', partyId, editing?.id ?? null],
    queryFn: () =>
      api<SetOffOpenItems>(
        `/set-offs/open/${partyId}${editing ? `?excludeSetOffId=${editing.id}` : ''}`
      ),
    enabled: open && !!partyId,
  });

  // Default allocation: square the smaller side off in full, oldest bills first.
  // Both sides get the SAME budget, so the dialog opens already balanced. An
  // edit instead restores what was saved.
  useEffect(() => {
    if (!openItems || seeded) return;
    setSeeded(true);
    if (editing) {
      const p: Alloc = {};
      for (const leg of editing.purchases) {
        if (leg.id) p[`${leg.kind}:${leg.id}`] = String(Math.round(Number(leg.amount)));
      }
      const s: Alloc = {};
      for (const leg of editing.sales) {
        if (leg.saleDispatchId) s[leg.saleDispatchId] = String(Math.round(Number(leg.amount)));
      }
      setPurchaseAlloc(p);
      setSaleAlloc(s);
      return;
    }
    const budget = Math.min(openItems.totals.payable, openItems.totals.receivable);
    setPurchaseAlloc(
      fillOldestFirst(openItems.purchases.map((p) => ({ key: purchaseKey(p), outstanding: p.outstanding })), budget)
    );
    setSaleAlloc(
      fillOldestFirst(openItems.sales.map((s) => ({ key: s.saleDispatchId, outstanding: s.outstanding })), budget)
    );
  }, [openItems, seeded, editing]);

  const purchaseTotal = useMemo(() => sum(purchaseAlloc), [purchaseAlloc]);
  const saleTotal = useMemo(() => sum(saleAlloc), [saleAlloc]);
  const difference = Math.round(purchaseTotal - saleTotal);
  const balanced = difference === 0 && purchaseTotal > 0;

  const mutation = useMutation({
    mutationFn: () =>
      api(isEdit ? `/set-offs/${editing!.id}` : '/set-offs', {
        method: isEdit ? 'PATCH' : 'POST',
        body: {
          date,
          partyId,
          note: note.trim() || undefined,
          purchases: Object.entries(purchaseAlloc)
            .filter(([, v]) => (Number.parseFloat(v) || 0) > 0)
            .map(([key, v]) => {
              const [kind, ...rest] = key.split(':');
              return { kind, id: rest.join(':'), amount: Number.parseFloat(v) };
            }),
          sales: Object.entries(saleAlloc)
            .filter(([, v]) => (Number.parseFloat(v) || 0) > 0)
            .map(([saleDispatchId, v]) => ({ saleDispatchId, amount: Number.parseFloat(v) })),
        },
      }),
    onSuccess: () => {
      toast.success(
        isEdit
          ? 'Set-off updated - both sides restated, no cash moved'
          : 'Set-off recorded - both sides cleared, no cash moved'
      );
      // A set-off writes a receipt AND a payment, so both cache families go:
      // the receipt side has its own fan-out (Sale Dues, product sales pages,
      // ledger, dashboard), and the payment side feeds Purchase Dues.
      invalidateReceiptQueries(qc);
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['party-ledgers'] });
      qc.invalidateQueries({ queryKey: ['set-offs'] });
      qc.invalidateQueries({ queryKey: ['set-off-open'] });
      onOpenChange(false);
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : `Failed to ${isEdit ? 'update' : 'record'} the set-off`),
  });

  // Only parties that could plausibly have both sides. The server re-checks what
  // is actually open, so this list is just to keep the picker short.
  const options = useMemo(
    () =>
      (parties ?? [])
        .filter((p) => p.type !== 'HAMALI_TEAM')
        .map((p) => ({ value: p.id, label: p.name, hint: p.type })),
    [parties]
  );

  const nothingToDo =
    !!openItems && (openItems.totals.payable === 0 || openItems.totals.receivable === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-sky-600 dark:text-sky-400" />
            {isEdit ? 'Edit set-off' : 'Set off purchase against sale'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            {isEdit
              ? "Restates the whole knock-off: the old legs and contra entry come out and the corrected ones go in, so Purchase Dues, Sale Dues and the ledger all follow. Still no money moves."
              : "Squares what we owe this party against what they owe us. No money moves: the purchase bills and the sale invoices below are both marked settled, and the party's ledger balance stays exactly where it is."}
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-2">
              <Label>Party</Label>
              {/* Both sides of a knock-off belong to one party by definition, so
                  a correction can restate the amounts but never move parties. */}
              <Combobox
                options={options}
                value={partyId}
                onChange={setPartyId}
                placeholder="Select the party…"
                searchPlaceholder="Search parties…"
                ariaLabel="Party"
                disabled={isEdit}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="setoff-date">Date</Label>
              <Input id="setoff-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          {!partyId ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Pick a party to see what is open on both sides.
            </p>
          ) : isLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : nothingToDo ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing to knock off - this party has{' '}
              {openItems!.totals.payable === 0 ? 'no open purchase bills' : 'no open sale invoices'}.
              A set-off needs an open bill on both sides.
            </p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {/* ── We owe them ─────────────────────────────────────────── */}
              <AllocPanel
                title="Purchase bills (we owe)"
                total={openItems!.totals.payable}
                allocated={purchaseTotal}
                tone="rose"
                rows={openItems!.purchases.map((p) => ({
                  key: purchaseKey(p),
                  primary: p.invoiceNumber ?? (p.kind === 'DUST' ? 'Dust / byproduct' : 'No invoice'),
                  secondary: `${shortDate(p.date)}${p.lorryNumber ? ` · ${p.lorryNumber}` : ''}`,
                  outstanding: p.outstanding,
                }))}
                alloc={purchaseAlloc}
                setAlloc={setPurchaseAlloc}
              />

              {/* ── They owe us ─────────────────────────────────────────── */}
              <AllocPanel
                title="Sale invoices (they owe)"
                total={openItems!.totals.receivable}
                allocated={saleTotal}
                tone="emerald"
                rows={openItems!.sales.map((s: SetOffOpenSale) => ({
                  key: s.saleDispatchId,
                  primary: s.invoiceNumber ?? 'No invoice',
                  secondary: `${shortDate(s.date)} · ${s.product.replace(/_/g, ' ')}`,
                  outstanding: s.outstanding,
                }))}
                alloc={saleAlloc}
                setAlloc={setSaleAlloc}
              />
            </div>
          )}

          {partyId && !nothingToDo && !isLoading && (
            <>
              <div
                className={cn(
                  'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 text-sm',
                  balanced
                    ? 'border-sky-500/30 bg-sky-500/10'
                    : 'border-amber-500/30 bg-amber-500/10'
                )}
              >
                <span className="font-medium">
                  {balanced
                    ? `Setting off ${rupees(purchaseTotal)} on both sides`
                    : difference === 0
                      ? 'Allocate an amount on both sides to continue'
                      : `Out of balance by ${rupees(Math.abs(difference))} - ${
                          difference > 0 ? 'more allocated to purchase bills' : 'more allocated to sale invoices'
                        }`}
                </span>
                <span className="text-muted-foreground">
                  Purchases {rupees(purchaseTotal)} · Sales {rupees(saleTotal)}
                </span>
              </div>

              <div className="space-y-1">
                <Label htmlFor="setoff-note">Note (optional)</Label>
                <Input
                  id="setoff-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. squared off over phone with the party"
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={!balanced || mutation.isPending}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : isEdit ? 'Save Changes' : 'Record Set-off'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One side of the knock-off: its open bills, each with an editable share. */
function AllocPanel({
  title,
  total,
  allocated,
  tone,
  rows,
  alloc,
  setAlloc,
}: {
  title: string;
  total: number;
  allocated: number;
  tone: 'rose' | 'emerald';
  rows: { key: string; primary: string; secondary: string; outstanding: number }[];
  alloc: Alloc;
  setAlloc: (a: Alloc) => void;
}) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-semibold">{title}</span>
        <span
          className={cn(
            'text-sm font-bold',
            tone === 'rose' ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
          )}
        >
          {rupees(total)}
        </span>
      </div>
      <div className="max-h-64 divide-y overflow-y-auto">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.primary}</div>
              <div className="truncate text-xs text-muted-foreground">
                {r.secondary} · open {rupees(r.outstanding)}
              </div>
            </div>
            <Input
              type="number"
              inputMode="numeric"
              className="h-8 w-28 text-right"
              value={alloc[r.key] ?? ''}
              max={r.outstanding}
              min={0}
              placeholder="0"
              onChange={(e) => {
                const next = { ...alloc };
                // Never let a bill absorb more than it still owes - the server
                // rejects it anyway, so catch it while the number is being typed.
                const v = Math.min(Number.parseFloat(e.target.value) || 0, r.outstanding);
                if (v > 0) next[r.key] = String(Math.round(v));
                else delete next[r.key];
                setAlloc(next);
              }}
            />
          </div>
        ))}
      </div>
      <div className="border-t px-4 py-2 text-right text-xs text-muted-foreground">
        Allocated {rupees(allocated)} of {rupees(total)}
      </div>
    </div>
  );
}
