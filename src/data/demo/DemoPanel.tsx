// デモ専用：役割切替・通信失敗スイッチ・競合の発生・初期化。pilot ビルドには含めない。
import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { match, useRouter } from '../../app/router';
import { ROLE_LABEL } from '../../components/labels';
import { Button } from '../../components/ui';
import type { DemoRepository, NetworkControls } from './demoRepository';

export function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      <span>検証用デモ・サンプルデータ</span>
      <span style={{ fontWeight: 400 }}>実顧客データを入力しないでください。再読込で初期状態に戻ります（実保存されません）。</span>
    </div>
  );
}

export function DemoPanel() {
  const { repo, session, refreshSession, bumpData } = useApp();
  const demo = repo as DemoRepository;
  const { path, navigate } = useRouter();
  const [c, setC] = useState<NetworkControls>(demo.controls);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => demo.subscribe(() => setC({ ...demo.controls })), [demo]);
  const set = (p: Partial<NetworkControls>) => demo.setControls(p);
  const returnRoute = match('/rentals/:id/return', path);
  const members = demo.server.db.members;

  return (
    <details className="demo-panel">
      <summary>
        デモ操作（役割切替・通信失敗）
        {(c.offline || c.slow || c.nextMutation !== 'none' || c.nextPhotoFail || c.sessionExpired) && <span>　※通信の模擬が有効</span>}
      </summary>
      <div className="demo-grid">
        <div className="field">
          <label htmlFor="demo-user">担当者を切り替える（役割）</label>
          <select
            id="demo-user"
            value={session?.userId ?? ''}
            onChange={async (e) => {
              await demo.login(e.target.value, false);
              refreshSession();
              navigate('/', { force: true });
            }}
          >
            {members.map((m) => (
              <option key={m.userId} value={m.userId} disabled={!m.active}>
                {m.displayName}／{ROLE_LABEL[m.role]}
                {!m.active ? '（停止中）' : ''}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600 }}>次の保存1回</legend>
          {(
            [
              ['none', '正常'],
              ['network', '通信失敗（サーバー未到達）'],
              ['timeout', 'タイムアウト（サーバーは確定・応答なし）'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="check">
              <input type="radio" name="demo-next" checked={c.nextMutation === k} onChange={() => set({ nextMutation: k })} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <div className="stack-sm">
          <label className="check">
            <input type="checkbox" checked={c.offline} onChange={(e) => set({ offline: e.target.checked })} />
            <span>オフライン（全通信失敗）</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={c.slow} onChange={(e) => set({ slow: e.target.checked })} />
            <span>応答を3秒遅らせる</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={c.nextPhotoFail} onChange={(e) => set({ nextPhotoFail: e.target.checked })} />
            <span>次の写真送信1回を失敗させる</span>
          </label>
        </div>
        <div className="stack-sm">
          <Button onClick={() => set({ sessionExpired: true })} disabled={c.sessionExpired}>
            セッション切れにする
          </Button>
          {returnRoute && (
            <Button
              onClick={() => {
                try {
                  const item = demo.simulateOtherDeviceReceipt(returnRoute.id!);
                  setMsg(`別端末の担当者が「${item}」を1つ返却しました（あなたの画面は自動で上書きされません）`);
                } catch (e) {
                  setMsg(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              別端末から先に1つ返却する（409を発生）
            </Button>
          )}
          <Button
            onClick={() => {
              demo.reset();
              bumpData();
              setMsg('初期データに戻しました');
              navigate('/', { force: true });
            }}
          >
            初期データに戻す
          </Button>
          {msg && (
            <p className="small" role="status">
              {msg}
            </p>
          )}
        </div>
      </div>
    </details>
  );
}
