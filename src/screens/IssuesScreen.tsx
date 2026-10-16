// S06 例外一覧（原則１列）＋ S07 例外詳細。PC は一覧と作業面の２領域まで。
import { useState } from 'react';
import { useApp, useQuery } from '../app/AppContext';
import { useDirty, useRouter } from '../app/router';
import { useSave } from '../app/useSave';
import { Button, FieldError, LoadGate, Modal, Notice, PageHead, QtyGrid, SaveFeedback, Status } from '../components/ui';
import { PhotoPicker, RemotePhoto, revokePhotos, sendPhoto, type LocalPhoto } from '../components/photos';
import { issueLabel, issueTone } from '../components/labels';
import { ChevronIcon } from '../components/Icons';
import { BILLING_LABEL, ISSUE_KIND_LABEL, RESOLUTION_LABEL } from '../domain/issueRules';
import { tokyoDateTime } from '../domain/time';
import { PHOTOS_PER_TARGET } from '../domain/photo';
import type { IssueDetail, IssueListRow, SubmitIssueAction } from '../data/repository';
import type { ContactChannel } from '../domain/types';

type Tab = 'mine' | 'overdue' | 'review' | 'sendback' | 'open' | 'closed';
const TABS: [Tab, string][] = [
  ['mine', '自分の担当'],
  ['overdue', '期限超過'],
  ['review', '確認待ち'],
  ['sendback', '差し戻し'],
  ['open', '未完了すべて'],
  ['closed', '完了'],
];

function filterRows(rows: IssueListRow[], tab: Tab, me: string, reviewer: boolean) {
  const open = rows.filter((r) => r.issue.status !== 'closed');
  switch (tab) {
    case 'mine':
      return open.filter((r) => r.issue.ownerUserId === me && r.issue.status !== 'approved');
    case 'overdue':
      return open.filter((r) => r.overdue);
    case 'review':
      return open.filter((r) => r.issue.status === 'review_pending');
    case 'sendback':
      return open.filter((r) => r.issue.status === 'needs_correction' && (reviewer || r.issue.ownerUserId === me));
    case 'open':
      return open;
    case 'closed':
      return rows.filter((r) => r.issue.status === 'closed');
  }
}

export function IssuesScreen({ selectedId }: { selectedId: string | null }) {
  const { repo, session } = useApp();
  const { query, navigate } = useRouter();
  const tab = (query.get('tab') as Tab) ?? 'mine';
  const q = useQuery(() => repo.listIssues(), []);
  const reviewer = session?.role !== 'operator';

  return (
    <div className={`two-pane${selectedId ? ' has-selection' : ''}`}>
      <section className="pane-list stack" aria-label="例外一覧">
        <PageHead title="不足・破損" back="/" backLabel="今日の返却" />
        <div className="tabs" role="tablist" aria-label="絞り込み">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => navigate(`/issues?tab=${k}`)}>
              {label}
              {q.data && <span className="small">（{filterRows(q.data, k, session!.userId, reviewer).length}）</span>}
            </button>
          ))}
        </div>
        <LoadGate q={q} label="例外一覧の読み込み">
          {(rows) => {
            const list = filterRows(rows, tab, session!.userId, reviewer);
            if (list.length === 0) return <p className="card">この絞り込みに該当する例外はありません。</p>;
            return (
              <ul className="list">
                {list.map((r) => (
                  <li key={r.issue.id}>
                    <button
                      type="button"
                      className="list-row"
                      aria-current={r.issue.id === selectedId}
                      onClick={() => navigate(`/issues/${r.issue.id}?tab=${tab}`)}
                    >
                      <span className="grow">
                        <span className="row" style={{ gap: 6 }}>
                          <strong>{ISSUE_KIND_LABEL[r.issue.kind]}</strong>
                          <Status tone={issueTone(r.issue.status)}>{issueLabel(r.issue.status)}</Status>
                          {r.overdue && <Status tone="error">期限超過</Status>}
                          {r.issue.externalCorrectionPending && <Status tone="warning">外部訂正が必要</Status>}
                        </span>
                        <span style={{ display: 'block' }}>
                          <span className="rental-no">{r.rentalNumber}</span>　{r.itemName} <span className="num">{r.issue.qty}</span>
                          {r.unit}
                        </span>
                        <span className="small muted" style={{ display: 'block' }}>
                          担当 {r.ownerName}
                          {!r.ownerActive && '（停止中）'}・期限 {tokyoDateTime(r.issue.dueAt)}
                        </span>
                      </span>
                      <ChevronIcon />
                    </button>
                  </li>
                ))}
              </ul>
            );
          }}
        </LoadGate>
      </section>
      <section className="pane-work" aria-label="選択中の例外">
        {selectedId ? (
          <IssueDetailPane issueId={selectedId} backTo={`/issues?tab=${tab}`} />
        ) : (
          <p className="card muted">一覧から例外を選ぶと、ここに詳細が表示されます。</p>
        )}
      </section>
    </div>
  );
}

