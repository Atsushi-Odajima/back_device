// 架空データ（展示サンプル社）。実在の会社・人物とは関係ない。
// 一貫性を保つため、初期状態もサーバーの更新処理を通して作る。
import { uuid } from '../../domain/ids';
import { decodeB64 } from '../../domain/base64';
import { searchKey } from '../../domain/searchKey';
import { sha256Hex } from '../../domain/sha256';
import { addDays, tokyoDate, tokyoToIso } from '../../domain/time';
import { jpegSize } from '../../domain/photo';
import type { Member, Rental, RentalLine } from '../../domain/types';
import { DemoServer, emptyDb } from './demoServer';
import { SAMPLE_PHOTO_A, SAMPLE_PHOTO_B } from './samplePhotos';

export const DEMO_ORG_ID = '0a000000-0000-4000-8000-000000000001';
export const OTHER_ORG_ID = '0b000000-0000-4000-8000-000000000002';
export const SITE_ID = '0a000000-0000-4000-8000-0000000000a1';
export const USERS = {
  op1: '0a000000-0000-4000-8000-000000000011',
  op2: '0a000000-0000-4000-8000-000000000012',
  rv: '0a000000-0000-4000-8000-000000000021',
  ad: '0a000000-0000-4000-8000-000000000031',
  other: '0b000000-0000-4000-8000-000000000041',
} as const;
export const SOURCE_SYSTEM = 'DEMO-RENT';

export { decodeB64 };

interface LineSpec {
  code: string;
  name: string;
  unit: string;
  qty: number;
}

