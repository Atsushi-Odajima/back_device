// 受入条件（仕様16）のうち Stage A のモック範囲：AC01～05、08～10、12。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sample = (name: string) => new Uint8Array(readFileSync(resolve(process.cwd(), 'samples', name)));
import Papa from 'papaparse';
import { uuid } from '../../src/domain/ids';
import { sha256Hex } from '../../src/domain/sha256';
import { RepoError } from '../../src/domain/errors';
import { repoAs, serverWithChairs10, tinyJpeg, USERS } from './helpers';
import type { DemoRepository } from '../../src/data/demo/demoRepository';

async function lineQ(repo: DemoRepository, rentalId: string) {
  const d = await repo.getRental(rentalId);
  return d.lines[0]!.q;
}

async function submit(repo: DemoRepository, rentalId: string, lineId: string, qty: number, dmg: number, opId = uuid()) {
  const d = await repo.getRental(rentalId);
  return repo.submitReceipt(opId, {
    rentalId,
    expectedVersion: d.rental.version,
    lines: [{ rentalLineId: lineId, qtyReceived: qty, qtyDamaged: dmg, checklist: {} }],
    memo: '',
  });
}

async function attachPhoto(repo: DemoRepository, issueId: string) {
  const bytes = tinyJpeg();
  const { attachmentId } = await repo.createAttachment(uuid(), {
    issueId,
    receiptLineId: null,
    byteSize: bytes.length,
    mime: 'image/jpeg',
    imageWidth: 8,
    imageHeight: 8,
    sha256: sha256Hex(bytes),
  });
  await repo.uploadAttachment(attachmentId, bytes);
}

describe('AC01 数量：貸出10・返却8・破損1', () => {
  it('累計返却8、未返却2、破損1（7や9にならない）', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const repo = await repoAs(USERS.op1, server);
    const r = await submit(repo, rentalId, lineId, 8, 1);
    const q = await lineQ(repo, rentalId);
    expect(q).toMatchObject({ qtyOut: 10, returned: 8, outstanding: 2, damaged: 1, lost: 0 });
    expect(q.returned + q.outstanding).toBe(10);
    const issues = (await repo.getRental(rentalId)).issues;
    expect(issues.filter((i) => i.kind === 'missing')).toHaveLength(1);
    expect(issues.find((i) => i.kind === 'missing')!.qty).toBe(2);
    expect(issues.find((i) => i.kind === 'damage')!.qty).toBe(1);
    expect(r.damageIssueIds[lineId]).toBeDefined();
  });
});

describe('AC02 冪等：同じ operation_id を3回再送', () => {
  it('receipt は1件、返却8のまま', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const repo = await repoAs(USERS.op1, server);
    const op = uuid();
    const body = { rentalId, expectedVersion: 1, lines: [{ rentalLineId: lineId, qtyReceived: 8, qtyDamaged: 1, checklist: {} }], memo: '' };
    const a = await repo.submitReceipt(op, body);
    const b = await repo.submitReceipt(op, body);
    const c = await repo.submitReceipt(op, body);
    expect(b.receiptId).toBe(a.receiptId);
    expect(c.receiptId).toBe(a.receiptId);
    expect(server.db.receipts.filter((x) => x.rentalId === rentalId)).toHaveLength(1);
    expect((await lineQ(repo, rentalId)).returned).toBe(8);
  });

  it('同じIDで異なる内容は 409（idempotency_mismatch）', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const repo = await repoAs(USERS.op1, server);
    const op = uuid();
    await repo.submitReceipt(op, { rentalId, expectedVersion: 1, lines: [{ rentalLineId: lineId, qtyReceived: 8, qtyDamaged: 0, checklist: {} }], memo: '' });
    await expect(
      repo.submitReceipt(op, { rentalId, expectedVersion: 1, lines: [{ rentalLineId: lineId, qtyReceived: 7, qtyDamaged: 0, checklist: {} }], memo: '' }),
    ).rejects.toMatchObject({ code: 'idempotency_mismatch' });
  });
});

