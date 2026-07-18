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
  ShoppingCart,
  LogOut,
  BookOpen,
  Coins,
  Receipt,
  Warehouse,
  Calculator,
  MapPin,
  ArrowLeftRight,
  CalendarDays,
  Globe,
  Wheat,
  Layers,
  Recycle,
  ChevronRight,
  SlidersHorizontal,
  Banknote,
  Tag,
  Shield,
  Package,
  Zap,
  Wrench,
  HandCoins,
  Percent,
  Loader2,
  PanelLeftClose,
  Menu,
  FileText,
  TrendingUp,
  FileMinus2,
  TrendingDown,
  Wallet,
  Landmark,
  FileSpreadsheet,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { preloadRoute } from '@/lib/preload';
import { ThemeToggle } from '@/components/ThemeToggle';
import DispatchReminders from '@/components/DispatchReminders';

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
      { to: '/purchases', label: 'Stock in Detail', icon: Scale },
      { to: '/verification', label: 'Verification', icon: BadgeCheck },
    ],
  },
  {
    heading: 'Stock',
    items: [
      { to: '/stock/overview', label: 'Black Seed Stock', icon: Warehouse },
      { to: '/stock/price', label: 'Order Planner', icon: Tag },
      { to: '/stock/date', label: 'Stock by Date (FIFO)', icon: CalendarDays },
      { to: '/stock/location', label: 'Stock by Location (Band Price)', icon: MapPin },
      { to: '/stock/transfer', label: 'Stock Transfer', icon: ArrowLeftRight },
      { to: '/stock/party', label: 'Stock by Party', icon: Users },
      { to: '/stock/state', label: 'Stock by State', icon: Globe },
    ],
  },
  {
    heading: 'Tools',
    items: [
      { to: '/pappu-calculator', label: 'Pappu Calculator', icon: Calculator },
    ],
  },
  {
    heading: 'Sales',
    items: [
      { to: '/sale-orders', label: 'Sale Orders', icon: ClipboardList },
      { to: '/sales/pappu', label: 'Pappu', icon: ShoppingCart },
      { to: '/sales/profit-loss', label: 'Pappu Profit & Loss', icon: TrendingUp },
      { to: '/sales/husk', label: 'Husk', icon: Layers },
      { to: '/sales/tps', label: 'TPS (Brokens)', icon: Wheat },
      { to: '/sales/byproducts', label: 'Tamarind Byproducts', icon: Recycle },
      { to: '/sales/notes', label: 'Credit/Debit Notes', icon: FileMinus2 },
    ],
  },
  {
    heading: 'Reports',
    items: [
      { to: '/reports/irn-ewb', label: 'IRN/EWB', icon: FileText },
      { to: '/reports/purchase-dues', label: 'Purchase Dues', icon: TrendingDown },
      { to: '/reports/payment-planner', label: 'Payment Planner', icon: Wallet },
      { to: '/reports/sale-dues', label: 'Sale Dues', icon: TrendingUp },
      { to: '/reports/freight-dues', label: 'Freight Dues', icon: Truck },
      { to: '/accounts/brokerage-ledger', label: 'Brokerage Report', icon: Handshake },
      { to: '/accounts/party-ledger', label: 'Party Ledger', icon: BookOpen },
      { to: '/accounts/hamali-ledger', label: 'Hamali Report', icon: Coins },
      { to: '/accounts/kata-fee-ledger', label: 'Kata Report', icon: Receipt },
      { to: '/accounts/surya-road-transport', label: 'Transport Report', icon: Truck },
      { to: '/reports/gunny-bags', label: 'Gunny Bags', icon: Package },
      { to: '/reports/electricity', label: 'Electricity', icon: Zap },
      { to: '/reports/maintenance', label: 'Maintenance', icon: Wrench },
      { to: '/reports/drawings', label: 'Drawings', icon: HandCoins },
      { to: '/reports/interest', label: 'Interest', icon: Percent },
    ],
  },
  {
    heading: 'Banking',
    items: [
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

  const activeHeading = sections.find(
    (s) => s.heading && s.items.some((it) => it.to !== '/' && location.pathname.startsWith(it.to))
  )?.heading;
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    () => (activeHeading ? { [activeHeading]: true } : {})
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const toggle = (heading: string) =>
    setOpenSections((prev) => (prev[heading] ? {} : { [heading]: true }));

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
      <DispatchReminders />
      <aside className={cn('w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border relative', sidebarOpen ? 'flex' : 'hidden')}>
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(125%_40%_at_0%_0%,rgba(232,169,63,0.11),transparent_62%)]" />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.025] via-transparent to-black/25" />
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-white/10 via-white/[0.04] to-transparent" />
        <div className="relative z-10 flex items-center gap-3 px-5 h-16 border-b border-sidebar-border shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center shadow-lg shadow-amber-950/50 ring-1 ring-amber-300/20 shrink-0">
            <span className="font-display font-semibold text-[15px] text-amber-50 leading-none">R</span>
          </div>
          <div className="min-w-0 leading-tight">
            <div className="font-display font-semibold text-[15px] text-amber-50/95 truncate tracking-tight">RVP Industries</div>
            <div className="text-[10.5px] uppercase tracking-[0.16em] text-sidebar-foreground/55">Tamarind Seed Processing</div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            title="Close sidebar"
            aria-label="Close sidebar"
            className="ml-auto p-1.5 rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-hover hover:text-white transition-colors shrink-0"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>

        <p className="relative z-10 px-5 pt-5 pb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-sidebar-foreground/55">
          Navigation
        </p>

        <nav className="relative z-10 flex-1 overflow-y-auto px-3 pb-4 space-y-0.5">
          {sections.map((section, i) => {
            const isOpen = section.heading ? !!openSections[section.heading] : true;
            return (
              <div key={section.heading ?? i}>
                {section.heading && (
                  <button
                    type="button"
                    onClick={() => toggle(section.heading!)}
                    className={cn(
                      'group/h mt-1 w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-bold uppercase tracking-[0.14em] transition-colors',
                      isOpen
                        ? 'text-amber-200'
                        : 'text-sidebar-foreground/80 hover:text-white'
                    )}
                  >
                    <span className="flex-1 text-left">{section.heading}</span>
                    <span
                      className={cn(
                        'flex h-5 w-5 items-center justify-center rounded-md border transition-all duration-200',
                        isOpen
                          ? 'border-amber-400/45 bg-amber-400/15 text-amber-200'
                          : 'border-white/12 bg-white/[0.05] text-sidebar-foreground/70 group-hover/h:border-white/25 group-hover/h:text-white'
                      )}
                    >
                      <ChevronRight
                        className={cn('h-3.5 w-3.5 transition-transform duration-200', isOpen && 'rotate-90')}
                      />
                    </span>
                  </button>
                )}
                {isOpen && (
                  <div
                    className={cn(
                      'space-y-0.5',
                      section.heading &&
                        'relative ml-[1.15rem] mb-1 pl-3 border-l border-sidebar-border/80'
                    )}
                  >
                    {section.items.map(({ to, label, icon: Icon, end }) => (
                      <NavLink
                        key={to}
                        to={to}
                        end={end}
                        onMouseEnter={() => preloadRoute(to)}
                        onFocus={() => preloadRoute(to)}
                        className={({ isActive }) =>
                          cn(
                            'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-all duration-200',
                            isActive
                              ? 'bg-gradient-to-r from-amber-500/[0.2] to-transparent text-white font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                              : 'text-sidebar-foreground/90 font-semibold hover:bg-white/[0.06] hover:text-white'
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            {isActive && section.heading && (
                              <span className="absolute -left-3 top-1/2 -translate-y-1/2 h-5 w-[2.5px] rounded-full bg-[var(--sidebar-accent)] shadow-[0_0_12px_var(--sidebar-accent)]" />
                            )}
                            <Icon className={cn('h-4 w-4 shrink-0 transition-colors', isActive ? 'text-[var(--sidebar-accent)]' : 'text-sidebar-foreground/70 group-hover:text-white')} />
                            <span className="truncate">{label}</span>
                          </>
                        )}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* User / logout */}
        <div className="relative z-10 border-t border-sidebar-border p-3 shrink-0">
          <div className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-white/[0.03] transition-colors">
            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-amber-500/80 to-amber-700/80 ring-1 ring-amber-300/20 flex items-center justify-center shrink-0">
              <span className="text-amber-50 text-xs font-bold">{initials}</span>
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
        <header className="h-16 shrink-0 sticky top-0 z-30 flex items-center justify-between gap-4 px-8 bg-card border-b border-border/80 shadow-[0_1px_0_color-mix(in_srgb,var(--card)_90%,transparent)]">
          <div className="flex items-baseline gap-2.5 min-w-0">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                title="Open sidebar"
                aria-label="Open sidebar"
                className="self-center -ml-2 mr-1 p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
              >
                <Menu className="h-5 w-5" />
              </button>
            )}
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
