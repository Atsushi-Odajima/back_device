// Stage A の Repository 実装。メモリ内サーバーの前に「通信」を模擬する層を置く。
// 通信失敗スイッチで、未到達・タイムアウト（サーバー確定済み）・写真失敗・セッション切れを再現する。
import { RepoError } from '../../domain/errors';
import { uuid } from '../../domain/ids';
import type { Member } from '../../domain/types';
import type { Repository, Session } from '../repository';
import type { DemoServer } from './demoServer';
import { createSeededServer, DEMO_ORG_ID, USERS } from './seed';

export interface NetworkControls {
  /** 全通信を失敗させる（機内モード相当） */
  offline: boolean;
  /** 応答を3秒遅らせる（「画面を閉じずにお待ちください」の確認） */
  slow: boolean;
  /** 次の保存1回：network=サーバー未到達、timeout=サーバーは確定したが応答が届かない */
  nextMutation: 'none' | 'network' | 'timeout';
  /** 次の写真送信1回を失敗させる */
  nextPhotoFail: boolean;
  /** セッション切れ（再認証まで全要求が 401） */
  sessionExpired: boolean;
}

export const defaultControls = (): NetworkControls => ({
  offline: false,
  slow: false,
  nextMutation: 'none',
  nextPhotoFail: false,
  sessionExpired: false,
});

