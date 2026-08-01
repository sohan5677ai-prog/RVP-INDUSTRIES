import { useEffect, useRef } from 'react';

/**
 * Clipboard-image support for the upload zones.
 *
 * Screenshots are the common case here — a UPI/bank app screenshot or a snip of
 * a lorry invoice — and going through Save-as then a file picker for something
 * that is already on the clipboard is pure friction. Two ways in: Ctrl+V while
 * the dialog is open, or the explicit "Paste" button for mouse-only users.
 */

/** First image among clipboard items, or null if the paste carried no image. */
function imageFromItems(items: DataTransferItemList | null | undefined): File | null {
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith('image/')) return file;
  }
  return null;
}

/**
 * Clipboard images arrive as a nameless blob (or a generic "image.png"), which
 * makes every stored proof file look identical. Stamp them so the saved file
 * still says what it is and when it was captured.
 */
function withName(file: Blob, type: string, prefix: string): File {
  const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return new File([file], `${prefix}-${stamp}.${ext}`, { type });
}

/**
 * While `enabled`, a Ctrl+V anywhere in the page hands any pasted image to
 * `onFile`. Pastes that carry no image (ordinary text into an amount box) are
 * left completely alone, so normal typing in the surrounding form still works.
 *
 * Mount this only inside an open dialog: the listener is document-level, and
 * unmounting is what scopes it to the form the user is actually looking at.
 */
export function usePasteImage(enabled: boolean, onFile: (file: File) => void, prefix = 'pasted') {
  // Callers pass inline arrows; keep the listener stable across their renders.
  const handler = useRef(onFile);
  handler.current = onFile;

  useEffect(() => {
    if (!enabled) return;
    function onPaste(e: ClipboardEvent) {
      const file = imageFromItems(e.clipboardData?.items);
      if (!file) return;
      e.preventDefault();
      handler.current(withName(file, file.type, prefix));
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [enabled, prefix]);
}

/**
 * Read an image straight off the system clipboard for the "Paste" button.
 * Returns null when the clipboard holds no image; throws when the browser
 * refuses the read (permission denied, or Firefox, which has no image read) —
 * callers fall back to telling the user to press Ctrl+V.
 */
export async function readImageFromClipboard(prefix = 'pasted'): Promise<File | null> {
  if (!navigator.clipboard?.read) throw new Error('Clipboard read is not supported in this browser');
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    return withName(await item.getType(type), type, prefix);
  }
  return null;
}
