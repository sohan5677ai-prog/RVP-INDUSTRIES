// Developer-only Archive Manager: export a financial year to a sealed
// .rvparchive, watch the job run, download it, and identify an archive dropped
// back in. See docs/fy-archive-spec.md for the format and the model
// classification behind it.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Download,
  Upload,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  Lock,
  LockOpen,
  ShieldAlert,
  FileArchive,
  ChevronDown,
  Scale,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api, apiBlob, getErrorMessage } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  readArchiveManifest, summariseEntries, formatBytes, ArchiveReadError,
  type ArchiveManifest,
} from '@/lib/rvparchive';

interface FinancialYear {
  fyStart: number;
  label: string;
  status: string;
  source: string;
}

interface ExportJob {
  id: string;
  fyStart: number;
  status: 'RUNNING' | 'READY' | 'FAILED';
  progress: number;
  step: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  fileName: string | null;
  bytes: number | null;
  manifest: ArchiveManifest | null;
}

interface ModelInfo {
  name: string;
  class: string;
  entry: string;
  dateField: string | null;
  omitted: string[];
  note: string | null;
}

const CLASS_LABELS: Record<string, { title: string; blurb: string }> = {
  MASTER: { title: 'Master', blurb: 'Shared across every year — snapshotted so a mounted year can resolve its own keys' },
  TXN: { title: 'Transactional', blurb: 'Scoped by its own business date' },
  DERIVED: { title: 'Derived child', blurb: 'Inherits its parent document’s year, never its own date' },
  LOG: { title: 'Operational log', blurb: 'Archived for audit, excluded from accounting checks' },
  SPANNING: { title: 'Spanning / state', blurb: 'Not an event — snapshotted whole, never date-sliced' },
  COUNTER: { title: 'Counter', blurb: 'Already FY-keyed; carried so numbering stays correct' },
};

const POLL_MS = 1500;