export function createSeededServer(now: Date = new Date()): DemoServer {
  const db = emptyDb();
  const today = tokyoDate(now);
  const createdAt = new Date(now.getTime() - 3 * 86400_000).toISOString();
  db.orgs.push(
    { id: DEMO_ORG_ID, nameOriginal: '展示サンプル社', timezone: 'Asia/Tokyo', status: 'active', storageLimitBytes: 5 * 1024 ** 3, createdAt },
    { id: OTHER_ORG_ID, nameOriginal: '別テスト組織（越境確認用）', timezone: 'Asia/Tokyo', status: 'active', storageLimitBytes: 1024 ** 3, createdAt },
  );
  const member = (orgId: string, userId: string, displayName: string, role: Member['role']): Member => ({
    orgId,
    userId,
    displayName,
    role,
    active: true,
    joinedAt: createdAt,
  });
  db.members.push(
    member(DEMO_ORG_ID, USERS.op1, '返却担当A（架空）', 'operator'),
    member(DEMO_ORG_ID, USERS.op2, '返却担当B（架空）', 'operator'),
    member(DEMO_ORG_ID, USERS.rv, 'テスト事務', 'reviewer'),
    member(DEMO_ORG_ID, USERS.ad, '管理者（架空）', 'admin'),
    member(OTHER_ORG_ID, USERS.other, '別組織ユーザー（架空）', 'admin'),
  );
  db.sites.push(
    { id: SITE_ID, orgId: DEMO_ORG_ID, code: 'HQ', nameOriginal: '本社倉庫（サンプル）', active: true },
    { id: uuid(), orgId: OTHER_ORG_ID, code: 'HQ', nameOriginal: '別組織倉庫', active: true },
  );
  db.settings.push(
    {
      orgId: DEMO_ORG_ID,
      version: 1,
      checklist: [
        { id: 'clean', label: '汚れなし' },
        { id: 'parts', label: '部品・付属品そろい' },
        { id: 'works', label: '開閉・動作確認' },
      ],
    },
    { orgId: OTHER_ORG_ID, version: 1, checklist: [] },
  );

  const addRental = (orgId: string, siteId: string, rentalNo: string, customer: string, dueAt: string, lines: LineSpec[]) => {
    const r: Rental = {
      id: uuid(),
      orgId,
      siteId,
      sourceSystem: SOURCE_SYSTEM,
      externalRentalIdOriginal: rentalNo,
      externalRentalIdSearch: searchKey(rentalNo),
      customerLabelOriginal: customer,
      customerLabelSearch: searchKey(customer),
      dueAt,
      status: 'open',
      version: 1,
      externalReturnAckAt: null,
      externalReturnRef: null,
      externalReturnNoRefReason: null,
      createdAt,
    };
    db.rentals.push(r);
    const ls: RentalLine[] = lines.map((l, i) => ({
      id: uuid(),
      orgId,
      rentalId: r.id,
      externalLineIdOriginal: String(i + 1),
      itemCodeOriginal: l.code,
      itemNameOriginal: l.name,
      unitOriginal: l.unit,
      qtyOut: l.qty,
      version: 1,
    }));
    db.rentalLines.push(...ls);
    return { rental: r, lines: ls };
  };

  const at = (dayOffset: number, hhmm: string) => tokyoToIso(addDays(today, dayOffset), hhmm);
  const chair = { code: 'CH-01', name: '折りたたみ椅子', unit: '脚' };

  addRental(DEMO_ORG_ID, SITE_ID, 'R-001', 'サンプル企画（架空）', at(0, '10:00'), [
    { ...chair, qty: 10 },
    { code: 'TB-18', name: '長机（1800）', unit: '台', qty: 5 },
  ]);
  addRental(DEMO_ORG_ID, SITE_ID, 'R-002', 'テスト展示会事務局（架空）', at(0, '13:00'), [
    { code: 'TN-33', name: 'テント（3×3）', unit: '張', qty: 2 },
    { code: 'WT-10', name: 'テント用ウェイト', unit: '個', qty: 8 },
  ]);
  addRental(DEMO_ORG_ID, SITE_ID, 'R-003', '架空イベント合同会社', at(0, '16:30'), [
    { code: 'CH-02', name: 'パイプ椅子', unit: '脚', qty: 30 },
    { code: 'PD-01', name: '演台', unit: '台', qty: 1 },
  ]);
  const r4 = addRental(DEMO_ORG_ID, SITE_ID, 'R-004', '株式会社ＡＢＣ（架空）', at(-1, '15:00'), [{ ...chair, qty: 20 }]);
  const r5 = addRental(DEMO_ORG_ID, SITE_ID, 'R-005', 'サンプル音響（架空）', at(-1, '11:00'), [
    { code: 'SP-01', name: 'スピーカー', unit: '台', qty: 4 },
  ]);
  const r6 = addRental(DEMO_ORG_ID, SITE_ID, 'R-006', 'テスト学園祭実行委員会（架空）', at(-2, '17:00'), [
    { code: 'TB-12', name: 'テーブル（1200）', unit: '台', qty: 6 },
  ]);
  addRental(DEMO_ORG_ID, SITE_ID, 'Ｒ－００７', '架空ホール運営', at(1, '10:00'), [
    { code: 'ＰＴ－０１', name: 'パーテーション', unit: '枚', qty: 12 },
  ]);
  const r8 = addRental(DEMO_ORG_ID, SITE_ID, 'R-008', 'サンプル町内会（架空）', at(-1, '18:00'), [{ ...chair, qty: 6 }]);
  const r9 = addRental(DEMO_ORG_ID, SITE_ID, 'R-009', 'テスト写真スタジオ（架空）', at(0, '09:00'), [
    { code: 'LT-01', name: '照明スタンド', unit: '本', qty: 4 },
  ]);
  addRental(OTHER_ORG_ID, db.sites[1]!.id, 'X-900', '別組織の顧客（越境確認用）', at(0, '12:00'), [
    { code: 'X-1', name: '別組織の備品', unit: '個', qty: 3 },
  ]);

  // ---- 更新処理を通して状態を作る ----
  const server = new DemoServer(db, () => now);
  let clock = new Date(now.getTime() - 2 * 86400_000);
  server.clock = () => clock;
  const as = <T>(userId: string, name: string, body: unknown, fn: Parameters<DemoServer['mutate']>[5]) =>
    server.mutate(userId, DEMO_ORG_ID, name, uuid(), body, fn) as T;
  const rentalOf = (id: string) => server.db.rentals.find((r) => r.id === id)!;
  const receipt = (userId: string, r: { rental: Rental; lines: RentalLine[] }, qty: number, dmg: number) =>
    as<{ receiptLineIds: Record<string, string>; damageIssueIds: Record<string, string> }>(userId, 'seed_receipt', {}, (ctx) =>
      server.submitReceipt(ctx, {
        rentalId: r.rental.id,
        expectedVersion: rentalOf(r.rental.id).version,
        lines: [{ rentalLineId: r.lines[0]!.id, qtyReceived: qty, qtyDamaged: dmg, checklist: { clean: dmg === 0, parts: true, works: dmg === 0 } }],
        memo: dmg > 0 ? '脚部の変形あり（サンプル）' : '',
      }),
    );
  const photo = (userId: string, issueId: string, receiptLineId: string, b64: string) => {
    const bytes = decodeB64(b64);
    const size = jpegSize(bytes)!;
    const { attachmentId } = as<{ attachmentId: string }>(userId, 'seed_attach', {}, (ctx) =>
      server.createAttachment(ctx, {
        issueId,
        receiptLineId,
        byteSize: bytes.length,
        mime: 'image/jpeg',
        imageWidth: size.width,
        imageHeight: size.height,
        sha256: sha256Hex(bytes),
      }),
    );
    server.uploadAttachment(userId, DEMO_ORG_ID, attachmentId, bytes);
  };
  const issueOf = (id: string) => server.db.issues.find((i) => i.id === id)!;

  // R-004：20脚中18脚返却、2脚未返却（期限超過の不足）
  receipt(USERS.op1, r4, 18, 0);

  // R-005：4台返却、うち破損1台 → 確認待ち
  const p5 = receipt(USERS.op2, r5, 4, 1);
  const d5 = p5.damageIssueIds[r5.lines[0]!.id]!;
  photo(USERS.op2, d5, p5.receiptLineIds[r5.lines[0]!.id]!, SAMPLE_PHOTO_A);
  as(USERS.op2, 'seed_submit', {}, (ctx) =>
    server.submitIssue(ctx, { issueId: d5, expectedVersion: issueOf(d5).version, action: 'request_review', note: '天板の割れ1台。顧客へ電話済み（サンプル）' }),
  );

  // R-006：6台返却、うち破損1台 → 承認済み（請求候補 3,000円）・事務未受領
  const p6 = receipt(USERS.op1, r6, 6, 1);
  const d6 = p6.damageIssueIds[r6.lines[0]!.id]!;
  photo(USERS.op1, d6, p6.receiptLineIds[r6.lines[0]!.id]!, SAMPLE_PHOTO_B);
  as(USERS.op1, 'seed_submit', {}, (ctx) =>
    server.submitIssue(ctx, { issueId: d6, expectedVersion: issueOf(d6).version, action: 'request_review', note: '' }),
  );
  clock = new Date(now.getTime() - 1 * 86400_000);
  as(USERS.rv, 'seed_review', {}, (ctx) =>
    server.reviewIssue(ctx, {
      issueId: d6,
      expectedVersion: issueOf(d6).version,
      decision: 'approve',
      resolutionCode: 'repair',
      billingAction: 'charge_candidate',
      chargeCandidateYen: 3000,
      decisionReason: '天板の欠け。修理費の請求候補（サンプル）',
    }),
  );

  // R-008：破損1脚・写真不鮮明で差し戻し
  const p8 = receipt(USERS.op1, r8, 6, 1);
  const d8 = p8.damageIssueIds[r8.lines[0]!.id]!;
  photo(USERS.op1, d8, p8.receiptLineIds[r8.lines[0]!.id]!, SAMPLE_PHOTO_A);
  as(USERS.op1, 'seed_submit', {}, (ctx) =>
    server.submitIssue(ctx, { issueId: d8, expectedVersion: issueOf(d8).version, action: 'request_review', note: '' }),
  );
  as(USERS.rv, 'seed_review', {}, (ctx) =>
    server.reviewIssue(ctx, {
      issueId: d8,
      expectedVersion: issueOf(d8).version,
      decision: 'send_back',
      resolutionCode: null,
      billingAction: null,
      chargeCandidateYen: null,
      decisionReason: '破損箇所が写っていません。脚の付け根をもう1枚撮影してください（サンプル）',
    }),
  );

  // R-009：全数返却・例外なし → 事務の返却反映確認待ち
  clock = new Date(now.getTime() - 2 * 3600_000);
  receipt(USERS.op2, r9, 4, 0);

  server.clock = () => new Date();
  return server;
}
