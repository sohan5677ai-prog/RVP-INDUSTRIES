import { useEffect, useState, memo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Wrench,
  Clock,
  ShieldCheck,
  AlertTriangle,
  Play,
  Square,
  Eye,
  CheckCircle2,
  Phone,
  MessageSquare,
  Zap,
} from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import type { MaintenanceStatus, MaintenanceConfig } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import MaintenanceScreen from './MaintenanceScreen';

const DURATION_PRESETS = [
  { label: '5 Mins', minutes: 5 },
  { label: '10 Mins', minutes: 10 },
  { label: '15 Mins', minutes: 15 },
  { label: '30 Mins', minutes: 30 },
  { label: '45 Mins', minutes: 45 },
  { label: '1 Hour', minutes: 60 },
  { label: '2 Hours', minutes: 120 },
];

const MESSAGE_TEMPLATES = [
  {
    title: 'Core Database & Accounting Engine Upgrade',
    message:
      'We are deploying essential database indexing, ledger reconciliations, and performance optimizations. The ERP will be back online shortly with improved speeds.',
  },
  {
    title: 'Emergency Bug Fix & Stability Patch',
    message:
      'A critical hotfix is being applied to system calculations and reports. All ongoing transactions and data remain completely safe and secure.',
  },
  {
    title: 'Scheduled Server Infrastructure Maintenance',
    message:
      'We are upgrading the cloud servers and network connections to improve reliability. System access for all users will resume in a few minutes.',
  },
  {
    title: 'Year-End Archival & Balance Sheet Sync',
    message:
      'The developer is performing automated data archival and financial audit reconciliations. The system is paused temporarily to prevent conflicting updates.',
  },
];

/**
 * Isolated timer component to avoid re-rendering the parent form on every second tick
 */
