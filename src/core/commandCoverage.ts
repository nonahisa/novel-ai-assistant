/**
 * コマンドごとに、外部AI（MCP）からどこまで届くかの区分（設計書6.87.24）。
 *
 * **作者の指示（2026-10-16）「外部AIがMCPを操作して、ほとんどの機能が利用できるように」**
 * に向けた棚卸し（`docs/measurements/2026-10-16-mcp-coverage.md`）の表を、コードへ移したもの。
 *
 * ## なぜコードに置くか
 *
 * MCP はコマンドを自動では追わない（設計書6.87.7「VS Code のコマンドをそのまま MCP へ
 * 並べない」）。コマンドを足しても、外部AIから届くかどうかは誰も決めないまま残る。
 * そこで、`package.json` のコマンドが**この表に無ければテストで落とす**
 * （`test/unit/cross/commandCoverage.test.ts`）。足した人が区分を決めることになり、
 * 追い忘れが「黙って届かない」にならない。
 *
 * ## 区分
 *
 * | 区分 | 意味 |
 * |---|---|
 * | A | MCP の道具で直接できる（読む・検算・AIを撃つ・承認待ちへ置く・新しい資料を作る例外） |
 * | B | 動いている VS Code に頼めばできる（`run.request`・`setup.request`・`guide.spotlight`） |
 * | C1 | `run.request` の白名簿に足せば届く |
 * | C2 | VS Code の要らない道具で足りる（読む口 `novel.read` の kind か、`novel.run` の feature） |
 * | C3 | 画面の中でしかできない |
 * | C4 | 外部AIに渡さない（`reason` に理由の種類） |
 *
 * **C4 は口を作らない。** 渡すかどうかは作者の裁定で決まり、表を書き換えただけでは
 * 何も開かない（開くのは道具を足したときだけ）。
 *
 * 表を直したら、測定文書の件数も読み比べること（あちらは 2026-10-16 時点の記録）。
 */

export type CommandReach = "A" | "B" | "C1" | "C2" | "C3" | "C4";

/** C4 の理由の種類（測定文書の「C4 を渡さない理由」の表と同じ5つ） */
export type CommandWithheldReason = "原稿" | "送信" | "設定" | "消す" | "作者の判断";

export interface CommandCoverage {
  class: CommandReach;
  /** 画面に出る名前（棚卸しの表の「機能」の欄） */
  label: string;
  /**
   * 棚卸しのあとで足した道（どの道具のどの指定で届くか）。棚卸しのあとで届くように
   * したものだけ。**既に A だった機能に足した道も書く**——冒頭診断・事実の照合・抽出は
   * `novel.run` で A だったが、作者のAI設定で走らせる `run.request` の道を 2026-10-16 に足した
   */
  via?: string;
  /** C4 のときだけ。なぜ渡さないか */
  reason?: CommandWithheldReason;
}

