// CSV出力（仕様９）。数式インジェクション対策＋RFC4180引用。
// 原文の忠実な返却は JSON で行い、CSV は安全用の変換があることを明記する。

export const CSV_SAFETY_NOTE =
  'CSVでは、=,+,-,@、タブ、改行で始まる文字列の先頭にアポストロフィ（\'）を付けて表計算での数式実行を防いでいます。原文は履歴JSONを参照してください。';

const FORMULA_START = /^[=+\-@\t\r\n]/;

/** 文字列セルの無害化。数値セルは対象外（負数を壊さない）。 */
export function neutralizeCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function quoteCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export type CsvValue = string | number | null;

export function toCsv(header: readonly string[], rows: readonly CsvValue[][]): string {
  const line = (cells: readonly CsvValue[]) =>
    cells
      .map((c) => {
        if (c === null) return '';
        if (typeof c === 'number') return String(c);
        return quoteCell(neutralizeCell(c));
      })
      .join(',');
  // Excel で文字化けしないよう BOM 付き UTF-8、改行は CRLF（RFC4180）。
  return `﻿${[line(header), ...rows.map(line)].join('\r\n')}\r\n`;
}

export const HANDOFF_CSV_COLUMNS = [
  'rental_id',
  'line_id',
  'issue_id',
  'approved_version',
  'item_name',
  'qty',
  'charge_candidate_yen',
  'currency',
  'decision_reason',
] as const;
