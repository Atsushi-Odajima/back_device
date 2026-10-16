// 重要更新の送信手順（仕様８・10）。
// - 同じボタンの再送には同じ operation_id を使う（成功するまで変えない）。
// - タイムアウト時は operation_id の結果照会を先に行い、確定済みなら成功として扱う。
// - サーバー確定応答の後にだけ成功を表示する（楽観更新なし）。
import { useCallback, useRef, useState } from 'react';
import { RepoError, isRepoError } from '../domain/errors';
import { uuid } from '../domain/ids';
import { useApp } from './AppContext';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving'; slow: boolean }
  | { kind: 'checking' }
  | { kind: 'done'; at: string; opId: string }
  | { kind: 'not_saved'; error: RepoError } // サーバーに届いていない／拒否された。入力はそのまま
  | { kind: 'unknown'; error: RepoError }; // 成否不明（照会もできない）

export function useSave<I, R>(fn: (opId: string, input: I) => Promise<R>) {
  const { repo, bumpData, requestReauth } = useApp();
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const [result, setResult] = useState<R | null>(null);
  const opRef = useRef<string>(uuid());
  const lastInput = useRef<I | null>(null);
  const busy = useRef(false);

  const finish = useCallback(
    (r: R) => {
      const op = opRef.current;
      setResult(r);
      setState({ kind: 'done', at: new Date().toISOString(), opId: op });
      opRef.current = uuid(); // 次の操作は新しいID
      bumpData();
      return r;
    },
    [bumpData],
  );

  const check = useCallback(async (): Promise<R | null> => {
    setState({ kind: 'checking' });
    try {
      const look = await repo.lookupOperation(opRef.current);
      if (look.found) return finish(look.result as R);
      setState({
        kind: 'not_saved',
        error: new RepoError('network', '保存されていませんでした。入力はそのままです。内容を確認してもう一度保存してください。'),
      });
    } catch (e) {
      setState({
        kind: 'unknown',
        error: isRepoError(e) ? e : new RepoError('network', String(e)),
      });
    }
    return null;
  }, [repo, finish]);

  const run = useCallback(
    async (input: I): Promise<R | null> => {
      if (busy.current) return null; // 二重押下禁止
      busy.current = true;
      lastInput.current = input;
      setState({ kind: 'saving', slow: false });
      const slowTimer = setTimeout(() => setState((s) => (s.kind === 'saving' ? { kind: 'saving', slow: true } : s)), 2000);
      try {
        const r = await fn(opRef.current, input);
        return finish(r);
      } catch (e) {
        const err = isRepoError(e) ? e : new RepoError('network', e instanceof Error ? e.message : String(e));
        if (err.code === 'timeout') return await check();
        if (err.code === 'session_expired') requestReauth();
        if (err.code === 'conflict' || err.code === 'forbidden') bumpData();
        setState({ kind: 'not_saved', error: err });
        return null;
      } finally {
        clearTimeout(slowTimer);
        busy.current = false;
      }
    },
    [fn, finish, check, requestReauth, bumpData],
  );

  return {
    state,
    result,
    run,
    check,
    opId: opRef.current,
    reset: () => {
      setState({ kind: 'idle' });
      setResult(null);
    },
    saving: state.kind === 'saving' || state.kind === 'checking',
  };
}