describe('AC03 同時更新：残2に対して2ずつの2要求', () => {
  it('片方だけ成功し、合計は10を超えない', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const a = await repoAs(USERS.op1, server);
    const b = await repoAs(USERS.op2, server);
    await submit(a, rentalId, lineId, 8, 0);
    const version = (await a.getRental(rentalId)).rental.version;
    const req = (repo: DemoRepository) =>
      repo.submitReceipt(uuid(), { rentalId, expectedVersion: version, lines: [{ rentalLineId: lineId, qtyReceived: 2, qtyDamaged: 0, checklist: {} }], memo: '' });
    const results = await Promise.allSettled([req(a), req(b)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as RepoError).code).toBe('conflict');
    const q = await lineQ(a, rentalId);
    expect(q.returned).toBe(10);
    expect(q.outstanding).toBe(0);
  });

  it('version が一致していても数量超過はトランザクション全体を拒否', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const a = await repoAs(USERS.op1, server);
    await submit(a, rentalId, lineId, 8, 0);
    await expect(submit(a, rentalId, lineId, 3, 0)).rejects.toMatchObject({ code: 'invariant' });
    expect((await lineQ(a, rentalId)).returned).toBe(8);
  });
});

describe('AC04 全数返却→請求候補3,000円→出力だけでは閉じない→受領・返却反映で完了', () => {
  it('一連の流れ', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const op = await repoAs(USERS.op1, server);
    const rv = await repoAs(USERS.rv, server);
    const r1 = await submit(op, rentalId, lineId, 8, 1);
    const damageId = r1.damageIssueIds[lineId]!;
    await submit(op, rentalId, lineId, 2, 0);
    expect((await lineQ(op, rentalId)).outstanding).toBe(0);

    // 未返却0で missing は確認待ちへ（自動で請求なし・終了にしない）。判断対象数量は2のまま。
    const missing = (await op.getRental(rentalId)).issues.find((i) => i.kind === 'missing')!;
    expect(missing.status).toBe('review_pending');
    expect(missing.qty).toBe(2);
    expect(missing.billingAction).toBeNull();

    // 破損：写真なしでは確認依頼できない
    let dmg = await op.getIssue(damageId);
    await expect(op.submitIssue(uuid(), { issueId: damageId, expectedVersion: dmg.issue.version, action: 'request_review', note: '' })).rejects.toMatchObject({ code: 'validation' });
    await attachPhoto(op, damageId);
    dmg = await op.getIssue(damageId);
    await op.submitIssue(uuid(), { issueId: damageId, expectedVersion: dmg.issue.version, action: 'request_review', note: '' });

    // 承認（operator は不可）
    dmg = await rv.getIssue(damageId);
    const approve = {
      issueId: damageId,
      expectedVersion: dmg.issue.version,
      decision: 'approve' as const,
      resolutionCode: 'repair' as const,
      billingAction: 'charge_candidate' as const,
      chargeCandidateYen: 3000,
      decisionReason: '脚の変形',
    };
    await expect(op.reviewIssue(uuid(), approve)).rejects.toMatchObject({ code: 'forbidden' });
    const { handoffId } = await rv.reviewIssue(uuid(), approve);
    const m = await rv.getIssue(missing.id);
    await rv.reviewIssue(uuid(), {
      issueId: missing.id,
      expectedVersion: m.issue.version,
      decision: 'approve',
      resolutionCode: 'returned',
      billingAction: 'no_charge',
      chargeCandidateYen: 0,
      decisionReason: '後日全数返却',
    });

    // CSV出力
    const { file } = await rv.exportHandoffs(uuid(), { handoffIds: [handoffId!] });
    const text = String(file.data).replace(/^﻿/, '');
    const rows = Papa.parse<string[]>(text.trim()).data;
    expect(rows[0]).toEqual(['rental_id', 'line_id', 'issue_id', 'approved_version', 'item_name', 'qty', 'charge_candidate_yen', 'currency', 'decision_reason']);
    expect(rows[1]).toEqual(['AC-001', '1', damageId, String(dmg.issue.version + 1), '折りたたみ椅子', '1', '3000', 'JPY', '脚の変形']);

    // 出力だけでは閉じない
    expect((await rv.getIssue(damageId)).issue.status).toBe('approved');
    await expect(rv.closeRental(uuid(), { rentalId, expectedVersion: (await rv.getRental(rentalId)).rental.version, externalRef: 'X', noRefReason: '' })).rejects.toMatchObject({ code: 'validation' });

    // 請求候補は外部番号が必須
    await expect(rv.ackHandoff(uuid(), { handoffId: handoffId!, externalRef: '', note: '' })).rejects.toMatchObject({ code: 'validation' });
    await rv.ackHandoff(uuid(), { handoffId: handoffId!, externalRef: 'INV-2026-0001', note: '' });
    const mh = (await rv.listHandoffs()).find((h) => h.issue.id === missing.id)!;
    await expect(rv.ackHandoff(uuid(), { handoffId: mh.handoff.id, externalRef: '', note: '' })).rejects.toMatchObject({ code: 'validation' });
    await rv.ackHandoff(uuid(), { handoffId: mh.handoff.id, externalRef: '', note: '既存ソフトに返却済みで反映。請求なし' });

    // 返却反映確認（外部番号または反映不要理由が必須）
    const v = (await rv.getRental(rentalId)).rental.version;
    await expect(rv.closeRental(uuid(), { rentalId, expectedVersion: v, externalRef: '', noRefReason: '' })).rejects.toMatchObject({ code: 'validation' });
    await rv.closeRental(uuid(), { rentalId, expectedVersion: v, externalRef: 'RET-778', noRefReason: '' });
    const done = await rv.getRental(rentalId);
    expect(done.rental.status).toBe('closed');
    expect(done.rental.externalReturnAckAt).not.toBeNull();
    // 出力時刻と受領時刻は別に記録
    const h = (await rv.listHandoffs()).find((x) => x.handoff.id === handoffId)!.handoff;
    expect(h.exportedAt).not.toBeNull();
    expect(h.ackAt).not.toBeNull();
  });
});

