import type { WorkFormatKey } from "./workFormat";
import { WORK_KINDS, workKindDef, type WorkKindKey } from "./workKind";

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
 * **詳細メニュー（`views/actionList.ts`）は形式では絞らない。** 「全部は
 * ここにある」という受け皿を1か所残す。隠れた機能を探せなくなる事故を防ぎ、
 * 「メモ集から物語が生まれた」ような越境の道も塞がないためである。
 * 種類の軸（下の後半、設計書6.109.7）だけは、**登録した作品が全部
 * 物語でないとき**に限って詳細メニューからも外す（`isCommandVisibleForSomeWork`）。
 *
 * ## 迷ったら出す
 *
 * 表に無いコマンドは**出す**。隠しすぎると、作者は機能が消えたことにも
 * 気づけない（見えすぎは、押してから「合いません」と分かるだけで済む）。
 * 載せ忘れは `test/unit/core/workTypeVisibility.test.ts` が知らせる。
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
  format?: WorkFormatKey,
  /** 作品の種類（設計書6.109.7）。物語でない種類だけが印の後ろに付く */
  workKind?: WorkKindKey
): string {
  const base = `${kind}-${workTypeColumn(format) ?? WORK_TYPE_CONTEXT_UNSET}`;
  const suffix = kindContextSuffix(workKind);
  return suffix ? `${base}-${suffix}` : base;
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
 * **`package.json` に登録した全コマンドを載せる。** 載せ忘れは
 * 全タイプで出続けるので、テストが漏れを知らせる。
 */
export const COMMAND_FEATURES: Readonly<Record<string, WorkFeature>> = {
  // ── 作品の登録・管理。作るときは、まだタイプが無い ──
  "novelai.addWork": "allTypes",
  "novelai.createWork": "allTypes",
  "novelai.createWorkWithPlot": "allTypes",
  "novelai.createWorkFromManuscript": "allTypes",
  "novelai.addWorkFromGithub": "allTypes",
  // ZIPの取り込み（設計書6.98）。中身を見るまでタイプは分からない
  "novelai.importWorkFromZip": "allTypes",
  // 未登録の作品を探す（設計書6.97.4）。こちらも中身を見るまで
  // タイプは分からないうえ、登録する前の操作である
  "novelai.collectUnregisteredWorks": "allTypes",
  // 呼び名を変えるだけの操作。中身が何であっても要る（設計書6.1.1）
  "novelai.renameWork": "allTypes",
  // シリーズのつながり（設計書6.95）。長編でも短編集でも、同じ世界を
  // 書き続けることはある。タイプで絞る理由が無い
  "novelai.setSeries": "allTypes",
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
  "novelai.saveAndSync": "allTypes",
  "novelai.resolveDivergence": "allTypes",
  "novelai.resolveConflicts": "allTypes",
  "novelai.gitRestore": "allTypes",

  // ── 話・メモ・投稿のファイル操作 ──
  "novelai.addEpisode": "allTypes",
  "novelai.deleteEpisodeFile": "allTypes",
  "novelai.convertToMarkdown": "allTypes",
  // 改行コードの食い違いは、作品のタイプと関係なく起きる（設計書5.4.2）
  "novelai.unifyEol": "allTypes",
  // Word からの取り込みは、どのタイプの作品でも起こりうる（設計書6.85）
  "novelai.convertDocxToMarkdown": "allTypes",
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
  "novelai.chaptersFromHeadings": "story",
  "novelai.importChaptersFromBackup": "story",
  "novelai.suggestChapterName": "story",

  // ── プロット・構想 ──
  "novelai.createPlot": "story",
  // プロットモードの画面（設計書6.4.8）。話の連なりを見取り図にするもので、
  // 続きものでない作品（メモ集・SNS記事）には並べる筋が無い
  "novelai.openPlotMode": "story",
  "novelai.plotInterview": "story",
  "novelai.generatePlot": "story",
  "novelai.createEpisodePlot": "story",
  // 単話プロットからの行き来（設計書6.36）。単話プロットと同じく続きものだけ
  "novelai.episodePlotToPlotMode": "story",
  "novelai.previousEpisodePlot": "story",
  "novelai.nextEpisodePlot": "story",
  // **タイプを決める入口は、どのタイプでも要る。**
  // ここが消えると、間違えて選んだタイプから戻れなくなる
  "novelai.setPlotBasics": "allTypes",
  // 種類（設計書6.109）も、消えると間違えた種類から戻れない。必ず全タイプ
  "novelai.setWorkKind": "allTypes",
  "novelai.setWorkGoals": "allTypes",
  // 応募先の提案（設計書6.3.6.5）。隠し機能でステップ・右クリックには出さないが、
  // 表の漏れを見張る試験のために載せる。応募先は作品目標設定と同じく全タイプ
  "novelai.suggestContests": "allTypes",

  // ── 執筆の場 ──
  "novelai.resumeWriting": "allTypes",
  "novelai.openVertical": "allTypes",
  "novelai.readManuscriptAloud": "allTypes",
  "novelai.addRuby": "allTypes",
  "novelai.addEmphasis": "allTypes",
  // 口述の整文（設計書6.83）。声で書くことに、作品のタイプは関わらない
  "novelai.dictationClean": "allTypes",
  "novelai.openSceneMemos": "allTypes",
  "novelai.addSceneMemo": "allTypes",
  "novelai.nextSceneMemo": "allTypes",
  "novelai.prevSceneMemo": "allTypes",
  "novelai.openChat": "allTypes",
  "novelai.openChatPanel": "allTypes",
  "novelai.chooseChatWork": "allTypes",
  "novelai.setAdvicePolicy": "allTypes",
  // 作者自身の読者タイプ（設計書6.101）。**作者ごとの答え**なので、
  // 作品のタイプで出し分ける理由がない
  "novelai.setAuthorReaderType": "allTypes",
  "novelai.chooseStepWork": "allTypes",

  // ── 執筆量・記録 ──
  "novelai.showWritingStats": "allTypes",
  "novelai.showAllWorksWritingStats": "allTypes",
  // スケジュール（設計書6.111）。締切や発売日は作品の種類を問わない
  "novelai.openSchedule": "allTypes",
  "novelai.importHolidays": "allTypes",
  "novelai.exportScheduleIcs": "allTypes",
  "novelai.showEditHistory": "allTypes",
  // 外部AIの利用許可（設計書6.87.10）。**どのタイプの作品でも要る**——
  // 外から読まれうることに、作品の種類は関係ない
  "novelai.toggleExternalAccess": "allTypes",
  // AI用の指示書（設計書6.87.15 柱5）。**どのタイプの作品でも要る**——
  // 外部AIに扱わせるときの決まりに、作品の種類は関係ない
  "novelai.writeAiInstructions": "allTypes",
  // Claude Code とつなぐ（設計書6.87.18）。作品を選ばない
  "novelai.connectClaudeCode": "allTypes",
  // 年表と時期・系統は「作中の時間」を並べるもの。
  // 続きものでない作品には並べる筋が無い
  "novelai.openChronicle": "story",
  "novelai.editTimeline": "story",
  // 場面検索と似た場面の検出（設計書6.19.10）。**書いた文字がある限り効く**
  // ——探す・重なりを見るのに、話の連なりは要らない
  "novelai.searchScenes": "allTypes",
  "novelai.findSimilarScenes": "allTypes",

  /*
    新作をひと通り仕上げる（作者の指示、2026-09-19）。

    **まとめ実行と違って「story」に置く。** 走らせる段に各話あらすじ・
    プロットの逆算・章立て・プロット逸脱が入っており、話の連なりが無い
    作品（メモ集・SNS記事）では、その半分が走らないか的外れになる。
  */
  "novelai.finishNewWork": "story",

  // ── 校正・校閲。書いた文字がある限り、どのタイプでも効く ──
  // まとめ実行（設計書6.80）は、走らせるものを選ぶ画面である。
  // 物語向けの検知も選べるが、**選ばなければ走らない**ので、
  // 入口そのものは誤字脱字と同じ列に置く
  "novelai.runProofreadingSuite": "allTypes",
  "novelai.checkTypos": "allTypes",
  "novelai.checkTyposForFile": "allTypes",
  "novelai.manageKeepWords": "allTypes",
  "novelai.checkNotation": "allTypes",
  "novelai.checkProofread": "allTypes",
  // 古い指摘の片づけ（設計書6.96.4）。どの検知の指摘も同じ置き場に
  // 溜まるので、物語向けの検知しか使わないタイプでも要る
  "novelai.pruneFindings": "allTypes",
  // 冒頭の掴みは、記事にもメモの書き出しにも効く（全タイプに倒した）
  "novelai.checkOpening": "allTypes",
  // 筋・設定と突き合わせる検知は、物語のあるタイプだけ
  "novelai.checkDeviations": "story",
  // 単話プロットの検査・本文との照合（設計書6.36.3）。
  // 単話プロットそのものが物語向けの道具である
  "novelai.checkEpisodePlot": "story",
  "novelai.checkContradictions": "story",
  // 事実の照合による矛盾検知（設計書6.88）。P-12 としばらく並行させる
  "novelai.checkFactContradictions": "story",
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
  // 提供先別の書き出し（設計書6.75）。元が設定資料なので同じ列に載せる
  "novelai.exportSettingsForAudience": "story",
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
  // 読者の反応も同じ（設計書6.79.7）。PVやいいねは作品のタイプを選ばない
  "novelai.importReaderStats": "allTypes",
  "novelai.recordReaderStats": "allTypes",

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
  "novelai.showTuningStats": "allTypes",
  "novelai.forgetTuning": "allTypes",
  "novelai.setupOllama": "allTypes",
  "novelai.setupLmStudio": "allTypes",
  "novelai.selectOllamaExecutable": "allTypes",
  "novelai.runFullSetup": "allTypes",
  "novelai.openExtensionSettings": "allTypes",
  "novelai.manageConfirmSkips": "allTypes",
  "novelai.setupVectorSearch": "allTypes",
  "novelai.runReaderTargetDiagnosis": "allTypes",
  // 「ターゲット読者」（設計書6.108.6）。上の診断・シート・3つの輪を
  // まとめた入口なので、見せ方もそれらと同じ
  "novelai.openTargetReader": "allTypes",
  // ターゲットシート・3つの輪（設計書6.108・6.101）。どちらも押すと
  // 「ターゲット読者」を開く転送になった（2026-09-23）ので、見せ方も同じ
  "novelai.openTargetSheet": "allTypes",
  "novelai.showThreeCircles": "allTypes",
  "novelai.buildVectorIndex": "allTypes",
  "novelai.clearVectorIndex": "allTypes",

  // ── 画面の出し入れ・ヘルプ ──
  "novelai.soloWorks": "allTypes",
  "novelai.soloSteps": "allTypes",
  "novelai.soloActions": "allTypes",
  "novelai.soloChat": "allTypes",
  "novelai.showAllViews": "allTypes",
  "novelai.exitChatFocus": "allTypes",
  "novelai.runWriterDiagnosis": "allTypes",
  "novelai.openManual": "allTypes",
  "novelai.openSceneGuide": "allTypes",
  "novelai.showLog": "allTypes",
  "novelai.openProposals": "allTypes",
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

/* ────────────────────────────────────────────────────────────
   種類の軸（設計書6.109.7）
   ──────────────────────────────────────────────────────────── */

/**
 * 種類（小説・台本・漫画の原作・エッセイ・歌詞）で見る、機能の分類。
 *
 * **形式の表（上）とは別に持つ。** 形式は「どう並べるか」、種類は
 * 「何を書くか」で、別々の軸である（6.109.1）。1つの表に混ぜると、
 * 形式×種類の組み合わせの数だけ列が要る。見せるかどうかは
 * **両方の表が「見せる」と言ったときだけ**になる。
 *
 * - `anyKind`：どの種類でも使う（プロット・章立て・あらすじ・EPUB など。
 *   エッセイにも「伝えたいこと・構成」のプロットがあり、随筆集・詩集も
 *   章に分けて本にする）
 * - `narrative`：物語の種類だけ（登場人物・筋・伏線・時系列を扱う操作）
 */
export type KindFeature = "anyKind" | "narrative";

export const KIND_FEATURE_KINDS: Record<KindFeature, readonly WorkKindKey[]> = {
  anyKind: WORK_KINDS.map((def) => def.key),
  // 台本・漫画の原作は物語である。役名も筋も伏線もある
  narrative: ["novel", "script", "manga"],
};

/**
 * コマンドごとの種類の分類。**形式の表で `story` に置いた操作は全部載せる**
 * （エッセイ・歌詞で要るかを1つずつ決めた跡を残す。漏れはテストが止める）。
 * それ以外の操作は、載っていなければ `anyKind`。
 */
export const COMMAND_KIND_FEATURES: Readonly<Record<string, KindFeature>> = {
  // ── 章立て。随筆集・詩集も章に分けて本にする ──
  "novelai.startChapter": "anyKind",
  "novelai.renameChapter": "anyKind",
  "novelai.removeChapter": "anyKind",
  "novelai.proposeChapters": "anyKind",
  "novelai.chaptersFromHeadings": "anyKind",
  "novelai.suggestChapterName": "anyKind",

  // ── プロット。エッセイ・歌詞にも書き出しの見出しがある（6.109.3） ──
  "novelai.createPlot": "anyKind",
  "novelai.openPlotMode": "anyKind",
  // 聞き取り（6.4.7）と逆算（P-02）は、登場人物と筋を組み立てる道具
  "novelai.plotInterview": "narrative",
  "novelai.generatePlot": "narrative",
  // 単話プロット（6.36）は「この話で誰が何をするか」を書く
  "novelai.createEpisodePlot": "narrative",
  "novelai.episodePlotToPlotMode": "narrative",
  "novelai.previousEpisodePlot": "narrative",
  "novelai.nextEpisodePlot": "narrative",
  "novelai.checkEpisodePlot": "narrative",

  // ── 作中の時間。並べる筋が無い ──
  "novelai.openChronicle": "narrative",
  "novelai.editTimeline": "narrative",
  // 仕上げの流れに逆算・逸脱検知が入っている
  "novelai.finishNewWork": "narrative",

  // ── 筋・設定と突き合わせる検知 ──
  "novelai.checkDeviations": "narrative",
  "novelai.checkContradictions": "narrative",
  "novelai.checkFactContradictions": "narrative",
  "novelai.checkForeshadows": "narrative",
  "novelai.checkForeshadowResolution": "narrative",
  "novelai.openForeshadows": "narrative",
  "novelai.addForeshadow": "narrative",
  "novelai.setForeshadowStatus": "narrative",

  // ── 設定資料（登場人物・場所・能力・組織・世界観） ──
  "novelai.extractSettings": "narrative",
  "novelai.extractCharactersOnly": "narrative",
  "novelai.extractLocationsOnly": "narrative",
  "novelai.extractAbilitiesOnly": "narrative",
  "novelai.extractOrganizationsOnly": "narrative",
  "novelai.extractWorldOnly": "narrative",
  "novelai.unifyCharacters": "narrative",
  "novelai.applyPendingUpdates": "narrative",
  "novelai.openSettingsPanel": "narrative",
  "novelai.openRelationGraph": "narrative",
  "novelai.showSettingsForTerm": "narrative",
  "novelai.manageCustomFields": "narrative",
  "novelai.generateSettingsDocs": "narrative",
  "novelai.exportSettingsForAudience": "narrative",
  "novelai.generateCharacterDocs": "narrative",
  "novelai.generateLocationDocs": "narrative",
  "novelai.generateAbilityDocs": "narrative",
  "novelai.generateWorldDocs": "narrative",
  "novelai.checkNames": "narrative",
  "novelai.renameCharacter": "narrative",
  "novelai.applyRenameToRecords": "narrative",

  // ── あらすじ・広報・本。作品を紹介し、まとめることは種類を問わない ──
  "novelai.generateSynopses": "anyKind",
  "novelai.openSynopsisDocs": "anyKind",
  "novelai.generateWorkBlurb": "anyKind",
  "novelai.generateCatchphrases": "anyKind",
  "novelai.exportEpub": "anyKind",
  "novelai.openEpubEditor": "anyKind",
};

/** その操作の種類の分類。載っていなければ `anyKind` */
export function kindFeatureOfCommand(command: string): KindFeature {
  return COMMAND_KIND_FEATURES[command] ?? "anyKind";
}

/**
 * その種類の作品で、その操作を見せるか。
 *
 * **種類が分からなければ隠さない**（形式の「決めていない」と同じ考え）。
 */
export function isCommandVisibleForKind(
  command: string,
  kind: WorkKindKey | undefined
): boolean {
  if (!kind) return true;
  return KIND_FEATURE_KINDS[kindFeatureOfCommand(command)].includes(kind);
}

/**
 * 右クリックの印（`contextValue`）の後ろに付ける種類。
 *
 * **物語の種類には付けない。** 付けると、`^work-(novel|script|unset)$` の
 * ような既存の `when` がすべて外れ、小説の作品から項目が消える。
 * 物語でない種類だけが印を持ち、`$` で閉じた物語向けの `when` から
 * 自然に外れる——どの種類でも出す操作だけ、`when` に印を許す形を足す。
 */
export function kindContextSuffix(kind: WorkKindKey | undefined): string | undefined {
  if (!kind) return undefined;
  return KIND_FEATURE_KINDS.narrative.includes(kind) ? undefined : kind;
}

/** 印を持つ種類の一覧（`package.json` の `when` と突き合わせるテストが読む） */
export const KIND_CONTEXT_SUFFIXES: readonly WorkKindKey[] = WORK_KINDS.map(
  (def) => def.key
).filter((kind) => kindContextSuffix(kind) !== undefined);

/**
 * 詳細メニュー（作品を選ばない画面）に出すか。
 *
 * **登録した作品のどれか1つでも使えるなら出す。** 詳細メニューは
 * 「全部はここにある」受け皿（6.70.1）なので、形式では絞らない。
 * 種類で隠すのは、**全部の作品が物語でないと分かっているときだけ**——
 * 歌詞だけを書いている作者に、伏線や人物の操作を並べ続けないため。
 *
 * @param kinds 登録した作品の種類。まだ分からない作品は undefined
 *   （走査が済んでいない）で、分からないものがあれば出す
 */
export function isCommandVisibleForSomeWork(
  command: string,
  kinds: readonly (WorkKindKey | undefined)[]
): boolean {
  if (kinds.length === 0) return true;
  return kinds.some((kind) => isCommandVisibleForKind(command, kind));
}

/**
 * 隠した操作をコマンドパレットから押されたときの断り。
 *
 * **理由と戻し方を1文で言う。** 「使えません」だけでは、壊れたのか
 * 種類のせいなのかが分からない。
 */
export function kindMismatchMessage(label: string, kind: WorkKindKey): string {
  return (
    `「${label}」は、種類が「${workKindDef(kind).label}」の作品では使いません` +
    "（登場人物や筋を扱う操作のため）。種類は「作品の種類」で変えられます。"
  );
}

/**
 * 登録した作品の種類から、詳細メニューで隠す操作を挙げる（設計書6.109.7）。
 *
 * 隠れうるのは種類の表に載った操作だけ（載っていなければ `anyKind`）。
 */
export function commandsHiddenForWorks(
  kinds: readonly (WorkKindKey | undefined)[]
): ReadonlySet<string> {
  return new Set(
    Object.keys(COMMAND_KIND_FEATURES).filter(
      (command) => !isCommandVisibleForSomeWork(command, kinds)
    )
  );
}
