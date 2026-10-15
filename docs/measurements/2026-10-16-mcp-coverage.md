# 外部AIから MCP でどこまで届くか——棚卸しと設計の案（2026-10-16）

作者の指示（2026-10-16 未明）「外部AIがMCPを操作して、ほとんどの機能が利用できるようにしてください」に向けた棚卸し。**コードは書いていない。** 見たのは worktree の HEAD（main 4077d69b と同じ）。

- 母数は `package.json` の `contributes.commands` の **185件**。`extension.ts` の `registerCommand` の行は212あるが、差（約27件）は画面の内側から呼ぶ内部用（パレットに出ない）なので数えていない
- MCP の道具は `src/mcp/server.ts` に登録された **26本**（下の「いまの MCP」）
- 別の担当が「表紙を焼く」を `run.request` に足している最中。下の表ではその行を「B（追加中）」とした

## 区分の決め方

| 区分 | 意味 |
|---|---|
| **A** | MCP の道具で直接できる（読む・検算・AIを撃つ・承認待ちへ置く・新しい資料を作る例外） |
| **B** | 動いている VS Code に頼めば今でもできる。道は3つ：`run.request`（白名簿7件・作者の確認つき・結果が返る）／`setup.request`（8段。確認が出て押すのは作者・結果は返らない）／`guide.spotlight`（メニューを光らせるだけ。押すのは作者） |
| **C1** | `run.request` の白名簿に足せばよい（拡張機能の側の処理を呼んで、結果を保管庫へ返せる） |
| **C2** | VS Code の要らない道具で足りる。**読むだけ**の新しい口か、**AIの機能なら `novel.run` の `feature` を1つ足す**（`src/prompts/` は全ファイル `vscode` を import していないので、プロンプトはそのまま束に入る） |
| **C3** | 画面の中でしかできない（canvas・音声・写真・画面の並び・作者の打鍵）。届かせる案は表の「足し方」に書く |
| **C4** | 外部AIに渡さない／渡すべきでない。理由の種類は「足し方」の欄の先頭に〔原稿〕〔送信〕〔設定〕〔消す〕〔作者の判断〕で書く |

難しさ：**低**＝既にある `core/` の部品（`vscode` を import していない）を呼ぶだけ／**中**＝`features/` か `vscode` に触る `core/` から純粋な部分を切り出す・結果を返す実行口を作る／**高**＝画面の部品や外部プロセスに手を入れる。C4 は「出さない」なので難しさを書かない（—）。

C2 の判定は「その機能の中身が `vscode` を import していないか」で行った（`grep -c '"vscode"' src/core/<部品>.ts`）。0 の部品：`writingStats`・`chronicle`・`relationGraph`・`settingsMarkdown`・`settingsSummary`・`featureGuide`・`foreshadowStore`・`foreshadowMarkdown`・`resumeSheet`・`postingConvert`・`ruby`・`imeDictionary`・`locationSketch`・`chronicleMarkdown`・`termIndex`。1 の部品（切り出しが要る）：`writingStatsStore`・`editHistory`・`characterStore`・`settingsStore`・`keepWordStore`・`proposalStore`・`chatLog`・`chapterStore`・`timelineStore`・`postingStore`。設定資料の記録は MCP 側に `mcp/tools/shared.ts` の `readSettingsRecords` が既にある。

## いまの MCP（26本）

| 道具 | 何ができるか | 書くか |
|---|---|---|
| `mcp.version`・`windows.list`・`notices.recent`・`works.list`・`ai.settings` | 版・窓・出た知らせ・登録簿の写し・AIの割当とチューニングの記録を読む | 読むだけ |
| `novel.scan` | 話数・題・字数・前提の揃い具合・単話プロットの場所 | 読むだけ |
| `novel.prompt`・`novel.validate`・`novel.run` | 19機能（`core/mcpFeatures.ts` の `FEATURE_NAMES`：typo・proofread・notation・contradiction・factContradiction・foreshadow〈detect／resolve〉・deviation・episodePlot・episodePlotContrast・settings・settingsEnrich・synopsis・plotReverse・chapter〈nameOnly〉・blurb・catchphrase・opening・name・chat）を、行き先 ollama／claude／sampling で通す | 書かない（`stash` で控えを貯めるだけ） |
| `novel.detect`・`novel.material`・`novel.notice` | AIなしの検出（notation・name・proofread・contradiction の位置関係）・矛盾検知の材料・実行前の断り | 読むだけ |
| `novel.search` | 索引か語句一致で場面を探す | 読むだけ |
| `pending.list` | 承認待ちの更新案と、提案パネルの指摘（kind: finding） | 読むだけ |
| `novel.propose` | 設定資料の更新案を承認待ちへ／指摘を検算し直して提案パネルへ | 承認待ち・`findings.jsonl` へ新規・追記だけ |
| `novel.extract.commit`・`novel.synopsis.commit` | 抽出・各話あらすじ・紹介文を、**まだ無い資料だけ**新しく作る（6.87.7 の例外1・2） | 新規だけ |
| `outbox.pack`・`outbox.import` | 出先の原稿箱。作者が出先で書いたメモ・採否・本文を戻す（6.87.7 の例外3。本文は `mcp/tools/bodyWrite.ts` で製品と同じ判断） | 本文を書く唯一の道。**作者自身が出先で打ったものだけ**で、外部AIの出力を書く口ではない |
| `ollama.generate`・`ollama.models` | 手元の Ollama を直に | 書かない |
| `guide.spotlight` | 作者のメニュー項目を光らせる | 書かない |
| `schedule.milestones` | 全作品の締切・発売日・連載開始 | 読むだけ |
| `setup.request` | 8段（ollama・lmstudio・ai・vector・create・register・diagnosis・external-access）を作者の画面に頼む | 書かない（押すのは作者） |
| `run.request`・`run.result` | 作者のAI設定で走らせ、検算済みの結果を返す。白名簿は typo・proofread・contradiction・foreshadow・deviation・synopsis・vectorIndex | 原稿・資料・提案パネルは変えない（索引の控えだけ書く） |

## 件数

| 区分 | 件数 |
|---|---|
| A | 34 |
| B | 14 |
| C1 | 15 |
| C2 | 33 |
| C3 | 21 |
| C4 | 68 |
| 計 | 185 |

