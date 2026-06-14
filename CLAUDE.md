# 賞味期限リマインダー（在庫管理アプリ）

社内（合同会社mokume）で使う、食品在庫の賞味期限管理アプリ。フロントは単一HTMLファイル、データはGoogle Apps Script(GAS)経由でGoogleスプレッドシートに保存し、チームで共有する構成。

## ファイル構成

- `index.html` — アプリ本体。HTML/CSS/JSすべて1ファイルに収まっている。GitHub Pagesで公開して全員が同じURLで利用する。
- `gas-spreadsheet-sync.gs` — サーバー側。GASプロジェクトの「コード.gs」にこの内容を貼り付けて使う。データの読み書き（スプレッドシート）と、毎朝の自動リマインドメール送信を担当。

> 注意: このリポジトリの `.gs` ファイルは「GASエディタに貼り付ける元ネタ」。`git push` してもGASには反映されない。GAS側は別途、手動で貼り替え＋再デプロイが必要（後述）。

## アーキテクチャ

```
[ブラウザ: index.html] ←→ [GAS ウェブアプリ(.../exec)] ←→ [Googleスプレッドシート]
       │                          │
   localStorage              毎朝8時台トリガー → MailApp でリマインドメール送信
  (端末ローカルキャッシュ)
```

- アプリは操作のたびに、その操作だけをGASへ送る（全件上書きではない）。GAS側は排他ロックを取り、スプレッドシートの該当データだけ更新して最新stateを返す。アプリはそのstateで画面を再描画する。
- 起動時とタブにフォーカスが戻ったとき(15秒に1回まで)に自動でサーバーから最新stateを取得する。
- localStorageはオフライン時や未接続時のローカルキャッシュ。`DB_ITEMS`/`DB_HISTORY`/`DB_SETTINGS` のキーで保存。

## データモデル

スプレッドシートは3シート構成（GAS側が自動生成）。

- **商品シート**: `id, name, expiry, remind, supplier, createdAt`
- **履歴シート**: `id, name, expiry, remind, supplier, createdAt, type, disposedAt, daysLeft`
  - `type` は `sale`(売上) または `dispose`(廃棄)
- **設定シート**: `key, value`（valueはJSON文字列。email, auto, suppliers[], supplierNotify{} など）

フィールドの意味:
- `expiry` 賞味/消費期限 (YYYY-MM-DD)
- `remind` 期限の何日前に通知するか（数値）
- `supplier` 仕入れ先カテゴリ名（空文字は「未設定」）
- `createdAt` 登録日 (YYYY-MM-DD)
- `daysLeft` 売上/廃棄した時点での期限までの残日数（マイナスは期限切れ）

## アプリの主要機能

1. **商品管理** — 追加/編集、賞味期限ステータス（余裕/要注意/期限切れ）の色分けバッジ表示
2. **並び替え・フィルター** — 期限順/商品名順/登録が新しい順、状態フィルター、仕入れ先フィルター
3. **売上/廃棄の記録** — 商品をリストから消すとき「売上」「廃棄」「完全削除」を選ぶ。売上/廃棄は履歴シートに記録
4. **複数選択・一括処理** — チェックして選択し、まとめて売上/廃棄/削除
5. **仕入れ先カテゴリ** — 設定タブで追加/改名/削除。改名時は既存の商品・履歴の仕入れ先も追従更新
6. **仕入れ先ごとのメール通知ON/OFF** — 🔔/🔕で切替。OFFのカテゴリは通知メールから除外
7. **PDF一括登録（OCR）** — お届け情報PDFを読み取り、商品名・期限・個数・画像を抽出。個数分まとめて登録。テキストPDFはpdf.js、画像PDFはTesseract.jsでOCR
8. **チーム共有** — 全員が同じGAS URL＋合言葉を設定すると同じスプレッドシートを読み書き
9. **自動リマインドメール** — GAS側トリガーで毎朝8時台に、期限が近い/切れた商品をメール通知（PCを開いていなくても動く）

## 重要な設計上の制約（変更時に壊しやすい点）

