// S11 設定：拠点、役割、チェック項目、データ返却、メンバー停止。変更は admin のみ。
import { useState } from 'react';
import { useApp, useQuery } from '../app/AppContext';
import { useDirty } from '../app/router';
import { useSave } from '../app/useSave';
import { Button, LoadGate, Modal, Notice, PageHead, SaveFeedback, Status, download } from '../components/ui';
import { ROLE_LABEL } from '../components/labels';
import { isRepoError } from '../domain/errors';
import { tokyoDateTime } from '../domain/time';
import type { ChecklistItem, Member, Role } from '../domain/types';
import type { OrgOverview } from '../data/repository';

export function SettingsScreen() {
  const { repo, session } = useApp();
  const q = useQuery(() => repo.getOverview(), []);
  const admin = session?.role === 'admin';
  return (
    <div className="stack form-width">
      <PageHead title="設定" back="/" backLabel="今日の返却" />
      {!admin && (
        <Notice tone="info" title="閲覧のみ">
          <p className="small">設定の変更・データ返却は組織管理者だけが行えます。</p>
        </Notice>
      )}
      <LoadGate q={q} label="設定の読み込み">
        {(ov) => (
          <>
            <section className="card stack-sm">
              <h2>組織・拠点</h2>
              <dl className="kv">
                <dt>組織</dt>
                <dd>{ov.org.nameOriginal}</dd>
                <dt>時刻</dt>
                <dd>Asia/Tokyo（固定）</dd>
                {ov.sites.map((s) => (
                  <div key={s.id} style={{ display: 'contents' }}>
                    <dt>拠点</dt>
                    <dd>
                      {s.nameOriginal}（コード <span className="num">{s.code}</span>）{!s.active && '・停止中'}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
            <Members ov={ov} admin={admin} />
            <Checklist key={ov.settings.version} ov={ov} admin={admin} />
            <DataReturn admin={admin} />
          </>
        )}
      </LoadGate>
    </div>
  );
}

function Members({ ov, admin }: { ov: OrgOverview; admin: boolean }) {
  const { repo, session } = useApp();
  const issues = useQuery(() => repo.listIssues(), []);
  const [stopping, setStopping] = useState<Member | null>(null);
  const [to, setTo] = useState('');
  const role = useSave<{ userId: string; role: Role }, { ok: true }>((op, x) => repo.setMemberRole(op, x));
  const stop = useSave<{ userId: string; reassignTo: string | null }, { reassigned: number }>((op, x) => repo.stopMember(op, x));
  const owned = stopping ? (issues.data ?? []).filter((r) => r.issue.ownerUserId === stopping.userId && r.issue.status !== 'closed') : [];
  const activeAdmins = ov.members.filter((m) => m.active && m.role === 'admin').length;

  return (
    <section className="card stack-sm">
      <h2>メンバーと役割</h2>
      <Button disabledReason="招待はサーバー経由のメール送信が必要です。Authのメール配送を設定するまで（Stage B）実招待はできません">メンバーを招待</Button>
      <ul className="list">
        {ov.members.map((m) => {
          const lastAdmin = m.role === 'admin' && m.active && activeAdmins <= 1;
          return (
            <li key={m.userId} className="stack-sm" style={{ padding: '12px 0' }}>
              <div className="row">
                <strong style={{ flex: 1 }}>
                  {m.displayName}
                  {m.userId === session?.userId && '（あなた）'}
                </strong>
                {m.active ? <Status tone="success">有効</Status> : <Status tone="neutral">停止</Status>}
              </div>
              {admin && m.active ? (
                <div className="row">
                  <label className="visually-hidden" htmlFor={`role-${m.userId}`}>
                    {m.displayName}の役割
                  </label>
                  <select
                    id={`role-${m.userId}`}
                    value={m.role}
                    style={{ width: 'auto' }}
                    disabled={lastAdmin || role.saving}
                    onChange={(e) => void role.run({ userId: m.userId, role: e.target.value as Role })}
                  >
                    {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <Button disabledReason={lastAdmin ? '最後の有効な管理者は停止・役割変更できません' : null} onClick={() => setStopping(m)}>
                    利用を停止
                  </Button>
                </div>
              ) : (
                <span className="small muted">{ROLE_LABEL[m.role]}</span>
              )}
            </li>
          );
        })}
      </ul>
      <SaveFeedback state={role.state} successText="役割を変更しました" />
      {stop.state.kind === 'done' && stop.result && (
        <Notice tone="success" title="利用を停止しました">
          <p className="small">未完了の担当 {stop.result.reassigned}件を引き継ぎました。停止したユーザーの既存セッションからも取得・更新できません。履歴の記録者名は残ります。</p>
        </Notice>
      )}
      {stopping && (
        <Modal title={`${stopping.displayName} の利用を停止`} onClose={() => setStopping(null)}>
          <p className="small">退職・異動による個人の停止です。組織の削除とは別の操作です。</p>
          {owned.length > 0 ? (
            <div className="field">
              <label htmlFor="reassign">未完了の担当 {owned.length}件の引き継ぎ先（必須）</label>
              <select id="reassign" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">選んでください</option>
                {ov.members
                  .filter((m) => m.active && m.userId !== stopping.userId)
                  .map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.displayName}
                    </option>
                  ))}
              </select>
              <ul className="small">
                {owned.map((r) => (
                  <li key={r.issue.id}>
                    {r.rentalNumber} {r.itemName}（{r.issue.summary}）
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="small">未完了の担当案件はありません。</p>
          )}
          <SaveFeedback state={stop.state} />
          <div className="row">
            <Button
              variant="primary"
              disabled={stop.saving}
              disabledReason={owned.length > 0 && !to ? '引き継ぎ先を選んでください' : null}
              onClick={async () => {
                if (await stop.run({ userId: stopping.userId, reassignTo: to || null })) {
                  setStopping(null);
                  setTo('');
                }
              }}
            >
              停止する
            </Button>
            <Button onClick={() => setStopping(null)}>やめる</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function Checklist({ ov, admin }: { ov: OrgOverview; admin: boolean }) {
  const { repo } = useApp();
  const [items, setItems] = useState<ChecklistItem[]>(ov.settings.checklist);
  const [newLabel, setNewLabel] = useState('');
  const dirty = JSON.stringify(items) !== JSON.stringify(ov.settings.checklist);
  useDirty('checklist', dirty || newLabel !== '');
  const save = useSave<ChecklistItem[], { version: number }>((op, list) => repo.updateChecklist(op, { expectedVersion: ov.settings.version, items: list }));
  const labelErr = newLabel.length > 40 ? '40字以内にしてください' : /[<>]/.test(newLabel) ? '< > は使えません' : null;
  return (
    <section className="card stack-sm">
      <h2>返却時のチェック項目（最大10）</h2>
      <ul className="list">
        {items.map((c) => (
          <li key={c.id} className="row" style={{ padding: 8 }}>
            <span style={{ flex: 1 }}>{c.label}</span>
            {admin && <Button onClick={() => setItems(items.filter((x) => x.id !== c.id))}>外す</Button>}
          </li>
        ))}
      </ul>
      {admin && (
        <>
          <div className="field">
            <label htmlFor="new-check">項目を追加（文字のみ。HTMLやコードは登録できません）</label>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input id="new-check" type="text" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} aria-invalid={!!labelErr} />
              <Button
                disabledReason={items.length >= 10 ? '10個までです' : newLabel.trim() === '' ? null : labelErr}
                disabled={newLabel.trim() === ''}
                onClick={() => {
                  setItems([...items, { id: '', label: newLabel.trim() }]);
                  setNewLabel('');
                }}
              >
                追加
              </Button>
            </div>
          </div>
          <Button variant="primary" disabledReason={!dirty ? '変更がありません' : null} disabled={save.saving} onClick={() => void save.run(items)}>
            {save.saving ? '保存中' : 'チェック項目を保存'}
          </Button>
          <SaveFeedback state={save.state} onRetry={() => void save.run(items)} onCheck={() => void save.check()} />
        </>
      )}
    </section>
  );
}

function DataReturn({ admin }: { admin: boolean }) {
  const { repo } = useApp();
  const [state, setState] = useState<{ kind: 'idle' | 'making' | 'done' | 'error'; msg?: string; at?: string }>({ kind: 'idle' });
  return (
    <section className="card stack-sm">
      <h2>データ返却（全データ＋写真）</h2>
      <p className="small">
        一覧の絞り込みCSVとは別に、組織の全データをまとめて書き出します：UTF-8 CSV、原文JSON、縮小JPEG、manifest.json（sha256）、README。他の組織のユーザー情報は含みません。
        本番ではサーバーで生成し、短時間有効のURLで受け取ります。
      </p>
      <Button
        variant="primary"
        disabled={state.kind === 'making'}
        disabledReason={!admin ? '組織管理者だけが実行できます' : null}
        onClick={async () => {
          setState({ kind: 'making' });
          try {
            const f = await repo.exportDataReturn();
            download(f);
            setState({ kind: 'done', at: new Date().toISOString(), msg: f.fileName });
          } catch (e) {
            setState({ kind: 'error', msg: isRepoError(e) ? e.message : String(e) });
          }
        }}
      >
        {state.kind === 'making' ? '作成中' : 'データ返却ZIPを作成'}
      </Button>
      {state.kind === 'done' && <Notice tone="success" title="作成しました（サンプルデータ）">{`${state.msg}・${tokyoDateTime(state.at!)}`}</Notice>}
      {state.kind === 'error' && <Notice tone="error" title="作成できませんでした。不完全なZIPは完了扱いにしません">{state.msg}</Notice>}
    </section>
  );
}
