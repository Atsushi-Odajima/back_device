import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateImport } from '../../src/domain/csvImport';
import { neutralizeCell, toCsv } from '../../src/domain/csvExport';
import { lineQuantities, parseQtyField, checkReceiptInput } from '../../src/domain/quantity';
import { checkDecision, transitionCheck } from '../../src/domain/issueRules';
import { sha256Hex } from '../../src/domain/sha256';
import { searchKey } from '../../src/domain/searchKey';
import { jpegSize, acceptInputFile } from '../../src/domain/photo';
import { buildZip, crc32 } from '../../src/domain/zip';
import { tinyJpeg } from './helpers';

const sample = (n: string) => new Uint8Array(readFileSync(resolve(process.cwd(), 'samples', n)));
const ctx = { siteCodes: ['HQ'], existing: [] };

describe('CSV取込の検証', () => {
  it('正常ファイルは全行OK、差分は追加のみ', () => {
    const v = validateImport(sample('rentals_normal.csv'), ctx);
    expect(v.ok).toBe(true);
    expect(v.summary).toEqual({ added: 2, changed: 0, unchanged: 0 });
  });

  it('CP932 は拒否して CSV UTF-8 を案内', () => {
    const v = validateImport(sample('rentals_cp932.csv'), ctx);
    expect(v.ok).toBe(false);
    expect(v.issues[0]!.message).toContain('CSV UTF-8');
  });

  it('BOMあり UTF-8 を受け付ける', () => {
    expect(validateImport(sample('rentals_fullwidth.csv'), ctx).ok).toBe(true);
  });

  it('重複キーを行番号付きで検出', () => {
    const v = validateImport(sample('rentals_duplicate.csv'), ctx);
    expect(v.ok).toBe(false);
    expect(v.issues).toContainEqual(expect.objectContaining({ row: 2, column: 'line_id', severity: 'error' }));
  });

  it('全角数字のエラーは修正例を示す', () => {
    const v = validateImport(sample('rentals_error_one_row.csv'), ctx);
    const e = v.issues.find((i) => i.severity === 'error')!;
    expect(e.row).toBe(2);
    expect(e.message).toContain('10');
  });

  it('未知拠点・不正日時・負数・過大桁・空白のみ・空・前後空白（警告）', () => {
    const v = validateImport(sample('rentals_errors_many.csv'), ctx);
    const byRow = (r: number) => v.issues.filter((i) => i.row === r);
    expect(byRow(1)[0]!.column).toBe('site_code');
    expect(byRow(2)[0]!.column).toBe('due_at');
    expect(byRow(3)[0]!.message).toContain('負');
    expect(byRow(4)[0]!.column).toBe('qty_out');
    expect(byRow(5)[0]!.message).toContain('空白');
    expect(byRow(6)[0]!.message).toContain('空');
    expect(byRow(7)[0]!.severity).toBe('warning');
    expect(v.ok).toBe(false);
  });

  it('長名（120字・160字）は受け付ける', () => {
    expect(validateImport(sample('rentals_long_names.csv'), ctx).ok).toBe(true);
  });

  it('検索キーだけ一致する既存は警告して統合しない', () => {
    const v = validateImport(sample('rentals_fullwidth.csv'), {
      siteCodes: ['HQ'],
      existing: [
        {
          id: 'x',
          sourceSystem: 'DEMO-RENT',
          externalRentalIdOriginal: 'R-101',
          externalRentalIdSearch: 'r-101',
          customerLabelOriginal: 'ABC',
          siteCode: 'HQ',
          dueAt: '2026-10-22T00:00:00.000Z',
          version: 1,
          hasReceipts: false,
          status: 'open',
          lines: [],
        },
      ],
    });
    expect(v.ok).toBe(true);
    expect(v.summary.added).toBe(1);
    expect(v.issues.some((i) => i.severity === 'warning' && i.message.includes('自動統合しません'))).toBe(true);
  });
});

