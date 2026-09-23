---
name: codebase-map
description: src/ のどこに何があるかを知りたいとき、新しいファイルの置き場所を決めるとき、土台の部品（paths・atomicWrite・eolSpace・chunkSettings・termColors など）を使う前に読む。CLAUDE.md にあったアーキテクチャの一覧。
---

# コードの配置

CLAUDE.md から移した一覧（2026-09-17）。文章は移す前のまま。

## アーキテクチャ

**下の一覧は「主なもの」であって、全部ではない。** `src/core` だけで150以上のファイルがあり、
全件を書くと読めないうえ、次の変更ですぐ古くなる（実際、一度は130件以上が抜けた状態になった）。

**ここへ書き足すのは、土台になるものだけでよい**——「新しく書く人がその存在を知らないと、
同じ失敗をくり返すもの」が基準である（例：`atomicWrite.ts` の上書き禁止、
`paths.ts` の場所の扱い）。個別の機能ファイルは、書かなくてよい。

```
src/
├─ extension.ts          エントリポイント。コマンド登録とステータスバー
│
├─ models/               データ型の定義のみ。VSCode APIに依存しない
│  ├─ types.ts           作品・ファイル・文字数
│  ├─ character.ts       登場人物
│  ├─ ability.ts         能力・能力体系
│  ├─ location.ts        場所
│  ├─ customField.ts     作者が定義する追加項目
│  ├─ aiNote.ts          AIの掘り下げメモ
│  ├─ jsonValidation.ts  作者が手編集するJSONの検証部品
│  ├─ keepWord.ts       作者が「直さない」と決めた語（方言・口癖）
│  ├─ actor.ts          誰の操作か（作者・編集者・AI）
│  ├─ proposal.ts       編集部からの提案と、その承認・却下
│  └─ fileLock.ts       校閲中のファイルのロック（ファイル単位）
│
├─ core/                 ドメインロジック
│  【どこでも動かす土台】手元のVS Codeとブラウザ版の両方で動かすための部品（設計書5.8）
│  ├─ runtime.ts         いまブラウザか。外部プロセスを起動できるか
│  ├─ paths.ts           場所の扱い。**`path` の代わりにこれを使う**
│  ├─ pathText.ts        paths.ts の純粋な部分（vscode 不要）。既定は paths のまま。core の純粋な部品だけが直に指す
│  ├─ hash.ts            SHA-1/256。ブラウザには node:crypto が無いので自前
│  ├─ processAvailability.ts ブラウザで使えない操作と、その理由
│  ├─ gitAttribution.ts  誰が編集したか（git.ts を巻き込まずに取る）
│  └─ gitSyncStatusText.ts 同期状態の短い印（型だけを見る純粋関数）
│
│  【原稿を読む】
│  ├─ textFile.ts        文字コード・改行を保持した安全な読み書き
│  ├─ textEdit.ts        変わった1か所だけを取り出す（全文差し替えを避ける）
│  ├─ eolSpace.ts        画面は常にLF空間で持つ（CRLFの変換は境界だけ。守らないと打鍵のたびに改行が書き換わる）
│  ├─ fileSystem.ts      ファイル操作の薄い層
│  ├─ atomicWrite.ts     既存ファイルを壊さない書き込み（後述の制約あり）
│  ├─ timestampedFileName.ts 上書き禁止の世界で衝突しない別名を作る（秒→連番。回避策はここへ寄せる）
│  ├─ scanner.ts         作品フォルダの走査
│  ├─ episodeParser.ts   ファイル名から話数を解析
│  ├─ metadataParser.ts  投稿サイトのDLファイルのヘッダー解析
│  ├─ charCount.ts       文字数計測
│  ├─ episodeLabel.ts    話数の見出しとタイトル（一覧と統計で共用）
│  ├─ plotTemplate.ts    プロットの初期テンプレート
│  ├─ gitHistory.ts      過去の版の一覧と復元（履歴は消さない）
│  ├─ gitClone.ts        GitHubから作品を取り寄せる
│  ├─ writingStats.ts    執筆量の集計（日次・週次・月次・年次、目標）
│  ├─ writingStatsStore.ts 執筆量の記録（端末ごとに1ファイル）
│  ├─ episodeCharTable.ts 話ごとの文字数一覧（長さの偏り）
│  ├─ chunker.ts         本文のチャンク分割（大きさはモデルの上限から決める）
│  ├─ chunkCache.ts      処理済みチャンクのキャッシュ
│  ├─ manuscriptSources.ts / mentionExcerpts.ts  本文からの場面抜粋
│  【設定資料を持つ】
│  ├─ workRegistry.ts    作品の登録管理
│  ├─ characterStore.ts  登場人物の永続化（1人1ファイル）
│  ├─ abilityStore.ts / settingsStore.ts  能力・場所の永続化
│  ├─ customFieldStore.ts 追加項目の定義の永続化
│  ├─ pendingUpdates.ts  承認待ちの更新
│  【設定資料を組み立てる】
│  ├─ characterMerge.ts / settingsMerge.ts  抽出結果のマージ
│  ├─ characterUnify.ts  同一人物のまとめ
│  ├─ characterDiff.ts   更新内容の差分
│  ├─ settingsEdit.ts    作者による書き換え（名前と別名の入れ替えを含む）
│  ├─ settingsAsOf.ts    その話の時点での設定（先の話で判明した値を巻き戻す）
│  ├─ gender.ts          性別の表記を揃える
│  ├─ reading.ts         読み仮名の生成
│  ├─ summaryLimit.ts    紹介文の字数制限
│  ├─ characterExtractionValidation.ts / settingsExtractionValidation.ts
│  ├─ groundedEvidence.ts 抽出根拠が本文に実在するかの照合
│  【外に出す】
│  ├─ settingsMarkdown.ts 設定資料集のMarkdown
│  ├─ settingsSummary.ts  AIへ渡す「現在の設定」
│  ├─ markdownLite.ts     パネル表示用のMarkdown整形
│  ├─ manuscriptRender.ts 原稿エディタの表示（ルビ・傍点・用語の色分け）
│  ├─ manuscriptViewTypes.ts 原稿エディタのviewType定数。views→featuresの逆流を防ぐためcoreに置く
│  ├─ termColors.ts       用語の色の唯一の定義（写しを作らない。3か所が参照し、写しが無いことをテストが見る）
│  ├─ imeDictionary.ts    IME辞書
│  ├─ termIndex.ts        用語の索引（ハイライト用）
│  ├─ logger.ts           失敗の記録（APIキーは伏せる）
│  ├─ ruby.ts            ルビと傍点の変換（投稿サイト↔{漢字|かんじ}・{{強調}}）
│  ├─ markdownItRuby.ts  標準のMarkdownプレビューへルビを差し込む
│  └─ markdownConversion.ts .txt を .md へ（名前だけ変える）
│  【AIの出力から原稿を守る】
│  ├─ placeholderText.ts 「空文字」など、中身の無い言葉を修正案にしない
│  ├─ keepWordStore.ts   直さない語の永続化
│  └─ protectExternalEdits.ts 外で直された資料をAIから守る印
│  【編集部と一緒に書く】
│  ├─ editorMode.ts      編集者モードで使える操作（許すものを並べる）
│  ├─ actorContext.ts    いまの環境が誰として動いているか
│  ├─ editHistory.ts     編集履歴（同期される。追記だけ）
│  ├─ proposalStore.ts   編集部からの提案（同期される。追記だけ）
│  └─ fileLockStore.ts   校閲ロック（同期される。追記だけ）
│
├─ ai/                   AIプロバイダ抽象化
│  ├─ types.ts           AIProvider インターフェース、AIError
│  ├─ registry.ts        プロバイダ選択・セットアップウィザード
│  ├─ ollamaProvider.ts / ollamaLauncher.ts
│  ├─ claudeProvider.ts / openaiProvider.ts / geminiProvider.ts
│  ├─ sakuraProvider.ts  さくらのAI（クラウド・OpenAI互換。無料枠あり）
│  ├─ lmstudioProvider.ts LM Studio（手元・OpenAI互換。鍵が要らない）
│  ├─ httpClient.ts      共通のHTTP・再試行
│  ├─ jsonSchema.ts      プロバイダ方言へのスキーマ変換
│  └─ outputLimit.ts     出力トークン上限
│
├─ prompts/              プロンプト定義（バージョン管理あり。17ファイル）
│  └─ 一覧はプロンプト設計書の1.1にある（ここへ写すと二重管理になる）
│     例：characterExtract.ts（P-04a 一括抽出）、foreshadowDetect.ts（P-25 伏線検知）
│
├─ features/             機能単位のオーケストレーション
│  ├─ chunkSettings.ts     チャンクの大きさの設定を読む（**AI機能はここを通す**）
│  ├─ extractSettings.ts / extractCharacters.ts
│  ├─ applyPendingUpdates.ts / unifyCharacters.ts
│  ├─ settingsPanel.ts      設定資料パネル
│  ├─ manageCustomFields.ts 追加項目の管理
│  ├─ generateSettingsDocs.ts / exportImeDictionary.ts
│  ├─ startWork.ts          新規作品の始め方（プロット／本文）の選択
│  ├─ gitRestore.ts         過去の版に戻す
│  ├─ addWorkFromGithub.ts  GitHubから作品を追加
│  ├─ setupOllama.ts        Ollamaの導入・起動・モデル取得の案内
│  ├─ writingProgress.ts    保存時の執筆量の記録・ステータスバー
│  ├─ writingStatsPanel.ts  執筆量パネル（グラフ・話ごとの一覧）
│  ├─ selectOllamaExecutable.ts
│  ├─ proposalPanel.ts     提案パネル（旧「AI指摘」。作者への提案は全部ここ）
│  ├─ reviewProposals.ts   編集部の提案の確認と、校閲ロックの開始・終了
│  ├─ editHistoryPanel.ts  編集履歴（作者・編集者・AIで色分け）
│  ├─ manageKeepWords.ts   直さない語の管理
│  ├─ protectExternalEdits.ts 外で直された資料を守る
│  ├─ manuscriptEditor.ts  原稿エディタ（既定は横書き。縦横2つの入口。**本文はVS Codeに保存させる**）
│  ├─ ruby.ts              ルビ・傍点を振る／投稿サイト用に変換／取り込む
│  └─ mergeIntoLibrary.ts  別々の作品を1つの書庫へまとめ直す（写すだけ。元は消さない）
│
└─ views/                VSCode UI
   ├─ workTree.ts          作品一覧
   ├─ actionList.ts        詳細メニュー（分類→小分類→操作の3階層）
   ├─ actionDecorations.ts 詳細メニュー末尾の印（AI・未反映の件数）
   ├─ stepMenu.ts          簡単ステップメニュー。操作の実体はACTION_TREEだけが持ち、こちらはコマンドIDで参照する（写し禁止）
   ├─ openDocument.ts      ファイルの開き方の共通口。openTextDocument+showTextDocumentは関連付けを無視して素のエディタで開く
   ├─ settingsPanelHtml.ts パネルのWebView
   ├─ writingStatsPanelHtml.ts 執筆量パネル（グラフは自前のSVG）
   ├─ manuscriptEditorHtml.ts 原稿エディタの画面（縦横・面は4つで既定は「組んで書く」）
   ├─ termHighlight.ts     用語ハイライト
   ├─ progress.ts          進捗表示（中止ボタン付き）
   ├─ proposalPanelHtml.ts 提案パネルのWebView
   └─ editHistoryPanelHtml.ts 編集履歴のWebView
```

**依存の方向**：`views` / `features` → `core` → `models`。逆流させない。`models` は VSCode API に依存させない（テストしやすくするため）。

**単体テストの置き場所**（2026-09-23、残課題 A5）：`test/unit/` の下に **`src/` と同じ形のフォルダー**（`core`・`features`・`views`・`prompts`・`mcp`・`ai`・`models`）。主に試す `src/` のファイルと同じフォルダーへ置く。1つに決まらないもの（複数のフォルダーにまたがる・ソースや文書を走査する網のテスト）は `test/unit/cross/`。部品は `test/unit/support/`。**直下に置くと `cross/testPlacement.test.ts` が落ちる。**
