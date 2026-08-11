import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toPng } from 'html-to-image';
import { LifeBuoy, Loader2, Camera, CameraOff } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { formatCapturedErrors } from '@/lib/errorLog';
import { cn } from '@/lib/utils';

interface Props {
  /** Friendly name of the current page, from the sidebar nav ("Purchase Orders"). */
  pageLabel: string;
  className?: string;
}

interface CreateTicketResponse {
  id: string;
  screenshotUrl: string | null;
  notified: boolean;
  notifyError?: string;
}

/** Everything about the browser worth knowing when reproducing a bug. */
function collectBrowserInfo(): string {
  return [
    `UA: ${navigator.userAgent}`,
    `Viewport: ${window.innerWidth}x${window.innerHeight}`,
    `Screen: ${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}x`,
    `Language: ${navigator.language}`,
    `Online: ${navigator.onLine}`,
    `Theme: ${document.documentElement.classList.contains('dark') ? 'dark' : 'light'}`,
    `URL: ${window.location.href}`,
  ].join('\n');
}

/**
 * html-to-image clones the DOM to render it, and clone-node.ts copies styles
 * via getComputedStyle only - there is no CSS property for "current scroll
 * offset", so every cloned scrollable element comes back reset to
 * scrollTop/scrollLeft 0. The app's layout has exactly one scroll container
 * (`<main>` in Layout.tsx - the sidebar and topbar are fixed, `document.body`
 * itself never scrolls) plus the odd inner table with its own overflow-auto.
 * Without this, reporting a bug halfway down a long page or table captures
 * the top of it instead of the thing the user actually scrolled to see.
 *
 * Fix: shift each scrolled container's own children by its current offset
 * right before cloning starts, so the still-clipped (overflow-auto) box shows
 * the same slice the user sees, then undo it once the capture settles. Sticky
 * headers ride along with the shift instead of staying pinned - a minor
 * cosmetic miss next to capturing the wrong section entirely. This never
 * paints visibly: the dialog's overlay covers the page before the shift would
 * be seen (see below).
 */