/** セッション保存先。既定はメモリ（共有端末向け）。明示選択時のみ sessionStorage。 */
interface SessionAdapter {
  load(): string | null;
  save(userId: string | null): void;
}
const memoryAdapter = (): SessionAdapter => {
  let v: string | null = null;
  return { load: () => v, save: (x) => void (v = x) };
};
const SESSION_KEY = 'return-desk.demo.user';
const sessionStorageAdapter: SessionAdapter = {
  load: () => {
    try {
      return globalThis.sessionStorage?.getItem(SESSION_KEY) ?? null;
    } catch {
      return null;
    }
  },
  save: (x) => {
    try {
      if (x) globalThis.sessionStorage?.setItem(SESSION_KEY, x);
      else globalThis.sessionStorage?.removeItem(SESSION_KEY);
    } catch {
      /* 保存できない環境では無視（メモリのみ） */
    }
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DemoRepository implements Repository {
  readonly mode = 'demo' as const;
  server: DemoServer;
  controls: NetworkControls = defaultControls();
  private session: Session | null = null;
  private listeners = new Set<() => void>();
  private latencyMs: number;
  private memory = memoryAdapter();

  constructor(opts: { server?: DemoServer; latencyMs?: number } = {}) {
    this.server = opts.server ?? createSeededServer();
    this.latencyMs = opts.latencyMs ?? 180;
    const persisted = sessionStorageAdapter.load();
    if (persisted) {
      const m = this.server.db.members.find((x) => x.userId === persisted && x.active);
      if (m) this.session = this.toSession(m, true);
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
  setControls(patch: Partial<NetworkControls>) {
    this.controls = { ...this.controls, ...patch };
    this.emit();
  }

  private toSession(m: Member, persist: boolean): Session {
    return { userId: m.userId, orgId: m.orgId, displayName: m.displayName, role: m.role, persist };
  }

  private requireSession(): Session {
    if (!this.session) throw new RepoError('session_expired', 'ログインしてください');
    return this.session;
  }

  /** 通信の模擬。kind=mutation のみ「次の保存」スイッチを消費する。 */
  private async call<T>(kind: 'read' | 'mutation' | 'upload', fn: (s: Session) => T): Promise<T> {
    await sleep(this.controls.slow ? 3000 : this.latencyMs);
    if (this.controls.offline) throw new RepoError('network', '通信できません。電波の良い場所で再接続してから、もう一度確認してください。');
    const s = this.requireSession();
    if (this.controls.sessionExpired) throw new RepoError('session_expired', 'ログインの有効期限が切れました。再ログイン後に確認して再提出してください。');
    if (kind === 'mutation' && this.controls.nextMutation === 'network') {
      this.setControls({ nextMutation: 'none' });
      throw new RepoError('network', '通信できませんでした。サーバーには届いていません。');
    }
    if (kind === 'upload' && this.controls.nextPhotoFail) {
      this.setControls({ nextPhotoFail: false });
      throw new RepoError('network', '写真の送信に失敗しました。同じ写真をもう一度送信できます。');
    }
    const result = fn(s); // サーバー側で確定
    if (kind === 'mutation' && this.controls.nextMutation === 'timeout') {
      this.setControls({ nextMutation: 'none' });
      throw new RepoError('timeout', '応答がありません。保存できたかを確認します。');
    }
    return structuredClone(result);
  }

  private read<T>(fn: Parameters<DemoServer['read']>[2]): Promise<T> {
    return this.call('read', (s) => this.server.read(s.userId, s.orgId, fn) as T);
  }
  private mut<T>(name: string, opId: string, body: unknown, fn: Parameters<DemoServer['mutate']>[5]): Promise<T> {
    return this.call('mutation', (s) => this.server.mutate(s.userId, s.orgId, name, opId, body, fn) as T);
  }

  // ---- 認証（デモ：架空担当者を選ぶ） ----
  async login(userId: string, persist: boolean) {
    await sleep(this.latencyMs);
    const m = this.server.db.members.find((x) => x.userId === userId);
    if (!m || !m.active) throw new RepoError('forbidden', 'このユーザーは停止されています');
    this.session = this.toSession(m, persist);
    this.controls = { ...this.controls, sessionExpired: false };
    (persist ? sessionStorageAdapter : this.memory).save(userId);
    if (!persist) sessionStorageAdapter.save(null);
    this.emit();
    return this.session;
  }
  async logout() {
    this.session = null;
    sessionStorageAdapter.save(null);
    this.memory.save(null);
    this.emit();
  }
  currentSession() {
    return this.session;
  }
  async listLoginCandidates() {
    await sleep(this.latencyMs);
    return structuredClone(this.server.db.members);
  }

  // ---- 参照 ----
  getOverview = () => this.read<ReturnType<DemoServer['overview']>>((c) => this.server.overview(c));
  listRentalsForDate = (ymd: string) => this.read<ReturnType<DemoServer['rentalsForDate']>>((c) => this.server.rentalsForDate(c, ymd));
  searchRentals = (q: { query: string; mode: 'today' | 'open'; ymd: string }) =>
    this.read<ReturnType<DemoServer['search']>>((c) => this.server.search(c, q));
  getRental = (id: string) => this.read<ReturnType<DemoServer['rentalDetail']>>((c) => this.server.rentalDetail(c, id));
  listIssues = () => this.read<ReturnType<DemoServer['issueList']>>((c) => this.server.issueList(c));
  getIssue = (id: string) => this.read<ReturnType<DemoServer['issueDetail']>>((c) => this.server.issueDetail(c, id));
  listHandoffs = () => this.read<ReturnType<DemoServer['handoffList']>>((c) => this.server.handoffList(c));
  listRentalsAwaitingAck = () => this.read<ReturnType<DemoServer['awaitingAck']>>((c) => this.server.awaitingAck(c));
  getHistory = (id: string) => this.read<ReturnType<DemoServer['history']>>((c) => this.server.history(c, id));
  getPhoto = (id: string) => this.read<ReturnType<DemoServer['photo']>>((c) => this.server.photo(c, id));
  listImports = () =>
    this.read<ReturnType<Repository['listImports']> extends Promise<infer R> ? R : never>((c) =>
      c.db.imports.filter((i) => i.orgId === c.actor.orgId).map(({ bytesB64: _b, validation: _v, ...rest }) => rest),
    );
  lookupOperation = (opId: string) => this.call('read', (s) => this.server.lookup(s.userId, s.orgId, opId));

  // ---- 更新 ----
  submitReceipt: Repository['submitReceipt'] = (op, i) => this.mut('submit_receipt', op, i, (c) => this.server.submitReceipt(c, i));
  createAttachment: Repository['createAttachment'] = (op, i) => this.mut('create_attachment', op, i, (c) => this.server.createAttachment(c, i));
  uploadAttachment: Repository['uploadAttachment'] = (id, bytes) =>
    this.call('upload', (s) => this.server.uploadAttachment(s.userId, s.orgId, id, bytes));
  submitIssue: Repository['submitIssue'] = (op, i) => this.mut('submit_issue', op, i, (c) => this.server.submitIssue(c, i));
  assignIssue: Repository['assignIssue'] = (op, i) => this.mut('assign_issue', op, i, (c) => this.server.assignIssue(c, i));
  addContactRecord: Repository['addContactRecord'] = (op, i) => this.mut('add_contact', op, i, (c) => this.server.addContact(c, i));
  reviewIssue: Repository['reviewIssue'] = (op, i) => this.mut('review_issue', op, i, (c) => this.server.reviewIssue(c, i));
  resolveLoss: Repository['resolveLoss'] = (op, i) => this.mut('resolve_loss', op, i, (c) => this.server.resolveLoss(c, i));
  reverseLoss: Repository['reverseLoss'] = (op, i) => this.mut('reverse_loss', op, i, (c) => this.server.reverseLoss(c, i));
  exportHandoffs: Repository['exportHandoffs'] = (op, i) => this.mut('export_handoffs', op, i, (c) => this.server.exportHandoffs(c, i));
  ackHandoff: Repository['ackHandoff'] = (op, i) => this.mut('ack_handoff', op, i, (c) => this.server.ackHandoff(c, i));
  reopenIssue: Repository['reopenIssue'] = (op, i) => this.mut('reopen_issue', op, i, (c) => this.server.reopenIssue(c, i));
  closeRental: Repository['closeRental'] = (op, i) => this.mut('close_rental', op, i, (c) => this.server.closeRental(c, i));
  cancelRental: Repository['cancelRental'] = (op, i) => this.mut('cancel_rental', op, i, (c) => this.server.cancelRental(c, i));
  correctReceipt: Repository['correctReceipt'] = (op, i) => this.mut('reverse_receipt', op, i, (c) => this.server.correctReceipt(c, i));
  changeQtyOut: Repository['changeQtyOut'] = (op, i) => this.mut('change_qty_out', op, i, (c) => this.server.changeQtyOut(c, i));
  validateImport: Repository['validateImport'] = (name, bytes) =>
    this.call('read', (s) => this.server.validateImport(s.userId, s.orgId, name, bytes));
  commitImport: Repository['commitImport'] = (op, i) => this.mut('commit_import', op, i, (c) => this.server.commitImport(c, i));
  updateChecklist: Repository['updateChecklist'] = (op, i) => this.mut('update_checklist', op, i, (c) => this.server.updateChecklist(c, i));
  setMemberRole: Repository['setMemberRole'] = (op, i) => this.mut('set_member_role', op, i, (c) => this.server.setMemberRole(c, i));
  stopMember: Repository['stopMember'] = (op, i) => this.mut('stop_member', op, i, (c) => this.server.stopMember(c, i));
  exportRentalsCsv = () => this.read<ReturnType<DemoServer['rentalsCsv']>>((c) => this.server.rentalsCsv(c));
  exportHistoryJson = (id: string) => this.read<ReturnType<DemoServer['historyJson']>>((c) => this.server.historyJson(c, id));
  exportDataReturn = () => this.read<ReturnType<DemoServer['dataReturn']>>((c) => this.server.dataReturn(c));

  // ---- デモ専用（pilot ビルドには含めない） ----

  /** 別端末の担当者が同じ貸出に先に返却を保存した状態を作る（409の確認用）。 */
  simulateOtherDeviceReceipt(rentalId: string): string {
    const rental = this.server.db.rentals.find((r) => r.id === rentalId);
    if (!rental) throw new RepoError('not_found', '貸出が見つかりません');
    const other = this.session?.userId === USERS.op2 ? USERS.op1 : USERS.op2;
    const line = this.server.db.rentalLines.find((l) => {
      if (l.rentalId !== rentalId) return false;
      const d = this.server.read(other, DEMO_ORG_ID, (c) => this.server.rentalDetail(c, rentalId));
      return (d.lines.find((x) => x.id === l.id)?.q.outstanding ?? 0) > 0;
    });
    if (!line) throw new RepoError('validation', '未返却の明細がありません');
    this.server.mutate(other, DEMO_ORG_ID, 'submit_receipt', uuid(), { demo: true }, (c) =>
      this.server.submitReceipt(c, {
        rentalId,
        expectedVersion: rental.version,
        lines: [{ rentalLineId: line.id, qtyReceived: 1, qtyDamaged: 0, checklist: {} }],
        memo: '別端末からの返却（デモ）',
      }),
    );
    this.emit();
    return line.itemNameOriginal;
  }

  /** 初期データに戻す（再読込と同じ）。 */
  reset() {
    this.server = createSeededServer();
    this.controls = defaultControls();
    this.emit();
  }
}
