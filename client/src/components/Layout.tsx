import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Handshake,
  ClipboardList,
  Truck,
  Scale,
  BadgeCheck,
  Factory,
  Tag,
  ShoppingCart,
  LogOut,
  BookOpen,
  Coins,
  Receipt,
  Warehouse,
  Calculator,
  Landmark,
  FileSpreadsheet,
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
    heading: 'Output',
    items: [
      { to: '/processing', label: 'Processing', icon: Factory },
      { to: '/pappu-pricing', label: 'Pappu Pricing', icon: Tag },
      { to: '/pappu-calculator', label: 'Pappu Calculator', icon: Calculator },
      { to: '/stock-location', label: 'Stock by Location', icon: Warehouse },
    ],
  },
  {
    heading: 'Sales',
    items: [{ to: '/sale-orders', label: 'Sale Orders', icon: ShoppingCart }],
  },
  {
    heading: 'Accounts',
    items: [
      { to: '/accounts/party-ledger', label: 'Party Ledger', icon: BookOpen },
      { to: '/accounts/hamali-ledger', label: 'Hamali Ledger', icon: Coins },
      { to: '/accounts/kata-fee-ledger', label: 'Kata Fee Ledger', icon: Receipt },
      { to: '/accounts/chart-of-accounts', label: 'Chart of Accounts', icon: Landmark },
      { to: '/accounts/journal-entries', label: 'General Journal', icon: FileSpreadsheet },
    ],
  },
  {
    heading: 'Master data',
    items: [
      { to: '/parties', label: 'Parties', icon: Users },
      { to: '/brokers', label: 'Brokers', icon: Handshake },
    ],
  },
];

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r bg-card flex flex-col">
        <div className="px-5 py-4 border-b">
          <div className="font-bold text-lg leading-tight">RVP Industries</div>
          <div className="text-xs text-muted-foreground">Tamarind Processing</div>
        </div>
        <nav className="flex-1 overflow-auto p-2 space-y-4">
          {sections.map((section, i) => (
            <div key={section.heading ?? i} className="space-y-1">
              {section.heading && (
                <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {section.heading}
                </div>
              )}
              {section.items.map(({ to, label, icon: Icon, end }) => (
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
          ))}
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
