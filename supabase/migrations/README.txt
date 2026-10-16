Stage B（未実装）
ここに Postgres の migration を置く：全業務テーブル（org_id NOT NULL、(org_id,id) UNIQUE と複合FK）、
全テーブル RLS、SECURITY DEFINER RPC（固定 search_path、public/anon から EXECUTE 剥奪、auth.uid() と所属を毎回検査）：
submit_receipt, reverse_receipt, submit_issue, review_issue, resolve_loss, ack_handoff, reopen_issue, close_rental, commit_import。
mutation_keys を同一トランザクションで保存。数量・状態の規則は src/domain と src/data/demo/demoServer.ts を正として SQL へ移す。
