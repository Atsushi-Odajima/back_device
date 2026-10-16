// 例外（issue）の状態遷移と判断の検査。純粋関数。
import type { BillingAction, IssueKind, IssueStatus, ResolutionCode, Role } from './types';

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  open: '対応中',
  waiting: '顧客確認中',
  review_pending: '確認待ち',
  needs_correction: '差し戻し',
  approved: '承認済み・事務未受領',
  closed: '完了',
};

export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  missing: '不足（未返却）',
  damage: '破損',
  other: 'その他',
};

export const RESOLUTION_LABEL: Record<ResolutionCode, string> = {
  returned: '返却済み',
  repair: '修理',
  lost: '紛失扱い',
  other: 'その他',
};

export const BILLING_LABEL: Record<BillingAction, string> = {
  no_charge: '請求なし',
  charge_candidate: '請求候補',
};

export type IssueTransition =
  | 'to_waiting'
  | 'request_review'
  | 'approve'
  | 'send_back'
  | 'revoke_approval'
  | 'ack_close'
  | 'reopen';

const ALLOWED: Record<IssueTransition, { from: IssueStatus[]; to: IssueStatus; roles: Role[] }> = {
  to_waiting: { from: ['open'], to: 'waiting', roles: ['operator', 'reviewer', 'admin'] },
  request_review: {
    from: ['open', 'waiting', 'needs_correction'],
    to: 'review_pending',
    roles: ['operator', 'reviewer', 'admin'],
  },
  approve: { from: ['review_pending'], to: 'approved', roles: ['reviewer', 'admin'] },
  send_back: { from: ['review_pending'], to: 'needs_correction', roles: ['reviewer', 'admin'] },
  revoke_approval: { from: ['approved'], to: 'needs_correction', roles: ['reviewer', 'admin'] },
  ack_close: { from: ['approved'], to: 'closed', roles: ['reviewer', 'admin'] },
  reopen: { from: ['closed'], to: 'needs_correction', roles: ['admin'] },
};

export function transitionCheck(
  t: IssueTransition,
  from: IssueStatus,
  role: Role,
): { ok: true; to: IssueStatus } | { ok: false; reason: string; code: 'forbidden' | 'conflict' } {
  const rule = ALLOWED[t];
  if (!rule.roles.includes(role)) return { ok: false, code: 'forbidden', reason: 'この操作の権限がありません' };
  if (!rule.from.includes(from))
    return { ok: false, code: 'conflict', reason: `現在の状態（${ISSUE_STATUS_LABEL[from]}）ではこの操作はできません` };
  return { ok: true, to: rule.to };
}

export interface DecisionInput {
  resolutionCode: ResolutionCode | null;
  billingAction: BillingAction | null;
  chargeCandidateYen: number | null;
  decisionReason: string;
}

/** 承認時の判断内容の検査。請求なし=0円、請求候補=1円以上。解消方法とは別に持つ。 */
export function checkDecision(d: DecisionInput, ctx: { hasActiveLoss: boolean }): string[] {
  const errs: string[] = [];
  if (!d.resolutionCode) errs.push('解消方法を選んでください');
  if (!d.billingAction) errs.push('請求の扱いを選んでください');
  if (d.billingAction === 'no_charge' && d.chargeCandidateYen !== 0) errs.push('請求なしの場合、金額は0円です');
  if (d.billingAction === 'charge_candidate') {
    const y = d.chargeCandidateYen;
    if (y === null || !Number.isInteger(y) || y < 1 || y > 100_000_000)
      errs.push('請求候補の金額は1～100,000,000円の整数（税抜）で入力してください');
  }
  if (d.decisionReason.trim().length === 0) errs.push('判断理由を入力してください');
  if (d.decisionReason.length > 2000) errs.push('判断理由は2000字以内です');
  if (ctx.hasActiveLoss && d.resolutionCode !== 'lost') errs.push('紛失処理が記録されているため、解消方法は「紛失扱い」です');
  if (!ctx.hasActiveLoss && d.resolutionCode === 'lost') errs.push('紛失扱いにするには先に紛失数量を記録してください');
  return errs;
}

export function isUnclosed(s: IssueStatus): boolean {
  return s !== 'closed';
}
