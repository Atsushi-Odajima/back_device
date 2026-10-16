// S03 返却入力 → S04 状態・写真 → S05 提出確認。
// 順序：案件確認→今回数→状態・写真→確認→保存。全数ボタンも確認画面を省略しない。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useApp, useQuery } from '../app/AppContext';
import { useDirty, useRouter } from '../app/router';
import { useSave } from '../app/useSave';
import { Button, FieldError, LoadGate, Notice, PageHead, QtyGrid, SaveFeedback, Status } from '../components/ui';
import { PhotoPicker, revokePhotos, sendPhoto, type LocalPhoto } from '../components/photos';
import { parseQtyField } from '../domain/quantity';
import { tokyoDateTime } from '../domain/time';
import { shortId } from '../domain/ids';
import type { ChecklistItem } from '../domain/types';
import type { LineView, RentalDetail, SubmitReceiptInput, SubmitReceiptResult } from '../data/repository';

type Step = 'input' | 'state' | 'confirm' | 'result';

interface LineForm {
  qty: string;
  dmg: string;
  checklist: Record<string, boolean>;
}
interface FormValues {
  lines: Record<string, LineForm>;
  memo: string;
}

function buildSchema(lines: LineView[]) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  return z
    .object({
      lines: z.record(z.string(), z.object({ qty: z.string(), dmg: z.string(), checklist: z.record(z.string(), z.boolean()) })),
      memo: z.string().max(2000, 'メモは2000字以内です'),
    })
    .superRefine((v, ctx) => {
      let any = false;
      for (const [id, f] of Object.entries(v.lines)) {
        const line = byId.get(id);
        if (!line) continue;
        const q = parseQtyField(f.qty);
        if (q.error) ctx.addIssue({ code: 'custom', path: ['lines', id, 'qty'], message: q.error });
        else if (q.value !== null && q.value > line.q.outstanding)
          ctx.addIssue({ code: 'custom', path: ['lines', id, 'qty'], message: `未返却は残り${line.q.outstanding}${line.unitOriginal}までです` });
        if (q.value) any = true;
        const d = parseQtyField(f.dmg);
        if (d.error) ctx.addIssue({ code: 'custom', path: ['lines', id, 'dmg'], message: d.error });
        else if ((d.value ?? 0) > (q.value ?? 0))
          ctx.addIssue({ code: 'custom', path: ['lines', id, 'dmg'], message: `破損数は今回返却数（${q.value ?? 0}${line.unitOriginal}）以下にしてください` });
      }
      if (!any) ctx.addIssue({ code: 'custom', path: ['memo'], message: '今回返却数を１つ以上入力してください' });
    });
}

export function ReturnFlowScreen({ rentalId }: { rentalId: string }) {
  const { repo } = useApp();
  const q = useQuery(() => repo.getRental(rentalId), [rentalId]);
  const overview = useQuery(() => repo.getOverview(), []);
  return (
    <LoadGate q={q} label="貸出の読み込み">
      {(detail) => <ReturnFlow key={detail.rental.id} detail={detail} checklist={overview.data?.settings.checklist ?? []} />}
    </LoadGate>
  );
}

