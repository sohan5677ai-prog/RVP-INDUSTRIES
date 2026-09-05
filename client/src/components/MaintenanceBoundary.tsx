import { useEffect, useState, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import type { MaintenanceStatus } from '@/lib/types';
import MaintenanceScreen from '@/pages/MaintenanceScreen';

export default function MaintenanceBoundary() {
  const { user } = useAuth();
  const isDeveloper = user?.role === 'DEVELOPER';

  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [checked, setChecked] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api<MaintenanceStatus>('/system/maintenance/status');
      setStatus(res);
      // Non-developer is locked if server says isUnderMaintenance is true
      if (!isDeveloper && res.isUnderMaintenance) {
        setIsLocked(true);
      } else {
        setIsLocked(false);
      }
    } catch {
      // Fail open on transient network errors
    } finally {
      setChecked(true);
    }
  }, [isDeveloper]);

  useEffect(() => {
    fetchStatus();

    // Listen to global 503 maintenance event dispatched by api.ts
    const onMaintenanceActive = (e: Event) => {
      const customEvent = e as CustomEvent<MaintenanceStatus>;
      if (customEvent.detail) {
        setStatus(customEvent.detail);
      }
      if (!isDeveloper) {
        setIsLocked(true);
      }
    };

    window.addEventListener('maintenance:active', onMaintenanceActive);

    // Re-check when window regains focus
    const onFocus = () => fetchStatus();
    window.addEventListener('focus', onFocus);

    // Periodic background polling: 5s if currently under maintenance, 20s if normal
    const pollInterval = setInterval(
      () => {
        fetchStatus();
      },
      isLocked ? 5000 : 20000
    );

    return () => {
      window.removeEventListener('maintenance:active', onMaintenanceActive);
      window.removeEventListener('focus', onFocus);
      clearInterval(pollInterval);
    };
  }, [isDeveloper, isLocked, fetchStatus]);

  // If initial check is still running, prevent flash
  if (!checked) return null;

  // Hard maintenance interceptor for non-developer roles
  if (!isDeveloper && isLocked) {
    return (
      <MaintenanceScreen
        initialStatus={status}
        onResolved={() => {
          setIsLocked(false);
          fetchStatus();
        }}
      />
    );
  }

  return <Outlet />;
}
