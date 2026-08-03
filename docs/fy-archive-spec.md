# Financial-Year Archive — Format & Model Classification

Spec for the FY close / export / mount framework. Two parts:

1. **Model classification** — how each of the 52 Prisma models is treated.
2. **`.rvparchive` format** — the on-disk contract.

Design rule underneath both: a financial year is addressable by one integer,
`fyStart` (2025 = FY 2025-26), derived from an IST business date via
`istFinancialYearStart` — never from `createdAt`, because Render runs UTC.

---

## 1. Model classification

Seven classes. The class decides whether a model gets an `fyStart` column, how
that column is filled, and whether the model appears in an archive.

### Class M — Master (10 models)

Shared across every financial year. **No `fyStart` column.** Never duplicated per
year — this is the main reason we don't run a separate database per FY.

| Model | Note |
|---|---|
| `User` | Passwords excluded from archives (see §2.6) |
| `Party` | |
| `Broker` | |
| `AccountGroup` | |
| `Account` | ⚠ `openingBalance` must move out — see §1.8 |
| `FreightRate` | Live rate; historical rates already pinned on `SaleOrder.freightRatePerTonne` |
| `HamaliRate` | Live rate; historical costs already frozen on the documents |
| `CompanyProfile` | Singleton |
| `ProductTaxInfo` | |
| `TallyLedgerMap` | |

Every archive carries a **snapshot** of these in `masters/` so a mounted year can
resolve its own foreign keys even if a party was deleted since. On mount, a master
is inserted **only if absent** — a master that still exists is never overwritten,
because the live row is newer.

A consequence worth stating plainly: **every archive contains the full master
snapshot regardless of which year it covers.** An export of an empty FY 2019-20
still carries all 88 parties with their GSTINs and bank details. This is why
encryption is on by default and why the API refuses a plaintext export unless
`encrypt:false` is passed deliberately.

### Class T — Transactional, event-anchored (28 models)

Gets `fyStart Int`, derived from **its own business date**. Indexed as
`@@index([fyStart])`, and composite `@@index([fyStart, partyId])` where a party
filter already exists.

| Model | Date field | Model | Date field |
|---|---|---|---|
| `PurchaseOrder` | `poDate` | `GunnyBagEntry` | `date` |
| `StockIn` | `arrivalDate` | `GunnySaleEntry` | `date` |
| `Processing` | `processDate` | `OtherIncomeEntry` | `date` |
| `SaleOrder` | `saleDate` | `ElectricityBill` | `date` |
| `SaleDispatch` | `dispatchDate` | `MaintenanceExpense` | `date` |
| `CreditNote` | `noteDate` | `MiscExpense` | `date` |
| `DebitNote` | `noteDate` | `InterestCharge` | `date` |
| `JournalEntry` | `date` | `TermLoanPrincipal` | `date` |
| `Payment` | `date` | `Drawing` | `date` |
| `Receipt` | `date` | `StorageMaintenanceExpense` | `date` |
| `DustPurchase` | `purchaseDate` | `ManualHamaliCost` | `date` |
| `StockTransfer` | `transferDate` | `HamaliVerification` | `asOfDate` |
| `ShellTransfer` | `transferDate` | `TallyUnmappedVoucher` | `date` |
| `HuskTransfer` | `transferDate` | `LoanRepayment` | `date` |

**Event-anchored, not document-anchored — and this is deliberate.** The tempting
alternative is to make a whole document chain inherit the FY of its head (a March
PO keeps its April stock-in in FY 2025-26). That would eliminate every cross-year
foreign key, but it is *statutorily wrong*: input GST on an April invoice belongs
to FY 2026-27's GSTR, and a dispatch invoiced `RVP/01/26-27` is FY 2026-27 revenue.
Anchoring on the event keeps the books correct and pushes the complexity into
carry-forward (§1.7), which is where it belongs.

`CreditNote` / `DebitNote` already carry `noteFy`, and `SaleDispatch` carries
`invoiceFy`. **`fyStart` must be asserted equal to these at write time** — a
mismatch means the note or invoice was numbered into a year it isn't posted in.

### Class D — Derived children (4 models)

Gets `fyStart`, but **copied from the parent, never computed from its own date.**
Splitting a parent and child across two years would tear a single document in half.

