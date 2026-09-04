import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon';
import {
  LorryPaymentData,
  LORRY_PAYMENT_LANGUAGES,
  formatLorryPaymentReceiptText,
  buildWhatsAppWebUrl,
} from '@/lib/lorryPaymentTemplate';
import { Copy, Check, Send, ExternalLink, Loader2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

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
  const [phone, setPhone] = useState(initialPhone || '');
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);

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

  const handleOpenWhatsAppWeb = () => {
    const targetPhone = phone.trim() || initialPhone || '';
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
        toast.success(res.message || 'WhatsApp message sent successfully!');
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

          {/* Recipient Phone Input */}
          <div className="space-y-1.5">
            <Label htmlFor="target-phone" className="text-xs font-semibold text-muted-foreground">
              Recipient WhatsApp Mobile
            </Label>
            <Input
              id="target-phone"
              type="tel"
              placeholder="e.g. 9876543210 (Driver / Transporter)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="text-sm"
            />
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
            onClick={handleOpenWhatsAppWeb}
            className="gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 border-emerald-600/30 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 w-full sm:w-auto"
          >
            <WhatsAppIcon className="h-3.5 w-3.5 fill-emerald-600" />
            WhatsApp Web
            <ExternalLink className="h-3 w-3 opacity-60" />
          </Button>
          <Button
            size="sm"
            onClick={handleSendApi}
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
