# 書き先の決まらない記録の洗い出し（2026-11-05、0.127.3 のあと）

0.127.3 で、命令の入口（`src/extension.ts` の registerCommand の包み）で、ほかの命令が走っていないときに記録の書き先を外すようにした（`useLogFile(undefined)`＝保管庫の記録）。そのため、命令の中で書き先を決めずに `logLine`／`logStep`／`logFailure` を書く道は、これまで偶然「直前に使った作品の記録」へ入っていた行が、保管庫の記録へ移った。

調べ方：`src` の `logLine(`・`logStep(`・`logFailure(` の呼び出し（約1,000か所・195ファイル）を grep で集め、関数名で呼び出し図を作って、同じ流れで `useLogFile`／`useLogFiles`／`useSyncLog` が先に呼ばれているかを機械で絞り、残りを目視した（担当：Sonnet。コードは読んだだけ）。全件を1行ずつ確かめたわけではない（最後の「確かめきれなかった所」）。

## 作品の記録に残るべき行で、書き先が決まっていないもの（約80か所・約45関数）

「直す場所の案」は、その行を書く処理の先頭に `useLogFile(...folderPath)` を足すか、`workLog(folder)` に替える案。

| ファイル:行 | 行の要旨 | 入口 | 作品を知っているか | 直す場所の案 |
|---|---|---|---|---|
| extension.ts:4001 | プロットからの人物反映の失敗 | 保存イベント（`syncPlotCharactersOnSave`） | あり（`work`） | ~3995 の `if (!work) return;` の直後 |
| extension.ts:4018 | 最終編集環境の記録の失敗 | 保存イベント（`recordEditedSession`） | あり（`work`） | ~4012 の `if (!work) return;` の直後 |
| extension.ts:4132 | 登録後の集計の失敗 | 作品の登録 | あり（`entry`） | ~4120 の `try` の前 |
| features/manuscriptEditor.ts:519, 901, 907, 984, 1169, 1243, 1312, 1364, 1406, 2186, 2989, 3182, 3199, 3220, 3659–3708, 3741, 3796–3874, 3908, 4004, 4019, 4239, 4578, 4638, 5004（約31か所） | 原稿エディターの失敗・開き直し・書き込みの失敗 | タブの見張り・カスタムエディターの呼び返し・右クリックや読み上げ | `filePath`／`document` から引ける | 既にある `logForDocument`（:3955）と同じ形の `logForFile(filePath, text)` を作って置き換える |
| features/manuscriptTab.ts:255, 268, 296 | 原稿のタブを開く・前に出す際の失敗 | 原稿エディターの各操作 | `filePath` のみ | 呼び元（manuscriptEditor）で決める |
| features/workChatPanel.ts:1144 | 読者像の台帳が読めない | `postContext` | あり | :1133 `readerProfileFor` の先頭 |
| features/workChatPanel.ts:2771, 2970 | 待ち時間設定・再読込の失敗 | `runErrorAction`・`reloadRecord` | 不確か | 要確認 |
| features/workChatPanel.ts:3026, 3126, 3166, 3182, 3188, 3210 | 「そこを見せて」の失敗 | `showLocation` など | あり（`staged.work`） | :3009 `showLocation` の先頭 |
| features/workChatPanel.ts:3282, 3346, 3404, 3429, 3681, 3755, 3815 | 機能起動・書き込み・取り消し・メモ保存・資料反映の失敗 | `runFeature` など | あり（関数ごとに確認） | 各関数の先頭、または `handle()`（:1618）で一括 |
| core/synopsisChapters.ts:91, 110 | あらすじ文書の章立てが読めない | 相談の `applyChatEdit` | あり | features/applyChatEdit.ts の先頭 |
| core/postingStore.ts:207, 232 | 投稿台帳の読み飛ばし・持ち回し | 台帳を読むあらゆる場面 | あり（`this.work`） | `workLog(this.work.folderPath)` に替える |
| features/sceneMemoPanel.ts:630, 982, 1101, 1409 | 本文の読み込み・パネルのエラー・相談の失敗 | パネルのメッセージ処理 | あり（`this.work`） | :1026 `handleMessage` と :942 `load` の先頭 |
| features/relationGraphPanel.ts:275, 377 | 人物の置き場を見張れない・パネルのエラー | `watchCharacters`／`handleMessage` | あり | :255・:326 の先頭 |
| features/locationSketchPanel.ts:139 | 場所の置き場を見張れない | `watchLocations` | あり | :119 の先頭 |
| features/proposalPanel.ts:1226, 3071 | 書いたあとの読み直し・決め終えた合図の失敗 | 呼び返し／`receive` | あり | :1215 の `.catch` の中、:3058 の先頭 |
| features/proposeChapters.ts:201, 233, 1012, 1228 | 章立て提案の反映・読み直し・資料読み・ストア失敗 | 提案パネルの承認、`collectMaterial` | あり | :1222 と :157 `apply` の呼び元 |
| features/autoResend.ts:284, 295 | 自動の送り直しの例外・印の付け直しの失敗 | タイマー | あり（`target`） | 該当の catch で `logFailure` の前に `await useSyncLog(target.root, target.works)` |
| features/episodeRenameWatch.ts:80, 113, 129 | 名前の変更の追従で台帳が読めない | 作品を開いた合図 | あり | :392 `check` の先頭 |
| features/celebrations.ts:418 | 執筆統計の祝いの失敗 | パネルの呼び返し | 任意 | :410 の前に `if (work) useLogFile(...)` |

## 作品と関わりの無い行（保管庫でよいもの）

約150か所（概算）。`ai/*` 約48、`core` 約21（localAiCrossTurn・modelTuning など）、`features` 約77（tuningStageRunners・localAiGate・setupWizard・views/notify など）、`extension.ts` 約10（保管庫の書き込み遅延・起動時の点検と案内・deactivate など）。

## 確かめきれなかった所

- 呼び出し元は関数名で追った。名前が重なる関数（`load`・`start`・`messageOf`・`collectChunks`・`confirm` など）は「呼ばれている」と誤って判定した可能性がある
- 呼び元で書き先を決めていると見なして表に入れなかったもの：publicityReader.ts:38–57、postingKit.ts:1953、photoTranscribe.ts:504–515、checkProofread／checkForeshadows の `collectChunks`、checkFactContradictions の `load*`、gitSync.ts:2078、syncAllWorks.ts:228、vectorSearch.ts:436
- `extension.ts` の `activate` の中の呼び返しは機械で拾えず、目視で上の3件を拾った
- workChatPanel.ts:1820・1960（バックアップの取り込み）は、作品が決まる前なので保管庫のままでよい（:1839・:1881 の `useLogFile(undefined)` は意図的）
- `logStep`／`logLine` を別名の関数で包んでいる所は拾えていない可能性がある

## 0.127.3 の再現テストの確かめ（2026-11-05）

直しの3ファイル（syncLog.ts・syncAllWorks.ts・extension.ts）だけを直す前へ戻すと、test/unit/features/syncLog.test.ts の4件（1作品だけ関わった同期／2作品とも関わった同期／書庫の直下に書かない／関わった作品が分からないとき全作品へ）と、test/unit/core/logFiles.test.ts の1件（registerCommand の包みが書き先を外す）の計5件が落ちた。残りの4件は直す前から変わらない振る舞いを見るもので、通るのが正しい。戻したあと9件とも通った。