C の内訳：C1 15・C2 33・C3 21・C4 68（計137）。C4 の理由の内訳は〔原稿〕17・〔送信〕8・〔設定〕13・〔消す〕7・〔作者の判断〕23。

（件数は下の表の区分の列を数えた値。表を直したら数え直す。）

## コマンドの一覧（185件）

### 作品・登録・始め方

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.addWork` | フォルダー登録 | B | `setup.request` step: register | — | フォルダーを選ぶのは作者 |
| `novelai.collectUnregisteredWorks` | 未登録作品検索 | C2 | 探すだけの読む口（`works.list` の隣に） | 中 | 登録は B のまま（作者が押す） |
| `novelai.importWorkFromZip` | バックアップ取込 | C4 | 〔作者の判断〕作者がファイルを選ぶ | — | 外から任意の zip を展開させない |
| `novelai.createWork` | 新規作品を作成 | B | `setup.request` step: create | — | |
| `novelai.renameWork` | 作品名変更 | C4 | 〔設定〕登録簿と題を変える | — | 確認つきの C1 にもできるが、題は作者の決め事 |
| `novelai.setSeries` | シリーズ連結 | C4 | 〔設定〕登録簿を変える | — | |
| `novelai.removeWork` | 作品の登録を解除 | C4 | 〔消す〕 | — | |
| `novelai.createWorkWithPlot` | プロット起点 | B | `setup.request` step: create の中で作者が選ぶ | — | |
| `novelai.createWorkFromManuscript` | 本文起点 | B | 同上 | — | |
| `novelai.addWorkFromGithub` | GitHubから作品を追加 | C4 | 〔送信〕ネットと資格情報 | — | |
| `novelai.mergeIntoLibrary` | 書庫集約 | C4 | 〔作者の判断〕写すだけだが作品の置き場所を決める操作 | — | |
| `novelai.refresh` | 再読み込み | C1 | 作品一覧の読み直し | 低 | 結果は無い。外部AIにとっての値打ちは小さい |
| `novelai.openWorkFolder` | 作品フォルダを開く | C3 | OS のエクスプローラーを開くだけ | — | 外部AIには `novel.scan` の場所で足りる |
| `novelai.addEpisode` | 新規話数ファイルを追加 | C1 | 新しい話のファイルを作るだけ（`mode: "create"`） | 中 | 6.87.7 の「何もない状態から」の例外に入るかは作者の裁定 |

### プロット・単話プロット・章

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.createPlot` | プロット自力作成 | C1 | 雛形からプロットを新しく作るだけ | 低 | 既にあれば断る |
| `novelai.openPlotMode` | プロットモード | C3 | 画面。中身は外部AIがファイルとして読める | — | 開いてほしいときは `guide.spotlight` |
| `novelai.setPlotBasics` | 形式・ジャンル | C4 | 〔作者の判断〕 | — | |
| `novelai.setWorkKind` | 作品の種類（小説・台本など） | C4 | 〔作者の判断〕 | — | |
| `novelai.generatePlot` | プロット逆算 | A | `novel.run` feature: plotReverse | — | 製品はプロットへ保存するが、MCP は保存しない。保存は `synopsis.commit` と同じ形（無いときだけ作る）なら足せる |
| `novelai.plotInterview` | 対話式プロット作成 | C2 | `novel.run` に feature を足す（`prompts/plotDialogue.ts`） | 中 | **問いに答えるのは作者。** 外部AIは問う側にだけ立つ |
| `novelai.createEpisodePlot` | 単話プロット作成 | C1 | 新しいファイルを作るだけ | 低 | |
| `novelai.episodePlotToPlotMode` | プロットモードへ | C3 | 画面の移動だけ | — | |
| `novelai.previousEpisodePlot` | 前の話の単話プロット | C3 | 画面の移動だけ | — | |
| `novelai.nextEpisodePlot` | 次の話の単話プロット | C3 | 画面の移動だけ | — | |
| `novelai.checkEpisodePlot` | 単話プロット検査 | A | `novel.run` feature: episodePlot／episodePlotContrast | — | |
| `novelai.proposeChapters` | 章立て提案 | A | `novel.run` feature: chapter | — | 章の台帳へ入れるのは作者（下の章の操作） |
| `novelai.suggestChapterName` | この章の名前の案を出す | A | `novel.run` feature: chapter、options.nameOnly | — | |
| `novelai.startChapter` | ここから章を始める | C4 | 〔作者の判断〕章の台帳を書く | — | 提案として置く道（案3の「提案の器」）なら届く |
| `novelai.renameChapter` | 章の名前を変える | C4 | 〔作者の判断〕 | — | 同上 |
| `novelai.removeChapter` | 章を外す | C4 | 〔消す〕 | — | |
| `novelai.chaptersFromHeadings` | 章見出し反映 | C4 | 〔作者の判断〕章の台帳を作り直す | — | |
| `novelai.importChaptersFromBackup` | 章立て取込（バックアップから） | C4 | 〔作者の判断〕 | — | |

