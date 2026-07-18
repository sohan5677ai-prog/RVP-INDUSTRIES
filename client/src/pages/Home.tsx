import { useState, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  Search,
  ClipboardList,
  ShoppingCart,
  Warehouse,
  Truck,
  Wallet,
  Receipt,
  ArrowRight,
  Package,
} from 'lucide-react';
import { api } from '@/lib/api';
import { kg, rupees } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import type { Party, PurchaseOrder, SaleOrder } from '@/lib/types';

interface BlackSeedRow {
  purchaseId: string;
  date: string;
  invoiceNumber: string;
  partyName: string;
  poNumber: string | null;
  lorryNumber: string;
  rvpNetWeightKg: number;
  location: string;
  pricePerKg: number;
  value: number;
  verified: boolean;
}
interface BlackSeedStockResponse {
  rows: BlackSeedRow[];
}

// ---------------------------------------------------------------------------
// Quick-access tiles
// ---------------------------------------------------------------------------
const tiles = [
  { to: '/purchase-orders', label: 'Purchase Orders', desc: 'Raise & track supplier POs', icon: ClipboardList },
  { to: '/stock-in', label: 'Stock In', desc: 'Record lorry arrivals', icon: Truck },
  { to: '/stock/overview', label: 'Black Seed Stock', desc: 'Raw stock on hand', icon: Warehouse },
  { to: '/sale-orders', label: 'Sale Orders', desc: 'Sales pipeline & dispatch', icon: ShoppingCart },
  { to: '/transactions/payments', label: 'Payments', desc: 'Pay suppliers & transporters', icon: Wallet },
  { to: '/transactions/receipts', label: 'Receipts', desc: 'Record buyer receipts', icon: Receipt },
] as const;

export default function Home() {
  const { user } = useAuth();

  const { data: parties } = useQuery({ queryKey: ['parties'], queryFn: () => api<Party[]>('/parties') });
  const { data: pos } = useQuery({ queryKey: ['purchase-orders'], queryFn: () => api<PurchaseOrder[]>('/purchase-orders?all=true') });
  const { data: sales } = useQuery({ queryKey: ['sale-orders'], queryFn: () => api<SaleOrder[]>('/sale-orders') });
  const { data: stock } = useQuery({ queryKey: ['black-seed-stock'], queryFn: () => api<BlackSeedStockResponse>('/inventory/black-seed') });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Welcome{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</h1>
        <p className="text-muted-foreground">RVP Industries - Tamarind Processing ERP</p>
      </div>

      {/* Search bars */}
      <div className="grid gap-4 sm:grid-cols-2">
        <SearchBox<Party>
          label="Find a party"
          placeholder="Search suppliers & buyers by name, phone, GSTIN…"
          items={parties}
          filter={(p, q) =>
            p.name.toLowerCase().includes(q) ||
            (p.phone ?? '').toLowerCase().includes(q) ||
            (p.gstin ?? '').toLowerCase().includes(q)
          }
          getKey={(p) => p.id}
          to="/accounts/party-ledger"
          render={(p) => (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium truncate">{p.name}</span>
                <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4 shrink-0">{p.type}</Badge>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">{p.phone ?? '-'}</span>
            </>
          )}
        />

        <SearchBox<PurchaseOrder>
          label="Find a purchase order"
          placeholder="Search POs by number or party…"
          items={pos}
          filter={(po, q) =>
            po.poNumber.toLowerCase().includes(q) ||
            (po.party?.name ?? '').toLowerCase().includes(q)
          }
          getKey={(po) => po.id}
          to="/purchase-orders"
          render={(po) => (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium truncate">{po.poNumber}</span>
                <span className="text-xs text-muted-foreground truncate">{po.party?.name}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">{kg(po.tonnageKg)}</span>
                <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4">{po.status}</Badge>
              </div>
            </>
          )}
        />

        <SearchBox<SaleOrder>
          label="Find a sale / invoice"
          placeholder="Search by buyer, product or invoice no…"
          items={sales}
          filter={(s, q) =>
            (s.buyer?.name ?? '').toLowerCase().includes(q) ||
            s.product.toLowerCase().includes(q) ||
            (s.dispatches ?? []).some((d) => (d.invoiceNumber ?? '').toLowerCase().includes(q))
          }
          getKey={(s) => s.id}
          to="/sale-orders"
          render={(s) => (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium truncate">{s.buyer?.name ?? 'Unknown buyer'}</span>
                <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4 shrink-0">{s.product}</Badge>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">{kg(s.tonnageKg)}</span>
                <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4">{s.status}</Badge>
              </div>
            </>
          )}
        />

        <SearchBox<BlackSeedRow>
          label="Find a stock lot"
          placeholder="Search lots by party, invoice, lorry or PO…"
          items={stock?.rows}
          filter={(r, q) =>
            r.partyName.toLowerCase().includes(q) ||
            (r.invoiceNumber ?? '').toLowerCase().includes(q) ||
            (r.lorryNumber ?? '').toLowerCase().includes(q) ||
            (r.poNumber ?? '').toLowerCase().includes(q)
          }
          getKey={(r) => r.purchaseId}
          to="/stock/overview"
          render={(r) => (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <Package className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-medium truncate">{r.partyName}</span>
                <span className="text-xs text-muted-foreground truncate">{r.lorryNumber}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">{kg(r.rvpNetWeightKg)}</span>
                <span className="text-xs font-medium">{rupees(r.value)}</span>
              </div>
            </>
          )}
        />
      </div>

      {/* Quick-access tiles */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Quick access</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map(({ to, label, desc, icon: Icon }) => (
            <Link key={to} to={to} className="group">
              <Card className="h-full transition-colors hover:bg-accent/50 hover:border-primary/40">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
                </CardHeader>
                <CardContent>
                  <CardTitle className="text-base">{label}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">{desc}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable live-search box with results dropdown
// ---------------------------------------------------------------------------
interface SearchBoxProps<T> {
  label: string;
  placeholder: string;
  items: T[] | undefined;
  filter: (item: T, query: string) => boolean;
  getKey: (item: T) => string;
  render: (item: T) => React.ReactNode;
  /** Page to navigate to when a result is clicked. */
  to: string;
}

function SearchBox<T>({ label, placeholder, items, filter, getKey, render, to }: SearchBoxProps<T>) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !items) return [];
    return items.filter((it) => filter(it, q)).slice(0, 6);
  }, [query, items, filter]);

  const open = focused && query.trim().length > 0;

  return (
    <div className="relative">
      <label className="block text-xs font-medium text-muted-foreground mb-1.5">{label}</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            setFocused(true);
          }}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setFocused(false), 150);
          }}
          placeholder={placeholder}
          className="pl-9"
        />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted-foreground">No matches found.</div>
          ) : (
            results.map((item) => (
              <button
                key={getKey(item)}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => navigate(to)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm',
                  'hover:bg-accent hover:text-accent-foreground transition-colors',
                )}
              >
                {render(item)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