function ReturnFlow({ detail: initialDetail, checklist }: { detail: RentalDetail; checklist: ChecklistItem[] }) {
  const { repo } = useApp();
  const { navigate } = useRouter();
  // 入力開始時点の版。最新値が来ても自動で差し替えない（自動上書き禁止）。
  const [base, setBase] = useState(initialDetail);
  const [latest, setLatest] = useState<RentalDetail | null>(null);
  const [step, setStep] = useState<Step>('input');
  const [photos, setPhotos] = useState<Record<string, LocalPhoto[]>>({});
  const [submitted, setSubmitted] = useState<{ input: SubmitReceiptInput; result: SubmitReceiptResult } | null>(null);
  const resolver = useMemo(() => zodResolver(buildSchema(base.lines)) as unknown as Resolver<FormValues>, [base.lines]);
  const form = useForm<FormValues>({
    resolver,
    mode: 'onChange',
    defaultValues: {
      lines: Object.fromEntries(base.lines.map((l) => [l.id, { qty: '', dmg: '0', checklist: {} }])),
      memo: '',
    },
  });
  // 最新値で見直す時：新しい残数で入力を再検証する（入力値は残す）
  useEffect(() => {
    if (base !== initialDetail) void form.trigger();
  }, [base, initialDetail, form]);
  const values = useWatch({ control: form.control }) as FormValues;
  const save = useSave<SubmitReceiptInput, SubmitReceiptResult>((op, i) => repo.submitReceipt(op, i));
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => revokePhotos(Object.values(photosRef.current).flat()), []);

  const parsed = base.lines.map((l) => {
    const f = values.lines?.[l.id];
    const qty = parseQtyField(f?.qty ?? '').value ?? 0;
    const dmg = parseQtyField(f?.dmg ?? '').value ?? 0;
    return { line: l, qty, dmg, after: l.q.outstanding - qty, checklist: f?.checklist ?? {} };
  });
  const active = parsed.filter((p) => p.qty > 0);
  const anyPhoto = Object.values(photos).some((p) => p.length > 0);
  const dirty = step !== 'result' && (form.formState.isDirty || anyPhoto);
  useDirty('return-flow', dirty);

  const rental = base.rental;
  const head = (
    <div className="card stack-sm">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="rental-no" style={{ fontSize: 22, fontWeight: 700 }}>
          {rental.externalRentalIdOriginal}
        </span>
        <span className="small muted">返却予定 {tokyoDateTime(rental.dueAt)}</span>
      </div>
      <div>{rental.customerLabelOriginal}</div>
    </div>
  );

  // ---- 送信 ----
  const allPhotoTargets = () =>
    Object.entries(photos).flatMap(([lineId, list]) => list.map((p) => ({ lineId, p })));

  const sendPhotos = async (result: SubmitReceiptResult) => {
    for (const { lineId, p } of allPhotoTargets()) {
      if (p.state === 'ready') continue;
      setPhotos((cur) => ({ ...cur, [lineId]: cur[lineId]!.map((x) => (x.localId === p.localId ? { ...x, state: 'sending' } : x)) }));
      const sent = await sendPhoto(repo, p, {
        issueId: result.damageIssueIds[lineId] ?? null,
        receiptLineId: result.receiptLineIds[lineId] ?? null,
      });
      setPhotos((cur) => ({ ...cur, [lineId]: cur[lineId]!.map((x) => (x.localId === p.localId ? sent : x)) }));
    }
  };

  const doSubmit = async () => {
    const input: SubmitReceiptInput = {
      rentalId: rental.id,
      expectedVersion: rental.version,
      lines: active.map((p) => ({ rentalLineId: p.line.id, qtyReceived: p.qty, qtyDamaged: p.dmg, checklist: p.checklist })),
      memo: values.memo ?? '',
    };
    const result = await save.run(input);
    if (result) await afterSaved(input, result);
  };

  const afterSaved = async (input: SubmitReceiptInput | null, result: SubmitReceiptResult) => {
    setSubmitted({ input: input ?? submitted?.input ?? (null as unknown as SubmitReceiptInput), result });
    setStep('result');
    await sendPhotos(result);
  };

  // タイムアウト後の「保存結果を確認」：確定済みなら結果へ進む
  const doCheck = async () => {
    const result = await save.check();
    if (result) await afterSaved(null, result);
  };

  useEffect(() => {
    if (save.state.kind === 'not_saved' && save.state.error.code === 'conflict') {
      repo.getRental(rental.id).then(setLatest, () => setLatest(null));
    }
  }, [save.state, repo, rental.id]);

  // ---- S03 ----
  if (step === 'input') {
    return (
      <form
        className="stack form-width"
        noValidate
        onSubmit={form.handleSubmit(() => setStep('state'))}
        onKeyDown={(e) => {
          // IME 変換確定の Enter で送信しない
          if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
        }}
      >
        <PageHead title="返却を確認" back="/rentals" backLabel="貸出を選び直す" />
        {head}
        {rental.status !== 'open' && <Notice tone="warning" title="この貸出は完了または取消済みです" />}
        {base.lines.map((l) => {
          const err = form.formState.errors.lines?.[l.id]?.qty?.message;
          const id = `qty-${l.id}`;
          return (
            <section key={l.id} className="line-band" aria-labelledby={`${id}-name`}>
              <div className="line-head">
                <div className="grow">
                  <h2 id={`${id}-name`}>{l.itemNameOriginal}</h2>
                  <div className="small muted num">
                    {l.itemCodeOriginal}・明細 {l.externalLineIdOriginal}
                  </div>
                </div>
              </div>
              <QtyGrid
                cells={[
                  { label: '貸出', value: l.q.qtyOut },
                  { label: '累計返却', value: l.q.returned },
                  { label: '未返却', value: l.q.outstanding, attention: l.q.outstanding > 0 },
                ]}
              />
              {l.q.lost > 0 && <p className="small">うち紛失扱い {l.q.lost}{l.unitOriginal}（責任者記録）</p>}
              {l.q.outstanding === 0 ? (
                <p className="small muted">この明細は未返却がありません。</p>
              ) : (
                <div className="this-time">
                  <div className="field">
                    <label htmlFor={id}>今回返却数（{l.unitOriginal}）</label>
                    <input
                      id={id}
                      className="qty-input"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="off"
                      aria-invalid={!!err}
                      aria-describedby={err ? `${id}-err` : `${id}-hint`}
                      {...form.register(`lines.${l.id}.qty` as const)}
                    />
                    <span className="hint" id={`${id}-hint`}>
                      空欄のままなら今回は返却なし。半角数字。
                    </span>
                  </div>
                  <Button onClick={() => form.setValue(`lines.${l.id}.qty`, String(l.q.outstanding), { shouldDirty: true, shouldValidate: true })}>
                    全数（{l.q.outstanding}）
                  </Button>
                </div>
              )}
              <FieldError id={`${id}-err`}>{err}</FieldError>
            </section>
          );
        })}
        <FieldError id="form-err">{form.formState.errors.memo?.message}</FieldError>
        <div className="bottom-bar">
          <button type="submit" className="btn btn-accent btn-main btn-block">
            次へ（状態・写真）
          </button>
        </div>
      </form>
    );
  }

  // ---- S04 ----
  if (step === 'state') {
    return (
      <form
        className="stack form-width"
        noValidate
        onSubmit={form.handleSubmit(() => setStep('confirm'))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229) && (e.target as HTMLElement).tagName !== 'TEXTAREA') e.preventDefault();
        }}
      >
        <PageHead title="状態・写真" />
        <Button variant="quiet" onClick={() => setStep('input')}>
          ‹ 数量に戻る（入力は残ります）
        </Button>
        {head}
        {active.map(({ line, qty, dmg, after }) => {
          const id = `dmg-${line.id}`;
          const err = form.formState.errors.lines?.[line.id]?.dmg?.message;
          const list = photos[line.id] ?? [];
          return (
            <section key={line.id} className="line-band" aria-labelledby={`${id}-name`}>
              <h2 id={`${id}-name`}>{line.itemNameOriginal}</h2>
              <dl className="kv">
                <dt>数量の根拠</dt>
                <dd>
                  今回返却 <strong className="num">{qty}</strong>
                  {line.unitOriginal}
                </dd>
                <dt>不足</dt>
                <dd>
                  {after > 0 ? (
                    <Status tone="warning">
                      {after}
                      {line.unitOriginal}が未返却（保存後も未返却として残ります）
                    </Status>
                  ) : (
                    'なし'
                  )}
                </dd>
                <dt>破損</dt>
                <dd>
                  {dmg > 0 ? (
                    <Status tone="error">
                      {dmg}
                      {line.unitOriginal}（返却済み{qty}の内数）
                    </Status>
                  ) : (
                    'なし'
                  )}
                </dd>
              </dl>
              <div className="field">
                <label htmlFor={id}>うち破損数（{line.unitOriginal}）</label>
                <input
                  id={id}
                  className="qty-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  aria-invalid={!!err}
                  aria-describedby={err ? `${id}-err` : undefined}
                  {...form.register(`lines.${line.id}.dmg` as const)}
                />
                <FieldError id={`${id}-err`}>{err}</FieldError>
              </div>
              {checklist.length > 0 && (
                <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend style={{ fontWeight: 600 }}>チェック項目</legend>
                  {checklist.map((c) => (
                    <label key={c.id} className="check">
                      <input type="checkbox" {...form.register(`lines.${line.id}.checklist.${c.id}` as const)} />
                      <span>{c.label}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              <PhotoPicker
                label={dmg > 0 ? '破損の写真' : '写真'}
                photos={list}
                onAdd={(p) => setPhotos((cur) => ({ ...cur, [line.id]: [...(cur[line.id] ?? []), p] }))}
                onRemove={(localId) =>
                  setPhotos((cur) => {
                    const target = (cur[line.id] ?? []).find((x) => x.localId === localId);
                    if (target) revokePhotos([target]);
                    return { ...cur, [line.id]: (cur[line.id] ?? []).filter((x) => x.localId !== localId) };
                  })
                }
              />
              {dmg > 0 && list.length === 0 && (
                <Notice tone="warning" title="破損の写真がありません">
                  <p className="small">数量は保存できますが、破損は写真が送信されるまで確認依頼・承認ができません。</p>
                </Notice>
              )}
            </section>
          );
        })}
        <div className="field">
          <label htmlFor="memo">メモ（任意）</label>
          <textarea id="memo" maxLength={2000} {...form.register('memo')} />
        </div>
        <div className="bottom-bar">
          <button type="submit" className="btn btn-primary btn-main btn-block">
            次へ（提出内容の確認）
          </button>
        </div>
      </form>
    );
  }

  // ---- S05 ----
  if (step === 'confirm') {
    const missing = active.filter((p) => p.after > 0);
    const damaged = active.filter((p) => p.dmg > 0);
    const photoCount = Object.values(photos).flat().length;
    const conflict = save.state.kind === 'not_saved' && save.state.error.code === 'conflict';
    return (
      <div className="stack form-width">
        <PageHead title="提出内容の確認" />
        <Button variant="quiet" onClick={() => setStep('state')} disabled={save.saving}>
          ‹ 修正する（入力は残ります）
        </Button>
        {head}
        <div className="table-wrap">
          <table className="data stackable">
            <thead>
              <tr>
                <th>品目</th>
                <th>今回</th>
                <th>累計返却（保存後）</th>
                <th>未返却（保存後）</th>
                <th>うち破損</th>
              </tr>
            </thead>
            <tbody>
              {active.map((p) => (
                <tr key={p.line.id}>
                  <td data-label="品目">{p.line.itemNameOriginal}</td>
                  <td data-label="今回" className="num">
                    {p.qty}
                  </td>
                  <td data-label="累計返却" className="num">
                    {p.line.q.returned + p.qty} / {p.line.q.qtyOut}
                  </td>
                  <td data-label="未返却" className="num">
                    {p.after}
                  </td>
                  <td data-label="うち破損" className="num">
                    {p.dmg}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stack-sm">
          <h2>保存すると発生する対応</h2>
          {missing.length === 0 && damaged.length === 0 && <p>不足・破損はありません。事務の返却反映確認へ進みます。</p>}
          {missing.map((p) => (
            <Notice key={`m${p.line.id}`} tone="warning" title={`${p.line.itemNameOriginal}：${p.after}${p.line.unitOriginal}が未返却です`}>
              <p className="small">「不足（未返却）」として記録されます。紛失・延滞とは自動判定しません。</p>
            </Notice>
          ))}
          {damaged.map((p) => (
            <Notice key={`d${p.line.id}`} tone="error" title={`${p.line.itemNameOriginal}：破損 ${p.dmg}${p.line.unitOriginal}`}>
              <p className="small">「破損」の対応が作られます。写真 {(photos[p.line.id] ?? []).length}枚。</p>
            </Notice>
          ))}
          <p className="small">写真：{photoCount === 0 ? 'なし' : `未送信 ${photoCount}枚（数量の保存後に送信します）`}</p>
        </div>

        {conflict && (
          <Notice tone="warning" title="他の担当者が先にこの貸出を更新しました">
            <p className="small">自動で上書きしません。最新の値とあなたの入力を比べてください。</p>
            {latest ? (
              <div className="stack-sm">
                {active.map((p) => {
                  const now = latest.lines.find((l) => l.id === p.line.id)!;
                  const over = p.qty > now.q.outstanding;
                  return (
                    <div key={p.line.id} className="compare">
                      <div>
                        <div className="small muted">最新の未返却</div>
                        <strong className="num">
                          {now.q.outstanding}
                          {now.unitOriginal}
                        </strong>
                        <div className="small">（あなたの入力時点：{p.line.q.outstanding}）</div>
                      </div>
                      <div>
                        <div className="small muted">あなたの今回</div>
                        <strong className="num">
                          {p.qty}
                          {now.unitOriginal}
                        </strong>
                        {over && <div className="field-error">最新の未返却を超えています</div>}
                      </div>
                    </div>
                  );
                })}
                <div className="row">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setBase(latest);
                      setLatest(null);
                      save.reset();
                      setStep('input');
                    }}
                  >
                    最新値で入力を見直す
                  </Button>
                  <Button
                    onClick={() => {
                      form.reset();
                      navigate('/', { force: true });
                    }}
                  >
                    入力を取り消す
                  </Button>
                </div>
              </div>
            ) : (
              <p className="small">最新の値を取得しています…</p>
            )}
          </Notice>
        )}
        {!conflict && <SaveFeedback state={save.state} onRetry={doSubmit} onCheck={doCheck} />}

        <div className="bottom-bar">
          <Button
            variant="accent"
            main
            block
            onClick={doSubmit}
            disabled={save.saving}
            disabledReason={conflict ? '最新の値との比較を先に確認してください' : rental.status !== 'open' ? 'この貸出は完了または取消済みです' : null}
          >
            {save.saving ? '保存中' : '確認して保存'}
          </Button>
          <p className="small muted">画面を閉じると未送信の入力は失われます。端末には保存しません。</p>
        </div>
      </div>
    );
  }

  // ---- 結果 ----
  const list = allPhotoTargets();
  const pending = list.filter(({ p }) => p.state !== 'ready');
  const sending = list.some(({ p }) => p.state === 'sending');
  const r = submitted!.result;
  return (
    <div className="stack form-width">
      <PageHead title="返却の保存結果" />
      {head}
      {pending.length === 0 ? (
        <Notice tone="success" title="保存しました">
          <p className="small">
            確定時刻 {tokyoDateTime(r.receivedAt)}　受付番号 <span className="num">{shortId(r.receiptId)}</span>
          </p>
          {list.length > 0 && <p className="small">写真 {list.length}枚 送信済み</p>}
        </Notice>
      ) : (
        <Notice tone="warning" title={sending ? '数量保存済み・写真送信中' : '数量保存済み・写真未完了'}>
          <p className="small">
            数量は確定しました（受付番号 <span className="num">{shortId(r.receiptId)}</span>、{tokyoDateTime(r.receivedAt)}）。写真{' '}
            {pending.length}枚がまだ送信されていません。
          </p>
          {!sending && (
            <>
              <ul className="small">
                {pending.map(({ p }) => (
                  <li key={p.localId}>{p.error ?? '未送信'}</li>
                ))}
              </ul>
              <div className="row">
                <Button variant="primary" onClick={() => void sendPhotos(r)}>
                  同じ写真をもう一度送信
                </Button>
              </div>
            </>
          )}
        </Notice>
      )}
      <div className="photos">
        {list.map(({ p }, i) => (
          <div className="photo" key={p.localId}>
            <img src={p.previewUrl} alt={`写真${i + 1}`} />
            {p.state === 'ready' ? <Status tone="success">送信済み</Status> : p.state === 'sending' ? <Status tone="info">送信中</Status> : <Status tone="error">未完了</Status>}
          </div>
        ))}
      </div>
      {(r.missingIssueIds.length > 0 || Object.keys(r.damageIssueIds).length > 0) && (
        <Notice tone="warning" title="不足・破損の対応があります">
          <p className="small">不足 {r.missingIssueIds.length}件・破損 {Object.keys(r.damageIssueIds).length}件。例外一覧から担当・期限・連絡を記録してください。</p>
        </Notice>
      )}
      <div className="stack-sm">
        <Button variant="primary" block onClick={() => navigate('/', { force: true })}>
          今日の返却へ
        </Button>
        <Button block onClick={() => navigate('/issues?tab=mine', { force: true })}>
          不足・破損を確認
        </Button>
        <Button block onClick={() => navigate(`/rentals/${rental.id}`, { force: true })}>
          この貸出の履歴
        </Button>
        {pending.length > 0 && <p className="small muted">写真未完了のまま移動すると、写真は送信されません（例外詳細から追加できます）。</p>}
      </div>
    </div>
  );
}
