import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wrench, Clock, Square, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { api, getErrorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { MaintenanceStatus } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export default function DeveloperMaintenanceBanner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isDeveloper = user?.role === 'DEVELOPER';

  const { data: status } = useQuery({
    queryKey: ['maintenance-status-badge'],
    queryFn: () => api<MaintenanceStatus>('/system/maintenance/status'),
    enabled: isDeveloper,
    refetchInterval: 5000,
  });

  const isUnderMaintenance = !!status?.isUnderMaintenance;

  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (status?.endsAt && isUnderMaintenance) {
      const diff = Math.floor((new Date(status.endsAt).getTime() - Date.now()) / 1000);
      setSecondsLeft(Math.max(0, diff));
    } else {
      setSecondsLeft(0);
    }
  }, [status?.endsAt, isUnderMaintenance]);

  useEffect(() => {
    if (!isUnderMaintenance || secondsLeft <= 0) return;
    const interval = setInterval(() => {
      setSecondsLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [isUnderMaintenance, secondsLeft]);

  const extendMutation = useMutation({
    mutationFn: (minutes: number) =>
      api<MaintenanceStatus>('/system/maintenance/extend', {
        method: 'POST',
        body: { minutes },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-status-badge'] });
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
      toast.success('Extended Maintenance Duration!');
    },
    onError: (err) => {
      toast.error(getErrorMessage(err) || 'Failed to extend maintenance');
    },
  });

  const endMutation = useMutation({
    mutationFn: () => api<MaintenanceStatus>('/system/maintenance/end', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-status-badge'] });
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
      toast.success('Maintenance Mode Stopped. System restored!');
    },
    onError: (err) => {
      toast.error(getErrorMessage(err) || 'Failed to stop maintenance');
    },
  });

  if (!isDeveloper || !isUnderMaintenance) return null;

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const timerStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25 transition-all shadow-md shadow-amber-500/10 cursor-pointer animate-pulse"
          title="Maintenance Mode is Active - Click for quick controls"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
          </span>
          <span className="text-[11px] font-bold tracking-wider uppercase flex items-center gap-1.5 font-mono">
            <Wrench className="h-3 w-3" />
            MAINTENANCE: {timerStr}
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-4 bg-zinc-950 border-amber-500/30 text-zinc-100 shadow-2xl backdrop-blur-xl" align="end">
        <div className="space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Live Maintenance Gate
              </div>
              <p className="text-xs text-zinc-300 font-semibold mt-1 truncate max-w-[200px]">
                {status?.title}
              </p>
            </div>
            <div className="font-mono text-lg font-bold text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
              {timerStr}
            </div>
          </div>

          <p className="text-[11px] text-zinc-400 line-clamp-2">
            {status?.message}
          </p>

          <div className="space-y-1.5 pt-2 border-t border-white/10">
            <div className="text-[10px] uppercase font-semibold text-zinc-400">Quick Timer Extension:</div>
            <div className="grid grid-cols-3 gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs bg-zinc-900 border-white/10 hover:bg-amber-500/20 hover:text-amber-300"
                disabled={extendMutation.isPending}
                onClick={() => extendMutation.mutate(5)}
              >
                +5 Mins
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs bg-zinc-900 border-white/10 hover:bg-amber-500/20 hover:text-amber-300"
                disabled={extendMutation.isPending}
                onClick={() => extendMutation.mutate(10)}
              >
                +10 Mins
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs bg-zinc-900 border-white/10 hover:bg-amber-500/20 hover:text-amber-300"
                disabled={extendMutation.isPending}
                onClick={() => extendMutation.mutate(15)}
              >
                +15 Mins
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-white/10">
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate('/settings?tab=maintenance')}
              className="flex-1 h-8 text-xs border-white/10"
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              Full Controls
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={endMutation.isPending}
              onClick={() => endMutation.mutate()}
              className="flex-1 h-8 text-xs font-semibold bg-rose-600 hover:bg-rose-700"
            >
              <Square className="h-3 w-3 mr-1" />
              End Now
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