- **画像はチーム共有されない**: スプレッドシートに画像は保存しない。送信ペイロードからは `stripPhotos()` で `photo` を除去している。`applyState()` は、サーバー応答に画像が無くても、同じidのローカル画像を温存して引き継ぐ。この2つの対の関係を壊さないこと。
- **アプリのcloudOpアクションとGASのdoPostは1対1で対応**: アプリ側で新しい `cloudOp('xxx')` を追加したら、GAS側 `doPost` にも同名アクションの分岐を必ず追加する。対応が崩れるとデータが反映されない。現在のアクション: `load, save, addItems, updateItem, process, deleteItems, saveSettings, renameSupplier, removeSupplier, clearAll, clearHistory`
- **idはタイムスタンプ(Date.now())**: 登録日の復元にも使われる(`getCreatedAt`)。一括登録時は `baseId + count` で衝突を避けている。
- **localStorageは安全ラッパー経由**: `lsGet/lsSet` を使う。`localStorage` を直接呼ばない（プレビュー等の制限環境で落ちるため）。
- **CDN依存**（オフラインでは一部機能が動かない）:
  - pdf.js `3.11.174`（PDF読み取り）
  - Tesseract.js `5.1.1`（OCR。worker/core/辞書もすべて5.1.1系で揃える。バージョンを混在させない）
  - OCR辞書: `@tesseract.js-data/jpn@1.0.0` の `4.0.0_best_int/jpn.traineddata.gz`
- **合言葉(TOKEN)**: GAS側 `gas-spreadsheet-sync.gs` の `var TOKEN` と、アプリ設定画面の入力が一致して初めて接続できる。コードにハードコードしないのが理想だが、現状はGAS側に直書き。GitHub Pagesは公開URLなので、合言葉は推測されにくい文字列にすること。

## 変更後のデプロイ手順

### アプリ(index.html)を変更したとき → GitHub にプッシュするだけ
```bash
git add index.html
git commit -m "変更内容"
git push
```
GitHub Pagesが数分で自動反映。`index.html` なのでURLは `https://<ユーザー名>.github.io/<リポジトリ名>/` でアクセスできる。

### GAS(.gs)を変更したとき → 手動作業が必要（pushだけでは反映されない）
1. script.google.com で対象プロジェクトを開く
2. 「コード.gs」を `gas-spreadsheet-sync.gs` の内容で全置換して保存
3. 「デプロイ」→「デプロイを管理」→ 鉛筆アイコン → バージョン「新バージョン」→「デプロイ」（URLは変わらない）
4. 新しい権限を使う変更をした場合は、エディタで該当関数を1回手動実行して権限承認する

### 自動メールのトリガー設定（初回のみ）
GASエディタで関数 `setupDailyTrigger` を1回実行。停止は `removeDailyTrigger`、テスト送信は `testReminderNow`。

## ローカルでの動作確認

`file://` で直接開くとOCR(Tesseract)がブラウザのセキュリティ制限で動かないことがある（特にChrome/OneDrive配下）。動作確認はGitHub PagesのURL（https）で行うのが確実。Edgeは比較的緩い。

## コーディング方針

- 依存追加は最小限に。現状ビルドツールなし・単一HTMLで完結しているので、その手軽さを保つ。
- 変更したら、HTMLの `<script>` 部分を Node の `node --check` で構文チェックすると事故を防げる。
- 大きめの変更は、GASの該当アクションとの整合（上記の1対1対応）を必ず確認する。

## 変更履歴

- 2026-06-13: リストタブの絞り込みを「期限・仕入先・登録日」の3軸に整理。
  - 期限: 既存の状態フィルター（すべて/⚠ 要注意/✓ 余裕あり/期限切れ）を「期限」グループとして配置。判定ロジック（`currentFilter`）は変更なし。
  - 仕入先: 既存の `filter-supplier` セレクトを「仕入先」グループとして配置。
  - 登録日: 新規追加。`filter-created` セレクト（すべて/今日/今週/今月）で `getCreatedAt()` の値を絞り込み。「今週」は当日から直近7日間、「今月」は年月が一致するもの。`createdAt` が空のアイテムは「すべて」以外を選んだ場合に除外される。
  - 3軸はAND条件で併用可能。並び替え（`sort-btn` 系）とは独立した `filter-bar` に配置し、混在しない。
