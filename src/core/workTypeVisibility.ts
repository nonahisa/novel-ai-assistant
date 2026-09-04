import type { WorkFormatKey } from "./workFormat";

/**
 * タイプ×機能の対応表（設計書6.70.1）。
 *
 * 作者の指定（2026-09-04）：「作品タイプによって、必要のない作業は
 * ステップや右クリックに表示させないようにしてください」。
 *
 * ## 表は1か所しか持たない
 *
 * 簡単ステップメニュー（`views/stepMenu.ts`）と作品一覧の右クリック
 * （`package.json` の `when` ＋ `views/workTree.ts` の `contextValue`）が、
 * どちらもここを読む。写しを作ると、片方だけ直したときに
 * 「ステップからは消えているのに右クリックには出る」が起き、
 * **画面を見比べるまで気づけない。**
 *
 * **詳細メニュー（`views/actionList.ts`）は絞らない。** 「全部はここに
 * ある」という受け皿を1か所残す。隠れた機能を探せなくなる事故を防ぎ、
 * 「メモ集から物語が生まれた」ような越境の道も塞がないためである。
 *
 * ## 迷ったら出す
 *
 * 表に無いコマンドは**出す**。隠しすぎると、作者は機能が消えたことにも
 * 気づけない（見えすぎは、押してから「合いません」と分かるだけで済む）。
 * 載せ忘れは `test/unit/workTypeVisibility.test.ts` が知らせる。
 *
 * VS Code APIに依存しない。
 */

/**
 * 表の列。**小説の4つの形式（短編・短編集・長編・大長編）は1つの列**に
 * まとめる。長さの違いで出す機能が変わるわけではない（そちらは
 * `formatFit.ts` が実行前に断りを入れる役目を持っている）。
 */
export type WorkTypeColumn = "novel" | "sns" | "memo" | "script";

export const WORK_TYPE_COLUMNS: readonly WorkTypeColumn[] = [
  "novel",
  "sns",
  "memo",
  "script",
];

/**
 * タイプを決めていない作品の印。
 *
 * **「決めていない」を「小説と決めた」と読み替えない。** 絞り込みを
 * しない（いままでどおり全部出す）ことを表す値である。
 */
export const WORK_TYPE_CONTEXT_UNSET = "unset";

/**
 * 作品一覧のノードの種類。`contextValue` の前半になる。
 *
 * メモの枝（設計書6.71）も種別を持つ。**話（`episode`）と混ぜない**
 * ——メモは原稿ではないので、話に出る操作（投稿・章立て・話数の挿入）が
 * 出てはいけない。
 */
export type WorkTreeNodeKind =
  | "work"
  | "chapter"
  | "episode"
  | "memoFolder"
  | "memoFile";

/**
 * 種別の一覧。**`package.json` の `when` と突き合わせるテストが読む。**
 * 種別を足したときに、新しい項目だけが照合から漏れないようにする。
 */
export const WORK_TREE_NODE_KINDS: readonly WorkTreeNodeKind[] = [
  "work",
  "chapter",
  "episode",
  "memoFolder",
  "memoFile",
];

/** その形式が、表のどの列にあたるか。決めていなければ undefined */
export function workTypeColumn(
  format?: WorkFormatKey
): WorkTypeColumn | undefined {
  switch (format) {
    case "sns":
      return "sns";
    case "memo":
      return "memo";
    case "script":
      return "script";
    case "short":
    case "shortCollection":
    case "long":
    case "epic":
      return "novel";
    default:
      return undefined;
  }
}

/**
 * ツリーのノードに付ける `contextValue`（設計書6.70.1）。
 *
 * `package.json` の `when` は**この文字列しか見ない**。
 * 形が変わると右クリックの項目が黙って消えるので、
 * 噛み合っていることをテストで両側から確かめている。
 */
export function workTypeContextValue(
  kind: WorkTreeNodeKind,
  format?: WorkFormatKey
): string {
  return `${kind}-${workTypeColumn(format) ?? WORK_TYPE_CONTEXT_UNSET}`;
}

