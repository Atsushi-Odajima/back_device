// 貸出明細CSVの検証（仕様９）。純粋関数。1件でも error があれば全体未確定。
import Papa from 'papaparse';
import { searchKey } from './searchKey';
import { sha256Hex } from './sha256';
import type { ImportIssue } from './types';

export const IMPORT_COLUMNS = [
  'source_system',
  'rental_id',
  'line_id',
  'site_code',
  'customer_label',
  'due_at',
  'item_code',
  'item_name',
  'unit',
  'qty_out',
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 2000;

const MAX_LEN: Record<ImportColumn, number> = {
  source_system: 40,
  rental_id: 80,
  line_id: 80,
  site_code: 40,
  customer_label: 120,
  due_at: 40,
  item_code: 80,
  item_name: 160,
  unit: 12,
  qty_out: 4,
};

const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface ParsedLine {
  row: number;
  sourceSystem: string;
  rentalId: string;
  lineId: string;
  siteCode: string;
  customerLabel: string;
  dueAt: string; // ISO UTC
  itemCode: string;
  itemName: string;
  unit: string;
  qtyOut: number;
}

export interface ParsedRental {
  sourceSystem: string;
  rentalId: string;
  siteCode: string;
  customerLabel: string;
  dueAt: string;
  lines: ParsedLine[];
}

/** 既存データとの差分計算に必要な最小限の既存情報。 */
export interface ExistingRental {
  id: string;
  sourceSystem: string;
  externalRentalIdOriginal: string;
  externalRentalIdSearch: string;
  customerLabelOriginal: string;
  siteCode: string;
  dueAt: string;
  version: number;
  hasReceipts: boolean;
  status: string;
  lines: { externalLineIdOriginal: string; itemCodeOriginal: string; itemNameOriginal: string; unitOriginal: string; qtyOut: number }[];
}

export type DiffKind = 'add' | 'change' | 'unchanged';

export interface RentalDiff {
  kind: DiffKind;
  key: string;
  rental: ParsedRental;
  existingId: string | null;
  expectedVersion: number | null;
  changes: string[];
}

export interface ImportValidation {
  sha256: string;
  rowCount: number;
  issues: ImportIssue[];
  diffs: RentalDiff[];
  ok: boolean;
  summary: { added: number; changed: number; unchanged: number };
}

function decode(bytes: Uint8Array): { text: string | null; issue: ImportIssue | null } {
  try {
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text, issue: null };
  } catch {
    return {
      text: null,
      issue: {
        row: null,
        column: null,
        severity: 'error',
        message:
          'UTF-8として読めません（Shift_JIS/CP932の可能性）。Excelの「名前を付けて保存」で「CSV UTF-8（コンマ区切り）」を選んで保存し直してください。',
      },
    };
  }
}

const err = (row: number | null, column: string | null, message: string): ImportIssue => ({
  row,
  column,
  message,
  severity: 'error',
});
const warn = (row: number | null, column: string | null, message: string): ImportIssue => ({
  row,
  column,
  message,
  severity: 'warning',
});

