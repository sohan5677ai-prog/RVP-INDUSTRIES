import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import type { CompanyProfile } from '@/lib/types';
import {
  LorryPaymentData,
  LORRY_PAYMENT_LANGUAGES,
  formatLorryPaymentReceiptText,
  buildWhatsAppWebUrl,
} from '@/lib/lorryPaymentTemplate';
import { Copy, Check, Send, ExternalLink, Loader2, Truck, UserCheck, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

type AlertMember = { name: string; phone: string };

function parseAlertMembers(raw?: string | null): AlertMember[] {
  try {
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      return arr.map((m: any) => ({ name: String(m?.name ?? '').trim(), phone: String(m?.phone ?? '').trim() })).filter((m) => m.name || m.phone);
    }
  } catch { /* malformed */ }
  return [];
}

interface LorryPaymentShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: LorryPaymentData | null;
  initialPhone?: string | null;
}

export function LorryPaymentShareDialog({
  open,
  onOpenChange,
  data,
  initialPhone = '',
}: LorryPaymentShareDialogProps) {
  const [selectedLang, setSelectedLang] = useState<'EN' | 'TE' | 'HI' | 'TA'>('EN');
  const [phone, setPhone] = useState(initialPhone || data?.driverPhone || '');
  const [driverName, setDriverName] = useState(data?.driverName || '');
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
    staleTime: 60_000,
  });

  const internalRecipients = useMemo<AlertMember[]>(() => {
    const parsed = parseAlertMembers(company?.alertRecipients);
    if (parsed.length > 0) return parsed;
    if (company?.ownerWhatsappNumber) {
      return [{ name: 'Owner', phone: company.ownerWhatsappNumber }];
    }
    return [];
  }, [company?.alertRecipients, company?.ownerWhatsappNumber]);

  useEffect(() => {
    if (open && data) {
      const initPhone = (initialPhone || data.driverPhone || '').trim();
      setPhone(initPhone);
      setDriverName(data.driverName || '');

      // If phone is missing, try looking it up via the backend contact-info endpoint
      if (!initPhone && data.lorryNumber) {
        api<{
          driverPhone?: string | null;
          driverName?: string | null;
          ownerPhone?: string | null;
        }>(`/whatsapp/lorry/contact-info?lorryNumber=${encodeURIComponent(data.lorryNumber)}`)
          .then((res) => {
            if (res?.driverPhone) {
              setPhone(res.driverPhone);
            }
            if (res?.driverName) {
              setDriverName(res.driverName);
            }
          })
          .catch(() => {});
      }
    }
  }, [open, initialPhone, data?.driverPhone, data?.driverName, data?.lorryNumber]);

  if (!data) return null;

  const messageText = formatLorryPaymentReceiptText(data, selectedLang);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      toast.success('Lorry receipt message copied to clipboard!');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const handleOpenWhatsAppWeb = (target?: string) => {
    const targetPhone = (target ?? phone).trim() || initialPhone || '';
    if (!targetPhone) {
      toast.error('Please enter a recipient phone number');
      return;
    }
    const url = buildWhatsAppWebUrl(targetPhone, messageText);
    window.open(url, '_blank');
  };

  const handleSendApi = async () => {
    const targetPhone = phone.trim() || initialPhone || '';
    if (!targetPhone) {
      toast.error('Please enter a recipient phone number');
      return;
    }

    setSending(true);
    try {
      const res = await api<{ ok: boolean; message: string }>('/whatsapp/lorry-payment/send-summary', {
        method: 'POST',
        body: {
          lorryDetails: {
            date: data.date,
            lorryNumber: data.lorryNumber,
            destination: data.destination,
            grossFreight: data.grossFreight,
            kata: data.kata,
            hamali: data.hamali,
            otherDeductions: data.otherDeductions,
            netPayable: data.netPayable,
            amountPaid: data.amountPaid,
            reference: data.reference,
            balance: data.balance,
          },
          targetPhone,
          language: selectedLang,
        },
      });

      if (res.ok) {
        toast.success(res.message || 'WhatsApp message sent to driver & copy delivered to owner!');
        onOpenChange(false);
      } else {
        toast.error(res.message || 'Failed to send WhatsApp message');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to send WhatsApp message');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <div className="p-1.5 rounded-md bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400">
              <Truck className="h-4 w-4" />
            </div>
            Lorry Freight Payment Receipt
            <Badge variant="outline" className="ml-auto font-mono text-xs">
              {data.lorryNumber}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Quick Stats Banner */}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 rounded-lg bg-muted/40 p-2.5 text-xs">
            <div>
              <span className="text-muted-foreground block text-[10px]">Gross Freight</span>
              <span className="font-semibold font-mono">₹{data.grossFreight?.toLocaleString('en-IN')}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-[10px]">Net Payable</span>
              <span className="font-semibold font-mono text-primary">₹{data.netPayable?.toLocaleString('en-IN')}</span>
            </div>
            <div>
              <span className="text-muted-foreground block text-[10px]">Amount Paid</span>
              <span className="font-semibold font-mono text-emerald-600 dark:text-emerald-400">₹{data.amountPaid?.toLocaleString('en-IN')}</span>
            </div>
            <div className="col-span-3 sm:col-span-1">
              <span className="text-muted-foreground block text-[10px]">Balance Due</span>
              <span className={`font-semibold font-mono ${data.balance > 0 ? 'text-rose-600 dark:text-rose-400 font-bold' : 'text-emerald-600'}`}>
                ₹{data.balance?.toLocaleString('en-IN')}
              </span>
            </div>
          </div>

          {/* Language Selector Tabs */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Select Language Template</Label>
            <div className="grid grid-cols-4 gap-1.5 p-1 rounded-lg bg-muted/50 border">
              {LORRY_PAYMENT_LANGUAGES.map((lang) => {
                const isActive = selectedLang === lang.key;
                return (
                  <button
                    key={lang.key}
                    type="button"
                    onClick={() => setSelectedLang(lang.key)}
                    className={`py-1.5 px-2 text-xs font-medium rounded-md transition-all flex flex-col items-center justify-center ${
                      isActive
                        ? 'bg-background text-foreground shadow-sm font-semibold border'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/80'
                    }`}
                  >
                    <span>{lang.native}</span>
                    <span className="text-[10px] text-muted-foreground font-normal">{lang.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Message Preview */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-muted-foreground">WhatsApp Message Preview</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopy}
                className="h-6 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="relative rounded-lg border bg-emerald-950/10 dark:bg-emerald-950/20 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground max-h-56 overflow-y-auto border-emerald-500/20">
              {messageText}
            </div>
          </div>

          {/* Recipient Phone Input & Auto-Fill Info */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="target-phone" className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                Driver WhatsApp Mobile
                {driverName && (
                  <Badge variant="secondary" className="font-normal text-[10px] py-0 px-1.5">
                    <UserCheck className="h-3 w-3 mr-1 text-emerald-600" />
                    {driverName}
                  </Badge>
                )}
              </Label>
              {phone && (
                <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                  Auto-filled for {data.lorryNumber}
                </span>
              )}
            </div>
            <Input
              id="target-phone"
              type="tel"
              placeholder="e.g. 9876543210 (Driver / Transporter)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="text-sm font-mono"
            />

            {/* Internal Team Copy Banner (Us / Management) */}
            <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 p-2.5 space-y-2 text-xs text-foreground">
              <div className="flex items-start gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <div className="leading-tight">
                  <span className="font-semibold text-emerald-900 dark:text-emerald-200">
                    Internal Copy (Our Management Team):
                  </span>{' '}
                  <span className="text-muted-foreground text-[11px]">
                    Automatic copy will be delivered to us (
                    {internalRecipients.map((m) => m.name || m.phone).join(', ') || 'Internal Alerts'}
                    ) on WhatsApp.
                  </span>
                </div>
              </div>

              {internalRecipients.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-emerald-500/15">
                  <span className="text-[10px] font-medium text-emerald-800 dark:text-emerald-300">
                    WhatsApp Web to us:
                  </span>
                  {internalRecipients.map((m, idx) => (
                    <Button
                      key={idx}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenWhatsAppWeb(m.phone)}
                      className="h-5 px-1.5 text-[10px] gap-1 border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
                      title={`Send WhatsApp Web copy to ${m.name} (${m.phone})`}
                    >
                      <WhatsAppIcon className="h-2.5 w-2.5 fill-emerald-600" />
                      {m.name || m.phone}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5 text-xs w-full sm:w-auto">
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied to Clipboard' : 'Copy Message'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenWhatsAppWeb()}
            className="gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 border-emerald-600/30 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 w-full sm:w-auto"
          >
            <WhatsAppIcon className="h-3.5 w-3.5 fill-emerald-600" />
            WhatsApp Web
            <ExternalLink className="h-3 w-3 opacity-60" />
          </Button>
          <Button
            size="sm"
            onClick={() => handleSendApi()}
            disabled={sending}
            className="gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white w-full sm:w-auto ml-auto"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {sending ? 'Sending…' : 'Send WhatsApp'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
