// S10 取込：CSV選択→列・行エラー→差分確認→確定。黙って部分成功させない。
// Stage A は同梱サンプルCSVのみ。持込ファイルの入口は理由付きで無効。
import { useState } from 'react';
import { useApp, useQuery } from '../app/AppContext';
import { useRouter } from '../app/router';
import { useSave } from '../app/useSave';
import { Button, LoadGate, Notice, PageHead, SaveFeedback, Status } from '../components/ui';
import { APP_MODE } from '../components/photos';
import { isRepoError } from '../domain/errors';
import { shortId } from '../domain/ids';
import { tokyoDateTime } from '../domain/time';
import type { ImportValidation } from '../domain/csvImport';
import normalUrl from '../../samples/rentals_normal.csv?url';
import fullwidthUrl from '../../samples/rentals_fullwidth.csv?url';
import oneErrorUrl from '../../samples/rentals_error_one_row.csv?url';
import duplicateUrl from '../../samples/rentals_duplicate.csv?url';
import longUrl from '../../samples/rentals_long_names.csv?url';
import formulaUrl from '../../samples/rentals_formula.csv?url';
import manyUrl from '../../samples/rentals_errors_many.csv?url';
import cp932Url from '../../samples/rentals_cp932.csv?url';

const SAMPLES = [
  { name: 'rentals_normal.csv', url: normalUrl, note: '正常：2件の貸出（4明細）' },
  { name: 'rentals_fullwidth.csv', url: fullwidthUrl, note: '全角：「株式会社ＡＢＣ」「Ｒ－００１」（BOM付き）' },
  { name: 'rentals_long_names.csv', url: longUrl, note: '長名：顧客120字・品名160字' },
  { name: 'rentals_formula.csv', url: formulaUrl, note: '数式で始まる文字列（=, +, -, @）' },
  { name: 'rentals_error_one_row.csv', url: oneErrorUrl, note: '誤り：1行だけ全角数字' },
  { name: 'rentals_duplicate.csv', url: duplicateUrl, note: '誤り：同じ明細キーが重複' },
  { name: 'rentals_errors_many.csv', url: manyUrl, note: '誤り：未知拠点・日時・負数・桁超過・空欄など' },
  { name: 'rentals_cp932.csv', url: cp932Url, note: '誤り：Shift_JIS（CP932）で保存' },
];

interface Checked {
  name: string;
  importId: string;
  validation: ImportValidation;
  reused: boolean;
}