### 相談・診断・案内

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.openChat` | AIに相談する | A | `novel.run` feature: chat | — | |
| `novelai.openChatPanel` | AI相談（大きく開く） | A | 同上 | — | 画面そのものは C3 |
| `novelai.openChatLog` | 相談ログ | C2 | 読む口（`core/chatLog.ts` は `vscode` を使うので読み部分を切り出す） | 中 | 作者の相談の中身が外へ出る。許可の鍵を分ける |
| `novelai.chooseChatWork` | 相談作品選択 | C3 | 画面の状態 | — | いま選んでいる作品は `windows.list` の chatWork で読める |
| `novelai.setAdvicePolicy` | 助言方針（診断） | C4 | 〔作者の判断〕作者が答える問い | — | |
| `novelai.setAuthorReaderType` | あなた自身の読者タイプ（診断） | C4 | 〔作者の判断〕作者が答える問い | — | |
| `novelai.openTargetReader` | ターゲット読者 | C2 | 読む口（読者像の記録を返す） | 低 | 書き換えは C4 |
| `novelai.runReaderTargetDiagnosis` | ターゲット読者診断 | C4 | 〔作者の判断〕作者が答える問い | — | |
| `novelai.openTargetSheet` | ターゲットシート | C2 | 読む口 | 低 | |
| `novelai.showThreeCircles` | 3つの輪 | C2 | 読む口（図は C3） | 低 | |
| `novelai.runWriterDiagnosis` | 作家タイプ診断 | B | `setup.request` step: diagnosis | — | 答えるのは作者 |
| `novelai.openManual` | 使い方（マニュアル） | C2 | 読む口（`core/featureGuide.ts`） | 低 | 相談の `featureIndex` が一部を既に渡している |
| `novelai.openSceneGuide` | 場面別案内 | C2 | 同上 | 低 | |

### 執筆量・予定・公募

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.showWritingStats` | 執筆統計 | C2 | 読む口（集計の `core/writingStats.ts` は純粋。記録の読みは `writingStatsStore.ts` から切り出す） | 中 | |
| `novelai.showAllWorksWritingStats` | 全作品執筆統計 | C2 | 同上（作品ごとに許可を確かめる。`schedule.milestones` と同じ作法） | 中 | |
| `novelai.setWorkGoals` | 作品目標設定 | C4 | 〔作者の判断〕 | — | |
| `novelai.openSchedule` | スケジュール | C2 | 読む口（段と期日の全部） | 中 | 大きな日付だけなら `schedule.milestones` で既に A |
| `novelai.importHolidays` | 祝日を取り込む | C1 | ネットから取り、予定に足すだけ | 低 | |
| `novelai.exportScheduleIcs` | スケジュールをカレンダーへ書き出す | A | `schedule.milestones`（同じ uid） | — | カレンダーへ書くのは呼び出し元 |
| `novelai.suggestContests` | 応募先をAIに提案してもらう | C1 | 公募情報を取ってAIへ。結果を返す | 中 | プロンプト（`contestSuggest.ts`）だけなら C2 でも組めるが、公募情報の取り寄せが `features/` にある |

### AIの設定・チューニング

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.setupAI` | AI設定 | B | `setup.request` step: ai | — | 性質は C4〔設定〕。押すのは作者なので今のままでよい |
| `novelai.assignFeatureAI` | 機能別AI割当 | C4 | 〔設定〕 | — | 読むのは `ai.settings` で A |
| `novelai.testAI` | AI接続確認 | C1 | 短い文を送って通るかを返す | 低 | 有料AIは料金が出る（ごく少量）。確認のモーダルに出す |
| `novelai.measureContext` | AIチューニング | C1 | 測って記録へ書く。結果を返す | 中 | 時間と料金が大きい。確認に目安を出す |
| `novelai.showTuningStats` | AIチューニング一覧 | A | `ai.settings` | — | |
| `novelai.forgetTuning` | AIチューニング削除 | C4 | 〔消す〕 | — | |
| `novelai.setupOllama` | Ollama導入 | B | `setup.request` step: ollama | — | |
| `novelai.setupLmStudio` | LM Studio導入 | B | `setup.request` step: lmstudio | — | |
| `novelai.selectOllamaExecutable` | Ollama実行ファイル位置 | C4 | 〔設定〕ファイルを選ぶ | — | |
| `novelai.openExtensionSettings` | 設定管理 | C4 | 〔設定〕 | — | |
| `novelai.manageConfirmSkips` | 確認省略解除 | C4 | 〔設定〕確認を省く・戻す | — | 外から「確認を省く」側へ動かせると、ほかの守りが全部薄くなる |
| `novelai.runFullSetup` | セットアップ | B | `setup.request` を段ごとに | — | |
| `novelai.diagnoseWeb` | 動作診断（ブラウザ版の確認用） | C1 | 結果を返す | 低 | ブラウザ版には MCP が無いので、値打ちは手元の版の診断だけ |
| `novelai.showVersion` | バージョン確認 | A | `windows.list`・`mcp.version` | — | |
| `novelai.showLog` | ログ表示 | C2 | 読む口（鍵は書く時点で伏せてある） | 低 | 作者の本文の断片が入りうる。許可の鍵を分ける |

### 書き出し

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.exportPdf` | PDF出力（印刷用） | C1 | 書き出して場所を返す | 中 | 外部プロセスを使う。組み上がりの見た目は作者 |
| `novelai.exportEpub` | EPUB出力（試作） | C1 | 書き出して場所を返す | 中 | 表紙は焼いた画像を読むだけ（焼くのは C3。下の画面の表） |
| `novelai.openEpubEditor` | EPUBエディター（試作） | C3 | 画面 | — | |
| `novelai.exportImeDictionary` | IME辞書出力 | C2 | 中身を返す（`core/imeDictionary.ts`） | 低 | ファイルに書くなら C1 |
| `novelai.generateSettingsDocs` | 設定資料集出力 | C2 | 中身を返す（`core/settingsMarkdown.ts`） | 低 | ファイルに書くなら C1 |
| `novelai.exportSettingsForAudience` | 提供先別出力 | C2 | 中身を返す | 中 | 提供先別の伏せ方は製品と同じ関数を通す |
| `novelai.generateCharacterDocs` | 人物一覧を生成 | C2 | 中身を返す | 低 | |
| `novelai.generateLocationDocs` | 場所一覧を生成 | C2 | 中身を返す | 低 | |
| `novelai.generateAbilityDocs` | スキル一覧を生成 | C2 | 中身を返す | 低 | |
| `novelai.generateWorldDocs` | 世界観一覧を生成 | C2 | 中身を返す | 低 | |

