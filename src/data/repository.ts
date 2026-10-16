// Stage A（demo）と Stage B（supabase）が共有する Repository インターフェース。
// 画面はこのインターフェースだけに依存する。重要更新は operation_id と expected_version を必ず渡す。
import type { LineQuantities } from '../domain/quantity';
import type { ImportValidation } from '../domain/csvImport';
import type {
  Attachment,
  BillingAction,
  ChecklistItem,
  ContactChannel,
  Handoff,
  ImportRecord,
  Issue,
  IssueEvent,
  LossResolution,
  Member,
  Organization,
  Receipt,
  ReceiptLine,
  Rental,
  RentalLine,
  ResolutionCode,
  Role,
  Settings,
  Site,
} from '../domain/types';

export interface Session {
  userId: string;
  orgId: string;
  displayName: string;
  role: Role;
  persist: boolean;
}

export type RentalStage =
  | 'not_started'
  | 'partial'
  | 'issues_open'
  | 'awaiting_ack'
  | 'closed'
  | 'cancelled';

export interface RentalSummary {
  rental: Rental;
  siteName: string;
  lineCount: number;
  totalOut: number;
  totalOutstanding: number;
  openIssueCount: number;
  hasReceipts: boolean;
  stage: RentalStage;
  /** 最初の品名（一覧の補助表示） */
  firstItemName: string;
}

export interface LineView extends RentalLine {
  q: LineQuantities;
}

export interface ReceiptView extends Receipt {
  lines: ReceiptLine[];
  actorName: string;
}

export interface CloseCheck {
  ok: boolean;
  reasons: string[];
}

export interface RentalDetail {
  rental: Rental;
  site: Site;
  lines: LineView[];
  receipts: ReceiptView[];
  issues: Issue[];
  closeCheck: CloseCheck;
}

export interface IssueListRow {
  issue: Issue;
  rentalNumber: string;
  customerLabel: string;
  itemName: string;
  unit: string;
  ownerName: string;
  ownerActive: boolean;
  outstanding: number;
  overdue: boolean;
}

export interface IssueEventView extends IssueEvent {
  actorName: string;
}

export interface IssueDetail {
  issue: Issue;
  rental: Rental;
  line: LineView;
  ownerName: string;
  events: IssueEventView[];
  attachments: Attachment[];
  handoffs: Handoff[];
  losses: LossResolution[];
}

export interface HandoffRow {
  handoff: Handoff;
  issue: Issue;
  rentalNumber: string;
  customerLabel: string;
  itemName: string;
  unit: string;
  ackByName: string | null;
  /** 承認版が現行か（取消・改訂されていないか） */
  current: boolean;
}

export interface HistoryEntry {
  at: string;
  actorName: string;
  category: 'receipt' | 'issue' | 'handoff' | 'export' | 'rental' | 'loss' | 'import' | 'settings';
  title: string;
  detail: string;
  operationId: string | null;
}

export interface OrgOverview {
  org: Organization;
  sites: Site[];
  settings: Settings;
  members: Member[];
}

export interface PhotoData {
  bytes: Uint8Array;
  mime: string;
  /** 署名URL相当の有効期限（60秒）。 */
  expiresAt: string;
}

export interface FileOut {
  fileName: string;
  mime: string;
  data: Uint8Array | string;
}

// ---- 入力 ----

export interface SubmitReceiptInput {
  rentalId: string;
  expectedVersion: number;
  lines: { rentalLineId: string; qtyReceived: number; qtyDamaged: number; checklist: Record<string, boolean> }[];
  memo: string;
}
export interface SubmitReceiptResult {
  receiptId: string;
  receivedAt: string;
  rentalVersion: number;
  receiptLineIds: Record<string, string>; // rentalLineId → receiptLineId
  damageIssueIds: Record<string, string>; // rentalLineId → issueId
  missingIssueIds: string[];
}

export interface CreateAttachmentInput {
  issueId: string | null;
  receiptLineId: string | null;
  byteSize: number;
  mime: string;
  imageWidth: number;
  imageHeight: number;
  sha256: string;
}

export type SubmitIssueAction = 'to_waiting' | 'request_review' | 'photo_skip';

export interface ReviewInput {
  issueId: string;
  expectedVersion: number;
  decision: 'approve' | 'send_back' | 'revoke';
  resolutionCode: ResolutionCode | null;
  billingAction: BillingAction | null;
  chargeCandidateYen: number | null;
  decisionReason: string;
}

export interface MutationLookup {
  found: boolean;
  result?: unknown;
  createdAt?: string;
}

