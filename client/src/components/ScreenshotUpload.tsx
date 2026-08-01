import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, UploadCloud, FileText, ClipboardPaste, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { usePasteImage, readImageFromClipboard } from '@/lib/usePasteImage';

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
 * A compact drop zone for a transaction screenshot. The file can be clicked in,
 * dragged in, or pasted (Ctrl+V / the Paste button) - pasting is the common
 * path, since these are almost always fresh screenshots.
 *
 * With an `endpoint` the file is uploaded to an extract endpoint (e.g.
 * /payments/extract) and the read fields are handed back so the surrounding
 * form can pre-fill itself; the user still verifies and saves. Without one the
 * zone is proof-only: the file is just handed to `onFile` to persist on save.
 */
export function ScreenshotUpload({
  endpoint,
  label = 'Auto-fill from screenshot',
  hint = 'Drop a bank / UPI / cheque screenshot',
  onExtracted,
  onFile,
  filePrefix = 'screenshot',
  enabled = true,
}: {
  /** Extract endpoint. Omit for a proof-only zone that runs no AI read. */
  endpoint?: string;
  label?: string;
  hint?: string;
  onExtracted?: (data: ExtractedTransaction) => void;
  /** Hand back the raw file, for forms that persist it on save. */
  onFile?: (file: File | null) => void;
  /** Filename stem given to pasted images. */
  filePrefix?: string;
  /** Set false to stop this zone claiming Ctrl+V (e.g. a hidden step). */
  enabled?: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Revoking on change frees the previous object URL; on unmount, the last one.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function handle(file: File | null) {
    if (!file) return;
    setName(file.name);
    setPreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
    onFile?.(file);
    if (!endpoint || !onExtracted) return;
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

  usePasteImage(enabled, (f) => { void handle(f); }, filePrefix);

  async function pasteFromClipboard() {
    try {
      const file = await readImageFromClipboard(filePrefix);
      if (file) void handle(file);
      else toast.message('No image on the clipboard. Take a screenshot first.');
    } catch {
      toast.error('Could not read the clipboard - press Ctrl+V instead.');
    }
  }

  function clear() {
    setName(null);
    setPreview(null);
    onFile?.(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1 text-xs text-muted-foreground">
        {endpoint ? <Sparkles className="h-3 w-3" /> : <FileText className="h-3 w-3" />} {label}
      </Label>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void handle(e.dataTransfer.files?.[0] ?? null); }}
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
            {preview ? (
              <img src={preview} alt="" className="max-h-24 rounded border object-contain" />
            ) : (
              <FileText className="h-5 w-5 text-primary" />
            )}
            <p className="max-w-[200px] truncate text-xs font-medium">{name}</p>
            <p className="text-[10px] text-muted-foreground">Click to replace</p>
          </>
        ) : (
          <>
            <UploadCloud className="h-5 w-5 text-muted-foreground" />
            <p className="text-xs font-medium">{hint}</p>
            <p className="text-[10px] text-muted-foreground">or press Ctrl+V to paste a screenshot</p>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={busy}
          onClick={pasteFromClipboard}
        >
          <ClipboardPaste className="mr-1 h-3 w-3" /> Paste
        </Button>
        {name && (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clear}>
            <X className="mr-1 h-3 w-3" /> Remove
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={(e) => void handle(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

/** Loose name key for matching: lowercase, alphanumerics only. */
export function nameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}
