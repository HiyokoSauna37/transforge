# TransForge

Claude API でページを**自然な日本語**に翻訳する、自分用の Chrome 拡張（Manifest V3・ビルド不要）。
DeepL / Google 翻訳のようにページ全体を置き換えるか、原文の下に訳文を並べる（対訳）か、選択範囲だけ訳すかを選べる。

Google 翻訳が「弦（String）」「間違い（false）」「真実（true）」のように壊すところを、技術文書として読める日本語にするのが目的。

## セットアップ

1. Chrome で `chrome://extensions` を開き、右上の **デベロッパーモード** を ON
2. **パッケージ化されていない拡張機能を読み込む** → このフォルダ（`TransForge/`）を選ぶ
3. ツールバーの羽根アイコン → **設定 ⚙**（または拡張の「詳細」→「拡張機能のオプション」）
4. **Anthropic API キー**を貼って **接続テスト** → **保存**

API キーはこの PC の `chrome.storage.local` にだけ保存され、リクエストは拡張のサービスワーカーから `api.anthropic.com` に直接送られる（中継サーバーなし）。

## 使い方

| 操作 | 方法 |
|---|---|
| ページ全体を翻訳 / 原文に戻す | ツールバーの羽根アイコン →「翻訳する」、または **Alt+T**（`chrome://extensions/shortcuts` で変更可） |
| 表示モード | ポップアップの **置換**（原文を訳文に差し替え）/ **対訳**（原文の下に緑の罫線付きで訳文） |
| 選択範囲だけ訳す | テキストを選択 → 横に出る **訳** ボタン、または右クリック →「選択範囲を Claude で翻訳」 |
| 常に翻訳するサイト | ポップアップの「このサイトは常に翻訳」 |
| 途中で止める | 右下のバッジの **中止** |

翻訳は**画面に見えている部分から**始まり、残りは上から順に流れる。SPA で後から追加された文や、開いた `<details>` の中身も自動で追い翻訳する。

## 語順の扱い（重要）

Google 翻訳は HTML のテキストノード単位で訳すため、`<a>` や `<strong>` で分かれた語句の順序が日本語で崩れる。
TransForge は **段落（run）全体を 1 セグメント**として渡し、リンク・太字などは `<i0>…</i0>`、コード・画像などは `<i1/>` というマーカーに置き換える。Claude には「日本語の語順に合わせてマーカーごと並べ替えてよい」と指示し、返ってきた順序どおりに DOM を組み直す。

```
原文: See <i0>the documentation</i0> for <i1>details</i1>.
訳文: <i1>詳細</i1>は<i0>ドキュメント</i0>を参照してください。
```

- 構造が変わらなければ元のテキストノードの中身だけを書き換える（React 等のアプリを壊しにくい）
- 順序が変わった場合は要素を複製して並べ替える（`href` などの属性は維持）
- マーカーが壊れて返ってきたときは 1 回だけ単体で再試行し、それでも駄目なら訳文テキストを置いて黄色の点線下線で印を付ける

`<code>` / `<pre>` / `translate="no"` / `.notranslate` / 非表示要素 / `nav`・`aside`（設定で変更可）は訳さない。
型名（String, boolean…）・識別子・オプション名・true/false は原語のまま残すようプロンプトで指示している。

## モデルと費用

| モデル | 入力 / 出力 ($/MTok) | 英文 1 万字のページの目安 |
|---|---|---|
| Claude Opus 5.5 | 4 / 20 | ≈ $0.16 ≈ ¥24 |
| Claude Sonnet 5.5（既定） | 2 / 10 | ≈ $0.08 ≈ ¥12 |
| Claude Haiku 5.5 | 0.10 / 0.50 | ≈ $0.004 ≈ ¥0.6 |

- ポップアップに **このページ** と **累計** の概算コストを表示する
- 同じ文は **翻訳キャッシュ**（IndexedDB）から返し、再課金しない（置換⇄対訳の切替や再訪問は無料）
- `effort` は `low` が既定（翻訳には十分で最速）。設定で変更可
- Opus / Sonnet / Fable では安全分類器による拒否時にサーバー側フォールバック（`fallbacks: "default"`）を有効にしている

## 設定項目

- 翻訳先の言語（既定: 日本語）、既定の表示モード
- **追加指示**（文体・分野）と **用語集**（`原語 = 訳語` を 1 行 1 つ）はシステムプロンプトに入る
- 1 リクエストの文字数上限 / 同時リクエスト数（レート制限に当たるなら下げる）
- nav / aside を訳さない、キャッシュの ON/OFF と削除、常に翻訳するホスト一覧、表示用の USD/JPY レート
- 使用量（リクエスト数・トークン・概算コスト）とリセット

## 構成

```
manifest.json          MV3
background.js          service worker: API 呼び出し・再試行・キャッシュ・使用量・注入
content/segmenter.js   DOM → セグメント化（マーカー直列化 / 復元 / in-place 適用）
content/content.js     翻訳の進行・適用・復元、MutationObserver、選択翻訳、shadow DOM UI
content/content.css    対訳モードの訳文スタイル
popup/, options/       ポップアップと設定ページ（shared/theme.css の Claude 風暖色テーマ）
fonts/                 UI 用の丸ゴシック M PLUS Rounded 1c（OFL、woff2 サブセット・ページ本文には使わない）
shared/                models.js(モデル表・価格) api.js(リクエスト) prompt.js(プロンプト) cache.js settings.js
tools/make_icons.py    アイコン生成 / tools/check.mjs 構文チェック
tests/                 e2e.mjs(Playwright + モック API) real_api_check.mjs(実 API の小テスト) diag_as2.mjs
```

## テスト

```
npm run check                        # 構文チェック
npm i && npx playwright install chromium   # E2E の準備（playwright-core + Chromium。headless shell では拡張を読めない）
npm test                             # モック API に対する E2E（翻訳 / 復元 / 対訳 / 選択翻訳 / 設定移行、70 項目）
ANTHROPIC_API_KEY=... npm run real [-- model]   # 実 API で Camel AS2 の実セグメントを翻訳（課金あり・数セント）
```

`tests/fixture/as2.html` は検証用に保存した [Apache Camel の AS2 コンポーネント文書](https://camel.apache.org/components/4.22.x/as2-component.html)（Apache License 2.0）のスナップショットです。

## 既知の制限

- iframe の中身（別フレーム）は訳さない
- 画像の `alt`、`placeholder`、`title` 属性は訳さない
- React 等が翻訳後にテキストを書き戻した場合、その段落は再翻訳対象になる（無限ループ防止のため追い翻訳は 60 回まで）
- 閉じた Shadow DOM の中は見えない
