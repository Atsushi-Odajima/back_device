// S02 貸出検索・選択。番号検索を優先。複数行を勝手に１案件へ結合しない。
import { useState } from 'react';
import { useApp, useQuery } from '../app/AppContext';
import { useRouter } from '../app/router';
import { LoadGate, PageHead, Status } from '../components/ui';
import { STAGE } from '../components/labels';
import { ChevronIcon } from '../components/Icons';
import { tokyoDate, tokyoDateTime } from '../domain/time';
import { rentalTarget } from './HomeScreen';

export function SearchScreen() {
  const { repo } = useApp();
  const { query, navigate } = useRouter();
  const ymd = query.get('date') ?? tokyoDate(new Date());
  const [mode, setMode] = useState<'today' | 'open'>(query.get('mode') === 'open' ? 'open' : 'today');
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
  const [applied, setApplied] = useState('');
  const q = useQuery(() => repo.searchRentals({ query: applied, mode, ymd }), [applied, mode, ymd]);

  return (
    <div className="stack">
      <PageHead title="返却する貸出を選ぶ" back="/" backLabel="今日の返却" />
      <form
        className="stack-sm form-width"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (!composing) setApplied(text);
        }}
      >
        <label htmlFor="rental-search" style={{ fontWeight: 600 }}>
          貸出番号（または顧客名）
        </label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            id="rental-search"
            type="search"
            inputMode="text"
            autoComplete="off"
            value={text}
            placeholder="例：R-001"
            onChange={(e) => {
              setText(e.target.value);
              if (!composing) setApplied(e.target.value);
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(e) => {
              setComposing(false);
              setApplied(e.currentTarget.value);
            }}
          />
          <button type="submit" className="btn btn-primary">
            検索
          </button>
        </div>
        <p className="small muted">全角・半角の違いは区別せずに探します（保存されている番号は原文のまま）。</p>
      </form>
      <div className="tabs" role="tablist" aria-label="表示範囲">
        {(
          [
            ['today', `${ymd.replace(/-/g, '/')} の返却予定`],
            ['open', '未完了すべて'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)}>
            {label}
          </button>
        ))}
      </div>
      <LoadGate q={q} label="検索">
        {(list) =>
          list.length === 0 ? (
            <p className="card">該当する貸出はありません。番号を確認するか「未完了すべて」に切り替えてください。</p>
          ) : (
            <ul className="list" aria-label="検索結果">
              {list.map((s) => (
                <li key={s.rental.id}>
                  <button type="button" className="list-row" onClick={() => navigate(rentalTarget(s))}>
                    <span className="grow">
                      <span className="rental-no" style={{ fontWeight: 700, fontSize: 18 }}>
                        {s.rental.externalRentalIdOriginal}
                      </span>
                      <span style={{ display: 'block' }}>{s.rental.customerLabelOriginal}</span>
                      <span className="small muted" style={{ display: 'block' }}>
                        返却予定 {tokyoDateTime(s.rental.dueAt)}・{s.rental.sourceSystem}
                      </span>
                      <Status tone={STAGE[s.stage].tone}>{STAGE[s.stage].label}</Status>
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