function IssueDetailPane({ issueId, backTo }: { issueId: string; backTo: string }) {
  const { repo } = useApp();
  const q = useQuery(() => repo.getIssue(issueId), [issueId]);
  return (
    <div className="stack">
      <PageHead title="例外の詳細" back={backTo} backLabel="一覧" />
      <LoadGate q={q} label="例外の読み込み">
        {(d) => <IssueDetailView d={d} />}
      </LoadGate>
    </div>
  );
}

export function IssueSummary({ d }: { d: IssueDetail }) {
  const i = d.issue;
  return (
    <div className="card stack-sm">
      <div className="row">
        <h2 style={{ flex: 1 }}>{ISSUE_KIND_LABEL[i.kind]}</h2>
        <Status tone={issueTone(i.status)}>{issueLabel(i.status)}</Status>
      </div>
      <div>
        <span className="rental-no" style={{ fontWeight: 700 }}>
          {d.rental.externalRentalIdOriginal}
        </span>
        　{d.rental.customerLabelOriginal}
      </div>
      <div className="small muted">
        {d.line.itemNameOriginal}（{d.line.itemCodeOriginal}）
      </div>
      <p>{i.summary}</p>
      <QtyGrid
        cells={
          i.kind === 'missing'
            ? [
                { label: '判断対象数量', value: i.qty },
                { label: '現在の未返却', value: d.line.q.outstanding, attention: d.line.q.outstanding > 0 },
                { label: '紛失扱い', value: d.line.q.lost },
              ]
            : [
                { label: '破損', value: i.qty, attention: true },
                { label: '累計返却', value: d.line.q.returned },
                { label: '貸出', value: d.line.q.qtyOut },
              ]
        }
      />
      {i.kind === 'missing' && (
        <p className="small muted">判断対象数量は確認依頼時点の数で固定します。現在の未返却は返却記録から計算した値です。</p>
      )}
      {i.externalCorrectionPending && (
        <Notice tone="warning" title="既存ソフト側の訂正が必要（未解消）">
          <p className="small">完了後に再開されました。事務が既存ソフトで訂正し、新しい版を受領するまで閉じません。</p>
        </Notice>
      )}
      {i.photoSkipReason && (
        <Notice tone="error" title="写真なしで記録（承認できません）">
          <p className="small">理由：{i.photoSkipReason}。写真を送信して確認を依頼してください。</p>
        </Notice>
      )}
      {i.decisionReason && (
        <dl className="kv">
          <dt>解消方法</dt>
          <dd>{i.resolutionCode ? RESOLUTION_LABEL[i.resolutionCode] : '—'}</dd>
          <dt>請求</dt>
          <dd>
            {i.billingAction ? BILLING_LABEL[i.billingAction] : '—'}
            {i.billingAction === 'charge_candidate' && `（税抜 ${i.chargeCandidateYen?.toLocaleString('ja-JP')}円）`}
          </dd>
          <dt>判断理由</dt>
          <dd>{i.decisionReason}</dd>
        </dl>
      )}
    </div>
  );
}