| Model | Inherits from | Why not its own date |
|---|---|---|
| `Purchase` | `StockIn.arrivalDate` | `purchaseDate` is operator-settable and can drift past 31 Mar; a Purchase in a different FY from its StockIn splits the seed value from the payable |
| `WeightVerification` | `Purchase` | Approval can happen days after arrival |
| `JournalLine` | `JournalEntry` | A split entry would break the trial balance |
| `SaleAllocation` | `SaleOrder` | Planning link; the PO side legitimately belongs to another year |

Close-time validation should **warn** (not block) when `Purchase.purchaseDate`
falls outside its inherited FY, since that's usually a data-entry slip.

### Class L — Operational logs (3 models)

Gets `fyStart` from `createdAt` / `sentAt`. Archived for audit, but **excluded
from accounting reconciliation** — a failed WhatsApp send is not a voucher.

`EmailLog`, `WhatsAppLog`, `TransportConfirmation`

### Class S — Spanning / state (2 models)

**No `fyStart`.** These are not events, so stamping them is a category error.

| Model | Why | Handling |
|---|---|---|
| `BankLoan` | A drawdown spans years by design; stamping it would hide an open loan from the new year | Stays live and unstamped. `LoanRepayment` (Class T) is stamped normally, so each year sees only its own repayments while the loan itself persists |
| `SiloInventory` | A *current balance* row, not a transaction — there is exactly one per item/location, continuously mutated | Stays live and unstamped. Close writes an immutable `FyClosingStock` snapshot; FY N+1's opening bands derive from it |

### Class C — FY-keyed counters (2 models)

`PoSerialCounter`, `NoteSerialCounter` — already carry an `fy` string with
`@@unique([seriesKey, fy])`. No `fyStart` needed, but this uniqueness becomes a
**hard blocker for mounting**: without it, loading FY 2024-25 back in would let its
counters collide with the current year's numbering.

`SaleDispatch` is already safe — `@@unique([invoiceFy, invoiceSeq, invoiceSeries])`.

Archives carry their year's counter rows so a re-mounted year can still reprint
documents with correct numbers.

### Class X — Excluded from archives (3 models)

`SlackDraft` (ephemeral flow state), `Subscription` and `SubscriptionPayment`
(vendor billing — not the client's books, and containing Razorpay identifiers that
have no business in a file handed to a CA).

---

### 1.7 Cross-FY foreign keys — the actual hard part

Event-anchoring creates edges that cross a year boundary. Full inventory from the
schema, and how each is resolved so an archive stays self-contained:

| # | Edge | When | Resolution |
|---|---|---|---|
| 1 | `StockIn.purchaseOrderId → PurchaseOrder` | PO in Mar, lorry arrives Apr | **(a)** carry-forward |
| 2 | `SaleDispatch.saleOrderId → SaleOrder` | Order Mar, dispatch Apr | **(a)** carry-forward |
| 3 | `SaleAllocation → SaleOrder / PurchaseOrder` | Planning link, routinely spans | **(a)** carry-forward |
| 4 | `LoanRepayment.loanId → BankLoan` | Loans run years | **(a)** — loan is Class S, never leaves |
| 5 | `Payment.purchaseId → Purchase` | Pay in Apr for a Mar purchase | **(b)** bill reference |
| 6 | `Receipt.saleDispatchId → SaleDispatch` | Collect in Jun on a Mar invoice | **(b)** bill reference |
| 7 | `Payment.hamaliVerificationId → HamaliVerification` | Crew settled after period close | **(b)** bill reference |
| 8 | `CreditNote/DebitNote.saleDispatchId → SaleDispatch` | Amendment window runs to 30 Nov | **(c)** ref stub |
| 9 | `EmailLog` / `WhatsAppLog` → documents | Resend an old invoice | **(c)** ref stub |
| 10 | `Processing.purchaseId → Purchase` | Buy Mar, mill Apr | **(d)** opening band |

**(a) Carry-forward re-issue.** At close, any still-open operational document —
`PENDING` PurchaseOrder, `PENDING`/`PARTIAL` SaleOrder — is re-issued as a new row
in FY N+1 carrying `carriedFromFy` + `carriedFromId`. The old row is marked
`CARRIED` and closed. Next year's children attach to the *new* head. This is
standard practice, not a workaround: open orders genuinely carry forward.

