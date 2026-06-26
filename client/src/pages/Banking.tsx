import { Landmark, CreditCard, Building, Banknote } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Banking() {
  const accounts = [
    {
      title: 'OD Account',
      limit: '₹6.00 Cr',
      icon: CreditCard,
      color: 'text-rose-500',
      desc: 'Working Capital Overdraft',
    },
    {
      title: 'Term Loan Account',
      limit: '₹4.00 Cr',
      icon: Landmark,
      color: 'text-violet-500',
      desc: 'Long-term business loan',
    },
    {
      title: 'Ad-hoc Limit',
      limit: '₹1.30 Cr',
      icon: Banknote,
      color: 'text-amber-500',
      desc: 'Temporary facility',
    },
    {
      title: 'JanSmarth Term Loan',
      limit: '₹1.11 Cr',
      icon: Building,
      color: 'text-emerald-500',
      desc: 'Govt. subsidized scheme',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Banking Limits & Accounts</h1>
        <p className="text-sm text-muted-foreground mt-1">Overview of major bank facilities and sanctioned limits</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {accounts.map((acc, i) => {
          const Icon = acc.icon;
          return (
            <Card key={i} className="transition-all hover:shadow-md hover:border-primary/30">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{acc.title}</CardTitle>
                <Icon className={`h-5 w-5 ${acc.color}`} />
              </CardHeader>
              <CardContent>
                <div className={`text-3xl font-bold tracking-tight ${acc.color}`}>{acc.limit}</div>
                <p className="text-xs text-muted-foreground mt-1.5">{acc.desc}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
