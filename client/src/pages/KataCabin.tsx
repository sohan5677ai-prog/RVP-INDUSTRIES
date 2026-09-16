import { useEffect, useState } from 'react';
import { LoaderCircle, MonitorCog, ShieldAlert } from 'lucide-react';
import { API_BASE, setToken } from '@/lib/api';
import WeighbridgeScreen from '@/pages/Reports/WeighbridgeScreen';

const CABIN_KEY_STORAGE = 'rvp_kata_cabin_installation_key';

/**
 * The permanent, no-login screen for the supervised weighbridge PC. A manager
 * activates a browser once with the private setup URL; future starts exchange
 * that local installation key for a narrowly-scoped API token automatically.
 */
export default function KataCabin() {
  const [state, setState] = useState<'starting' | 'ready' | 'not-activated' | 'error'>('starting');
  const [message, setMessage] = useState('Connecting the kata cabin…');

  useEffect(() => {
    const activate = async () => {
      const url = new URL(window.location.href);
      const setupKey = url.searchParams.get('activate');
      if (setupKey) {
        localStorage.setItem(CABIN_KEY_STORAGE, setupKey);
        url.searchParams.delete('activate');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      }

      const key = localStorage.getItem(CABIN_KEY_STORAGE);
      if (!key) {
        setState('not-activated');
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/auth/kiosk`, {
          method: 'POST',
          headers: { 'X-Kata-Cabin-Key': key },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.token) {
          setMessage(data.error || 'Unable to verify this cabin');
          setState('error');
          return;
        }
        setToken(data.token);
        setState('ready');
      } catch {
        setMessage('The ERP server is not reachable. Check the internet connection.');
        setState('error');
      }
    };
    activate();
  }, []);

  if (state === 'ready') return <WeighbridgeScreen cabinMode />;

  const notActivated = state === 'not-activated';
  return (
    <main className="min-h-screen bg-[#15130f] text-stone-100 grid place-items-center p-6">
      <section className="w-full max-w-md rounded-3xl border border-amber-500/20 bg-stone-900 p-8 text-center shadow-2xl shadow-black/40">
        <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/25">
          {notActivated ? <MonitorCog className="h-7 w-7" /> : state === 'error' ? <ShieldAlert className="h-7 w-7" /> : <LoaderCircle className="h-7 w-7 animate-spin" />}
        </div>
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-amber-400">RVP Industries</p>
        <h1 className="mt-2 font-display text-2xl font-semibold">Kata Cabin</h1>
        <p className="mt-3 text-sm leading-6 text-stone-400">
          {notActivated
            ? 'This browser has not been activated as the permanent weighbridge terminal.'
            : message}
        </p>
        {notActivated && <p className="mt-5 rounded-xl border border-stone-700 bg-stone-950/60 p-3 text-xs leading-5 text-stone-300">Open the private activation link supplied by the ERP administrator once. After that, this screen opens directly without a staff login.</p>}
      </section>
    </main>
  );
}