### 設定資料

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.extractSettings` | 一括抽出 | A | `novel.run` settings → `novel.extract.commit` | — | 作者のクラウドAIで走らせたいなら `run.request` に足す（C1 相当） |
| `novelai.extractCharactersOnly` | 人物抽出 | A | 同上（全種類を抽出する） | — | 種類だけに絞る options は無い。要るなら options.kinds を足す |
| `novelai.extractLocationsOnly` | 場所抽出 | A | 同上 | — | 同上 |
| `novelai.extractAbilitiesOnly` | スキル抽出 | A | 同上 | — | 同上 |
| `novelai.extractOrganizationsOnly` | 組織抽出 | A | 同上 | — | 同上 |
| `novelai.extractWorldOnly` | 世界観抽出 | A | 同上 | — | 同上 |
| `novelai.openSettingsPanel` | 設定資料集閲覧 | C2 | 読む口（`readSettingsRecords` が既にある） | 低 | 直すのは `novel.propose`（A） |
| `novelai.showSettingsForTerm` | 設定情報を表示 | C2 | 読む口（語から記録を引く。`termIndex` は純粋） | 低 | |
| `novelai.openRelationGraph` | 人物相関図 | C2 | 読む口（`core/relationGraph.ts`。図は C3） | 低 | |
| `novelai.openLocationSketch` | 場所の略図 | C2 | 読む口（`core/locationSketch.ts`。図は C3） | 低 | |
| `novelai.openChronicle` | 年表 | C2 | 読む口（`core/chronicle.ts`・`chronicleMarkdown.ts`） | 低 | |
| `novelai.editTimeline` | 作中時期・別筋登録 | C4 | 〔作者の判断〕 | — | 提案の器なら届く |
| `novelai.manageCustomFields` | 設定資料項目追加 | C4 | 〔設定〕資料の形を変える | — | |
| `novelai.applyPendingUpdates` | 設定資料更新分反映 | C4 | 〔作者の判断〕承認は作者 | — | 置くのは `novel.propose`、読むのは `pending.list`（ともに A） |
| `novelai.unifyCharacters` | 人物重複統合 | C4 | 〔作者の判断〕どちらを残すかは作者 | — | 候補の組を返すだけなら C2 |
| `novelai.renameCharacter` | 人物名変更 | C4 | 〔原稿〕本文の名前を書き換える | — | |
| `novelai.applyRenameToRecords` | 人物名変更の資料反映 | C4 | 〔原稿〕資料をまとめて書き換える | — | |
| `novelai.checkNames` | 名前点検 | A | `novel.detect` name | — | |

### 校正・検知

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.finishNewWork` | 支援機能全工程実行 | C1 | まとめて走らせ結果を返す | 高 | 製品は途中で保存する。保存の段は例外1・2の範囲だけにする |
| `novelai.runProofreadingSuite` | 校正一括実行 | B | `run.request` を機能ごとに頼む | — | 1回の確認でまとめたいなら C1（中） |
| `novelai.checkTypos` | 誤字脱字検知 | A | `novel.run` typo | — | `run.request` でも可（作者のAIで）。**製品は提案パネルへ並べる**——並べるには `novel.propose` kind: finding を足して通す |
| `novelai.checkTyposForFile` | この話の誤字脱字を検知 | A | 同上（filePath） | — | 同上 |
| `novelai.checkProofread` | 推敲 | A | `novel.run` proofread | — | 同上 |
| `novelai.checkOpening` | 冒頭診断 | A | `novel.run` opening | — | `run.request` の白名簿には無い |
| `novelai.checkContradictions` | 矛盾検知 | A | `novel.run` contradiction | — | `run.request` でも可 |
| `novelai.checkFactContradictions` | 矛盾検知（事実の照合） | A | `novel.run` factContradiction | — | `run.request` の白名簿には無い |
| `novelai.checkLocationConsistency` | 位置関係の照合 | A | `novel.detect` contradiction | — | |
| `novelai.checkDeviations` | プロット逸脱検知 | A | `novel.run` deviation | — | `run.request` でも可 |
| `novelai.checkForeshadows` | 伏線検知 | A | `novel.run` foreshadow | — | 同上 |
| `novelai.checkForeshadowResolution` | 伏線回収確認 | A | `novel.run` foreshadow、options.mode: resolve | — | `run.request` は配置の検知だけ |
| `novelai.checkNotation` | 表記ゆれ検知 | A | `novel.detect` notation → `novel.run` notation | — | |
| `novelai.manageKeepWords` | 指摘対象外管理 | C4 | 〔作者の判断〕足すと検知が黙る | — | 一覧を読むだけなら C2 |
| `novelai.openForeshadows` | 伏線一覧 | C2 | 読む口（`core/foreshadowStore.ts`） | 低 | |
| `novelai.addForeshadow` | 伏線手動追加 | C4 | 〔作者の判断〕伏線の台帳を書く | — | 提案の器なら届く（提案パネルには既に「伏線へ登録」がある） |
| `novelai.setForeshadowStatus` | 伏線状態変更 | C4 | 〔作者の判断〕 | — | 同上 |
| `novelai.resumeWriting` | 再開用資料 | C2 | 読む口（`core/resumeSheet.ts`） | 低 | |
| `novelai.openProposals` | 提案パネルを開く | A | `pending.list` kind: finding | — | 当てる・退けるは C4 |
| `novelai.pruneFindings` | 期限切れ指摘消去 | C4 | 〔消す〕 | — | |
| `novelai.searchScenes` | 場面検索 | A | `novel.search` | — | |
| `novelai.findSimilarScenes` | 類似場面検出 | C2 | 読む口（索引を引く。`novel.search` と同じ索引） | 中 | 索引が無ければ `run.request` vectorIndex で作る |
| `novelai.setupVectorSearch` | ベクトル検索準備 | B | `setup.request` step: vector | — | |
| `novelai.buildVectorIndex` | 検索索引作成／更新 | B | `run.request` feature: vectorIndex | — | |
| `novelai.buildVectorIndexAll` | 検索索引作成／更新（全作品） | B | `run.request` vectorIndex、scope: all | — | |
| `novelai.clearVectorIndex` | 検索索引削除 | C4 | 〔消す〕 | — | 作り直せる控えなので、確認つきの C1 にしてもよい |

