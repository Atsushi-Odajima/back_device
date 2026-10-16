import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { RepoError } from '../domain/errors';
import { tokyoDateTime } from '../domain/time';
import { shortId } from '../domain/ids';
import type { SaveState } from '../app/useSave';
import type { QueryState } from '../app/AppContext';
import { useRouter } from '../app/router';
import { AlertIcon, BackIcon, CheckIcon, ClockIcon, ErrorIcon } from './Icons';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'accent' | 'secondary' | 'quiet';
  main?: boolean;
  block?: boolean;
  /** 押せない理由。指定時は無効化して隣に表示する（opacity だけで処理しない）。 */
  disabledReason?: string | null;
};

export function Button({ variant = 'secondary', main, block, disabledReason, className, children, ...rest }: BtnProps) {
  const disabled = rest.disabled || !!disabledReason;
  const cls = ['btn', variant !== 'secondary' && `btn-${variant}`, main && 'btn-main', block && 'btn-block', className]
    .filter(Boolean)
    .join(' ');
  const btn = (
    <button type="button" {...rest} className={cls} disabled={disabled}>
      {children}
    </button>
  );
  if (!disabledReason) return btn;
  return (
    <div className="stack-sm">
      {btn}
      <span className="disabled-reason">押せない理由：{disabledReason}</span>
    </div>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

const TONE_ICON: Record<Tone, ReactNode> = {
  neutral: <ClockIcon />,
  info: <ClockIcon />,
  success: <CheckIcon />,
  warning: <AlertIcon />,
  error: <ErrorIcon />,
};

/** 状態ラベル：色・アイコン・文言の３つで伝える。 */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status status-${tone}`}>
      {TONE_ICON[tone]}
      <span>{children}</span>
    </span>
  );
}

export function Notice({ tone, title, children, role }: { tone: 'success' | 'warning' | 'error' | 'info'; title?: ReactNode; children?: ReactNode; role?: 'alert' | 'status' }) {
  return (
    <div className={`notice notice-${tone}`} role={role ?? (tone === 'error' ? 'alert' : 'status')}>
      {TONE_ICON[tone]}
      <div>
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function PageHead({ title, back, backLabel = '戻る', children }: { title: ReactNode; back?: string; backLabel?: string; children?: ReactNode }) {
  const { navigate } = useRouter();
  return (
    <div className="page-head">
      {back && (
        <button type="button" className="btn btn-quiet" onClick={() => navigate(back)} aria-label={backLabel}>
          <BackIcon />
          <span className="small">{backLabel}</span>
        </button>
      )}
      <h1>{title}</h1>
      {children}
    </div>
  );
}

/** 読み込み中・失敗の表示。失敗を空一覧と誤表示しない。 */
export function LoadGate<T>({ q, children, label = '読み込み' }: { q: QueryState<T>; children: (data: T) => ReactNode; label?: string }) {
  if (q.error && q.data === undefined) {
    return (
      <Notice tone="error" title={`${label}に失敗しました`}>
        <p>{q.error.message}</p>
        {q.fetchedAt && <p className="small">最後に取得：{tokyoDateTime(q.fetchedAt)}</p>}
        <div className="row">
          <Button onClick={q.reload}>再読み込み</Button>
        </div>
      </Notice>
    );
  }
  if (q.data === undefined) return <p className="muted" role="status">読み込み中…</p>;
  return (
    <>
      {q.error && (
        <Notice tone="warning" title="最新の情報を取得できませんでした">
          <p>表示は {q.fetchedAt ? tokyoDateTime(q.fetchedAt) : '前回'} 時点の内容です。{q.error.message}</p>
          <div className="row">
            <Button onClick={q.reload}>再読み込み</Button>
          </div>
        </Notice>
      )}
      {children(q.data)}
    </>
  );
}

/** 保存操作の結果表示。成功はサーバー確定後だけ。 */
export function SaveFeedback({
  state,
  onRetry,
  onCheck,
  successText = '保存しました',
  listPath = '/',
}: {
  state: SaveState;
  onRetry?: () => void;
  onCheck?: () => void;
  successText?: string;
  listPath?: string;
}) {
  const { navigate } = useRouter();
  switch (state.kind) {
    case 'idle':
      return null;
    case 'saving':
      return (
        <p role="status" className="muted">
          保存中…{state.slow && <strong>　画面を閉じずにお待ちください</strong>}
        </p>
      );
    case 'checking':
      return (
        <p role="status" className="muted">
          応答がないため、保存できたかをサーバーに確認しています…
        </p>
      );
    case 'done':
      return (
        <Notice tone="success" title={successText}>
          <p className="small">
            確定時刻 {tokyoDateTime(state.at)}　受付番号 <span className="num">{shortId(state.opId)}</span>
          </p>
        </Notice>
      );
    case 'unknown':
      return (
        <Notice tone="warning" title="保存できたか確認できません">
          <p>{state.error.message}</p>
          <p className="small">通信が戻ったら「保存結果を確認」を押してください。二重に保存されることはありません。</p>
          {onCheck && (
            <div className="row">
              <Button onClick={onCheck}>保存結果を確認</Button>
            </div>
          )}
        </Notice>
      );
    case 'not_saved':
      return <ErrorFeedback error={state.error} onRetry={onRetry} listPath={listPath} navigate={navigate} />;
  }
}

function ErrorFeedback({ error, onRetry, listPath, navigate }: { error: RepoError; onRetry?: () => void; listPath: string; navigate: (p: string, o?: { force?: boolean }) => void }) {
  if (error.code === 'forbidden') {
    return (
      <Notice tone="error" title="権限が変更されました（403）">
        <p>{error.message}</p>
        <div className="row">
          <Button onClick={() => navigate(listPath, { force: true })}>一覧へ戻る</Button>
        </div>
      </Notice>
    );
  }
  if (error.code === 'session_expired') {
    return (
      <Notice tone="warning" title="ログインの有効期限が切れました">
        <p>再ログイン後、入力内容を確認して再提出してください。入力は残っています。</p>
      </Notice>
    );
  }
  if (error.code === 'conflict') {
    return (
      <Notice tone="warning" title="他の担当者が先に更新しました（409）">
        <p>あなたの入力は残しています。最新の値と比べて確認してください。</p>
      </Notice>
    );
  }
  return (
    <Notice tone="error" title={error.code === 'network' ? '保存されていません' : '保存できませんでした'}>
      <p>{error.message}</p>
      {onRetry && (error.code === 'network' || error.code === 'timeout') && (
        <div className="row">
          <Button onClick={onRetry}>同じ内容でもう一度保存</Button>
        </div>
      )}
    </Notice>
  );
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="field-error" id={id}>
      <ErrorIcon width={16} height={16} />
      <span>{children}</span>
    </p>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) onClose();
      if (e.key === 'Tab' && ref.current) {
        const els = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, a[href]')];
        if (els.length === 0) return;
        const f = els[0]!;
        const l = els[els.length - 1]!;
        if (e.shiftKey && document.activeElement === f) {
          l.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === l) {
          f.focus();
          e.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <h2 id="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function QtyGrid({ cells }: { cells: { label: string; value: number | string; attention?: boolean }[] }) {
  return (
    <div className="qty-grid" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}>
      {cells.map((c) => (
        <div key={c.label} className={`qty-cell${c.attention ? ' attention' : ''}`}>
          <div className="label">{c.label}</div>
          <div className="value">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

export function yen(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `${n.toLocaleString('ja-JP')}円`;
}

export function download(file: { fileName: string; mime: string; data: Uint8Array | string }) {
  const blob = new Blob([typeof file.data === 'string' ? file.data : new Uint8Array(file.data)], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
