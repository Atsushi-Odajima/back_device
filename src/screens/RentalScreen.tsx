// S12 履歴：案件の時系列。誰が何を訂正したか、CSV出力時点と事務受領時点を区別して表示。
// 返却記録の訂正（取消反転＋新記録）、貸出数の変更（admin）、取消もここから行う。
import { useState } from 'react';
import { useApp, useQuery } from '../app/AppContext';
import { useRouter } from '../app/router';
import { useSave } from '../app/useSave';
import { Button, LoadGate, Modal, Notice, PageHead, QtyGrid, SaveFeedback, Status, download } from '../components/ui';
import { STAGE, issueLabel, issueTone } from '../components/labels';
import { ISSUE_KIND_LABEL } from '../domain/issueRules';
import { parseQtyField } from '../domain/quantity';
import { tokyoDateTime } from '../domain/time';
import { shortId } from '../domain/ids';
import { isRepoError } from '../domain/errors';
import type { LineView, ReceiptView, RentalDetail } from '../data/repository';

export function RentalScreen({ rentalId }: { rentalId: string }) {
  const { repo, session } = useApp();
  const { navigate } = useRouter();
  const q = useQuery(() => repo.getRental(rentalId), [rentalId]);
  const h = useQuery(() => repo.getHistory(rentalId), [rentalId]);
  const reviewer = session?.role !== 'operator';
  const [jsonErr, setJsonErr] = useState<string | null>(null);

  return (
    <div className="stack form-width">
      <PageHead title="貸出と履歴" back="/" backLabel="今日の返却" />
      <LoadGate q={q} label="貸出の読み込み">
        {(d) => {
          const stage = summarizeStage(d);
          return (
            <>
              <div className="card stack-sm">
                <div className="row">
                  <span className="rental-no" style={{ fontSize: 22, fontWeight: 700, flex: 1 }}>
                    {d.rental.externalRentalIdOriginal}
                  </span>
                  <Status tone={STAGE[stage].tone}>{STAGE[stage].label}</Status>
                </div>
                <div>{d.rental.customerLabelOriginal}</div>
                <div className="small muted">
                  返却予定 {tokyoDateTime(d.rental.dueAt)}・{d.site.nameOriginal}・取込元 {d.rental.sourceSystem}
                </div>
                {d.rental.externalReturnAckAt && (
                  <p className="small">
                    既存ソフトへの返却反映確認：{tokyoDateTime(d.rental.externalReturnAckAt)}（{d.rental.externalReturnRef ?? `反映不要：${d.rental.externalReturnNoRefReason}`}）
                  </p>
                )}
                {d.rental.status === 'open' && d.lines.some((l) => l.q.outstanding > 0) && (
                  <Button variant="accent" main block onClick={() => navigate(`/rentals/${d.rental.id}/return`)}>
                    返却を確認
                  </Button>
                )}
              </div>

              {d.lines.map((l) => (
                <LineCard key={l.id} d={d} line={l} />
              ))}

              {d.issues.length > 0 && (
                <section className="stack-sm">
                  <h2>不足・破損</h2>
                  <ul className="list">
                    {d.issues.map((i) => (
                      <li key={i.id}>
                        <button type="button" className="list-row" onClick={() => navigate(`/issues/${i.id}?tab=open`)}>
                          <span className="grow">
                            {ISSUE_KIND_LABEL[i.kind]} <span className="num">{i.qty}</span>　<Status tone={issueTone(i.status)}>{issueLabel(i.status)}</Status>
                            <span className="small muted" style={{ display: 'block' }}>
                              {i.summary}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="stack-sm">
                <h2>返却記録</h2>
                {d.receipts.length === 0 && <p className="small muted">返却記録はまだありません。</p>}
                <ul className="list">
                  {d.receipts.map((r) => (
                    <ReceiptRow key={r.id} r={r} d={d} canCorrect={reviewer} />
                  ))}
                </ul>
              </section>

              {reviewer && d.rental.status === 'open' && d.receipts.length === 0 && <CancelRental d={d} />}
            </>
          );
        }}
      </LoadGate>

      <section className="stack-sm">
        <div className="row">
          <h2 style={{ flex: 1 }}>時系列</h2>
          {reviewer && (
            <Button
              onClick={async () => {
                setJsonErr(null);
                try {
                  download(await repo.exportHistoryJson(rentalId));
                } catch (e) {
                  setJsonErr(isRepoError(e) ? e.message : String(e));
                }
              }}
            >
              履歴JSON（原文）
            </Button>
          )}
        </div>
        {jsonErr && <Notice tone="error" title="出力できませんでした">{jsonErr}</Notice>}
        <LoadGate q={h} label="履歴の読み込み">
          {(list) => (
            <ol className="timeline">
              {list.map((e, n) => (
                <li key={n} className={`cat-${e.category}`}>
                  <div className="small muted">
                    {tokyoDateTime(e.at)}・{e.actorName}
                    {e.operationId && <span className="num">・操作 {shortId(e.operationId)}</span>}
                  </div>
                  <div>
                    <strong>{e.title}</strong>
                    {e.detail && `：${e.detail}`}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </LoadGate>
      </section>
    </div>
  );
}

function summarizeStage(d: RentalDetail) {
  if (d.rental.status === 'closed') return 'closed' as const;
  if (d.rental.status === 'cancelled') return 'cancelled' as const;
  if (!d.receipts.some((r) => r.status === 'valid' && !r.reversalOf)) return 'not_started' as const;
  if (d.lines.some((l) => l.q.outstanding > 0)) return 'partial' as const;
  if (d.issues.some((i) => i.status !== 'closed')) return 'issues_open' as const;
  return 'awaiting_ack' as const;
}

function LineCard({ d, line }: { d: RentalDetail; line: LineView }) {
  const { repo, session } = useApp();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(line.qtyOut));
  const [reason, setReason] = useState('');
  const save = useSave<void, { version: number }>((op) => repo.changeQtyOut(op, { lineId: line.id, expectedVersion: line.version, qtyOut: Number(qty), reason }));
  const p = parseQtyField(qty);
  const min = line.q.returned + line.q.lost;
  const err = p.error ?? (p.value !== null && (p.value < Math.max(1, min)) ? `返却済み＋紛失（${min}）未満にはできません` : null);
  return (
    <div className="line-band">
      <div>
        <strong>{line.itemNameOriginal}</strong> <span className="small muted num">{line.itemCodeOriginal}</span>
      </div>
      <QtyGrid
        cells={[
          { label: '貸出', value: line.q.qtyOut },
          { label: '累計返却', value: line.q.returned },
          { label: '未返却', value: line.q.outstanding, attention: line.q.outstanding > 0 },
        ]}
      />
      <p className="small">
        うち破損 {line.q.damaged}（返却済みの内数）・紛失扱い {line.q.lost}
      </p>
      {session?.role === 'admin' && d.rental.status === 'open' && d.receipts.length > 0 && (
        <>
          <Button variant="quiet" onClick={() => setOpen(true)}>
            貸出数を変更（管理者）
          </Button>
          {open && (
            <Modal title="貸出数の変更" onClose={() => setOpen(false)}>
              <p className="small">返却開始後の変更です。関連する例外は再確認に戻ります。</p>
              <div className="field">
                <label htmlFor="qo">新しい貸出数</label>
                <input id="qo" className="qty-input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={!!err} />
                {err && <p className="field-error">{err}</p>}
              </div>
              <div className="field">
                <label htmlFor="qo-r">理由（必須）</label>
                <input id="qo-r" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <SaveFeedback state={save.state} />
              <div className="row">
                <Button
                  variant="primary"
                  disabled={save.saving}
                  disabledReason={err ?? (reason.trim() === '' ? '理由を入力してください' : null)}
                  onClick={async () => (await save.run()) && setOpen(false)}
                >
                  変更する
                </Button>
                <Button onClick={() => setOpen(false)}>やめる</Button>
              </div>
            </Modal>
          )}
        </>
      )}
    </div>
  );
}

function ReceiptRow({ r, d, canCorrect }: { r: ReceiptView; d: RentalDetail; canCorrect: boolean }) {
  const [open, setOpen] = useState(false);
  const name = (id: string) => d.lines.find((l) => l.id === id)?.itemNameOriginal ?? '';
  const isReversal = !!r.reversalOf;
  return (
    <li style={{ padding: '12px 8px' }} className="stack-sm">
      <div className="row">
        <span className="small muted" style={{ flex: 1 }}>
          {tokyoDateTime(r.receivedAt)}・{r.actorName}・受付 <span className="num">{shortId(r.id)}</span>
        </span>
        {isReversal ? <Status tone="warning">取消反転</Status> : r.status === 'reversed' ? <Status tone="neutral">取消済み</Status> : <Status tone="success">有効</Status>}
      </div>
      {isReversal ? (
        <div className="small">受付 {shortId(r.reversalOf!)} を取消：{r.reason}</div>
      ) : (
        <div>
          {r.lines.map((l) => `${name(l.rentalLineId)} 返却${l.qtyReceived}${l.qtyDamaged ? `（うち破損${l.qtyDamaged}）` : ''}`).join('、')}
          {r.reason && <div className="small muted">{r.reason}</div>}
        </div>
      )}
      {canCorrect && !isReversal && r.status === 'valid' && d.rental.status === 'open' && (
        <>
          <Button variant="quiet" onClick={() => setOpen(true)}>
            この返却記録を訂正
          </Button>
          {open && <CorrectReceipt r={r} d={d} onClose={() => setOpen(false)} />}
        </>
      )}
    </li>
  );
}

function CorrectReceipt({ r, d, onClose }: { r: ReceiptView; d: RentalDetail; onClose: () => void }) {
  const { repo } = useApp();
  const [vals, setVals] = useState<Record<string, { qty: string; dmg: string }>>(() =>
    Object.fromEntries(d.lines.map((l) => {
      const rl = r.lines.find((x) => x.rentalLineId === l.id);
      return [l.id, { qty: String(rl?.qtyReceived ?? 0), dmg: String(rl?.qtyDamaged ?? 0) }];
    })),
  );
  const [reason, setReason] = useState('');
  const save = useSave<void, unknown>((op) =>
    repo.correctReceipt(op, {
      receiptId: r.id,
      rentalExpectedVersion: d.rental.version,
      reason,
      lines: d.lines.map((l) => ({
        rentalLineId: l.id,
        qtyReceived: parseQtyField(vals[l.id]!.qty).value ?? 0,
        qtyDamaged: parseQtyField(vals[l.id]!.dmg).value ?? 0,
      })),
    }),
  );
  const bad = d.lines.some((l) => parseQtyField(vals[l.id]!.qty).error || parseQtyField(vals[l.id]!.dmg).error);
  return (
    <Modal title="返却記録の訂正" onClose={onClose}>
      <p className="small">元の記録は上書きせず、取消反転と新しい記録を同時に保存します。承認・完了済みの例外がある場合は、先に権限者が再開してください。</p>
      {d.lines.map((l) => (
        <div key={l.id} className="row">
          <strong style={{ flex: '1 1 100%' }}>{l.itemNameOriginal}</strong>
          <label className="field" style={{ flex: 1 }}>
            <span className="label">返却数</span>
            <input type="text" inputMode="numeric" value={vals[l.id]!.qty} onChange={(e) => setVals({ ...vals, [l.id]: { ...vals[l.id]!, qty: e.target.value } })} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span className="label">うち破損</span>
            <input type="text" inputMode="numeric" value={vals[l.id]!.dmg} onChange={(e) => setVals({ ...vals, [l.id]: { ...vals[l.id]!, dmg: e.target.value } })} />
          </label>
        </div>
      ))}
      <div className="field">
        <label htmlFor="corr-reason">訂正理由（必須）</label>
        <input id="corr-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <SaveFeedback state={save.state} onRetry={() => void save.run()} onCheck={() => void save.check()} />
      <div className="row">
        <Button
          variant="primary"
          disabled={save.saving}
          disabledReason={bad ? '半角数字で入力してください' : reason.trim() === '' ? '訂正理由を入力してください' : null}
          onClick={async () => (await save.run()) && onClose()}
        >
          {save.saving ? '保存中' : '訂正を保存'}
        </Button>
        <Button onClick={onClose}>やめる</Button>
      </div>
    </Modal>
  );
}

function CancelRental({ d }: { d: RentalDetail }) {
  const { repo } = useApp();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const save = useSave<void, unknown>((op) => repo.cancelRental(op, { rentalId: d.rental.id, expectedVersion: d.rental.version, reason }));
  return (
    <section className="stack-sm">
      <Button variant="quiet" onClick={() => setOpen(true)}>
        この貸出を取消（返却記録がない場合のみ）
      </Button>
      {open && (
        <Modal title="貸出の取消" onClose={() => setOpen(false)}>
          <p className="small">取消しても履歴は残ります。返却後の貸出は取消できません。</p>
          <div className="field">
            <label htmlFor="cancel-r">理由（必須）</label>
            <input id="cancel-r" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <SaveFeedback state={save.state} />
          <div className="row">
            <Button variant="primary" disabledReason={reason.trim() === '' ? '理由を入力してください' : null} disabled={save.saving} onClick={async () => (await save.run()) && setOpen(false)}>
              取消する
            </Button>
            <Button onClick={() => setOpen(false)}>やめる</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
