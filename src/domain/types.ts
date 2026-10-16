// 返却デスク（仮称）ドメイン型。Stage A／B 共通。
// 日時は ISO8601 UTC 文字列（DB の timestamptz に対応）、業務日は Asia/Tokyo。

export type UUID = string;
export type IsoDateTime = string;

export type Role = 'operator' | 'reviewer' | 'admin';

export interface Organization {
  id: UUID;
  nameOriginal: string;
  timezone: 'Asia/Tokyo';
  status: 'active' | 'suspended' | 'closing';
  storageLimitBytes: number;
  createdAt: IsoDateTime;
}

export interface Member {
  orgId: UUID;
  userId: UUID;
  displayName: string;
  role: Role;
  active: boolean;
  joinedAt: IsoDateTime;
}

export interface Site {
  id: UUID;
  orgId: UUID;
  code: string;
  nameOriginal: string;
  active: boolean;
}

export type RentalStatus = 'open' | 'closed' | 'cancelled';

export interface Rental {
  id: UUID;
  orgId: UUID;
  siteId: UUID;
  sourceSystem: string;
  externalRentalIdOriginal: string;
  externalRentalIdSearch: string;
  customerLabelOriginal: string;
  customerLabelSearch: string;
  dueAt: IsoDateTime;
  status: RentalStatus;
  version: number;
  externalReturnAckAt: IsoDateTime | null;
  externalReturnRef: string | null;
  externalReturnNoRefReason: string | null;
  createdAt: IsoDateTime;
}

export interface RentalLine {
  id: UUID;
  orgId: UUID;
  rentalId: UUID;
  externalLineIdOriginal: string;
  itemCodeOriginal: string;
  itemNameOriginal: string;
  unitOriginal: string;
  qtyOut: number;
  version: number;
}

export interface Receipt {
  id: UUID;
  orgId: UUID;
  rentalId: UUID;
  operationId: UUID;
  receivedAt: IsoDateTime;
  actorId: UUID;
  status: 'valid' | 'reversed';
  /** 取消反転レコードの場合、取り消した元 receipt の ID。 */
  reversalOf: UUID | null;
  reason: string | null;
  memo: string | null;
  createdAt: IsoDateTime;
}

export interface ReceiptLine {
  id: UUID;
  orgId: UUID;
  receiptId: UUID;
  rentalLineId: UUID;
  qtyReceived: number;
  qtyDamaged: number;
  checklistSnapshot: Record<string, boolean>;
}

export type IssueKind = 'missing' | 'damage' | 'other';
export type IssueStatus =
  | 'open'
  | 'waiting'
  | 'review_pending'
  | 'needs_correction'
  | 'approved'
  | 'closed';
export type ResolutionCode = 'returned' | 'repair' | 'lost' | 'other';
export type BillingAction = 'no_charge' | 'charge_candidate';

export interface Issue {
  id: UUID;
  orgId: UUID;
  rentalId: UUID;
  lineId: UUID;
  kind: IssueKind;
  receiptLineId: UUID | null;
  /** 判断対象数量のスナップショット。数量計算の原資にしない。 */
  qty: number;
  summary: string;
  ownerUserId: UUID;
  dueAt: IsoDateTime;
  status: IssueStatus;
  resolutionCode: ResolutionCode | null;
  billingAction: BillingAction | null;
  chargeCandidateYen: number | null;
  decisionReason: string | null;
  /** 通信断・形式非対応で写真を省略した理由。設定されている間は承認不可。 */
  photoSkipReason: string | null;
  /** 閉鎖後に再開した場合、既存ソフト側の訂正が未確認であることを示す。 */
  externalCorrectionPending: boolean;
  version: number;
  createdAt: IsoDateTime;
}

export interface LossResolution {
  id: UUID;
  orgId: UUID;
  lineId: UUID;
  issueId: UUID;
  qtyLost: number;
  approvedBy: UUID;
  approvedAt: IsoDateTime;
  reversedAt: IsoDateTime | null;
  reversedBy: UUID | null;
  reason: string;
  reverseReason: string | null;
}

export type ContactChannel = 'phone' | 'email' | 'other';

export interface IssueEvent {
  id: UUID;
  orgId: UUID;
  issueId: UUID;
  actorId: UUID;
  eventType: string;
  note: string;
  channel: ContactChannel | null;
  contactedAt: IsoDateTime | null;
  outcome: string | null;
  /** 訂正イベントの場合、訂正対象のイベントID。 */
  correctsEventId: UUID | null;
  createdAt: IsoDateTime;
}

export interface Attachment {
  id: UUID;
  orgId: UUID;
  issueId: UUID | null;
  receiptLineId: UUID | null;
  objectKey: string;
  byteSize: number;
  mime: string;
  imageWidth: number;
  imageHeight: number;
  sha256: string;
  status: 'pending' | 'ready' | 'rejected';
  createdBy: UUID;
  createdAt: IsoDateTime;
}

export interface Handoff {
  id: UUID;
  orgId: UUID;
  issueId: UUID;
  approvedVersion: number;
  action: BillingAction;
  chargeCandidateYen: number;
  exportedAt: IsoDateTime | null;
  exportCount: number;
  ackAt: IsoDateTime | null;
  ackBy: UUID | null;
  externalRef: string | null;
  note: string | null;
  revokedAt: IsoDateTime | null;
  revokedReason: string | null;
  createdAt: IsoDateTime;
}

export interface ImportRecord {
  id: UUID;
  orgId: UUID;
  sha256: string;
  fileName: string;
  status: 'validated' | 'committed' | 'failed';
  rowCount: number;
  errorReport: ImportIssue[];
  summary: { added: number; changed: number; unchanged: number };
  createdBy: UUID;
  createdAt: IsoDateTime;
}

export interface ImportIssue {
  row: number | null; // 1始まりのデータ行番号（ヘッダ除く）。ファイル全体の誤りは null。
  column: string | null;
  message: string;
  severity: 'error' | 'warning';
}

export interface AuditEvent {
  id: UUID;
  orgId: UUID;
  actorId: UUID;
  entityType: string;
  entityId: UUID;
  action: string;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  createdAt: IsoDateTime;
  operationId: UUID | null;
  /** 履歴表示用の対象案件。 */
  rentalId: UUID | null;
}

export interface ChecklistItem {
  id: string;
  label: string;
}

export interface Settings {
  orgId: UUID;
  version: number;
  checklist: ChecklistItem[];
}