export function ImportScreen() {
  const { repo, session } = useApp();
  const { navigate } = useRouter();
  const [file, setFile] = useState<(typeof SAMPLES)[number] | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commit = useSave<string, { importId: string; summary: ImportValidation['summary'] }>((op, importId) => repo.commitImport(op, { importId }));
  const history = useQuery(() => repo.listImports(), []);

  if (session?.role === 'operator') {
    return (
      <Notice tone="error" title="取込は検品責任者・事務と組織管理者だけが行えます">
        <Button onClick={() => navigate('/', { force: true })}>今日の返却へ</Button>
      </Notice>
    );
  }

  const validate = async (f: (typeof SAMPLES)[number]) => {
    setFile(f);
    setChecked(null);
    setError(null);
    commit.reset();
    setBusy(true);
    try {
      const bytes = new Uint8Array(await (await fetch(f.url)).arrayBuffer());
      const r = await repo.validateImport(f.name, bytes);
      setChecked({ name: f.name, ...r });
      history.reload();
    } catch (e) {
      setError(isRepoError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const v = checked?.validation;
  const errors = v?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = v?.issues.filter((i) => i.severity === 'warning') ?? [];

  return (
    <div className="stack">
      <PageHead title="貸出明細CSVの取込" back="/" backLabel="今日の返却" />
      <p className="small muted">
        列：source_system, rental_id, line_id, site_code, customer_label, due_at, item_code, item_name, unit, qty_out（全て必須）。UTF-8（BOM可）、5MB・2,000行まで。
        大量の確認はPCでの利用をおすすめします。
      </p>

      <section className="stack-sm">
        <h2>１．ファイルを選ぶ</h2>
        {APP_MODE === 'demo' && (
          <>
            <Button disabledReason="検証用デモのため、持込ファイルの取込は無効です。下の同梱サンプルを使ってください（Stage Bで有効）">CSVファイルを選ぶ</Button>
            <ul className="list" aria-label="同梱サンプル">
              {SAMPLES.map((f) => (
                <li key={f.name}>
                  <button type="button" className="list-row" aria-current={file?.name === f.name} onClick={() => validate(f)} disabled={busy}>
                    <span className="grow">
                      <span className="num">{f.name}</span>
                      <span className="small muted" style={{ display: 'block' }}>
                        {f.note}
                      </span>
                    </span>
                    <span className="small">{file?.name === f.name ? '選択中' : '検証する'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {busy && <p role="status">検証中…</p>}
      {error && <Notice tone="error" title="検証できませんでした">{error}</Notice>}

      {checked && v && (
        <section className="stack">
          <h2>２．検証結果</h2>
          {checked.reused && (
            <Notice tone="info" title="同じファイルは取込済みです">
              <p className="small">同じ内容（sha256一致）のファイルは既存の結果を返し、重複して登録しません。</p>
            </Notice>
          )}
          <p className="small">
            {checked.name}・{v.rowCount}行・sha256 <span className="num">{v.sha256.slice(0, 12)}…</span>
          </p>
          {errors.length > 0 ? (
            <Notice tone="error" title={`エラー ${errors.length}件：全体を確定しません`}>
              <p className="small">1件でも誤りがあると、どの行も登録しません。元ファイルを直して、もう一度検証してください。</p>
              <div className="table-wrap">
                <table className="data stackable">
                  <thead>
                    <tr>
                      <th>行</th>
                      <th>列</th>
                      <th>内容と直し方</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.map((e, n) => (
                      <tr key={n}>
                        <td data-label="行" className="num">
                          {e.row ?? 'ファイル'}
                        </td>
                        <td data-label="列" className="num">
                          {e.column ?? '—'}
                        </td>
                        <td data-label="内容">{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row">
                <Button onClick={() => file && validate(file)}>元ファイルを再検証</Button>
              </div>
            </Notice>
          ) : (
            <Notice tone="success" title="エラーはありません" />
          )}
          {warnings.length > 0 && (
            <Notice tone="warning" title={`確認事項 ${warnings.length}件（確定は可能）`}>
              <ul className="small">
                {warnings.map((w, n) => (
                  <li key={n}>
                    {w.row && `${w.row}行目 `}
                    {w.column && `[${w.column}] `}
                    {w.message}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {v.diffs.length > 0 && (
            <div className="stack-sm">
              <h3>差分（追加 {v.summary.added}・変更 {v.summary.changed}・変更なし {v.summary.unchanged}）</h3>
              <p className="small muted">ファイルにない貸出は削除しません。</p>
              <div className="table-wrap">
                <table className="data stackable">
                  <thead>
                    <tr>
                      <th>区分</th>
                      <th>貸出番号</th>
                      <th>顧客</th>
                      <th>明細</th>
                      <th>変更点</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.diffs.map((d) => (
                      <tr key={d.key}>
                        <td data-label="区分">
                          <Status tone={d.kind === 'add' ? 'info' : d.kind === 'change' ? 'warning' : 'neutral'}>
                            {d.kind === 'add' ? '追加' : d.kind === 'change' ? '変更' : '変更なし'}
                          </Status>
                        </td>
                        <td data-label="貸出番号" className="rental-no">
                          {d.rental.rentalId}
                        </td>
                        <td data-label="顧客">{d.rental.customerLabel}</td>
                        <td data-label="明細">
                          {d.rental.lines.map((l) => `${l.itemName}×${l.qtyOut}`).join('、')}
                        </td>
                        <td data-label="変更点">{d.changes.join('／') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {v.ok && (
            <div className="stack-sm form-width">
              <h2>３．確定</h2>
              <Button
                variant="primary"
                main
                disabled={commit.saving || commit.state.kind === 'done'}
                onClick={() => void commit.run(checked.importId)}
              >
                {commit.saving ? '保存中' : `この内容で確定（追加${v.summary.added}・変更${v.summary.changed}）`}
              </Button>
              {commit.state.kind === 'done' && commit.result && (
                <Notice tone="success" title="取込を確定しました">
                  <p className="small">
                    取込番号 <span className="num">{shortId(commit.result.importId)}</span>・追加 {commit.result.summary.added}・変更 {commit.result.summary.changed}・変更なし{' '}
                    {commit.result.summary.unchanged}
                  </p>
                </Notice>
              )}
              {commit.state.kind !== 'done' && <SaveFeedback state={commit.state} onRetry={() => void commit.run(checked.importId)} onCheck={() => void commit.check()} />}
            </div>
          )}
        </section>
      )}

      <section className="stack-sm">
        <h2>取込の記録</h2>
        <LoadGate q={history} label="取込記録の読み込み">
          {(list) =>
            list.length === 0 ? (
              <p className="small muted">まだ取込はありません。</p>
            ) : (
              <ul className="list">
                {[...list].reverse().map((i) => (
                  <li key={i.id} className="row" style={{ padding: 8 }}>
                    <span className="num small" style={{ flex: 1 }}>
                      {tokyoDateTime(i.createdAt)} {i.fileName}
                    </span>
                    <Status tone={i.status === 'committed' ? 'success' : i.status === 'failed' ? 'error' : 'neutral'}>
                      {i.status === 'committed' ? '確定' : i.status === 'failed' ? 'エラーで未確定' : '検証のみ'}
                    </Status>
                  </li>
                ))}
              </ul>
            )
          }
        </LoadGate>
      </section>
    </div>
  );
}