/**
 * 機能分類（表の行）。
 *
 * **コマンドごとに列を並べない。** 「なぜそのタイプで出すのか」を
 * 分類の名前で残しておかないと、新しいタイプを足すたびに
 * 100件の判断をやり直すことになる。
 */
export type WorkFeature =
  /** どのタイプでも使う（執筆統計・校正・同期・投稿キット・設定など） */
  | "allTypes"
  /** 物語向け（プロット・あらすじ・矛盾・伏線・逸脱・章立て・EPUB・資料抽出） */
  | "story"
  /** 番号で数えるタイプだけ（話数の挿入・削除・合本の分割） */
  | "numbered"
  /** 投稿サイト向けの変換・取り込み */
  | "posting"
  /** 創作メモ集だけ（メモを作品へ移管する。設計書6.71） */
  | "memoOnly";

export const FEATURE_COLUMNS: Record<WorkFeature, readonly WorkTypeColumn[]> = {
  allTypes: ["novel", "sns", "memo", "script"],
  // 脚本は物語である。SNS記事と創作メモ集は続きものではないので、
  // 筋・伏線・登場人物の資料を組み立てる機能はここで落ちる
  story: ["novel", "script"],
  // SNS記事は日付、創作メモ集は題名で並ぶ。詰め直す番号が無い
  numbered: ["novel", "script"],
  /*
    投稿サイト向けの変換は、いまはどのタイプでも出す。

    設計書6.70.1の初案は「SNS記事では note だけに」だが、**絞るのは
    変換先の選択肢の側**であって、操作そのものを消す話ではない
    （変換先の絞り込みは次の作業）。
  */
  posting: ["novel", "sns", "memo", "script"],
  /*
    **ここだけは「迷ったら出す」に倒せない**（設計書6.71）。

    「このメモを作品へ移管」は、押した話ファイルを別の作品の
    `設定/メモ/` へ**動かす**操作である。小説の話に出してしまうと、
    本文が1話まるごと設定資料の下へ消える見え方になる。
    移す元がメモであることが前提なので、メモ集だけに出す。
  */
  memoOnly: ["memo"],
};

/**
 * コマンドごとの機能分類。
 *
 * **`package.json` に登録した全コマンドを載せる**（開発ビルド専用の
 * `novelai.dev.*` を除く）。載せ忘れは全タイプで出続けるので、
 * テストが漏れを知らせる。
 */