export interface Repository {
  readonly mode: 'demo' | 'pilot';

  // 認証
  login(userId: string, persist: boolean): Promise<Session>;
  logout(): Promise<void>;
  currentSession(): Session | null;
  listLoginCandidates(): Promise<Member[]>;

  // 参照
  getOverview(): Promise<OrgOverview>;
  listRentalsForDate(ymd: string): Promise<RentalSummary[]>;
  searchRentals(q: { query: string; mode: 'today' | 'open'; ymd: string }): Promise<RentalSummary[]>;
  getRental(rentalId: string): Promise<RentalDetail>;
  listIssues(): Promise<IssueListRow[]>;
  getIssue(issueId: string): Promise<IssueDetail>;
  listHandoffs(): Promise<HandoffRow[]>;
  listRentalsAwaitingAck(): Promise<RentalSummary[]>;
  getHistory(rentalId: string): Promise<HistoryEntry[]>;
  getPhoto(attachmentId: string): Promise<PhotoData>;
  listImports(): Promise<ImportRecord[]>;
  lookupOperation(operationId: string): Promise<MutationLookup>;

  // 更新（全て operation_id 付き。同じIDの再送は同じ結果）
  submitReceipt(opId: string, input: SubmitReceiptInput): Promise<SubmitReceiptResult>;
  createAttachment(opId: string, input: CreateAttachmentInput): Promise<{ attachmentId: string; objectKey: string }>;
  uploadAttachment(attachmentId: string, bytes: Uint8Array): Promise<{ status: 'ready' }>;
  submitIssue(
    opId: string,
    input: { issueId: string; expectedVersion: number; action: SubmitIssueAction; note: string },
  ): Promise<{ version: number }>;
  assignIssue(
    opId: string,
    input: { issueId: string; expectedVersion: number; ownerUserId: string; dueAt: string; note: string },
  ): Promise<{ version: number }>;
  addContactRecord(
    opId: string,
    input: {
      issueId: string;
      channel: ContactChannel;
      contactedAt: string;
      outcome: string;
      note: string;
      correctsEventId: string | null;
    },
  ): Promise<{ eventId: string }>;
  reviewIssue(opId: string, input: ReviewInput): Promise<{ version: number; handoffId: string | null }>;
  resolveLoss(
    opId: string,
    input: { issueId: string; expectedVersion: number; qtyLost: number; reason: string },
  ): Promise<{ lossId: string; version: number }>;
  reverseLoss(opId: string, input: { lossId: string; reason: string }): Promise<{ ok: true }>;
  exportHandoffs(opId: string, input: { handoffIds: string[] }): Promise<{ file: FileOut; exportedAt: string }>;
  ackHandoff(
    opId: string,
    input: { handoffId: string; externalRef: string; note: string },
  ): Promise<{ ackAt: string }>;
  reopenIssue(opId: string, input: { issueId: string; expectedVersion: number; reason: string }): Promise<{ version: number }>;
  closeRental(
    opId: string,
    input: { rentalId: string; expectedVersion: number; externalRef: string; noRefReason: string },
  ): Promise<{ version: number }>;
  cancelRental(opId: string, input: { rentalId: string; expectedVersion: number; reason: string }): Promise<{ version: number }>;
  correctReceipt(
    opId: string,
    input: {
      receiptId: string;
      rentalExpectedVersion: number;
      reason: string;
      lines: { rentalLineId: string; qtyReceived: number; qtyDamaged: number }[];
    },
  ): Promise<{ reversalId: string; newReceiptId: string | null }>;
  changeQtyOut(
    opId: string,
    input: { lineId: string; expectedVersion: number; qtyOut: number; reason: string },
  ): Promise<{ version: number }>;

  validateImport(fileName: string, bytes: Uint8Array): Promise<{ importId: string; validation: ImportValidation; reused: boolean }>;
  commitImport(opId: string, input: { importId: string }): Promise<{ importId: string; summary: ImportRecord['summary'] }>;

  updateChecklist(opId: string, input: { expectedVersion: number; items: ChecklistItem[] }): Promise<{ version: number }>;
  setMemberRole(opId: string, input: { userId: string; role: Role }): Promise<{ ok: true }>;
  stopMember(opId: string, input: { userId: string; reassignTo: string | null }): Promise<{ reassigned: number }>;

  exportRentalsCsv(): Promise<FileOut>;
  exportHistoryJson(rentalId: string): Promise<FileOut>;
  exportDataReturn(): Promise<FileOut>;
}
