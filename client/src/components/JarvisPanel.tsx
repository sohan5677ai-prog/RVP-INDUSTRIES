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
} from 'lucide-react';
import { api } from '@/lib/api';
import './JarvisPanel.css';

// ── Types ─────────────────────────────────────────────────
interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  content: string;
  navigationIntents?: { route: string; pageLabel: string }[];
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
export default function JarvisPanel({ open, onClose }: JarvisPanelProps) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(() => {
    return localStorage.getItem('jarvis-voice-reply') !== 'false';
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);

  // Toggle voice replies
  const toggleVoiceReply = useCallback(() => {
    setVoiceReplyEnabled(prev => {
      const next = !prev;
      localStorage.setItem('jarvis-voice-reply', String(next));
      if (!next && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      return next;
    });
  }, []);

  // Text to Speech (TTS) for JARVIS voice replies
  const speak = useCallback((text: string) => {
    if (!('speechSynthesis' in window) || !voiceReplyEnabled) return;
    window.speechSynthesis.cancel();

    // Clean text: strip table rows, markdown formatting, HTML, and URLs for smooth speech
    let clean = text
      .replace(/\|[^\n]+\|/g, '') // strip table rows
      .replace(/[*#`_~>]/g, '')   // strip markdown formatting
      .replace(/<[^>]*>/g, '')    // strip HTML tags
      .replace(/https?:\/\/\S+/g, '') // strip URLs
      .replace(/\s+/g, ' ')
      .trim();

    if (!clean) return;

    // Keep voice summary crisp so it doesn't drone on
    if (clean.length > 280) {
      const sentenceEnd = clean.indexOf('.', 180);
      if (sentenceEnd > 0 && sentenceEnd < 320) {
        clean = clean.slice(0, sentenceEnd + 1) + ' I have displayed the complete breakdown on your screen.';
      } else {
        clean = clean.slice(0, 240) + '... Full details are displayed on your screen.';
      }
    }

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1.02;
    utterance.pitch = 0.95;

    // Pick best voice: Indian English or UK/US English
    const voices = window.speechSynthesis.getVoices();
    const voice =
      voices.find(v => v.lang === 'en-IN') ||
      voices.find(v => v.lang.startsWith('en-GB')) ||
      voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google'))) ||
      voices.find(v => v.lang.startsWith('en'));

    if (voice) utterance.voice = voice;

    window.speechSynthesis.speak(utterance);
  }, [voiceReplyEnabled]);

  // Cancel speech on close or unmount
  useEffect(() => {
    if (!open && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Fetch proactive insights
  const { data: insightsData } = useQuery({
    queryKey: ['jarvis-insights'],
    queryFn: () => api<{ insights: InsightCard[] }>('/chat/insights'),
    enabled: open,
    staleTime: 60_000, // refresh every minute when panel is open
    refetchInterval: open ? 120_000 : false,
  });

  const insights = insightsData?.insights ?? [];

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Keyboard shortcut to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Send message
  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      // Build history for context
      const history = [...messages, userMsg].map(m => ({
        role: m.role,
        content: m.content,
      }));

      const res = await api<{ text: string; navigationIntents?: { route: string; pageLabel: string }[] }>(
        '/chat',
        { method: 'POST', body: { messages: history } }
      );

      const assistantMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'model',
        content: res.text || 'I couldn\'t process that. Please try again.',
        navigationIntents: res.navigationIntents,
      };

      setMessages(prev => [...prev, assistantMsg]);
      speak(assistantMsg.content);
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: `e-${Date.now()}`,
        role: 'model',
        content: `⚠️ ${err.message || 'Something went wrong. Please try again.'}`,
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  }, [messages, loading, speak]);

  // Voice input using Web Speech API
  const toggleVoice = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Voice input is not supported in this browser. Please use Chrome or Edge.');
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-IN';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setVoiceTranscript(transcript);
      if (event.results[0]?.isFinal) {
        setInput(transcript);
        setVoiceTranscript('');
        setIsListening(false);
        // Auto-send after short delay
        setTimeout(() => sendMessage(transcript), 300);
      }
    };

    recognition.onerror = () => {
      setIsListening(false);
      setVoiceTranscript('');
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setVoiceTranscript('Listening...');
  }, [isListening, sendMessage]);

  // Handle navigation
  const handleNavigate = (route: string) => {
    onClose();
    navigate(route);
  };

  if (!open) return null;

  const hasMessages = messages.length > 0;

  return (
    <>
      {/* Backdrop */}
      <div className="jarvis-backdrop" onClick={onClose} />

      {/* Panel */}
      <div className="jarvis-panel">
        {/* Header */}
        <div className="jarvis-header">
          <div className="jarvis-avatar">
            <Bot />
          </div>
          <div className="jarvis-title">
            <h3>JARVIS</h3>
            <p>RVP Industries AI Assistant</p>
          </div>
          <button
            className={`jarvis-icon-btn ${voiceReplyEnabled ? 'active' : ''}`}
            onClick={toggleVoiceReply}
            title={voiceReplyEnabled ? 'Voice reply enabled (click to mute)' : 'Voice reply muted (click to enable)'}
          >
            {voiceReplyEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
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
            <h4>Hello, I'm JARVIS</h4>
            <p>
              Your AI assistant for RVP Industries ERP. Ask me about stock, sales, dues, parties, or say
              "take me to purchase orders" to navigate.
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
              <kbd>Ctrl</kbd>+<kbd>J</kbd> to toggle
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

            {/* Quick suggestions below chat when there are few messages */}
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

        {/* Voice transcript preview */}
        {voiceTranscript && (
          <div className="jarvis-voice-preview">
            🎤 {voiceTranscript}
          </div>
        )}

        {/* Input area */}
        <div className="jarvis-input-area">
          <button
            className={`jarvis-btn ${isListening ? 'mic-active' : ''}`}
            onClick={toggleVoice}
            title={isListening ? 'Stop listening' : 'Voice input'}
          >
            {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
          <input
            ref={inputRef}
            type="text"
            className="jarvis-input"
            placeholder="Ask JARVIS anything..."
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
