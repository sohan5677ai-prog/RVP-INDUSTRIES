import { useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Printer, Scale } from 'lucide-react';
import type { WeighbridgeTicket, CompanyProfile } from '@/lib/types';
import { shortDate } from '@/lib/format';

interface WeighbridgeSlipModalProps {
  ticket: WeighbridgeTicket | null;
  companyProfile?: CompanyProfile | null;
  onClose: () => void;
}

export default function WeighbridgeSlipModal({
  ticket,
  companyProfile,
  onClose,
}: WeighbridgeSlipModalProps) {
  const printRef = useRef<HTMLDivElement>(null);

  if (!ticket) return null;

  const handlePrint = () => {
    window.print();
  };

  const firstWeight = ticket.firstWeightKg ?? 0;
  const secondWeight = ticket.secondWeightKg ?? 0;

  // Determine Gross and Tare
  const grossWeight = ticket.secondWeightKg != null
    ? Math.max(firstWeight, secondWeight)
    : (ticket.loadType === 'LOAD' ? firstWeight : null);
  const tareWeight = ticket.secondWeightKg != null
    ? Math.min(firstWeight, secondWeight)
    : (ticket.loadType === 'EMPTY' ? firstWeight : null);
  const netWeight = ticket.netWeightKg ?? (grossWeight != null && tareWeight != null ? Math.abs(grossWeight - tareWeight) : null);

  return (
    <Dialog open={!!ticket} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md p-0 overflow-hidden print:m-0 print:p-0 print:border-none print:shadow-none">
        <DialogHeader className="p-4 bg-muted/40 border-b flex flex-row items-center justify-between print:hidden">
          <DialogTitle className="text-sm font-semibold flex items-center gap-2">
            <Scale className="h-4 w-4 text-primary" />
            Weighbridge Slip #{ticket.ticketNo}
          </DialogTitle>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handlePrint} className="h-8 gap-1.5 font-medium">
              <Printer className="h-3.5 w-3.5" />
              Print Slip
            </Button>
          </div>
        </DialogHeader>

        {/* Printable Slip Body */}
        <div ref={printRef} className="p-6 bg-white text-zinc-900 font-mono text-xs select-text print:p-2">
          {/* Header */}
          <div className="text-center pb-3 border-b-2 border-zinc-900">
            <h2 className="text-base font-bold uppercase tracking-wider text-zinc-950">
              {companyProfile?.name || 'RVP INDUSTRIES'}
            </h2>
            <p className="text-[11px] text-zinc-600 font-sans">
              {companyProfile?.address || 'Punganur Road, Chittoor District, Andhra Pradesh'}
            </p>
            <p className="text-[10px] text-zinc-500 font-sans">
              GSTIN: {companyProfile?.gstin || '37AAHFR8844D1ZU'} · WEIGHBRIDGE DIVISION
            </p>
            <div className="mt-2 inline-block px-3 py-0.5 bg-zinc-900 text-white font-sans text-[11px] font-bold uppercase tracking-widest rounded-xs">
              WEIGHMENT CERTIFICATE
            </div>
          </div>

          {/* Ticket Metadata */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 py-3 border-b border-zinc-300 text-[11px]">
            <div>
              <span className="text-zinc-500">Ticket No: </span>
              <span className="font-bold text-zinc-950">#{ticket.ticketNo}</span>
            </div>
            <div className="text-right">
              <span className="text-zinc-500">Date: </span>
              <span className="font-semibold">{shortDate(ticket.createdAt)}</span>
            </div>

            <div>
              <span className="text-zinc-500">Vehicle No: </span>
              <span className="font-bold text-sm text-zinc-950 tracking-wide">{ticket.vehicleNumber}</span>
            </div>
            <div className="text-right">
              <span className="text-zinc-500">Vehicle: </span>
              <span className="font-medium">{ticket.vehicleType}</span>
            </div>

            <div className="col-span-2">
              <span className="text-zinc-500">Customer: </span>
              <span className="font-bold text-zinc-950">{ticket.partyName || '-'}</span>
            </div>

            <div>
              <span className="text-zinc-500">Material: </span>
              <span className="font-semibold text-zinc-950">{ticket.material || '-'}</span>
            </div>
            <div className="text-right">
              <span className="text-zinc-500">Trip: </span>
              <span className="font-semibold uppercase">{ticket.tripType}</span>
            </div>
          </div>

          {/* Weight Matrix */}
          <div className="py-3 border-b-2 border-zinc-900 space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-zinc-600 font-sans">GROSS WEIGHT:</span>
              <span className="font-bold font-mono text-sm">
                {grossWeight != null ? `${grossWeight.toLocaleString('en-IN')} KG` : '-'}
              </span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-zinc-600 font-sans">TARE WEIGHT:</span>
              <span className="font-bold font-mono text-sm">
                {tareWeight != null ? `${tareWeight.toLocaleString('en-IN')} KG` : '-'}
              </span>
            </div>
            <div className="pt-2 border-t border-dashed border-zinc-400 flex justify-between items-baseline">
              <span className="text-sm font-black font-sans text-zinc-950 tracking-wider">NET WEIGHT:</span>
              <div className="text-right">
                <span className="text-lg font-black font-mono text-zinc-950">
                  {netWeight != null ? `${netWeight.toLocaleString('en-IN')} KG` : '-'}
                </span>
                {netWeight != null && (
                  <span className="block text-[10px] text-zinc-600 font-sans">
                    ({(netWeight / 1000).toFixed(3)} Tonnes)
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Charges & Footer */}
          <div className="pt-2 pb-6 flex justify-between text-[10px] text-zinc-600">
            <div>
              <span>Fee: ₹{Number(ticket.amount).toFixed(2)} ({ticket.billType})</span>
              <span className="block text-[9px] text-zinc-400">Operator: {ticket.operatorName || 'ADMIN'}</span>
            </div>
            <div className="text-right">
              <span>Time: {new Date(ticket.createdAt).toLocaleTimeString()}</span>
              <span className="block text-[9px] text-zinc-400">Computer Generated Slip</span>
            </div>
          </div>

          {/* Signature lines */}
          <div className="pt-6 flex justify-between text-[10px] font-sans text-zinc-600">
            <div className="border-t border-zinc-400 pt-1 w-24 text-center">
              Driver Signature
            </div>
            <div className="border-t border-zinc-400 pt-1 w-28 text-center">
              Operator Signature
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
