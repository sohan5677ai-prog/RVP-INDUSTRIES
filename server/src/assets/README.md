# Signature & masthead artwork (server copy)

`authorised-sign.png`, `company-stamp.png`, `ganesha.png` and `balaji.png` are
mirrored here from `client/public` by `npm run sync:signature` (run from the
repo root).

The signature/stamp pair is read at runtime by `server/src/lib/signatureAssets.ts`
and stamped onto the PDFKit documents - the tax invoice and the purchase
verification statement. `ganesha.png`/`balaji.png` are read by
`server/src/lib/lorryReceiptPdf.ts` for the Surya Road Lines lorry-receipt
masthead. The path resolves the same from `src/lib` (tsx, dev) and `dist/lib`
(tsc output on Render), so the build never has to copy them.

Do not edit them here; replace the masters in `client/public` and re-run the
sync, otherwise the printed page and the downloaded PDF will drift apart.
