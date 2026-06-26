import { useState, useRef, useEffect } from 'react';
import { X, Send, Loader2, Bot } from 'lucide-react';
import { api, getErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

export function Chatbot() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const userMsg = input.trim();
    setInput('');
    const newMessages: ChatMessage[] = [...messages, { role: 'user', content: userMsg }];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const res = await api<{ text: string }>('/chat', {
        method: 'POST',
        body: { messages: newMessages },
      });
      setMessages((prev) => [...prev, { role: 'model', content: res.text }]);
    } catch (err) {
      const errMsg = getErrorMessage(err);
      setMessages((prev) => [...prev, { role: 'model', content: `Oops! Something went wrong: ${errMsg}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {/* Floating Button */}
      {!isOpen && (
        <Button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-2xl bg-gradient-to-r from-violet-600 to-indigo-600 hover:scale-110 active:scale-95 transition-all duration-300 z-50 flex items-center justify-center border-2 border-violet-400/30 group"
          size="icon"
        >
          <Bot className="h-6 w-6 text-white group-hover:rotate-12 transition-transform duration-300" />
          <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500"></span>
          </span>
        </Button>
      )}

      {/* Chat Window */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 w-80 sm:w-96 h-[500px] max-h-[80vh] bg-background border rounded-xl shadow-2xl flex flex-col z-50 overflow-hidden animate-in slide-in-from-bottom-5">
          {/* Header */}
          <div className="bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600 text-white p-4 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-2">
              <div className="relative">
                <Bot className="h-5 w-5 text-white animate-pulse" />
                <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-emerald-500 border border-white"></span>
              </div>
              <div className="text-left">
                <span className="font-bold text-sm tracking-wide block">RVP Brain 2.0</span>
                <span className="text-[10px] text-violet-200 block -mt-0.5 font-medium">Proactive Assistant Online</span>
              </div>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-white/20 hover:text-white text-white/80 rounded-full" onClick={() => setIsOpen(false)}>
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-muted/30" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground text-sm mt-4 space-y-4 px-2">
                <div className="relative inline-block mt-4">
                  <div className="absolute -inset-1 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 blur opacity-40 animate-pulse"></div>
                  <div className="relative bg-background border rounded-full p-4">
                    <Bot className="h-10 w-10 text-violet-600" />
                  </div>
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold text-foreground text-base">I'm boosted & ready! ⚡</h3>
                  <p className="text-xs">Ask me anything about stocks, sales, purchases, loans, or transactions.</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-left pt-2">
                  <button 
                    onClick={() => { setInput("Give me a stock summary"); }}
                    className="p-2 border rounded-lg bg-card hover:bg-accent text-card-foreground text-center font-medium transition-colors cursor-pointer"
                  >
                    📦 Stock Summary
                  </button>
                  <button 
                    onClick={() => { setInput("What are our recent sales?"); }}
                    className="p-2 border rounded-lg bg-card hover:bg-accent text-card-foreground text-center font-medium transition-colors cursor-pointer"
                  >
                    📊 Recent Sales
                  </button>
                  <button 
                    onClick={() => { setInput("Do we have outstanding loans?"); }}
                    className="p-2 border rounded-lg bg-card hover:bg-accent text-card-foreground text-center font-medium transition-colors cursor-pointer"
                  >
                    🏦 Bank Loans
                  </button>
                  <button 
                    onClick={() => { setInput("Give me a financial summary"); }}
                    className="p-2 border rounded-lg bg-card hover:bg-accent text-card-foreground text-center font-medium transition-colors cursor-pointer"
                  >
                    💰 Money & Flows
                  </button>
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={cn("flex", msg.role === 'user' ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[85%] rounded-lg p-3 text-sm whitespace-pre-wrap text-left shadow-sm", msg.role === 'user' ? "bg-violet-600 text-white" : "bg-muted border")}>
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg p-3 text-sm bg-muted border flex items-center gap-2 shadow-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-violet-600" /> <span className="text-muted-foreground">Thinking...</span>
                </div>
              </div>
            )}
          </div>

          {/* Input Area */}
          <div className="p-3 bg-background border-t">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="flex items-center gap-2"
            >
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask me anything..."
                className="flex-1 focus-visible:ring-violet-600"
              />
              <Button type="submit" size="icon" disabled={!input.trim() || isLoading} className="bg-violet-600 hover:bg-violet-700">
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
