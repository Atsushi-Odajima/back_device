import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { AppProvider } from './app/AppContext';
import { RouterProvider } from './app/router';
import { APP_MODE } from './components/photos';
import type { Repository } from './data/repository';

async function createRepository(): Promise<Repository> {
  if (APP_MODE === 'demo') {
    const { DemoRepository } = await import('./data/demo/demoRepository');
    return new DemoRepository();
  }
  const { createSupabaseRepository } = await import('./data/supabase/supabaseRepository');
  return createSupabaseRepository();
}

const root = createRoot(document.getElementById('root')!);
createRepository().then(
  (repo) =>
    root.render(
      <StrictMode>
        <RouterProvider>
          <AppProvider repo={repo}>
            <App />
          </AppProvider>
        </RouterProvider>
      </StrictMode>,
    ),
  (e: unknown) => {
    const p = document.createElement('p');
    p.style.padding = '16px';
    p.textContent = `起動できませんでした：${e instanceof Error ? e.message : String(e)}`;
    document.getElementById('root')!.replaceChildren(p);
  },
);

// Service Worker はアプリシェルだけをキャッシュする（業務データ・写真・CSVはキャッシュしない）。
if ('serviceWorker' in navigator && import.meta.env.PROD && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 登録できなくても通常のWebアプリとして動く */
    });
  });
}
