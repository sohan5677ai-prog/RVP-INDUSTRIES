import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
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
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  Banknote,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type NavItem = { to: string; label: string; icon: React.ComponentType<{ className?: string }>; end?: boolean };
type NavSection = { heading?: string; items: NavItem[] };

const sections: NavSection[] = [
  {
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }],
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
      { to: '/stock/date', label: 'Stock by Date (FIFO)', icon: CalendarDays },
      { to: '/stock/location', label: 'Stock by Location (FIFO)', icon: MapPin },
      { to: '/stock/transfer', label: 'Stock Transfer', icon: ArrowLeftRight },
      { to: '/stock/party', label: 'Stock by Party', icon: Users },
      { to: '/stock/state', label: 'Stock by State', icon: Globe },
    ],
  },
  {
    heading: 'Loans',
    items: [
      { to: '/loans', label: 'Bank Loans', icon: Banknote },
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
    heading: 'Transactions',
    items: [
      { to: '/transactions/payments', label: 'Payments', icon: Wallet },
      { to: '/transactions/receipts', label: 'Receipts', icon: Receipt },
    ],
  },
  {
    heading: 'Accounts',
    items: [
      { to: '/accounts/party-ledger', label: 'Party Ledger', icon: BookOpen },
      { to: '/accounts/hamali-ledger', label: 'Hamali Ledger', icon: Coins },
      { to: '/accounts/kata-fee-ledger', label: 'Kata Fee Ledger', icon: Receipt },
      { to: '/accounts/surya-road-transport', label: 'Surya Road Transport', icon: Truck },
      { to: '/accounts/brokerage-ledger', label: 'Brokerage Ledger', icon: Handshake },
      { to: '/accounts/chart-of-accounts', label: 'Chart of Accounts', icon: Landmark },
      { to: '/accounts/journal-entries', label: 'General Journal', icon: FileSpreadsheet },
    ],
  },
  {
    heading: 'Reports',
    items: [
      { to: '/reports/sale-dues', label: 'Sale Dues', icon: TrendingUp },
      { to: '/reports/purchase-dues', label: 'Purchase Dues', icon: TrendingDown },
      { to: '/reports/brokerage-dues', label: 'Brokerage Dues', icon: Handshake },
      { to: '/reports/freight-dues', label: 'Freight Dues', icon: Truck },
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
    heading: 'Settings',
    items: [
      { to: '/settings/freight-rates', label: 'Freight Rates', icon: SlidersHorizontal },
    ],
  },
];

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
  const toggle = (heading: string) =>
    setOpenSections((prev) => ({ ...prev, [heading]: !prev[heading] }));

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r bg-card flex flex-col">
        <div className="px-5 py-4 border-b">
          <div className="font-bold text-lg leading-tight">RVP Industries</div>
          <div className="text-xs text-muted-foreground">Tamarind Processing</div>
        </div>
        <nav className="flex-1 overflow-auto p-2 space-y-2">
          {sections.map((section, i) => {
            const isOpen = section.heading ? !!openSections[section.heading] : true;
            return (
              <div key={section.heading ?? i} className="space-y-1">
                {section.heading && (
                  <button
                    type="button"
                    onClick={() => toggle(section.heading!)}
                    className="w-full flex items-center justify-between px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 hover:text-muted-foreground transition-colors"
                  >
                    <span>{section.heading}</span>
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </button>
                )}
                {isOpen &&
                  section.items.map(({ to, label, icon: Icon, end }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={end}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                        )
                      }
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </NavLink>
                  ))}
              </div>
            );
          })}
        </nav>
        <div className="border-t p-3">
          <div className="px-2 pb-2 text-xs">
            <div className="font-medium">{user?.name}</div>
            <div className="text-muted-foreground">{user?.role}</div>
          </div>
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={logout}>
            <LogOut className="h-4 w-4" /> Logout
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto bg-background">
        <div className="mx-auto max-w-6xl p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
