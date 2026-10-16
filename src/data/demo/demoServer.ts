// Stage A のメモリ内「サーバー」。Stage B の RPC（DBトランザクション）と同じ検査をここで行う。
// - 各更新はスナップショット上で実行し、例外時は全体を破棄する（トランザクション相当）。
// - operation_id と要求ハッシュを mutation_keys に同一トランザクションで保存する。
// - 権限は毎回 membership（active）から判定する。
// 再読込で全て初期化される。実保存ではない。
import { checkDecision, isUnclosed, transitionCheck, type IssueTransition } from '../../domain/issueRules';
import { checkReceiptInput, invariantHolds, lineQuantities, type LineQuantities } from '../../domain/quantity';
import { RepoError } from '../../domain/errors';
import { uuid } from '../../domain/ids';
import { searchKey } from '../../domain/searchKey';
import { sha256Hex, stableStringify } from '../../domain/sha256';
import { addDays, tokyoDate, tokyoToIso } from '../../domain/time';
import { validateImport, type ExistingRental, type ImportValidation } from '../../domain/csvImport';
import { HANDOFF_CSV_COLUMNS, toCsv, CSV_SAFETY_NOTE } from '../../domain/csvExport';
import { buildZip, type ZipEntry } from '../../domain/zip';
import { PHOTO_MAX_EDGE, PHOTO_MAX_STORED_BYTES, PHOTOS_PER_TARGET, isJpegSignature, jpegSize } from '../../domain/photo';
import type {
  Attachment,
  AuditEvent,
  ChecklistItem,
  Handoff,
  ImportRecord,
  Issue,
  IssueEvent,
  IssueKind,
  LossResolution,
  Member,
  Organization,
  Receipt,
  ReceiptLine,
  Rental,
  RentalLine,
  Role,
  Settings,
  Site,
} from '../../domain/types';
import type {
  CreateAttachmentInput,
  FileOut,
  HandoffRow,
  HistoryEntry,
  IssueDetail,
  IssueListRow,
  MutationLookup,
  OrgOverview,
  RentalDetail,
  RentalStage,
  RentalSummary,
  ReviewInput,
  SubmitIssueAction,
  SubmitReceiptInput,
  SubmitReceiptResult,
} from '../repository';

export interface MutationKey {
  orgId: string;
  actorId: string;
  operationId: string;
  name: string;
  requestHash: string;
  resultJson: unknown;
  createdAt: string;
}

export interface DemoDb {
  orgs: Organization[];
  members: Member[];
  sites: Site[];
  settings: Settings[];
  rentals: Rental[];
  rentalLines: RentalLine[];
  receipts: Receipt[];
  receiptLines: ReceiptLine[];
  issues: Issue[];
  lossResolutions: LossResolution[];
  issueEvents: IssueEvent[];
  attachments: Attachment[];
  handoffs: Handoff[];
  imports: (ImportRecord & { validation: ImportValidation; bytesB64: string })[];
  mutationKeys: MutationKey[];
  auditEvents: AuditEvent[];
}

export function emptyDb(): DemoDb {
  return {
    orgs: [],
    members: [],
    sites: [],
    settings: [],
    rentals: [],
    rentalLines: [],
    receipts: [],
    receiptLines: [],
    issues: [],
    lossResolutions: [],
    issueEvents: [],
    attachments: [],
    handoffs: [],
    imports: [],
    mutationKeys: [],
    auditEvents: [],
  };
}

interface Ctx {
  db: DemoDb;
  actor: Member;
  now: string;
  opId: string | null;
}