export const COMMAND_COVERAGE: Readonly<Record<string, CommandCoverage>> = {
  // ── 作品・登録・始め方
  "novelai.addWork": { class: "B", label: "フォルダー登録" },
  "novelai.collectUnregisteredWorks": { class: "C2", label: "未登録作品検索" },
  "novelai.importWorkFromZip": { class: "C4", label: "バックアップ取込", reason: "作者の判断" },
  "novelai.createWork": { class: "B", label: "新規作品を作成" },
  "novelai.renameWork": { class: "C4", label: "作品名変更", reason: "設定" },
  "novelai.setSeries": { class: "C4", label: "シリーズ連結", reason: "設定" },
  "novelai.removeWork": { class: "C4", label: "作品の登録を解除", reason: "消す" },
  "novelai.createWorkWithPlot": { class: "B", label: "プロット起点" },
  "novelai.createWorkFromManuscript": { class: "B", label: "本文起点" },
  "novelai.addWorkFromGithub": { class: "C4", label: "GitHubから作品を追加", reason: "送信" },
  "novelai.mergeIntoLibrary": { class: "C4", label: "書庫集約", reason: "作者の判断" },
  "novelai.refresh": { class: "C1", label: "再読み込み" },
  "novelai.openWorkFolder": { class: "C3", label: "作品フォルダを開く" },
  "novelai.addEpisode": { class: "C1", label: "新規話数ファイルを追加" },
  // ── プロット・単話プロット・章
  "novelai.createPlot": { class: "C1", label: "プロット自力作成" },
  "novelai.openPlotMode": { class: "C3", label: "プロットモード" },
  "novelai.setPlotBasics": { class: "C4", label: "形式・ジャンル", reason: "作者の判断" },
  "novelai.setWorkKind": { class: "C4", label: "作品の種類（小説・台本など）", reason: "作者の判断" },
  "novelai.generatePlot": { class: "A", label: "プロット逆算" },
  "novelai.plotInterview": { class: "C2", label: "対話式プロット作成" },
  "novelai.createEpisodePlot": { class: "C1", label: "単話プロット作成" },
  "novelai.episodePlotToPlotMode": { class: "C3", label: "プロットモードへ" },
  "novelai.previousEpisodePlot": { class: "C3", label: "前の話の単話プロット" },
  "novelai.nextEpisodePlot": { class: "C3", label: "次の話の単話プロット" },
  "novelai.checkEpisodePlot": { class: "A", label: "単話プロット検査" },
  "novelai.proposeChapters": { class: "A", label: "章立て提案" },
  "novelai.suggestChapterName": { class: "A", label: "この章の名前の案を出す" },
  "novelai.startChapter": { class: "A", label: "ここから章を始める", via: "novel.propose kind: chapter（案を置くだけ。採るのは作者）" },
  "novelai.renameChapter": { class: "A", label: "章の名前を変える", via: "novel.propose kind: chapter（案を置くだけ。採るのは作者）" },
  "novelai.removeChapter": { class: "C4", label: "章を外す", reason: "消す" },
  "novelai.chaptersFromHeadings": { class: "C4", label: "章見出し反映", reason: "作者の判断" },
  "novelai.importChaptersFromBackup": { class: "C4", label: "章立て取込（バックアップから）", reason: "作者の判断" },
  // ── 相談・診断・案内
  "novelai.openChat": { class: "A", label: "AIに相談する" },
  "novelai.openChatPanel": { class: "A", label: "AI相談（大きく開く）" },
  "novelai.openChatLog": { class: "A", label: "相談ログ", via: "novel.read kind: chatLog（名指しの鍵。\"*\" では読めない）" },
  "novelai.chooseChatWork": { class: "C3", label: "相談作品選択" },
  "novelai.setAdvicePolicy": { class: "C4", label: "助言方針（診断）", reason: "作者の判断" },
  "novelai.setAuthorReaderType": { class: "C4", label: "あなた自身の読者タイプ（診断）", reason: "作者の判断" },
  "novelai.openTargetReader": { class: "C2", label: "ターゲット読者" },
  "novelai.runReaderTargetDiagnosis": { class: "C4", label: "ターゲット読者診断", reason: "作者の判断" },
  "novelai.openTargetSheet": { class: "C2", label: "ターゲットシート" },
  "novelai.showThreeCircles": { class: "C2", label: "3つの輪" },
  "novelai.runWriterDiagnosis": { class: "B", label: "作家タイプ診断" },
  "novelai.openManual": { class: "C2", label: "使い方（マニュアル）" },
  "novelai.openSceneGuide": { class: "C2", label: "場面別案内" },
  // ── 執筆量・予定・公募
  "novelai.showWritingStats": { class: "A", label: "執筆統計", via: "novel.read kind: writingStats" },
  "novelai.showAllWorksWritingStats": { class: "C2", label: "全作品執筆統計" },
  "novelai.setWorkGoals": { class: "C4", label: "作品目標設定", reason: "作者の判断" },
  "novelai.openSchedule": {
    class: "A",
    label: "スケジュール",
    via: "novel.read kind: schedule（段の id を読み、novel.propose kind: schedule で段の案を置く）",
  },
  "novelai.importHolidays": { class: "C1", label: "祝日を取り込む" },
  "novelai.exportScheduleIcs": { class: "A", label: "スケジュールをカレンダーへ書き出す" },
  "novelai.suggestContests": { class: "C1", label: "応募先をAIに提案してもらう" },
  // ── AIの設定・チューニング
  "novelai.setupAI": { class: "B", label: "AI設定" },
  "novelai.assignFeatureAI": { class: "C4", label: "機能別AI割当", reason: "設定" },
  "novelai.testAI": { class: "B", label: "AI接続確認", via: "run.request feature: testAI" },
  "novelai.measureContext": { class: "C1", label: "AIチューニング" },
  "novelai.showTuningStats": { class: "A", label: "AIチューニング一覧" },
  "novelai.forgetTuning": { class: "C4", label: "AIチューニング削除", reason: "消す" },
  "novelai.setupOllama": { class: "B", label: "Ollama導入" },
  "novelai.setupLmStudio": { class: "B", label: "LM Studio導入" },
  "novelai.selectOllamaExecutable": { class: "C4", label: "Ollama実行ファイル位置", reason: "設定" },
  "novelai.openExtensionSettings": { class: "C4", label: "設定管理", reason: "設定" },
  "novelai.manageConfirmSkips": { class: "C4", label: "確認省略解除", reason: "設定" },
  "novelai.runFullSetup": { class: "B", label: "セットアップ" },
  "novelai.diagnoseWeb": { class: "C1", label: "動作診断（ブラウザ版の確認用）" },
  "novelai.showVersion": { class: "A", label: "バージョン確認" },
  "novelai.showLog": { class: "A", label: "ログ表示", via: "novel.read kind: log（名指しの鍵。\"*\" では読めない）" },
  // 何を外へ出すかを作者が確認の画面で決める（設計書8.5）。外部AIに代わりに押させない
  "novelai.exportIssueReport": { class: "C4", label: "障害報告用の記録を書き出す", reason: "作者の判断" },
  // ── 書き出し
  "novelai.exportPdf": { class: "B", label: "PDF出力（印刷用）", via: "run.request feature: exportPdf" },
  "novelai.exportEpub": { class: "B", label: "EPUB出力（試作）", via: "run.request feature: exportEpub" },
  "novelai.openEpubEditor": { class: "C3", label: "EPUBエディター（試作）" },
  "novelai.exportImeDictionary": { class: "C2", label: "IME辞書出力" },
  "novelai.generateSettingsDocs": { class: "C2", label: "設定資料集出力" },
  "novelai.exportSettingsForAudience": { class: "C2", label: "提供先別出力" },
  "novelai.generateCharacterDocs": { class: "C2", label: "人物一覧を生成" },
  "novelai.generateLocationDocs": { class: "C2", label: "場所一覧を生成" },
  "novelai.generateAbilityDocs": { class: "C2", label: "スキル一覧を生成" },
  "novelai.generateWorldDocs": { class: "C2", label: "世界観一覧を生成" },
  // ── 設定資料
  "novelai.extractSettings": { class: "A", label: "一括抽出", via: "run.request feature: settings" },
  "novelai.extractCharactersOnly": { class: "A", label: "人物抽出" },
  "novelai.extractLocationsOnly": { class: "A", label: "場所抽出" },
  "novelai.extractAbilitiesOnly": { class: "A", label: "スキル抽出" },
  "novelai.extractOrganizationsOnly": { class: "A", label: "組織抽出" },
  "novelai.extractWorldOnly": { class: "A", label: "世界観抽出" },
  "novelai.openSettingsPanel": { class: "A", label: "設定資料集閲覧", via: "novel.read kind: settings" },
  "novelai.showSettingsForTerm": { class: "A", label: "設定情報を表示", via: "novel.read kind: settings（term）" },
  "novelai.openRelationGraph": { class: "A", label: "人物相関図", via: "novel.read kind: relations" },
  "novelai.openLocationSketch": { class: "A", label: "場所の略図", via: "novel.read kind: locations" },
  "novelai.openChronicle": { class: "A", label: "年表", via: "novel.read kind: chronicle" },
  "novelai.editTimeline": { class: "C4", label: "作中時期・別筋登録", reason: "作者の判断" },
  "novelai.manageCustomFields": { class: "C4", label: "設定資料項目追加", reason: "設定" },
  "novelai.applyPendingUpdates": { class: "C4", label: "設定資料更新分反映", reason: "作者の判断" },
  "novelai.unifyCharacters": { class: "C4", label: "人物重複統合", reason: "作者の判断" },
  "novelai.renameCharacter": { class: "C4", label: "人物名変更", reason: "原稿" },
  "novelai.applyRenameToRecords": { class: "C4", label: "人物名変更の資料反映", reason: "原稿" },
  "novelai.checkNames": { class: "A", label: "名前点検" },
  // ── 校正・検知
  "novelai.finishNewWork": { class: "C1", label: "支援機能全工程実行" },
  "novelai.runProofreadingSuite": { class: "B", label: "校正一括実行" },
  "novelai.checkTypos": { class: "A", label: "誤字脱字検知" },
  "novelai.checkTyposForFile": { class: "A", label: "この話の誤字脱字を検知" },
  "novelai.checkProofread": { class: "A", label: "推敲" },
  "novelai.checkOpening": { class: "A", label: "冒頭診断", via: "run.request feature: opening" },
  "novelai.checkContradictions": { class: "A", label: "矛盾検知" },
  "novelai.checkFactContradictions": { class: "A", label: "矛盾検知（事実の照合）", via: "run.request feature: factContradiction" },
  "novelai.checkLocationConsistency": { class: "A", label: "位置関係の照合" },
  "novelai.checkDeviations": { class: "A", label: "プロット逸脱検知" },
  "novelai.checkForeshadows": { class: "A", label: "伏線検知" },
  "novelai.checkForeshadowResolution": { class: "A", label: "伏線回収確認" },
  "novelai.checkNotation": { class: "A", label: "表記ゆれ検知" },
  "novelai.manageKeepWords": { class: "C4", label: "指摘対象外管理", reason: "作者の判断" },
  "novelai.openForeshadows": { class: "A", label: "伏線一覧", via: "novel.read kind: foreshadows" },
  "novelai.addForeshadow": { class: "A", label: "伏線手動追加", via: "novel.propose kind: foreshadow（案を置くだけ。採るのは作者）" },
  "novelai.setForeshadowStatus": { class: "A", label: "伏線状態変更", via: "novel.propose kind: foreshadow（foreshadowId。案を置くだけ）" },
  "novelai.resumeWriting": { class: "A", label: "再開用資料", via: "novel.read kind: resume" },
  "novelai.openProposals": { class: "A", label: "提案パネルを開く" },
  "novelai.pruneFindings": { class: "C4", label: "期限切れ指摘消去", reason: "消す" },
  "novelai.searchScenes": { class: "A", label: "場面検索" },
  "novelai.findSimilarScenes": { class: "C2", label: "類似場面検出" },
  "novelai.setupVectorSearch": { class: "B", label: "ベクトル検索準備" },
  "novelai.buildVectorIndex": { class: "B", label: "検索索引作成／更新" },
  "novelai.buildVectorIndexAll": { class: "B", label: "検索索引作成／更新（全作品）" },
  "novelai.clearVectorIndex": { class: "C4", label: "検索索引削除", reason: "消す" },
  // ── 本文の操作・ファイル
  "novelai.deleteEpisodeFile": { class: "C4", label: "ファイルを削除", reason: "消す" },
  "novelai.insertEpisodeBefore": { class: "C4", label: "この話の前に挿入", reason: "原稿" },
  "novelai.removeEpisodeAndRenumber": { class: "C4", label: "この話を削除（話数を詰める）", reason: "原稿" },
  "novelai.splitCollectedFile": { class: "C4", label: "話ごとのファイルに分ける", reason: "原稿" },
  "novelai.renameWithSubtitle": { class: "C4", label: "ファイル名にサブタイトルを付ける", reason: "原稿" },
  "novelai.convertToMarkdown": { class: "C4", label: "本文 .md 化", reason: "原稿" },
  "novelai.unifyEol": { class: "C4", label: "改行コード統一", reason: "原稿" },
  "novelai.convertDocxToMarkdown": { class: "C1", label: "Word 原稿変換" },
  "novelai.openVertical": { class: "C3", label: "縦書き表示" },
  "novelai.openEpisode": { class: "C3", label: "話を開く" },
  "novelai.readManuscriptAloud": { class: "C3", label: "原稿読み上げ" },
  "novelai.addEmphasis": { class: "C4", label: "傍点付与", reason: "原稿" },
  "novelai.addRuby": { class: "C4", label: "ルビ付与", reason: "原稿" },
  "novelai.importRuby": { class: "C4", label: "投稿サイトルビ取込", reason: "原稿" },
  "novelai.dictationClean": { class: "C4", label: "口述文整形", reason: "原稿" },
  "novelai.transcribePhotos": { class: "C3", label: "写真から書き起こし" },
  "novelai.copyForPosting": { class: "A", label: "コピー（投稿サイト用）", via: "novel.read kind: posting" },
  "novelai.copyBodyForPosting": { class: "A", label: "コピー（投稿サイト用）", via: "novel.read kind: posting" },
  "novelai.copySubtitle": { class: "A", label: "サブタイトルをコピー" },
  "novelai.chooseStepWork": { class: "C3", label: "ステップメニューの作品を選ぶ" },
  "novelai.addWorkMemo": { class: "C1", label: "メモ追加" },
  "novelai.removeWorkMemo": { class: "C4", label: "メモを削除（ごみ箱へ）", reason: "消す" },
  "novelai.transferMemoToWork": { class: "C4", label: "このメモを作品へ移管", reason: "作者の判断" },
  // ── 校正・メモパネル・編集部
  "novelai.openSceneMemos": { class: "C2", label: "校正・メモパネルを開く" },
  "novelai.nextSceneMemo": { class: "C3", label: "次のメモへ" },
  "novelai.prevSceneMemo": { class: "C3", label: "前のメモへ" },
  "novelai.addSceneMemo": { class: "C4", label: "ここにメモを足す", reason: "原稿" },
  "novelai.importOutboxInbox": { class: "A", label: "原稿箱を取り込む" },
  "novelai.showEditHistory": { class: "A", label: "編集履歴", via: "novel.read kind: editHistory（名指しの鍵。\"*\" では読めない）" },
  "novelai.reviewProposals": { class: "C4", label: "編集部提案確認", reason: "作者の判断" },
  "novelai.toggleReviewLock": { class: "C4", label: "校閲開始／終了", reason: "作者の判断" },
  "novelai.switchMode": { class: "C4", label: "作者／編集者切替", reason: "設定" },
  "novelai.shareWithEditor": { class: "C4", label: "編集部共有", reason: "送信" },
  "novelai.collectEditorProposals": { class: "C1", label: "編集部提案取込" },
  // ── 同期・GitHub
  "novelai.gitSync": { class: "C4", label: "GitHubと同期", reason: "送信" },
  "novelai.saveAndSync": { class: "C4", label: "保存・同期", reason: "送信" },
  "novelai.gitPull": { class: "C4", label: "別の環境の変更を取り込む", reason: "原稿" },
  "novelai.gitPush": { class: "C4", label: "この環境の変更を送信する", reason: "送信" },
  "novelai.syncAllWorks": { class: "C4", label: "全作品同期", reason: "送信" },
  "novelai.resolveConflicts": { class: "C4", label: "競合解決", reason: "原稿" },
  "novelai.resolveDivergence": { class: "C4", label: "分岐合流", reason: "原稿" },
  "novelai.gitRestore": { class: "C4", label: "過去の版に戻す", reason: "原稿" },
  "novelai.setupGithub": { class: "C4", label: "GitHub初期設定", reason: "設定" },
  // ── あらすじ・紹介文
  "novelai.generateSynopses": { class: "A", label: "各話あらすじ" },
  "novelai.openSynopsisDocs": { class: "C2", label: "紹介文・あらすじ閲覧" },
  "novelai.generateWorkBlurb": { class: "A", label: "作品紹介文" },
  "novelai.generateCatchphrases": { class: "A", label: "キャッチコピー案" },
  // ── 投稿・告知・読者の反応
  "novelai.generateAnnouncement": { class: "A", label: "更新SNS告知文作成", via: "novel.run feature: announce" },
  "novelai.configureAnnouncement": { class: "C4", label: "SNS告知設定", reason: "設定" },
  "novelai.postNewEpisode": { class: "C4", label: "新話投稿", reason: "送信" },
  "novelai.postThisEpisode": { class: "C4", label: "この話を投稿する", reason: "送信" },
  "novelai.configurePostingSites": { class: "C4", label: "投稿サイト設定", reason: "設定" },
  "novelai.recordRanking": { class: "C4", label: "ランキング記録", reason: "作者の判断" },
  "novelai.importReaderStats": { class: "C3", label: "読者反応自動取込" },
  "novelai.recordReaderStats": { class: "C4", label: "読者反応手動入力", reason: "作者の判断" },
  // ── 外部AI・画面の並び
  "novelai.toggleExternalAccess": { class: "B", label: "外部AI許可／取消" },
  "novelai.writeAiInstructions": { class: "C4", label: "外部AI指示書設置", reason: "設定" },
  "novelai.connectClaudeCode": { class: "C4", label: "Claude Code接続", reason: "設定" },
  "novelai.exitChatFocus": { class: "C3", label: "作品一覧とメニューを出す" },
  "novelai.soloWorks": { class: "C3", label: "他のメニューを閉じる" },
  "novelai.soloSteps": { class: "C3", label: "他のメニューを閉じる" },
  "novelai.soloActions": { class: "C3", label: "他のメニューを閉じる" },
  "novelai.soloChat": { class: "C3", label: "他のメニューを閉じる" },
  "novelai.showAllViews": { class: "C3", label: "すべてのメニューを出す" },
};
