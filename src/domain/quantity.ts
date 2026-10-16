// 数量の不変条件（仕様７）。純粋関数のみ。Stage B の RPC でも同じ規則を SQL で再検査する。
import type { LossResolution, Receipt, ReceiptLine, RentalLine } from './types';

export interface LineQuantities {
  lineId: string;
  qtyOut: number;
  /** 有効 receipt_lines.qty_received の合計 */
  returned: number;
  /** 未取消 loss_resolutions.qty_lost の合計 */
  lost: number;
  /** qty_out − returned − lost（常に0以上） */
  outstanding: number;
  /** 返却済みの内数。未返却から再度引かない。 */
  damaged: number;
}

export function validReceiptLines(
  receipts: readonly Receipt[],
  receiptLines: readonly ReceiptLine[],
): ReceiptLine[] {
  const valid = new Set(receipts.filter((r) => r.status === 'valid' && r.reversalOf === null).map((r) => r.id));
  return receiptLines.filter((l) => valid.has(l.receiptId));
}

export function lineQuantities(
  line: Pick<RentalLine, 'id' | 'qtyOut'>,
  receipts: readonly Receipt[],
  receiptLines: readonly ReceiptLine[],
  losses: readonly LossResolution[],
): LineQuantities {
  let returned = 0;
  let damaged = 0;
  for (const rl of validReceiptLines(receipts, receiptLines)) {
    if (rl.rentalLineId !== line.id) continue;
    returned += rl.qtyReceived;
    damaged += rl.qtyDamaged;
  }
  let lost = 0;
  for (const l of losses) if (l.lineId === line.id && l.reversedAt === null) lost += l.qtyLost;
  return { lineId: line.id, qtyOut: line.qtyOut, returned, lost, outstanding: line.qtyOut - returned - lost, damaged };
}

export interface ReceiptLineInput {
  rentalLineId: string;
  qtyReceived: number;
  qtyDamaged: number;
}

export interface QtyProblem {
  rentalLineId: string;
  field: 'qtyReceived' | 'qtyDamaged';
  message: string;
}

const isInt = (n: number) => Number.isInteger(n) && Number.isFinite(n);

/**
 * 返却入力を現在の数量に対して検査する。1件でも問題があれば要求全体を拒否する。
 * unitLabel は「残り２脚まで」のような表示用。
 */
export function checkReceiptInput(
  inputs: readonly ReceiptLineInput[],
  current: ReadonlyMap<string, LineQuantities>,
  unitLabel: (lineId: string) => string = () => '',
): QtyProblem[] {
  const problems: QtyProblem[] = [];
  const seen = new Set<string>();
  if (inputs.length === 0 || inputs.every((i) => i.qtyReceived === 0)) {
    problems.push({ rentalLineId: '', field: 'qtyReceived', message: '今回返却数を１つ以上入力してください' });
  }
  for (const i of inputs) {
    if (seen.has(i.rentalLineId)) {
      problems.push({ rentalLineId: i.rentalLineId, field: 'qtyReceived', message: '同じ明細が重複しています' });
      continue;
    }
    seen.add(i.rentalLineId);
    const q = current.get(i.rentalLineId);
    if (!q) {
      problems.push({ rentalLineId: i.rentalLineId, field: 'qtyReceived', message: 'この貸出に含まれない明細です' });
      continue;
    }
    if (!isInt(i.qtyReceived) || i.qtyReceived < 0 || i.qtyReceived > 9999) {
      problems.push({ rentalLineId: i.rentalLineId, field: 'qtyReceived', message: '0～9999の半角整数で入力してください' });
    } else if (i.qtyReceived > q.outstanding) {
      problems.push({
        rentalLineId: i.rentalLineId,
        field: 'qtyReceived',
        message: `未返却は残り${q.outstanding}${unitLabel(i.rentalLineId)}までです`,
      });
    }
    if (!isInt(i.qtyDamaged) || i.qtyDamaged < 0) {
      problems.push({ rentalLineId: i.rentalLineId, field: 'qtyDamaged', message: '0以上の半角整数で入力してください' });
    } else if (i.qtyDamaged > i.qtyReceived) {
      problems.push({
        rentalLineId: i.rentalLineId,
        field: 'qtyDamaged',
        message: `破損数は今回返却数（${i.qtyReceived}）以下にしてください`,
      });
    }
  }
  return problems;
}

/** returned + lost が qty_out を超えないか（トランザクション確定前の最終検査）。 */
export function invariantHolds(q: Pick<LineQuantities, 'qtyOut' | 'returned' | 'lost'>): boolean {
  return q.returned >= 0 && q.lost >= 0 && q.returned + q.lost <= q.qtyOut;
}

/** 入力欄の文字列を数量へ。空欄は null（0として確定しない）。全角数字は受け付けない。 */
export function parseQtyField(raw: string): { value: number | null; error: string | null } {
  if (raw === '') return { value: null, error: null };
  if (/[０-９]/.test(raw)) return { value: null, error: '半角数字で入力してください（例：8）' };
  if (!/^\d{1,4}$/.test(raw)) return { value: null, error: '0～9999の半角整数で入力してください' };
  return { value: Number(raw), error: null };
}
