// 原文（display_*/*_original）とは別に保持する検索用の派生キー。
// 原文には一切適用しない。
const DASHES = /[‐-―−﹘﹣]/g;

export function searchKey(s: string): string {
  return s.normalize('NFKC').replace(DASHES, '-').toLowerCase().trim();
}