### 本文の操作・ファイル

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.deleteEpisodeFile` | ファイルを削除 | C4 | 〔消す〕 | — | |
| `novelai.insertEpisodeBefore` | この話の前に挿入 | C4 | 〔原稿〕後ろの話のファイル名が変わる | — | |
| `novelai.removeEpisodeAndRenumber` | この話を削除（話数を詰める） | C4 | 〔原稿〕 | — | |
| `novelai.splitCollectedFile` | 話ごとのファイルに分ける | C4 | 〔原稿〕 | — | |
| `novelai.renameWithSubtitle` | ファイル名にサブタイトルを付ける | C4 | 〔原稿〕ファイル名を変える | — | |
| `novelai.convertToMarkdown` | 本文 .md 化 | C4 | 〔原稿〕ファイル名を変える | — | |
| `novelai.unifyEol` | 改行コード統一 | C4 | 〔原稿〕 | — | |
| `novelai.convertDocxToMarkdown` | Word 原稿変換 | C1 | 新しい .md を作るだけ（`mode: "create"`） | 中 | Word ファイルを選ぶのは作者。場所を札に書けば外からも頼める |
| `novelai.openVertical` | 縦書き表示 | C3 | 画面 | — | |
| `novelai.openEpisode` | 話を開く | C3 | 画面 | — | 開いてほしいときは `guide.spotlight` か「開く依頼」（案3） |
| `novelai.readManuscriptAloud` | 原稿読み上げ | C3 | 音声（WebView の読み上げ） | — | |
| `novelai.addEmphasis` | 傍点付与 | C4 | 〔原稿〕 | — | 振った結果を返すだけなら C2（`core/ruby.ts`） |
| `novelai.addRuby` | ルビ付与 | C4 | 〔原稿〕 | — | 同上 |
| `novelai.importRuby` | 投稿サイトルビ取込 | C4 | 〔原稿〕 | — | 同上 |
| `novelai.dictationClean` | 口述文整形 | C4 | 〔原稿〕本文を書き換える | — | 整えた文を返すだけなら C2（`prompts/dictationClean.ts` を feature に） |
| `novelai.transcribePhotos` | 写真から書き起こし | C3 | 写真の受け取り・向きの確認・目印の色は画面 | — | 写真を札に添えて頼む形なら C1（高）。保存は新しいファイルだけ |
| `novelai.copyForPosting` | コピー（投稿サイト用） | C2 | 変換した文を返す（`core/postingConvert.ts`） | 低 | クリップボードへ入れるのは呼び出し元 |
| `novelai.copyBodyForPosting` | コピー（投稿サイト用） | C2 | 同上 | 低 | |
| `novelai.copySubtitle` | サブタイトルをコピー | A | `novel.scan` が題を返す | — | |
| `novelai.chooseStepWork` | ステップメニューの作品を選ぶ | C3 | 画面の状態 | — | |
| `novelai.addWorkMemo` | メモ追加 | C1 | 新しいメモのファイルを作るだけ | 低 | 外部AIのメモと作者のメモを見分ける印が要る |
| `novelai.removeWorkMemo` | メモを削除（ごみ箱へ） | C4 | 〔消す〕 | — | |
| `novelai.transferMemoToWork` | このメモを作品へ移管 | C4 | 〔作者の判断〕 | — | |

### 校正・メモパネル・編集部

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.openSceneMemos` | 校正・メモパネルを開く | C2 | 読む口（本文の `//` メモの一覧。指摘は `pending.list` で A） | 低 | |
| `novelai.nextSceneMemo` | 次のメモへ | C3 | 画面の移動 | — | |
| `novelai.prevSceneMemo` | 前のメモへ | C3 | 画面の移動 | — | |
| `novelai.addSceneMemo` | ここにメモを足す | C4 | 〔原稿〕本文へ `//` の行を入れる | — | 原稿箱（`outbox.import`）は作者自身のメモだけを入れる例外。外部AIの意見は提案パネルへ |
| `novelai.importOutboxInbox` | 原稿箱を取り込む | A | `outbox.import` | — | |
| `novelai.showEditHistory` | 編集履歴 | C2 | 読む口（`core/editHistory.ts` から読み部分を切り出す） | 中 | 外部AIの記録（`external.jsonl`）も並べられる |
| `novelai.reviewProposals` | 編集部提案確認 | C4 | 〔作者の判断〕採否は作者 | — | |
| `novelai.toggleReviewLock` | 校閲開始／終了 | C4 | 〔作者の判断〕 | — | |
| `novelai.switchMode` | 作者／編集者切替 | C4 | 〔設定〕 | — | |
| `novelai.shareWithEditor` | 編集部共有 | C4 | 〔送信〕非公開リポジトリを作って送る | — | |
| `novelai.collectEditorProposals` | 編集部提案取込 | C1 | 取り寄せて提案パネルへ並べる（本文に触らない） | 中 | ネットを使う |

### 同期・GitHub

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.gitSync` | GitHubと同期 | C4 | 〔送信〕 | — | |
| `novelai.saveAndSync` | 保存・同期 | C4 | 〔送信〕 | — | |
| `novelai.gitPull` | 別の環境の変更を取り込む | C4 | 〔原稿〕作業中のファイルが変わる | — | |
| `novelai.gitPush` | この環境の変更を送信する | C4 | 〔送信〕 | — | |
| `novelai.syncAllWorks` | 全作品同期 | C4 | 〔送信〕 | — | |
| `novelai.resolveConflicts` | 競合解決 | C4 | 〔原稿〕 | — | |
| `novelai.resolveDivergence` | 分岐合流 | C4 | 〔原稿〕 | — | |
| `novelai.gitRestore` | 過去の版に戻す | C4 | 〔原稿〕 | — | 版の一覧を読むだけなら C2 |
| `novelai.setupGithub` | GitHub初期設定 | C4 | 〔設定〕資格情報 | — | |

### あらすじ・紹介文

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.generateSynopses` | 各話あらすじ | A | `novel.run` synopsis → `novel.synopsis.commit` | — | `run.request` でも可（作者のAIで。保存はしない）。保存はまだ無い話だけ |
| `novelai.openSynopsisDocs` | 紹介文・あらすじ閲覧 | C2 | 読む口（`設定/chapter_synopses.json`・`synopsis.md`） | 低 | |
| `novelai.generateWorkBlurb` | 作品紹介文 | A | `novel.run` blurb → `novel.synopsis.commit` kind: blurb | — | 保存は紹介文が無いときだけ |
| `novelai.generateCatchphrases` | キャッチコピー案 | A | `novel.run` catchphrase | — | |