describe('CSV出力', () => {
  it('数式の起点を無害化し、数値は変えない', () => {
    expect(neutralizeCell('=1+1')).toBe("'=1+1");
    expect(neutralizeCell('+81')).toBe("'+81");
    expect(neutralizeCell('-x')).toBe("'-x");
    expect(neutralizeCell('@a')).toBe("'@a");
    expect(neutralizeCell('\tx')).toBe("'\tx");
    expect(neutralizeCell('通常')).toBe('通常');
    const csv = toCsv(['a', 'b'], [['a,"b"', -5]]);
    expect(csv).toBe('﻿a,b\r\n"a,""b""",-5\r\n');
  });
});

describe('数量', () => {
  it('空欄は0として確定しない／全角は拒否', () => {
    expect(parseQtyField('')).toEqual({ value: null, error: null });
    expect(parseQtyField('８').error).toContain('半角');
    expect(parseQtyField('12345').error).not.toBeNull();
    expect(parseQtyField('8').value).toBe(8);
  });

  it('取消反転された返却は数えない', () => {
    const q = lineQuantities(
      { id: 'L', qtyOut: 10 },
      [
        { id: 'r1', status: 'reversed', reversalOf: null } as never,
        { id: 'r2', status: 'valid', reversalOf: 'r1' } as never,
        { id: 'r3', status: 'valid', reversalOf: null } as never,
      ],
      [
        { receiptId: 'r1', rentalLineId: 'L', qtyReceived: 8, qtyDamaged: 1 } as never,
        { receiptId: 'r3', rentalLineId: 'L', qtyReceived: 7, qtyDamaged: 0 } as never,
      ],
      [{ lineId: 'L', qtyLost: 1, reversedAt: null } as never],
    );
    expect(q).toMatchObject({ returned: 7, lost: 1, outstanding: 2, damaged: 0 });
  });

  it('上限超過は「残り○脚まで」', () => {
    const p = checkReceiptInput(
      [{ rentalLineId: 'L', qtyReceived: 3, qtyDamaged: 0 }],
      new Map([['L', { lineId: 'L', qtyOut: 10, returned: 8, lost: 0, outstanding: 2, damaged: 0 }]]),
      () => '脚',
    );
    expect(p[0]!.message).toBe('未返却は残り2脚までです');
  });
});

describe('状態遷移と判断', () => {
  it('operator は承認できない／closed の再開は admin のみ', () => {
    expect(transitionCheck('approve', 'review_pending', 'operator').ok).toBe(false);
    expect(transitionCheck('reopen', 'closed', 'reviewer').ok).toBe(false);
    expect(transitionCheck('reopen', 'closed', 'admin').ok).toBe(true);
    expect(transitionCheck('ack_close', 'review_pending', 'reviewer').ok).toBe(false);
  });

  it('請求なし=0円、請求候補=1円以上', () => {
    const base = { resolutionCode: 'repair' as const, decisionReason: 'x' };
    expect(checkDecision({ ...base, billingAction: 'no_charge', chargeCandidateYen: 100 }, { hasActiveLoss: false })).not.toHaveLength(0);
    expect(checkDecision({ ...base, billingAction: 'charge_candidate', chargeCandidateYen: 0 }, { hasActiveLoss: false })).not.toHaveLength(0);
    expect(checkDecision({ ...base, billingAction: 'charge_candidate', chargeCandidateYen: 3000 }, { hasActiveLoss: false })).toHaveLength(0);
  });
});

describe('ユーティリティ', () => {
  it('sha256 既知値', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('検索キーは NFKC＋小文字。原文とは別', () => {
    expect(searchKey('Ｒ－００１')).toBe('r-001');
    expect(searchKey('株式会社ＡＢＣ')).toBe('株式会社abc');
  });
  it('JPEG 寸法と入力拒否', () => {
    expect(jpegSize(tinyJpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(acceptInputFile({ type: 'image/svg+xml', size: 10, name: 'a.svg' })).not.toBeNull();
    expect(acceptInputFile({ type: 'application/pdf', size: 10, name: 'a.pdf' })).not.toBeNull();
    expect(acceptInputFile({ type: 'image/jpeg', size: 11 * 1024 * 1024, name: 'a.jpg' })).not.toBeNull();
    expect(acceptInputFile({ type: 'image/jpeg', size: 1000, name: 'a.jpg' })).toBeNull();
  });
  it('ZIP の構造', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const z = buildZip([{ path: 'a.txt', data: 'hello' }]);
    expect([z[0], z[1], z[2], z[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