**(b) Bill-reference settlement.** Money edges do **not** keep their FK across a
year. At close, every unsettled purchase and unpaid invoice becomes an
`OpeningBillRef { fyStart, partyId, kind, docLabel, docDate, amount }`, and next
year's Payment/Receipt settles *that*. This is exactly Tally's bill-wise opening
balance, and it keeps party ledgers continuous without dragging last year's
documents into this year's tables.

**(c) Ref stubs.** Some edges must legitimately point at a closed document — a
November credit note against a March invoice cannot pretend the invoice doesn't
exist. The archive's `refs/stubs.ndjson` carries a minimal read-only projection of
each out-of-FY row referenced from inside. On mount, a stub is inserted **only if
the real row is absent**, and flagged `isStub: true` so no report counts it as a
document in its own right.

**(d) Opening band.** `Processing.purchaseId` is already nullable ("standalone
processing runs remain valid"). Un-milled seed at year end becomes FY N+1 opening
*price-band* tonnage, and April's mill run draws from the band rather than reaching
back to a specific March `Purchase`. This fits the stock-by-price model exactly —
seed is fungible by cost band, so nothing is lost.

### 1.8 Schema changes this forces

Beyond adding `fyStart`:

| Change | Reason |
|---|---|
| **New** `FinancialYear { fyStart @id, label, status, source, closedAt, closedBy, archiveSha256 }` | `status: OPEN \| SOFT_CLOSED \| LOCKED`; `source: LIVE \| MOUNTED` |
| **Move** `Account.openingBalance` → new `AccountOpening { fyStart, accountId, amount }` `@@unique([fyStart, accountId])` | It is FY-specific data currently sitting on a shared master — switching years would otherwise show the wrong opening balance on every account |
| **New** `OpeningBillRef` | Mechanism (b) |
| **New** `FyClosingStock { fyStart, itemType, location, weightKg, totalValue }` + per-band rows | Immutable close snapshot; feeds next year's opening bands |
| **New** `ArchiveJob { id, fyStart, kind, status, progress, storagePath, sha256, error, createdBy }` | `kind: EXPORT \| MOUNT \| UNMOUNT` |
| **New** `ArchiveAuditLog` | Who did what, when (IST), with which checksum |
| **Add** `carriedFromFy` / `carriedFromId` to `PurchaseOrder`, `SaleOrder` | Mechanism (a) |
| **Add** `isStub Boolean @default(false)` to every model reachable by a stub | Mechanism (c) |

Already FY-safe, no change needed: `SaleOrder.freightRatePerTonne` and
`seedCostSnapshot` (stamped at creation), `SaleDispatch` invoice uniqueness.

---

## 2. `.rvparchive` format

### 2.1 Layout

A zip. Filename `FY2025-26_RVP_20260401-1842.rvparchive`.

```
manifest.json                              ← always plaintext
masters/
  010_User.ndjson  020_Party.ndjson  ...   (10 files, Class M)
tables/
  010_PurchaseOrder.ndjson                 ← numeric prefix = FK-safe insert order
  020_StockIn.ndjson
  030_Purchase.ndjson
  ...                                      (37 files, Classes T/D/L/S)
counters/
  010_PoSerialCounter.ndjson  020_NoteSerialCounter.ndjson
```

**Built and shipping.** 49 entries plus the manifest, produced by
`server/src/archive/export.service.ts`.

**Not yet emitted** — these depend on machinery that arrives in later phases, and
the format reserves their paths:

| Folder | Contents | Blocked on |
|---|---|---|
| `refs/stubs.ndjson` | Out-of-FY rows referenced from inside (mechanism (c)) | Phase 0 — needs `isStub` |
| `opening/` | `accountOpenings`, `billRefs`, `stockBands` | Phase 3 — the close wizard produces them |
| `closing/` | `trialBalance`, `stockBands`, `siloInventory` | Phase 3 — `FyClosingStock` |
| `reports/FY2025-26_books.xlsx` | The CA-readable workbook | Phase 2b — report formatting, separate from the data pipeline |

Until `closing/` exists, the year's trial-balance totals live in
`manifest.totals`, which is what the balance assertion checks.

The numeric prefixes encode a topological sort of the FK graph, so an importer can
insert in filename order without knowing the schema. `SET CONSTRAINTS ALL DEFERRED`
inside the transaction makes this belt-and-braces rather than load-bearing.

### 2.2 Why NDJSON

One JSON object per line, no wrapping array. A `pg_dump` can't be selectively
re-imported into a live database and can't be read by anything but Postgres; a
single big JSON array has to be fully materialised in memory. NDJSON streams
line-by-line, so a 500k-row table never blows Render's dyno, and it diffs.

### 2.3 Encoding rules

These are the rules that decide whether the round-trip is lossless:

- **`Decimal` → string, always.** `"48210993.00"`, never `48210993`. A JS float
  silently loses paise on large values. This is the single most important rule in
  the format.
- **`DateTime` → ISO-8601 UTC with `Z`.** Never a localised string. IST is
  re-derived on read through `istDate`.
- **`Json` columns** (`billAddables`, `qualityAdjustments`, `seedCostSnapshot`)
  embed as-is, no re-stringification.
- **`null` is explicit; `undefined` is omitted.** They mean different things on
  re-insert.
- **Keys sorted.** Canonical ordering makes two exports of the same year
  byte-identical, so checksums are reproducible and archives are diffable.
- **`Int`** stays a JSON number — all in safe-integer range (weights in kg).
- Enums as their string name.

### 2.4 `manifest.json`

Plaintext even when the payload is encrypted — it holds only metadata, no party
names, no GSTINs, no amounts beyond aggregate totals. This is what lets the
Archive Manager page identify a dropped file *before* asking for the passphrase.

```json
{
  "format": "rvparchive",
  "formatVersion": 1,
  "schemaVersion": 17,
  "erpCommit": "ca11adf",
  "company": { "name": "RVP INDUSTRIES", "gstin": "37…" },
  "financialYear": {
    "fyStart": 2025, "label": "2025-26",
    "from": "2025-03-31T18:30:00.000Z", "to": "2026-03-31T18:30:00.000Z"
  },
  "exportedAt": "2026-08-03T18:18:59.000Z",
  "exportedAtIst": "03/08/2026 11:48:59 PM",
  "exportedBy": { "userId": "…", "username": "sohan" },
  "encryption": {
    "enabled": true, "cipher": "aes-256-gcm", "kdf": "scrypt",
    "N": 32768, "r": 8, "p": 1, "salt": "…"
  },
  "entries": {
    "tables/020_StockIn.ndjson": {
      "model": "StockIn", "rows": 34, "plainBytes": 15383,
      "sha256": "f1f4f7b8…", "iv": "…", "tag": "…"
    }
  },
  "totals": {
    "trialBalanceDr": "84374639.92",
    "trialBalanceCr": "84374639.92",
    "rows": 653
  },
  "seal": "a46c1051d65484c9…"
}
```

Row counts and checksums live in one `entries` map rather than the parallel
`counts` / `checksums` objects first sketched — two maps that could disagree
about the same file is a bug waiting to happen.

`financialYear.from` / `to` are the half-open UTC instants of the year, so
`18:30:00Z` is midnight IST on 1 April. `closingStock` totals move here once
Phase 3 produces a real close snapshot; the current live `SiloInventory` is a
*today* balance and would be wrong on a past year.

`seal` is the SHA-256 of the canonicalised manifest with `seal` removed — so the
manifest can't be edited to match a tampered payload.

`totals.trialBalanceDr === totals.trialBalanceCr` is asserted at export and
re-asserted at mount. An archive whose trial balance doesn't balance is refused.

### 2.5 Encryption

Each payload entry is encrypted **individually** with AES-256-GCM, so decryption
stays streaming and per-file. `manifest.json` is left plaintext.

The key is **scrypt** (N=2^15, r=8, p=1), not Argon2id as first sketched, purely
because scrypt ships in `node:crypto`. An archive format whose only dependency is
the standard library is one fewer thing that can fail to install three years from
now, when someone actually needs to open FY 2025-26.

Compression and encryption interact, so the two cases store differently:

| | zip method | entry bytes | CRC covers |
|---|---|---|---|
| Plain | DEFLATE | the NDJSON | the NDJSON |
| Encrypted | STORE | `GCM(deflateRaw(ndjson))` | the ciphertext |

Encrypted entries are STOREd because their bytes are ciphertext — a zip reader
that tried to inflate them would fail. Compression still happens, just inside the
envelope and *before* encryption, where it can still do some good: a real
`StockIn` table went 15,383 plaintext bytes → 2,768 stored.

Both cases produce a zip that Windows Explorer, `unzip` and `Expand-Archive` open
normally; the encrypted payload files simply read as opaque bytes.

Encryption is optional per export but **on by default**, and the API refuses a
plaintext export unless `encrypt:false` is passed explicitly — the payload
carries GSTINs, bank account numbers and IFSC codes for every party.

### 2.6 What is deliberately not in an archive

- `User.password` hashes — users are re-linked by `username` on mount; a bcrypt
  hash in a file that leaves the building is a liability with no upside.
- Class X models (`SlackDraft`, `Subscription`, `SubscriptionPayment`).
- TaxPro / Razorpay credentials from `CompanyProfile` — stripped on export,
  preserved on the live row.
- Uploaded file *bytes*. `invoiceFileUrl`, `kataFileUrl`, `screenshotUrl` point at
  Supabase Storage and are carried as URLs. Bundling every scanned invoice would
  multiply archive size by 50× for data that already has its own retention.
  A separate "download documents" export can cover that if wanted.

### 2.7 Forward compatibility

`schemaVersion` in the manifest is compared against the running ERP's. When an
archive is older, the mount pipeline applies ordered transforms from
`server/src/archive/migrations/v{n}_to_v{n+1}.ts` before insert. This is the part
that will bite in year three if it isn't built in year one: every schema change
after the first export needs a transform, and the preflight must refuse rather
than guess when one is missing.

---

## 3. Verification contract

A mount, and any removal that follows, is gated on all of:

1. Every file's SHA-256 matches `manifest.checksums`.
2. `manifest.seal` matches the recomputed canonical hash.
3. `counts` matches actual lines per file.
4. `totals.trialBalanceDr === totals.trialBalanceCr`.
5. `schemaVersion` ≤ current, with a transform chain available for the gap.
6. `fyStart` not already present in the database (or explicit replace, which
   requires un-mounting first).
7. Every master ID referenced by the payload resolves — against the live table, or
   against `masters/` for re-creation.

Removal of a live year additionally requires a **verified round-trip**: export →
re-import into a scratch schema → row counts, checksums and trial balance all
match → only then does the removal unlock. Never remove on the strength of an
unverified file.

---

## 4. Implementation

| File | Role |
|---|---|
| `server/src/archive/registry.ts` | The classification in §1, as code. The only file Phase 0 has to change |
| `server/src/archive/serialize.ts` | Canonical NDJSON encoding (§2.3) |
| `server/src/archive/crc32.ts` | CRC-32 for the zip central directory |
| `server/src/archive/zip.ts` | Entry spooler + minimal streaming zip writer |
| `server/src/archive/crypto.ts` | scrypt KDF, AES-256-GCM per entry |
| `server/src/archive/manifest.ts` | Manifest shape, seal, seal verification |
| `server/src/archive/export.service.ts` | Orchestration — read-only, touches no table |
| `server/src/archive/jobs.ts` | In-process job registry (until `ArchiveJob` lands in Phase 0) |
| `server/src/controllers/archive.controller.ts` | Endpoints |
| `server/src/archive/archive.test.ts` | 25 tests, including a zip reader that round-trips the writer |

### Endpoints — all `DEVELOPER` only

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/archive/financial-years` | Years containing data, derived from business dates |
| `GET` | `/api/archive/describe` | What an archive would contain, without building one |
| `POST` | `/api/archive/exports` | Start an export. `202` + job id; body `{ fyStart, passphrase, encrypt? }` |
| `GET` | `/api/archive/exports` | All jobs this process knows about |
| `GET` | `/api/archive/exports/:id` | Status, progress %, current model, sealed manifest |
| `GET` | `/api/archive/exports/:id/download` | Signed Supabase URL, or a direct stream if the upload failed |

The finished archive is uploaded to a **private** `archives` bucket
(`SUPABASE_ARCHIVE_BUCKET`) and only ever handed out as a 5-minute signed URL.
Render's disk is ephemeral, so the local copy is a fallback, not the store.

### Known limits

- Jobs are in-process. A dyno restart mid-export loses the job; since export is
  read-only, nothing is damaged and it can simply be re-run.
- Archives above 128 MB are not buffered for the Supabase upload and stay on
  local disk. Realistic years are three orders of magnitude below that — a real
  FY 2025-26 export came to 44 KB.
- No zip64, so 4 GB is the hard ceiling.
- `SCHEMA_VERSION` in `manifest.ts` must be bumped by hand whenever a schema
  change alters archive content (§2.7).
