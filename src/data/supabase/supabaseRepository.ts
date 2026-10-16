// Stage B（pilot）用の Repository 実装の入口。
// 未実装：Supabase Auth（招待制）、RLS 付き Postgres、RPC（submit_receipt など）、private Storage。
// Stage A の画面は repository.ts のインターフェースにだけ依存しているため、ここを実装すれば差し替えられる。
// 仮APIを実接続済みと報告しないこと（docs/implementation_status.txt 参照）。
import type { Repository } from '../repository';

export function createSupabaseRepository(): Repository {
  throw new Error('Stage B（pilot）の Supabase 接続は未実装です。VITE_APP_MODE=demo で起動してください。');
}
