import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/lib/auth';
import App from './App';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/geist-mono';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Mutations invalidate the keys they touch, so served-from-cache data
      // stays fresh; this just stops every page revisit from re-fetching and
      // flashing a spinner. Revisits within the window render instantly.
      staleTime: 60_000,
      // A broken/missing endpoint shouldn't hang a page for ~7s of backoff.
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
        <AuthProvider>
          <App />
          <Toaster richColors />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