export function IssuePhotos({ d }: { d: IssueDetail }) {
  const ready = d.attachments.filter((a) => a.status === 'ready');
  const pending = d.attachments.filter((a) => a.status === 'pending');
  return (
    <div className="stack-sm">
      <h3>写真</h3>
      {ready.length === 0 && <p className="small muted">送信済みの写真はありません。</p>}
      <div className="photos">
        {ready.map((a, n) => (
          <div className="photo" key={a.id}>
            <RemotePhoto attachmentId={a.id} alt={`写真${n + 1}（${a.imageWidth}×${a.imageHeight}）`} />
            <span className="small muted">{tokyoDateTime(a.createdAt)}</span>
          </div>
        ))}
      </div>
      {pending.length > 0 && <Status tone="warning">送信未完了の写真 {pending.length}枚</Status>}
    </div>
  );
}

export function IssueEvents({ d }: { d: IssueDetail }) {
  return (
    <ol className="timeline" aria-label="対応履歴">
      {[...d.events].reverse().map((e) => (
        <li key={e.id}>
          <div className="small muted">
            {tokyoDateTime(e.createdAt)}・{e.actorName}
          </div>
          <div>
            {e.eventType === 'contact' && <strong>連絡記録（手動）：</strong>}
            {e.eventType === 'correction' && <strong>訂正の追記：</strong>}
            {e.channel && `${CHANNEL[e.channel]}／`}
            {e.contactedAt && `${tokyoDateTime(e.contactedAt)}／`}
            {e.outcome && `結果：${e.outcome}　`}
            {e.note}
          </div>
        </li>
      ))}
    </ol>
  );
}

const CHANNEL: Record<ContactChannel, string> = { phone: '電話', email: 'メール', other: 'その他' };