const DevLiveCountdown = memo(function DevLiveCountdown({
  endsAt,
  isUnderMaintenance,
}: {
  endsAt?: string | null;
  isUnderMaintenance: boolean;
}) {
  const [secondsLeft, setSecondsLeft] = useState<number>(() => {
    if (endsAt && isUnderMaintenance) {
      return Math.max(0, Math.floor((new Date(endsAt).getTime() - Date.now()) / 1000));
    }
    return 0;
  });

  useEffect(() => {
    if (!endsAt || !isUnderMaintenance) {
      setSecondsLeft(0);
      return;
    }

    const update = () => {
      const diff = Math.max(0, Math.floor((new Date(endsAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(diff);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [endsAt, isUnderMaintenance]);

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const timerStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  return (
    <div className="font-mono text-3xl sm:text-4xl font-bold text-amber-600 dark:text-amber-300 tracking-tight">
      {timerStr}
    </div>
  );
});

export default function DeveloperMaintenance() {
  const qc = useQueryClient();

  // Fetch developer config & live status with a relaxed 6s interval
  const { data } = useQuery({
    queryKey: ['maintenance-config'],
    queryFn: () =>
      api<{ config: MaintenanceConfig; status: MaintenanceStatus }>(
        '/system/maintenance/config'
      ),
    refetchInterval: 6000,
    staleTime: 5000,
  });

  const status = data?.status;

  // Form State
  const [title, setTitle] = useState('System Maintenance in Progress');
  const [message, setMessage] = useState(
    'We are performing essential system maintenance and database optimization. The ERP will be back online shortly.'
  );
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [customMinutes, setCustomMinutes] = useState('');
  const [contactInfo, setContactInfo] = useState('Developer / Technical Support');
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Sync state once initial data loads
  useEffect(() => {
    if (data?.config) {
      if (data.config.title) setTitle(data.config.title);
      if (data.config.message) setMessage(data.config.message);
      if (data.config.durationMinutes) setDurationMinutes(data.config.durationMinutes);
      if (data.config.contactInfo) setContactInfo(data.config.contactInfo);
    }
  }, [data?.config]);

  // Mutations
  const updateMutation = useMutation({
    mutationFn: (body: {
      enabled: boolean;
      title?: string;
      message?: string;
      durationMinutes?: number;
      contactInfo?: string;
    }) => api<MaintenanceStatus>('/system/maintenance/config', { method: 'POST', body }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
      qc.invalidateQueries({ queryKey: ['maintenance-status-badge'] });
      if (res.enabled) {
        toast.success(`Maintenance Mode Activated for ${res.durationMinutes} minutes!`, {
          description: 'Users, Admins, and Owners are now seeing the live countdown screen.',
        });
      } else {
        toast.success('Maintenance Mode Deactivated!', {
          description: 'All users have full access to the ERP again.',
        });
      }
      setShowConfirmModal(false);
    },
    onError: (err) => {
      toast.error(getErrorMessage(err) || 'Failed to update maintenance settings');
    },
  });

  const extendMutation = useMutation({
    mutationFn: (minutes: number) =>
      api<MaintenanceStatus>('/system/maintenance/extend', {
        method: 'POST',
        body: { minutes },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
      qc.invalidateQueries({ queryKey: ['maintenance-status-badge'] });
      toast.success(`Extended Maintenance by +${res.durationMinutes}m!`, {
        description: 'User countdown clocks have been updated in real-time.',
      });
    },
    onError: (err) => {
      toast.error(getErrorMessage(err) || 'Failed to extend maintenance');
    },
  });

  const endMutation = useMutation({
    mutationFn: () => api<MaintenanceStatus>('/system/maintenance/end', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
      qc.invalidateQueries({ queryKey: ['maintenance-status-badge'] });
      toast.success('Maintenance Mode Stopped!', {
        description: 'The app is back online for all users.',
      });
    },
    onError: (err) => {
      toast.error(getErrorMessage(err) || 'Failed to end maintenance');
    },
  });

  const isUnderMaintenance = !!status?.isUnderMaintenance;

  const handlePresetClick = (mins: number) => {
    setDurationMinutes(mins);
    setCustomMinutes('');
  };

  const handleTemplateClick = (tmpl: (typeof MESSAGE_TEMPLATES)[0]) => {
    setTitle(tmpl.title);
    setMessage(tmpl.message);
    toast.info(`Loaded template: "${tmpl.title}"`);
  };

  const handleStartMaintenance = () => {
    const finalDuration = customMinutes ? Math.max(1, parseInt(customMinutes, 10)) : durationMinutes;
    updateMutation.mutate({
      enabled: true,
      title,
      message,
      durationMinutes: finalDuration,
      contactInfo,
    });
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* ── Active Status Banner ── */}
      {isUnderMaintenance ? (
        <div className="rounded-2xl bg-amber-500/10 border border-amber-500/40 dark:border-amber-500/30 p-6 shadow-lg relative overflow-hidden">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
                </span>
                <span className="text-xs font-bold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                  MAINTENANCE MODE IS CURRENTLY ACTIVE
                </span>
              </div>
              <h2 className="text-2xl font-bold text-foreground tracking-tight">{status?.title}</h2>
              <p className="text-sm text-muted-foreground max-w-xl line-clamp-2">{status?.message}</p>
              <div className="flex items-center gap-4 text-xs text-amber-800 dark:text-amber-200/80 pt-1 font-medium">
                <span>Started: {status?.startedAt ? new Date(status.startedAt).toLocaleTimeString() : 'Recently'}</span>
                <span>•</span>
                <span>
                  Expected End: {status?.endsAt ? new Date(status.endsAt).toLocaleTimeString() : 'In a few minutes'}
                </span>
              </div>
            </div>

            {/* Countdown Box & Live Extension Controls */}
            <div className="flex flex-col items-center sm:items-end gap-3 bg-card border border-border rounded-2xl p-4 shrink-0 shadow-sm">
              <div className="text-center sm:text-right">
                <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  TIME LEFT FOR USERS
                </div>
                <DevLiveCountdown endsAt={status?.endsAt} isUnderMaintenance={isUnderMaintenance} />
              </div>

              {/* Quick Extend Buttons */}
              <div className="flex items-center gap-1.5 flex-wrap justify-center">
                <span className="text-[10px] text-muted-foreground mr-1 font-medium">Extend:</span>
                {[5, 10, 15, 30].map((mins) => (
                  <Button
                    key={mins}
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-xs bg-background hover:bg-amber-500/15 hover:text-amber-700 dark:hover:text-amber-300 border-border font-medium cursor-pointer"
                    disabled={extendMutation.isPending}
                    onClick={() => extendMutation.mutate(mins)}
                  >
                    +{mins}m
                  </Button>
                ))}
              </div>

              <div className="flex items-center gap-2 w-full pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowPreviewModal(true)}
                  className="flex-1 h-8 text-xs border-border text-foreground hover:bg-muted cursor-pointer"
                >
                  <Eye className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
                  Preview Screen
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={endMutation.isPending}
                  onClick={() => endMutation.mutate()}
                  className="flex-1 h-8 text-xs font-semibold cursor-pointer"
                >
                  <Square className="h-3.5 w-3.5 mr-1" />
                  Stop Now
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl bg-card border border-border p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm">
          <div className="flex items-center gap-3.5">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-foreground">System is Online</h3>
                <span className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full font-semibold">
                  Normal Operations
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                All Owners, Admins, and Users have full unrestricted access to the ERP.
              </p>
            </div>
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowPreviewModal(true)}
            className="text-xs border-border text-foreground hover:bg-muted shrink-0 cursor-pointer"
          >
            <Eye className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
            Preview User Screen
          </Button>
        </div>
      )}

      {/* ── Maintenance Configuration & Launcher ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Form controls (2 cols) */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border bg-card shadow-sm">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-600 dark:text-amber-400">
                  <Wrench className="h-4 w-4" />
                </div>
                <div>
                  <CardTitle className="text-base sm:text-lg">Maintenance Setup</CardTitle>
                  <CardDescription className="text-xs">
                    Configure timer and message broadcasted to all users, admins, and owners
                  </CardDescription>
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-5">
              {/* Duration Presets */}
              <div className="space-y-2.5">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  Select Maintenance Duration
                </Label>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {DURATION_PRESETS.map((p) => {
                    const isSelected = !customMinutes && durationMinutes === p.minutes;
                    return (
                      <button
                        key={p.minutes}
                        type="button"
                        onClick={() => handlePresetClick(p.minutes)}
                        className={`px-3 py-2.5 rounded-xl border text-xs font-semibold text-center transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-amber-500/15 border-amber-500 text-amber-800 dark:text-amber-300 shadow-sm font-bold'
                            : 'bg-muted/40 border-border text-foreground hover:bg-muted hover:border-border/80'
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>

                {/* Custom minutes input */}
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">Or custom duration:</span>
                  <div className="relative w-36">
                    <Input
                      type="number"
                      min="1"
                      max="1440"
                      placeholder="e.g. 25"
                      value={customMinutes}
                      onChange={(e) => {
                        setCustomMinutes(e.target.value);
                        if (e.target.value) setDurationMinutes(parseInt(e.target.value, 10) || 10);
                      }}
                      className="h-8 text-xs pr-10 bg-background border-input text-foreground"
                    />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                      mins
                    </span>
                  </div>
                </div>
              </div>

              {/* Title Input */}
              <div className="space-y-1.5">
                <Label htmlFor="maint-title" className="text-xs font-medium text-foreground">
                  Notice Title (Visible on User Lock Screen)
                </Label>
                <Input
                  id="maint-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. System Maintenance in Progress"
                  className="h-9 text-sm bg-background border-input text-foreground"
                />
              </div>

              {/* Message Textarea */}
              <div className="space-y-1.5">
                <Label htmlFor="maint-msg" className="text-xs font-medium text-foreground">
                  Message from Developer (Detailed explanation of updates)
                </Label>
                <textarea
                  id="maint-msg"
                  rows={4}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Explain to the users what is being upgraded..."
                  className="w-full rounded-xl bg-background border border-input p-3 text-xs sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              {/* Contact / Tech Support Info */}
              <div className="space-y-1.5">
                <Label htmlFor="maint-contact" className="text-xs font-medium text-foreground flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                  Support / Direct Line (Optional)
                </Label>
                <Input
                  id="maint-contact"
                  value={contactInfo}
                  onChange={(e) => setContactInfo(e.target.value)}
                  placeholder="e.g. Developer Contact / Tech Desk: +91 9440216173"
                  className="h-9 text-xs bg-background border-input text-foreground"
                />
              </div>

              {/* Action Buttons */}
              <div className="pt-3 border-t border-border flex items-center gap-3">
                <Button
                  size="lg"
                  className="flex-1 bg-amber-600 hover:bg-amber-700 text-white dark:bg-amber-500 dark:hover:bg-amber-600 dark:text-black font-bold shadow-md shadow-amber-500/10 cursor-pointer"
                  onClick={() => setShowConfirmModal(true)}
                  disabled={updateMutation.isPending}
                >
                  <Play className="h-4 w-4 mr-2 fill-current" />
                  {isUnderMaintenance ? 'Update Maintenance Settings' : 'Turn ON Maintenance Mode'}
                </Button>

                {isUnderMaintenance && (
                  <Button
                    size="lg"
                    variant="destructive"
                    onClick={() => endMutation.mutate()}
                    disabled={endMutation.isPending}
                    className="h-11 px-5 font-semibold cursor-pointer"
                  >
                    <Square className="h-4 w-4 mr-2" />
                    Turn OFF
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Message Templates & Info */}
        <div className="space-y-6">
          <Card className="border-border bg-card shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2 text-foreground">
                <MessageSquare className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                Quick Message Templates
              </CardTitle>
              <CardDescription className="text-xs">
                Click a template to auto-populate title and notice text
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {MESSAGE_TEMPLATES.map((tmpl, idx) => (
                <div
                  key={idx}
                  onClick={() => handleTemplateClick(tmpl)}
                  className="p-3 rounded-xl border border-border bg-muted/30 hover:bg-muted/70 hover:border-amber-500/40 transition-all cursor-pointer group"
                >
                  <div className="text-xs font-semibold text-foreground group-hover:text-amber-700 dark:group-hover:text-amber-400 flex items-center justify-between">
                    <span>{tmpl.title}</span>
                    <Zap className="h-3 w-3 opacity-0 group-hover:opacity-100 text-amber-600 dark:text-amber-400 transition-opacity" />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                    {tmpl.message}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-border bg-card shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2 text-foreground">
                <ShieldCheck className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                Developer Protection Guarantee
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-2.5">
              <p>
                • <strong className="text-foreground">Developer Bypass:</strong> You (Developer account) are never locked out and retain full access to test, verify, and run transactions.
              </p>
              <p>
                • <strong className="text-foreground">Auto-Recovery:</strong> When the countdown timer ends, the user client automatically detects server restoration and unlocks without refresh.
              </p>
              <p>
                • <strong className="text-foreground">Backend Enforcement:</strong> Non-developer API requests receive HTTP 503 Service Unavailable with the live timer status.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Confirmation Modal ── */}
      <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
        <DialogContent className="max-w-md bg-card border-border text-card-foreground">
          <DialogHeader>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <DialogTitle className="text-center text-lg font-bold text-foreground">
              {isUnderMaintenance ? 'Update Maintenance Mode?' : 'Activate Maintenance Mode?'}
            </DialogTitle>
            <DialogDescription className="text-center text-xs text-muted-foreground mt-1">
              All Owners, Admins, and standard Users will be locked out and shown the live countdown timer screen for{' '}
              <strong className="text-amber-700 dark:text-amber-300 font-bold">
                {customMinutes ? customMinutes : durationMinutes} minutes
              </strong>
              .
            </DialogDescription>
          </DialogHeader>

          <div className="my-3 rounded-xl bg-muted/50 border border-border p-3 text-xs space-y-1 text-foreground">
            <div>
              <span className="text-muted-foreground font-medium">Title:</span> {title}
            </div>
            <div className="line-clamp-2">
              <span className="text-muted-foreground font-medium">Message:</span> {message}
            </div>
          </div>

          <DialogFooter className="flex gap-2 sm:gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowConfirmModal(false)}
              className="flex-1 border-border text-foreground hover:bg-muted cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleStartMaintenance}
              disabled={updateMutation.isPending}
              className="flex-1 bg-amber-600 hover:bg-amber-700 text-white dark:bg-amber-500 dark:hover:bg-amber-600 dark:text-black font-bold cursor-pointer"
            >
              {updateMutation.isPending ? 'Activating…' : 'Confirm & Activate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Live Preview Modal ── */}
      <Dialog open={showPreviewModal} onOpenChange={setShowPreviewModal}>
        <DialogContent className="max-w-4xl p-0 overflow-hidden bg-background border-border text-foreground shadow-2xl max-h-[95vh]">
          <div className="relative">
            <button
              onClick={() => setShowPreviewModal(false)}
              className="absolute top-4 right-4 z-50 px-3 py-1.5 rounded-xl bg-card hover:bg-muted text-xs font-semibold text-foreground border border-border shadow-md cursor-pointer"
            >
              ✕ Close Preview
            </button>
            <div className="max-h-[85vh] overflow-y-auto rounded-3xl">
              <MaintenanceScreen
                initialStatus={{
                  enabled: true,
                  isUnderMaintenance: true,
                  title,
                  message,
                  startedAt: new Date().toISOString(),
                  endsAt: new Date(
                    Date.now() + (customMinutes ? parseInt(customMinutes, 10) : durationMinutes) * 60 * 1000
                  ).toISOString(),
                  secondsLeft: (customMinutes ? parseInt(customMinutes, 10) : durationMinutes) * 60,
                  durationMinutes: customMinutes ? parseInt(customMinutes, 10) : durationMinutes,
                  contactInfo,
                  updatedAt: new Date().toISOString(),
                }}
                onResolved={() => setShowPreviewModal(false)}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
