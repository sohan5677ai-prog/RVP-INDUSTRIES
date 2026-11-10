import { describe, it, expect } from 'vitest';
import { sniffFileType, SNIFFED_TYPE_META } from './fileSignature.js';

/** Build a buffer from a byte prefix plus filler, as a real file would look. */
function withPrefix(bytes: number[], length = 64): Buffer {
  const buf = Buffer.alloc(length, 0x41);
  Buffer.from(bytes).copy(buf, 0);
  return buf;
}

describe('sniffFileType', () => {
  it('identifies each accepted format', () => {
    expect(sniffFileType(withPrefix([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('pdf');
    expect(sniffFileType(withPrefix([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(
      sniffFileType(withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ).toBe('png');
    expect(sniffFileType(withPrefix([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif');
    expect(sniffFileType(withPrefix([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe('gif');
  });

  it('identifies WebP, whose second tag sits at offset 8', () => {
    const buf = withPrefix([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00]);
    Buffer.from([0x57, 0x45, 0x42, 0x50]).copy(buf, 8);
    expect(sniffFileType(buf)).toBe('webp');
  });

  it('rejects RIFF that is not WebP, such as a WAV', () => {
    const buf = withPrefix([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00]);
    Buffer.from([0x57, 0x41, 0x56, 0x45]).copy(buf, 8);
    expect(sniffFileType(buf)).toBeNull();
  });

  // The bypass this module exists to close: the extension allow-list only ever
  // saw the filename, which the client picks.
  it('rejects HTML and SVG however they are named', () => {
    expect(sniffFileType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffFileType(Buffer.from('<!DOCTYPE html><body>hi'))).toBeNull();
    expect(sniffFileType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('rejects executables and archives', () => {
    expect(sniffFileType(withPrefix([0x4d, 0x5a]))).toBeNull(); // PE/EXE
    expect(sniffFileType(withPrefix([0x7f, 0x45, 0x4c, 0x46]))).toBeNull(); // ELF
    expect(sniffFileType(withPrefix([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // ZIP
  });

  it('rejects a polyglot whose real signature is not at the start', () => {
    // An HTML prologue with a JPEG header further in must not pass: the
    // browser would treat it as HTML, which is the whole problem.
    const buf = Buffer.concat([
      Buffer.from('<html><!-- '),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from(' --></html>'),
    ]);
    expect(sniffFileType(buf)).toBeNull();
  });

  it('rejects empty and truncated buffers without throwing', () => {
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
    expect(sniffFileType(Buffer.from([0x25, 0x50]))).toBeNull();
    // RIFF header present but the file ends before the WEBP tag.
    expect(sniffFileType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10]))).toBeNull();
  });
});

describe('SNIFFED_TYPE_META', () => {
  it('gives every sniffable type a canonical extension and media type', () => {
    for (const [type, meta] of Object.entries(SNIFFED_TYPE_META)) {
      expect(meta.ext.startsWith('.'), `${type} ext`).toBe(true);
      expect(meta.mime).toMatch(/^(image|application)\//);
    }
    // The stored extension is canonical, so .jpeg uploads normalise to .jpg.
    expect(SNIFFED_TYPE_META.jpeg.ext).toBe('.jpg');
  });
});