function IssueDetailView({ d }: { d: IssueDetail }) {
  const { repo, session, bumpData } = useApp();
  const { navigate } = useRouter();
  const i = d.issue;
  const role = session!.role;
  const reviewer = role !== 'operator';
  const [note, setNote] = useState('');
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const act = useSave<{ action: SubmitIssueAction; note: string }, { version: number }>((op, x) =>
    repo.submitIssue(op, { issueId: i.id, expectedVersion: i.version, ...x }),
  );
  useDirty(`issue-${i.id}`, note !== '' || photos.some((p) => p.state !== 'ready'));

  const editable = ['open', 'waiting', 'needs_correction'].includes(i.status);
  const readyPhotos = d.attachments.filter((a) => a.status === 'ready').length;
  const needPhoto = i.kind === 'damage' && readyPhotos === 0;
  const lastSendBack = [...d.events].reverse().find((e) => e.eventType === 'send_back' || e.eventType === 'revoke_approval');

  const [sentCount, setSentCount] = useState(0);
  const sendPhotos = async () => {
    const results: LocalPhoto[] = [];
    for (const p of photos) {
      if (p.state === 'ready') continue;
      setPhotos((cur) => cur.map((x) => (x.localId === p.localId ? { ...x, state: 'sending' } : x)));
      const sent = await sendPhoto(repo, p, { issueId: i.id, receiptLineId: i.receiptLineId });
      results.push(sent);
      setPhotos((cur) => cur.map((x) => (x.localId === p.localId ? sent : x)));
    }
    if (results.every((r) => r.state === 'ready')) {
      // 送信済みはサーバー側の写真として表示し直す
      revokePhotos(photos);
      setPhotos([]);
      setSentCount(results.length);
    }
    bumpData();
  };
  const allSent = false;

  return (
    <div className="stack">
      <IssueSummary d={d} />
      {i.status === 'needs_correction' && lastSendBack && (
        <Notice tone="error" title="差し戻し理由">
          <p>{lastSendBack.note}</p>
          <p className="small">
            {lastSendBack.actorName}・{tokyoDateTime(lastSendBack.createdAt)}
          </p>
        </Notice>
      )}

      <div className="card stack-sm">
        <dl className="kv">
          <dt>担当</dt>
          <dd>{d.ownerName}</dd>
          <dt>期限</dt>
          <dd>{tokyoDateTime(i.dueAt)}</dd>
        </dl>
        {reviewer && i.status !== 'closed' && <AssignForm d={d} />}
      </div>

      <IssuePhotos d={d} />
      {editable && i.kind !== 'missing' && (
        <div className="card stack-sm">
          <PhotoPicker
            label="写真を追加"
            max={Math.max(0, PHOTOS_PER_TARGET - d.attachments.filter((a) => a.status !== 'rejected').length)}
            photos={photos}
            onAdd={(p) => setPhotos((c) => [...c, p])}
            onRemove={(id) => setPhotos((c) => {
              revokePhotos(c.filter((x) => x.localId === id));
              return c.filter((x) => x.localId !== id);
            })}
          />
          {photos.length > 0 && !allSent && (
            <Button variant="primary" onClick={sendPhotos} disabled={photos.some((p) => p.state === 'sending')}>
              {photos.some((p) => p.state === 'sending') ? '送信中' : photos.some((p) => p.state === 'failed') ? '同じ写真をもう一度送信' : '写真を送信'}
            </Button>
          )}
          {photos.some((p) => p.state === 'failed') && (
            <p className="field-error" role="alert">
              {photos.find((p) => p.error)?.error}
            </p>
          )}
          {sentCount > 0 && photos.length === 0 && <Status tone="success">写真 {sentCount}枚 送信しました</Status>}
        </div>
      )}

      <div className="stack-sm">
        <h3>次の操作</h3>
        {editable && (
          <>
            <div className="field">
              <label htmlFor="issue-note">確認依頼のメモ（任意）</label>
              <textarea id="issue-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
            </div>
            <Button
              variant="primary"
              main
              block
              disabled={act.saving}
              disabledReason={needPhoto ? '破損の確認依頼には送信済みの写真が1枚以上必要です' : null}
              onClick={async () => (await act.run({ action: 'request_review', note })) && setNote('')}
            >
              {act.saving ? '保存中' : i.status === 'needs_correction' ? '直して確認を依頼' : '確認を依頼'}
            </Button>
            {i.status === 'open' && (
              <Button block onClick={async () => (await act.run({ action: 'to_waiting', note })) && setNote('')} disabled={act.saving}>
                顧客確認中にする
              </Button>
            )}
            {i.kind === 'damage' && needPhoto && !i.photoSkipReason && (
              <Button variant="quiet" onClick={() => setSkipOpen(true)}>
                写真を省略して理由を記録する
              </Button>
            )}
          </>
        )}
        {i.status === 'review_pending' &&
          (reviewer ? (
            <Button variant="primary" main block onClick={() => navigate(`/issues/${i.id}/review`)}>
              責任者確認へ
            </Button>
          ) : (
            <Notice tone="info" title="責任者の確認待ちです" />
          ))}
        {i.status === 'approved' &&
          (reviewer ? (
            <div className="stack-sm">
              <Button variant="primary" block onClick={() => navigate('/handoff')}>
                事務引き渡しへ（未受領）
              </Button>
              <Button block onClick={() => navigate(`/issues/${i.id}/review`)}>
                承認内容を見る・取り消す
              </Button>
            </div>
          ) : (
            <Notice tone="info" title="承認済み・事務の受領待ちです" />
          ))}
        {i.status === 'closed' && (role === 'admin' ? <ReopenForm d={d} /> : <Notice tone="success" title="完了しています">訂正が必要な場合は組織管理者に依頼してください。</Notice>)}
        <SaveFeedback state={act.state} onRetry={() => void act.run({ action: 'request_review', note })} onCheck={() => void act.check()} listPath="/issues" />
        {act.state.kind === 'not_saved' && act.state.error.code === 'conflict' && (
          <p className="small">表示は最新の内容に更新されました。状態を確認してからもう一度操作してください。</p>
        )}
      </div>

      <ContactForm d={d} />

      <div className="stack-sm">
        <h3>対応履歴</h3>
        <IssueEvents d={d} />
        <Button variant="quiet" onClick={() => navigate(`/rentals/${d.rental.id}`)}>
          貸出全体の履歴を見る
        </Button>
      </div>

      {skipOpen && (
        <Modal title="写真を省略して記録" onClose={() => setSkipOpen(false)}>
          <p className="small">写真なしの破損は「差し戻し（写真未完了）」として残り、写真が送信されるまで承認できません。</p>
          <div className="field">
            <label htmlFor="skip-reason">省略する理由（必須）</label>
            <textarea id="skip-reason" value={skipReason} onChange={(e) => setSkipReason(e.target.value)} />
          </div>
          <div className="row">
            <Button
              variant="primary"
              disabledReason={skipReason.trim() === '' ? '理由を入力してください' : null}
              onClick={async () => {
                if (await act.run({ action: 'photo_skip', note: skipReason })) setSkipOpen(false);
              }}
            >
              理由を記録
            </Button>
            <Button onClick={() => setSkipOpen(false)}>やめる</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AssignForm({ d }: { d: IssueDetail }) {
  const { repo } = useApp();
  const ov = useQuery(() => repo.getOverview(), []);
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState(d.issue.ownerUserId);
  const [due, setDue] = useState(() => toLocalInput(d.issue.dueAt));
  const [note, setNote] = useState('');
  const save = useSave<void, { version: number }>((op) =>
    repo.assignIssue(op, { issueId: d.issue.id, expectedVersion: d.issue.version, ownerUserId: owner, dueAt: fromLocalInput(due), note }),
  );
  const newOwner = ov.data?.members.find((m) => m.userId === owner);
  if (!open)
    return (
      <div className="stack-sm">
        <Button onClick={() => setOpen(true)}>担当・期限を変更</Button>
        {save.state.kind === 'done' && (
          <Notice tone="success" title="担当・期限を変更しました">
            <p className="small">引き継ぎ確認：新しい担当者に、連絡履歴と次の操作を伝えてください。旧担当は履歴に残ります。</p>
          </Notice>
        )}
      </div>
    );
  return (
    <div className="stack-sm">
      <div className="field">
        <label htmlFor="assign-owner">担当者</label>
        <select id="assign-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          {ov.data?.members
            .filter((m) => m.active)
            .map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
              </option>
            ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="assign-due">期限</label>
        <input id="assign-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="assign-note">引き継ぎメモ</label>
        <input id="assign-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {newOwner && newOwner.userId !== d.issue.ownerUserId && (
        <p className="small">
          {d.ownerName} → <strong>{newOwner.displayName}</strong> に引き継ぎます。
        </p>
      )}
      <div className="row">
        <Button variant="primary" disabled={save.saving} onClick={async () => (await save.run()) && setOpen(false)}>
          {save.saving ? '保存中' : '変更を保存'}
        </Button>
        <Button onClick={() => setOpen(false)}>やめる</Button>
      </div>
      <SaveFeedback state={save.state} onRetry={() => void save.run()} onCheck={() => void save.check()} listPath="/issues" />
    </div>
  );
}

function ContactForm({ d }: { d: IssueDetail }) {
  const { repo } = useApp();
  const [channel, setChannel] = useState<ContactChannel>('phone');
  const [at, setAt] = useState(() => toLocalInput(new Date().toISOString()));
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [corrects, setCorrects] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  useDirty(`contact-${d.issue.id}`, outcome !== '' || note !== '');
  const save = useSave<void, { eventId: string }>((op) =>
    repo.addContactRecord(op, { issueId: d.issue.id, channel, contactedAt: fromLocalInput(at), outcome, note, correctsEventId: corrects }),
  );
  const contacts = d.events.filter((e) => e.eventType === 'contact');
  const outcomeErr = touched && outcome.trim() === '' && !corrects ? '連絡の結果を入力してください（例：不在、明日返却と回答）' : null;
  return (
    <form
      className="card stack-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        setTouched(true);
        if (outcome.trim() === '' && !corrects) return;
        if (await save.run()) {
          setOutcome('');
          setNote('');
          setCorrects(null);
          setTouched(false);
        }
      }}
    >
      <h3>連絡を記録（手動）</h3>
      <p className="small muted">電話・メールした事実を記録します。このアプリから顧客へ送信はしません。</p>
      {corrects && (
        <Notice tone="info" title="訂正を追記します">
          <p className="small">元の記録は残したまま、訂正内容を追加します。</p>
          <Button variant="quiet" onClick={() => setCorrects(null)}>
            訂正をやめる
          </Button>
        </Notice>
      )}
      <fieldset className="choice-row" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="visually-hidden">連絡手段</legend>
        {(Object.keys(CHANNEL) as ContactChannel[]).map((c) => (
          <label key={c} className="choice">
            <input type="radio" name={`ch-${d.issue.id}`} checked={channel === c} onChange={() => setChannel(c)} />
            <span>{CHANNEL[c]}</span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="contact-at">連絡日時</label>
        <input id="contact-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="contact-outcome">結果</label>
        <input
          id="contact-outcome"
          type="text"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          aria-invalid={!!outcomeErr}
          aria-describedby={outcomeErr ? 'contact-outcome-err' : undefined}
        />
        <FieldError id="contact-outcome-err">{outcomeErr}</FieldError>
      </div>
      <div className="field">
        <label htmlFor="contact-note">メモ</label>
        <textarea id="contact-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </div>
      <button type="submit" className="btn btn-primary" disabled={save.saving}>
        {save.saving ? '保存中' : corrects ? '訂正を追記' : '連絡を記録'}
      </button>
      <SaveFeedback state={save.state} onRetry={() => void save.run()} onCheck={() => void save.check()} successText="記録しました" />
      {contacts.length > 0 && (
        <details>
          <summary className="small" style={{ minHeight: 48, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            過去の連絡記録を訂正する
          </summary>
          <ul className="list">
            {contacts.map((c) => (
              <li key={c.id} className="row" style={{ padding: 8 }}>
                <span style={{ flex: 1 }} className="small">
                  {tokyoDateTime(c.createdAt)} {c.outcome}
                </span>
                <Button onClick={() => setCorrects(c.id)}>この記録を訂正</Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </form>
  );
}

function ReopenForm({ d }: { d: IssueDetail }) {
  const { repo } = useApp();
  const [reason, setReason] = useState('');
  const save = useSave<void, { version: number }>((op) => repo.reopenIssue(op, { issueId: d.issue.id, expectedVersion: d.issue.version, reason }));
  return (
    <div className="card stack-sm">
      <h3>完了後の訂正（組織管理者）</h3>
      <p className="small">再開すると新しい改訂版になり、旧版・理由・行為者は履歴に残ります。外部で受領済みなら「既存ソフト側の訂正が必要」が未解消タスクとして残ります。</p>
      <div className="field">
        <label htmlFor="reopen-reason">再開の理由（必須）</label>
        <textarea id="reopen-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button variant="primary" disabledReason={reason.trim() === '' ? '理由を入力してください' : null} disabled={save.saving} onClick={() => void save.run()}>
        {save.saving ? '保存中' : '理由を記録して再開'}
      </Button>
      <SaveFeedback state={save.state} onRetry={() => void save.run()} onCheck={() => void save.check()} />
    </div>
  );
}

export function toLocalInput(iso: string): string {
  // Asia/Tokyo 固定で datetime-local 用の文字列にする
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return d.toISOString().slice(0, 16);
}
export function fromLocalInput(v: string): string {
  return new Date(`${v}:00+09:00`).toISOString();
}
