// 依存を増やさない最小のルーター。未保存入力がある時は遷移前に確認する。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

function subscribe(cb: () => void) {
  window.addEventListener('popstate', cb);
  window.addEventListener('rd:navigate', cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener('rd:navigate', cb);
  };
}
const getHref = () => window.location.pathname + window.location.search;

interface RouterValue {
  path: string;
  query: URLSearchParams;
  navigate: (to: string, opts?: { replace?: boolean; force?: boolean }) => void;
  setDirty: (key: string, dirty: boolean) => void;
  pendingNav: string | null;
  confirmLeave: () => void;
  cancelLeave: () => void;
}

const RouterCtx = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const href = useSyncExternalStore(subscribe, getHref, () => '/');
  const dirty = useRef(new Set<string>());
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const lastHref = useRef(href);

  const go = useCallback((to: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    window.dispatchEvent(new Event('rd:navigate'));
    window.scrollTo(0, 0);
  }, []);

  const navigate = useCallback<RouterValue['navigate']>(
    (to, opts = {}) => {
      if (to === getHref()) return;
      if (!opts.force && dirty.current.size > 0) {
        setPendingNav(to);
        return;
      }
      go(to, opts.replace);
    },
    [go],
  );

  // ブラウザの戻る：未保存があれば元の画面に戻して確認する
  useEffect(() => {
    const onPop = () => {
      const now = getHref();
      if (dirty.current.size > 0 && now !== lastHref.current) {
        window.history.pushState(null, '', lastHref.current);
        window.dispatchEvent(new Event('rd:navigate'));
        setPendingNav(now);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    lastHref.current = href;
  }, [href]);

  // 画面を閉じる・再読込：未保存があればブラウザ標準の確認を出す
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current.size > 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const value = useMemo<RouterValue>(() => {
    const u = new URL(href, 'http://x');
    return {
      path: u.pathname,
      query: u.searchParams,
      navigate,
      setDirty: (key, d) => {
        if (d) dirty.current.add(key);
        else dirty.current.delete(key);
      },
      pendingNav,
      confirmLeave: () => {
        const to = pendingNav;
        dirty.current.clear();
        setPendingNav(null);
        if (to) go(to);
      },
      cancelLeave: () => setPendingNav(null),
    };
  }, [href, navigate, pendingNav, go]);

  return <RouterCtx.Provider value={value}>{children}</RouterCtx.Provider>;
}

export function useRouter(): RouterValue {
  const v = useContext(RouterCtx);
  if (!v) throw new Error('RouterProvider がありません');
  return v;
}

/** 未保存入力を登録する。保存済み・破棄時は false に戻す。 */
export function useDirty(key: string, dirty: boolean) {
  const { setDirty } = useRouter();
  useEffect(() => {
    setDirty(key, dirty);
    return () => setDirty(key, false);
  }, [key, dirty, setDirty]);
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = s[i]!;
    if (a.startsWith(':')) out[a.slice(1)] = decodeURIComponent(b);
    else if (a !== b) return null;
  }
  return out;
}
