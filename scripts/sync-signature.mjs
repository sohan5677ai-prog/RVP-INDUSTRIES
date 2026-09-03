// Mirrors the authorised-signature artwork (plus the lorry-receipt masthead
// emblems) from client/public into server/src/assets, so the browser-printed
// documents and the PDFKit-drawn ones (tax invoice, purchase verification
// statement, lorry receipt) carry the same marks.
//
//   npm run sync:signature
//
// Run it again whenever any of these PNGs is replaced.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = path.join(ROOT, 'client', 'public');
const TO = path.join(ROOT, 'server', 'src', 'assets');
const FILES = ['authorised-sign.png', 'company-stamp.png', 'ganesha.png', 'balaji.png', 'surya-sign.png', 'shiva.png'];

mkdirSync(TO, { recursive: true });

let missing = 0;
for (const f of FILES) {
  const src = path.join(FROM, f);
  if (!existsSync(src)) {
    console.error(`  missing  client/public/${f}`);
    missing += 1;
    continue;
  }
  copyFileSync(src, path.join(TO, f));
  console.log(`  copied   client/public/${f} -> server/src/assets/${f}`);
}

if (missing) {
  console.error(`\n${missing} file(s) not found. Save the signature and stamp PNGs into client/public first.`);
  process.exit(1);
}
