import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  X,
  Send,
  Mic,
  MicOff,
  Bot,
  Zap,
  Volume2,
  VolumeX,
  ArrowRight,
  Minimize2,
  Maximize2,
  CheckCircle2,
  AlertTriangle,
  Radio,
} from 'lucide-react';
import { api } from '@/lib/api';
import './JarvisPanel.css';

// ── Types ─────────────────────────────────────────────────
export interface ActionCard {
  type: string;
  title: string;
  description: string;
  status: 'SUCCESS' | 'WARNING' | 'ERROR';
  data?: any;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  content: string;
  navigationIntents?: { route: string; pageLabel: string; autoExecute?: boolean }[];
  actions?: ActionCard[];
}

interface InsightCard {
  id: string;
  type: 'info' | 'warning' | 'alert' | 'success';
  icon: string;
  title: string;
  description: string;
  action?: { route: string; label: string };
}

interface JarvisPanelProps {
  open: boolean;
  onClose: () => void;
  startVoiceImmediately?: boolean;
}

// ── Quick suggestion chips ─────────────────────────────────
const SUGGESTIONS = [
  '📦 Stock summary',
  '💰 Today\'s summary',
  '⚠️ Overdue dues',
  '📊 P&L overview',
  '🚚 Recent dispatches',
  '🏦 Outstanding loans',
];