function freezeScrollOffsets(root: HTMLElement): () => void {
  const restores: Array<() => void> = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    if (el instanceof HTMLElement && (el.scrollTop > 0 || el.scrollLeft > 0)) {
      const { scrollTop, scrollLeft } = el;
      for (const child of Array.from(el.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const prevTransform = child.style.transform;
        child.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)${prevTransform ? ` ${prevTransform}` : ''}`;
        restores.push(() => {
          child.style.transform = prevTransform;
        });
      }
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return () => restores.forEach((restore) => restore());
}

/**
 * "Contact support" - one press captures where the user is and what they are
 * looking at, they add a sentence, and it goes out on WhatsApp.
 *
 * The capture is a DOM render (html-to-image), not a real screenshot: browsers
 * only give a true screen grab behind getDisplayMedia's "choose what to share"
 * prompt, which would defeat the point of a one-press button. Rendering the DOM
 * needs no permission and catches what actually matters - the wrong number, the
 * empty table, the error toast.
 *
 * It is captured BEFORE the dialog opens. Rendering afterwards would photograph
 * the dialog and its overlay sitting on top of the very screen being reported.
 */
export default function SupportButton({ pageLabel, className }: Props) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [shot, setShot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Frozen at capture time: if the user keeps clicking around with the dialog
  // open, the report must still describe the screen the image shows.
  const context = useRef({ path: location.pathname, label: pageLabel });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function startReport() {
    context.current = { path: location.pathname, label: pageLabel };
    setNote('');
    setShot(null);
    setCapturing(true);
    // Open immediately so the button feels responsive; the preview fills in.
    setOpen(true);
    const restoreScroll = freezeScrollOffsets(document.body);
    try {
      // cacheBust defeats html-to-image's cross-render image cache, which
      // otherwise reuses a stale copy of the page on a second report.
      const capture = toPng(document.body, {
        cacheBust: true,
        pixelRatio: 1, // full DPI would push a 4K screen past the 10MB upload cap
        backgroundColor: document.documentElement.classList.contains('dark') ? '#0b1220' : '#ffffff',
        // Fonts are NOT embedded, deliberately. html-to-image inlines every
        // stylesheet it can see, and the app loads the Anek/Noto families from
        // fonts.googleapis.com - a cross-origin sheet whose cssRules the browser
        // refuses to read. It then falls back to re-fetching that sheet over the
        // network, which measured 4x slower (2.0s vs 0.5s), threw two console
        // errors into the very error buffer this ticket attaches, and stalled
        // for tens of seconds on a slow connection. The cost is that one
        // decorative display heading renders in a fallback face; body text,
        // tables, figures and layout - everything a bug report is actually
        // about - are unaffected.
        skipFonts: true,
        // Never photograph the reporting UI itself.
        filter: (node) => !(node instanceof HTMLElement && node.dataset.supportExclude === 'true'),
      });
      // A capture that never settles would leave the reporter stuck behind a
      // disabled Send button, which is worse than no screenshot at all.
      const dataUrl = await Promise.race([
        capture,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
      setShot(dataUrl);
    } catch (err) {
      // A failed capture must not block the report - it just goes text-only.
      console.error('[support] screen capture failed', err);
      setShot(null);
    } finally {
      // Held until the capture (or its 10s timeout) settles - see
      // freezeScrollOffsets, restoring early would un-shift content that
      // html-to-image hasn't cloned yet.
      restoreScroll();
      setCapturing(false);
    }
  }

  useEffect(() => {
    if (open && !capturing) textareaRef.current?.focus();
  }, [open, capturing]);

  async function submit() {
    const trimmed = note.trim();
    if (!trimmed) {
      toast.error('Please describe the issue first');
      textareaRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('note', trimmed);
      form.append('pagePath', context.current.path);
      form.append('pageLabel', context.current.label);
      form.append('browserInfo', collectBrowserInfo());
      form.append('consoleErrors', formatCapturedErrors());
      if (shot) {
        const blob = await (await fetch(shot)).blob();
        form.append('screenshot', blob, 'screen.png');
      }

      const res = await api<CreateTicketResponse>('/support/tickets', {
        method: 'POST',
        multipart: true,
        body: form,
      });

      // Be honest about which of the two things happened. A ticket that was
      // stored but never delivered looks identical to the user otherwise, and
      // they would assume someone had been told.
      if (res.notified) {
        toast.success('Support has been notified on WhatsApp.');
      } else {
        toast.warning('Issue recorded, but the WhatsApp alert did not go out. Please call if it is urgent.');
      }
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the report');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={startReport}
        title="Contact support"
        aria-label="Contact support"
        data-support-exclude="true"
        className={cn(
          'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card/60 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
          className
        )}
      >
        <LifeBuoy className="h-4 w-4" />
      </button>

      <Dialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
        <DialogContent data-support-exclude="true" className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Contact support</DialogTitle>
            <DialogDescription>
              We've noted which page you're on and captured your screen. Just tell us what went wrong.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Page: </span>
            <span className="font-medium text-foreground">{context.current.label}</span>
            <span className="text-muted-foreground"> · {context.current.path}</span>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="support-note">What went wrong?</Label>
            <textarea
              id="support-note"
              ref={textareaRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="e.g. The total on this page shows 0 even though there are 4 lorries listed."
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {capturing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Capturing your screen…
                </>
              ) : shot ? (
                <>
                  <Camera className="h-3.5 w-3.5" /> Screenshot attached
                </>
              ) : (
                <>
                  <CameraOff className="h-3.5 w-3.5" /> Screenshot unavailable — sending the details only
                </>
              )}
            </div>
            {shot && (
              <img
                src={shot}
                alt="Captured screen"
                className="max-h-52 w-full rounded-lg border border-border object-cover object-top"
              />
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={submitting || capturing}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? 'Sending…' : 'Send to support'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