export const COMMAND_FEATURES: Readonly<Record<string, WorkFeature>> = {
  // ── 作品の登録・管理。作るときは、まだタイプが無い ──
  "novelai.addWork": "allTypes",
  "novelai.createWork": "allTypes",
  "novelai.createWorkWithPlot": "allTypes",
  "novelai.createWorkFromManuscript": "allTypes",
  "novelai.addWorkFromGithub": "allTypes",
  "novelai.removeWork": "allTypes",
  "novelai.openWorkFolder": "allTypes",
  "novelai.refresh": "allTypes",
  "novelai.mergeIntoLibrary": "allTypes",

  // ── GitHub同期。原稿の中身を問わない ──
  "novelai.setupGithub": "allTypes",
  "novelai.gitSync": "allTypes",
  "novelai.gitPull": "allTypes",
  "novelai.gitPush": "allTypes",
  "novelai.syncAllWorks": "allTypes",
  "novelai.resolveDivergence": "allTypes",
  "novelai.resolveConflicts": "allTypes",
  "novelai.gitRestore": "allTypes",

  // ── 話・メモ・投稿のファイル操作 ──
  "novelai.addEpisode": "allTypes",
  "novelai.deleteEpisodeFile": "allTypes",
  "novelai.convertToMarkdown": "allTypes",
  "novelai.copySubtitle": "allTypes",
  // 番号を詰め直す操作は、番号で数えるタイプだけ
  "novelai.insertEpisodeBefore": "numbered",
  "novelai.removeEpisodeAndRenumber": "numbered",
  "novelai.splitCollectedFile": "numbered",
  "novelai.renameWithSubtitle": "numbered",

  // ── 作品ごとのメモ（設計書6.71） ──
  // メモはどの作品にも要る。**創作メモ集だけのものではない**
  "novelai.addWorkMemo": "allTypes",
  "novelai.removeWorkMemo": "allTypes",
  // 移管だけはメモ集から出る道なので、メモ集の話にしか出さない
  "novelai.transferMemoToWork": "memoOnly",

  // ── 章立て（設計書6.66）。話の連なりがある作品のもの ──
  "novelai.startChapter": "story",
  "novelai.renameChapter": "story",
  "novelai.removeChapter": "story",
  "novelai.proposeChapters": "story",
  "novelai.suggestChapterName": "story",

  // ── プロット・構想 ──
  "novelai.createPlot": "story",
  // プロットモードの画面（設計書6.4.8）。話の連なりを見取り図にするもので、
  // 続きものでない作品（メモ集・SNS記事）には並べる筋が無い
  "novelai.openPlotMode": "story",
  "novelai.plotInterview": "story",
  "novelai.generatePlot": "story",
  "novelai.createEpisodePlot": "story",
  // **タイプを決める入口は、どのタイプでも要る。**
  // ここが消えると、間違えて選んだタイプから戻れなくなる
  "novelai.setPlotBasics": "allTypes",
  "novelai.setWorkGoals": "allTypes",

  // ── 執筆の場 ──
  "novelai.resumeWriting": "allTypes",
  "novelai.openVertical": "allTypes",
  "novelai.readManuscriptAloud": "allTypes",
  "novelai.addRuby": "allTypes",
  "novelai.addEmphasis": "allTypes",
  "novelai.openSceneMemos": "allTypes",
  "novelai.addSceneMemo": "allTypes",
  "novelai.nextSceneMemo": "allTypes",
  "novelai.prevSceneMemo": "allTypes",
  "novelai.openChat": "allTypes",
  "novelai.openChatPanel": "allTypes",
  "novelai.chooseChatWork": "allTypes",
  "novelai.chooseStepWork": "allTypes",

  // ── 執筆量・記録 ──
  "novelai.showWritingStats": "allTypes",
  "novelai.showAllWorksWritingStats": "allTypes",
  "novelai.showEditHistory": "allTypes",
  // 年表と時期・系統は「作中の時間」を並べるもの。
  // 続きものでない作品には並べる筋が無い
  "novelai.openChronicle": "story",
  "novelai.editTimeline": "story",

  // ── 校正・校閲。書いた文字がある限り、どのタイプでも効く ──
  "novelai.checkTypos": "allTypes",
  "novelai.checkTyposForFile": "allTypes",
  "novelai.manageKeepWords": "allTypes",
  "novelai.checkNotation": "allTypes",
  "novelai.checkProofread": "allTypes",
  // 冒頭の掴みは、記事にもメモの書き出しにも効く（全タイプに倒した）
  "novelai.checkOpening": "allTypes",
  // 筋・設定と突き合わせる検知は、物語のあるタイプだけ
  "novelai.checkDeviations": "story",
  // 単話プロットの検査・本文との照合（設計書6.36.3）。
  // 単話プロットそのものが物語向けの道具である
  "novelai.checkEpisodePlot": "story",
  "novelai.checkContradictions": "story",
  "novelai.checkForeshadows": "story",
  "novelai.checkForeshadowResolution": "story",
  "novelai.openForeshadows": "story",
  "novelai.addForeshadow": "story",
  "novelai.setForeshadowStatus": "story",

  // ── 設定資料（登場人物・場所・能力・組織・世界観） ──
  "novelai.extractSettings": "story",
  "novelai.extractCharactersOnly": "story",
  "novelai.extractLocationsOnly": "story",
  "novelai.extractAbilitiesOnly": "story",
  "novelai.extractOrganizationsOnly": "story",
  "novelai.extractWorldOnly": "story",
  "novelai.unifyCharacters": "story",
  "novelai.applyPendingUpdates": "story",
  "novelai.openSettingsPanel": "story",
  "novelai.openRelationGraph": "story",
  "novelai.showSettingsForTerm": "story",
  "novelai.manageCustomFields": "story",
  "novelai.generateSettingsDocs": "story",
  "novelai.generateCharacterDocs": "story",
  "novelai.generateLocationDocs": "story",
  "novelai.generateAbilityDocs": "story",
  "novelai.generateWorldDocs": "story",
  "novelai.checkNames": "story",
  "novelai.renameCharacter": "story",
  "novelai.applyRenameToRecords": "story",
  // IME辞書の元は設定資料だが、**手で足した語も入る**。
  // 入力を楽にする道具なので全タイプに倒した
  "novelai.exportImeDictionary": "allTypes",

  // ── あらすじ・広報 ──
  "novelai.generateSynopses": "story",
  "novelai.openSynopsisDocs": "story",
  "novelai.generateWorkBlurb": "story",
  "novelai.generateCatchphrases": "story",
  // 更新告知は「出したこと」を知らせる文。投稿キットと同じ側に置く
  "novelai.generateAnnouncement": "allTypes",
  "novelai.configureAnnouncement": "allTypes",

  // ── 投稿 ──
  "novelai.copyForPosting": "posting",
  "novelai.copyBodyForPosting": "posting",
  "novelai.importRuby": "posting",
  "novelai.postNewEpisode": "allTypes",
  "novelai.postThisEpisode": "allTypes",
  "novelai.configurePostingSites": "allTypes",
  // 順位はどのタイプの作品にも付く（SNS記事もメモ集も投稿できる）
  "novelai.recordRanking": "allTypes",

  // ── 書き出し ──
  // PDFは「いま手元にある文字をそのまま紙にする」道具なので全タイプ。
  // EPUB（本にする）は物語向けとして扱う（設計書6.70.1の初案どおり）
  "novelai.exportPdf": "allTypes",
  "novelai.exportEpub": "story",
  "novelai.openEpubEditor": "story",

  // ── 編集部とのやり取り ──
  "novelai.switchMode": "allTypes",
  "novelai.shareWithEditor": "allTypes",
  "novelai.collectEditorProposals": "allTypes",
  "novelai.reviewProposals": "allTypes",
  "novelai.toggleReviewLock": "allTypes",

  // ── 拡張機能そのものの設定・道具立て ──
  "novelai.setupAI": "allTypes",
  "novelai.assignFeatureAI": "allTypes",
  "novelai.testAI": "allTypes",
  "novelai.measureContext": "allTypes",
  "novelai.setupOllama": "allTypes",
  "novelai.setupLmStudio": "allTypes",
  "novelai.selectOllamaExecutable": "allTypes",
  "novelai.runFullSetup": "allTypes",
  "novelai.openExtensionSettings": "allTypes",
  "novelai.setupVectorSearch": "allTypes",
  "novelai.buildVectorIndex": "allTypes",
  "novelai.clearVectorIndex": "allTypes",

  // ── 画面の出し入れ・ヘルプ ──
  "novelai.soloWorks": "allTypes",
  "novelai.soloSteps": "allTypes",
  "novelai.soloActions": "allTypes",
  "novelai.soloChat": "allTypes",
  "novelai.showAllViews": "allTypes",
  "novelai.exitChatFocus": "allTypes",
  "novelai.openManual": "allTypes",
  "novelai.showLog": "allTypes",
  "novelai.openChatLog": "allTypes",
  "novelai.diagnoseWeb": "allTypes",
  "novelai.showVersion": "allTypes",
};

/** その操作の機能分類。表に無ければ undefined（＝どのタイプでも出す） */
export function featureOfCommand(command: string): WorkFeature | undefined {
  return COMMAND_FEATURES[command];
}

/** その列（タイプ）で、その操作を見せるか */
export function isCommandVisibleForColumn(
  command: string,
  column: WorkTypeColumn
): boolean {
  const feature = featureOfCommand(command);
  // 表に載っていない操作は隠さない（漏れはテストが知らせる）
  if (!feature) return true;
  return FEATURE_COLUMNS[feature].includes(column);
}

/**
 * その作品で、その操作を見せるか。
 *
 * **タイプを決めていない作品では絞らない。** プロットに形式を書いて
 * いないだけの作品から、機能が消えてはいけない。
 */
export function isCommandVisibleForWorkType(
  command: string,
  format?: WorkFormatKey
): boolean {
  const column = workTypeColumn(format);
  return column === undefined || isCommandVisibleForColumn(command, column);
}
