import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { SaleOrder } from '@/lib/types';
import { kg, rupees, shortDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function SaleDispatch() {
  const { saleOrderId } = useParams<{ saleOrderId: string }>();
  const navigate = useNavigate();

  const { data: order, isLoading } = useQuery({
    queryKey: ['sale-orders', saleOrderId],
    queryFn: () => api<SaleOrder>(`/sale-orders/${saleOrderId}`),
    enabled: !!saleOrderId,
  });

  const [dispatchDate, setDispatchDate] = useState(new Date().toISOString().slice(0, 10));
  const [dispatchWeightKg, setDispatchWeightKg] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('saleOrderId', saleOrderId!);
      fd.append('dispatchDate', dispatchDate);
      fd.append('dispatchWeightKg', dispatchWeightKg);
      if (file) fd.append('invoice', file);
      return api('/sale-dispatch', { method: 'POST', body: fd, multipart: true });
    },
    onSuccess: () => {
      toast.success('Dispatch recorded');
      navigate('/sale-orders');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return toast.error('Please attach the dispatch invoice');
    mutation.mutate();
  }

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (!order) return <p className="text-muted-foreground">Sale order not found.</p>;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dispatch</h1>
          <p className="text-muted-foreground">
            {order.buyer?.name} · {shortDate(order.saleDate)} · {kg(order.tonnageKg)} @ {rupees(order.ratePerKg)}/kg
          </p>
        </div>
        <Button asChild variant="outline" size="sm"><Link to="/sale-orders">← All sales</Link></Button>
      </div>

      {order.dispatch ? (
        <Card>
          <CardContent className="pt-6 space-y-2 text-sm">
            <div className="flex items-center gap-2 text-green-700">
              <CheckCircle2 className="h-5 w-5" /> Already dispatched.
            </div>
            <div className="flex justify-between"><span className="text-muted-foreground">Dispatch date</span><span className="font-medium">{shortDate(order.dispatch.dispatchDate)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Dispatch weight</span><span className="font-medium">{kg(order.dispatch.dispatchWeightKg)}</span></div>
            <a href={order.dispatch.invoiceFileUrl} target="_blank" rel="noreferrer" className="text-primary underline">View invoice</a>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader><CardTitle className="text-base">Dispatch details</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ddate">Dispatch date</Label>
                  <Input id="ddate" type="date" value={dispatchDate} onChange={(e) => setDispatchDate(e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dweight">Dispatch weight (kg)</Label>
                  <Input id="dweight" type="number" value={dispatchWeightKg} onChange={(e) => setDispatchWeightKg(e.target.value)} required />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoice">Dispatch invoice (PDF/image)</Label>
                <Input id="invoice" type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? 'Saving…' : 'Record dispatch'}
                </Button>
                <Button asChild type="button" variant="outline"><Link to="/sale-orders">Cancel</Link></Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
