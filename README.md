# 返却デスク（仮称）— Stage A 検証用デモ

イベント什器・備品レンタル（3～15名、既存の予約・請求ソフトを残す会社）向けの返却確認アプリの**検証用デモ**です。
英語の開発識別名は `return-desk`。仮称であり正式ブランドではありません。需要・成約・効果は実証されていません。

- **Stage A（このリポジトリの現状）**：React の画面、メモリ内の架空データ、役割切替、CSV検証、数量・状態ロジック、通信失敗スイッチ、操作履歴、サンプル出力、iPhone向けレスポンシブ。
  - 画面上部に常時「検証用デモ・サンプルデータ」を表示。**再読込で初期化**され、実保存はされません。本番アプリではありません。
  - 受け付けるファイルは同梱サンプルCSVと架空画像のみ。持込ファイルの入口は理由付きで無効です。
- **Stage B（未実装）**：招待制認証・Postgres・RLS・private写真・RPC・監査・バックアップ復元。`src/data/repository.ts` のインターフェースを Supabase で実装して差し替えます。

何ができて何が未実装かは [docs/implementation_status.txt](docs/implementation_status.txt) を参照してください。

## 起動（Windows PowerShell）

前提：Node.js 22.12以上、Git。依存バージョンは [package.json](package.json) とlockfileを参照してください。

macOS / Linuxでは環境ファイルのコピーを `cp .env.example .env.local` に読み替えます。

```powershell
npm ci
Copy-Item .env.example .env.local     # macOS/Linux: cp .env.example .env.local
npm run dev -- --host 0.0.0.0         # http://localhost:5173
npm run test                          # 単体・ロジック・部品テスト（Vitest）
npx playwright install                # 初回のみ：E2E用ブラウザ
npm run test:e2e                      # E2E（Playwright、ビルド＋preview を自動起動）
npm run build                         # dist/ を生成
npm run preview -- --host 0.0.0.0     # http://localhost:4173
```

- LAN の `http://PCのIP:5173` はレイアウト確認用です。PWA・安全なコンテキストの合格証拠にはなりません（HTTPS配信は docs/operations.txt）。
- 導入済み Chromium で E2E を動かす場合：`PW_CHROMIUM_PATH=<chromeのパス> npm run test:e2e`。

## デモの触り方

1. 架空の担当者（返却担当A／B、テスト事務、管理者、別組織ユーザー）を選んでログイン。
2. 「返却を確認」→ 貸出番号（例 `R-001`、全角の `Ｒ－００７` も `r-007` で検索可）→ 今回数 → 状態・写真 → 確認して保存。
3. 画面上部「デモ操作」で役割切替、通信失敗（未到達／タイムアウト）、写真送信失敗、セッション切れ、別端末からの先行返却（409）、初期化を試せます。
4. テスト事務で「責任者確認」→ 承認 →「事務引き渡し」で CSV 出力 → 外部番号で受領 → 返却反映確認で完了。

## 構成

```
src/domain        数量・状態遷移・CSV取込/出力・検索キー・sha256・ZIP（純粋なTypeScript関数）
src/data          Repository インターフェース、demo（メモリ内サーバー＋通信模擬）、supabase（Stage B 入口・未実装）
src/screens       S00～S12 の画面
src/components    共通部品・写真変換・自作SVGピクト
src/styles        UIトークン（CSS変数）と画面CSS
samples           サンプルCSV（正常・誤り・重複・長名・全角・数式・CP932）
supabase          Stage B 用（未実装、README のみ）
tests             unit（Vitest）／e2e（Playwright）
public            manifest・Service Worker（アプリシェルのみ）・仮アイコン・Cloudflare Pages 設定
docs              実装状況・運用・導入・依存版・試験結果
assets            仮称ブランドボード（デザインイメージ。数値・機能は仕様書を正とする）
```

## 実装を読む

- [src/domain](src/domain)：数量・状態遷移・CSV検証・出力のロジック。
- [src/data](src/data)：Repository境界と、通信失敗・競合を模擬するメモリ内データ層。
- [tests](tests)：ロジック・画面フローの検証。既存の試験結果は [docs](docs) を参照してください。
- [LICENSES.txt](LICENSES.txt)：自作サンプルと第三者依存物の表記。

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