export default function ArchiveManager() {
  const { user } = useAuth();
  const dev = user?.role === 'DEVELOPER';

  const [years, setYears] = useState<FinancialYear[]>([]);
  const [currentFyStart, setCurrentFyStart] = useState<number | null>(null);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [exportTarget, setExportTarget] = useState<FinancialYear | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [encrypt, setEncrypt] = useState(true);
  const [starting, setStarting] = useState(false);

  const [dropped, setDropped] = useState<{ name: string; size: number; manifest: ArchiveManifest } | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [showModels, setShowModels] = useState(false);

  const loadJobs = useCallback(async () => {
    const data = await api<{ jobs: ExportJob[] }>('/archive/exports');
    setJobs(data.jobs);
    return data.jobs;
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [yearData] = await Promise.all([
        api<{ years: FinancialYear[]; currentFyStart: number }>('/archive/financial-years'),
        loadJobs(),
      ]);
      setYears(yearData.years);
      setCurrentFyStart(yearData.currentFyStart);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [loadJobs]);

  useEffect(() => {
    if (dev) void refresh();
    else setLoading(false);
  }, [dev, refresh]);

  // Poll only while something is actually running, so an idle page is silent.
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'RUNNING')) return;
    const timer = setInterval(() => { void loadJobs(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [jobs, loadJobs]);

  async function startExport() {
    if (!exportTarget) return;
    setStarting(true);
    setError(null);
    try {
      await api('/archive/exports', {
        method: 'POST',
        body: {
          fyStart: exportTarget.fyStart,
          encrypt,
          ...(encrypt ? { passphrase } : {}),
        },
      });
      setExportTarget(null);
      setPassphrase('');
      setConfirmPassphrase('');
      await loadJobs();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  /**
   * The endpoint answers with a signed Supabase URL when the upload succeeded,
   * and streams the file itself when it did not — so both shapes land here.
   */
  async function download(job: ExportJob) {
    try {
      const blob = await apiBlob(`/archive/exports/${job.id}/download`);
      if (blob.type.includes('application/json')) {
        const { url } = JSON.parse(await blob.text()) as { url: string };
        window.location.href = url;
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = job.fileName ?? 'archive.rvparchive';
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleFile(file: File) {
    setDropError(null);
    setDropped(null);
    setReading(true);
    try {
      const manifest = await readArchiveManifest(file);
      setDropped({ name: file.name, size: file.size, manifest });
    } catch (err) {
      setDropError(
        err instanceof ArchiveReadError ? err.message : `Could not read the file: ${getErrorMessage(err)}`,
      );
    } finally {
      setReading(false);
    }
  }

  async function toggleModels() {
    setShowModels((v) => !v);
    if (!models) {
      try {
        const data = await api<{ models: ModelInfo[] }>('/archive/describe');
        setModels(data.models);
      } catch (err) {
        setError(getErrorMessage(err));
      }
    }
  }

  if (!dev) {
    return (
      <div className="space-y-6">
        <PageHeader title="Archive Manager" icon={Archive} />
        <Card>
          <CardContent className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            An archive contains every party’s GSTIN, bank details and full transaction
            history in one file. This page is restricted to the developer account.
          </CardContent>
        </Card>
      </div>
    );
  }

  const runningFor = new Set(jobs.filter((j) => j.status === 'RUNNING').map((j) => j.fyStart));
  const passphraseValid = !encrypt || (passphrase.length >= 12 && passphrase === confirmPassphrase);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Archive Manager"
        icon={Archive}
        description="Export a financial year to a sealed, encrypted archive file, or drop one back in to see what it holds."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Financial years ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Financial Years</CardTitle>
          <CardDescription>
            Years that contain data. Exporting reads only — it never writes to the books.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : years.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No dated records found yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Financial year</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {years.map((year) => (
                  <TableRow key={year.fyStart}>
                    <TableCell className="font-medium">
                      FY {year.label}
                      {year.fyStart === currentFyStart && (
                        <Badge variant="secondary" className="ml-2">Current</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                        <LockOpen className="h-3.5 w-3.5" /> Open
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">Live</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={runningFor.has(year.fyStart)}
                        onClick={() => { setExportTarget(year); setEncrypt(true); }}
                      >
                        {runningFor.has(year.fyStart)
                          ? <><Loader2 className="animate-spin" /> Exporting…</>
                          : <><Download /> Export</>}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Jobs ───────────────────────────────────────────────────────── */}
      {jobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Exports</CardTitle>
            <CardDescription>
              Jobs live in the server’s memory and are cleared an hour after they finish.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-xl border bg-card/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {job.status === 'RUNNING' && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />}
                    {job.status === 'READY' && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />}
                    {job.status === 'FAILED' && <XCircle className="h-4 w-4 shrink-0 text-destructive" />}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {job.fileName ?? `FY ${job.fyStart}-${String((job.fyStart + 1) % 100).padStart(2, '0')}`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {job.status === 'RUNNING' && (job.step ? `Writing ${job.step}…` : 'Starting…')}
                        {job.status === 'READY' && job.bytes != null && (
                          <>
                            {formatBytes(job.bytes)} · {job.manifest?.totals.rows ?? 0} rows
                            {job.manifest?.encryption.enabled && <> · <Lock className="inline h-3 w-3" /> encrypted</>}
                          </>
                        )}
                        {job.status === 'FAILED' && <span className="text-destructive">{job.error}</span>}
                      </div>
                    </div>
                  </div>
                  {job.status === 'READY' && (
                    <Button size="sm" onClick={() => void download(job)}>
                      <Download /> Download
                    </Button>
                  )}
                </div>

                {job.status === 'RUNNING' && (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-500"
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>
                )}

                {job.status === 'READY' && job.manifest && (
                  <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Scale className="h-3.5 w-3.5" />
                      Trial balance Dr {job.manifest.totals.trialBalanceDr} = Cr {job.manifest.totals.trialBalanceCr}
                    </span>
                    <span>Seal {job.manifest.seal?.slice(0, 12)}…</span>
                    <span>Schema v{job.manifest.schemaVersion}</span>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── Load an archive ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Load an archive</CardTitle>
          <CardDescription>
            The manifest is the one part of an archive left unencrypted, so a dropped file
            identifies itself here without uploading anything or asking for the passphrase.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
            onClick={() => fileInput.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
              dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/40'
            }`}
          >
            {reading ? (
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
            ) : (
              <Upload className="h-7 w-7 text-muted-foreground" />
            )}
            <div className="text-sm font-medium">
              {reading ? 'Reading manifest…' : 'Drop a .rvparchive file here, or click to browse'}
            </div>
            <div className="text-xs text-muted-foreground">
              Only the manifest is read — a 200 MB archive identifies as fast as a 40 KB one.
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".rvparchive,.zip"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = '';
              }}
            />
          </div>

          {dropError && (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{dropError}</span>
            </div>
          )}

          {dropped && <DroppedArchive dropped={dropped} />}
        </CardContent>
      </Card>

      {/* ── What an archive contains ───────────────────────────────────── */}
      <Card>
        <CardHeader className="cursor-pointer" onClick={() => void toggleModels()}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>What goes into an archive</CardTitle>
              <CardDescription>
                How each model in the schema is scoped to a financial year.
              </CardDescription>
            </div>
            <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${showModels ? 'rotate-180' : ''}`} />
          </div>
        </CardHeader>
        {showModels && (
          <CardContent className="space-y-5">
            {!models ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              Object.entries(CLASS_LABELS).map(([cls, meta]) => {
                const group = models.filter((m) => m.class === cls);
                if (group.length === 0) return null;
                return (
                  <div key={cls}>
                    <div className="flex flex-wrap items-baseline gap-2">
                      <h3 className="text-sm font-semibold">{meta.title}</h3>
                      <Badge variant="secondary">{group.length}</Badge>
                      <span className="text-xs text-muted-foreground">{meta.blurb}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {group.map((m) => (
                        <span
                          key={m.name}
                          title={m.dateField ? `Scoped by ${m.dateField}` : m.note ?? undefined}
                          className="rounded-md bg-muted px-2 py-1 font-mono text-xs"
                        >
                          {m.name}
                          {m.dateField && <span className="text-muted-foreground"> · {m.dateField}</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        )}
      </Card>

      {/* ── Export dialog ──────────────────────────────────────────────── */}
      <Dialog open={Boolean(exportTarget)} onOpenChange={(open) => !open && setExportTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export FY {exportTarget?.label}</DialogTitle>
            <DialogDescription>
              Reads every row belonging to this year into a sealed archive file. Nothing in
              the books is changed, and no year is removed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3">
              <input
                type="checkbox"
                checked={encrypt}
                onChange={(e) => setEncrypt(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span className="text-sm">
                <span className="font-medium">Encrypt this archive</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  The payload carries every party’s GSTIN, bank account number and IFSC.
                  Leave this on unless you have a specific reason not to.
                </span>
              </span>
            </label>

            {encrypt && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Passphrase</label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="At least 12 characters"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Confirm passphrase</label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassphrase}
                    onChange={(e) => setConfirmPassphrase(e.target.value)}
                  />
                </div>
                {passphrase.length > 0 && passphrase.length < 12 && (
                  <p className="text-xs text-destructive">Passphrase must be at least 12 characters.</p>
                )}
                {confirmPassphrase.length > 0 && passphrase !== confirmPassphrase && (
                  <p className="text-xs text-destructive">Passphrases do not match.</p>
                )}
                <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                  There is no recovery. Lose this passphrase and the archive cannot be opened
                  by anyone, including us — store it wherever you keep the archive.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setExportTarget(null)}>Cancel</Button>
            <Button onClick={() => void startExport()} disabled={!passphraseValid || starting}>
              {starting ? <><Loader2 className="animate-spin" /> Starting…</> : <><Download /> Start export</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Preflight summary of a dropped archive, read entirely in the browser. */
function DroppedArchive({ dropped }: { dropped: { name: string; size: number; manifest: ArchiveManifest } }) {
  const { manifest } = dropped;
  const summary = summariseEntries(manifest);
  const balanced = manifest.totals.trialBalanceDr === manifest.totals.trialBalanceCr;

  return (
    <div className="rounded-2xl border bg-card/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <FileArchive className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="text-base font-semibold">FY {manifest.financialYear.label}</div>
            <div className="truncate text-xs text-muted-foreground" title={dropped.name}>
              {dropped.name} · {formatBytes(dropped.size)}
            </div>
          </div>
        </div>
        <Badge variant={manifest.encryption.enabled ? 'secondary' : 'destructive'}>
          {manifest.encryption.enabled
            ? <><Lock className="h-3 w-3" /> Encrypted</>
            : <><LockOpen className="h-3 w-3" /> Not encrypted</>}
        </Badge>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-3">
        <Field label="Rows" value={manifest.totals.rows.toLocaleString('en-IN')} />
        <Field label="Files" value={`${summary.populated} of ${summary.files} populated`} />
        <Field label="Exported" value={manifest.exportedAtIst} />
        <Field label="By" value={manifest.exportedBy.username} />
        <Field label="Schema" value={`v${manifest.schemaVersion}`} />
        <Field label="ERP commit" value={manifest.erpCommit ?? '—'} />
      </dl>

      <div className="mt-4 space-y-1.5 border-t pt-3 text-xs">
        <div className={balanced ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}>
          {balanced ? <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" /> : <XCircle className="mr-1 inline h-3.5 w-3.5" />}
          Trial balance Dr {manifest.totals.trialBalanceDr} {balanced ? '=' : '≠'} Cr {manifest.totals.trialBalanceCr}
        </div>
        <div className="text-muted-foreground">
          Seal {manifest.seal?.slice(0, 24)}… · {summary.masters} master rows,{' '}
          {summary.tables} transaction rows, {summary.counters} counter rows
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3">
        <Button size="sm" disabled title="Mounting arrives with Phase 4">
          <Upload /> Mount this year
        </Button>
        <p className="text-xs text-muted-foreground">
          Reading and verifying a dropped archive works now. Loading one back into the
          database needs the fyStart row scoping first, so nothing mounted can mix with
          the live year.
        </p>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm" title={value}>{value}</dd>
    </div>
  );
}
