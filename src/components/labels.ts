import { ISSUE_STATUS_LABEL } from '../domain/issueRules';
import type { IssueStatus, Role } from '../domain/types';
import type { RentalStage } from '../data/repository';
import type { Tone } from './ui';

export const ROLE_LABEL: Record<Role, string> = {
  operator: '返却担当',
  reviewer: '検品責任者・事務',
  admin: '組織管理者',
};

export const STAGE: Record<RentalStage, { label: string; tone: Tone }> = {
  not_started: { label: '未返却', tone: 'neutral' },
  partial: { label: '一部未返却', tone: 'warning' },
  issues_open: { label: '不足・破損の対応中', tone: 'warning' },
  awaiting_ack: { label: '事務の返却反映確認待ち', tone: 'info' },
  closed: { label: '完了', tone: 'success' },
  cancelled: { label: '取消', tone: 'neutral' },
};

export function issueTone(s: IssueStatus): Tone {
  switch (s) {
    case 'closed':
      return 'success';
    case 'needs_correction':
      return 'error';
    case 'approved':
    case 'review_pending':
      return 'info';
    default:
      return 'warning';
  }
}

export const issueLabel = (s: IssueStatus) => ISSUE_STATUS_LABEL[s];
