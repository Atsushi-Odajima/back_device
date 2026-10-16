// S01 今日の返却。KPIカード・グラフは置かない。
import { useApp, useQuery } from '../app/AppContext';
import { useRouter } from '../app/router';
import { Button, LoadGate, Status } from '../components/ui';
import { STAGE } from '../components/labels';
import { AlertIcon, ChevronIcon, ScanIcon, SendBackIcon, DocIcon, ExportIcon } from '../components/Icons';
import { addDays, formatBusinessDate, tokyoDate, tokyoTime } from '../domain/time';
import type { RentalSummary } from '../data/repository';

export function rentalTarget(s: RentalSummary): string {
  return s.rental.status === 'open' && s.totalOutstanding > 0 ? `/rentals/${s.rental.id}/return` : `/rentals/${s.rental.id}`;
}

export function HomeScreen() {
  const { repo, session } = useApp();
  const { navigate, query } = useRouter();
  const ymd = query.get('date') ?? tokyoDate(new Date());
  const rentals = useQuery(() => repo.listRentalsForDate(ymd), [ymd]);
  const issues = useQuery(() => repo.listIssues(), []);
  const overview = useQuery(() => repo.getOverview(), []);
  const reviewer = session?.role !== 'operator';

  const open = issues.data?.filter((r) => r.issue.status !== 'closed') ?? [];
  const mineOpen = open.filter((r) => ['open', 'waiting'].includes(r.issue.status) && (reviewer || r.issue.ownerUserId === session?.userId));
  const sendBack = open.filter((r) => r.issue.status === 'needs_correction' && (reviewer || r.issue.ownerUserId === session?.userId));
  const reviewWait = open.filter((r) => r.issue.status === 'review_pending');
  const approved = open.filter((r) => r.issue.status === 'approved');
  const count = (n: number) => (issues.data ? `${n}件` : issues.error ? '件数を取得できません' : '…');

  const setDate = (d: string) => navigate(`/?date=${d}`);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="eyebrow">{overview.data?.sites[0]?.nameOriginal ?? '拠点'}</div>
          <h1>今日の返却</h1>
        </div>
        <div className="row" aria-label="日付">
          <Button aria-label="前の日" onClick={() => setDate(addDays(ymd, -1))}>
            ‹
          </Button>
          <label className="visually-hidden" htmlFor="home-date">
            日付
          </label>
          <input id="home-date" type="date" value={ymd} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 'auto' }} />
          <Button aria-label="次の日" onClick={() => setDate(addDays(ymd, 1))}>
            ›
          </Button>
        </div>
      </div>
      <p className="num muted" style={{ marginTop: -8 }}>
        {formatBusinessDate(ymd)}
      </p>

      <button type="button" className="btn btn-accent task-band" onClick={() => navigate(`/rentals?mode=today&date=${ymd}`)}>
        <ScanIcon />
        <span className="grow">返却を確認</span>
        <ChevronIcon />
      </button>
      <div className="stack-sm">
        <button type="button" className="task-line" onClick={() => navigate('/issues?tab=mine')}>
          <AlertIcon />
          <span className="grow">不足・破損を確認</span>
          <span className="small">{count(mineOpen.length)}</span>
          <ChevronIcon />
        </button>
        <button type="button" className="task-line" onClick={() => navigate('/issues?tab=sendback')}>
          <SendBackIcon />
          <span className="grow">差し戻しを直す</span>
          <span className="small">{count(sendBack.length)}</span>
          <ChevronIcon />
        </button>
        {reviewer && (
          <>
            <button type="button" className="task-line" onClick={() => navigate('/issues?tab=review')}>
              <DocIcon />
              <span className="grow">責任者確認（確認待ち）</span>
              <span className="small">{count(reviewWait.length)}</span>
              <ChevronIcon />
            </button>
            <button type="button" className="task-line" onClick={() => navigate('/handoff')}>
              <ExportIcon />
              <span className="grow">事務引き渡し（未受領）</span>
              <span className="small">{count(approved.length)}</span>
              <ChevronIcon />
            </button>
          </>
        )}
      </div>

      <hr className="section-rule" />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>返却予定と未完了</h2>
        <span className="small muted">時刻順</span>
      </div>
      <LoadGate q={rentals} label="返却予定の読み込み">
        {(list) =>
          list.length === 0 ? (
            <div className="card stack-sm">
              <p>今日の返却予定はありません</p>
              <div className="row">
                <Button onClick={() => setDate(addDays(ymd, 1))}>翌日を見る</Button>
                <Button onClick={() => setDate(tokyoDate(new Date()))}>今日に戻る</Button>
              </div>
            </div>
          ) : (
            <ul className="list" aria-label="返却予定">
              {list.map((s) => (
                <li key={s.rental.id}>
                  <button type="button" className="list-row" onClick={() => navigate(rentalTarget(s))}>
                    <span className="time">{tokyoDate(s.rental.dueAt) === ymd ? tokyoTime(s.rental.dueAt) : '超過'}</span>
                    <span className="grow">
                      <span className="rental-no" style={{ fontWeight: 700 }}>
                        {s.rental.externalRentalIdOriginal}
                      </span>
                      <span style={{ display: 'block' }}>{s.rental.customerLabelOriginal}</span>
                      <span className="small muted" style={{ display: 'block' }}>
                        {s.firstItemName}
                        {s.lineCount > 1 && ` ほか${s.lineCount - 1}品目`}
                      </span>
                      <Status tone={STAGE[s.stage].tone}>
                        {STAGE[s.stage].label}
                        {s.totalOutstanding > 0 && s.hasReceipts && `・未返却${s.totalOutstanding}`}
                      </Status>
                    </span>
                    <span className="qty-mini">
                      <span style={{ fontSize: 20, fontWeight: 700 }}>{s.totalOut}</span>
                      <span className="small muted" style={{ display: 'block' }}>
                        貸出
                      </span>
                    </span>
                    <ChevronIcon />
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </LoadGate>
    </div>
  );
}