const MUTATORS = ['reviewer', 'admin'] as const;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class DemoServer {
  db: DemoDb;
  /** 写真の実体（Storage 相当、private）。トランザクションのスナップショット対象外。 */
  readonly objects = new Map<string, Uint8Array>();
  clock: () => Date;

  constructor(db: DemoDb = emptyDb(), clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  // ------------------------------------------------------------------
  // 基盤
  // ------------------------------------------------------------------

  /** 有効な所属を毎回DBから確認する（セッションの自己申告を信用しない）。 */
  private actorOf(userId: string, orgId: string): Member {
    const m = this.db.members.find((x) => x.userId === userId && x.orgId === orgId);
    if (!m || !m.active) throw new RepoError('forbidden', 'この組織での権限が無効になりました。管理者に確認してください。');
    const org = this.db.orgs.find((o) => o.id === orgId);
    if (!org || org.status !== 'active') throw new RepoError('forbidden', '組織が利用停止中です。');
    return m;
  }

  read<T>(userId: string, orgId: string, fn: (ctx: Ctx) => T): T {
    const actor = this.actorOf(userId, orgId);
    return fn({ db: this.db, actor, now: this.clock().toISOString(), opId: null });
  }

  /**
   * 重要更新の共通処理：権限確認 → 冪等キー確認 → スナップショット上で実行 → 一括確定。
   */
  mutate<T>(userId: string, orgId: string, name: string, opId: string, body: unknown, fn: (ctx: Ctx) => T): T {
    const actor = this.actorOf(userId, orgId);
    if (!/^[0-9a-f-]{36}$/i.test(opId)) throw new RepoError('validation', 'operation_id が不正です');
    const requestHash = sha256Hex(stableStringify({ name, body }));
    const existing = this.db.mutationKeys.find(
      (k) => k.orgId === orgId && k.actorId === userId && k.operationId === opId,
    );
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new RepoError('idempotency_mismatch', '同じ操作IDで異なる内容が送信されました。画面を開き直してください。');
      return structuredClone(existing.resultJson) as T;
    }
    const draft = structuredClone(this.db);
    const ctx: Ctx = { db: draft, actor, now: this.clock().toISOString(), opId };
    const result = fn(ctx);
    draft.mutationKeys.push({
      orgId,
      actorId: userId,
      operationId: opId,
      name,
      requestHash,
      resultJson: structuredClone(result),
      createdAt: ctx.now,
    });
    this.db = draft; // コミット
    return result;
  }

  lookup(userId: string, orgId: string, opId: string): MutationLookup {
    this.actorOf(userId, orgId);
    const k = this.db.mutationKeys.find((x) => x.orgId === orgId && x.actorId === userId && x.operationId === opId);
    return k ? { found: true, result: structuredClone(k.resultJson), createdAt: k.createdAt } : { found: false };
  }

  // ------------------------------------------------------------------
  // 共通ヘルパー
  // ------------------------------------------------------------------

  private static role(ctx: Ctx, roles: readonly Role[]) {
    if (!roles.includes(ctx.actor.role)) throw new RepoError('forbidden', 'この操作の権限がありません（役割が変更された可能性があります）。');
  }

  private static version(current: number, expected: number, latest: unknown) {
    if (current !== expected)
      throw new RepoError('conflict', '他の担当者が先に更新しました。最新の内容と比べて確認してください。', { latest });
  }

  private static rental(ctx: Ctx, id: string): Rental {
    const r = ctx.db.rentals.find((x) => x.id === id && x.orgId === ctx.actor.orgId);
    if (!r) throw new RepoError('not_found', '貸出が見つかりません');
    return r;
  }

  private static issue(ctx: Ctx, id: string): Issue {
    const i = ctx.db.issues.find((x) => x.id === id && x.orgId === ctx.actor.orgId);
    if (!i) throw new RepoError('not_found', '例外が見つかりません');
    return i;
  }

  private static line(ctx: Ctx, id: string): RentalLine {
    const l = ctx.db.rentalLines.find((x) => x.id === id && x.orgId === ctx.actor.orgId);
    if (!l) throw new RepoError('not_found', '明細が見つかりません');
    return l;
  }

  private static qty(db: DemoDb, line: RentalLine): LineQuantities {
    return lineQuantities(
      line,
      db.receipts.filter((r) => r.rentalId === line.rentalId),
      db.receiptLines.filter((l) => l.rentalLineId === line.id),
      db.lossResolutions.filter((l) => l.lineId === line.id),
    );
  }

  private static assertInvariant(db: DemoDb, line: RentalLine) {
    const q = DemoServer.qty(db, line);
    if (!invariantHolds(q))
      throw new RepoError('invariant', `返却数と紛失数の合計が貸出数（${line.qtyOut}）を超えるため保存できません`, { lineId: line.id, q });
  }

  private static audit(
    ctx: Ctx,
    entityType: string,
    entityId: string,
    action: string,
    before: unknown,
    after: unknown,
    rentalId: string | null,
  ) {
    ctx.db.auditEvents.push({
      id: uuid(),
      orgId: ctx.actor.orgId,
      actorId: ctx.actor.userId,
      entityType,
      entityId,
      action,
      beforeSnapshot: before === null ? null : structuredClone(before),
      afterSnapshot: after === null ? null : structuredClone(after),
      createdAt: ctx.now,
      operationId: ctx.opId,
      rentalId,
    });
  }

  private static event(ctx: Ctx, issue: Issue, eventType: string, note: string, extra: Partial<IssueEvent> = {}): IssueEvent {
    const e: IssueEvent = {
      id: uuid(),
      orgId: ctx.actor.orgId,
      issueId: issue.id,
      actorId: ctx.actor.userId,
      eventType,
      note: note.slice(0, 2000),
      channel: null,
      contactedAt: null,
      outcome: null,
      correctsEventId: null,
      createdAt: ctx.now,
      ...extra,
    };
    ctx.db.issueEvents.push(e);
    return e;
  }

  private static transition(ctx: Ctx, issue: Issue, t: IssueTransition, note: string) {
    const r = transitionCheck(t, issue.status, ctx.actor.role);
    if (!r.ok) throw new RepoError(r.code, r.reason);
    const before = { ...issue };
    issue.status = r.to;
    issue.version += 1;
    DemoServer.event(ctx, issue, t, note);
    DemoServer.audit(ctx, 'issue', issue.id, t, before, issue, issue.rentalId);
  }

  private static defaultDue(now: string): string {
    return tokyoToIso(addDays(tokyoDate(now), 1), '17:00');
  }

  private static createIssue(
    ctx: Ctx,
    rental: Rental,
    line: RentalLine,
    kind: IssueKind,
    qty: number,
    receiptLineId: string | null,
    summary: string,
  ): Issue {
    const issue: Issue = {
      id: uuid(),
      orgId: ctx.actor.orgId,
      rentalId: rental.id,
      lineId: line.id,
      kind,
      receiptLineId,
      qty,
      summary: summary.slice(0, 500),
      ownerUserId: ctx.actor.userId,
      dueAt: DemoServer.defaultDue(ctx.now),
      status: 'open',
      resolutionCode: null,
      billingAction: null,
      chargeCandidateYen: null,
      decisionReason: null,
      photoSkipReason: null,
      externalCorrectionPending: false,
      version: 1,
      createdAt: ctx.now,
    };
    ctx.db.issues.push(issue);
    DemoServer.event(ctx, issue, 'created', summary);
    DemoServer.audit(ctx, 'issue', issue.id, 'create', null, issue, rental.id);
    return issue;
  }

  /** 承認済みの引き渡しを取消履歴として残す（旧版CSVを再利用不可にする）。 */
  private static revokeHandoffs(ctx: Ctx, issue: Issue, reason: string) {
    for (const h of ctx.db.handoffs) {
      if (h.issueId === issue.id && h.revokedAt === null && h.ackAt === null) {
        h.revokedAt = ctx.now;
        h.revokedReason = reason;
        DemoServer.audit(ctx, 'handoff', h.id, 'revoke', null, h, issue.rentalId);
      }
    }
  }

  /** 閉鎖済みを再開。外部で受領済みなら外部訂正タスクを残す。 */
  private static reopenClosed(ctx: Ctx, issue: Issue, reason: string) {
    const before = { ...issue };
    issue.status = 'needs_correction';
    issue.version += 1;
    issue.externalCorrectionPending = ctx.db.handoffs.some((h) => h.issueId === issue.id && h.ackAt !== null);
    DemoServer.event(ctx, issue, 'reopen', reason);
    DemoServer.audit(ctx, 'issue', issue.id, 'reopen', before, issue, issue.rentalId);
    const rental = ctx.db.rentals.find((r) => r.id === issue.rentalId)!;
    if (rental.status === 'closed') {
      const rb = { ...rental };
      rental.status = 'open';
      rental.externalReturnAckAt = null;
      rental.version += 1;
      DemoServer.audit(ctx, 'rental', rental.id, 'reopen', rb, rental, rental.id);
    }
  }

  /**
   * 未返却に応じて missing を作成／更新する。
   * cause=receipt は通常の返却追加。それ以外（訂正・数量変更・紛失反転）は判断済みでも再確認へ戻す。
   */
  private static syncMissing(ctx: Ctx, rental: Rental, line: RentalLine, cause: 'receipt' | 'recheck'): string | null {
    const q = DemoServer.qty(ctx.db, line);
    const m = ctx.db.issues.find((i) => i.lineId === line.id && i.kind === 'missing' && isUnclosed(i.status));
    const unit = line.unitOriginal;
    if (q.outstanding > 0) {
      if (!m) {
        return DemoServer.createIssue(ctx, rental, line, 'missing', q.outstanding, null, `${line.itemNameOriginal}が${q.outstanding}${unit}未返却`).id;
      }
      if (m.status === 'open' || m.status === 'waiting' || m.status === 'needs_correction') {
        if (m.qty !== q.outstanding) {
          const before = { ...m };
          m.qty = q.outstanding;
          m.summary = `${line.itemNameOriginal}が${q.outstanding}${unit}未返却`;
          m.version += 1;
          DemoServer.event(ctx, m, 'qty_updated', `未返却数を${before.qty}→${q.outstanding}${unit}に更新`);
          DemoServer.audit(ctx, 'issue', m.id, 'qty_updated', before, m, rental.id);
        }
        return m.id;
      }
      if (cause === 'receipt') {
        DemoServer.event(ctx, m, 'returned_after_submit', `判断依頼の後に返却が追加されました（現在の未返却 ${q.outstanding}${unit}）`);
        return m.id;
      }
      // 判断済み・判断中の数量前提が崩れた → 差し戻して再確認
      const before = { ...m };
      if (m.status === 'approved') DemoServer.revokeHandoffs(ctx, m, '数量の訂正により再確認');
      m.status = 'needs_correction';
      m.qty = q.outstanding;
      m.version += 1;
      DemoServer.event(ctx, m, 'recheck', `数量の訂正により再確認が必要です（現在の未返却 ${q.outstanding}${unit}）`);
      DemoServer.audit(ctx, 'issue', m.id, 'recheck', before, m, rental.id);
      return m.id;
    }
    // 未返却0：自動で請求なし・終了にはせず判断依頼へ
    if (m && (m.status === 'open' || m.status === 'waiting' || m.status === 'needs_correction')) {
      const before = { ...m };
      m.status = 'review_pending';
      m.version += 1;
      DemoServer.event(ctx, m, 'all_resolved', `未返却が0になりました。判断対象数量 ${m.qty}${unit} で確認待ちにしました`);
      DemoServer.audit(ctx, 'issue', m.id, 'auto_review_pending', before, m, rental.id);
    }
    return m?.id ?? null;
  }

  // ------------------------------------------------------------------
  // 参照
  // ------------------------------------------------------------------

  private static summary(db: DemoDb, rental: Rental): RentalSummary {
    const lines = db.rentalLines.filter((l) => l.rentalId === rental.id);
    const qs = lines.map((l) => DemoServer.qty(db, l));
    const issues = db.issues.filter((i) => i.rentalId === rental.id);
    const openIssueCount = issues.filter((i) => isUnclosed(i.status)).length;
    const hasReceipts = db.receipts.some((r) => r.rentalId === rental.id && r.status === 'valid' && r.reversalOf === null);
    const totalOutstanding = qs.reduce((s, q) => s + q.outstanding, 0);
    let stage: RentalStage;
    if (rental.status === 'closed') stage = 'closed';
    else if (rental.status === 'cancelled') stage = 'cancelled';
    else if (!hasReceipts) stage = 'not_started';
    else if (totalOutstanding > 0) stage = 'partial';
    else if (openIssueCount > 0) stage = 'issues_open';
    else stage = 'awaiting_ack';
    return {
      rental: { ...rental },
      siteName: db.sites.find((s) => s.id === rental.siteId)?.nameOriginal ?? '',
      lineCount: lines.length,
      totalOut: qs.reduce((s, q) => s + q.qtyOut, 0),
      totalOutstanding,
      openIssueCount,
      hasReceipts,
      stage,
      firstItemName: lines[0]?.itemNameOriginal ?? '',
    };
  }

  private static closeCheck(db: DemoDb, rental: Rental) {
    const reasons: string[] = [];
    const lines = db.rentalLines.filter((l) => l.rentalId === rental.id);
    const out = lines.reduce((s, l) => s + DemoServer.qty(db, l).outstanding, 0);
    if (rental.status !== 'open') reasons.push('この貸出は未完了ではありません');
    if (out > 0) reasons.push(`未返却が${out}あります`);
    const open = db.issues.filter((i) => i.rentalId === rental.id && isUnclosed(i.status)).length;
    if (open > 0) reasons.push(`未完了の不足・破損が${open}件あります`);
    return { ok: reasons.length === 0, reasons };
  }

  overview(ctx: Ctx): OrgOverview {
    const org = ctx.db.orgs.find((o) => o.id === ctx.actor.orgId)!;
    return structuredClone({
      org,
      sites: ctx.db.sites.filter((s) => s.orgId === org.id),
      settings: ctx.db.settings.find((s) => s.orgId === org.id)!,
      members: ctx.db.members.filter((m) => m.orgId === org.id),
    });
  }

  rentalsForDate(ctx: Ctx, ymd: string): RentalSummary[] {
    return ctx.db.rentals
      .filter((r) => r.orgId === ctx.actor.orgId && r.status !== 'cancelled')
      .filter((r) => tokyoDate(r.dueAt) === ymd || (r.status === 'open' && tokyoDate(r.dueAt) < ymd))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .map((r) => DemoServer.summary(ctx.db, r));
  }

  search(ctx: Ctx, q: { query: string; mode: 'today' | 'open'; ymd: string }): RentalSummary[] {
    const key = searchKey(q.query);
    return ctx.db.rentals
      .filter((r) => r.orgId === ctx.actor.orgId)
      .filter((r) => (q.mode === 'today' ? tokyoDate(r.dueAt) === q.ymd : r.status === 'open'))
      .filter((r) => key === '' || r.externalRentalIdSearch.includes(key) || r.customerLabelSearch.includes(key))
      .sort((a, b) => {
        // 番号の前方一致を優先
        const ap = a.externalRentalIdSearch.startsWith(key) ? 0 : 1;
        const bp = b.externalRentalIdSearch.startsWith(key) ? 0 : 1;
        return ap - bp || a.dueAt.localeCompare(b.dueAt);
      })
      .map((r) => DemoServer.summary(ctx.db, r));
  }

  rentalDetail(ctx: Ctx, rentalId: string): RentalDetail {
    const rental = DemoServer.rental(ctx, rentalId);
    const db = ctx.db;
    const nameOf = (id: string) => db.members.find((m) => m.userId === id && m.orgId === rental.orgId)?.displayName ?? '不明';
    return structuredClone({
      rental,
      site: db.sites.find((s) => s.id === rental.siteId)!,
      lines: db.rentalLines.filter((l) => l.rentalId === rental.id).map((l) => ({ ...l, q: DemoServer.qty(db, l) })),
      receipts: db.receipts
        .filter((r) => r.rentalId === rental.id)
        .map((r) => ({ ...r, actorName: nameOf(r.actorId), lines: db.receiptLines.filter((l) => l.receiptId === r.id) })),
      issues: db.issues.filter((i) => i.rentalId === rental.id),
      closeCheck: DemoServer.closeCheck(db, rental),
    });
  }

  issueList(ctx: Ctx): IssueListRow[] {
    const db = ctx.db;
    const now = ctx.now;
    return db.issues
      .filter((i) => i.orgId === ctx.actor.orgId)
      .map((issue) => {
        const rental = db.rentals.find((r) => r.id === issue.rentalId)!;
        const line = db.rentalLines.find((l) => l.id === issue.lineId)!;
        const owner = db.members.find((m) => m.userId === issue.ownerUserId && m.orgId === issue.orgId);
        return structuredClone({
          issue,
          rentalNumber: rental.externalRentalIdOriginal,
          customerLabel: rental.customerLabelOriginal,
          itemName: line.itemNameOriginal,
          unit: line.unitOriginal,
          ownerName: owner?.displayName ?? '不明',
          ownerActive: owner?.active ?? false,
          outstanding: DemoServer.qty(db, line).outstanding,
          overdue: isUnclosed(issue.status) && issue.status !== 'approved' && issue.dueAt < now,
        });
      })
      .sort((a, b) => a.issue.dueAt.localeCompare(b.issue.dueAt));
  }

  issueDetail(ctx: Ctx, issueId: string): IssueDetail {
    const issue = DemoServer.issue(ctx, issueId);
    const db = ctx.db;
    const rental = db.rentals.find((r) => r.id === issue.rentalId)!;
    const line = db.rentalLines.find((l) => l.id === issue.lineId)!;
    const nameOf = (id: string) => db.members.find((m) => m.userId === id && m.orgId === issue.orgId)?.displayName ?? '不明';
    return structuredClone({
      issue,
      rental,
      line: { ...line, q: DemoServer.qty(db, line) },
      ownerName: nameOf(issue.ownerUserId),
      events: db.issueEvents.filter((e) => e.issueId === issue.id).map((e) => ({ ...e, actorName: nameOf(e.actorId) })),
      attachments: db.attachments.filter(
        (a) =>
          a.orgId === issue.orgId &&
          (a.issueId === issue.id || (issue.receiptLineId !== null && a.receiptLineId === issue.receiptLineId)),
      ),
      handoffs: db.handoffs.filter((h) => h.issueId === issue.id),
      losses: db.lossResolutions.filter((l) => l.issueId === issue.id),
    });
  }

  handoffList(ctx: Ctx): HandoffRow[] {
    const db = ctx.db;
    return db.handoffs
      .filter((h) => h.orgId === ctx.actor.orgId)
      .map((h) => {
        const issue = db.issues.find((i) => i.id === h.issueId)!;
        const rental = db.rentals.find((r) => r.id === issue.rentalId)!;
        const line = db.rentalLines.find((l) => l.id === issue.lineId)!;
        return structuredClone({
          handoff: h,
          issue,
          rentalNumber: rental.externalRentalIdOriginal,
          customerLabel: rental.customerLabelOriginal,
          itemName: line.itemNameOriginal,
          unit: line.unitOriginal,
          ackByName: h.ackBy ? (db.members.find((m) => m.userId === h.ackBy)?.displayName ?? '不明') : null,
          current: h.revokedAt === null && issue.version === h.approvedVersion,
        });
      })
      .sort((a, b) => b.handoff.createdAt.localeCompare(a.handoff.createdAt));
  }

  awaitingAck(ctx: Ctx): RentalSummary[] {
    return ctx.db.rentals
      .filter((r) => r.orgId === ctx.actor.orgId && r.status === 'open')
      .map((r) => DemoServer.summary(ctx.db, r))
      .filter((s) => s.stage === 'awaiting_ack');
  }

  history(ctx: Ctx, rentalId: string): HistoryEntry[] {
    const rental = DemoServer.rental(ctx, rentalId);
    const db = ctx.db;
    const nameOf = (id: string) => db.members.find((m) => m.userId === id && m.orgId === rental.orgId)?.displayName ?? '不明';
    const out: HistoryEntry[] = [];
    for (const a of db.auditEvents.filter((x) => x.rentalId === rental.id)) {
      out.push({ at: a.createdAt, actorName: nameOf(a.actorId), operationId: a.operationId, ...describeAudit(a, db) });
    }
    for (const e of db.issueEvents.filter((x) => db.issues.some((i) => i.id === x.issueId && i.rentalId === rental.id))) {
      if (e.eventType !== 'contact' && e.eventType !== 'note' && e.eventType !== 'correction') continue;
      out.push({
        at: e.createdAt,
        actorName: nameOf(e.actorId),
        category: 'issue',
        title: e.eventType === 'contact' ? '連絡記録（手動記録）' : e.eventType === 'correction' ? '記録の訂正' : 'メモ',
        detail: [e.channel ? `手段:${e.channel}` : '', e.outcome ? `結果:${e.outcome}` : '', e.note].filter(Boolean).join(' / '),
        operationId: null,
      });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  // ------------------------------------------------------------------
  // 更新
  // ------------------------------------------------------------------

  submitReceipt(ctx: Ctx, input: SubmitReceiptInput): SubmitReceiptResult {
    const rental = DemoServer.rental(ctx, input.rentalId);
    if (rental.status !== 'open') throw new RepoError('conflict', 'この貸出は完了または取消済みです');
    DemoServer.version(rental.version, input.expectedVersion, DemoServer.summary(ctx.db, rental));
    const lines = ctx.db.rentalLines.filter((l) => l.rentalId === rental.id);
    const current = new Map(lines.map((l) => [l.id, DemoServer.qty(ctx.db, l)]));
    const unit = (id: string) => lines.find((l) => l.id === id)?.unitOriginal ?? '';
    const effective = input.lines.filter((l) => l.qtyReceived > 0 || l.qtyDamaged > 0);
    const problems = checkReceiptInput(effective, current, unit);
    if (problems.length > 0) throw new RepoError('invariant', problems[0]!.message, { problems });
    if (input.memo.length > 2000) throw new RepoError('validation', 'メモは2000字以内です');

    const receipt: Receipt = {
      id: uuid(),
      orgId: ctx.actor.orgId,
      rentalId: rental.id,
      operationId: ctx.opId!,
      receivedAt: ctx.now,
      actorId: ctx.actor.userId,
      status: 'valid',
      reversalOf: null,
      reason: null,
      memo: input.memo || null,
      createdAt: ctx.now,
    };
    ctx.db.receipts.push(receipt);
    const result: SubmitReceiptResult = {
      receiptId: receipt.id,
      receivedAt: ctx.now,
      rentalVersion: 0,
      receiptLineIds: {},
      damageIssueIds: {},
      missingIssueIds: [],
    };
    const checklistIds = new Set(ctx.db.settings.find((s) => s.orgId === ctx.actor.orgId)?.checklist.map((c) => c.id));
    for (const i of effective) {
      const line = lines.find((l) => l.id === i.rentalLineId)!;
      const snapshot: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(input.lines.find((x) => x.rentalLineId === i.rentalLineId)?.checklist ?? {})) {
        if (checklistIds.has(k)) snapshot[k] = v === true;
      }
      const rl: ReceiptLine = {
        id: uuid(),
        orgId: ctx.actor.orgId,
        receiptId: receipt.id,
        rentalLineId: line.id,
        qtyReceived: i.qtyReceived,
        qtyDamaged: i.qtyDamaged,
        checklistSnapshot: snapshot,
      };
      ctx.db.receiptLines.push(rl);
      result.receiptLineIds[line.id] = rl.id;
      DemoServer.assertInvariant(ctx.db, line);
      if (i.qtyDamaged > 0) {
        const memo = input.memo ? `／${input.memo.slice(0, 200)}` : '';
        const d = DemoServer.createIssue(ctx, rental, line, 'damage', i.qtyDamaged, rl.id, `${line.itemNameOriginal} 破損${i.qtyDamaged}${line.unitOriginal}${memo}`);
        result.damageIssueIds[line.id] = d.id;
      }
    }
    for (const i of effective) {
      const line = lines.find((l) => l.id === i.rentalLineId)!;
      const mid = DemoServer.syncMissing(ctx, rental, line, 'receipt');
      if (mid) result.missingIssueIds.push(mid);
    }
    rental.version += 1;
    result.rentalVersion = rental.version;
    DemoServer.audit(ctx, 'receipt', receipt.id, 'submit_receipt', null, {
      receipt,
      lines: ctx.db.receiptLines.filter((l) => l.receiptId === receipt.id),
    }, rental.id);
    return result;
  }

  createAttachment(ctx: Ctx, input: CreateAttachmentInput): { attachmentId: string; objectKey: string } {
    if (!input.issueId && !input.receiptLineId) throw new RepoError('validation', '写真の親（例外または返却明細）が必要です');
    let issue: Issue | null = null;
    if (input.issueId) {
      issue = DemoServer.issue(ctx, input.issueId);
      if (!isUnclosed(issue.status) || issue.status === 'approved')
        throw new RepoError('conflict', '完了・承認済みの例外には写真を追加できません');
    }
    if (input.receiptLineId) {
      const rl = ctx.db.receiptLines.find((x) => x.id === input.receiptLineId && x.orgId === ctx.actor.orgId);
      if (!rl) throw new RepoError('not_found', '返却明細が見つかりません');
    }
    if (input.mime !== 'image/jpeg') throw new RepoError('validation', '保存できるのはJPEGに変換した画像だけです');
    const siblings = ctx.db.attachments.filter(
      (a) =>
        a.status !== 'rejected' &&
        ((input.issueId && a.issueId === input.issueId) || (!input.issueId && a.receiptLineId === input.receiptLineId)),
    );
    if (siblings.length >= PHOTOS_PER_TARGET) throw new RepoError('validation', `写真は1件につき${PHOTOS_PER_TARGET}枚までです`);
    const org = ctx.db.orgs.find((o) => o.id === ctx.actor.orgId)!;
    const used = ctx.db.attachments.filter((a) => a.orgId === org.id && a.status !== 'rejected').reduce((s, a) => s + a.byteSize, 0);
    if (used + input.byteSize > org.storageLimitBytes) throw new RepoError('validation', '組織の写真容量の上限に達しています');
    const a: Attachment = {
      id: uuid(),
      orgId: ctx.actor.orgId,
      issueId: input.issueId,
      receiptLineId: input.receiptLineId,
      objectKey: `${ctx.actor.orgId}/${uuid()}.jpg`, // ユーザー指定のパスは使わない
      byteSize: input.byteSize,
      mime: 'image/jpeg',
      imageWidth: input.imageWidth,
      imageHeight: input.imageHeight,
      sha256: input.sha256,
      status: 'pending',
      createdBy: ctx.actor.userId,
      createdAt: ctx.now,
    };
    ctx.db.attachments.push(a);
    DemoServer.audit(ctx, 'attachment', a.id, 'create_pending', null, a, issue?.rentalId ?? null);
    return { attachmentId: a.id, objectKey: a.objectKey };
  }

  /** アップロード＋サーバー検証（自己申告の Content-Type を信用しない）。 */
  uploadAttachment(userId: string, orgId: string, attachmentId: string, bytes: Uint8Array): { status: 'ready' } {
    const actor = this.actorOf(userId, orgId);
    const a = this.db.attachments.find((x) => x.id === attachmentId && x.orgId === actor.orgId);
    if (!a) throw new RepoError('not_found', '写真の受付が見つかりません');
    if (a.status === 'ready') return { status: 'ready' };
    if (a.createdBy !== actor.userId && actor.role === 'operator') throw new RepoError('forbidden', '他の担当者の写真は送信できません');
    const reject = (msg: string): never => {
      throw new RepoError('validation', msg);
    };
    if (bytes.byteLength > PHOTO_MAX_STORED_BYTES) reject('写真が2MiBを超えています');
    if (!isJpegSignature(bytes)) reject('JPEG画像ではありません');
    const size = jpegSize(bytes);
    if (!size) reject('画像の寸法を読み取れません');
    if (Math.max(size!.width, size!.height) > PHOTO_MAX_EDGE) reject(`長辺が${PHOTO_MAX_EDGE}pxを超えています`);
    if (sha256Hex(bytes) !== a.sha256) reject('送信途中で内容が変わりました。もう一度送信してください');
    this.objects.set(a.objectKey, bytes.slice());
    const draft = structuredClone(this.db);
    const da = draft.attachments.find((x) => x.id === a.id)!;
    da.status = 'ready';
    da.byteSize = bytes.byteLength;
    da.imageWidth = size!.width;
    da.imageHeight = size!.height;
    this.db = draft;
    return { status: 'ready' };
  }

  /** 60秒有効の読取（署名URL相当）。権限を再検証してから返す。 */
  photo(ctx: Ctx, attachmentId: string) {
    const a = ctx.db.attachments.find((x) => x.id === attachmentId && x.orgId === ctx.actor.orgId);
    if (!a || a.status !== 'ready' || !a.objectKey.startsWith(`${ctx.actor.orgId}/`))
      throw new RepoError('not_found', '写真が見つかりません');
    const bytes = this.objects.get(a.objectKey);
    if (!bytes) throw new RepoError('not_found', '写真が見つかりません');
    return { bytes: bytes.slice(), mime: a.mime, expiresAt: new Date(Date.parse(ctx.now) + 60_000).toISOString() };
  }

  /** 24時間以上 pending のままの孤児を清掃する。 */
  cleanupPendingAttachments(): number {
    const cutoff = this.clock().getTime() - 24 * 3600_000;
    const before = this.db.attachments.length;
    this.db = {
      ...this.db,
      attachments: this.db.attachments.filter((a) => !(a.status === 'pending' && Date.parse(a.createdAt) < cutoff)),
    };
    return before - this.db.attachments.length;
  }

  submitIssue(ctx: Ctx, input: { issueId: string; expectedVersion: number; action: SubmitIssueAction; note: string }) {
    const issue = DemoServer.issue(ctx, input.issueId);
    DemoServer.version(issue.version, input.expectedVersion, issue);
    if (input.action === 'to_waiting') {
      DemoServer.transition(ctx, issue, 'to_waiting', input.note || '顧客確認中にしました');
    } else if (input.action === 'request_review') {
      if (issue.kind === 'damage') {
        const ready = ctx.db.attachments.filter(
          (a) => a.status === 'ready' && (a.issueId === issue.id || (issue.receiptLineId && a.receiptLineId === issue.receiptLineId)),
        );
        if (ready.length === 0)
          throw new RepoError('validation', '破損の確認依頼には送信済みの写真が1枚以上必要です');
        issue.photoSkipReason = null;
      }
      if (issue.kind === 'missing') {
        // 提出時に判断対象数量を固定（以後0に上書きしない）
        const line = DemoServer.line(ctx, issue.lineId);
        const q = DemoServer.qty(ctx.db, line);
        if (q.outstanding > 0) issue.qty = q.outstanding;
      }
      DemoServer.transition(ctx, issue, 'request_review', input.note || '確認を依頼しました');
    } else {
      if (issue.kind !== 'damage') throw new RepoError('validation', '写真省略は破損のみ記録できます');
      if (input.note.trim() === '') throw new RepoError('validation', '写真を省略する理由を入力してください');
      if (!['open', 'waiting', 'needs_correction'].includes(issue.status))
        throw new RepoError('conflict', 'この状態では写真省略を記録できません');
      const before = { ...issue };
      issue.photoSkipReason = input.note;
      issue.status = 'needs_correction';
      issue.version += 1;
      DemoServer.event(ctx, issue, 'photo_skipped', `写真なし（理由：${input.note}）。写真が送信されるまで承認できません`);
      DemoServer.audit(ctx, 'issue', issue.id, 'photo_skip', before, issue, issue.rentalId);
    }
    return { version: issue.version };
  }

  assignIssue(ctx: Ctx, input: { issueId: string; expectedVersion: number; ownerUserId: string; dueAt: string; note: string }) {
    DemoServer.role(ctx, MUTATORS);
    const issue = DemoServer.issue(ctx, input.issueId);
    DemoServer.version(issue.version, input.expectedVersion, issue);
    if (!isUnclosed(issue.status)) throw new RepoError('conflict', '完了した例外の担当は変更できません');
    const owner = ctx.db.members.find((m) => m.userId === input.ownerUserId && m.orgId === ctx.actor.orgId && m.active);
    if (!owner) throw new RepoError('validation', '担当者は有効な所属メンバーから選んでください');
    if (Number.isNaN(Date.parse(input.dueAt))) throw new RepoError('validation', '期限が不正です');
    const before = { ...issue };
    const prevName = ctx.db.members.find((m) => m.userId === issue.ownerUserId)?.displayName ?? '不明';
    issue.ownerUserId = owner.userId;
    issue.dueAt = new Date(input.dueAt).toISOString();
    issue.version += 1;
    DemoServer.event(ctx, issue, 'assign', `担当：${prevName} → ${owner.displayName}${input.note ? `／${input.note}` : ''}`);
    DemoServer.audit(ctx, 'issue', issue.id, 'assign', before, issue, issue.rentalId);
    return { version: issue.version };
  }

  addContact(
    ctx: Ctx,
    input: { issueId: string; channel: 'phone' | 'email' | 'other'; contactedAt: string; outcome: string; note: string; correctsEventId: string | null },
  ) {
    const issue = DemoServer.issue(ctx, input.issueId);
    if (input.correctsEventId && !ctx.db.issueEvents.some((e) => e.id === input.correctsEventId && e.issueId === issue.id))
      throw new RepoError('validation', '訂正対象の記録が見つかりません');
    if (input.outcome.trim() === '' && !input.correctsEventId) throw new RepoError('validation', '連絡の結果を入力してください');
    if (Number.isNaN(Date.parse(input.contactedAt))) throw new RepoError('validation', '連絡日時が不正です');
    const e = DemoServer.event(ctx, issue, input.correctsEventId ? 'correction' : 'contact', input.note, {
      channel: input.channel,
      contactedAt: new Date(input.contactedAt).toISOString(),
      outcome: input.outcome.slice(0, 200),
      correctsEventId: input.correctsEventId,
    });
    return { eventId: e.id };
  }

  reviewIssue(ctx: Ctx, input: ReviewInput) {
    DemoServer.role(ctx, MUTATORS);
    const issue = DemoServer.issue(ctx, input.issueId);
    DemoServer.version(issue.version, input.expectedVersion, issue);
    if (input.decision === 'send_back' || input.decision === 'revoke') {
      if (input.decisionReason.trim() === '') throw new RepoError('validation', '差し戻しの理由を入力してください');
      if (input.decision === 'revoke') DemoServer.revokeHandoffs(ctx, issue, input.decisionReason);
      DemoServer.transition(ctx, issue, input.decision === 'send_back' ? 'send_back' : 'revoke_approval', input.decisionReason);
      return { version: issue.version, handoffId: null };
    }
    const line = DemoServer.line(ctx, issue.lineId);
    const q = DemoServer.qty(ctx.db, line);
    const hasActiveLoss = ctx.db.lossResolutions.some((l) => l.issueId === issue.id && l.reversedAt === null);
    const errs = checkDecision(input, { hasActiveLoss });
    if (issue.kind === 'missing' && q.outstanding > 0)
      errs.push(`未返却が${q.outstanding}${line.unitOriginal}残っています。返却を待つか紛失数量を記録してから承認してください`);
    if (issue.kind === 'damage') {
      const ready = ctx.db.attachments.some(
        (a) => a.status === 'ready' && (a.issueId === issue.id || (issue.receiptLineId && a.receiptLineId === issue.receiptLineId)),
      );
      if (!ready || issue.photoSkipReason) errs.push('送信済みの写真がない破損は承認できません');
    }
    if (errs.length > 0) throw new RepoError('validation', errs[0]!, { errors: errs });
    const t = transitionCheck('approve', issue.status, ctx.actor.role);
    if (!t.ok) throw new RepoError(t.code, t.reason);
    const before = { ...issue };
    issue.resolutionCode = input.resolutionCode;
    issue.billingAction = input.billingAction;
    issue.chargeCandidateYen = input.chargeCandidateYen;
    issue.decisionReason = input.decisionReason;
    issue.status = 'approved';
    issue.version += 1;
    const h: Handoff = {
      id: uuid(),
      orgId: ctx.actor.orgId,
      issueId: issue.id,
      approvedVersion: issue.version,
      action: input.billingAction!,
      chargeCandidateYen: input.chargeCandidateYen ?? 0,
      exportedAt: null,
      exportCount: 0,
      ackAt: null,
      ackBy: null,
      externalRef: null,
      note: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: ctx.now,
    };
    if (ctx.db.handoffs.some((x) => x.issueId === issue.id && x.approvedVersion === h.approvedVersion))
      throw new RepoError('conflict', '同じ承認版の引き渡しが既にあります');
    ctx.db.handoffs.push(h);
    DemoServer.event(ctx, issue, 'approve', `承認：${input.decisionReason}`);
    DemoServer.audit(ctx, 'issue', issue.id, 'approve', before, issue, issue.rentalId);
    DemoServer.audit(ctx, 'handoff', h.id, 'create', null, h, issue.rentalId);
    return { version: issue.version, handoffId: h.id };
  }

  resolveLoss(ctx: Ctx, input: { issueId: string; expectedVersion: number; qtyLost: number; reason: string }) {
    DemoServer.role(ctx, MUTATORS);
    const issue = DemoServer.issue(ctx, input.issueId);
    DemoServer.version(issue.version, input.expectedVersion, issue);
    if (issue.kind !== 'missing') throw new RepoError('validation', '紛失処理は不足（未返却）の例外にだけ記録できます');
    if (!['open', 'waiting', 'review_pending', 'needs_correction'].includes(issue.status))
      throw new RepoError('conflict', 'この状態では紛失処理を記録できません');
    const line = DemoServer.line(ctx, issue.lineId);
    const q = DemoServer.qty(ctx.db, line);
    if (!Number.isInteger(input.qtyLost) || input.qtyLost < 1 || input.qtyLost > q.outstanding)
      throw new RepoError('invariant', `紛失数量は1～${q.outstanding}${line.unitOriginal}（現在の未返却数）で指定してください`);
    if (input.reason.trim() === '') throw new RepoError('validation', '紛失扱いの理由を入力してください');
    const loss: LossResolution = {
      id: uuid(),
      orgId: ctx.actor.orgId,
      lineId: line.id,
      issueId: issue.id,
      qtyLost: input.qtyLost,
      approvedBy: ctx.actor.userId,
      approvedAt: ctx.now,
      reversedAt: null,
      reversedBy: null,
      reason: input.reason,
      reverseReason: null,
    };
    ctx.db.lossResolutions.push(loss);
    DemoServer.assertInvariant(ctx.db, line);
    issue.version += 1;
    DemoServer.event(ctx, issue, 'loss', `紛失扱い ${input.qtyLost}${line.unitOriginal}（責任者による確認記録。法的責任の確定ではありません）：${input.reason}`);
    DemoServer.audit(ctx, 'loss_resolution', loss.id, 'resolve_loss', null, loss, issue.rentalId);
    const rental = DemoServer.rental(ctx, issue.rentalId);
    if (issue.status === 'review_pending') {
      // 確認待ちのまま。数量のみ記録。
    } else {
      DemoServer.syncMissing(ctx, rental, line, 'receipt');
    }
    return { lossId: loss.id, version: issue.version };
  }

  reverseLoss(ctx: Ctx, input: { lossId: string; reason: string }) {
    DemoServer.role(ctx, ['admin']);
    const loss = ctx.db.lossResolutions.find((l) => l.id === input.lossId && l.orgId === ctx.actor.orgId);
    if (!loss) throw new RepoError('not_found', '紛失処理が見つかりません');
    if (loss.reversedAt) throw new RepoError('conflict', 'この紛失処理は既に反転済みです');
    if (input.reason.trim() === '') throw new RepoError('validation', '反転の理由を入力してください');
    const before = { ...loss };
    loss.reversedAt = ctx.now;
    loss.reversedBy = ctx.actor.userId;
    loss.reverseReason = input.reason;
    const issue = DemoServer.issue(ctx, loss.issueId);
    DemoServer.audit(ctx, 'loss_resolution', loss.id, 'reverse_loss', before, loss, issue.rentalId);
    const line = DemoServer.line(ctx, loss.lineId);
    if (issue.status === 'closed') {
      DemoServer.reopenClosed(ctx, issue, `紛失処理の反転：${input.reason}`);
    } else if (issue.status === 'approved') {
      DemoServer.revokeHandoffs(ctx, issue, '紛失処理の反転');
      const b = { ...issue };
      issue.status = 'needs_correction';
      issue.version += 1;
      DemoServer.event(ctx, issue, 'loss_reversed', `紛失処理を反転：${input.reason}`);
      DemoServer.audit(ctx, 'issue', issue.id, 'loss_reversed', b, issue, issue.rentalId);
    } else {
      issue.version += 1;
      DemoServer.event(ctx, issue, 'loss_reversed', `紛失処理を反転：${input.reason}`);
    }
    // 金額は黙って相殺しない。再判断と外部訂正の確認を求める。
    issue.resolutionCode = null;
    issue.billingAction = null;
    issue.chargeCandidateYen = null;
    DemoServer.syncMissing(ctx, DemoServer.rental(ctx, issue.rentalId), line, 'recheck');
    return { ok: true as const };
  }

  exportHandoffs(ctx: Ctx, input: { handoffIds: string[] }): { file: FileOut; exportedAt: string } {
    DemoServer.role(ctx, MUTATORS);
    if (input.handoffIds.length === 0) throw new RepoError('validation', '出力する承認済み案件を選んでください');
    const rows: (string | number)[][] = [];
    for (const id of input.handoffIds) {
      const h = ctx.db.handoffs.find((x) => x.id === id && x.orgId === ctx.actor.orgId);
      if (!h) throw new RepoError('not_found', '引き渡しが見つかりません');
      const issue = DemoServer.issue(ctx, h.issueId);
      if (h.revokedAt || issue.version !== h.approvedVersion)
        throw new RepoError('conflict', '取消・改訂された旧版は出力できません。最新の承認版を選んでください');
      const rental = DemoServer.rental(ctx, issue.rentalId);
      const line = DemoServer.line(ctx, issue.lineId);
      h.exportedAt = ctx.now;
      h.exportCount += 1;
      DemoServer.audit(ctx, 'handoff', h.id, 'export', null, { exportedAt: ctx.now, approvedVersion: h.approvedVersion, exportCount: h.exportCount }, rental.id);
      rows.push([
        rental.externalRentalIdOriginal,
        line.externalLineIdOriginal,
        issue.id,
        h.approvedVersion,
        line.itemNameOriginal,
        issue.qty,
        h.chargeCandidateYen,
        'JPY',
        issue.decisionReason ?? '',
      ]);
    }
    const stamp = ctx.now.replace(/[-:]/g, '').slice(0, 15);
    return {
      exportedAt: ctx.now,
      file: { fileName: `charge_candidates_${stamp}.csv`, mime: 'text/csv', data: toCsv(HANDOFF_CSV_COLUMNS, rows) },
    };
  }

  ackHandoff(ctx: Ctx, input: { handoffId: string; externalRef: string; note: string }) {
    DemoServer.role(ctx, MUTATORS);
    const h = ctx.db.handoffs.find((x) => x.id === input.handoffId && x.orgId === ctx.actor.orgId);
    if (!h) throw new RepoError('not_found', '引き渡しが見つかりません');
    const issue = DemoServer.issue(ctx, h.issueId);
    if (h.revokedAt) throw new RepoError('conflict', 'この承認版は取り消されています');
    if (h.ackAt) throw new RepoError('conflict', '既に受領済みです');
    if (issue.version !== h.approvedVersion) throw new RepoError('conflict', '承認後に内容が変わっています。最新版を確認してください');
    if (h.action === 'charge_candidate' && input.externalRef.trim() === '')
      throw new RepoError('validation', '請求候補は既存ソフトでの外部処理番号が必要です');
    if (h.action === 'no_charge' && input.note.trim() === '' && input.externalRef.trim() === '')
      throw new RepoError('validation', '請求なしの場合は反映内容または反映不要の理由を入力してください');
    const t = transitionCheck('ack_close', issue.status, ctx.actor.role);
    if (!t.ok) throw new RepoError(t.code, t.reason);
    h.ackAt = ctx.now;
    h.ackBy = ctx.actor.userId;
    h.externalRef = input.externalRef.trim() || null;
    h.note = input.note.trim() || null;
    const before = { ...issue };
    issue.status = 'closed';
    issue.version += 1;
    issue.externalCorrectionPending = false;
    // 受領で issue.version が進むため、この handoff の承認版は「受領済み」として記録に残る
    DemoServer.event(ctx, issue, 'ack', `事務受領：${h.externalRef ?? ''}${h.note ? `（${h.note}）` : ''}`);
    DemoServer.audit(ctx, 'handoff', h.id, 'ack', null, h, issue.rentalId);
    DemoServer.audit(ctx, 'issue', issue.id, 'close', before, issue, issue.rentalId);
    return { ackAt: ctx.now };
  }

  reopenIssue(ctx: Ctx, input: { issueId: string; expectedVersion: number; reason: string }) {
    const issue = DemoServer.issue(ctx, input.issueId);
    DemoServer.version(issue.version, input.expectedVersion, issue);
    const t = transitionCheck('reopen', issue.status, ctx.actor.role);
    if (!t.ok) throw new RepoError(t.code, t.reason);
    if (input.reason.trim() === '') throw new RepoError('validation', '再開の理由を入力してください');
    DemoServer.reopenClosed(ctx, issue, input.reason);
    return { version: issue.version };
  }

  closeRental(ctx: Ctx, input: { rentalId: string; expectedVersion: number; externalRef: string; noRefReason: string }) {
    DemoServer.role(ctx, MUTATORS);
    const rental = DemoServer.rental(ctx, input.rentalId);
    DemoServer.version(rental.version, input.expectedVersion, DemoServer.summary(ctx.db, rental));
    const c = DemoServer.closeCheck(ctx.db, rental);
    if (!c.ok) throw new RepoError('validation', c.reasons.join('／'), { reasons: c.reasons });
    if (input.externalRef.trim() === '' && input.noRefReason.trim() === '')
      throw new RepoError('validation', '既存ソフトでの返却反映番号、または反映不要の理由を入力してください');
    const before = { ...rental };
    rental.externalReturnAckAt = ctx.now;
    rental.externalReturnRef = input.externalRef.trim() || null;
    rental.externalReturnNoRefReason = input.noRefReason.trim() || null;
    rental.status = 'closed';
    rental.version += 1;
    DemoServer.audit(ctx, 'rental', rental.id, 'close', before, rental, rental.id);
    return { version: rental.version };
  }

  cancelRental(ctx: Ctx, input: { rentalId: string; expectedVersion: number; reason: string }) {
    DemoServer.role(ctx, MUTATORS);
    const rental = DemoServer.rental(ctx, input.rentalId);
    DemoServer.version(rental.version, input.expectedVersion, DemoServer.summary(ctx.db, rental));
    if (rental.status !== 'open') throw new RepoError('conflict', '未完了の貸出だけ取消できます');
    if (ctx.db.receipts.some((r) => r.rentalId === rental.id))
      throw new RepoError('conflict', '返却記録がある貸出は取消できません（履歴を消さないため）');
    if (input.reason.trim() === '') throw new RepoError('validation', '取消の理由を入力してください');
    const before = { ...rental };
    rental.status = 'cancelled';
    rental.version += 1;
    DemoServer.audit(ctx, 'rental', rental.id, 'cancel', before, { ...rental, reason: input.reason }, rental.id);
    return { version: rental.version };
  }

  correctReceipt(
    ctx: Ctx,
    input: { receiptId: string; rentalExpectedVersion: number; reason: string; lines: { rentalLineId: string; qtyReceived: number; qtyDamaged: number }[] },
  ) {
    DemoServer.role(ctx, MUTATORS);
    const orig = ctx.db.receipts.find((r) => r.id === input.receiptId && r.orgId === ctx.actor.orgId);
    if (!orig) throw new RepoError('not_found', '返却記録が見つかりません');
    if (orig.status !== 'valid' || orig.reversalOf) throw new RepoError('conflict', 'この返却記録は既に取消済みです');
    const rental = DemoServer.rental(ctx, orig.rentalId);
    if (rental.status !== 'open') throw new RepoError('conflict', '完了した貸出は先に関連する例外を再開してください');
    DemoServer.version(rental.version, input.rentalExpectedVersion, DemoServer.summary(ctx.db, rental));
    if (input.reason.trim() === '') throw new RepoError('validation', '訂正理由を入力してください');
    const origLines = ctx.db.receiptLines.filter((l) => l.receiptId === orig.id);
    const touchedLineIds = new Set([...origLines.map((l) => l.rentalLineId), ...input.lines.map((l) => l.rentalLineId)]);
    const locked = ctx.db.issues.filter(
      (i) =>
        (i.status === 'approved' || i.status === 'closed') &&
        ((i.kind === 'damage' && origLines.some((l) => l.id === i.receiptLineId)) ||
          (i.kind === 'missing' && touchedLineIds.has(i.lineId))),
    );
    if (locked.length > 0)
      throw new RepoError('conflict', `承認・完了済みの例外が${locked.length}件あります。先に権限者が再開・差し戻してください`);

    // 取消反転
    orig.status = 'reversed';
    const reversal: Receipt = {
      id: uuid(),
      orgId: ctx.actor.orgId,
      rentalId: rental.id,
      operationId: ctx.opId!,
      receivedAt: ctx.now,
      actorId: ctx.actor.userId,
      status: 'valid',
      reversalOf: orig.id,
      reason: input.reason,
      memo: null,
      createdAt: ctx.now,
    };
    ctx.db.receipts.push(reversal);
    DemoServer.audit(ctx, 'receipt', orig.id, 'reverse_receipt', { status: 'valid' }, { status: 'reversed', reversalId: reversal.id, reason: input.reason }, rental.id);

    // 新規記録（同一トランザクション）
    const lines = ctx.db.rentalLines.filter((l) => l.rentalId === rental.id);
    const effective = input.lines.filter((l) => l.qtyReceived > 0 || l.qtyDamaged > 0);
    let newReceipt: Receipt | null = null;
    const newLineByRental = new Map<string, ReceiptLine>();
    if (effective.length > 0) {
      const current = new Map(lines.map((l) => [l.id, DemoServer.qty(ctx.db, l)]));
      const problems = checkReceiptInput(effective, current, (id) => lines.find((l) => l.id === id)?.unitOriginal ?? '');
      if (problems.length > 0) throw new RepoError('invariant', problems[0]!.message, { problems });
      newReceipt = { ...reversal, id: uuid(), reversalOf: null, reason: `訂正：${input.reason}`, memo: orig.memo };
      ctx.db.receipts.push(newReceipt);
      for (const i of effective) {
        const prev = origLines.find((l) => l.rentalLineId === i.rentalLineId);
        const rl: ReceiptLine = {
          id: uuid(),
          orgId: ctx.actor.orgId,
          receiptId: newReceipt.id,
          rentalLineId: i.rentalLineId,
          qtyReceived: i.qtyReceived,
          qtyDamaged: i.qtyDamaged,
          checklistSnapshot: prev?.checklistSnapshot ?? {},
        };
        ctx.db.receiptLines.push(rl);
        newLineByRental.set(i.rentalLineId, rl);
      }
      DemoServer.audit(ctx, 'receipt', newReceipt.id, 'correct_receipt', null, {
        receipt: newReceipt,
        lines: [...newLineByRental.values()],
        replaces: orig.id,
      }, rental.id);
    }
    for (const l of lines) DemoServer.assertInvariant(ctx.db, l);

    // 破損の付け替え
    for (const ol of origLines) {
      const dmg = ctx.db.issues.find((i) => i.kind === 'damage' && i.receiptLineId === ol.id && isUnclosed(i.status));
      if (!dmg) continue;
      const nl = newLineByRental.get(ol.rentalLineId);
      const before = { ...dmg };
      if (nl && nl.qtyDamaged > 0) {
        dmg.receiptLineId = nl.id;
        dmg.qty = nl.qtyDamaged;
        if (dmg.status === 'review_pending') dmg.status = 'needs_correction';
        dmg.version += 1;
        for (const a of ctx.db.attachments) if (a.receiptLineId === ol.id) a.issueId = a.issueId ?? dmg.id;
        DemoServer.event(ctx, dmg, 'recheck', `返却記録の訂正により破損数を${before.qty}→${nl.qtyDamaged}に更新：${input.reason}`);
      } else {
        // 破損自体が誤記録だった場合。承認を経ずに無効化したことを明示して閉じる。
        dmg.status = 'closed';
        dmg.resolutionCode = 'other';
        dmg.billingAction = 'no_charge';
        dmg.chargeCandidateYen = 0;
        dmg.decisionReason = `返却記録の訂正により破損記録を取消：${input.reason}`;
        dmg.version += 1;
        DemoServer.event(ctx, dmg, 'superseded', dmg.decisionReason);
      }
      DemoServer.audit(ctx, 'issue', dmg.id, 'receipt_corrected', before, dmg, rental.id);
    }
    for (const [lineId, nl] of newLineByRental) {
      if (nl.qtyDamaged === 0) continue;
      const linked = ctx.db.issues.some((i) => i.kind === 'damage' && i.receiptLineId === nl.id);
      if (!linked) {
        const line = lines.find((l) => l.id === lineId)!;
        DemoServer.createIssue(ctx, rental, line, 'damage', nl.qtyDamaged, nl.id, `${line.itemNameOriginal} 破損${nl.qtyDamaged}${line.unitOriginal}（訂正で追加）`);
      }
    }
    for (const l of lines.filter((x) => touchedLineIds.has(x.id))) DemoServer.syncMissing(ctx, rental, l, 'recheck');
    rental.version += 1;
    return { reversalId: reversal.id, newReceiptId: newReceipt?.id ?? null };
  }

  changeQtyOut(ctx: Ctx, input: { lineId: string; expectedVersion: number; qtyOut: number; reason: string }) {
    DemoServer.role(ctx, ['admin']);
    const line = DemoServer.line(ctx, input.lineId);
    DemoServer.version(line.version, input.expectedVersion, line);
    const rental = DemoServer.rental(ctx, line.rentalId);
    if (rental.status !== 'open') throw new RepoError('conflict', '未完了の貸出だけ数量を変更できます');
    if (input.reason.trim() === '') throw new RepoError('validation', '数量変更の理由を入力してください');
    const q = DemoServer.qty(ctx.db, line);
    if (!Number.isInteger(input.qtyOut) || input.qtyOut < 1 || input.qtyOut > 9999)
      throw new RepoError('validation', '貸出数は1～9999の整数です');
    if (input.qtyOut < q.returned + q.lost)
      throw new RepoError('invariant', `貸出数は返却済み＋紛失（${q.returned + q.lost}）未満にできません`);
    const before = { ...line };
    line.qtyOut = input.qtyOut;
    line.version += 1;
    DemoServer.audit(ctx, 'rental_line', line.id, 'change_qty_out', before, { ...line, reason: input.reason }, rental.id);
    for (const i of ctx.db.issues.filter((x) => x.lineId === line.id && (x.status === 'review_pending' || x.status === 'approved'))) {
      const b = { ...i };
      if (i.status === 'approved') DemoServer.revokeHandoffs(ctx, i, '貸出数の変更');
      i.status = 'needs_correction';
      i.version += 1;
      DemoServer.event(ctx, i, 'recheck', `貸出数の変更（${before.qtyOut}→${input.qtyOut}）により再確認：${input.reason}`);
      DemoServer.audit(ctx, 'issue', i.id, 'recheck', b, i, rental.id);
    }
    DemoServer.syncMissing(ctx, rental, line, 'recheck');
    rental.version += 1;
    return { version: line.version };
  }

  // ---- 取込 ----

  private static existingForImport(db: DemoDb, orgId: string): ExistingRental[] {
    return db.rentals
      .filter((r) => r.orgId === orgId)
      .map((r) => ({
        id: r.id,
        sourceSystem: r.sourceSystem,
        externalRentalIdOriginal: r.externalRentalIdOriginal,
        externalRentalIdSearch: r.externalRentalIdSearch,
        customerLabelOriginal: r.customerLabelOriginal,
        siteCode: db.sites.find((s) => s.id === r.siteId)?.code ?? '',
        dueAt: r.dueAt,
        version: r.version,
        status: r.status,
        hasReceipts: db.receipts.some((x) => x.rentalId === r.id),
        lines: db.rentalLines.filter((l) => l.rentalId === r.id),
      }));
  }

  validateImport(userId: string, orgId: string, fileName: string, bytes: Uint8Array) {
    const actor = this.actorOf(userId, orgId);
    if (actor.role === 'operator') throw new RepoError('forbidden', '取込は事務・管理者のみ行えます');
    const sha = sha256Hex(bytes);
    const committed = this.db.imports.find((i) => i.orgId === orgId && i.sha256 === sha && i.status === 'committed');
    if (committed) return { importId: committed.id, validation: structuredClone(committed.validation), reused: true };
    const validation = validateImport(bytes, {
      siteCodes: this.db.sites.filter((s) => s.orgId === orgId && s.active).map((s) => s.code),
      existing: DemoServer.existingForImport(this.db, orgId),
    });
    const rec = {
      id: uuid(),
      orgId,
      sha256: sha,
      fileName: fileName.slice(0, 200),
      status: validation.ok ? ('validated' as const) : ('failed' as const),
      rowCount: validation.rowCount,
      errorReport: validation.issues,
      summary: validation.summary,
      createdBy: userId,
      createdAt: this.clock().toISOString(),
      validation,
      bytesB64: b64(bytes),
    };
    this.db = { ...this.db, imports: [...this.db.imports, rec] };
    return { importId: rec.id, validation: structuredClone(validation), reused: false };
  }

  commitImport(ctx: Ctx, input: { importId: string }) {
    DemoServer.role(ctx, MUTATORS);
    const rec = ctx.db.imports.find((i) => i.id === input.importId && i.orgId === ctx.actor.orgId);
    if (!rec) throw new RepoError('not_found', '取込が見つかりません');
    const already = ctx.db.imports.find((i) => i.orgId === rec.orgId && i.sha256 === rec.sha256 && i.status === 'committed');
    if (already) return { importId: already.id, summary: already.summary };
    if (rec.status !== 'validated') throw new RepoError('validation', 'エラーのある取込は確定できません。元ファイルを直して再検証してください');
    // サーバー側で再検証（検証後の他者更新を検出）
    const v = validateImport(unb64(rec.bytesB64), {
      siteCodes: ctx.db.sites.filter((s) => s.orgId === rec.orgId && s.active).map((s) => s.code),
      existing: DemoServer.existingForImport(ctx.db, rec.orgId),
    });
    if (!v.ok) throw new RepoError('validation', '再検証でエラーが見つかりました。もう一度検証してください', { issues: v.issues });
    for (const d of v.diffs) {
      const prev = rec.validation.diffs.find((x) => x.key === d.key);
      if (prev && prev.expectedVersion !== d.expectedVersion)
        throw new RepoError('conflict', `検証後に貸出「${d.rental.rentalId}」が更新されました。もう一度検証してください`);
    }
    for (const d of v.diffs) {
      if (d.kind === 'unchanged') continue;
      const site = ctx.db.sites.find((s) => s.orgId === rec.orgId && s.code === d.rental.siteCode)!;
      if (d.kind === 'add') {
        const r: Rental = {
          id: uuid(),
          orgId: rec.orgId,
          siteId: site.id,
          sourceSystem: d.rental.sourceSystem,
          externalRentalIdOriginal: d.rental.rentalId,
          externalRentalIdSearch: searchKey(d.rental.rentalId),
          customerLabelOriginal: d.rental.customerLabel,
          customerLabelSearch: searchKey(d.rental.customerLabel),
          dueAt: d.rental.dueAt,
          status: 'open',
          version: 1,
          externalReturnAckAt: null,
          externalReturnRef: null,
          externalReturnNoRefReason: null,
          createdAt: ctx.now,
        };
        ctx.db.rentals.push(r);
        for (const l of d.rental.lines) {
          ctx.db.rentalLines.push({
            id: uuid(),
            orgId: rec.orgId,
            rentalId: r.id,
            externalLineIdOriginal: l.lineId,
            itemCodeOriginal: l.itemCode,
            itemNameOriginal: l.itemName,
            unitOriginal: l.unit,
            qtyOut: l.qtyOut,
            version: 1,
          });
        }
        DemoServer.audit(ctx, 'rental', r.id, 'import_add', null, { rental: r, importId: rec.id }, r.id);
      } else {
        const r = DemoServer.rental(ctx, d.existingId!);
        const before = { ...r };
        r.customerLabelOriginal = d.rental.customerLabel;
        r.customerLabelSearch = searchKey(d.rental.customerLabel);
        r.siteId = site.id;
        r.dueAt = d.rental.dueAt;
        for (const l of d.rental.lines) {
          const el = ctx.db.rentalLines.find((x) => x.rentalId === r.id && x.externalLineIdOriginal === l.lineId);
          if (el) {
            if (el.qtyOut !== l.qtyOut || el.itemNameOriginal !== l.itemName || el.itemCodeOriginal !== l.itemCode || el.unitOriginal !== l.unit) {
              el.qtyOut = l.qtyOut;
              el.itemNameOriginal = l.itemName;
              el.itemCodeOriginal = l.itemCode;
              el.unitOriginal = l.unit;
              el.version += 1;
            }
          } else {
            ctx.db.rentalLines.push({
              id: uuid(),
              orgId: rec.orgId,
              rentalId: r.id,
              externalLineIdOriginal: l.lineId,
              itemCodeOriginal: l.itemCode,
              itemNameOriginal: l.itemName,
              unitOriginal: l.unit,
              qtyOut: l.qtyOut,
              version: 1,
            });
          }
        }
        r.version += 1;
        DemoServer.audit(ctx, 'rental', r.id, 'import_change', before, { rental: r, changes: d.changes, importId: rec.id }, r.id);
      }
    }
    rec.status = 'committed';
    return { importId: rec.id, summary: rec.summary };
  }

  // ---- 設定・メンバー ----

  updateChecklist(ctx: Ctx, input: { expectedVersion: number; items: ChecklistItem[] }) {
    DemoServer.role(ctx, ['admin']);
    const s = ctx.db.settings.find((x) => x.orgId === ctx.actor.orgId)!;
    DemoServer.version(s.version, input.expectedVersion, s);
    if (input.items.length > 10) throw new RepoError('validation', 'チェック項目は10個までです');
    for (const i of input.items) {
      if (i.label.trim() === '' || i.label.length > 40) throw new RepoError('validation', 'チェック項目は1～40字の文字で入力してください');
      if (/[<>]/.test(i.label)) throw new RepoError('validation', 'チェック項目に < > は使えません（HTMLやコードは登録できません）');
    }
    const before = structuredClone(s);
    s.checklist = input.items.map((i) => ({ id: i.id || uuid(), label: i.label }));
    s.version += 1;
    DemoServer.audit(ctx, 'settings', ctx.actor.orgId, 'update_checklist', before, s, null);
    return { version: s.version };
  }

  private static activeAdmins(db: DemoDb, orgId: string) {
    return db.members.filter((m) => m.orgId === orgId && m.active && m.role === 'admin');
  }

  setMemberRole(ctx: Ctx, input: { userId: string; role: Role }) {
    DemoServer.role(ctx, ['admin']);
    const m = ctx.db.members.find((x) => x.userId === input.userId && x.orgId === ctx.actor.orgId);
    if (!m) throw new RepoError('not_found', 'メンバーが見つかりません');
    if (m.role === 'admin' && input.role !== 'admin' && DemoServer.activeAdmins(ctx.db, m.orgId).length <= 1)
      throw new RepoError('validation', '最後の有効な管理者の役割は変更できません');
    const before = { ...m };
    m.role = input.role;
    DemoServer.audit(ctx, 'membership', m.userId, 'set_role', before, m, null);
    return { ok: true as const };
  }

  stopMember(ctx: Ctx, input: { userId: string; reassignTo: string | null }) {
    DemoServer.role(ctx, ['admin']);
    const m = ctx.db.members.find((x) => x.userId === input.userId && x.orgId === ctx.actor.orgId);
    if (!m) throw new RepoError('not_found', 'メンバーが見つかりません');
    if (!m.active) throw new RepoError('conflict', '既に停止しています');
    if (m.role === 'admin' && DemoServer.activeAdmins(ctx.db, m.orgId).length <= 1)
      throw new RepoError('validation', '最後の有効な管理者は停止できません');
    const owned = ctx.db.issues.filter((i) => i.orgId === m.orgId && i.ownerUserId === m.userId && isUnclosed(i.status));
    if (owned.length > 0) {
      const to = ctx.db.members.find((x) => x.userId === input.reassignTo && x.orgId === m.orgId && x.active && x.userId !== m.userId);
      if (!to) throw new RepoError('validation', `未完了の担当案件が${owned.length}件あります。引き継ぎ先を選んでください`);
      for (const i of owned) {
        const b = { ...i };
        i.ownerUserId = to.userId;
        i.version += 1;
        DemoServer.event(ctx, i, 'assign', `担当：${m.displayName}（停止）→ ${to.displayName}`);
        DemoServer.audit(ctx, 'issue', i.id, 'reassign_on_stop', b, i, i.rentalId);
      }
    }
    const before = { ...m };
    m.active = false; // 履歴の actor は消さない
    DemoServer.audit(ctx, 'membership', m.userId, 'stop', before, m, null);
    return { reassigned: owned.length };
  }

  // ---- 出力 ----

  rentalsCsv(ctx: Ctx): FileOut {
    DemoServer.role(ctx, MUTATORS);
    const db = ctx.db;
    const rows: (string | number | null)[][] = [];
    for (const r of db.rentals.filter((x) => x.orgId === ctx.actor.orgId)) {
      for (const l of db.rentalLines.filter((x) => x.rentalId === r.id)) {
        const q = DemoServer.qty(db, l);
        rows.push([
          r.sourceSystem,
          r.externalRentalIdOriginal,
          r.customerLabelOriginal,
          db.sites.find((s) => s.id === r.siteId)?.code ?? '',
          r.dueAt,
          r.status,
          l.externalLineIdOriginal,
          l.itemCodeOriginal,
          l.itemNameOriginal,
          l.unitOriginal,
          l.qtyOut,
          q.returned,
          q.lost,
          q.outstanding,
          q.damaged,
          r.externalReturnRef,
        ]);
      }
    }
    return {
      fileName: 'rentals.csv',
      mime: 'text/csv',
      data: toCsv(
        ['source_system', 'rental_id', 'customer_label', 'site_code', 'due_at', 'status', 'line_id', 'item_code', 'item_name', 'unit', 'qty_out', 'returned', 'lost', 'outstanding', 'damaged_within_returned', 'external_return_ref'],
        rows,
      ),
    };
  }

  historyJson(ctx: Ctx, rentalId: string): FileOut {
    DemoServer.role(ctx, MUTATORS);
    const detail = this.rentalDetail(ctx, rentalId);
    const issues = detail.issues.map((i) => this.issueDetail(ctx, i.id));
    const audit = ctx.db.auditEvents.filter((a) => a.rentalId === rentalId);
    return {
      fileName: `history_${detail.rental.externalRentalIdSearch.replace(/[^a-z0-9_-]/g, '_')}.json`,
      mime: 'application/json',
      data: JSON.stringify({ note: '原文をそのまま含みます（CSVの安全用変換なし）', rental: detail, issues, audit }, null, 2),
    };
  }

  dataReturn(ctx: Ctx): FileOut {
    DemoServer.role(ctx, ['admin']);
    const orgId = ctx.actor.orgId;
    const db = ctx.db;
    const own = <T extends { orgId: string }>(xs: T[]) => xs.filter((x) => x.orgId === orgId);
    const entries: ZipEntry[] = [];
    const rentalsCsv = this.rentalsCsv(ctx);
    entries.push({ path: 'rentals.csv', data: rentalsCsv.data });
    const raw = {
      organization: db.orgs.find((o) => o.id === orgId),
      members: own(db.members).map((m) => ({ userId: m.userId, displayName: m.displayName, role: m.role, active: m.active })),
      sites: own(db.sites),
      settings: own(db.settings),
      rentals: own(db.rentals),
      rentalLines: own(db.rentalLines),
      receipts: own(db.receipts),
      receiptLines: own(db.receiptLines),
      issues: own(db.issues),
      lossResolutions: own(db.lossResolutions),
      issueEvents: own(db.issueEvents),
      attachments: own(db.attachments),
      handoffs: own(db.handoffs),
      imports: own(db.imports).map(({ bytesB64: _b, validation: _v, ...rest }) => rest),
      auditEvents: own(db.auditEvents),
    };
    entries.push({ path: 'data.json', data: JSON.stringify(raw, null, 2) });
    const manifest: { path: string; sha256: string; bytes: number }[] = [];
    for (const a of own(db.attachments).filter((x) => x.status === 'ready')) {
      if (!a.objectKey.startsWith(`${orgId}/`)) continue;
      const bytes = this.objects.get(a.objectKey);
      if (!bytes) continue;
      const path = `photos/${a.id}.jpg`;
      entries.push({ path, data: bytes });
      manifest.push({ path, sha256: sha256Hex(bytes), bytes: bytes.length });
    }
    for (const e of [...entries]) {
      if (e.path.startsWith('photos/')) continue;
      const d = typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data;
      manifest.push({ path: e.path, sha256: sha256Hex(d), bytes: d.length });
    }
    entries.push({ path: 'manifest.json', data: JSON.stringify({ generatedAt: ctx.now, orgId, files: manifest }, null, 2) });
    entries.push({
      path: 'README.txt',
      data: [
        '返却デスク（仮称）データ返却ファイル',
        '※Stage A 検証用デモで生成したサンプルです。実データではありません。',
        '',
        'rentals.csv  … 貸出と数量（UTF-8 BOM付き）。' + CSV_SAFETY_NOTE,
        'data.json    … 全業務データの原文（変換なし）。',
        'photos/      … 縮小済みJPEG（位置情報なし）。',
        'manifest.json… 各ファイルの sha256。',
        '他の組織のユーザー情報・写真は含みません。',
      ].join('\r\n'),
    });
    return { fileName: `data_return_${ctx.now.slice(0, 10)}.zip`, mime: 'application/zip', data: buildZip(entries) };
  }
}

function describeAudit(a: AuditEvent, db: DemoDb): Omit<HistoryEntry, 'at' | 'actorName' | 'operationId'> {
  const after = (a.afterSnapshot ?? {}) as Record<string, unknown>;
  const before = (a.beforeSnapshot ?? {}) as Record<string, unknown>;
  const lineName = (id: unknown) => db.rentalLines.find((l) => l.id === id)?.itemNameOriginal ?? '';
  switch (a.action) {
    case 'submit_receipt': {
      const lines = (after.lines as ReceiptLine[]) ?? [];
      return {
        category: 'receipt',
        title: '返却を記録',
        detail: lines.map((l) => `${lineName(l.rentalLineId)} 返却${l.qtyReceived}${l.qtyDamaged ? `（うち破損${l.qtyDamaged}）` : ''}`).join('、'),
      };
    }
    case 'reverse_receipt':
      return { category: 'receipt', title: '返却記録を取消反転（訂正）', detail: `理由：${String(after.reason ?? '')}` };
    case 'correct_receipt': {
      const lines = (after.lines as ReceiptLine[]) ?? [];
      return { category: 'receipt', title: '訂正後の返却記録', detail: lines.map((l) => `${lineName(l.rentalLineId)} 返却${l.qtyReceived}（破損${l.qtyDamaged}）`).join('、') };
    }
    case 'create':
      if (a.entityType === 'issue') return { category: 'issue', title: '例外を作成', detail: String(after.summary ?? '') };
      return { category: 'handoff', title: '事務引き渡しを作成', detail: `承認版 v${String(after.approvedVersion)}・${after.action === 'charge_candidate' ? `請求候補 ${Number(after.chargeCandidateYen).toLocaleString('ja-JP')}円` : '請求なし'}` };
    case 'approve':
      return { category: 'issue', title: '責任者が承認', detail: `${String(after.decisionReason ?? '')}` };
    case 'send_back':
    case 'revoke_approval':
      return { category: 'issue', title: a.action === 'send_back' ? '差し戻し' : '承認を取り消して差し戻し', detail: '' };
    case 'export':
      return { category: 'export', title: 'CSVに出力（未受領）', detail: `承認版 v${String(after.approvedVersion)}・${String(after.exportCount)}回目の出力` };
    case 'ack':
      return { category: 'handoff', title: '事務が受領（既存ソフトへ反映）', detail: `外部番号：${String(after.externalRef ?? 'なし')}${after.note ? `／${String(after.note)}` : ''}` };
    case 'revoke':
      return { category: 'handoff', title: '引き渡しを取消（旧版CSVは使用不可）', detail: String(after.revokedReason ?? '') };
    case 'close':
      if (a.entityType === 'rental')
        return { category: 'rental', title: '既存ソフトへの返却反映を確認して完了', detail: `外部番号：${String(after.externalReturnRef ?? 'なし')}${after.externalReturnNoRefReason ? `／反映不要：${String(after.externalReturnNoRefReason)}` : ''}` };
      return { category: 'issue', title: '例外を完了', detail: '' };
    case 'reopen':
      return { category: a.entityType === 'rental' ? 'rental' : 'issue', title: a.entityType === 'rental' ? '貸出を再開（返却反映の再確認が必要）' : '完了後に再開（改訂）', detail: '' };
    case 'resolve_loss':
      return { category: 'loss', title: '紛失扱いを記録', detail: `${String(after.qtyLost)}・理由：${String(after.reason)}` };
    case 'reverse_loss':
      return { category: 'loss', title: '紛失扱いを反転', detail: `理由：${String(after.reverseReason)}` };
    case 'assign':
    case 'reassign_on_stop':
      return { category: 'issue', title: '担当を変更', detail: '' };
    case 'cancel':
      return { category: 'rental', title: '貸出を取消', detail: String(after.reason ?? '') };
    case 'import_add':
      return { category: 'import', title: 'CSV取込で追加', detail: '' };
    case 'import_change':
      return { category: 'import', title: 'CSV取込で変更', detail: ((after.changes as string[]) ?? []).join('、') };
    case 'change_qty_out':
      return { category: 'rental', title: '貸出数を変更（管理者）', detail: `${String(before.qtyOut)}→${String(after.qtyOut)}・理由：${String(after.reason)}` };
    case 'auto_review_pending':
      return { category: 'issue', title: '未返却0のため確認待ちへ', detail: '' };
    case 'photo_skip':
      return { category: 'issue', title: '写真なしで記録（承認不可）', detail: String(after.photoSkipReason ?? '') };
    default:
      return { category: a.entityType === 'issue' ? 'issue' : 'rental', title: a.action, detail: '' };
  }
}