// Simple markdown-to-HTML (bold, italics, lists, tables, line breaks)
function renderMarkdown(text: string): string {
  let html = text
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Headers (## etc)
    .replace(/^### (.+)$/gm, '<strong style="font-size:13px">$1</strong>')
    .replace(/^## (.+)$/gm, '<strong style="font-size:14px">$1</strong>')
    // Unordered lists
    .replace(/^[•\-\*]\s+(.+)$/gm, '<li>$1</li>')
    // Line breaks
    .replace(/\n/g, '<br/>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*?<\/li><br\/>?)+)/g, (match) => {
    return '<ul>' + match.replace(/<br\/?>/g, '') + '</ul>';
  });

  // Simple table support: detect | delimited lines
  const lines = text.split('\n');
  let tableHtml = '';
  let inTable = false;
  const processedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      if (!inTable) {
        tableHtml = '<table>';
        inTable = true;
      }
      // Skip separator lines like |---|---|
      if (/^\|[\s\-:|]+\|$/.test(line)) continue;
      const cells = line.split('|').filter(c => c.trim() !== '');
      const tag = tableHtml === '<table>' ? 'th' : 'td';
      tableHtml += '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    } else {
      if (inTable) {
        tableHtml += '</table>';
        processedLines.push(tableHtml);
        tableHtml = '';
        inTable = false;
      }
      processedLines.push(line);
    }
  }
  if (inTable) {
    tableHtml += '</table>';
    processedLines.push(tableHtml);
  }

  if (processedLines.length > 0 && processedLines.some(l => l.includes('<table>'))) {
    html = processedLines.join('<br/>');
    html = html
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  return html;
}

// ── Component ──────────────────────────────────────────────
export default function JarvisPanel({ open, onClose, startVoiceImmediately }: JarvisPanelProps) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isDocked, setIsDocked] = useState(false);
  const [lastStatus, setLastStatus] = useState("Hello, I'm JARVIS");
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [handsFreeMode, setHandsFreeMode] = useState(() => {
    return localStorage.getItem('jarvis-hands-free') === 'true';
  });
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(() => {
    return localStorage.getItem('jarvis-voice-reply') !== 'false';
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<any>(null);

  // Toggle voice replies
  const toggleVoiceReply = useCallback(() => {
    setVoiceReplyEnabled(prev => {
      const next = !prev;
      localStorage.setItem('jarvis-voice-reply', String(next));
      if (!next && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        setIsSpeaking(false);
      }
      return next;
    });
  }, []);

  // Toggle hands-free continuous listening mode
  const toggleHandsFree = useCallback(() => {
    setHandsFreeMode(prev => {
      const next = !prev;
      localStorage.setItem('jarvis-hands-free', String(next));
      return next;
    });
  }, []);

  // Text to Speech (TTS) for JARVIS voice replies
  const speak = useCallback((text: string) => {
    if (!('speechSynthesis' in window) || !voiceReplyEnabled) return;
    window.speechSynthesis.cancel();

    // Clean text for speech
    let clean = text
      .replace(/\|[^\n]+\|/g, '') // strip tables
      .replace(/[*#`_~>]/g, '')   // strip markdown formatting
      .replace(/<[^>]*>/g, '')    // strip HTML tags
      .replace(/https?:\/\/\S+/g, '') // strip URLs
      .replace(/\s+/g, ' ')
      .trim();

    if (!clean) return;

    // Keep voice response concise
    if (clean.length > 250) {
      const sentenceEnd = clean.indexOf('.', 140);
      if (sentenceEnd > 0 && sentenceEnd < 280) {
        clean = clean.slice(0, sentenceEnd + 1);
      } else {
        clean = clean.slice(0, 200) + '... Full details are displayed on your screen.';
      }
    }

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.05;
    utterance.pitch = 0.96;

    // Best voice selection
    const voices = window.speechSynthesis.getVoices();
    const voice =
      voices.find(v => v.lang === 'en-IN') ||
      voices.find(v => v.lang.startsWith('en-GB')) ||
      voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google'))) ||
      voices.find(v => v.lang.startsWith('en'));

    if (voice) utterance.voice = voice;

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      setIsSpeaking(false);
      if (handsFreeMode && open) {
        setTimeout(() => startListening(), 400);
      }
    };
    utterance.onerror = () => setIsSpeaking(false);

    window.speechSynthesis.speak(utterance);
  }, [voiceReplyEnabled, handsFreeMode, open]);

  // Cancel speech on close or unmount
  useEffect(() => {
    if (!open && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        setIsListening(false);
      }
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  // Proactive insights
  const { data: insightsData } = useQuery({
    queryKey: ['jarvis-insights'],
    queryFn: () => api<{ insights: InsightCard[] }>('/chat/insights'),
    enabled: open && !isDocked,
    staleTime: 60_000,
    refetchInterval: open && !isDocked ? 120_000 : false,
  });

  const insights = insightsData?.insights ?? [];

  // Focus input when opened
  useEffect(() => {
    if (open && !isDocked) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, isDocked]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Keyboard shortcut to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isDocked) {
          setIsDocked(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, isDocked, onClose]);

  // Handle navigation
  const handleNavigate = useCallback((route: string) => {
    setIsDocked(true);
    navigate(route);
  }, [navigate]);

  // Send message
  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    // Interrupt any ongoing speech
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    setLastStatus(`Processing: "${trimmed}"`);

    try {
      const history = [...messages, userMsg].map(m => ({
        role: m.role,
        content: m.content,
      }));

      const res = await api<{
        text: string;
        navigationIntents?: { route: string; pageLabel: string; autoExecute?: boolean }[];
        actions?: ActionCard[];
      }>('/chat', { method: 'POST', body: { messages: history } });

      const assistantMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'model',
        content: res.text || 'I couldn\'t process that. Please try again.',
        navigationIntents: res.navigationIntents,
        actions: res.actions,
      };

      setMessages(prev => [...prev, assistantMsg]);
      setLastStatus(res.text || 'Action completed');

      // Check for auto-navigation command (e.g. "open party ledger of spectermum")
      const autoNav = res.navigationIntents?.find(n => n.autoExecute);
      if (autoNav) {
        navigate(autoNav.route);
        // Automatically dock into Floating Voice HUD so the user immediately sees the target page!
        setIsDocked(true);
      }

      speak(assistantMsg.content);
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: `e-${Date.now()}`,
        role: 'model',
        content: `⚠️ ${err.message || 'Something went wrong. Please try again.'}`,
      };
      setMessages(prev => [...prev, errorMsg]);
      setLastStatus('Encountered an error');
    } finally {
      setLoading(false);
    }
  }, [messages, loading, speak, navigate]);

  // Voice Recognition handler
  const startListening = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Voice recognition is not supported in this browser. Please use Chrome or Edge.');
      return;
    }

    // Cancel existing speech output when user starts speaking
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }

    try {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
      }

      const recognition = new SpeechRecognition();
      recognition.lang = 'en-IN';
      recognition.interimResults = true;
      recognition.continuous = true;

      recognition.onstart = () => {
        setIsListening(true);
        setVoiceTranscript('Listening...');
      };

      recognition.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        const currentText = finalTranscript || interimTranscript;
        setVoiceTranscript(currentText);

        // Reset silence timer
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

        if (finalTranscript.trim()) {
          // If a complete phrase is recognized, submit after brief pause
          silenceTimerRef.current = setTimeout(() => {
            const queryToSend = finalTranscript.trim();
            setVoiceTranscript('');
            setIsListening(false);
            try { recognition.stop(); } catch {}
            sendMessage(queryToSend);
          }, 600);
        } else if (interimTranscript.trim().length > 3) {
          // Debounce interim pause to auto-submit
          silenceTimerRef.current = setTimeout(() => {
            const queryToSend = interimTranscript.trim();
            setVoiceTranscript('');
            setIsListening(false);
            try { recognition.stop(); } catch {}
            sendMessage(queryToSend);
          }, 1200);
        }
      };

      recognition.onerror = (e: any) => {
        if (e.error !== 'no-speech') {
          setIsListening(false);
          setVoiceTranscript('');
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.error('Speech recognition error:', err);
      setIsListening(false);
    }
  }, [sendMessage]);

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
    }
    setIsListening(false);
    setVoiceTranscript('');
  }, []);

  const toggleVoice = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  // Trigger voice automatically if requested on open
  useEffect(() => {
    if (open && startVoiceImmediately && !isListening) {
      startListening();
    }
  }, [open, startVoiceImmediately]);

  if (!open) return null;

  const hasMessages = messages.length > 0;

  // ── Floating Docked Voice HUD ─────────────────────────────
  if (isDocked) {
    return (
      <div className="jarvis-voice-hud" role="dialog" aria-label="JARVIS Voice Assistant">
        <div
          className={`jarvis-hud-avatar ${isSpeaking ? 'speaking' : ''}`}
          onClick={() => setIsDocked(false)}
          title="Click to expand chat"
        >
          <Bot className="h-5 w-5 text-white" />
        </div>

        <div className="jarvis-hud-info">
          <div className="jarvis-hud-title">
            <span>JARVIS</span>
            {(isListening || isSpeaking) && (
              <div className="jarvis-waveform">
                <div className="jarvis-waveform-bar" />
                <div className="jarvis-waveform-bar" />
                <div className="jarvis-waveform-bar" />
                <div className="jarvis-waveform-bar" />
                <div className="jarvis-waveform-bar" />
              </div>
            )}
          </div>
          <div className="jarvis-hud-text" title={voiceTranscript || lastStatus}>
            {isListening
              ? (voiceTranscript || 'Listening to your command...')
              : isSpeaking
              ? 'Speaking...'
              : lastStatus}
          </div>
        </div>

        <div className="jarvis-hud-actions">
          <button
            className={`jarvis-hud-btn ${isListening ? 'active' : ''}`}
            onClick={toggleVoice}
            title={isListening ? 'Stop listening' : 'Start voice command'}
          >
            {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
          <button
            className="jarvis-hud-btn"
            onClick={() => setIsDocked(false)}
            title="Expand chat panel"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            className="jarvis-hud-btn"
            onClick={onClose}
            title="Close JARVIS"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  // ── Full Chat Panel ───────────────────────────────────────
  return (
    <>
      {/* Backdrop */}
      <div className="jarvis-backdrop" onClick={onClose} />

      {/* Panel */}
      <div className="jarvis-panel">
        {/* Header */}
        <div className="jarvis-header">
          <div className={`jarvis-avatar ${isSpeaking ? 'speaking' : ''}`}>
            <Bot />
          </div>
          <div className="jarvis-title">
            <div className="flex items-center gap-2">
              <h3>JARVIS</h3>
              {(isListening || isSpeaking) && (
                <div className="jarvis-waveform">
                  <div className="jarvis-waveform-bar" />
                  <div className="jarvis-waveform-bar" />
                  <div className="jarvis-waveform-bar" />
                  <div className="jarvis-waveform-bar" />
                  <div className="jarvis-waveform-bar" />
                </div>
              )}
            </div>
            <p>RVP Industries AI Voice Assistant</p>
          </div>

          <button
            className={`jarvis-icon-btn ${handsFreeMode ? 'active' : ''}`}
            onClick={toggleHandsFree}
            title={handsFreeMode ? 'Hands-Free continuous listening ON' : 'Hands-Free continuous listening OFF'}
          >
            <Radio className="h-4 w-4" />
          </button>

          <button
            className={`jarvis-icon-btn ${voiceReplyEnabled ? 'active' : ''}`}
            onClick={toggleVoiceReply}
            title={voiceReplyEnabled ? 'Voice reply enabled' : 'Voice reply muted'}
          >
            {voiceReplyEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </button>

          <button
            className="jarvis-icon-btn"
            onClick={() => setIsDocked(true)}
            title="Dock to Floating Voice HUD"
          >
            <Minimize2 className="h-4 w-4" />
          </button>

          <button className="jarvis-close" onClick={onClose} title="Close (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Insight Cards (horizontal scroll) */}
        {insights.length > 0 && (
          <div className="jarvis-insights">
            {insights.map(card => (
              <div
                key={card.id}
                className="jarvis-insight-card"
                data-type={card.type}
                onClick={() => card.action && handleNavigate(card.action.route)}
              >
                <div className="jarvis-insight-title">
                  <span>{card.icon}</span>
                  <span>{card.title}</span>
                </div>
                <div className="jarvis-insight-desc">{card.description}</div>
              </div>
            ))}
          </div>
        )}

        {/* Chat area */}
        {!hasMessages && !loading ? (
          <div className="jarvis-empty">
            <div className="jarvis-empty-icon">
              <Zap />
            </div>
            <h4>Voice-Ready JARVIS</h4>
            <p>
              Speak naturally: "Open party ledger of Spectrum", "Send E-invoice", or ask about stock and dues.
            </p>
            <div className="jarvis-suggestions">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  className="jarvis-suggestion"
                  onClick={() => sendMessage(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="jarvis-shortcut-hint">
              <kbd>Ctrl</kbd>+<kbd>J</kbd> to toggle • Click mic to talk
            </div>
          </div>
        ) : (
          <>
            <div className="jarvis-messages">
              {messages.map(msg => (
                <div
                  key={msg.id}
                  className={`jarvis-message ${msg.role === 'user' ? 'user' : 'assistant'}`}
                >
                  {msg.role === 'model' ? (
                    <div
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                    />
                  ) : (
                    msg.content
                  )}

                  {/* Navigation action buttons */}
                  {msg.navigationIntents?.map((nav, i) => (
                    <button
                      key={i}
                      className="jarvis-nav-btn"
                      onClick={() => handleNavigate(nav.route)}
                    >
                      <ArrowRight className="h-3 w-3" />
                      Go to {nav.pageLabel}
                    </button>
                  ))}

                  {/* Action Cards (e.g. E-Invoice or Party Ledger trigger) */}
                  {msg.actions?.map((act, i) => (
                    <div
                      key={i}
                      className="jarvis-action-card"
                      data-status={act.status}
                    >
                      <div className="jarvis-action-header">
                        <span className="jarvis-action-title">
                          {act.status === 'SUCCESS' ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                          ) : (
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                          )}
                          {act.title}
                        </span>
                        <span className="jarvis-action-badge">{act.status}</span>
                      </div>
                      <div className="jarvis-action-desc">{act.description}</div>
                      {act.data && (
                        <div className="jarvis-action-details">
                          {act.data.irn && (
                            <span className="jarvis-action-chip">
                              IRN: {act.data.irn.slice(0, 12)}...
                            </span>
                          )}
                          {act.data.invoiceNumber && (
                            <span className="jarvis-action-chip">
                              Inv #{act.data.invoiceNumber}
                            </span>
                          )}
                          {act.data.buyerName && (
                            <span className="jarvis-action-chip">
                              Party: {act.data.buyerName}
                            </span>
                          )}
                          {act.data.emailStatus && (
                            <span className="jarvis-action-chip">
                              Email: {act.data.emailStatus}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}

              {loading && (
                <div className="jarvis-thinking">
                  <div className="jarvis-thinking-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="jarvis-thinking-label">Thinking...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick suggestions below chat */}
            {messages.length < 3 && !loading && (
              <div className="jarvis-suggestions">
                {SUGGESTIONS.slice(0, 4).map(s => (
                  <button
                    key={s}
                    className="jarvis-suggestion"
                    onClick={() => sendMessage(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Live Voice Transcript Preview */}
        {(voiceTranscript || isListening) && (
          <div className="jarvis-voice-preview">
            <div className="jarvis-waveform">
              <div className="jarvis-waveform-bar" />
              <div className="jarvis-waveform-bar" />
              <div className="jarvis-waveform-bar" />
            </div>
            <span>{voiceTranscript || 'Listening...'}</span>
          </div>
        )}

        {/* Input area */}
        <div className="jarvis-input-area">
          <button
            className={`jarvis-btn ${isListening ? 'mic-active' : ''}`}
            onClick={toggleVoice}
            title={isListening ? 'Stop listening' : 'Talk to JARVIS'}
          >
            {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
          <input
            ref={inputRef}
            type="text"
            className="jarvis-input"
            placeholder={isListening ? 'Listening to your voice...' : 'Ask JARVIS anything...'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(input);
              }
            }}
            disabled={loading}
          />
          <button
            className="jarvis-btn send"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || loading}
            title="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );
}