describe('AC05 紛失2の承認後に2が戻る', () => {
  it('紛失反転→返却追加→外部訂正確認。数量は12にならない', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const op = await repoAs(USERS.op1, server);
    const rv = await repoAs(USERS.rv, server);
    const ad = await repoAs(USERS.ad, server);
    await submit(op, rentalId, lineId, 8, 0);
    const missing = (await op.getRental(rentalId)).issues.find((i) => i.kind === 'missing')!;

    // operator は紛失処理不可
    await expect(op.resolveLoss(uuid(), { issueId: missing.id, expectedVersion: missing.version, qtyLost: 2, reason: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    // 未返却を超える紛失は不可
    await expect(rv.resolveLoss(uuid(), { issueId: missing.id, expectedVersion: missing.version, qtyLost: 3, reason: 'x' })).rejects.toMatchObject({ code: 'invariant' });
    await rv.resolveLoss(uuid(), { issueId: missing.id, expectedVersion: missing.version, qtyLost: 2, reason: '会場で紛失と顧客回答' });
    let q = await lineQ(rv, rentalId);
    expect(q).toMatchObject({ returned: 8, lost: 2, outstanding: 0 });

    let m = await rv.getIssue(missing.id);
    expect(m.issue.status).toBe('review_pending');
    const { handoffId } = await rv.reviewIssue(uuid(), {
      issueId: missing.id,
      expectedVersion: m.issue.version,
      decision: 'approve',
      resolutionCode: 'lost',
      billingAction: 'charge_candidate',
      chargeCandidateYen: 6000,
      decisionReason: '紛失2脚',
    });
    await rv.ackHandoff(uuid(), { handoffId: handoffId!, externalRef: 'INV-9', note: '' });

    // 実物が戻った：反転前の返却追加は不変条件で拒否（12にしない）
    await expect(submit(op, rentalId, lineId, 2, 0)).rejects.toMatchObject({ code: 'invariant' });
    // 反転は admin のみ
    const lossId = m.losses[0]!.id;
    await expect(rv.reverseLoss(uuid(), { lossId, reason: '実物が戻った' })).rejects.toMatchObject({ code: 'forbidden' });
    await ad.reverseLoss(uuid(), { lossId, reason: '実物が戻った' });
    m = await ad.getIssue(missing.id);
    expect(m.issue.status).toBe('needs_correction');
    expect(m.issue.externalCorrectionPending).toBe(true);
    // 金額を黙って相殺しない（判断はクリアされ再判断が必要）
    expect(m.issue.billingAction).toBeNull();

    await submit(op, rentalId, lineId, 2, 0);
    q = await lineQ(op, rentalId);
    expect(q).toMatchObject({ qtyOut: 10, returned: 10, lost: 0, outstanding: 0 });

    m = await rv.getIssue(missing.id);
    expect(m.issue.status).toBe('review_pending');
    const re = await rv.reviewIssue(uuid(), {
      issueId: missing.id,
      expectedVersion: m.issue.version,
      decision: 'approve',
      resolutionCode: 'returned',
      billingAction: 'no_charge',
      chargeCandidateYen: 0,
      decisionReason: '紛失扱いを取消。全数返却',
    });
    // 外部訂正の確認（再受領）まで閉じない
    expect((await rv.getIssue(missing.id)).issue.externalCorrectionPending).toBe(true);
    await rv.ackHandoff(uuid(), { handoffId: re.handoffId!, externalRef: 'INV-9-訂正', note: '請求取消を既存ソフトで処理' });
    m = await rv.getIssue(missing.id);
    expect(m.issue.status).toBe('closed');
    expect(m.issue.externalCorrectionPending).toBe(false);
    // 旧版の引き渡しは履歴として残る
    expect(m.handoffs).toHaveLength(2);
  });
});

describe('AC08 CSV取込', () => {
  const read = sample;

  it('不正1行で全体未確定。再取込で重複しない。原文保持・半角検索', async () => {
    const rv = await repoAs(USERS.rv);
    const before = rv.server.db.rentals.length;
    const bad = await rv.validateImport('rentals_error_one_row.csv', read('rentals_error_one_row.csv'));
    expect(bad.validation.ok).toBe(false);
    expect(bad.validation.issues.filter((i) => i.severity === 'error')).toHaveLength(1);
    await expect(rv.commitImport(uuid(), { importId: bad.importId })).rejects.toMatchObject({ code: 'validation' });
    expect(rv.server.db.rentals.length).toBe(before);

    const good = await rv.validateImport('rentals_fullwidth.csv', read('rentals_fullwidth.csv'));
    expect(good.validation.ok).toBe(true);
    await rv.commitImport(uuid(), { importId: good.importId });
    const added = rv.server.db.rentals.length - before;
    expect(added).toBeGreaterThan(0);

    // 同じファイルの再取込は既存結果を返し、重複しない
    const again = await rv.validateImport('rentals_fullwidth.csv', read('rentals_fullwidth.csv'));
    expect(again.reused).toBe(true);
    await rv.commitImport(uuid(), { importId: again.importId });
    expect(rv.server.db.rentals.length - before).toBe(added);

    const r = rv.server.db.rentals.find((x) => x.externalRentalIdOriginal === 'Ｒ－１０１')!;
    expect(r.customerLabelOriginal).toBe('株式会社ＡＢＣ');
    const found = await rv.searchRentals({ query: 'r-101', mode: 'open', ymd: '2000-01-01' });
    expect(found.map((x) => x.rental.externalRentalIdOriginal)).toContain('Ｒ－１０１');
    const byName = await rv.searchRentals({ query: 'abc', mode: 'open', ymd: '2000-01-01' });
    expect(byName.some((x) => x.rental.customerLabelOriginal === '株式会社ＡＢＣ')).toBe(true);
    const line = rv.server.db.rentalLines.find((l) => l.rentalId === r.id)!;
    expect(line.itemCodeOriginal).toBe('Ｒ－００１');
  });

  it('operator は取込できない', async () => {
    const op = await repoAs(USERS.op1);
    await expect(op.validateImport('x.csv', read('rentals_normal.csv'))).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('AC09 CSV数式の無害化', () => {
  it('CSVでは先頭にアポストロフィ、原文JSONは元の文字', async () => {
    const rv = await repoAs(USERS.rv);
    const bytes = sample('rentals_formula.csv');
    const v = await rv.validateImport('rentals_formula.csv', bytes);
    expect(v.validation.ok).toBe(true);
    await rv.commitImport(uuid(), { importId: v.importId });
    const file = await rv.exportRentalsCsv();
    const text = String(file.data);
    expect(text).toContain("'=HYPERLINK(");
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(text).toContain("'@SUM(1+1)");
    const r = rv.server.db.rentals.find((x) => x.customerLabelOriginal.startsWith('=HYPERLINK'))!;
    const json = await rv.exportHistoryJson(r.id);
    expect(JSON.parse(String(json.data)).rental.rental.customerLabelOriginal).toMatch(/^=HYPERLINK\(/);
  });
});

describe('AC10 通信断・タイムアウト・写真失敗', () => {
  it('未到達は保存されず、同じIDで再送できる', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const repo = await repoAs(USERS.op1, server);
    const op = uuid();
    repo.setControls({ nextMutation: 'network' });
    await expect(submit(repo, rentalId, lineId, 8, 0, op)).rejects.toMatchObject({ code: 'network' });
    expect((await repo.lookupOperation(op)).found).toBe(false);
    expect((await lineQ(repo, rentalId)).returned).toBe(0);
    await submit(repo, rentalId, lineId, 8, 0, op);
    expect((await lineQ(repo, rentalId)).returned).toBe(8);
  });

  it('タイムアウト時は成否照会で確定済みを確認でき、再送しても二重にならない', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const repo = await repoAs(USERS.op1, server);
    const op = uuid();
    repo.setControls({ nextMutation: 'timeout' });
    await expect(submit(repo, rentalId, lineId, 8, 0, op)).rejects.toMatchObject({ code: 'timeout' });
    const look = await repo.lookupOperation(op);
    expect(look.found).toBe(true);
    await repo.submitReceipt(op, { rentalId, expectedVersion: 1, lines: [{ rentalLineId: lineId, qtyReceived: 8, qtyDamaged: 0, checklist: {} }], memo: '' });
    expect(server.db.receipts).toHaveLength(1);
  });

  it('写真失敗は pending のまま残り、同じ写真を再送して ready になる', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const repo = await repoAs(USERS.op1, server);
    const r = await submit(repo, rentalId, lineId, 8, 1);
    const bytes = tinyJpeg();
    const { attachmentId } = await repo.createAttachment(uuid(), {
      issueId: r.damageIssueIds[lineId]!,
      receiptLineId: r.receiptLineIds[lineId]!,
      byteSize: bytes.length,
      mime: 'image/jpeg',
      imageWidth: 8,
      imageHeight: 8,
      sha256: sha256Hex(bytes),
    });
    repo.setControls({ nextPhotoFail: true });
    await expect(repo.uploadAttachment(attachmentId, bytes)).rejects.toMatchObject({ code: 'network' });
    expect(server.db.attachments.find((a) => a.id === attachmentId)!.status).toBe('pending');
    await repo.uploadAttachment(attachmentId, bytes);
    expect(server.db.attachments.find((a) => a.id === attachmentId)!.status).toBe('ready');
  });

  it('セッション切れは 401、再ログイン後に同じIDで再提出', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const repo = await repoAs(USERS.op1, server);
    const op = uuid();
    repo.setControls({ sessionExpired: true });
    await expect(submit(repo, rentalId, lineId, 8, 0, op)).rejects.toMatchObject({ code: 'session_expired' });
    await repo.login(USERS.op1, false);
    await repo.submitReceipt(op, { rentalId, expectedVersion: 1, lines: [{ rentalLineId: lineId, qtyReceived: 8, qtyDamaged: 0, checklist: {} }], memo: '' });
    expect((await lineQ(repo, rentalId)).returned).toBe(8);
  });
});

describe('AC12 閉鎖後の訂正', () => {
  it('admin が理由を入れて再開。旧版・理由・行為者が残り、事務の再確認が必要', async () => {
    const op = await repoAs(USERS.op1);
    const rv = await repoAs(USERS.rv, op.server);
    const ad = await repoAs(USERS.ad, op.server);
    const row = (await rv.listHandoffs()).find((h) => h.rentalNumber === 'R-006')!;
    await rv.ackHandoff(uuid(), { handoffId: row.handoff.id, externalRef: 'INV-6', note: '' });
    const rentalId = row.issue.rentalId;
    await rv.closeRental(uuid(), { rentalId, expectedVersion: (await rv.getRental(rentalId)).rental.version, externalRef: 'RET-6', noRefReason: '' });

    const closed = await rv.getIssue(row.issue.id);
    await expect(rv.reopenIssue(uuid(), { issueId: row.issue.id, expectedVersion: closed.issue.version, reason: '金額誤り' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(ad.reopenIssue(uuid(), { issueId: row.issue.id, expectedVersion: closed.issue.version, reason: '' })).rejects.toMatchObject({ code: 'validation' });
    await ad.reopenIssue(uuid(), { issueId: row.issue.id, expectedVersion: closed.issue.version, reason: '金額誤り（2,000円が正）' });

    const reopened = await ad.getIssue(row.issue.id);
    expect(reopened.issue.status).toBe('needs_correction');
    expect(reopened.issue.externalCorrectionPending).toBe(true);
    expect(reopened.handoffs[0]!.ackAt).not.toBeNull(); // 旧版は残る
    const rental = await ad.getRental(rentalId);
    expect(rental.rental.status).toBe('open');
    expect(rental.rental.externalReturnAckAt).toBeNull();

    const hist = await ad.getHistory(rentalId);
    const reopen = hist.find((h) => h.title.startsWith('完了後に再開'))!;
    expect(reopen.actorName).toBe('管理者（架空）');
    const ev = reopened.events.find((e) => e.eventType === 'reopen')!;
    expect(ev.note).toContain('金額誤り');

    // 監査ログはクライアント用 API に削除手段がない
    const repoApi = Object.getOwnPropertyNames(Object.getPrototypeOf(ad)).concat(Object.keys(ad));
    expect(repoApi.some((k) => /delete.*audit|audit.*delete/i.test(k))).toBe(false);
  });

  it('返却記録の訂正は取消反転＋新記録。承認済みがあれば先に再開が必要', async () => {
    const { server, rentalId, lineId } = serverWithChairs10();
    const op = await repoAs(USERS.op1, server);
    const rv = await repoAs(USERS.rv, server);
    const r = await submit(op, rentalId, lineId, 8, 0);
    const v = (await rv.getRental(rentalId)).rental.version;
    await expect(op.correctReceipt(uuid(), { receiptId: r.receiptId, rentalExpectedVersion: v, reason: '数え間違い', lines: [] })).rejects.toMatchObject({ code: 'forbidden' });
    await rv.correctReceipt(uuid(), { receiptId: r.receiptId, rentalExpectedVersion: v, reason: '数え間違い', lines: [{ rentalLineId: lineId, qtyReceived: 7, qtyDamaged: 0 }] });
    const d = await rv.getRental(rentalId);
    expect(d.lines[0]!.q).toMatchObject({ returned: 7, outstanding: 3 });
    expect(d.receipts.find((x) => x.id === r.receiptId)!.status).toBe('reversed');
    expect(d.receipts.some((x) => x.reversalOf === r.receiptId)).toBe(true);
    expect(d.issues.find((i) => i.kind === 'missing')!.qty).toBe(3);
  });
});

describe('権限と組織分離（デモ範囲。実環境の AC06/07 は Stage B ゲート）', () => {
  it('operator は承認・出力・メンバー変更・全データ返却ができない', async () => {
    const op = await repoAs(USERS.op1);
    const row = (await op.listHandoffs())[0]!;
    await expect(op.exportHandoffs(uuid(), { handoffIds: [row.handoff.id] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(op.stopMember(uuid(), { userId: USERS.op2, reassignTo: USERS.op1 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(op.exportDataReturn()).rejects.toMatchObject({ code: 'forbidden' });
    await expect(op.ackHandoff(uuid(), { handoffId: row.handoff.id, externalRef: 'x', note: '' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('別組織のIDを指定しても取得できない', async () => {
    const other = await repoAs(USERS.other);
    const demoRental = other.server.db.rentals.find((r) => r.externalRentalIdOriginal === 'R-005')!;
    await expect(other.getRental(demoRental.id)).rejects.toMatchObject({ code: 'not_found' });
    const att = other.server.db.attachments.find((a) => a.status === 'ready')!;
    await expect(other.getPhoto(att.id)).rejects.toMatchObject({ code: 'not_found' });
    const list = await other.listRentalsForDate(new Date().toISOString().slice(0, 10));
    expect(list.every((s) => s.rental.orgId === other.currentSession()!.orgId)).toBe(true);
  });

  it('担当停止で未処理案件が再割当され、停止ユーザーの既存セッションは拒否', async () => {
    const op = await repoAs(USERS.op1);
    const ad = await repoAs(USERS.ad, op.server);
    const owned = (await ad.listIssues()).filter((r) => r.issue.ownerUserId === USERS.op1 && r.issue.status !== 'closed');
    expect(owned.length).toBeGreaterThan(0);
    await expect(ad.stopMember(uuid(), { userId: USERS.op1, reassignTo: null })).rejects.toMatchObject({ code: 'validation' });
    const res = await ad.stopMember(uuid(), { userId: USERS.op1, reassignTo: USERS.op2 });
    expect(res.reassigned).toBe(owned.length);
    await expect(op.listIssues()).rejects.toMatchObject({ code: 'forbidden' });
    await expect(ad.stopMember(uuid(), { userId: USERS.ad, reassignTo: USERS.rv })).rejects.toMatchObject({ code: 'validation' });
  });
});