export function validateImport(
  bytes: Uint8Array,
  ctx: { siteCodes: readonly string[]; existing: readonly ExistingRental[] },
): ImportValidation {
  const sha = sha256Hex(bytes);
  const issues: ImportIssue[] = [];
  const fail = (): ImportValidation => ({
    sha256: sha,
    rowCount: 0,
    issues,
    diffs: [],
    ok: false,
    summary: { added: 0, changed: 0, unchanged: 0 },
  });

  if (bytes.byteLength > IMPORT_MAX_BYTES) {
    issues.push(err(null, null, `ファイルが5MBを超えています（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB）。分割してください。`));
    return fail();
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    issues.push(err(null, null, 'Excelファイル（.xlsx）は直接取り込めません。CSV UTF-8で保存してください。'));
    return fail();
  }
  const { text, issue } = decode(bytes);
  if (issue || text === null) {
    if (issue) issues.push(issue);
    return fail();
  }

  const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: 'greedy' });
  for (const e of parsed.errors) {
    issues.push(err(e.row !== undefined ? e.row : null, null, `CSVの形式に誤りがあります：${e.message}`));
  }
  const [header, ...body] = parsed.data;
  if (!header) {
    issues.push(err(null, null, 'ヘッダ行がありません'));
    return fail();
  }
  // 列名のみは前後空白を許容して照合（値は原文保持）。
  const cols = header.map((h) => h.trim());
  const missing = IMPORT_COLUMNS.filter((c) => !cols.includes(c));
  if (missing.length > 0) {
    issues.push(err(null, null, `必須列がありません：${missing.join(', ')}`));
    return fail();
  }
  const dupCols = cols.filter((c, i) => cols.indexOf(c) !== i);
  if (dupCols.length > 0) {
    issues.push(err(null, null, `列名が重複しています：${[...new Set(dupCols)].join(', ')}`));
    return fail();
  }
  if (body.length === 0) {
    issues.push(err(null, null, 'データ行がありません'));
    return fail();
  }
  if (body.length > IMPORT_MAX_ROWS) {
    issues.push(err(null, null, `行数が上限の${IMPORT_MAX_ROWS}行を超えています（${body.length}行）。分割してください。`));
    return fail();
  }

  const idx = Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, cols.indexOf(c)])) as Record<ImportColumn, number>;
  const siteSet = new Set(ctx.siteCodes);
  const lines: ParsedLine[] = [];
  const seenKeys = new Map<string, number>();

  body.forEach((cells, i) => {
    const row = i + 1;
    if (cells.length !== header.length) {
      issues.push(err(row, null, `列数が${cells.length}です（ヘッダは${header.length}列）。区切りや引用符を確認してください。`));
      return;
    }
    const v = (c: ImportColumn) => cells[idx[c]] ?? '';
    let rowOk = true;
    for (const c of IMPORT_COLUMNS) {
      const val = v(c);
      if (val.trim() === '') {
        issues.push(err(row, c, val === '' ? '必須項目が空です' : '空白だけの値は使えません'));
        rowOk = false;
        continue;
      }
      if ([...val].length > MAX_LEN[c] && c !== 'qty_out') {
        issues.push(err(row, c, `${MAX_LEN[c]}字以内にしてください（${[...val].length}字）`));
        rowOk = false;
      }
      if (val !== val.trim()) {
        issues.push(warn(row, c, `前後に空白があります。原文のまま保存します。不要なら元ファイルで「${val.trim()}」に直してください。`));
      }
    }
    const qtyRaw = v('qty_out');
    let qty = NaN;
    if (/[０-９]/.test(qtyRaw)) {
      issues.push(err(row, 'qty_out', `全角数字は使えません。半角整数にしてください（例：「${qtyRaw.normalize('NFKC')}」）`));
      rowOk = false;
    } else if (/^-\d+$/.test(qtyRaw)) {
      issues.push(err(row, 'qty_out', '負の数は使えません（1～9999）'));
      rowOk = false;
    } else if (/^\d+$/.test(qtyRaw)) {
      qty = Number(qtyRaw);
      if (qtyRaw.length > 4 || qty < 1 || qty > 9999) {
        issues.push(err(row, 'qty_out', '1～9999の半角整数にしてください（桁数超過または0）'));
        rowOk = false;
      }
    } else if (qtyRaw.trim() !== '') {
      issues.push(err(row, 'qty_out', '半角整数のみ使えます（小数・記号・単位は不可、例：10）'));
      rowOk = false;
    }
    const due = v('due_at');
    let dueIso = '';
    if (due.trim() !== '') {
      if (!ISO_WITH_TZ.test(due) || Number.isNaN(new Date(due).getTime())) {
        issues.push(err(row, 'due_at', 'タイムゾーン付きISO8601にしてください（例：2026-10-16T17:00:00+09:00）'));
        rowOk = false;
      } else {
        dueIso = new Date(due).toISOString();
      }
    }
    const site = v('site_code');
    if (site.trim() !== '' && !siteSet.has(site)) {
      issues.push(err(row, 'site_code', `未登録の拠点コードです：「${site}」`));
      rowOk = false;
    }
    const key = `${v('source_system')}\u0000${v('rental_id')}\u0000${v('line_id')}`;
    const prev = seenKeys.get(key);
    if (prev !== undefined) {
      issues.push(err(row, 'line_id', `${prev}行目と同じ（source_system, rental_id, line_id）が重複しています`));
      rowOk = false;
    } else {
      seenKeys.set(key, row);
    }
    if (!rowOk) return;
    lines.push({
      row,
      sourceSystem: v('source_system'),
      rentalId: v('rental_id'),
      lineId: v('line_id'),
      siteCode: site,
      customerLabel: v('customer_label'),
      dueAt: dueIso,
      itemCode: v('item_code'),
      itemName: v('item_name'),
      unit: v('unit'),
      qtyOut: qty,
    });
  });

  // 同一貸出は同じ顧客・拠点・返却予定を持つ。
  const rentals = new Map<string, ParsedRental>();
  for (const l of lines) {
    const k = `${l.sourceSystem}\u0000${l.rentalId}`;
    const r = rentals.get(k);
    if (!r) {
      rentals.set(k, {
        sourceSystem: l.sourceSystem,
        rentalId: l.rentalId,
        siteCode: l.siteCode,
        customerLabel: l.customerLabel,
        dueAt: l.dueAt,
        lines: [l],
      });
      continue;
    }
    if (r.customerLabel !== l.customerLabel || r.siteCode !== l.siteCode || r.dueAt !== l.dueAt) {
      issues.push(err(l.row, 'rental_id', `同じ貸出（${l.rentalId}）で顧客・拠点・返却予定が${r.lines[0]!.row}行目と異なります`));
      continue;
    }
    r.lines.push(l);
  }

  // 既存データとの差分。ファイルにない案件は削除しない。
  const bySource = new Map(ctx.existing.map((e) => [`${e.sourceSystem}\u0000${e.externalRentalIdOriginal}`, e]));
  const diffs: RentalDiff[] = [];
  for (const [k, r] of rentals) {
    const ex = bySource.get(k);
    if (!ex) {
      const similar = ctx.existing.find(
        (e) => e.sourceSystem === r.sourceSystem && e.externalRentalIdSearch === searchKey(r.rentalId),
      );
      if (similar) {
        issues.push(
          warn(
            r.lines[0]!.row,
            'rental_id',
            `「${r.rentalId}」は既存の「${similar.externalRentalIdOriginal}」と全半角等だけが異なります。別の貸出として追加し、自動統合しません。`,
          ),
        );
      }
      diffs.push({ kind: 'add', key: k, rental: r, existingId: null, expectedVersion: null, changes: [] });
      continue;
    }
    const changes: string[] = [];
    if (ex.customerLabelOriginal !== r.customerLabel) changes.push(`顧客表示名：${ex.customerLabelOriginal} → ${r.customerLabel}`);
    if (ex.siteCode !== r.siteCode) changes.push(`拠点：${ex.siteCode} → ${r.siteCode}`);
    if (ex.dueAt !== r.dueAt) changes.push('返却予定日時が変わります');
    const exLines = new Map(ex.lines.map((l) => [l.externalLineIdOriginal, l]));
    let qtyChanged = false;
    for (const l of r.lines) {
      const el = exLines.get(l.lineId);
      if (!el) {
        changes.push(`明細追加：${l.lineId} ${l.itemName} ×${l.qtyOut}`);
        qtyChanged = true;
        continue;
      }
      if (el.qtyOut !== l.qtyOut) {
        changes.push(`貸出数：${l.lineId} ${el.qtyOut} → ${l.qtyOut}`);
        qtyChanged = true;
      }
      if (el.itemNameOriginal !== l.itemName) changes.push(`品名：${l.lineId} ${el.itemNameOriginal} → ${l.itemName}`);
      if (el.itemCodeOriginal !== l.itemCode) changes.push(`品目コード：${l.lineId} ${el.itemCodeOriginal} → ${l.itemCode}`);
      if (el.unitOriginal !== l.unit) changes.push(`単位：${l.lineId} ${el.unitOriginal} → ${l.unit}`);
    }
    if (changes.length === 0) {
      diffs.push({ kind: 'unchanged', key: k, rental: r, existingId: ex.id, expectedVersion: ex.version, changes });
      continue;
    }
    if (ex.status !== 'open') {
      issues.push(err(r.lines[0]!.row, 'rental_id', `貸出「${r.rentalId}」は完了または取消済みのため取込で変更できません`));
    } else if (ex.hasReceipts && qtyChanged) {
      issues.push(
        err(
          r.lines[0]!.row,
          'qty_out',
          `貸出「${r.rentalId}」は返却記録があるため、取込で数量・明細を変更できません。管理者が理由を入れて数量変更してください。`,
        ),
      );
    }
    diffs.push({ kind: 'change', key: k, rental: r, existingId: ex.id, expectedVersion: ex.version, changes });
  }

  const ok = !issues.some((i) => i.severity === 'error');
  return {
    sha256: sha,
    rowCount: body.length,
    issues: issues.sort((a, b) => (a.row ?? 0) - (b.row ?? 0)),
    diffs,
    ok,
    summary: {
      added: diffs.filter((d) => d.kind === 'add').length,
      changed: diffs.filter((d) => d.kind === 'change').length,
      unchanged: diffs.filter((d) => d.kind === 'unchanged').length,
    },
  };
}
