// S09 事務引き渡し。出力だけでは完了しない。外部処理番号または理由を入れて受領する。
import { useState } from 'react';
import { useApp, useQuery } from '../app/AppContext';
import { useDirty, useRouter } from '../app/router';
import { useSave } from '../app/useSave';
import { Button, LoadGate, Notice, PageHead, SaveFeedback, Status, download, yen } from '../components/ui';
import { BILLING_LABEL, ISSUE_KIND_LABEL } from '../domain/issueRules';
import { CSV_SAFETY_NOTE } from '../domain/csvExport';
import { tokyoDateTime } from '../domain/time';
import { isRepoError } from '../domain/errors';
import type { FileOut, HandoffRow, RentalSummary } from '../data/repository';

type Tab = 'pending' | 'returns' | 'acked' | 'revoked';

export function HandoffScreen() {
  const { repo, session } = useApp();
  const { query, navigate } = useRouter();
  const tab = (query.get('tab') as Tab) ?? 'pending';
  const q = useQuery(() => repo.listHandoffs(), []);
  const awaiting = useQuery(() => repo.listRentalsAwaitingAck(), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const exp = useSave<string[], { file: FileOut; exportedAt: string }>((op, ids) => repo.exportHandoffs(op, { handoffIds: ids }));
  const [csvError, setCsvError] = useState<string | null>(null);
  const [lastDone, setLastDone] = useState<string | null>(null);

  if (session?.role === 'operator') {
    return (
      <Notice tone="error" title="事務引き渡しは検品責任者・事務と組織管理者だけが使えます">
        <Button onClick={() => navigate('/', { force: true })}>今日の返却へ</Button>
      </Notice>
    );
  }

  const rows = q.data ?? [];
  const pending = rows.filter((r) => r.current && !r.handoff.ackAt);
  const acked = rows.filter((r) => r.handoff.ackAt);
  const revoked = rows.filter((r) => !r.current && !r.handoff.ackAt);
  const tabs: [Tab, string, number | null][] = [
    ['pending', '承認済み・未受領', q.data ? pending.length : null],
    ['returns', '返却反映の確認', awaiting.data ? awaiting.data.length : null],
    ['acked', '受領済み', q.data ? acked.length : null],
    ['revoked', '取消・旧版', q.data ? revoked.length : null],
  ];

  return (
    <div className="stack">
      <PageHead title="事務引き渡し" back="/" backLabel="今日の返却">
        <Button
          onClick={async () => {
            setCsvError(null);
            try {
              download(await repo.exportRentalsCsv());
            } catch (e) {
              setCsvError(isRepoError(e) ? e.message : String(e));
            }
          }}
        >
          案件CSVを出力
        </Button>
      </PageHead>
      {csvError && <Notice tone="error" title="出力できませんでした">{csvError}</Notice>}
      {lastDone && <Notice tone="success" title={lastDone} />}
      <p className="small muted">請求候補 ≠ 請求書発行 ≠ 会計計上 ≠ 入金。このアプリは既存ソフトへの反映を確認するだけです。</p>
      <div className="tabs" role="tablist">
        {tabs.map(([k, label, n]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => navigate(`/handoff?tab=${k}`)}>
            {label}
            {n !== null && <span className="small">（{n}）</span>}
          </button>
        ))}
      </div>

      {tab === 'pending' && (
        <LoadGate q={q} label="引き渡しの読み込み">
          {() => (
            <div className="stack">
              {pending.length === 0 ? (
                <p className="card">未受領の承認済み案件はありません。</p>
              ) : (
                <>
                  <div className="card stack-sm">
                    <div className="row">
                      <Button
                        variant="primary"
                        disabled={exp.saving}
                        disabledReason={selected.size === 0 ? '出力する案件を選んでください' : null}
                        onClick={async () => {
                          const r = await exp.run([...selected]);
                          if (r) download(r.file);
                        }}
                      >
                        {exp.saving ? '出力中' : `選択した${selected.size}件の請求候補CSVを出力`}
                      </Button>
                      <Button onClick={() => setSelected(new Set(pending.map((p) => p.handoff.id)))}>すべて選ぶ</Button>
                    </div>
                    <p className="small muted">{CSV_SAFETY_NOTE}</p>
                    <SaveFeedback state={exp.state} successText="CSVを出力しました（まだ未受領です）" onCheck={() => void exp.check().then((r) => r && download(r.file))} />
                  </div>
                  {pending.map((r) => (
                    <PendingCard
                      key={r.handoff.id}
                      onDone={setLastDone}
                      row={r}
                      checked={selected.has(r.handoff.id)}
                      onCheck={(c) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (c) n.add(r.handoff.id);
                          else n.delete(r.handoff.id);
                          return n;
                        })
                      }
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </LoadGate>
      )}

      {tab === 'returns' && (
        <LoadGate q={awaiting} label="返却反映待ちの読み込み">
          {(list) => (
            <div className="stack">
              <p className="small">全数が返却（または紛失処理）され、不足・破損がすべて完了した貸出です。既存ソフトで返却を反映したら、番号または反映不要の理由を入れて完了にします。</p>
              {list.length === 0 ? <p className="card">返却反映の確認待ちはありません。</p> : list.map((s) => <ReturnAckCard key={s.rental.id} s={s} onDone={setLastDone} />)}
            </div>
          )}
        </LoadGate>
      )}

      {tab === 'acked' && (
        <LoadGate q={q} label="引き渡しの読み込み">
          {() =>
            acked.length === 0 ? (
              <p className="card">受領済みはありません。</p>
            ) : (
              <ul className="list">
                {acked.map((r) => (
                  <li key={r.handoff.id} style={{ padding: '12px 8px' }} className="stack-sm">
                    <Head row={r} />
                    <dl className="kv small">
                      <dt>CSV出力</dt>
                      <dd>{r.handoff.exportedAt ? `${tokyoDateTime(r.handoff.exportedAt)}（${r.handoff.exportCount}回）` : '出力なし'}</dd>
                      <dt>事務受領</dt>
                      <dd>
                        {tokyoDateTime(r.handoff.ackAt!)}・{r.ackByName}
                      </dd>
                      <dt>外部番号／理由</dt>
                      <dd>
                        {r.handoff.externalRef ?? '—'} {r.handoff.note && `／${r.handoff.note}`}
                      </dd>
                    </dl>
                    {r.issue.externalCorrectionPending && <Status tone="warning">再開済み：既存ソフト側の訂正が必要</Status>}
                  </li>
                ))}
              </ul>
            )
          }
        </LoadGate>
      )}

      {tab === 'revoked' && (
        <LoadGate q={q} label="引き渡しの読み込み">
          {() =>
            revoked.length === 0 ? (
              <p className="card">取消・旧版はありません。</p>
            ) : (
              <ul className="list">
                {revoked.map((r) => (
                  <li key={r.handoff.id} style={{ padding: '12px 8px' }} className="stack-sm">
                    <Head row={r} />
                    <Status tone="error">取消済み・旧版CSVは使用不可</Status>
                    <p className="small">
                      {r.handoff.revokedAt && `取消 ${tokyoDateTime(r.handoff.revokedAt)}：${r.handoff.revokedReason ?? ''}`}
                      {r.handoff.exportedAt && `／この版は ${tokyoDateTime(r.handoff.exportedAt)} に出力済み。既存ソフトへ登録していれば訂正してください。`}
                    </p>
                  </li>
                ))}
              </ul>
            )
          }
        </LoadGate>
      )}
    </div>
  );
}

function Head({ row }: { row: HandoffRow }) {
  const { navigate } = useRouter();
  return (
    <div className="stack-sm">
      <div className="row">
        <span className="rental-no" style={{ fontWeight: 700 }}>
          {row.rentalNumber}
        </span>
        <span>{row.customerLabel}</span>
      </div>
      <div>
        {ISSUE_KIND_LABEL[row.issue.kind]}：{row.itemName} <span className="num">{row.issue.qty}</span>
        {row.unit}
      </div>
      <div className="row">
        <strong>{BILLING_LABEL[row.handoff.action]}</strong>
        <strong className="num" style={{ fontSize: 22 }}>
          {yen(row.handoff.chargeCandidateYen)}
        </strong>
        <span className="small muted">（税抜）承認版 v{row.handoff.approvedVersion}</span>
        <Button variant="quiet" onClick={() => navigate(`/issues/${row.issue.id}?tab=open`)}>
          詳細
        </Button>
      </div>
    </div>
  );
}

function PendingCard({ row, checked, onCheck, onDone }: { row: HandoffRow; checked: boolean; onCheck: (c: boolean) => void; onDone: (msg: string) => void }) {
  const { repo } = useApp();
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  useDirty(`ack-${row.handoff.id}`, ref !== '' || note !== '');
  const save = useSave<void, { ackAt: string }>((op) => repo.ackHandoff(op, { handoffId: row.handoff.id, externalRef: ref, note }));
  const charge = row.handoff.action === 'charge_candidate';
  const reason = charge && ref.trim() === '' ? '既存ソフトでの外部処理番号を入力してください' : !charge && ref.trim() === '' && note.trim() === '' ? '反映内容または反映不要の理由を入力してください' : null;
  return (
    <div className="card stack-sm">
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
        <span>CSV出力の対象にする</span>
      </label>
      <Head row={row} />
      <div className="row">
        <Status tone="warning">未受領</Status>
        {row.handoff.exportedAt ? (
          <Status tone="info">
            CSV出力済み {tokyoDateTime(row.handoff.exportedAt)}（{row.handoff.exportCount}回）
          </Status>
        ) : (
          <Status tone="neutral">CSV未出力</Status>
        )}
      </div>
      {row.issue.externalCorrectionPending && (
        <Notice tone="warning" title="既存ソフト側の訂正が必要">
          <p className="small">完了後に再開された改訂版です。旧版で登録した内容を既存ソフトで訂正してから受領してください。</p>
        </Notice>
      )}
      <div className="field">
        <label htmlFor={`ref-${row.handoff.id}`}>既存ソフトでの外部処理番号{charge ? '（必須）' : ''}</label>
        <input id={`ref-${row.handoff.id}`} type="text" value={ref} onChange={(e) => setRef(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`note-${row.handoff.id}`}>{charge ? 'メモ' : '反映内容または反映不要の理由'}</label>
        <input id={`note-${row.handoff.id}`} type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <Button
        variant="primary"
        disabled={save.saving}
        disabledReason={reason}
        onClick={async () => {
          const r = await save.run();
          if (r) onDone(`${row.rentalNumber} ${row.itemName} を受領しました（${tokyoDateTime(r.ackAt)}）。「受領済み」に移りました`);
        }}
      >
        {save.saving ? '保存中' : '既存ソフトへの反映を確認して受領'}
      </Button>
      <SaveFeedback state={save.state} onRetry={() => void save.run()} onCheck={() => void save.check()} successText="受領しました" listPath="/handoff" />
    </div>
  );
}

function ReturnAckCard({ s, onDone }: { s: RentalSummary; onDone: (msg: string) => void }) {
  const { repo } = useApp();
  const { navigate } = useRouter();
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  useDirty(`ret-${s.rental.id}`, ref !== '' || reason !== '');
  const save = useSave<void, { version: number }>((op) =>
    repo.closeRental(op, { rentalId: s.rental.id, expectedVersion: s.rental.version, externalRef: ref, noRefReason: reason }),
  );
  return (
    <div className="card stack-sm">
      <div className="row">
        <span className="rental-no" style={{ fontWeight: 700 }}>
          {s.rental.externalRentalIdOriginal}
        </span>
        <span>{s.rental.customerLabelOriginal}</span>
        <Button variant="quiet" onClick={() => navigate(`/rentals/${s.rental.id}`)}>
          履歴
        </Button>
      </div>
      <p className="small">
        貸出 {s.totalOut}・未返却 0・未完了の例外 0
      </p>
      <div className="field">
        <label htmlFor={`rref-${s.rental.id}`}>既存ソフトでの返却反映番号</label>
        <input id={`rref-${s.rental.id}`} type="text" value={ref} onChange={(e) => setRef(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`rreason-${s.rental.id}`}>番号がない場合：反映不要の理由</label>
        <input id={`rreason-${s.rental.id}`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button
        variant="primary"
        disabled={save.saving}
        disabledReason={ref.trim() === '' && reason.trim() === '' ? '番号または反映不要の理由を入力してください' : null}
        onClick={async () => {
          if (await save.run()) onDone(`${s.rental.externalRentalIdOriginal} の返却反映を確認し、完了にしました`);
        }}
      >
        {save.saving ? '保存中' : '返却反映を確認して完了'}
      </Button>
      <SaveFeedback state={save.state} onRetry={() => void save.run()} onCheck={() => void save.check()} successText="完了しました" listPath="/handoff" />
    </div>
  );
}
