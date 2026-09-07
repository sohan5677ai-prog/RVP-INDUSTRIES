import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { api } from '@/lib/api';
import JarvisPanel from './JarvisPanel';
import './JarvisPanel.css';

interface InsightCard {
  id: string;
  type: string;
  icon: string;
  title: string;
  description: string;
}

export default function JarvisOrb() {
  const [open, setOpen] = useState(false);

  // Fetch insights for the badge count
  const { data: insightsData } = useQuery({
    queryKey: ['jarvis-insights'],
    queryFn: () => api<{ insights: InsightCard[] }>('/chat/insights'),
    staleTime: 120_000,
    refetchInterval: 300_000, // refresh every 5 min in background
  });

  const insightCount = insightsData?.insights?.length ?? 0;

  // Ctrl+J to toggle JARVIS
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
      e.preventDefault();
      setOpen(prev => !prev);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <>
      {/* Floating Orb Button */}
      {!open && (
        <button
          className="jarvis-orb"
          onClick={() => setOpen(true)}
          title="Open JARVIS (Ctrl+J)"
          aria-label="Open JARVIS AI Assistant"
        >
          <Bot className="jarvis-orb-icon" />
          {insightCount > 0 && (
            <span className="jarvis-orb-badge">{insightCount}</span>
          )}
        </button>
      )}

      {/* Panel */}
      <JarvisPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}
