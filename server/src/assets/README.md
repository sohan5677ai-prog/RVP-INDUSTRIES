# Signature, logo & masthead artwork (server copy)

`rvp-logo-dark.png`, `authorised-sign.png`, `company-stamp.png`, `ganesha.png`
and `balaji.png` are mirrored here from `client/public` by
`npm run sync:signature` (run from the repo root).

`rvp-logo-dark.png` is the official RVP Industries logo in its darkened cut -
the one that reads on white paper - flattened onto white and kept small on
purpose: PDFKit re-encodes whatever it is given, and an alpha channel costs a
soft mask on every page. It is read by `server/src/lib/brandAssets.ts` and
drawn on the letterheads of the tax invoice, credit/debit note, party
statement, sales dues, brokerage statement and purchase verification
statement. The browser-printed twins of those documents load the same artwork
by URL as `rvp-logo-dark.webp`, so the two copies of a document match.

The signature/stamp pair is read at runtime by `server/src/lib/signatureAssets.ts`
and stamped onto the PDFKit documents - the tax invoice and the purchase
verification statement. `ganesha.png`/`balaji.png` are read by
`server/src/lib/lorryReceiptPdf.ts` for the Surya Road Lines lorry-receipt
masthead. The path resolves the same from `src/lib` (tsx, dev) and `dist/lib`
(tsc output on Render), so the build never has to copy them.

Do not edit them here; replace the masters in `client/public` and re-run the
sync, otherwise the printed page and the downloaded PDF will drift apart.
