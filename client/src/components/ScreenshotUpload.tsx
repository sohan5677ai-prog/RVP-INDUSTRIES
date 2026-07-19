import { useRef, useState } from 'react';
import { Loader2, Sparkles, UploadCloud, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { Label } from '@/components/ui/label';

/** Fields read off a payment/receipt transaction screenshot by the server OCR. */
export interface ExtractedTransaction {
  amount?: number;
  date?: string;
  reference?: string;
  counterpartyName?: string;
  matchedPartyName?: string;
  description?: string;
}

/**
 * A compact drag-and-drop zone that uploads a transaction screenshot to an
 * extract endpoint (e.g. /payments/extract) and hands the read fields back so
 * the surrounding form can pre-fill itself. The user still verifies and saves.
 */
export function ScreenshotUpload({
  endpoint,
  label = 'Auto-fill from screenshot',
  hint = 'Drop a bank / UPI / cheque screenshot',
  onExtracted,
  onFile,
}: {
  endpoint: string;
  label?: string;
  hint?: string;
  onExtracted: (data: ExtractedTransaction) => void;
  /** Also hand back the raw file, for forms that persist it on save. */
  onFile?: (file: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handle(file: File | null) {
    if (!file) return;
    setName(file.name);
    onFile?.(file);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('screenshot', file);
      const data = await api<ExtractedTransaction>(endpoint, { method: 'POST', body: fd, multipart: true });
      onExtracted(data);
    } catch (e) {
      toast.error(getErrorMessage(e as Error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1 text-xs text-muted-foreground">
        <Sparkles className="h-3 w-3" /> {label}
      </Label>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); handle(e.dataTransfer.files?.[0] ?? null); }}
        className={`flex min-h-[72px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-3 text-center transition-colors ${
          dragOver ? 'border-primary bg-primary/5' : 'border-input hover:border-primary/50'
        }`}
      >
        {busy ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">Reading with AI…</p>
          </>
        ) : name ? (
          <>
            <FileText className="h-5 w-5 text-primary" />
            <p className="max-w-[200px] truncate text-xs font-medium">{name}</p>
            <p className="text-[10px] text-muted-foreground">Click to replace</p>
          </>
        ) : (
          <>
            <UploadCloud className="h-5 w-5 text-muted-foreground" />
            <p className="text-xs font-medium">{hint}</p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={(e) => handle(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

/** Loose name key for matching: lowercase, alphanumerics only. */
export function nameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}
