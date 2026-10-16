// S08 責任者確認。判断案・請求候補・解消理由・変更履歴。承認／差し戻し。
// 入力中に他の担当が更新しても自動上書きしない（差分を示して再確認）。
import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useApp, useQuery } from '../app/AppContext';
import { useDirty, useRouter } from '../app/router';
import { useSave } from '../app/useSave';
import { Button, FieldError, LoadGate, Modal, Notice, PageHead, SaveFeedback, yen } from '../components/ui';
import { BILLING_LABEL, ISSUE_STATUS_LABEL, RESOLUTION_LABEL } from '../domain/issueRules';
import { tokyoDateTime } from '../domain/time';
import type { IssueDetail, ReviewInput } from '../data/repository';
import type { BillingAction, ResolutionCode } from '../domain/types';
import { IssueEvents, IssuePhotos, IssueSummary } from './IssuesScreen';

const schema = z
  .object({
    resolutionCode: z.enum(['returned', 'repair', 'lost', 'other'], { message: '解消方法を選んでください' }),
    billingAction: z.enum(['no_charge', 'charge_candidate'], { message: '請求の扱いを選んでください' }),
    amount: z.string(),
    decisionReason: z.string().trim().min(1, '判断理由を入力してください').max(2000, '2000字以内です'),
  })
  .superRefine((v, ctx) => {
    if (v.billingAction === 'charge_candidate') {
      if (/[０-９]/.test(v.amount)) ctx.addIssue({ code: 'custom', path: ['amount'], message: '半角数字で入力してください（例：3000）' });
      else if (!/^\d{1,9}$/.test(v.amount) || Number(v.amount) < 1 || Number(v.amount) > 100_000_000)
        ctx.addIssue({ code: 'custom', path: ['amount'], message: '1～100,000,000円の整数（税抜、カンマなし）で入力してください' });
    }
  });
type FormValues = z.input<typeof schema>;

export function ReviewScreen({ issueId }: { issueId: string }) {
  const { repo } = useApp();
  const q = useQuery(() => repo.getIssue(issueId), [issueId]);
  return (
    <div className="stack form-width">
      <PageHead title="責任者確認" back={`/issues/${issueId}?tab=review`} backLabel="例外の詳細" />
      <LoadGate q={q} label="例外の読み込み">
        {(live) => <Review live={live} />}
      </LoadGate>
    </div>
  );
}

