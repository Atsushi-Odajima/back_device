// S00 ログイン。Stage A では架空担当者を選ぶ入口。公開登録はない。
import { useState } from 'react';
import { useApp, useQuery } from '../app/AppContext';
import { useRouter } from '../app/router';
import { LoadGate, Notice } from '../components/ui';
import { ROLE_LABEL } from '../components/labels';
import { MarkIcon } from '../components/Icons';
import { isRepoError } from '../domain/errors';

export function LoginScreen({ reauth = false, onDone }: { reauth?: boolean; onDone?: () => void }) {
  const { repo, refreshSession, session } = useApp();
  const { navigate } = useRouter();
  const q = useQuery(() => repo.listLoginCandidates(), []);
  const [persist, setPersist] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const login = async (userId: string) => {
    setBusy(userId);
    setError(null);
    try {
      await repo.login(userId, persist);
      refreshSession();
      if (onDone) onDone();
      else navigate('/', { force: true });
    } catch (e) {
      setError(isRepoError(e) ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="form-width stack" style={{ margin: '0 auto' }}>
      {!reauth && (
        <div className="stack-sm">
          <div className="row" style={{ gap: 12 }}>
            <MarkIcon width={40} height={40} />
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.3 }}>返却デスク<small className="muted" style={{ fontSize: 14 }}>（仮称）</small></div>
              <div className="latin muted small">Return Desk — validation demo</div>
            </div>
          </div>
        </div>
      )}
      <Notice tone="info" title={reauth ? '再ログインしてください' : 'ログイン（検証用デモ）'}>
        <p className="small">
          本番は招待制のメール＋パスワード（パスワード再設定あり）です。自分で組織を作る公開登録はありません。
          このデモでは架空の担当者を選びます。
        </p>
      </Notice>
      <LoadGate q={q} label="担当者一覧の読み込み">
        {(members) => (
          <ul className="list" aria-label="架空の担当者">
            {members
              .filter((m) => !reauth || m.userId === session?.userId)
              .map((m) => (
                <li key={m.userId}>
                  <button type="button" className="list-row" onClick={() => login(m.userId)} disabled={!!busy || !m.active}>
                    <span className="grow">
                      <strong>{m.displayName}</strong>
                      <span className="small muted" style={{ display: 'block' }}>
                        {ROLE_LABEL[m.role]}
                        {m.orgId.startsWith('0b') && '・別テスト組織（越境確認用）'}
                        {!m.active && '・停止中（ログイン不可）'}
                      </span>
                    </span>
                    <span className="small">{busy === m.userId ? 'ログイン中…' : '選ぶ'}</span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </LoadGate>
      <label className="check">
        <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
        <span>
          個人端末でログインを維持する
          <span className="small muted" style={{ display: 'block' }}>
            既定は共有端末向け（画面を閉じるとログアウト）。選んだ場合もタブを閉じるまで。ブラウザの端末を完全に消去できるとは保証しません。
          </span>
        </span>
      </label>
      {error && <Notice tone="error" title="ログインできません">{error}</Notice>}
    </div>
  );
}