### 投稿・告知・読者の反応

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.generateAnnouncement` | 更新SNS告知文作成 | C2 | `novel.run` に feature を足す（`prompts/announce.ts`） | 中 | 生成だけ。投稿はしない |
| `novelai.configureAnnouncement` | SNS告知設定 | C4 | 〔設定〕 | — | |
| `novelai.postNewEpisode` | 新話投稿 | C4 | 〔送信〕公開 | — | |
| `novelai.postThisEpisode` | この話を投稿する | C4 | 〔送信〕公開 | — | |
| `novelai.configurePostingSites` | 投稿サイト設定 | C4 | 〔設定〕 | — | |
| `novelai.recordRanking` | ランキング記録 | C4 | 〔作者の判断〕作者の記録 | — | 外から書くと作者の手入力と見分けられない |
| `novelai.importReaderStats` | 読者反応自動取込 | C3 | ブラウザのヘルパーとクリップボード | — | |
| `novelai.recordReaderStats` | 読者反応手動入力 | C4 | 〔作者の判断〕作者の記録 | — | |

### 外部AI・画面の並び

| コマンド | 機能 | 区分 | 足し方 | 難しさ | 注意 |
|---|---|---|---|---|---|
| `novelai.toggleExternalAccess` | 外部AI許可／取消 | B | `setup.request` step: external-access | — | 性質は C4〔設定〕。**印を書けるのは拡張機能だけ**（6.87.10）、押すのは作者。これより広げない |
| `novelai.writeAiInstructions` | 外部AI指示書設置 | C4 | 〔設定〕外部AI自身の指示書を書く | — | 外部AIが自分の指示を書き換えられる形にしない |
| `novelai.connectClaudeCode` | Claude Code接続 | C4 | 〔設定〕MCP の登録 | — | |
| `novelai.exitChatFocus` | 作品一覧とメニューを出す | C3 | 画面の並び | — | |
| `novelai.soloWorks` | 他のメニューを閉じる | C3 | 画面の並び | — | |
| `novelai.soloSteps` | 他のメニューを閉じる | C3 | 画面の並び | — | |
| `novelai.soloActions` | 他のメニューを閉じる | C3 | 画面の並び | — | |
| `novelai.soloChat` | 他のメニューを閉じる | C3 | 画面の並び | — | |
| `novelai.showAllViews` | すべてのメニューを出す | C3 | 画面の並び | — | |

## 画面からだけ呼べる主な操作

WebView のパネルが受け取る操作（各 `features/*Panel.ts` の `case`）から、作者が押すものの主なものだけ。

| 画面 | 操作 | 区分 | 足し方・注意 |
|---|---|---|---|
| EPUBエディター | **表紙・裏表紙を焼く**（canvas で題名を重ね `設定/書籍/表紙_合成済み.png` へ） | B（追加中） | 別の担当が `run.request` に足している。canvas は画面の中にしか無いので、頼まれたら画面を開いて同じ関数で焼く形のはず |
| EPUBエディター | 扉・目次・奥付などの部品の編集 | C4 | 〔作者の判断〕本の作り |
| 提案パネル | 当てる・まとめて当てる・取り消す | C4 | 〔原稿〕［適用］1回で本文が変わる |
| 提案パネル | 退ける・直さない語にする | C4 | 〔作者の判断〕 |
| 提案パネル | 表記ゆれの揃え先をAIに問う | A | `novel.run` notation、options.group |
| 提案パネル | 伏線へ登録 | C4 | 〔作者の判断〕 |
| 提案パネル | 外部AIの提案をまとめて確かめる | C4 | 〔作者の判断〕外部AIが自分の案を承認する形は作らない |
| 設定資料パネル | 欄の保存・確定・破棄・引退・分ける | C4 | 〔作者の判断〕直したいときは `novel.propose`（A） |
| 設定資料パネル | AIで再読込 | A | `novel.run` settingsEnrich → `novel.propose` |
| 設定資料パネル | 作者が退けた値・関係を戻す | C4 | 〔作者の判断〕 |
| 原稿エディター | 打鍵・保存 | C4 | 〔原稿〕書き込みは作者の打鍵だけ（スキル desk-editor の決まり） |
| プロットモード | 節・予定の話を足す・動かす | C4 | 〔作者の判断〕プロットは作者の文書。提案の器なら届く |
| プロットモード | 助言を頼む／名前の案 | A／C2 | 名前は `novel.run` name。プロットの助言は `prompts/plotAdvice.ts` を feature に（C2） |
| プロットモード | 人物を資料へ同期 | C4 | 承認待ちへ置くなら `novel.propose` |
| スケジュール | 段・予定を足す・直す・消す | C4 | 〔作者の判断〕確認つきの C1 にもできる |
| 校正・メモパネル | 直す・済み・相談へ回す | C4／A | 直す・済みは C4。相談は `novel.run` chat |
| 相談パネル | 送る | A | `novel.run` chat |
| 人物相関図・場所の略図・年表 | 図を見る・書き出す・位置を動かす | C3 | 中身は C2 の読む口で足りる。図の書き出し（SVG）は C1 にできる |
| 写真の書き起こし | 写真を足す・向き・書き起こす・新しい話として保存 | C3 | 上のコマンド表と同じ |
| 執筆量パネル | グラフ | C3 | 数字は C2 の読む口 |

## C3 を届かせる案

1. **「開く依頼」**——`run.request` に「この画面をこの作品で開いてください」という依頼の種類を足す。作者の確認を通って画面が開くだけで、結果は「開いた」だけ。外部AIが作者に何かを見せたいとき（相関図・縦書き・提案パネル）に使う。いまの `guide.spotlight` は「光らせて押してもらう」なので、開くところまで行くのが違い
2. **見えない画面で同じ関数**——canvas で焼く・図を画像にするのように、画面の部品でしか作れない成果物は、頼まれたら WebView を開いて（できれば見えない位置で）同じ関数を走らせ、ファイルにして返す。「表紙を焼く」がこの形の最初の1件になる。VS Code の WebView は作者の画面に一瞬でも出る可能性があるので、作者が書いているときに頼むと焦点を奪う。確認のモーダルにそう書く
3. **画面の並び・音声・作者の打鍵は届かせない。** 外部AIにとっての値打ちが無いか、作者の手そのものだから

## C4 を渡さない理由と、渡すなら挟む確認

| 種類 | 渡さない理由 | 渡すならどうするか |
|---|---|---|
| 〔原稿〕本文・ファイル名・資料を書き換える（17件） | 実装ルール1・2と 6.87.7「原稿を書き換える操作を外へ出さない」。外部AIの出力を本文へ書く口はいま1つも無い（`outbox.import` は作者自身が出先で打った字を戻す道で、外部AIの出力ではない） | 書き換えは**提案パネルへ置く**（`novel.propose` kind: finding と同じ）。当てるのは作者。ルビ・傍点・口述整形のように結果が決まるものは「結果を返すだけ」（C2）に分ける |
| 〔送信〕公開・共有・push（8件） | 一度出ると取り消せない。作者の作品が外へ出る | 渡さない。外部AIは「いま同期していないものがある」を読むまで |
| 〔設定〕許可・AIの割当・確認の省略・MCP の登録・指示書（13件） | 6.87.10「許可の印を書けるのは拡張機能だけ」。外部AIが自分の許可や確認を緩められると、意思確認の意味が無くなる | 渡さない。`setup.request` のように作者が押す形だけ（いまの `setupAI`・`toggleExternalAccess` の2件は B のまま） |
| 〔消す〕（7件） | 戻せない、または作者が見る前に消える | 渡さない。作り直せる控え（検索索引）だけは確認つきの C1 にしてよい |
| 〔作者の判断〕診断の答え・承認・目標・章立て・伏線の台帳・記録の手入力（23件） | 作者が決めることを外部AIが決めると、作者の判断の記録にならない（診断は作者が答える問い。承認待ちを外部AIが採ると門番の2段が1段になる） | **提案として置く器を広げる**（章立て・伏線・年表の時期・予定の案を、作者が採否する場所へ）。採るのは作者 |

## 設計の案

「ほとんどの機能」を数で言うと、いま A＋B が 48/185（26％）。C1 と C2 を全部足すと 96/185（52％）。C4〔作者の判断〕23件のうち提案の器で置けるもの（章・伏線・年表・予定など）と、C4 の「結果を返すだけなら C2」（ルビ・傍点・口述整形など）を足すと6割台になる。画面の並び・音声などの C3 は数えても意味が無いので、**「ほとんど」の目安は、作者が外部AIに頼みたくなる操作の大半**と読むのがよい。**C4 の68件は、どの案でも直接は渡さない**（作者が「渡してよい」と裁定したものを除く）。

### 案1：機能ごとに道具を足す

C2 は読む道具を、C1 は `run.request` の白名簿の行を、1件ずつ足す。

- **安全**：高い。足すたびに白名簿と検算が付き、許可も機能の単位で出せる
- **作者の確認の手間**：今と同じ（`run.request` は毎回確認。読むだけは最初の許可だけ）
- **実装の量**：大きい（C1・C2 で48件。実行口を機能ごとに作る）
- **保守**：コマンドが増えても MCP は自動では追わない。追い忘れは「届かない」として残るだけで、壊れはしない
- **注意**：読む道具を1本ずつ足すと `tools/list` が太る（6.87.15 で 56本を10本に束ねたのは、繋ぐたびに読まれる量を減らすため）

### 案2：`run.request` に「コマンドを名前で頼む」汎用の口を足し、許可の印で絞る

`run.request` に `command: "novelai.exportPdf"` のように名前で頼む形を足し、VS Code の中で `executeCommand` する。許可は接続元×コマンドで出す。

- **安全**：低い。**6.87.7「VS Code のコマンドをそのまま MCP へ並べない」と正面からぶつかる**。理由は2つ：コマンドの中の選ぶ画面・保存の確認・ファイルの選択はそのまま作者の画面に出るので、**作者が席に居ないと止まる**／コマンドは結果を返す形になっていない（`done` に何も入らない）。さらに、白名簿をコマンド名で持つと、C4 のコマンドを白名簿へ入れ忘れない限り安全、という「入れ忘れの安全」になる
- **先例はある**：`setup.request` が既にこの形（白名簿8段＋作者の確認、結果は返さない）。拡げること自体は小さい
- **作者の確認の手間**：毎回のモーダルに加えて、コマンドの中の確認も出る
- **実装の量**：小さい（口1つ）
- **保守**：コマンドが増えると自動で頼めるようになる——**それが危うさでもある**。許可の `"*"` は「これから足す道具まで含めて許す」（6.87.14）ので、`*` を置いた作品では新しいコマンドが黙って開く

### 案3（推奨）：3つの口に束ね、許可を階級で分ける

| 口 | 何を入れるか | 形 |
|---|---|---|
| **読む口**（新しい道具1本。例：`novel.read`、`kind` で分ける） | C2 の読むもの：設定資料・相関図・略図・年表・伏線一覧・再開用資料・執筆統計・予定・マニュアル・投稿用の変換・書き出しの中身・編集履歴・相談ログ・ログ | VS Code 不要。1本に束ねて `tools/list` を太らせない（`novel.run` の `feature` と同じ考え） |
| **AIの機能**（いまの `novel.run` に `feature` を足す） | C2 のAI：告知文・対話式プロット・プロットの助言・口述整形（結果を返すだけ） | プロンプトは既に `vscode` 非依存。検算の関数を `core/` に揃えるのが本体の作業 |
| **走らせる口**（いまの `run.request` の白名簿を広げる） | C1：書き出し（PDF・EPUB）・AI接続確認・チューニング・祝日・応募先・新しいファイルを作るだけの操作・編集部提案の取り込み・抽出や冒頭診断など `novel.run` にあって白名簿に無い機能、それに「開く依頼」と「見えない画面で焼く」 | 確認のモーダル・上限・合言葉・期限は今のまま。**機能ごとに結果を返す実行口を作る**（コマンドは叩かない。6.87.22 と同じ） |
| **提案の器**（いまの `novel.propose` の `kind` を広げる） | C4〔作者の判断〕のうち、案なら置けるもの：章立て・伏線の登録と状態・年表の時期・予定の段 | 作者が採否する場所へ置くだけ。台帳は書かない |

許可は**階級**で分ける：「読む」「走らせる（作者のAIで）」「置く（提案）」「新しく作る」。いまの `"*"` が覆うのは「読む」と「走らせる」まで（作者に訊く点の2）。

- **安全**：高い。C4 は口が無いので、入れ忘れでは開かない。書く系は今の例外3つ＋提案の器だけ
- **作者の確認の手間**：走らせる口は毎回確認（今と同じ）。読む口・提案の器は最初の許可だけ
- **実装の量**：中。読む口は既にある純粋な部品を呼ぶものが多い（C2 の大半が難しさ「低」）
- **保守**：コマンドを足しても自動では追わない。代わりに**「コマンドごとの区分の表」を `core/` に置き、新しいコマンドに区分が無ければテストで落とす**（`cross/` の網）。追い忘れが「黙って届かない」にならず、足した人が区分を決めることになる

### 推奨

**案3。** 案2は実装が小さいが、6.87.7 の根拠（作者が席に居ないと止まる・結果が返らない）がそのまま残り、`"*"` と組むと新しいコマンドが黙って開く。案1は安全だが道具が増えすぎる。案3は案1を「読む口1本・AIは `feature`・実行は白名簿」に束ねたもので、6.87.7 の本文（コマンドをそのまま並べない・原稿を書き換えない）は変えずに済む。変えるのは許可の階級（6.87.14）と、**例外〔何もない所に新しく作るだけ〕の範囲を広げるかどうか**（作者に訊く点3）だけ。

### 最初に足すと効果の大きい10件

外部AIが作者の相談に乗るときに**最初に欲しくなるのは「作品の今を読むこと」**なので、読む口を先にする。

| 順 | 何を | 区分→どこへ | 難しさ | 理由 |
|---|---|---|---|---|
| 1 | 読む口を新設し、`kind: settings`（設定資料の記録・語から引く） | C2 → 新しい道具（`mcp/tools/` に1ファイル。`shared.ts` の `readSettingsRecords` を使う） | 低 | いま外部AIが設定資料を読むには `novel.material`（矛盾検知の材料）を流用するしかない。ファイルを読めない外部AI（Claude Desktop など）では読めない |
| 2 | 同じ口に `kind: resume`（再開用資料） | C2 → `core/resumeSheet.ts` | 低 | 「続きを書く前に」の相談でいちばん効く1枚 |
| 3 | 同じ口に `kind: foreshadows`（伏線一覧） | C2 → `core/foreshadowStore.ts`・`foreshadowMarkdown.ts` | 低 | 伏線検知の結果と台帳を突き合わせられる |
| 4 | 同じ口に `kind: chronicle`・`relations`・`locations`（年表・相関図・略図の中身） | C2 → `core/chronicle.ts`・`relationGraph.ts`・`locationSketch.ts` | 低 | 図は画面だけでも、中身は外部AIが文で扱える |
| 5 | `run.request` の白名簿に `opening`・`factContradiction`・`settings`（抽出。保存は今の `extract.commit`） | C1 → `core/runRequest.ts` の `RUN_FEATURES` と `features/runRequestRunners.ts` | 中 | `novel.run` にあるのに作者のクラウドAIで走らせられない機能。白名簿に1行＋実行口 |
| 6 | `run.request` に `testAI`（AI接続確認） | C1 → 同上 | 低 | 「作者のAIがいま動くか」を外から確かめられる。ほかの依頼の前に使える |
| 7 | 同じ口に `kind: writingStats`（執筆量・目標） | C2 → `core/writingStats.ts`（記録の読みを `writingStatsStore.ts` から切り出す） | 中 | 予定（`schedule.milestones`）と組んで進み具合の相談ができる |
| 8 | 同じ口に `kind: posting`（投稿サイト用に変換した本文・題） | C2 → `core/postingConvert.ts` | 低 | 投稿そのものは渡さず、貼る文だけを作れる |
| 9 | `novel.run` に `announce`（告知文）を足す | C2 → `prompts/announce.ts` を feature に | 中 | 生成だけで、公開は作者 |
| 10 | `run.request` に書き出し（`exportPdf`・`exportEpub`）。表紙は別担当の「焼く」を使う | C1 → 実行口2つ | 中 | 書き出しは新しいファイルを作るだけで、原稿を変えない |

11件目以降の候補：提案の器（章立て・伏線）・「開く依頼」・`kind: editHistory`／`chatLog`／`log`（許可の鍵を分けてから）・コマンドごとの区分の表と見張りのテスト。**区分の表と見張りは、10件のどこかで先に入れると後の追い忘れが止まる**（1件目と一緒に入れるのがよい）。

## 作者に決めてもらう点

選択肢で訊ける形にしてある。

1. **進め方の案**
   - 案3（3つの口に束ね、許可を階級で）〔推奨〕
   - 案1（機能ごとに道具を足す）
   - 案2（コマンドを名前で頼む汎用の口。6.87.7 を改める）
2. **許可の `"*"` が覆う範囲**（6.87.14 の変更になる）
   - 「読む」と「走らせる（毎回確認つき）」まで。提案を置く・新しく作るは別の許し〔推奨〕
   - いまのまま全部（これから足す口も含む）
   - 「読む」だけ
3. **「新しいファイルを作るだけ」の操作（話の追加・プロット・単話プロット・メモ・Word 変換）を外から頼めるようにするか**（6.87.7 の例外を広げる）
   - `run.request` で、毎回作者の確認つきなら頼める〔推奨〕
   - MCP から直接（`extract.commit` と同じ、確認なし）
   - 頼めないまま
4. **画面でしか作れないもの（表紙を焼く・図を画像に）の届け方**
   - 頼まれたら画面を開いて同じ関数で作る。作者の画面に一瞬出ることを確認に書く〔推奨〕
   - 作者が画面を開いているときだけ受ける
   - 届かせない
5. **〔作者の判断〕のうち、提案として置けるようにするもの**（複数選べる）
   - 章立て／伏線の登録と状態／年表の時期・別筋／予定の段
6. **相談ログ・ログ・編集履歴を外部AIに読ませるか**（作者の相談の中身や本文の断片が出る）
   - 読ませる。ただし別の許可の鍵にする〔推奨〕
   - 読ませない
7. **最初の10件の順**
   - 上の表のまま〔推奨〕
   - 走らせる口（5・6・10）を先に
   - 読む口（1〜4・7・8）だけ先に

## 作者の裁定（2026-10-16）

1. 進め方：**案3（3つの口に束ね、許可を階級で分ける）**
2. 許可の `"*"`：**いまのまま全部**（これから足す口も含む）。ただし 6 の相談ログ・ログ・編集履歴は `"*"` に含めない別の鍵
3. 新しいファイルを作るだけの操作：**`run.request` で、毎回作者の確認つきで頼める**
4. 画面でしか作れないもの：**頼まれたら画面を開いて同じ関数で作る**（作者の画面に一瞬出ることを確認の文に書く）
5. 提案として置けるもの：**章立て・伏線の登録と状態・予定の段**（年表の時期・別筋は置かない）
6. 相談ログ・ログ・編集履歴：**別の許可の鍵で読ませる**
7. 最初の10件：**表のまま**（区分の表と見張りのテストを1件目と一緒に入れる）