function Review({ live }: { live: IssueDetail }) {
  const { repo, session } = useApp();
  const { navigate } = useRouter();
  // 判断を始めた時点の版。最新が届いても自動で差し替えない。
  const [base, setBase] = useState(live);
  // 自分の紛失記録・反転の後は、自分の更新なので最新版へ取り込む
  const [ownChange, setOwnChange] = useState(false);
  useEffect(() => {
    if (ownChange && live.issue.version !== base.issue.version) {
      setBase(live);
      setOwnChange(false);
    }
  }, [ownChange, live, base.issue.version]);
  const changed = !ownChange && live.issue.version !== base.issue.version;
  const i = base.issue;
  const reviewer = session?.role !== 'operator';
  const hasActiveLoss = base.losses.some((l) => l.reversedAt === null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      resolutionCode: (i.resolutionCode ?? (hasActiveLoss ? 'lost' : i.kind === 'missing' ? 'returned' : undefined)) as ResolutionCode,
      billingAction: (i.billingAction ?? undefined) as BillingAction,
      amount: i.chargeCandidateYen ? String(i.chargeCandidateYen) : '',
      decisionReason: '',
    },
  });
  const v = useWatch({ control: form.control });
  useDirty(`review-${i.id}`, form.formState.isDirty);
  const [confirm, setConfirm] = useState<ReviewInput | null>(null);
  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [sendBackReason, setSendBackReason] = useState('');
  const save = useSave<ReviewInput, { version: number; handoffId: string | null }>((op, x) => repo.reviewIssue(op, x));

  if (!reviewer) {
    return (
      <Notice tone="error" title="この画面は検品責任者・事務と組織管理者だけが使えます">
        <Button onClick={() => navigate('/issues', { force: true })}>一覧へ戻る</Button>
      </Notice>
    );
  }

  const toInput = (f: FormValues): ReviewInput => ({
    issueId: i.id,
    expectedVersion: i.version,
    decision: 'approve',
    resolutionCode: f.resolutionCode,
    billingAction: f.billingAction,
    chargeCandidateYen: f.billingAction === 'charge_candidate' ? Number(f.amount) : 0,
    decisionReason: f.decisionReason.trim(),
  });

  const outstanding = base.line.q.outstanding;
  const missingBlock = i.kind === 'missing' && outstanding > 0 ? `未返却が${outstanding}${base.line.unitOriginal}残っています。返却を待つか紛失数量を記録してください` : null;
  const photoBlock = i.kind === 'damage' && (base.attachments.every((a) => a.status !== 'ready') || i.photoSkipReason) ? '送信済みの写真がない破損は承認できません' : null;
  const statusBlock = i.status !== 'review_pending' ? `現在の状態（${ISSUE_STATUS_LABEL[i.status]}）では承認できません` : null;

  return (
    <div className="stack">
      {changed && (
        <Notice tone="warning" title="他の担当者がこの例外を更新しました">
          <div className="compare">
            <div>
              <div className="small muted">あなたが確認を始めた版</div>
              <div>v{base.issue.version}・{ISSUE_STATUS_LABEL[base.issue.status]}・数量 {base.issue.qty}</div>
            </div>
            <div>
              <div className="small muted">最新</div>
              <div>
                v{live.issue.version}・{ISSUE_STATUS_LABEL[live.issue.status]}・数量 {live.issue.qty}
              </div>
            </div>
          </div>
          <p className="small">入力した判断は残しています。最新の内容を確認してから、もう一度判断してください。</p>
          <div className="row">
            <Button variant="primary" onClick={() => setBase(live)}>
              最新の内容で確認し直す
            </Button>
          </div>
        </Notice>
      )}
      <IssueSummary d={base} />
      <IssuePhotos d={base} />

      {i.kind === 'missing' && i.status !== 'approved' && i.status !== 'closed' && <LossSection d={base} onSaved={setOwnChange} />}
      {base.losses.length > 0 && <LossList d={base} onSaved={setOwnChange} />}

      {i.status === 'approved' ? (
        <RevokeSection d={base} />
      ) : (
        <form
          className="card stack"
          noValidate
          onSubmit={form.handleSubmit((f) => setConfirm(toInput(f)))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
          }}
        >
          <h2>判断</h2>
          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600 }}>解消方法</legend>
            <div className="choice-row">
              {(Object.keys(RESOLUTION_LABEL) as ResolutionCode[]).map((k) => (
                <label key={k} className="choice">
                  <input type="radio" value={k} {...form.register('resolutionCode')} />
                  <span>{RESOLUTION_LABEL[k]}</span>
                </label>
              ))}
            </div>
            <FieldError id="res-err">{form.formState.errors.resolutionCode?.message}</FieldError>
          </fieldset>
          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600 }}>請求の扱い（解消方法とは別）</legend>
            <div className="choice-row">
              {(Object.keys(BILLING_LABEL) as BillingAction[]).map((k) => (
                <label key={k} className="choice">
                  <input type="radio" value={k} {...form.register('billingAction')} />
                  <span>{BILLING_LABEL[k]}</span>
                </label>
              ))}
            </div>
            <FieldError id="bill-err">{form.formState.errors.billingAction?.message}</FieldError>
          </fieldset>
          {v.billingAction === 'charge_candidate' && (
            <div className="field">
              <label htmlFor="amount">請求候補の金額（円・税抜）</label>
              <input
                id="amount"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                className="num"
                aria-invalid={!!form.formState.errors.amount}
                aria-describedby="amount-hint amount-err"
                {...form.register('amount')}
              />
              <span className="hint" id="amount-hint">
                税計算・端数処理はしません。請求書の発行・会計計上・入金はこのアプリでは行いません。
              </span>
              <FieldError id="amount-err">{form.formState.errors.amount?.message}</FieldError>
            </div>
          )}
          {v.billingAction === 'no_charge' && <p className="small">請求なし：金額は0円として記録します。</p>}
          <div className="field">
            <label htmlFor="reason">判断理由</label>
            <textarea id="reason" aria-invalid={!!form.formState.errors.decisionReason} aria-describedby="reason-err" {...form.register('decisionReason')} />
            <FieldError id="reason-err">{form.formState.errors.decisionReason?.message}</FieldError>
          </div>
          <SaveFeedback state={save.state} onRetry={() => confirm && void save.run(confirm)} onCheck={() => void save.check()} listPath="/issues?tab=review" successText="保存しました" />
          <div className="bottom-bar">
            <button
              type="submit"
              className="btn btn-primary btn-main btn-block"
              disabled={!!(statusBlock || missingBlock || photoBlock || changed) || save.saving}
            >
              承認して事務へ
            </button>
            {(statusBlock || missingBlock || photoBlock || changed) && (
              <span className="disabled-reason">押せない理由：{statusBlock ?? missingBlock ?? photoBlock ?? '最新の内容で確認し直してください'}</span>
            )}
            {i.status === 'review_pending' && (
              <Button block onClick={() => setSendBackOpen(true)} disabled={save.saving || changed}>
                差し戻す
              </Button>
            )}
          </div>
        </form>
      )}

      <div className="stack-sm">
        <h3>変更履歴</h3>
        <IssueEvents d={base} />
      </div>

      {confirm && (
        <Modal title="この内容で承認しますか" onClose={() => setConfirm(null)}>
          <dl className="kv">
            <dt>対象</dt>
            <dd>
              <span className="rental-no">{base.rental.externalRentalIdOriginal}</span> {base.rental.customerLabelOriginal}
            </dd>
            <dt>品目・数量</dt>
            <dd>
              {base.line.itemNameOriginal} <strong className="num">{i.qty}</strong>
              {base.line.unitOriginal}（{i.kind === 'missing' ? '不足' : '破損'}）
            </dd>
            <dt>解消方法</dt>
            <dd>{confirm.resolutionCode && RESOLUTION_LABEL[confirm.resolutionCode]}</dd>
            <dt>請求</dt>
            <dd>
              {confirm.billingAction && BILLING_LABEL[confirm.billingAction]}　<strong className="num" style={{ fontSize: 22 }}>{yen(confirm.chargeCandidateYen)}</strong>（税抜）
            </dd>
            <dt>理由</dt>
            <dd>{confirm.decisionReason}</dd>
          </dl>
          <p className="small">承認すると事務引き渡し（未受領）になります。CSVを出力しただけでは完了しません。</p>
          <SaveFeedback state={save.state} onRetry={() => void save.run(confirm)} onCheck={() => void save.check()} listPath="/issues?tab=review" />
          <div className="row">
            <Button
              variant="primary"
              main
              disabled={save.saving}
              onClick={async () => {
                const r = await save.run(confirm);
                if (r) {
                  form.reset(form.getValues());
                  setConfirm(null);
                  navigate(`/issues/${i.id}?tab=review`, { force: true });
                }
              }}
            >
              {save.saving ? '保存中' : '承認する'}
            </Button>
            <Button onClick={() => setConfirm(null)} disabled={save.saving}>
              戻って直す
            </Button>
          </div>
        </Modal>
      )}
      {sendBackOpen && (
        <Modal title="差し戻す" onClose={() => setSendBackOpen(false)}>
          <div className="field">
            <label htmlFor="sb-reason">差し戻し理由（担当者に表示されます）</label>
            <textarea id="sb-reason" value={sendBackReason} onChange={(e) => setSendBackReason(e.target.value)} />
          </div>
          <SaveFeedback state={save.state} listPath="/issues?tab=review" />
          <div className="row">
            <Button
              variant="primary"
              disabledReason={sendBackReason.trim() === '' ? '理由を入力してください' : null}
              disabled={save.saving}
              onClick={async () => {
                const r = await save.run({
                  issueId: i.id,
                  expectedVersion: i.version,
                  decision: 'send_back',
                  resolutionCode: null,
                  billingAction: null,
                  chargeCandidateYen: null,
                  decisionReason: sendBackReason,
                });
                if (r) {
                  form.reset(form.getValues());
                  setSendBackOpen(false);
                  navigate(`/issues/${i.id}?tab=review`, { force: true });
                }
              }}
            >
              差し戻す
            </Button>
            <Button onClick={() => setSendBackOpen(false)}>やめる</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function LossSection({ d, onSaved }: { d: IssueDetail; onSaved: (ok: boolean) => void }) {
  const { repo } = useApp();
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const save = useSave<void, { lossId: string }>((op) =>
    repo.resolveLoss(op, { issueId: d.issue.id, expectedVersion: d.issue.version, qtyLost: Number(qty), reason }),
  );
  const out = d.line.q.outstanding;
  if (out === 0) return null;
  const n = Number(qty);
  const err = qty === '' ? null : !/^\d+$/.test(qty) || n < 1 || n > out ? `1～${out}${d.line.unitOriginal}（現在の未返却）で指定してください` : null;
  return (
    <div className="card stack-sm">
      <h2>紛失として記録</h2>
      <p className="small">責任者による紛失扱いの確認記録です。法的責任を自動で確定するものではありません。請求の有無は別に判断します。</p>
      <div className="field">
        <label htmlFor="loss-qty">紛失数量（{d.line.unitOriginal}）</label>
        <input id="loss-qty" className="qty-input" type="text" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={!!err} aria-describedby="loss-err" />
        <FieldError id="loss-err">{err}</FieldError>
      </div>
      <div className="field">
        <label htmlFor="loss-reason">理由</label>
        <input id="loss-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button
        variant="primary"
        disabled={save.saving}
        disabledReason={qty === '' || err ? '紛失数量を入力してください' : reason.trim() === '' ? '理由を入力してください' : null}
        onClick={async () => {
          onSaved(true);
          const ok = await save.run();
          if (!ok) onSaved(false);
          if (ok) {
            setQty('');
            setReason('');
          }
        }}
      >
        {save.saving ? '保存中' : '紛失として記録'}
      </Button>
      <SaveFeedback state={save.state} onRetry={() => void save.run()} onCheck={() => void save.check()} />
    </div>
  );
}

function LossList({ d, onSaved }: { d: IssueDetail; onSaved: (ok: boolean) => void }) {
  const { repo, session } = useApp();
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const save = useSave<void, { ok: true }>((op) => repo.reverseLoss(op, { lossId: target!, reason }));
  return (
    <div className="card stack-sm">
      <h3>紛失処理の記録</h3>
      <ul className="list">
        {d.losses.map((l) => (
          <li key={l.id} style={{ padding: 8 }}>
            <div>
              紛失 <strong className="num">{l.qtyLost}</strong>
              {d.line.unitOriginal}・{tokyoDateTime(l.approvedAt)}・{l.reason}
              {l.reversedAt && `（反転済み ${tokyoDateTime(l.reversedAt)}：${l.reverseReason}）`}
            </div>
            {!l.reversedAt && session?.role === 'admin' && (
              <Button onClick={() => setTarget(l.id)}>実物が戻ったので反転する</Button>
            )}
          </li>
        ))}
      </ul>
      {!d.losses.some((l) => !l.reversedAt) || session?.role === 'admin' ? null : (
        <p className="small muted">紛失扱いの後に実物が戻った場合は、組織管理者が反転してから返却を記録します。</p>
      )}
      {target && (
        <Modal title="紛失処理を反転" onClose={() => setTarget(null)}>
          <p className="small">反転すると未返却数が戻り、判断は差し戻しになります。金額は自動で相殺しません。外部で処理済みなら既存ソフト側の訂正確認が必要です。</p>
          <div className="field">
            <label htmlFor="rev-reason">理由</label>
            <input id="rev-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <SaveFeedback state={save.state} />
          <div className="row">
            <Button
              variant="primary"
              disabledReason={reason.trim() === '' ? '理由を入力してください' : null}
              disabled={save.saving}
              onClick={async () => {
                onSaved(true);
                const ok = await save.run();
                if (!ok) onSaved(false);
                if (ok) setTarget(null);
              }}
            >
              反転する
            </Button>
            <Button onClick={() => setTarget(null)}>やめる</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RevokeSection({ d }: { d: IssueDetail }) {
  const { repo } = useApp();
  const [reason, setReason] = useState('');
  const save = useSave<void, unknown>((op) =>
    repo.reviewIssue(op, {
      issueId: d.issue.id,
      expectedVersion: d.issue.version,
      decision: 'revoke',
      resolutionCode: null,
      billingAction: null,
      chargeCandidateYen: null,
      decisionReason: reason,
    }),
  );
  return (
    <div className="card stack-sm">
      <h2>承認済み（事務の受領待ち）</h2>
      <p className="small">承認内容を修正する場合は、理由を入れて差し戻します。旧い引き渡しは取消履歴として残り、旧版CSVは使えない表示になります。</p>
      <div className="field">
        <label htmlFor="revoke-reason">取り消す理由</label>
        <textarea id="revoke-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button disabledReason={reason.trim() === '' ? '理由を入力してください' : null} disabled={save.saving} onClick={() => void save.run()}>
        承認を取り消して差し戻す
      </Button>
      <SaveFeedback state={save.state} onRetry={() => void save.run()} onCheck={() => void save.check()} />
    </div>
  );
}
