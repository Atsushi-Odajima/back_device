import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Repository, Session } from '../data/repository';
import { isRepoError, type RepoError } from '../domain/errors';

interface AppValue {
  repo: Repository;
  session: Session | null;
  /** 更新が確定するたびに増える。参照フックの再取得に使う。 */
  dataVersion: number;
  bumpData: () => void;
  /** 401 を受けた時に再認証ダイアログを開く。 */
  reauthNeeded: boolean;
  requestReauth: () => void;
  completeReauth: () => void;
  refreshSession: () => void;
}

const Ctx = createContext<AppValue | null>(null);

export function AppProvider({ repo, children }: { repo: Repository; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(repo.currentSession());
  const [dataVersion, setDataVersion] = useState(0);
  const [reauthNeeded, setReauthNeeded] = useState(false);
  const bumpData = useCallback(() => setDataVersion((v) => v + 1), []);
  const refreshSession = useCallback(() => setSession(repo.currentSession()), [repo]);

  useEffect(() => {
    const r = repo as Repository & { subscribe?: (fn: () => void) => () => void };
    if (!r.subscribe) return;
    return r.subscribe(() => {
      setSession(repo.currentSession());
      setDataVersion((v) => v + 1);
    });
  }, [repo]);

  return (
    <Ctx.Provider
      value={{
        repo,
        session,
        dataVersion,
        bumpData,
        reauthNeeded,
        requestReauth: () => setReauthNeeded(true),
        completeReauth: () => {
          setReauthNeeded(false);
          refreshSession();
        },
        refreshSession,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider がありません');
  return v;
}

export interface QueryState<T> {
  data: T | undefined;
  error: RepoError | Error | null;
  loading: boolean;
  /** 最後に取得できた時刻（読み込み失敗時に表示） */
  fetchedAt: string | null;
  reload: () => void;
}

/** 参照用フック。エラーを空一覧として扱わない。 */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]): QueryState<T> {
  const { dataVersion, requestReauth } = useApp();
  const [state, setState] = useState<{ data: T | undefined; error: RepoError | Error | null; loading: boolean; fetchedAt: string | null }>({
    data: undefined,
    error: null,
    loading: true,
    fetchedAt: null,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false, fetchedAt: new Date().toISOString() }),
      (error: unknown) => {
        if (!alive) return;
        if (isRepoError(error) && error.code === 'session_expired') requestReauth();
        setState((s) => ({ ...s, error: error as Error, loading: false }));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, dataVersion, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}
