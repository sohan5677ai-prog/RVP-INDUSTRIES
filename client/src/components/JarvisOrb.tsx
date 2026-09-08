import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Mic } from 'lucide-react';
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
  const [startVoiceImmediately, setStartVoiceImmediately] = useState(false);

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
      setStartVoiceImmediately(false);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleOpenVoice = (e: React.MouseEvent) => {
    e.stopPropagation();
    setStartVoiceImmediately(true);
    setOpen(true);
  };

  const handleOpenNormal = () => {
    setStartVoiceImmediately(false);
    setOpen(true);
  };

  return (
    <>
      {/* Floating Orb Button */}
      {!open && (
        <div className="jarvis-orb-container">
          <button
            className="jarvis-orb"
            onClick={handleOpenNormal}
            title="Open JARVIS (Ctrl+J)"
            aria-label="Open JARVIS AI Assistant"
          >
            <Bot className="jarvis-orb-icon" />
            {insightCount > 0 && (
              <span className="jarvis-orb-badge">{insightCount}</span>
            )}
          </button>

          {/* Quick 1-tap Voice Orb Button */}
          <button
            className="jarvis-orb-mic"
            onClick={handleOpenVoice}
            title="Speak to JARVIS (Voice Command)"
            aria-label="Speak to JARVIS"
          >
            <Mic className="h-3.5 w-3.5 text-white" />
          </button>
        </div>
      )}

      {/* Panel */}
      <JarvisPanel
        open={open}
        onClose={() => {
          setOpen(false);
          setStartVoiceImmediately(false);
        }}
        startVoiceImmediately={startVoiceImmediately}
      />
    </>
  );
}
