# Signature artwork (server copy)

`authorised-sign.png` and `company-stamp.png` are mirrored here from
`client/public` by `npm run sync:signature` (run from the repo root).

They are read at runtime by `server/src/lib/signatureAssets.ts` and stamped onto
the PDFKit documents - the tax invoice and the purchase verification statement.
The path resolves the same from `src/lib` (tsx, dev) and `dist/lib` (tsc output
on Render), so the build never has to copy them.

Do not edit them here; replace the masters in `client/public` and re-run the
sync, otherwise the printed page and the downloaded PDF will drift apart.
