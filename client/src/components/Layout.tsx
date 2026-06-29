import { useState, Suspense } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Home,
  LayoutDashboard,
  Users,
  Handshake,
  ClipboardList,
  Truck,
  Scale,
  BadgeCheck,
  Factory,
  ShoppingCart,
  LogOut,
  BookOpen,
  Coins,
  Receipt,
  Warehouse,
  Calculator,
  Landmark,
  FileSpreadsheet,
  Wallet,
  TrendingUp,
  TrendingDown,
  MapPin,
  ArrowLeftRight,
  CalendarDays,
  Globe,
  Wheat,
  Layers,
  Nut,
  Trash2,
  ChevronRight,
  SlidersHorizontal,
  Banknote,
  Tag,
  Shield,
  Loader2,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { preloadRoute } from '@/lib/preload';
import { ThemeToggle } from '@/components/ThemeToggle';

type NavItem = { to: string; label: string; icon: React.ComponentType<{ className?: string }>; end?: boolean };
type NavSection = { heading?: string; items: NavItem[] };

const sections: NavSection[] = [
  {
    items: [
      { to: '/', label: 'Home', icon: Home, end: true },
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    heading: 'Master data',
    items: [
      { to: '/parties', label: 'Parties', icon: Users },
      { to: '/brokers', label: 'Brokers', icon: Handshake },
    ],
  },
  {
    heading: 'Purchases',
    items: [
      { to: '/purchase-orders', label: 'Purchase Orders', icon: ClipboardList },
      { to: '/stock-in', label: 'Stock In', icon: Truck },
      { to: '/purchases', label: 'Purchase', icon: Scale },
      { to: '/verification', label: 'Verification', icon: BadgeCheck },
    ],
  },
  {
    heading: 'Stock',
    items: [
      { to: '/stock/overview', label: 'Black Seed Stock', icon: Warehouse },
      { to: '/stock/price', label: 'Order Planner', icon: Tag },
      { to: '/stock/date', label: 'Stock by Date (FIFO)', icon: CalendarDays },
      { to: '/stock/location', label: 'Stock by Location (FIFO)', icon: MapPin },
      { to: '/stock/transfer', label: 'Stock Transfer', icon: ArrowLeftRight },
      { to: '/stock/party', label: 'Stock by Party', icon: Users },
      { to: '/stock/state', label: 'Stock by State', icon: Globe },
    ],
  },
  {
    heading: 'Processing',
    items: [
      { to: '/processing', label: 'Conversion', icon: Factory },
      { to: '/processing/pappu', label: 'Pappu (60%)', icon: Wheat },
      { to: '/processing/husk', label: 'Husk (25%)', icon: Layers },
      { to: '/processing/waste', label: 'Tamarind Waste (10%)', icon: Trash2 },
      { to: '/pappu-calculator', label: 'Pappu Calculator', icon: Calculator },
    ],
  },
  {
    heading: 'Sales',
    items: [
      { to: '/sale-orders', label: 'Sale Orders', icon: ClipboardList },
      { to: '/sales/pappu', label: 'Pappu', icon: ShoppingCart },
      { to: '/sales/husk', label: 'Husk', icon: Layers },
      { to: '/sales/waste', label: 'Tamarind Waste', icon: Trash2 },
      { to: '/sales/tps', label: 'TPS (Brokens)', icon: Wheat },
      { to: '/sales/shell', label: 'Tamarind Shell', icon: Nut },
    ],
  },
  {
    heading: 'Reports',
    items: [
      { to: '/reports/allocation-health', label: 'Allocation Health', icon: ClipboardList },
      { to: '/reports/purchase-dues', label: 'Purchase Dues', icon: TrendingDown },
      { to: '/reports/sale-dues', label: 'Sale Dues', icon: TrendingUp },
      { to: '/reports/freight-dues', label: 'Freight Dues', icon: Truck },
      { to: '/accounts/brokerage-ledger', label: 'Brokerage Report', icon: Handshake },
      { to: '/accounts/party-ledger', label: 'Party Ledger', icon: BookOpen },
      { to: '/accounts/hamali-ledger', label: 'Hamali Report', icon: Coins },
      { to: '/accounts/kata-fee-ledger', label: 'Kata Report', icon: Receipt },
      { to: '/accounts/surya-road-transport', label: 'Transport Report', icon: Truck },
    ],
  },
  {
    heading: 'Banking',
    items: [
      { to: '/banking/limits', label: 'Banking', icon: Landmark },
      { to: '/loans', label: 'Storage Loans', icon: Banknote },
    ],
  },
  {
    heading: 'Transactions',
    items: [
      { to: '/transactions/payments', label: 'Payments', icon: Wallet },
      { to: '/transactions/receipts', label: 'Receipts', icon: Receipt },
    ],
  },
  {
    heading: 'Accounts',
    items: [
      { to: '/accounts/chart-of-accounts', label: 'Chart of Accounts', icon: Landmark },
      { to: '/accounts/balance-sheet', label: 'Balance Sheet', icon: Scale },
      { to: '/accounts/profit-loss', label: 'Profit & Loss', icon: TrendingUp },
      { to: '/accounts/journal-entries', label: 'General Journal', icon: FileSpreadsheet },
    ],
  },
  {
    heading: 'Settings',
    items: [
      { to: '/settings', label: 'Settings', icon: SlidersHorizontal },
      { to: '/users', label: 'Users', icon: Shield },
    ],
  },
];

// Warm, earthy accent per section — a restrained palette true to the identity.
const HEADING_COLOR: Record<string, string> = {
  Purchases: 'text-amber-400',
  Stock: 'text-orange-300',
  Banking: 'text-rose-400',
  Processing: 'text-yellow-400',
  Sales: 'text-emerald-400',
  Transactions: 'text-teal-300',
  Accounts: 'text-lime-400',
  Reports: 'text-amber-300',
  'Master data': 'text-stone-400',
  Settings: 'text-stone-400',
};

function PageLoader() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-4 animate-fade-in">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-primary/10 animate-ping" />
        <Loader2 className="h-8 w-8 text-primary animate-spin relative z-10" />
      </div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/80 font-display">
        Loading workspace...
      </p>
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();

  // Sections are collapsed by default; the one holding the active route starts open.
  const activeHeading = sections.find(
    (s) => s.heading && s.items.some((it) => it.to !== '/' && location.pathname.startsWith(it.to))
  )?.heading;
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    () => (activeHeading ? { [activeHeading]: true } : {})
  );
  // Accordion: opening a section collapses the others.
  const toggle = (heading: string) =>
    setOpenSections((prev) => (prev[heading] ? {} : { [heading]: true }));

  // Derive a breadcrumb (section › page) for the topbar.
  let current: { label: string; heading?: string } | undefined;
  for (const s of sections) {
    for (const it of s.items) {
      const match = it.end
        ? location.pathname === it.to
        : it.to !== '/' && location.pathname.startsWith(it.to);
      if (match) { current = { label: it.label, heading: s.heading }; break; }
    }
    if (current) break;
  }
  if (!current && location.pathname === '/') current = { label: 'Home' };
  const crumbSection = current?.heading;

  const initials = (user?.name ?? 'U').slice(0, 2).toUpperCase();

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside className="w-64 shrink-0 flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border relative">
        {/* faint warm sheen at the top of the rail */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-amber-500/[0.06] to-transparent" />
        {/* Brand */}
        <div className="relative flex items-center gap-3 px-5 h-16 border-b border-sidebar-border shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center shadow-lg shadow-amber-950/50 ring-1 ring-amber-300/20 shrink-0">
            <span className="font-display font-semibold text-[15px] text-amber-50 leading-none">R</span>
          </div>
          <div className="min-w-0 leading-tight">
            <div className="font-display font-semibold text-[15px] text-amber-50/95 truncate tracking-tight">RVP Industries</div>
            <div className="text-[10.5px] uppercase tracking-[0.16em] text-sidebar-foreground/55">Tamarind Processing</div>
          </div>
        </div>

        <p className="px-5 pt-4 pb-2 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
          Navigation
        </p>

        <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-0.5">
          {sections.map((section, i) => {
            const isOpen = section.heading ? !!openSections[section.heading] : true;
            const color = section.heading ? HEADING_COLOR[section.heading] ?? 'text-sidebar-foreground/50' : '';
            return (
              <div key={section.heading ?? i} className="space-y-0.5">
                {section.heading && (
                  <button
                    type="button"
                    onClick={() => toggle(section.heading!)}
                    className="mt-2 w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-sidebar-foreground/70 hover:bg-sidebar-hover hover:text-white transition-colors"
                  >
                    <span className={cn('h-1.5 w-1.5 rounded-full', color.replace('text-', 'bg-'))} />
                    <span className="flex-1 text-left">{section.heading}</span>
                    <ChevronRight className={cn('h-3.5 w-3.5 text-sidebar-foreground/30 transition-transform', isOpen && 'rotate-90')} />
                  </button>
                )}
                {isOpen &&
                  section.items.map(({ to, label, icon: Icon, end }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={end}
                      onMouseEnter={() => preloadRoute(to)}
                      onFocus={() => preloadRoute(to)}
                      className={({ isActive }) =>
                        cn(
                          'group relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors',
                          section.heading ? 'pl-3.5 pr-3' : 'px-3',
                          isActive
                            ? 'bg-primary/15 text-white font-semibold'
                            : 'text-sidebar-foreground/65 hover:bg-sidebar-hover hover:text-white'
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && (
                            <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-[var(--sidebar-accent)] shadow-[0_0_12px_var(--sidebar-accent)]" />
                          )}
                          <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-[var(--sidebar-accent)]' : 'text-sidebar-foreground/45 group-hover:text-sidebar-foreground/80')} />
                          <span className="truncate">{label}</span>
                        </>
                      )}
                    </NavLink>
                  ))}
              </div>
            );
          })}
        </nav>

        {/* User / logout */}
        <div className="border-t border-sidebar-border p-3 shrink-0">
          <div className="flex items-center gap-3 px-2 py-2 rounded-xl">
            <div className="h-9 w-9 rounded-full bg-white/10 flex items-center justify-center shrink-0">
              <span className="text-white text-xs font-bold">{initials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-xs font-semibold truncate">{user?.name}</div>
              <div className="text-sidebar-foreground/55 text-[10px] truncate capitalize">{user?.role}</div>
            </div>
            <button
              onClick={logout}
              title="Logout"
              className="p-2 rounded-lg text-sidebar-foreground/60 hover:bg-rose-500/15 hover:text-rose-300 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-16 shrink-0 sticky top-0 z-30 flex items-center justify-between gap-4 px-8 bg-[color-mix(in_srgb,var(--card)_82%,transparent)] backdrop-blur-xl border-b border-border/80 shadow-[0_1px_0_color-mix(in_srgb,var(--card)_90%,transparent)]">
          <div className="flex items-baseline gap-2.5 min-w-0">
            {crumbSection && (
              <span className="hidden sm:inline text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80 shrink-0">
                {crumbSection}
                <span className="mx-2 text-border">/</span>
              </span>
            )}
            <span className="font-display text-lg font-semibold tracking-tight text-foreground truncate">
              {current?.label ?? 'Home'}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">

            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-auto premium-bg">
          <div className="mx-auto max-w-7xl px-8 py-8 animate-fade-in">
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}
