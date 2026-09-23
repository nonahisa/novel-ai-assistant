import * as vscode from "vscode";
import { pickFolder } from "./features/pickFolder";
import { fromUri, storageRootFrom } from "./core/paths";
import * as path from "./core/paths";
import { describeSyncTarget } from "./core/syncTarget";
import { menuVersionLabel } from "./core/versionLabel";
import {
  WorkRegistry,
  readWorkConfig,
  scaffoldWorkFolder,
  workPaths,
} from "./core/workRegistry";
import type { WorkRegistryInitReport } from "./core/workRegistry";
import { checkDictionaryFreshness } from "./core/imeDictionaryStatus";
import {
  WorkTreeProvider,
  WorkNode,
  EpisodeNode,
  ChapterNode,
  MemoFolderNode,
  MemoFileNode,
  type TreeNode,
} from "./views/workTree";
import {
  countChars,
  formatCount,
  toManuscriptPages,
} from "./core/charCount";
import {
  nextChapterNumber,
  nextDatedName,
  nextUntitledName,
  parseEpisodeFileName,
} from "./core/episodeParser";
// 新しい話の中身と、開く向き。どちらもタイプで変わる（設計書6.70）
import {
  newEpisodeExtension,
  newEpisodeTemplate,
} from "./core/episodeTemplate";
import { manuscriptViewTypeFor } from "./core/manuscriptViewTypes";
import { nextEpisodeFileNameLike } from "./core/episodeRenumber";
import { WorkFolderWatchers } from "./features/workFolderWatch";
import { setStreamingSettingReader } from "./ai/ollamaStream";
import { findLatestEpisode } from "./core/latestEpisode";
import { scanWork, type ScanTiming } from "./core/scanner";
import { createMaintenanceTrigger } from "./core/maintenanceTrigger";
import { SUPPORTED_EXTENSIONS, WorkEntry } from "./models/types";
import {
  AIRegistry,
  ASSIGNABLE_FEATURES,
  runSetupWizard,
  type AssignableFeature,
} from "./ai/registry";
import {
  extractCharacters,
  saveDirtyDocumentsBeforeExtraction,
} from "./features/extractCharacters";
// Node専用（node:child_process / node:path）。選ぶ操作の中で動的importする（設計書5.8.5）
import {
  chooseWorkStartMode,
  chooseWorkType,
  createFirstEpisodeFile,
  openPlotFile,
  skipsStartModeQuestion,
  type WorkStartMode,
} from "./features/startWork";
import { generateSettingsDocs } from "./features/generateSettingsDocs";
import { exportSettingsForAudience } from "./features/exportSettingsForAudience";
import { generateSynopses } from "./features/generateSynopses";
import {
  generateCatchphrases,
  generateWorkBlurb,
} from "./features/generateBlurb";
import {
  configureAnnouncement,
  generateAnnouncement,
} from "./features/generateAnnouncement";
import {
  findOpenSettingsPanel,
  openSettingsPanel,
  setRelationGraphOpener,
  setSettingsChangeObserver,
} from "./features/settingsPanel";
import {
  openRelationGraph,
  refreshRelationGraph,
} from "./features/relationGraphPanel";
import { openChronicle, refreshChronicle } from "./features/chroniclePanel";
import {
  jumpSceneMemo,
  noteSceneMemoCaret,
  openSceneMemoPanel,
  refreshSceneMemos,
  type SceneMemoDeps,
} from "./features/sceneMemoPanel";
import { editTimeline } from "./features/chronicleEdit";
import { unifyCharacterRecords } from "./features/unifyCharacters";
import { findMergeCandidates } from "./core/characterMerge";
import { CharacterStore } from "./core/characterStore";
import type { ChatRunKind } from "./core/chatEdit";
import {
  applyPendingCharacterUpdates,
  primePendingRecordUpdates,
} from "./features/applyPendingUpdates";
// 数日残してある指摘を、開いたときに提案パネルへ戻す（設計書6.96.4）
import {
  handOverFinding,
  primeSavedFindings,
} from "./features/primeFindings";
// 古い指摘を片づける（設計書6.96.4）。**findings.jsonl を書き直す唯一の道**
import {
  chooseFindingsTarget,
  pruneFindings,
  pruneFindingsAcrossWorks,
} from "./features/pruneFindings";
import { renameWork } from "./features/renameWork";
import { exportImeDictionary } from "./features/exportImeDictionary";
import { exportPdf } from "./features/exportPdf";
import { exportEpub } from "./features/exportEpub";
import { openEpubEditorPanel } from "./features/epubEditorPanel";
import { manageCustomFields } from "./features/manageCustomFields";
import { TermHighlighter } from "./views/termHighlight";
import { ActionListProvider, findAction, nodeKey } from "./views/actionList";
import { checkPrerequisites } from "./features/prerequisiteGate";
import {
  StepMenuProvider,
  stepNodeKey,
  stepViewDescription,
} from "./views/stepMenu";
import {
  FOCUS_CHAT_KEY,
  SOLO_VIEW_KEY,
  resetViewVisibility,
} from "./views/viewVisibility";
import { ActionDecorationProvider } from "./views/actionDecorations";
import { PendingUpdateStore } from "./core/pendingUpdates";
// 作品を選ぶ場面で「未処理の提案が何件あるか」を出すために使う。
// 提案パネル（features/proposalPanel）が既に読んでいるので、束は増えない
import { ProposalStore } from "./core/proposalStore";
// 作品を選ぶ場面の補足（文言と並び順）。**文言そのものを試験から見たい**
// ので、VS Code に依存しない側へ出してある
import {
  divergenceNote,
  imeDictionaryNote,
  pendingProposalNote,
  pushWaitingNote,
  sortByPickOrder,
} from "./core/workPickNotes";
// gitコマンドが要る。動的importする（設計書5.8.5）
import {
  tryRegisterAsCollection,
  type CollectionOptions,
} from "./features/addCollection";
import {
  currentCountMode,
  countModeLabel,
  excludeRubyFromCount,
  pickCount,
  needsRedraw,
  needsRescan,
} from "./core/countSettings";
import { abbreviateTitle, isAbbreviated } from "./core/abbreviateTitle";
// 以下6つはgit・外部プロセス起動が要る。動的importする（設計書5.8.5）
// shareWithEditor, collectEditorProposals ← ./features/shareWithEditor
// restoreFromHistory ← ./features/gitRestore
// setupOllama ← ./features/setupOllama
// setupLmStudio ← ./features/setupLmStudio
// setupVectorSearch ← ./features/setupVectorSearch
// runFullSetup ← ./features/setupWizard
import { showVersion } from "./features/showVersion";
import { chatLogPath, isChatLogEnabled } from "./core/chatLog";
import {
  buildVectorIndex,
  isVectorSearchEnabled,
  removeVectorIndex,
} from "./features/vectorSearch";
import {
  registerProgressCancelCommand,
  withProgress,
} from "./views/progress";
import { pathExists } from "./core/fileSystem";
import { describeTuningScope } from "./core/tuningScope";
import {
  disposeLog,
  logFailure,
  logStep,
  setFallbackLogRoot,
  showLog,
  useLogFile,
} from "./core/logger";
import { probeGeneration } from "./ai/generationProbe";
import {
  SettingsWatcher,
  notifyExternalChange,
} from "./features/watchSettings";
import { SelfWriteTracker } from "./core/externalChanges";
import { protectExternalEdits } from "./features/protectExternalEdits";
import { setWriteObserver } from "./core/atomicWrite";
// GitSyncMonitor・describeStatus・showGitSyncActions は node:child_process を
// 静的importする core/git.ts を読む。型だけ・バッジ描画用の関数だけを
// 安全に取り出す（設計書5.8.5）
import type { GitSyncMonitor } from "./features/gitSync";
import {
  describeSyncBadge,
  describeSyncTooltip,
  hasPendingSync,
} from "./core/gitSyncStatusText";
import { NullGitSyncMonitor, type GitSyncMonitorLike } from "./features/gitSyncStub";
import { canRunProcesses } from "./core/runtime";
import {
  beginStartupTiming,
  formatStartupMillis,
} from "./core/startupTiming";
import { startLoopLagMeter, type LoopLagReport } from "./core/loopLag";
import { startStartupProfile } from "./core/startupProfiler";
import { readerKind, type ReaderKind } from "./core/fileRead";
import { describeProcessesBlocked } from "./core/processAvailability";
import { exclusiveLabelOf } from "./core/exclusiveCommands";
import { beginCommand, endCommand } from "./core/runningCommands";
import { isStaleBundleError } from "./core/staleBundle";
// nextSetupStep, runSetupStep も core/git.ts 経由。動的importする

import { resolveDeviceId } from "./core/device";
import {
  SessionStore,
  describeOtherDeviceSession,
} from "./core/sessionStore";
// CONFLICT_SCHEME・ConflictContentProvider・resolveWorkConflicts も
// core/git.ts 経由。競合はgit操作でしか起きないので、動的importする
import type { ConflictContentProvider as ConflictContentProviderType } from "./features/resolveConflicts";
import {
  checkTypos,
  resolveTypoScope,
  type TypoCheckRunResult,
} from "./features/checkTypos";
// 完了通知の件数は、提案パネルの見出しと同じ数え方をする（設計書6.8）
import { describeCheckRunCounts } from "./core/checkRunCounts";
import { markInferredWork, pickHintedWork } from "./core/workTarget";
import type { IncomingCount } from "./core/proposalBuckets";
import {
  checkNotation,
  describeNotationResult,
} from "./features/checkNotation";
import { generatePlot } from "./features/generatePlot";
// プロットモードの画面（設計書6.4.8）。plot.md は左の普通のエディタで書く
import { openPlotMode, refreshPlotMode } from "./features/plotModePanel";
import { syncPlotCharacters } from "./features/plotCharacterSync";
import { WORK_CHAT_VIEW_ID, WorkChatPanel } from "./features/workChatPanel";
// 押すべき項目をサイドバーで光らせる（設計書6.104）
import { createActionSpotlight } from "./features/actionSpotlight";
import { ChatterService } from "./features/chatterService";
import { requestChatterComment } from "./features/chatterComment";
import { setPlotBasics } from "./features/setPlotBasics";
import {
  invalidateWorkFormat,
  readWorkFormat,
} from "./core/workFormatStore";
import type { WorkFormatKey } from "./core/workFormat";
// 作品タイプの在り処はプロットの `## 形式` ひとつ（設計書6.70）
import { writePlotSections } from "./core/plotFile";
import { statsDayKey } from "./core/writingStats";
import { setWorkGoals } from "./features/setWorkGoals";
import {
  checkContradictions,
  pickContradictionReadMode,
} from "./features/checkContradictions";
// 矛盾検知のもう1つの道（設計書6.88）。P-12 としばらく並行させる
import { checkFactContradictions } from "./features/checkFactContradictions";
import { checkProofread } from "./features/checkProofread";
import { checkDeviations } from "./features/checkDeviations";
// 単話プロットのAI判定2種（P-27・P-28。設計書6.36.3）
import {
  checkEpisodePlotDesign,
  contrastEpisodePlot,
  pickEpisodePlotTarget,
  type EpisodePlotCheckRef,
} from "./features/checkEpisodePlot";
import {
  episodePlotChapterOfPath,
  episodePlotCompletionParts,
} from "./core/episodePlotDoc";
import { checkOpening } from "./features/checkOpening";
// 名前の点検と付け替え（設計書6.37）
import {
  openNameCheckPanel,
  refreshNameCheckPanel,
} from "./features/nameCheck";
import {
  applyRenameToRecords,
  clearPendingRename,
  describeRenameRecordsResult,
  loadPendingRename,
  renameCharacter,
  savePendingRename,
} from "./features/nameRename";
import { pruneAllLogs } from "./features/pruneLogs";
import { parseSynopsisMarkdown, SYNOPSIS_FILE } from "./core/synopsisDoc";
import { SynopsisStore } from "./core/synopsisStore";
import { hasUnsavedChanges } from "./core/textFile";
import { PROPOSALS_VIEW_ID, ProposalPanel } from "./features/proposalPanel";
import {
  WritingProgressTracker,
  boundaryHour,
  describeStatusBarProgress,
} from "./features/writingProgress";
import {
  openWritingStatsPanel,
  refreshWritingStatsPanel,
} from "./features/writingStatsPanel";
import {
  openAllWorksWritingStatsPanel,
  refreshAllWorksWritingStatsPanel,
} from "./features/allWorksWritingStatsPanel";
import {
  createEpisodePlot,
  resumeWriting,
} from "./features/resumeWriting";
import { askText, cancelItem } from "./views/dialogs";
import { manageKeepWords } from "./features/manageKeepWords";
import { manageConfirmSkips } from "./features/manageConfirmSkips";
import { AdvicePolicyStore } from "./core/advicePolicyStore";
import { WriterProfileStore } from "./core/writerProfileStore";
import type { AdviceProfile } from "./core/advicePolicy";
import { setAdvicePolicy } from "./features/advicePolicyDiagnosis";
import { AuthorReaderTypeStore } from "./core/authorReaderTypeStore";
import {
  addForeshadowByHand,
  openForeshadows,
  registerForeshadowFromContradiction,
  setForeshadowStatus,
} from "./features/foreshadows";
import {
  checkForeshadowResolution,
  checkForeshadows,
  showForeshadowCandidates,
  showForeshadowResolutions,
} from "./features/checkForeshadows";
// 校正のまとめ実行（設計書6.80）。各コマンドは終わり方を戻り値で伝える——
// **止めた（cancelled）と失敗した（failed）は別物**で、残りを走らせるかが違う。
// ここの7コマンドが返すのは中止・完走と、前提が足りずに走らせなかった
// （`checkSkipped`）だけで、`CHECK_FAILED` を立てるのは
// AIの失敗を自分で掴んでいる機能の側（`checkOpening.ts`）である
import {
  collectSuiteEstimate,
  runProofreadingSuite,
} from "./features/proofreadingSuite";
import {
  CHECK_CANCELLED,
  CHECK_COMPLETED,
  // 走ろうとして失敗した回を、取りやめと呼ばないために要る（設計書6.104）
  CHECK_FAILED,
  PROOFREADING_SUITE_COMMAND,
  checkSkipped,
  isSuiteConfirmed,
  isSuiteHoldingRun,
  type CheckCommandOutcome,
  type CheckRunOptions,
} from "./core/proofreadingSuite";
// 画面で指しながらの案内（設計書6.104）。ここで要るのは「済んだと数えて
// よいか」の判断だけで、案内そのものは相談パネルの側が持つ
import { announceCommandFinished } from "./core/guidedTour";
// 新しい作品を、ひと通り仕上げる。**まとめ実行と同じ決まり**で作ってあり、
// ここでも処理は持たない（走らせるのは既にあるコマンド）
import {
  collectFinishEstimate,
  runFinishNewWork,
} from "./features/finishNewWork";
import { FINISH_NEW_WORK_COMMAND } from "./core/finishNewWork";
import {
  extendMarkdownItWithRuby,
  type MarkdownItLike,
} from "./core/markdownItRuby";
import {
  addEmphasis,
  addRuby,
  copyForPosting,
  importRuby,
} from "./features/ruby";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
  ManuscriptEditorProvider,
  activeManuscriptTabUri,
  addMemoToOpenManuscript,
  insertMemoLineAbove,
  isInsideWork,
  openManuscriptForReading,
  refreshManuscriptCounts,
  type ManuscriptEditorDeps,
} from "./features/manuscriptEditor";
// 「本文が見つからない」ときの文言は1か所に置く（`features/ruby.ts` と共用）
import { warnManuscriptNotOpen } from "./features/manuscriptTab";
import { registeredPostingSites } from "./features/postingCopyRegistered";
import { showEditHistory } from "./features/editHistoryPanel";
import { toggleExternalAccessPermission } from "./features/externalAccessPermission";
import { ExternalAccessWatcher } from "./features/externalAccessWatcher";
import { SpotlightRequestWatcher } from "./features/spotlightRequestWatcher";
import {
  refreshStableBundle,
  writeAiInstructions,
} from "./features/writeAiInstructions";
import {
  importAdviceProfileMirror,
  refreshAdviceProfileMirror,
} from "./features/adviceProfileMirror";
import { startWindowCard } from "./features/windowCard";
import {
  reviewProposals,
  toggleReviewLock,
} from "./features/reviewProposals";
import { offerFirstRunSetupInVsCode } from "./features/firstRun";
import { splitCollectedFile } from "./features/splitCollectedFile";
import {
  copyBodyForPosting,
  copySubtitle,
  renameWithSubtitle,
} from "./features/episodeCopy";
import {
  removeChapter,
  renameChapter,
  startChapterAt,
} from "./features/manageChapters";
import {
  addWorkMemo,
  removeWorkMemo,
  transferMemo,
} from "./features/manageWorkMemos";
import {
  configurePostingSites,
  postNewEpisode,
  recordRanking,
} from "./features/postingKit";
import {
  importReaderStats,
  recordReaderStats,
} from "./features/readerStats";
import {
  proposeChapters,
  suggestChapterName,
} from "./features/proposeChapters";
import { chaptersFromHeadings } from "./features/chaptersFromHeadings";
import { countUnextractedEpisodes } from "./features/extractionFreshness";
import {
  describeChosenScope,
  recordCheck,
  resolveCheckScope,
} from "./features/typoCheckScope";
import { switchMode } from "./features/switchMode";
import {
  revealFolder,
  setGeneratedStorageRoot,
} from "./views/openDocument";
import { GENERATED_DIR } from "./core/generatedFiles";
import { setTuningStoreRoot } from "./core/modelTuningStore";
import { formatDayTime } from "./core/timestampedFileName";
import { notifyDone, whenNoticePicked } from "./views/notify";
import { initBackupPickFolder } from "./features/backupPickFolder";

/**
 * **この束を読み終えた時刻**（設計書6.107）。
 *
 * ここより上の `import` は、`activate` が呼ばれるより前に**全部**走る
 * （静的importは呼ばれなくても実行される。実装ルール7）。束の評価に
 * 何秒もかかっていると、`activate` の中をいくら刻んでも1つも印が
 * 付かないまま時間が過ぎる。**入口より前は入口からは測れない**ので、
 * ここで時刻を取っておき、入口で差を取る。
 *
 * `Date.now()` ではなく `performance.now()` を使うのは、時計合わせで
 * 巻き戻ると経過時間が負になるため（`core/startupTiming.ts` と同じ）。
 */
const MODULE_LOADED_AT = performance.now();

/** 操作メニューで開いている分類の記憶先 */
const ACTION_GROUPS_KEY = "novelai.actions.expandedGroups";

/** 簡単ステップメニューで開いている段階の記憶先 */
const STEP_GROUPS_KEY = "novelai.steps.expandedGroups";

/**
 * 簡単ステップメニューで選んでいる作品の記憶先。
 *
 * **IDだけを覚える。** 作品そのものを写すと、名前を変えたり登録から
 * 外したりしたときに、消えた作品を指したままになる（実在の確認は
 * 表示のたびに `StepMenuProvider` が行う）。
 */
const STEP_WORK_KEY = "novelai.stepMenu.selectedWorkId";

/**
 * 起動の数字を書き出すまでに、開いたときの点検を待つ上限（設計書6.107）。
 *
 * **点検は回線しだいでいつまでも終わらない。** 待ちきると、作者が
 * いちばん知りたい「一覧が出るまで何秒か」が1行も残らなくなる。
 */
const STARTUP_HANDOFF_WAIT_MS = 10_000;

/**
 * MD化の案内を「今はしない」と断られたファイルの記憶先
 * （作者の指示、2026-08-29）。
 *
 * **端末に残す**（作品フォルダーへは書かない）。断りは作者ひとりの都合で
 * あって作品の設定ではないし、同期対象へ入れると、書いていないのに
 * 差分が出る（`writingStatsStore.ts` と同じ理由）。
 */
const MARKDOWN_DECLINED_KEY = "novelai.manuscript.markdownDeclined";

/**
 * 読み上げに使う声の記憶先（設計書6.42）。
 *
 * **端末に残す。** どの声が入っているかは端末ごとに違うので、作品フォルダーへ
 * 書くと、同期した先で存在しない声を指すことになる（MD化の断りと同じ理由）。
 */
const READ_ALOUD_VOICE_KEY = "novelai.readAloud.voice";

/**
 * この起動が始まった時刻。
 *
 * **提案パネルの一覧は、端末に残らない。** VS Code を閉じると消えるので、
 * 「未適用0件」が「全部当てた」なのか「一覧ごと消えた」なのか区別が
 * つかない。前回の起動で作られた待ちかどうかは、これと突き合わせて見る
 * （名前の付け替えの資料反映。設計書6.37.3）。
 */
const SESSION_STARTED_AT = Date.now();

/** 待ちを作った時刻を、作者が読める形にする。読めない値はそのまま見せる */
function describeCreatedAt(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : formatDayTime(at);
}

/**
 * 前回までの起動で作られたものか。
 *
 * 真なら、提案パネルの「未適用0件」は当てにできない——全部を適用したのか、
 * 一覧ごと消えたのかが区別できない。**時刻が読めないときも真**にする
 * （案内を出しすぎるほうが、黙って進むより安全である）。
 */
function isFromEarlierSession(iso: string): boolean {
  const at = new Date(iso).getTime();
  return Number.isNaN(at) || at < SESSION_STARTED_AT;
}

/**
 * 校正のコマンドで、未保存の本文を保存してから走らせる（設計書6.80）。
 *
 * **保存できなかったのも「中止」として返す。** 作者が「中止」を選んだのと
 * 原因は違うが、**次の検知でも同じ理由でまた止まる**——保存できない文書は
 * そこに残ったままである。「失敗（`CHECK_FAILED`）は次へ進む」のは、
 * 次では起きないかもしれない失敗（AIのレート上限・応答の解析）に対する
 * 扱いであって、前提が欠けたままの状態には当てはまらない。
 *
 * @returns 保存できたら `undefined`。走らせられないときは、そのまま
 *   返してよい戻り値
 */
async function saveBeforeCheck(
  work: WorkEntry,
  actionLabel: string
): Promise<CheckCommandOutcome | undefined> {
  const saved = await saveDirtyDocumentsBeforeExtraction(work, actionLabel);
  return saved ? undefined : CHECK_CANCELLED;
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<{ extendMarkdownIt<T extends MarkdownItLike>(md: T): T }> {
  /**
   * 起動の所要時間（設計書6.107）。
   *
   * 作者の機械ではメニューや作品一覧が出るまでに10秒以上かかるが、
   * 母艦でデータ量を測っても説明がつかない。**当てずっぽうで直さず、
   * 作者の機械で計る。** ここは入口なので、いちばん最初に作る。
   *
   * **束の読み込みにかかった時間も渡す。** ここへ来るまでに静的importが
   * 全部走っており、その時間は入口からの累積には入らない。
   */
  const startupTiming = beginStartupTiming(
    undefined,
    performance.now() - MODULE_LOADED_AT
  );

  /**
   * イベントループの遅れの見張り（設計書6.107。0.74.11）。
   *
   * **「読み 58,191ms」の正体を決めるために要る。** 同じ機械で Node に
   * 直接読ませれば698ファイルで255msなので、読み口そのものが遅いとは
   * 考えにくい。**遅れの合計が読みの待ちと釣り合えば「握られている」、
   * 釣り合わなければ「読み口が遅い」**と読める。
   *
   * **入口で始めて、作品一覧の初回描画で止める。** 走査が走っている
   * あいだを丸ごと覆う必要があるので、ここより後ろには置けない。
   */
  const loopLagMeter = startLoopLagMeter();

  /**
   * どちらの読み口を選んだか（設計書6.107。0.74.11）。
   *
   * **「Node 側へ行っているはず」を数字にする。** 起動の1行へ添えるが、
   * 決まるのは動的 import のあとなので、掴んでおいて書くときに読む。
   * 走査より先に頼んでおけば、一覧が出るころには必ず入っている。
   */
  let startupReaderKind: ReaderKind | undefined;
  void readerKind().then((kind) => {
    startupReaderKind = kind;
  });

  /**
   * 作品が決まらない処理のログの置き場所（保管庫）。
   *
   * **入口で決める。** 渡すのは下の `setFallbackLogRoot` だが、起動の
   * プロファイル（下）も同じ場所へ書くので、値だけ先に作っておく。
   * `vscode-userdata:` を手元だけ OS のパスへ倒す判定は `storageRootFrom`
   * にある（手元とブラウザで扱いが逆になる。生成文書の置き場と同じ判定）。
   */
  const fallbackLogRoot = storageRootFrom(context.globalStorageUri);

  /**
   * 起動のプロファイル（設計書6.107。0.74.11）。
   *
   * **環境変数 `NOVELAI_STARTUP_PROFILE` を立てたときだけ動く。**
   * 立っていなければ `undefined` が返り、以降は何も起きない
   * （作者の環境では立てない。ノートで測るための仕掛けである）。
   */
  const startupProfile = await startStartupProfile({
    logRoot: fallbackLogRoot,
    onSaved: (filePath) => {
      // 起動は作品が決まらない処理なので、保管庫側のログへ書く
      useLogFile(undefined);
      logStep(`起動のプロファイルを書いた：${filePath}`);
    },
    onFailed: (error) => {
      logFailure("起動のプロファイル", {
        詳細: error instanceof Error ? error.message : String(error),
      });
    },
  });

  /**
   * いま走っている操作（設計書6.17.4の末尾）。
   *
   * **`activate` のスコープに置く。** 拡張機能ホストが再読み込みされれば
   * 箱ごと作り直されるので、解けないまま残ることがない。
   */
  const runningCommands = new Set<string>();

  /**
   * 前提（設定資料・あらすじ・プロット・単話プロット）の関門（設計書6.94）。
   *
   * **登録の口が1つなので、ここに置けば入口を選ばない。** 詳細メニュー・
   * 簡単ステップメニュー・コマンドパレット・右クリックのどこから押しても
   * 同じ案内になる。
   *
   * **実行の札を取る前に通す。** 関門は代わりの操作や前提を作る操作を
   * その場で走らせるので、札を握ったまま入ると自分の札を自分で待つ。
   *
   * @returns 走らせるなら、コマンドへ渡す引数（作品を解決したら差し替える）
   */
  const guardPrerequisites = async (
    command: string,
    args: unknown[]
  ): Promise<{ run: false } | { run: true; args: unknown[] }> => {
    const item = findAction(command);
    if (!item?.needs || item.needs.length === 0) return { run: true, args };
    // まとめ実行では作者を止めない（設計書6.80）。飛ばした理由は
    // 機能の側が最後のまとめへ並べる
    if (isSuiteConfirmed(args[1])) return { run: true, args };
    // 右クリックでファイルを指して呼ばれたなら、前提はその1件が担っている
    if (args[0] instanceof vscode.Uri) return { run: true, args };
    // 作品が1つも無いのは、この関門の話ではない（コマンドの側が案内する）
    if (registry.list().length === 0) return { run: true, args };

    const given = args[0] as WorkRef | undefined;
    /*
      **開いているファイルの作品を先に見る。** 「単話プロットを検査」は
      開いている単話プロットから作品と話数を割り出す作りなので、ここで
      いきなり「作品を選択」を出すと、これまで出ていなかった問いが
      増える（しかも関門と機能で別の作品を見かねない）。
    */
    const openedPath = vscode.window.activeTextEditor
      ? fromUri(vscode.window.activeTextEditor.document.uri)
      : undefined;
    const work =
      given?.work ??
      (openedPath ? inferredWorkOfPath(registry, openedPath) : undefined) ??
      (await resolveWork(undefined, registry));
    // 選ばずに閉じたなら、そこで終わり。もう一度選ばせない
    if (!work) return { run: false };

    if ((await checkPrerequisites(item, work)) !== "proceed") {
      return { run: false };
    }
    // **解決した作品を渡す。** そのままだと、コマンドの側でもう一度
    // 作品を選ばされる（同じことを2度聞かれる）
    const forwarded = [...args];
    if (!given) forwarded[0] = { type: "work", work } satisfies WorkRef;
    return { run: true, args: forwarded };
  };

  /**
   * コマンド登録の入口。**登録の口を1つにまとめておく。**
   *
   * 0.45.0 まではここで押した操作を記録していた（F5の開発ホスト限定。
   * 実機確認の道具ごと撤去した。設計書6.26）。包みそのものは残す——
   * 登録が1か所であることに検査が拠っており（`contributesShape.test.ts` は
   * この関数へ渡すコマンドIDを読んで、宣言と突き合わせる）、
   * 80か所を素の `vscode.commands.registerCommand` へ散らす理由も無い。
   *
   * 0.49.3 から、**同じ操作の2本目をここで断る**（作者の報告 2026-09-12
   * 「すべて同期を2回押してしまうことがあったが、複数立ちあがった」）。
   * 対象は `exclusiveCommands.ts` に並べてあり、画面を開くだけのものは
   * 入っていない。**断りはモーダルにしない**——作者は誤って2回押しただけで、
   * 手を止めさせる場面ではない。
   *
   * さらに、**前提の関門をここで通す**（上の `guardPrerequisites`）。
   */
  /**
   * 操作が済んだことを知りたい人（設計書6.104）。
   *
   * **登録の口が1つであることに相乗りする。** 画面で指しながらの案内は、
   * 作者が自分で押したときにも次の段へ進む必要があるが、80か所の
   * コマンドへ1行ずつ足して回るのは、足し忘れが必ず出る。
   *
   * 相談パネルはこの包みより後で組み立てるので、後から差し込める形に
   * してある（案内していないあいだは、呼ばれても最初の1行で戻る）。
   */
  let onCommandFinished: ((command: string) => void) | undefined;

  const registerCommand: typeof vscode.commands.registerCommand = (
    command,
    callback,
    thisArg
  ) =>
    vscode.commands.registerCommand(command, async (...args: unknown[]) => {
      const gate = await guardPrerequisites(command, args);
      if (!gate.run) return undefined;
      args = gate.args;

      if (!beginCommand(runningCommands, command)) {
        const label = exclusiveLabelOf(command) ?? command;
        vscode.window.showInformationMessage(
          `「${label}」はいま動いています。終わるまでお待ちください。`
        );
        return undefined;
      }
      try {
        const returned = await callback.apply(thisArg, args);
        /*
          **成功して返ったときだけ知らせる**（設計書6.104）。

          前提の関門で止まった回（上で return 済み）と、例外で落ちた回を
          数えると、やっていない段が「済んだ」ことになる。

          **戻り値も見る**（2026-09-21）。ここを見ずに知らせていたので、
          作品選択を閉じて取りやめても「正常に返った」だけで済んだ扱いに
          なり、案内が次の段へ進んでいた。判断は `core/guidedTour.ts` に
          置いてある——`activate` は単体で動かせないので、ここに条件を
          書くと確かめられないまま腐る。
        */
        announceCommandFinished(command, returned, onCommandFinished, (error) =>
          logFailure("操作の通知", {
            操作: command,
            理由: error instanceof Error ? error.message : String(error),
          })
        );
        return returned;
      } catch (error) {
        /*
          **拡張機能が裏で入れ替わったときだけ、受け止めて案内する**
          （設計書6.106）。

          VS Code が更新すると古い版のフォルダーが消えるのに、開いている
          ウィンドウは古い版を動かし続ける。この拡張機能はコマンドの本体を
          押されたときに読む作りなので、押した瞬間に「もう無いフォルダー」を
          探しに行って落ちる。作者の画面には素の「システム エラー」しか
          出ていなかった。

          **それ以外の失敗はそのまま投げ直す**（いまの振る舞いを変えない）。
        */
        if (!isStaleBundleError(error, context.extensionPath)) throw error;

        logFailure("拡張機能の更新", {
          操作: command,
          詳細: error instanceof Error ? error.message : String(error),
        });
        void vscode.window
          .showErrorMessage(
            "拡張機能が更新されています。ウィンドウを再読み込みしてください。",
            "再読み込み"
          )
          .then((choice) => {
            if (choice === "再読み込み") {
              void vscode.commands.executeCommand(
                "workbench.action.reloadWindow"
              );
            }
          });
        return undefined;
      } finally {
        // **失敗しても、途中で止めても必ず解く。** 解き忘れると、その操作が
        // 二度と押せなくなる（重複起動より重い壊れ方）
        endCommand(runningCommands, command);
      }
    });

  /**
   * 作品に属さない生成文書（使い方・診断・セットアップの内訳・IME辞書の
   * 手順）の置き場を、ここで一度だけ渡す（設計書6.17.7）。
   *
   * **各機能へ `context` を持ち回らない**——生成文書を開く場面は8か所あり、
   * そのすべてに引数を足すのは、この件と関係のないところまで書き換える
   * ことになる。`useLogFile` と同じ形にしてある
   */
  setGeneratedStorageRoot(
    vscode.Uri.joinPath(context.globalStorageUri, GENERATED_DIR)
  );

  /*
    **作品が決まらない処理のログも、ファイルに残す**（作者の裁定、
    2026-09-19）。置き場は生成文書と同じ考え方で、拡張機能の保管庫である。

    それまでは書庫に作品が2つ以上あると `logTargetWorkFolder` が
    `undefined` を返し、AIチューニングの記録が**どこにも残らなかった。**
    実機では12分かけて測った結果も、反映待ちで止まっていることも、
    通知が消えた時点で失われている。

    値そのものは `activate` の入口で作ってある（起動のプロファイルも
    同じ場所へ書くため）。`vscode-userdata:` を手元だけ OS のパスへ
    倒すのは `storageRootFrom`（生成文書の置き場と同じ判定）。
  */
  setFallbackLogRoot(fallbackLogRoot);

  /**
   * AIチューニングの台帳の置き場も、ここで一度だけ渡す（設計書6.49）。
   *
   * **待つ。** 台帳は最初のAI呼び出しから引かれる（待ち時間・読める長さ）
   * ので、読み込みを待たずに進むと、起動直後の1回だけ測った値が
   * 効かないことになる。読むのは小さなJSONひとつである。
   */
  await setTuningStoreRoot(context.globalStorageUri);
  startupTiming.mark("調整の台帳");

  /*
    **左のビューを、素の状態から始める**（作者の報告、2026-09-03
    「再起動したとき、詳細メニューの下に『AIに相談』が無いことがある」）。

    ビューの出し入れを決めている印（`novelai.focusChat`・`novelai.soloView`）を
    持っているのはVS Code側で、拡張機能ではない。**拡張機能ホストだけが
    再起動したとき、前の印はそのまま残る**——`soloView = 'actions'` が
    残っていれば、相談のビューだけ消えた状態で立ち上がる。理由は
    `viewVisibility.ts` にある。

    **ビューを前面に出したりはしない。** サイドバーを開けば見出しが在る、
    という状態に戻すだけである。
  */
  await resetViewVisibility((key, value) =>
    vscode.commands.executeCommand("setContext", key, value)
  );
  startupTiming.mark("ビューの表示");

  const registry = new WorkRegistry(context);

  /**
   * 作品一覧のビュー。**走査中の件数を見出しの右へ出す**ために持つ。
   *
   * 作られるのはもっと下（コマンドの登録のあと）なので、それまでは
   * `undefined`。**走査が始まるのはビューが作られたあと**なので、
   * 数が出ないまま終わることはない。
   */
  let worksView: vscode.TreeView<TreeNode> | undefined;

  /**
   * 作品一覧を走査しているあいだ、案内文を差し替える印（設計書6.1.2）。
   *
   * **「まだ作品が登録されていません」は、走査中にも出てしまう。**
   * `getChildren` が返るまでツリーは空で、VS Code は空のツリーに
   * `viewsWelcome` を出すためである。16作品のノートPCでは34秒のあいだ
   * それが出ていた（2026-09-21の計測）。登録ボタンが4つ並ぶので、
   * **作者から見ると作品が消えたのと区別がつかない。**
   *
   * **件数は案内文へは入れられない**（`viewsWelcome` の文言は
   * `package.json` に固定で、差し込みの仕組みが無い）。そこで
   * ビューの見出しの右（`description`）に出す。
   */
  const setWorksLoading = (loading: boolean, count: number): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "novelai.worksLoading",
      loading
    );
    if (worksView) {
      worksView.description = loading ? `${count}作品を読み込み中` : undefined;
    }
  };

  /*
    **印は、起動のいちばん手前で立てる**（設計書6.1.2）。登録簿は
    globalState を読むだけなので、`list()` はここで既に使える——
    作品ごとの整備（`maintainWorks()`）を待つ必要は無い。以前はその
    整備のあとに立てており、**ノートPCでは20秒のあいだ「まだ作品が
    登録されていません」が出ていた**（2026-09-21の計測）。

    **0件なら立てない**——そのときは従来の案内がそのまま正しい。
  */
  setWorksLoading(registry.list().length > 0, registry.list().length);

  // GitHub同期の見張り。自動で走るのはfetch（取得のみ）だけで、
  // 取り込み・送信は作者がボタンを押したときにしか実行しない（設計書5.5.1）。
  // ブラウザ版（gitコマンドを起動できない）では、何もしない代役を使う（設計書5.8.5）
  const gitSync: GitSyncMonitorLike = canRunProcesses()
    ? new (await import("./features/gitSync.js")).GitSyncMonitor(registry)
    : new NullGitSyncMonitor();
  context.subscriptions.push(gitSync);

  /**
   * 作品を選ぶ場面へ出す、同期の状態（設計書5.5.1）。
   *
   * **どの作品を送ればよいのかが、選んだ後にしか分からなかった。**
   * 「GitHubへ送る」は作品を選ばせてから状態を見に行き、送るものが
   * 無ければ「送信するものはありません」と告げて終わる。作者から見ると
   * 選び直すしかなく、正解は総当たりでしか見つからない。
   * 作品一覧の印と同じ情報を、選ぶ場面にも出す。
   *
   * **数え直さない。** `statusFor` は見張りが持っている控えを読むだけなので、
   * 選択肢を出すたびに呼んでもgitは動かない。値は前回の取得時点のものだが、
   * 押した後の取得し直しはこれまでどおり行う（最終的な判断はそちら）。
   *
   * `tracked` 以外（gitを使っていない・リモートが無い等）は数が無いので、
   * 呼び出し側で補足を諦める。**印が出ないだけで実害はない**
   */
  const trackedSyncStatus = (workId: string) => {
    const status = gitSync.statusFor(workId);
    return status?.kind === "tracked" ? status : undefined;
  };

  /**
   * 作品フォルダーの整備を起こす（設計書6.107）。**1回しか起こさない。**
   *
   * **起こす場所は「作品一覧の初回描画のあと」**（0.74.9）。0.74.5 で
   * `activate` の末尾へ移したが、整備の `await` と作品一覧の走査は
   * **同じスレッドで取り合う**。0.74.7 で読み口を Node の `fs` へ替えても
   * 一覧は25.1秒のままで、整備のほうは「4番目 8.8秒、6番目 2.1秒」と
   * バラバラの位置で詰まった——走査が CPU を握っているあいだ、整備の
   * `await` が再開できずにいた形である。**一覧が出てから始めれば、
   * 取り合いそのものが起きない。**
   *
   * 印（「整備 開始」「整備」）はそのまま。**位置が後ろへ動くだけ**で、
   * 知らせ（無い作品・除外設定・未登録作品）も今までどおり出す。
   *
   * @param startNote 印へ添える一言。合図を待ちきって起こしたときだけ入る
   *   （`core/maintenanceTrigger.ts`）。下の「整備」の印に添える `note`
   *   （内訳）とは**別物**なので、名前を分けてある
   */
  let workMaintenanceStarted = false;
  const startWorkMaintenance = (startNote?: string): void => {
    /*
      **「一度だけ」を2か所で守る。** いつ起こすかの判断は
      `core/maintenanceTrigger.ts`（試験で守る）が持つが、起こす側にも
      印を残す。整備が2回走ると `.gitignore` の書き込みと知らせが
      二重になるので、ここは最後の砦である。
    */
    if (workMaintenanceStarted) return;
    workMaintenanceStarted = true;
    startupTiming.mark("整備 開始", startNote);
    const maintainStartedAt = performance.now();
    void registry
      .maintainWorks((works) => {
        /*
          **書庫にあるのに登録されていない作品を、1行だけ知らせる**（設計書6.97.4）。
          知らせるのは `features` の仕事なので、`core` の登録簿へは口だけを渡す。
          動的に読むのは、起動の道に載せないため（押されたときに要るものである）。
        */
        void (async () => {
          try {
            const { noticeUnregisteredWorksSafely } = await import(
              "./features/collectUnregisteredWorks.js"
            );
            noticeUnregisteredWorksSafely(context, works);
          } catch (error) {
            logFailure("書庫の未登録作品の確認", {
              詳細: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      })
      .then((report) => {
        const note = describeMaintainReport(report);
        startupTiming.mark("整備", note);
        /*
          **もう1行、単独でも書く**（設計書6.107）。整備は一覧の描画より
          後に終わることがあり、そのときは起動の1行（`report()`）が
          先に書き出されていて「整備」の印が載らない。**1行目の
          「整備 開始」に、この行の時間を足せば**、整備がいつ終わったかが
          分かる。
        */
        useLogFile(undefined);
        const order = describeMaintainOrder(report);
        logStep(
          `整備の所要時間：${formatStartupMillis(
            performance.now() - maintainStartedAt
          )}ms（作品 ${report.count}／${note}）` + (order ? ` ${order}` : "")
        );
      })
      .catch((error) => {
        // 整備で落ちても、起動も一覧も止めない
        logFailure("作品フォルダーの整備", {
          詳細: error instanceof Error ? error.message : String(error),
        });
      });
  };

  /*
    **合図が来ないときの保険**（設計書6.107。0.74.9）。

    VS Code が作品一覧の `getChildren` を呼ぶのは**ビューが見えたとき**
    なので、作者がサイドバーを一度も開かない起動では合図が来ない。
    そのままでは `.gitignore` の移行も「作品フォルダーが見つかりません」の
    知らせも、そのセッションでは出ない。**順番の問題ではなく抜け落ちである。**

    判断（一度だけ・上限で起こす）は `core/maintenanceTrigger.ts` にある
    ——`activate` は単体で動かせないので、試験で守れる形へ出してある。
  */
  const maintenanceTrigger = createMaintenanceTrigger((startNote) =>
    startWorkMaintenance(startNote)
  );
  context.subscriptions.push({
    dispose: () => maintenanceTrigger.dispose(),
  });

  /*
    **起動の数字を書き出す仕掛け**（設計書6.107）。

    出すのは「作品一覧の初回描画」と「開いたときの点検」の**遅いほう**が
    来た時点で1回だけ。どちらか片方で出すと、実際に作者が待たされている
    ほうが数字に入らない。

    **知らせは出さない。** 作者を止めずに、あとから読めればよい。
  */
  let startupTimingWritten = false;
  let firstRenderDone = false;
  // ブラウザ版では点検を走らせない（gitの子プロセスが起こせない）ので、
  // 最初から「待つものは無い」扱いにする
  let handoffPending = canRunProcesses();
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;

  const writeStartupTiming = (): void => {
    if (startupTimingWritten) return;
    startupTimingWritten = true;
    if (handoffTimer !== undefined) clearTimeout(handoffTimer);
    /*
      **保管庫側のログへ書く**（`useLogFile(undefined)`）。起動は作品が
      決まらない処理なので、直前に触っていた作品のログへ紛れさせない。
      `logStep` は出力チャンネルにも同じ行を出す。
    */
    useLogFile(undefined);
    /*
      **読み口も添える**（設計書6.107。0.74.11）。「Node 側へ行っている
      はず」を数字にするためで、ここが `vscode` なら走査の読みが遅いのは
      当たり前になる。まだ決まっていなければ書かない（嘘を書かない）。
    */
    const reader = startupReaderKind ? `／読み口 ${startupReaderKind}` : "";
    logStep(
      `${startupTiming.report()}（作品 ${registry.list().length}${reader}）`
    );
  };

  const noteStartupHandoffDone = (label: string): void => {
    startupTiming.mark(label);
    handoffPending = false;
    if (firstRenderDone) writeStartupTiming();
  };

  const noteFirstWorkListRender = (summary: ScanTiming): void => {
    try {
      /*
        **ここで見張りを止める**（設計書6.107。0.74.11）。走査が走って
        いたあいだのイベントループの遅れが、この時点までの合計として出る。
        起動のプロファイルも同じ区間なので、一緒に締める。
      */
      const lag = loopLagMeter.stop();
      void startupProfile?.stop();
      startupTiming.mark(
        "作品一覧の初回描画",
        describeScanSummary(summary, lag)
      );
      firstRenderDone = true;
      if (!handoffPending) {
        writeStartupTiming();
        return;
      }
      /*
        **点検の終わりを待ちきらない。** 回線が遅いと `runStartupHandoff`
        は何十秒もかかることがあり、そのあいだ「一覧が出るまで何秒か」が
        どこにも残らない。10秒で見切って「点検 未了」と書いて出す。
      */
      handoffTimer = setTimeout(() => {
        startupTiming.mark("点検 未了");
        writeStartupTiming();
      }, STARTUP_HANDOFF_WAIT_MS);
      context.subscriptions.push({
        dispose: () => {
          if (handoffTimer !== undefined) clearTimeout(handoffTimer);
        },
      });
    } catch (error) {
      // 計測で作品一覧を壊さない。数字が1行残らないだけに留める
      logFailure("起動の所要時間の記録", {
        詳細: error instanceof Error ? error.message : String(error),
      });
    } finally {
      /*
        **一覧が出てから、作品フォルダーの整備を始める**（設計書6.107）。

        `finally` に置くのは、**計測が落ちても整備は起こすため**。
        上の `try` には早い `return` があるので、その道でも通る。
        上限の見張りが先に起こしていれば、ここは何もしない。
      */
      maintenanceTrigger.signal();
    }
  };

  const treeProvider = new WorkTreeProvider(
    registry,
    (workId) => describeSyncBadge(gitSync.statusFor(workId)),
    (workId) => describeSyncTooltip(gitSync.statusFor(workId)),
    noteFirstWorkListRender,
    setWorksLoading
  );
  // 同期状態が変わっても本文は変わらないので、再走査はせず描き直すだけにする
  gitSync.onDidChange(() => treeProvider.redraw());
  const aiRegistry = new AIRegistry(context);

  // 端末ID。「どの環境で書いたか」を区別するのに使う（設計書5.5.2）。
  // Gitへは同期しない。全環境が同じIDを名乗ると区別できなくなる
  const deviceId = await resolveDeviceId(context.globalState);

  // 執筆量の記録（設計書6.3）。走査は作品一覧の結果を借りるので、
  // 保存のたびにファイルを2度読むことはない
  // **話ごとの文字数も渡す**（作者の指示、2026-08-29「記録の持ち方を細かくして」）。
  // どちらも同じ走査結果のキャッシュを引くので、2度読むことにはならない
  const progress = new WritingProgressTracker(deviceId, async (work) => ({
    stats: await treeProvider.getStats(work),
    episodes: await treeProvider.getEpisodes(work),
  }));

  // 競合の見比べに使う読み取り専用の本文置き場。
  // 競合はgit操作でしか起きないので、ブラウザでは作らない（設計書5.8.5）
  let conflictProvider: ConflictContentProviderType | undefined;
  if (canRunProcesses()) {
    const resolveConflicts = await import("./features/resolveConflicts.js");
    conflictProvider = new resolveConflicts.ConflictContentProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        resolveConflicts.CONFLICT_SCHEME,
        conflictProvider
      ),
      { dispose: () => conflictProvider?.clear() }
    );
  }

  // 本文中の用語を種類ごとに色分けし、ホバーで設定を出す
  const highlighter = new TermHighlighter(registry);
  context.subscriptions.push(highlighter);
  void highlighter.refresh();

  // 別のプラグインのAIやCLIが設定JSONを直接書くことがある。
  // エディターの保存イベントは起きないので、ファイルを直接監視する
  const selfWrites = new SelfWriteTracker();
  // 拡張機能の書き込みは、書き込み口の1か所で印を付ける。
  // これが無いと、自分が保存するたび「外部で変更されました」と出る
  setWriteObserver((filePath) => selfWrites.markWriting(filePath));
  context.subscriptions.push({ dispose: () => setWriteObserver(undefined) });

  // 競合の見比べは、同期の中からも呼ばれる（設計書5.5.18）。
  // **登録した置き場は1つ**なので、経路を問わず同じものを使う
  if (conflictProvider) {
    const resolveConflicts = await import("./features/resolveConflicts.js");
    resolveConflicts.useConflictProvider(conflictProvider);
    context.subscriptions.push({
      dispose: () => resolveConflicts.useConflictProvider(undefined),
    });
  }

  /**
   * 外で変わった資料を、画面へ映し直す（設計書5.4.9）。
   *
   * **読み直しの経路を1本にする。** 以前は知らせの3つのボタンが
   * それぞれ「索引を捨てる」「作品一覧を数え直す」を書いており、
   * **開いたままの設定資料パネルだけが誰からも読み直されていなかった**
   * （実機、2026-09-11）。外から人物を1人足しても消しても、タブは
   * 「登場人物(22)」のまま——「読み込み直すだけ」を押しても変わらず、
   * 窓ごと開き直すまで古い写しを見せ続けていた。
   *
   * 映す先が増えたときに書き忘れる形だったので、ここへ集める。
   * **同期（`gitSync`）の取り込みからも同じものを呼ぶ。**
   */
  const reloadAfterExternalChange = async (work: WorkEntry): Promise<void> => {
    highlighter.invalidate();
    treeProvider.refresh(work.id);
    // 開いていなければ何もしない（勝手に画面を開かない）
    await findOpenSettingsPanel(work.id)?.refreshFromDisk();
  };

  const settingsWatcher = new SettingsWatcher(
    registry,
    selfWrites,
    (work, files) => {
      void notifyExternalChange(work, files, {
        // 中身を見て取り込むかを決める。勝手に確定させない
        review: async () => {
          // まだ開いていなければ `openSettingsPanel` が読み込む。
          // **開いていれば reveal するだけ**なので、読み直しはこの後で行う
          await openSettingsPanel(context, work, aiRegistry);
          await reloadAfterExternalChange(work);
        },
        // **編集部の直しをAIから守る**（設計書5.5）。
        // GitHub経由の編集は拡張機能の画面を通らないので、
        // 印を付けないと次の抽出で上書きされる
        protect: async () => {
          await protectExternalEdits(work);
          await reloadAfterExternalChange(work);
        },
        reload: () => reloadAfterExternalChange(work),
      });
    }
  );
  context.subscriptions.push(settingsWatcher);

  // **取り込みのあいだは見張りを止める**（設計書5.5.18）。
  // gitが書いたファイルも外部変更として拾うため、止めないと
  // 同期のたびに「拡張機能の外で変更されました」が出る
  // （作者の指摘、2026-09-10）
  gitSync.setSettingsPause?.((work) => settingsWatcher.pause(work));
  context.subscriptions.push({
    dispose: () => gitSync.setSettingsPause?.(undefined),
  });

  // ステータスバーの進捗に添える中止ボタン用（コマンドパレットには出さない）
  context.subscriptions.push(registerProgressCancelCommand());

  // 本文で用語をクリックしたら、右側の資料をその項目へ切り替える。
  // 資料を開いていないときは何もしない（勝手に画面が割れると邪魔になる）
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async (event) => {
      const panels = registry.list().map((work) => work.id);
      if (panels.length === 0) return;

      const found = await highlighter.termAt(
        event.textEditor.document,
        event.selections[0].active
      );
      if (!found) return;
      const panel = findOpenSettingsPanel(found.work.id);
      if (!panel) return;
      // **本文から開いたのだから、その話に出る人どうしに絞る**（設計書6.92）
      panel.setChapterContext(chapterOfPath(fromUri(event.textEditor.document.uri)));
      await panel.showRecord(found.entry.kind, found.entry.id);
    })
  );

  /**
   * 原稿エディタ（設計書6.25）。
   *
   * **既定のエディタにはしない**（`package.json` の `priority` は `option`）。
   * 「縦書きで開く」か、VS Code の「エディターを再度開く」から選ぶ。
   *
   * **中身は縦書きと横書きで同じものを使う**（6.25.4）。違うのは、
   * 開いたときの向きだけである。
   */
  const manuscriptDeps = {
    highlighter,
    // **作品は登録簿で引く**（設計書6.68.2）。用語索引は設定資料が
    // 1件も無い作品では引けないので、作品を知りたいだけのところでは使わない
    workOf: (filePath) => workOfPath(registry, filePath),
    openSettings: async (work, kind, id, from) => {
      const panel = await openSettingsPanel(context, work, aiRegistry, {
        beside: true,
      });
      // **呼び合いは、その話に出る人どうしだけにする**（設計書6.92）。
      // 話数は原稿のファイル名から読む（数え方は episodeParser の1本だけ）
      if (from) panel.setChapterContext(chapterOfPath(from.filePath));
      // **用語から開くときは、一覧を畳んで出す**（作者の依頼、2026-08-28）。
      // 本文の隣に並ぶ狭い幅を一覧に取られると、肝心の資料が読めない
      await panel.showRecord(kind, id, { collapseList: true });
    },
    // 右クリックの時点で、**開いているパネルだけ**を追従させる
    // （作者の指示、2026-08-28）。開いていなければ何もしない——
    // 右クリックのたびに新しいパネルが開いては、作者の画面を奪う。
    // 一覧の畳みも触らない（作者が開けた一覧と喧嘩しないため）
    previewTerm: async (work, kind, id, from) => {
      const panel = findOpenSettingsPanel(work.id);
      if (!panel) return;
      if (from) panel.setChapterContext(chapterOfPath(from.filePath));
      await panel.showRecord(kind, id);
    },
    openChat: async (document, range) => {
      // 相談パネルは普通のエディタから本文を受け取る。
      // 同じ文書を横に開いてから渡す（開かないと、前に見ていた
      // 別の作品について答えることになる）
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
        selection: range,
      });
      workChatPanel.trackEditor(editor);
      await vscode.commands.executeCommand(`${WORK_CHAT_VIEW_ID}.focus`);
    },
    // 下段の字数（作者の指示、2026-08-29）。**走査は一覧のキャッシュを借りる**
    workStats: (work) => treeProvider.getStats(work),
    // 改行コードの案内（設計書5.4.2）も、走査は一覧の結果を借りる
    workEpisodes: (work) => treeProvider.getEpisodes(work),
    todayFileCount: (work, filePath) => progress.todayFileCount(work, filePath),
    // 空の話を作った直後に基準を置き直す（設計書6.3.2）。
    // **置き直さないと、そのあと書いた分が「今日 +0字」になって消える**
    rebaseline: (work) => progress.rebaseline(work),
    // MD化は**既存の変換と同じ経路**を通す（中のルビも直る。設計書6.12.4）
    convertToMarkdown: async (filePath) => {
      const { convertOne } = await import("./features/markdownConvert.js");
      return convertOne(filePath);
    },
    // 口述の整文（設計書6.83）。**繋ぐのはここだけ**——原稿エディタが
    // 整文を直に読み込むと、あの画面がAIの登録簿を抱えることになる。
    // **詳細メニューの操作と同じ関数を通す**（入口2つ・実体1つ）
    dictationClean: async (document, range) => {
      const { runDictationClean } = await import("./features/dictationClean.js");
      await runDictationClean(
        {
          document,
          range,
          work: workOfPath(registry, fromUri(document.uri)),
          // **原稿エディタからは「元に戻す」ボタンを出さない**——WebViewの
          // パネルにはアクティブなテキストエディタが無く、undo が効かない
          entry: "manuscriptEditor",
        },
        aiRegistry
      );
    },
    // シーンメモ（設計書6.40.4）。**繋ぐのはここだけ**——原稿エディタが
    // パネルを直に読み込むと、パネル側もこちらを読むので輪になる
    openSceneMemos: async (filePath) => {
      await showSceneMemosFor(filePath);
    },
    // カーソルの追従は片方向。パネルが開いていなければ何も起きない
    onCaretMoved: (filePath, line) => noteSceneMemoCaret(filePath, line),
    // 読み上げの声（設計書6.42）。**端末ごと**に覚える
    readAloudVoice: () => context.globalState.get<string>(READ_ALOUD_VOICE_KEY),
    saveReadAloudVoice: async (name) => {
      await context.globalState.update(READ_ALOUD_VOICE_KEY, name);
    },
    markdownDeclined: () =>
      context.globalState.get<string[]>(MARKDOWN_DECLINED_KEY, []),
    declineMarkdown: async (filePath) => {
      const declined = context.globalState.get<string[]>(
        MARKDOWN_DECLINED_KEY,
        []
      );
      if (declined.includes(filePath)) return;
      await context.globalState.update(MARKDOWN_DECLINED_KEY, [
        ...declined,
        filePath,
      ]);
    },
  } satisfies ManuscriptEditorDeps;

  const manuscriptOptions = {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: false,
  };

  /**
   * 提案パネルの「飛ぶ」から使う（作者の依頼、2026-08-28）。
   *
   * **台帳は入口ごとではなく1つ**（`manuscriptEditor.ts`）なので、
   * どちらの実体から呼んでも、縦書き・横書きの両方の画面が見つかる。
   */
  const manuscriptProvider = new ManuscriptEditorProvider(
    manuscriptDeps,
    "setting",
    MANUSCRIPT_EDITOR_VIEW_TYPE
  );

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MANUSCRIPT_EDITOR_VIEW_TYPE,
      manuscriptProvider,
      manuscriptOptions
    ),
    // **同じ画面を、横書きで開く入口**（作者の依頼、2026-08-27。設計書6.25.4）。
    // VS Code の「エディターを再度開く」に2つ並ぶので、開くときに選べる
    vscode.window.registerCustomEditorProvider(
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
      new ManuscriptEditorProvider(
        manuscriptDeps,
        "horizontal",
        MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
      ),
      manuscriptOptions
    )
  );

  /**
   * 機械を行き来するときの土台（設計書6.15.1）。
   *
   * **`features/handoffSync.ts` は `core/git.ts`（`node:child_process`）を
   * 静的importする**ので、ここでは型も値も直に持たず、使う場面で
   * 動的importして渡す（設計書5.8.5）。
   */
  const handoffDeps = () => ({
    registry,
    monitor: gitSync,
    // 「送らずに閉じた」印は作品をまたいで1つ。作品設定ではなく globalState
    storage: context.globalState,
    pauseSettingsWatch: () => settingsWatcher.pause(),
    batchFileNotices: gitSync.beginBatchedFileNotices?.bind(gitSync),
  });

  context.subscriptions.push(
    // **1押しで 保存 → 記録 → 送信**（設計書6.15.1の②）。既存の「GitHubと
    // 同期」との違いは、**先に未保存を保存する**ところだけである
    // （あちらは未保存があると保存を促して止まる。設計書6.15の手順1）
    registerCommand("novelai.saveAndSync", async () => {
      if (!canRunProcesses()) {
        vscode.window.showWarningMessage(
          describeProcessesBlocked("novelai.saveAndSync")
        );
        return;
      }
      const { saveAndSyncAll } = await import("./features/handoffSync.js");
      await saveAndSyncAll(handoffDeps());
    }),
    registerCommand("novelai.syncAllWorks", async () => {
      const { syncAllWorks } = await import("./features/syncAllWorks.js");
      // 同期の最中は、設定資料の見張りとファイル更新の知らせをまとめる
      // （設計書5.5.18）。ブラウザ版の代役は溜め込みを持たないので、
      // そのときは今までどおり素通しになる
      const batch = gitSync.beginBatchedFileNotices?.bind(gitSync);
      await syncAllWorks({
        registry,
        monitor: gitSync,
        pauseSettingsWatch: () => settingsWatcher.pause(),
        batchFileNotices: batch,
      });
    }),
    // 別のPCとこちらの両方で書くと分岐する（設計書5.5.16）。
    // これまでは「Gitのクライアントで解決してください」で行き止まりだった
    registerCommand(
      "novelai.resolveDivergence",
      async (node?: WorkNode) => {
        // 合わせる相手は置き場（リポジトリ）だが、選んでもらうのは作品にする。
        // 作者が見ているのは作品であり、どの作品がどの置き場かは意識しなくてよい
        const work = await resolveWork(node, registry, {
          title: "分かれた分を合わせる作品",
          // **この操作は分かれた作品しか対象にならない**のに、選択肢では
          // それを見分けられなかった。ブラウザ版では代役が全作品に同じ状態を
          // 返すので、補足を出さない（同じ文字が並ぶだけで手掛かりにならない）
          annotate: canRunProcesses()
            ? async (candidate) => {
                const status = trackedSyncStatus(candidate.id);
                if (!status) return {};
                // **分かれているかは置き場（リポジトリ）の性質**であって、
                // 作品ごとには決まらない。合わせる相手も置き場なので、
                // ここは `ahead`／`behind`（置き場ぜんぶ）で見るのが正しい。
                // 同じ置き場の作品に同じ補足が並ぶのは、それが事実だから
                return divergenceNote(status);
              }
            : undefined,
        });
        if (!work) return;
        const { resolveDivergence } = await import(
          "./features/resolveDivergence.js"
        );
        await resolveDivergence({ registry, monitor: gitSync }, work);
      }
    ),
    registerCommand("novelai.openVertical", async () => {
      const uri = activeManuscriptUri();
      if (!uri) {
        warnManuscriptNotOpen();
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        MANUSCRIPT_EDITOR_VIEW_TYPE
      );
    }),
    /*
      原稿を読み上げる（音読推敲。設計書6.42）。

      **開いて列を出すところまで。** 読み始めるのは作者が押したときで、
      ここでは始めない（声の一覧は非同期に揃うので、開いた瞬間に読ませると
      声が無いまま始めることになる）。
    */
    registerCommand("novelai.readManuscriptAloud", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await openManuscriptForReading(work);
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.showSettingsForTerm",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const found = await highlighter.termAt(
          editor.document,
          editor.selection.active
        );
        if (!found) {
          vscode.window.showInformationMessage(
            "カーソル位置に登録済みの用語がありません。"
          );
          return;
        }
        const panel = await openSettingsPanel(
          context,
          found.work,
          aiRegistry,
          { beside: true }
        );
        // 本文の用語からの入口。原稿エディタの右クリックと同じ扱いにする
        // （呼び合いの絞り込みも同じ。設計書6.92）
        panel.setChapterContext(chapterOfPath(fromUri(editor.document.uri)));
        await panel.showRecord(found.entry.kind, found.entry.id, {
          collapseList: true,
        });
      }
    )
  );

  const treeView = vscode.window.createTreeView("novelai.works", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  // 走査中の件数を見出しへ出すために控える（設計書6.1.2）
  worksView = treeView;
  context.subscriptions.push(treeView);

  // 操作の末尾に出す印（「AI」と未反映の件数）。
  // 詳細メニューの件数は全作品を合わせて数える。作品を選ばずにメニューを見るため、
  // 「どこかに溜まっている」ことが分かればよい。
  // **簡単ステップメニューは作品を1つ渡してくる**（最上段で選ぶ画面なので、
  // 合算を出すと選択作品の件数に見える。作者の実機報告、2026-09-05）
  const actionDecorations = new ActionDecorationProvider(async (counter, workId) => {
    let total = 0;
    for (const work of workId === undefined
      ? registry.list()
      : registry.list().filter((entry) => entry.id === workId)) {
      try {
        if (counter === "pendingUpdates") {
          total += await new PendingUpdateStore(work).count();
        } else if (counter === "staleImeDictionary") {
          // 書き出し済みの辞書より設定資料が新しい作品を数える。
          // 一度も書き出していない作品は数えない（催促にならないため）
          const config = await readWorkConfig(work);
          const freshness = await checkDictionaryFreshness(
            workPaths(work, config).settings
          );
          if (freshness.stale) total += 1;
        } else if (counter === "mergeCandidates") {
          // 同じ人物が別々に登録されている組を数える。
          // **まとめないと資料が二重になる**が、作者は
          // 「重複をまとめる」を開くまで気づけなかった
          const loaded = await new CharacterStore(work).loadAll();
          total += findMergeCandidates(loaded.characters).length;
        }
      } catch {
        // 読めない作品は0件として扱う。印が出ないだけで実害はない
      }
    }
    return total;
  });
  context.subscriptions.push(
    actionDecorations,
    vscode.window.registerFileDecorationProvider(actionDecorations)
  );

  // コマンドパレットにしかない操作は作者が存在に気づけないため、分類して一覧に出す。
  // 分類の開閉は作品をまたいで同じでよいので globalState に置く
  const actionProvider = new ActionListProvider(
    registry,
    {
      get: () => context.globalState.get<string[]>(ACTION_GROUPS_KEY, []),
      set: (groups) => void context.globalState.update(ACTION_GROUPS_KEY, groups),
    },
    (counter) => actionDecorations.countOf(counter)
  );
  const actionView = vscode.window.createTreeView("novelai.actions", {
    treeDataProvider: actionProvider,
  });
  // 画面での開閉を控えて次回に引き継ぐ。
  // VS Code は collapsibleState を作った時点の値でしか描かないため、
  // こちら側で覚えておかないと再読み込みで既定へ戻る
  actionView.onDidExpandElement((event) => {
    if (event.element.type !== "action") {
      actionProvider.setExpanded(nodeKey(event.element), true);
    }
  });
  actionView.onDidCollapseElement((event) => {
    if (event.element.type !== "action") {
      actionProvider.setExpanded(nodeKey(event.element), false);
    }
  });
  context.subscriptions.push(actionView);

  // **開いた瞬間に版が分かるように、見出しの右へ薄く出す**（作者の依頼、
  // 2026-09-22「開いたときにバージョンがわかるようどこか邪魔にならない
  // ところにバージョンを入れてください」）。タイトルバーは VS Code が
  // 拡張機能に貸さないので、2026-09-21 に一度取り下げた望みだが、
  // `TreeView.description` なら押す物も項目も増やさずに出せる。
  // **版は package.json から読む**——写しを置くと、上げ忘れた日に嘘をつく
  {
    const { version } = context.extension.packageJSON as { version?: string };
    actionView.description = menuVersionLabel(version);
  }

  // 作品づくりの流れ（1.作品登録 → … → 7.電子出版等）に沿った入口。
  // **操作の実体は詳細メニューの定義を参照するだけ**で、ここには持たない。
  // 最上段で選んだ作品を引数に載せて渡すので、押すたびに作品を訊かれない
  const stepProvider = new StepMenuProvider(
    registry,
    {
      get: () => context.globalState.get<string>(STEP_WORK_KEY),
      set: (id) => void context.globalState.update(STEP_WORK_KEY, id),
    },
    {
      get: () => context.globalState.get<string[]>(STEP_GROUPS_KEY, []),
      set: (groups) => void context.globalState.update(STEP_GROUPS_KEY, groups),
    },
    // **選んだ作品だけを数える**（設計書6.29）。詳細メニューの合算とは別
    (counter, workId) => actionDecorations.countOfWork(workId, counter)
  );
  const stepView = vscode.window.createTreeView("novelai.steps", {
    treeDataProvider: stepProvider,
  });
  // 開閉を控えて次回に引き継ぐ（詳細メニューと同じ理由）
  stepView.onDidExpandElement((event) => {
    if (event.element.type === "step" || event.element.type === "section") {
      stepProvider.setExpanded(stepNodeKey(event.element), true);
    }
  });
  stepView.onDidCollapseElement((event) => {
    if (event.element.type === "step" || event.element.type === "section") {
      stepProvider.setExpanded(stepNodeKey(event.element), false);
    }
  });
  // 見出しにも対象の作品名を出す（作者の依頼、2026-08-27）。
  // 最上段の選択窓はスクロールで画面の外へ流れるが、見出しは常に見える
  const updateStepViewDescription = (): void => {
    stepView.description = stepViewDescription(
      stepProvider.selectedWork(),
      registry.list().length > 0
    );
  };
  updateStepViewDescription();
  // 選び直し・作品の増減・件数の数え直しは、すべてこのイベントを通る
  context.subscriptions.push(
    stepProvider.onDidChangeTreeData(() => updateStepViewDescription())
  );
  context.subscriptions.push(stepView);

  /** 未反映の件数を数え直す。抽出・反映のあと、作品を選び直したあとに呼ぶ */
  const refreshActionBadges = (): void => {
    void actionDecorations.refresh().then(() => {
      actionProvider.refresh();
      // 同じ操作が2つのメニューに出るので、両方を引き直す
      stepProvider.refresh();
    });
    // 簡単ステップメニューは選んだ作品だけを数えるので、別に数え直す
    // （合算からその作品ぶんは割り出せない）
    void actionDecorations
      .refreshWork(stepProvider.selectedWork()?.id)
      .then(() => stepProvider.refresh());
  };
  // 起動直後にも数える。前回の抽出で溜まったままのことがある
  refreshActionBadges();
  registry.onDidChange(() => refreshActionBadges());
  // **Ollama の流し受信の設定を、純粋な部品へ差し込む**（設計書6.63.1、0.42.0）。
  // `ai/ollamaStream.ts` は VS Code に依存しないので、設定の読み方はここで渡す
  setStreamingSettingReader(() =>
    vscode.workspace.getConfiguration("novelai").get<boolean>("ollama.streaming")
  );
  // **作品フォルダーの本文を見張り、外で変わったら一覧を数え直す**
  // （`features/workFolderWatch.ts`。保存のときだけでは、ルビの適用・
  // 同期・別のエディタでの書き換えが開き直すまで一覧に出なかった）
  const folderWatchers = new WorkFolderWatchers((work) => {
    treeProvider.refresh(work.id);
  });
  folderWatchers.sync(registry.list());
  context.subscriptions.push(
    folderWatchers,
    registry.onDidChange(() => folderWatchers.sync(registry.list()))
  );

  /*
    **外部AIのノックを見つけて、その場で作者に尋ねる**（設計書6.87.14。
    作者の指示、2026-09-16「MCP承認を検知した場合は、拡張機能の画面上に
    ポップアップさせてください」）。

    MCPサーバーは別プロセスで、**VS Code が起動していなくても動く**ので、
    サーバーの側から画面は出せない。断った記録を見張って知らせる形にする
    ——起動したときにも一度読むので、**閉じている間のノックも出る。**
  */
  const externalAccessWatcher = new ExternalAccessWatcher(
    context,
    () => registry.list(),
    () => refreshActionBadges()
  );
  externalAccessWatcher.refresh();
  context.subscriptions.push(
    externalAccessWatcher,
    registry.onDidChange(() => externalAccessWatcher.refresh())
  );

  // 設定資料パネルからの保存を、本文の色分けと一覧へ届ける。
  // **パネルは長らくここを呼んでいなかった**ので、名前を変えても
  // 分けても、本文の用語ハイライトは古い人物を指したままだった
  setSettingsChangeObserver((work) => {
    highlighter.invalidate();
    treeProvider.refresh(work.id);
    refreshActionBadges();
  });
  context.subscriptions.push({
    dispose: () => setSettingsChangeObserver(undefined),
  });

  /**
   * 人物相関図の入口（設計書6.38）。
   *
   * 2つのパネルは互いを開く（設定資料の人物詳細から相関図へ、相関図から
   * 設定資料へ）。どちらかがもう一方を読み込むと輪になるので、繋ぐのは
   * ここだけにしてある。
   */
  const showRelationGraph = async (
    work: WorkEntry,
    characterId?: string
  ): Promise<void> => {
    await openRelationGraph(
      context,
      work,
      {
        openSettingsRecord: async (target, id) => {
          const panel = await openSettingsPanel(context, target, aiRegistry);
          await panel.showRecord("character", id);
        },
      },
      characterId ? { characterId } : {}
    );
  };
  setRelationGraphOpener((work, characterId) =>
    showRelationGraph(work, characterId)
  );
  context.subscriptions.push({
    dispose: () => setRelationGraphOpener(undefined),
  });

  /**
   * 年表の入口（設計書6.39）。
   *
   * 相関図と同じく、設定資料パネルと原稿エディタへの繋ぎはここだけに置く。
   * 年表の側からそれらを読み込むと、読み合いの輪ができる。
   */
  const showChronicle = async (work: WorkEntry): Promise<void> => {
    await openChronicle(context, work, {
      openSettingsRecord: async (target, id) => {
        const panel = await openSettingsPanel(context, target, aiRegistry);
        await panel.showRecord("character", id);
      },
      // 本文へ飛ぶ道は1本だけ（`revealLocation.ts`）。原稿エディタで
      // 書いていればその画面のまま示し、素のエディタなら素のまま開く
      revealInManuscript: (filePath, line) =>
        manuscriptProvider.revealLine(filePath, line),
      editTimeline: (target) => editTimeline(target),
    });
  };

  /**
   * シーンメモのパネル（設計書6.40.4）。
   *
   * 飛び先は1本の経路だけ（`revealLocation.ts`）。原稿エディタで書いて
   * いればその画面のまま示し、素のエディタなら素のまま開く。
   */
  const sceneMemoDeps: SceneMemoDeps = {
    revealInManuscript: (filePath: string, line: number) =>
      manuscriptProvider.revealLine(filePath, line),
    /*
      「直す」——AIの指摘を**種類ごとの道**（提案パネル）へ渡す（設計書6.96.5）。

      **シーンメモの側は本文を書き換えない。** 当てるのは提案パネルの既存の
      処理で、ここがするのは受け渡しだけである。組み立てはそちらと同じ
      `features/primeFindings.ts` を通す——写しを作ると、戻し方が片方だけ
      直る日が来る。

      **渡したら提案パネルを前へ出す。** 静かに置くだけだと、押しても何も
      起きなかったようにしか見えない（提案パネルは下段にあり、ほかのタブへ
      切り替えていると見えない）。
    */
    handOverFinding: async (work, finding) => {
      if (!handOverFinding(work, proposalPanel, finding)) return false;
      await vscode.commands.executeCommand(`${PROPOSALS_VIEW_ID}.focus`);
      return true;
    },
    // シーンメモで見送ったものを、提案の一覧からも下げる（6.96.5）
    noteFindingDismissed: (work, findingId) =>
      proposalPanel.noteFindingDismissed(work, findingId),
  };

  const showSceneMemos = async (
    work: WorkEntry,
    filePath?: string
  ): Promise<void> => {
    await openSceneMemoPanel(
      context,
      work,
      sceneMemoDeps,
      filePath ? { filePath } : {}
    );
  };

  /**
   * その本文が属する作品の、シーンメモのパネルを開く。
   *
   * **作品が分からなければ黙って諦めない。** 押しても何も起きないと、
   * 壊れているのか対象外なのかが作者に伝わらない。
   */
  const showSceneMemosFor = async (filePath: string): Promise<void> => {
    const found = await highlighter.indexFor(filePath);
    if (!found) {
      void vscode.window.showWarningMessage(
        "この原稿が属する作品が分かりませんでした。" +
          "作品として登録されているかご確認ください。"
      );
      return;
    }
    await showSceneMemos(found.work, filePath);
  };

  // 提案パネル（下段・出力やデバッグコンソールと同じ場所）。
  // 誤字脱字検知の結果をここへ表示する。0.22.24から作品ごとに
  // 置き場を分けて持つ。AIは「再チェック」（P-23）が使う。
  // 反映で承認待ちが減ったら、メニューの印を数え直す（0.23.2）。
  // 「飛ぶ」は、原稿エディタで書いていればその画面のまま示す（0.24.7）
  const proposalPanel = new ProposalPanel(
    aiRegistry,
    refreshActionBadges,
    (filePath, line) => manuscriptProvider.revealLine(filePath, line),
    // 開いたときに、溜まっている承認待ちを読み込む（0.45.0）。
    // **登録している作品ぶん見る**——ツリーの印は全作品の合計なので、
    // 表示中の1作品だけ読むと、印と噛み合わないままになる
    async (panel) => {
      for (const work of registry.list()) {
        try {
          await primePendingRecordUpdates(work, panel);
        } catch (error) {
          // 1つの作品が読めなくても、ほかの作品の分は出す。
          // 開いただけの場面なので、ダイアログは出さず記録に残す
          useLogFile(work.folderPath);
          logFailure("承認待ちの読み込みに失敗", {
            作品: work.title,
            詳細: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          // **数日残してある指摘も戻す**（設計書6.96.4）。承認待ちとは
          // 置き場も期限も違うので、片方が読めなくても他方は出す
          await primeSavedFindings(work, panel);
        } catch (error) {
          useLogFile(work.folderPath);
          logFailure("残っている指摘の読み込みに失敗", {
            作品: work.title,
            詳細: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PROPOSALS_VIEW_ID, proposalPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  /**
   * 検知を走らせる間、提案パネルに進み具合を出す（作者の報告、2026-08-29）。
   *
   * 「下に動いているときのチャンク数がでないですね」——結果が出るのは
   * このパネルなのに、進み具合はステータスバーにしか出ていなかった。
   *
   * **消すのは `finally` に置く。** 中止・失敗のときは結果（`issues`）が
   * 届かないので、画面側の「結果が来たら消す」だけでは足りない。
   * 「3/12」が出たまま残るのが、いちばん困る形である。
   *
   * @param unit 数えているもの。話ごとに送る検知は「話」になる
   * @param run 2つ目の引数 `stage` は、**段が変わる検知**（矛盾検知の検証段）
   *   のための別の札。同じ札の下で分母の違う数を流すと数が戻って見えるので、
   *   段ごとに札と単位を分ける
   */
  async function withPanelProgress<T>(
    work: WorkEntry,
    label: string,
    run: (
      onProgress: (
        done: number,
        total: number,
        skipped?: number,
        remaining?: string
      ) => void,
      stage: (
        stageLabel: string,
        stageUnit: string
      ) => (
        done: number,
        total: number,
        skipped?: number,
        remaining?: string
      ) => void
    ) => Promise<T>,
    unit = "チャンク"
  ): Promise<T> {
    // `skipped` は「処理済みで飛ばした数」。分母がAIへ送る数だけになった
    // 代わりに、飛ばした件数を画面へ添える（作者の指摘、2026-09-06）
    const reporter =
      (stageLabel: string, stageUnit: string) =>
      (done: number, total: number, skipped = 0, remaining = "") =>
        proposalPanel.showRunning(
          work,
          stageLabel,
          done,
          total,
          stageUnit,
          skipped,
          // 残り時間の見当（設計書6.8.19）。まだ言えないうちは空文字
          remaining
        );
    try {
      return await run(reporter(label, unit), reporter);
    } finally {
      proposalPanel.finishRunning();
    }
  }

  // いま開いている画面について相談するパネル（P-21）
  // 相談から標準機能を起動する口（作者の許可、2026-08-15）。
  // **コマンド名を組み立てて executeCommand を呼ばない。** 種別で分岐する
  // ことで、AIが返した文字列がコマンド名になる余地を無くしている
  // 作者のタイプ別の助言方針（設計書6.86）。**`globalState` に置く**——
  // 受容度や自信度は、GitHubで編集部と共有してよい情報ではない
  // **方針が変わったら、そのつど控えを書き直す**（設計書6.86.7）。
  // 控えは `globalStorage` の下に置き、MCP サーバー（VS Code の外）が読む——
  // 書き出さないと、**外部AI経由の相談だけタイプの方針も調子も効かない**
  const advicePolicies = new AdvicePolicyStore(context.globalState, () => {
    void refreshAdviceProfileMirror(
      context,
      advicePolicies,
      registry.list()
    ).catch(() => undefined);
  });
  // 作家タイプ診断（設計書6.90）。**作者ごとに1つ**——段取りや出し先は
  // 作品を変えても大きくは変わらない癖なので、作品ごとに聞き直さない
  const writerProfiles = new WriterProfileStore(context.globalState);
  // 作者自身の読者タイプ（設計書6.101）。**作品ではなく作者ごとに1つ**——
  // 「この作品は誰に届けるか」（6.91、作品ごと）とは別物で、
  // こちらは「あなた自身が読者として何を求めるか」である
  const authorReaderTypes = new AuthorReaderTypeStore(context.globalState);

  // 執筆スタイル（6.90）も相談へ渡す。渡すのは段取り（S1）と直す時期（S2）
  // だけで、資料の置き場・出し先は渡さない（作者の裁定、2026-09-14）。
  // ターゲット読者（6.91）は作品ごとのファイルにあるので、パネルが自分で読む
  // バックアップを選ぶ画面が、前に選んだフォルダーを覚えておく先
  // （相談パネルとメニューの取り込みで共有する。`backupPickFolder.ts`）
  initBackupPickFolder(context.globalState);
  const workChatPanel = new WorkChatPanel(registry, aiRegistry, {
    run: async (work, kind, filePath) => {
      // 既にコマンドとして登録されているものへ渡す。
      // **ここで処理を書き直さない。** 二重に持つと、片方だけ直したときに
      // 「メニューからは動くのに相談からは動かない」という食い違いが出る。
      //
      // 検知（誤字脱字・推敲・逸脱・矛盾・表記ゆれ）は 2026-09-06 に
      // ここへ寄せた。
      // それまでは相談側が結果の出し方まで自前で持っており、0.35.1 で
      // 入れた「指摘 N件＝パネルに残る件数」の数え方が届いていなかった
      // ——推敲とプロット逸脱は完了の知らせが出ず、矛盾はマージ・除外の
      // 前の件数を「指摘 N件」と言っていた（設計書6.8.16）
      const command = CHAT_RUN_COMMANDS[kind];
      if (command) {
        // 作品を指定して呼ぶ。引数無しだと作品選択からやり直させてしまう。
        // **相談の対象として印を付ける**（作者の裁定、2026-09-23）——作品を
        // 名指ししたのではなく、相談パネルが対象にしていた作品で走るので、
        // 「以降は訊かない」を覚えていても確認を出す
        const ref: WorkRef = { type: "work", work: markInferredWork(work, "chat") };
        await vscode.commands.executeCommand(command, ref);
        return;
      }

      // 以下は、コマンドの側が受け取れない道だけが残る。
      // 未保存のまま読むと、画面と違う本文を検知してしまう
      if (!(await saveDirtyDocumentsBeforeExtraction(work, "誤字脱字の検知"))) {
        return;
      }

      // **「いま開いている話だけ」の誤字脱字は、ここに残る。**
      // コマンド（`novelai.checkTyposForFile`）は一覧の節点（`EpisodeNode`）
      // を受け取るので、場所しか持っていない相談パネルからは呼べない。
      // 通知だけは共通の `reportTypoCheckResult` を通す（件数の数え方を
      // 写さないため）
      const result = await withPanelProgress(
        work,
        "誤字脱字を検知",
        (onProgress) =>
          checkTypos(work, aiRegistry, {
            onProgress,
            ...(kind === "checkTyposForFile" && filePath
              ? { filePaths: [filePath] }
              : {}),
          })
      );
      if (!result) return;
      const shown = proposalPanel.showResults(work, result.issues);
      reportTypoCheckResult(
        kind === "checkTyposForFile"
          ? `${path.basename(filePath ?? "")} の誤字脱字検知`
          : "誤字脱字検知",
        result,
        shown
      );
    },
    // 相談からの「AIで再読込」（設計書6.31.3）。
    // **設定資料パネルの再読込をそのまま呼ぶ。** ここで処理を書き直すと、
    // 画面のボタンから押したときと結果が食い違う
    reload: async (work, kind, recordId, notes) => {
      const panel = await openSettingsPanel(context, work, aiRegistry);
      await panel.reloadRecordFromChat(kind, recordId, notes);
    },
  }, advicePolicies, writerProfiles);
  // 相談パネルへ落とされたバックアップが、どの作品にも当たらなかったとき
  // （B13）。**メニューの「バックアップから取り込む」と同じ道へ渡す**——
  // 渡さないと、作者に同じファイルをもう一度選び直させることになる
  workChatPanel.setBackupImporter(async (picked) => {
    const { importWorkFromZip } = await import(
      "./features/importWorkFromZip.js"
    );
    await importWorkFromZip(
      registry.list(),
      (folderPath, title, options) =>
        registerFolderAsWork(folderPath, title, options),
      picked
    );
  });
  // 相談パネルへ落とされたバックアップと原稿の違いを、1か所ずつ提案パネルへ
  // 並べる（設計書6.99.7。作者の裁定、2026-09-23）。**提案パネルの実体は
  // ここにしか無い**ので、取り込みの口と同じ形で渡す
  workChatPanel.setBackupProposals((work, proposals) => {
    proposalPanel.showBackupDiffs(work, proposals);
  });
  // 相談パネルから話のファイルを足したあと（バックアップにあって手元に無い話）。
  // **`novelai.addEpisode` と同じ後始末**：一覧を読み直し、執筆量の基準を置き直す
  // （置き直さないと、次に書いた分が「今日 +0字」になって消える。設計書6.3.2）
  workChatPanel.setEpisodesAdded(async (work) => {
    treeProvider.refresh(work.id);
    await progress.rebaseline(work);
    updateStatusBar();
  });
  /*
    画面で指しながらの案内（設計書6.104。第1段）。

    **光らせる先は、ここでしか渡せない。** 3つのツリーは
    `createTreeView` の戻り値で、拡張機能の起動の途中にしか無い。
    押されたことを拾う口も、コマンド登録の包みに相乗りする形でここで繋ぐ
    ——案内していないあいだは何も起きない。
  */
  const actionSpotlight = createActionSpotlight({
    stepView,
    stepProvider,
    actionView,
    actionProvider,
    // 選ぶだけでは薄くて気づけなかった（作者の報告、2026-09-22）。
    // 指している項目に「▶」の印を残す先を渡す
    marker: actionDecorations,
  });
  workChatPanel.setTourSpotlight(actionSpotlight);
  onCommandFinished = (command) => workChatPanel.notifyCommandRun(command);

  /*
    **外部AI（MCP）からの「この項目を光らせて」を拾う**（設計書6.104。
    0.75.6。作者の指示、2026-09-22「内部と外部のAIからメニュー操作して
    2回点滅を出せるようにしてください」）。

    ノックの見張り（6.87.14）と同じ形——別プロセスのMCPサーバーが
    `.aiwriter/history/spotlight.jsonl` へ1行書き、こちらが見張る。
    **光らせるだけで、命令は実行しない。**
  */
  const spotlightRequests = new SpotlightRequestWatcher(
    context,
    () => registry.list(),
    actionSpotlight
  );
  spotlightRequests.refresh();
  context.subscriptions.push(
    spotlightRequests,
    registry.onDidChange(() => spotlightRequests.refresh())
  );

  /*
    **画面で指している作品を、作品を訊く場面の当てどころにする**（0.75.4。
    設計書6.68.2／6.104）。

    **見えているものだけを渡す。** 畳んだツリーの選択や、閉じた相談の対象は
    作者の目に入っていない——そこから当てると、作者から見れば
    「関係のない作品が勝手に選ばれた」ことになる。
  */
  workTargetHints = () => ({
    treeSelectedId: worksView?.visible
      ? worksView.selection.find(
          (item): item is WorkNode => item.type === "work"
        )?.work.id
      : undefined,
    chatTargetId: workChatPanel.isVisible()
      ? workChatPanel.currentWorkId()
      : undefined,
  });

  context.subscriptions.push(
    workChatPanel,
    vscode.window.registerWebviewViewProvider(WORK_CHAT_VIEW_ID, workChatPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // パネルへフォーカスが移ると activeTextEditor は undefined になるので、
    // 最後に開いていた本文を覚えておく
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      workChatPanel.trackEditor(editor);
    }),
    // アイコンを増やすと、同じ絵柄が並んで何のアイコンか分からなくなる
    // （実機で指摘、2026-08-15）。左サイドバーの中に置き、
    // メニューと本文の右クリックから開く形にした
    registerCommand("novelai.openChat", async () => {
      // 呼ぶ前に、今開いている本文を確実に覚えさせる。
      // このコマンド自体はエディターのフォーカスを奪わないが、
      // パネルを開いた時点で activeTextEditor は取れなくなる
      workChatPanel.trackEditor(vscode.window.activeTextEditor);
      await vscode.commands.executeCommand(`${WORK_CHAT_VIEW_ID}.focus`);
    }),
    // 本文の領域に大きく開く（作者の要望、2026-08-28）。
    // **横の小さいパネル（novelai.openChat）は残す。** 範囲を選んで聞くときは
    // 本文が見えている必要があり、大きい画面では隠れてしまう
    registerCommand("novelai.openChatPanel", () => {
      // 開く前に、今の本文を覚えさせる（`openChat` と同じ理由）
      workChatPanel.trackEditor(vscode.window.activeTextEditor);
      workChatPanel.openLargePanel();
    }),
    registerCommand("novelai.exitChatFocus", async () => {
      await setChatFocus(false);
    }),
    // 1つのメニューだけを残す（作者の依頼、2026-08-29）。
    // **入口はビューごとに分ける。** 「どのビューを残すか」を後から訊く形にすると、
    // 押したビューを残したいだけなのに選択画面が1枚挟まる
    registerCommand("novelai.soloWorks", () => setSoloView("works")),
    registerCommand("novelai.soloSteps", () => setSoloView("steps")),
    registerCommand("novelai.soloActions", () => setSoloView("actions")),
    registerCommand("novelai.soloChat", () => setSoloView("chat")),
    registerCommand("novelai.showAllViews", () => setSoloView(undefined))
  );
  // 3つのツリー（作品一覧・詳細メニュー・簡単ステップ）と、2つのパネル
  // （提案・AIに相談）を登録し終えた所。ここまでが「画面の登録」（設計書6.107）
  startupTiming.mark("画面の登録");

  /**
   * 相談に集中する表示にする／戻す（設計書6.21.2）。
   *
   * 作品一覧と操作メニューを引っ込め、相談パネルへ場所を譲る。
   * `package.json` のビューの `when` が、この印を見て出し入れする。
   *
   * **戻す口を必ず用意する。** 消えたまま戻し方が分からないと、
   * 拡張機能が壊れたようにしか見えない。相談パネルの見出しに
   * 「作品一覧とメニューを出す」ボタンが出る。
   */
  async function setChatFocus(on: boolean): Promise<void> {
    // 印の名前は `viewVisibility.ts` が持つ。写しを作ると、
    // 起動時に戻すつもりの印と別のものを立ててしまう
    await vscode.commands.executeCommand("setContext", FOCUS_CHAT_KEY, on);
  }

  /**
   * 1つのメニューだけを残して、ほかを引っ込める（作者の依頼、2026-08-29）。
   *
   * 左側には4つのビュー（作品一覧・簡単ステップメニュー・詳細メニュー・
   * AIに相談）が縦に並ぶ。畳んでも見出しの行は残るので、1つを大きく使いたい
   * ときに邪魔になる。
   *
   * 渡すのは残すビューの短い名前（"works" | "steps" | "actions" | "chat"）で、
   * `package.json` のビューの `when` がこの印を見て出し入れする。
   * `undefined` を渡すと印が消えて、全部が戻る。
   *
   * **相談に集中する表示（`novelai.focusChat`）とは別に持つ。** どちらも
   * 「ほかを引っ込める」だが、focusChat は相談パネルを開く流れの中で自動的に
   * 掛かるもので、こちらは作者が明示的に選ぶもの。1つの印にまとめると、
   * プロット相談を終えたときに、作者が選んだ表示まで巻き戻ってしまう。
   *
   * **覚えない（globalState へ書かない）。** 閉じた状態のまま再起動すると、
   * 出し方を知らない作者には拡張機能が壊れたようにしか見えない。
   * 起動のたびに全部出るほうが、閉じ込め事故より安い。
   *
   * **覚えないだけでは足りなかった**（作者の報告、2026-09-03）。印を持つのは
   * VS Code側なので、拡張機能ホストだけが再起動すると前の印が残る。
   * 起動時に `resetViewVisibility` で入れ直している。
   */
  async function setSoloView(view: string | undefined): Promise<void> {
    await vscode.commands.executeCommand("setContext", SOLO_VIEW_KEY, view);
  }

  // ─── AIの独り言（設計書6.21） ───
  const chatter = new ChatterService({
    resolveAi: () => {
      // 独り言は相談パネルへ出るものなので、相談の割当で有料かを見る
      const resolved = aiRegistry.resolve("chat");
      return resolved ? { paid: resolved.provider.isPaid } : undefined;
    },
    panelVisible: () => workChatPanel.isVisible(),
    post: (item, work, filePath) =>
      workChatPanel.postChatter(item, work, filePath),
    summary: async (work) => {
      const summary = await progress.summary(work);
      return summary
        ? {
            today: summary.today,
            written: summary.todayProgress.written,
            streak: summary.streak,
          }
        : undefined;
    },
    // **まだ設定資料へ取り込んでいない話の数**（設計書6.21.1）。
    // 更新時刻だけで見る。中身で比べるには全話をチャンクへ割ることになり、
    // 独り言のために払う費用としては大きすぎる
    unextractedEpisodes: (work) => countUnextractedEpisodes(work),
    counts: () => ({
      pendingUpdates: actionDecorations.countOf("pendingUpdates"),
      mergeCandidates: actionDecorations.countOf("mergeCandidates"),
    }),
    // **本文を読んだ感想**（設計書6.21.4）。相談パネルへ出るものなので、
    // 割当も相談（`chat`）に相乗りする。有料かどうかは向こうでも見る
    requestComment: (work, manuscriptPath, signal) =>
      requestChatterComment(
        work,
        manuscriptPath,
        () => aiRegistry.resolve("chat"),
        signal
      ),
  });
  chatter.start();
  context.subscriptions.push(chatter);

  // ─── ログの整理（設計書8.3） ───
  // **起動のときに1回だけ。** 書き込みのたびに全体を読み直すと、
  // 抽出のように何十回も書く処理が遅くなる。
  // 失敗しても何も言わない（整理できないことを知らせる必要はない）
  void pruneAllLogs(registry.list()).catch(() => undefined);

  // ─── MCP の束の写しを作り直す（設計書6.87.15） ───
  // **起動のたびに。** 作品へ書いた登録は、版に依らない場所へ写した束を
  // 指している。写さないと、拡張機能を更新したあと作者が「AI用の指示書を
  // 置く」を走らせるまで**古い束が静かに走り続ける**——道が切れるより
  // 気づきにくい。写し直せば更新時刻が変わるので、`mcp/staleness.ts` の
  // 判定2が拾って「開き直してください」と出る。
  // 失敗しても何も言わない（次に指示書を置くときに写し直される）
  void refreshStableBundle(context).catch(() => undefined);

  // ─── 窓の札（MCP の windows.list。作者の依頼 2026-09-22） ───
  // 2台で実機確認をするとき、どの窓がどの版で動いているかを
  // 外のセッションが聞けるように、保管庫へ札を書く。5分ごとに打ち直し、
  // 閉じるときに消す（`deactivate`）。ブラウザ版では書かない（読む相手が居ない）
  const windowCard = startWindowCard(context);
  if (windowCard) {
    context.subscriptions.push(windowCard);
    closeWindowCard = windowCard.close;
  }

  // ─── 助言方針の控え（設計書6.86.7） ───
  // **取り込んでから書き出す。** 外部AI経由の相談で動いた推定は
  // `globalStorage` の控えにしか無いので、先に取り込まないと次の書き出しで
  // 消える。取り込むのは「控えのほうが新しい」ときだけで、決められない
  // ときは手元（`globalState`）を残す。
  // 失敗しても何も言わない（画面に出すような話ではない。理由はログへ）
  void (async () => {
    await importAdviceProfileMirror(context, advicePolicies, registry.list());
    await refreshAdviceProfileMirror(context, advicePolicies, registry.list());
  })().catch(() => undefined);

  // ─── ステータスバー（現在開いているファイルの文字数） ───
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.tooltip = "小説AI執筆補助: 現在のファイルの文字数";
  context.subscriptions.push(statusBar);

  /**
   * 表示を作り直した回数。
   *
   * 今日の執筆量は記録を読んでから添えるため、書いている最中に
   * 何度も呼ばれると古い結果が新しい表示を上書きしうる。
   * 自分より新しい呼び出しがあれば、その結果は捨てる。
   */
  let statusBarGeneration = 0;

  const updateStatusBar = () => {
    const generation = ++statusBarGeneration;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      statusBar.hide();
      return;
    }
    const ext = path.extname(editor.document.fileName).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      statusBar.hide();
      return;
    }

    // 作品一覧と同じ部品を使う。別々に読むと、片方だけ直したときにずれる
    const mode = currentCountMode();
    const excludeRuby = excludeRubyFromCount();

    const counts = countChars(
      editor.document.getText(),
      ext === ".md" ? excludeRuby : false
    );
    const value = pickCount(counts, mode);
    const label = countModeLabel(mode);

    // 選択範囲があればその文字数も出す
    const sel = editor.selection;
    let selectionPart = "";
    if (!sel.isEmpty) {
      const selCounts = countChars(
        editor.document.getText(sel),
        ext === ".md" ? excludeRuby : false
      );
      const selValue = pickCount(selCounts, mode);
      selectionPart = ` (選択 ${formatCount(selValue)})`;
    }

    const fileText = `$(book) ${label}${formatCount(value)}字${selectionPart}`;
    const fileTooltip = [
      `**${path.basename(editor.document.fileName)}**`,
      "",
      `- 純文字数: ${formatCount(counts.net)} 字`,
      `- 総文字数: ${formatCount(counts.gross)} 字`,
      `- 段落数: ${counts.paragraphs}`,
      `- 原稿用紙換算: 約 ${formatCount(toManuscriptPages(counts.manuscriptLines))} 枚`,
    ];
    statusBar.text = fileText;
    statusBar.tooltip = new vscode.MarkdownString(fileTooltip.join("\n"));
    statusBar.show();

    // 今日どれだけ進んだかは、開いているファイルの字数だけでは分からない。
    // 記録が読めたときにだけ添える（統計を切っていれば何も出ない）
    const showProgress = vscode.workspace
      .getConfiguration("novelai")
      .get<boolean>("stats.showInStatusBar", true);
    const work = showProgress
      ? findWorkForPath(registry, fromUri(editor.document.uri))
      : undefined;
    if (!work) return;

    void progress.summary(work).then((summary) => {
      if (!summary || generation !== statusBarGeneration) return;
      statusBar.text = `${fileText}  ${describeStatusBarProgress(summary)}`;
      statusBar.tooltip = new vscode.MarkdownString(
        [
          ...fileTooltip,
          "",
          `**${work.title}**`,
          "",
          `- 今日: ${formatCount(summary.todayProgress.written)} 字${
            summary.todayProgress.goal > 0
              ? `（目標 ${formatCount(summary.todayProgress.goal)} 字 / 達成率 ${
                  summary.todayProgress.rate
                }%）`
              : ""
          }`,
          `- 今月: ${formatCount(summary.monthProgress.written)} 字（${
            summary.monthActiveDays
          }日）`,
          `- 連続: ${summary.streak} 日`,
        ].join("\n")
      );
    });
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatusBar),
    vscode.window.onDidChangeTextEditorSelection(updateStatusBar),
    // **数え方の設定を変えたら、その場で反映する。** これまで受け口が
    // 無く、ファイルを開き直すまで古い数字のままだった（2026-08-21）
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!needsRedraw(event)) return;
      updateStatusBar();
      // ルビの扱いは走査のときに効くので、変わったら読み直す。
      // 純／総の切り替えは両方を数えてあるので、描き直すだけでよい
      if (needsRescan(event)) {
        treeProvider.refresh();
      } else {
        treeProvider.redraw();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        updateStatusBar();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      updateStatusBar();
      // プロットを書き換えたら形式を読み直す。作者が「## 形式」を
      // 直したのに一覧が「第3話」のままでは、直った気がしない
      if (path.basename(document.fileName).toLowerCase() === "plot.md") {
        invalidateWorkFormat();
        // 簡単ステップメニューも、タイプで絞ったものを並べ直す（設計書6.70.1）。
        // 忘れると、タイプを変えたのに前のタイプの並びが残る
        stepProvider.invalidateFormats();
        // 「主要登場人物」に書き足した人を、設定資料の更新案として積む
        // （設計書6.4.9）。**台帳へは書かない**——承認待ちに積むだけで、
        // 反映は作者が「更新分を反映」で承認したときに起きる
        void syncPlotCharactersOnSave(fromUri(document.uri));
      }
      treeProvider.refresh();
      // 「直前にどの環境で書いていたか」を残す（設計書5.5.2）。
      // 開いただけでは書かない。何も書いていないのに作業ツリーが汚れ、
      // 未コミットの変更を理由に取り込みが止まるようになるため
      void recordEditedSession(fromUri(document.uri));
      // 保存した瞬間が、書いた量を数えられる唯一の機会である（設計書6.3）
      void recordWritingProgress(fromUri(document.uri));
      // 付箋を書き足したり消したりしたのは、保存で初めてディスクに残る。
      // **開いているパネルだけ**が読み直す（設計書6.40.4）
      void refreshSceneMemos(fromUri(document.uri));
      // プロットと単話プロットの保存で、プロットモードの目次と印を
      // 作り直す（設計書6.4.8。開き直さなくても追いつくようにする）
      void refreshPlotMode(fromUri(document.uri));
    })
  );
  updateStatusBar();

  /**
   * 保存された本文の作品で、前回からの増減をその日の執筆量として記録する。
   *
   * 記録し終えてからステータスバーを出し直す。保存した直後に
   * 「今日 +0字」のままだと、書いたのに数えられていないように見える。
   */
  async function recordWritingProgress(filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return;
    const work = findWorkForPath(registry, filePath);
    if (!work) return;
    // 保存を「手を動かした」印として独り言へ渡す。
    // 書いている最中に話しかけないための基準になる
    chatter.noteEdit(work, filePath);
    await progress.record(work);
    updateStatusBar();
    // **記録し終えてから、原稿エディタの下段を測り直す**（作者の指示、
    // 2026-08-29）。先に読むと「今日 +◯字」が保存1回ぶん古いままになる
    refreshManuscriptCounts(filePath);
    await refreshWritingStatsPanel(work, deviceId);
    await refreshAllWorksWritingStatsPanel(registry, deviceId);
  }

  /**
   * 保存された plot.md の「主要登場人物」を、更新案として積む（設計書6.4.9）。
   *
   * **前回と同じ内容なら何もしないし、何も言わない。** 保存のたびに同じ
   * 提案が積まれる画面にしない。失敗しても保存の流れを止めない
   * （書いている手を、資料の都合で止めない）。
   */
  async function syncPlotCharactersOnSave(filePath: string): Promise<void> {
    const work = findWorkForPath(registry, filePath);
    if (!work) return;
    try {
      await syncPlotCharacters(work);
    } catch (error) {
      logFailure("プロットからの人物反映に失敗", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 保存された本文が属する作品に、この環境の編集記録を残す */
  async function recordEditedSession(filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return;
    const work = findWorkForPath(registry, filePath);
    if (!work) return;
    try {
      await new SessionStore(work, deviceId).record(filePath);
    } catch (error) {
      // 記録できなくても執筆は続けられる。黙って諦めずログには残す
      logFailure("最終編集環境の記録に失敗", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 別の環境が最近書いていたら知らせる（設計書5.5.2）。
   *
   * ロックはしない。同一人物なので、知らせれば本人が判断できる。
   * 作品ごとに1回だけ出す。開くたびに出ると読まれなくなる。
   */
  const sessionNotified = new Set<string>();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (!editor) return;
      const work = findWorkForPath(registry, fromUri(editor.document.uri));
      if (!work || sessionNotified.has(work.id)) return;
      sessionNotified.add(work.id);

      const other = await new SessionStore(work, deviceId).newerElsewhere();
      if (!other) return;
      vscode.window.showInformationMessage(
        `「${work.title}」を${describeOtherDeviceSession(other)}` +
          "取り込み忘れがないか確認してください。"
      );
    })
  );

  // ─── コマンド ───

  /**
   * 場所を1つ受け取って、作品として登録する。
   *
   * **入口が違っても、ここから先は同じ道を通す。** 「フォルダから追加」と
   * 「GitHubから追加」（ブラウザ版）は場所の決め方が違うだけで、書庫の
   * 見分け方も、登録後の集計も同じでよい。分けて書くと、片方だけ直る
   * （実際、登録後の集計を囲む修正は片方にしか入っていなかった）。
   */
  async function registerFolderAsWork(
    folderPath: string,
    /**
     * 作品名。渡されなければ作者に入力してもらう。
     *
     * **ブラウザ版の実動テスト（`npm run test:web`）が通るための口**
     * （設計書5.8.13）。入力画面は誰も押せないので、テストからは名前を
     * 添えて呼ぶ。作者が押したときは `undefined` のままで、これまでと
     * 同じ画面が出る
     */
    givenTitle?: string,
    /**
     * 呼び出し側が知っていること。
     *
     * **自分で作った作品フォルダーを登録するとき**（ZIPからの取り込み）は
     * `knownSingleWork` を立てる。渡さなければこれまでどおり、書庫かどうかを
     * 中身から見分ける
     */
    options: CollectionOptions = {}
  ): Promise<WorkEntry | undefined> {
    // **書庫かもしれない。** 中に作品フォルダーが並んでいたら、
    // まとめて登録する（設計書5.7）。作品そのものならこれまで通り進む。
    // ただし呼び出し側が1作品だと知っているときは、訊かずに進む
    const collection = await tryRegisterAsCollection(
      registry,
      folderPath,
      options
    );
    if (collection.handled) {
      if (collection.added.length > 0) {
        treeProvider.refresh();
        highlighter.invalidate();
      }
      return undefined;
    }

    const defaultTitle = path.basename(folderPath);
    const title =
      givenTitle ??
      (await askText({
        prompt: "作品名を入力してください",
        value: defaultTitle,
        validateInput: (v) =>
          v.trim().length === 0 ? "作品名を入力してください" : null,
      }));
    if (title === undefined) return undefined;

    let entry: WorkEntry | undefined;
    try {
      entry = await registry.addExisting(folderPath, title.trim());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(
        `作品フォルダを登録できませんでした。登録状態は変更されていません。\n${detail}`
      );
      return undefined;
    }
    if (!entry) return undefined;

    // **登録はもう済んでいる。** ここから先（文字数の集計）で失敗しても、
    // 一覧の更新まで巻き添えにしない。以前は `scanWork` を囲っておらず、
    // 集計で落ちると**登録できているのに画面が何も変わらなかった**
    // （2026-08-22、作者の環境で判明）
    try {
      const result = await scanWork(entry);
      vscode.window.showInformationMessage(
        `「${entry.title}」を登録しました（${result.stats.fileCount}ファイル / ${formatCount(
          result.stats.totals.net
        )}字）`
      );
    } catch (error) {
      logFailure("登録後の集計", {
        作品: entry.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
      vscode.window.showInformationMessage(
        `「${entry.title}」を登録しました（文字数の集計は後で行います）。`
      );
    }
    treeProvider.refresh();
    highlighter.invalidate();

    /*
      **2作目を書庫の外へ登録したときだけ、1度だけ、まとめるかを訊く**
      （設計書6.97.3）。判断は `core/libraryHome.ts` にあるので、ここでは
      登録が済んだことだけを伝える。1作目・3作目以降・すでに同じ書庫の中、
      のいずれかなら、この呼び出しは何もせずに戻る。

      **登録の終わりを、この案内で待たせない**（`firstRun.ts` と同じ形）。
      ボタンの付いた案内は押されるまで消えないので、await すると
      「登録できた」が返るのがそこまで遅れる——ブラウザ版の実動テスト
      （画面を押せない）が止まってしまう。失敗はログへ残すだけにして、
      登録そのものは巻き添えにしない
    */
    const registered = registry.list();
    const added = entry;
    void (async () => {
      try {
        const { offerLibraryMergeInVsCode } = await import(
          "./features/offerLibraryMerge.js"
        );
        await offerLibraryMergeInVsCode(context, registered, added);
      } catch (error) {
        logFailure("書庫へまとめる案内", {
          詳細: error instanceof Error ? error.message : String(error),
        });
      }
      /*
        **書庫に作品が並んだときだけ、1度だけ、シリーズをつなぐかを訊く**
        （設計書6.95.4）。まとめる案内の**あと**に置くのは、2つの案内が
        同時に出ると、どちらに答えたのか分からなくなるためである。
        書庫の外の2作目なら上が出て、こちらは（隣が無いので）何もしない。
      */
      try {
        const { offerSeriesLinkInVsCode } = await import(
          "./features/offerSeriesLink.js"
        );
        await offerSeriesLinkInVsCode(context, registered, added);
      } catch (error) {
        logFailure("シリーズをつなぐ案内", {
          詳細: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return entry;
  }

  context.subscriptions.push(
    registerCommand("novelai.addWork", async (argument?: unknown) => {
      // **場所と作品名を引数で渡せる**（設計書5.8.13）。ブラウザ版の実動テスト
      // （`npm run test:web`）は画面を押せないので、選択画面と入力画面を
      // 飛ばす道が要る。作者が押したときは引数が無く、これまで通り画面が出る
      const given = parseAddWorkArgument(argument);
      const folderPath =
        given?.folderPath ??
        (await pickFolder("作品フォルダを選択", "この作品フォルダを登録"));
      // **フォルダー選びを閉じたら「取りやめ」と名乗る**（設計書6.104）。
      // 黙って戻ると、画面の案内が済んだものとして次の段へ行く
      if (!folderPath) return CHECK_CANCELLED;
      // 登録できた作品を返す。呼んだ側（テスト）が結果を確かめられる。
      // **ここは形を変えない**——ブラウザ版の実動テストが作品を受け取る。
      // `undefined` のときは「書庫としてまとめて登録した（成功）」と
      // 「作品名を閉じた（取りやめ）」が混ざっており、見分けが付かない
      return await registerFolderAsWork(folderPath, given?.title);
    })
  );

  /*
    **書庫にあるのに登録されていない作品を拾う**（設計書6.97.4）。

    OSのフォルダー選びを通さない道である。書庫の場所は登録済み作品から
    割り出せるので、作者に選ばせる必要が無い。「フォルダから追加」は
    **書庫の外**から入れる道として残してある。
  */
  context.subscriptions.push(
    registerCommand("novelai.collectUnregisteredWorks", async () => {
      const { collectUnregisteredWorks } = await import(
        "./features/collectUnregisteredWorks.js"
      );
      await collectUnregisteredWorks(registry, () => {
        treeProvider.refresh();
        highlighter.invalidate();
      });
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.importWorkFromZip", async () => {
      // **登録は「フォルダから追加」と同じ道を通す。** 取り込み側は
      // 場所と題を決めるところまでで、そこから先（集計・一覧の更新）は
      // 写さない（設計書6.98）。**書庫の見分けだけは通らない**——
      // その作品フォルダーを作ったのは取り込み自身なので、
      // 「書庫かもしれない」と訊く相手がいない（6.99）
      const { importWorkFromZip } = await import(
        "./features/importWorkFromZip.js"
      );
      await importWorkFromZip(registry.list(), (folderPath, title, options) =>
        registerFolderAsWork(folderPath, title, options)
      );
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.createWork", async () => {
      // **取りやめ・失敗・完走をそのまま通す**（設計書6.104）
      return await createNewWork();
    })
  );

  // 操作メニューからは始め方を選んだ状態で入る。
  // 「プロットから開始」を押した作者に、もう一度「どちらから始めますか」と
  // 訊き返すのは失礼である
  context.subscriptions.push(
    registerCommand("novelai.createWorkWithPlot", async () => {
      return await createNewWork("plot");
    }),
    registerCommand(
      "novelai.createWorkFromManuscript",
      async () => {
        return await createNewWork("manuscript");
      }
    )
  );

  /**
   * 新規作品を作る。
   *
   * @param mode 始め方。渡されなければ作者に選んでもらう
   *   （コマンドパレットの「新規作品を作成」から来た場合）
   */
  async function createNewWork(
    mode?: WorkStartMode
  ): Promise<CheckCommandOutcome> {
    /*
      **行き先は書庫にする**（設計書6.97.2）。「書庫を作りますか」とは
      訊かない——初めて使う人は、書庫が何の役に立つのかをまだ知らない。
      すでに書庫があれば訊かずにそこへ入れ、分かれているときだけ訊く。
      決まった行き先は、下の入力画面に一行で添える。

      ブラウザ版でフォルダーを選ぶ道（開いているフォルダーから選ぶ。
      設計書5.8.8）は、この中の `pickFolder` がこれまでどおり受け持つ。
    */
    const { resolveNewWorkHome } = await import("./features/newWorkHome.js");
    const home = await resolveNewWorkHome(registry.list());
    if (!home) return CHECK_CANCELLED;
    const parentPath = home.folderPath;

    const title = await askText({
      title: home.note,
      prompt: "作品名を入力してください（フォルダ名になります）",
      validateInput: (v) => {
        const t = v.trim();
        if (t.length === 0) return "作品名を入力してください";
        if (/[/\\:*?"<>|]/.test(t)) return "フォルダ名に使えない文字が含まれています";
        return null;
      },
    });
    if (!title) return CHECK_CANCELLED;

    // **タイプも始め方も、フォルダーを作る前に訊く。** 作ったあとで
    // 取り消されると、中身の無い作品フォルダーだけが残る
    const workType = await chooseWorkType(title.trim());
    if (!workType) return CHECK_CANCELLED;
    const format =
      workType === "unset" ? undefined : (workType.key as WorkFormatKey);

    /*
      **創作メモ集には「始め方」を訊かない**（設計書6.70）。プロットの
      無いタイプなので選びようがなく、選ばせても書くのはメモである。
      訊かずに最初のメモ（無題.md）を開く。
    */
    const startMode = skipsStartModeQuestion(format)
      ? "manuscript"
      : (mode ?? (await chooseWorkStartMode(title.trim())));
    if (!startMode) return CHECK_CANCELLED;

    const folderPath = path.join(parentPath, title.trim());
    try {
      await scaffoldWorkFolder(folderPath, title.trim(), {
        withPlot: startMode === "plot",
      });
    } catch (e) {
      vscode.window.showErrorMessage(
        `作品フォルダの作成に失敗しました: ${String(e)}`
      );
      // **取りやめではなく失敗である。** 作者は押しており、止めたのは
      // こちらの都合なので、そう名乗る（まとめ実行は失敗では止まらない）
      return CHECK_FAILED;
    }

    const entry = await registry.add(folderPath, title.trim());
    if (!entry) return CHECK_FAILED;

    /*
      **タイプの在り処はプロットの `## 形式` ひとつ**（設計書6.4.5・6.70）。

      `.aiwriter/config.json` にも持たせると二重管理になり、作者が
      プロットを書き換えたときにどちらが本当か分からなくなる。
      「本文から書き始める」を選んだ作品でも、タイプを決めたなら
      そのためだけに `設定/plot.md` を作る（決めなければ作らない）。
      **書くのは「形式」の節だけ**——`updatePlotMarkdown` は頼まれた節しか
      書かないので、創作メモ集にプロットの見出し一式が並ぶことはない。
    */
    if (workType !== "unset") {
      try {
        await writePlotSections(entry, { format: workType.label });
        invalidateWorkFormat(entry.id);
      } catch (e) {
        // タイプを書けなくても作品は作れている。**作業を止めない**
        vscode.window.showWarningMessage(
          `作品タイプをプロットへ書けませんでした（${String(e)}）。` +
            // 詳細メニューの名前と揃える（`actionList.ts` の label）。
            // 画面の案内が、実際に押す項目と違う名前を言わないように
            "「形式とジャンル」からやり直せます。"
        );
      }
    }

    treeProvider.refresh();
    if (startMode === "plot") {
      await openPlotFile(entry);
      await startPlotAdvice(entry);
    } else {
      // 空の第1話を作ったら、執筆量の基準を置き直す（設計書6.3.2）。
      // **置き直さないと、作者が書いて最初に保存した分が消える**
      await createFirstEpisodeFile(
        entry,
        (work) => progress.rebaseline(work),
        format
      );
    }
    return CHECK_COMPLETED;
  }

  /**
   * 新しい作品のプロット相談を始める（設計書6.21.2）。
   *
   * **プロットから始めるときだけ出す。** 「本文から書き始める」を選んだ作者は
   * 先に書きたいのであって、相談したいわけではない。
   *
   * 相談パネルへ場所を譲るため、作品一覧と操作メニューを引っ込める。
   * 白紙のプロットと相談窓を並べたいところなので、
   * 左側に一覧が3つ並んでいると相談窓が数行しか見えない。
   */
  async function startPlotAdvice(work: WorkEntry): Promise<void> {
    await setChatFocus(true);
    await vscode.commands.executeCommand(`${WORK_CHAT_VIEW_ID}.focus`);
    await workChatPanel.startPlotAdvice(work);
    // プロットを書く場所へ戻す。相談窓に居座ると、
    // 話を聞いたあとに書き始められない
    await openPlotFile(work);
  }

  context.subscriptions.push(
    registerCommand(
      "novelai.createPlot",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await openPlotFile(work);
      }
    ),
    // プロットモード（設計書6.4.8）。**左に plot.md、右に作業パネル**。
    // パネルは読むだけ＋既存の操作の呼び出しだけで、書き込みの道は増やさない
    registerCommand(
      "novelai.openPlotMode",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await openPlotMode(context, work);
      }
    ),
    // 対話でプロットを埋める（設計書6.4.7）。**AIに筋書きを作らせず、
    // まだ書かれていない項目を1つずつ尋ねて引き出す**
    registerCommand(
      "novelai.plotInterview",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;
        await workChatPanel.startPlotInterview(work);
        return CHECK_COMPLETED;
      }
    ),
    registerCommand(
      "novelai.setPlotBasics",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;
        await setPlotBasics(work);
        /*
          **ここが「作品タイプを後から変える」入口である**（設計書6.70）。

          書き換えたのはプロットのファイルそのものなので、保存の合図
          （`onDidSaveTextDocument`）は流れてこない。覚えている形式を
          捨てないと、一覧の見出しも右クリックもステップも前のタイプの
          ままで、**変えたのに何も起きていないように見える。**
        */
        invalidateWorkFormat(work.id);
        treeProvider.refresh(work.id);
        stepProvider.invalidateFormats(work.id);
        return CHECK_COMPLETED;
      }
    ),
    registerCommand(
      "novelai.setWorkGoals",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await setWorkGoals(work);
        // 目標を変えたら、開いているパネルの「あと何字」を出し直す
        await refreshWritingStatsPanel(work, deviceId);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.generatePlot",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        // 未保存のまま読むと、画面と違う本文からプロットを組み立ててしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "プロットの逆算")))
          return;
        await generatePlot(work, aiRegistry);
      }
    )
  );

  context.subscriptions.push(
    registerCommand("novelai.addWorkFromGithub", async () => {
      // **ブラウザ版でも、別のリポジトリの作品を登録できる**（設計書5.8.12）。
      // 取り寄せる（`git clone`）代わりに、GitHubの中身を直に読む仕組みを指す。
      // 場所が決まったあとは「フォルダから追加」とまったく同じ道を通る
      if (!canRunProcesses()) {
        const { resolveGithubRepoFolder } = await import(
          "./features/addWorkFromGithubWeb.js"
        );
        const folderPath = await resolveGithubRepoFolder();
        if (!folderPath) return;
        await registerFolderAsWork(folderPath);
        return;
      }
      const { addWorkFromGithub } = await import(
        "./features/addWorkFromGithub.js"
      );
      const entries = await addWorkFromGithub(registry);
      if (entries.length === 0) return;
      treeProvider.refresh();
      // 取り寄せた作品の設定が用語ハイライトの材料になる
      highlighter.invalidate();
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.gitRestore",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        if (!canRunProcesses()) {
          vscode.window.showWarningMessage(
            "過去の版への復元はブラウザ版では使えません。"
          );
          return;
        }
        const { restoreFromHistory } = await import(
          "./features/gitRestore.js"
        );
        await restoreFromHistory(work);
        // 原稿が入れ替わったので、文字数もハイライトも作り直す
        treeProvider.refresh(work.id);
        highlighter.invalidate();
        refreshActionBadges();
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.setupGithub",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        if (!canRunProcesses()) {
          vscode.window.showWarningMessage(
            "GitHub同期の設定はブラウザ版では使えません。"
          );
          return;
        }
        const { describeStatus } = await import("./features/gitSync.js");
        const { nextSetupStep, runSetupStep } = await import(
          "./features/gitOnboarding.js"
        );
        // **どこを1つの置き場にするかを先に決める**（設計書5.7.9）。
        // 既定は「1つのリポジトリに複数の作品」なので、隣に作品が並んで
        // いれば、まとめる側を先に出して選んでもらう
        const { resolveSyncTarget } = await import(
          "./features/resolveSyncTarget.js"
        );
        const target = await resolveSyncTarget(work, registry.list());
        if (!target) return;

        // 状態を見てから、足りない一手だけを案内する（設計書5.5.4）
        const { readSyncStatus } = await import("./core/git.js");
        const status = await readSyncStatus(target.folderPath);
        const step = nextSetupStep(status);
        if (!step) {
          vscode.window.showInformationMessage(
            `${describeSyncTarget(target)} の同期の準備はすでに整っています。${describeStatus(status)}`
          );
          return;
        }
        if (await runSetupStep(target, status)) {
          await gitSync.refresh(work, { fetch: true, notify: false });
        }
      }
    )
  );

  context.subscriptions.push(
    registerCommand("novelai.setupOllama", async () => {
      if (!canRunProcesses()) {
        vscode.window.showWarningMessage(
          "Ollamaの導入案内はブラウザ版では使えません（ローカルで動くAIのため）。"
        );
        return;
      }
      const { setupOllama } = await import("./features/setupOllama.js");
      await setupOllama(aiRegistry);
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.setupLmStudio", async () => {
      if (!canRunProcesses()) {
        vscode.window.showWarningMessage(
          "LM Studioの導入案内はブラウザ版では使えません（ローカルで動くAIのため）。"
        );
        return;
      }
      const { setupLmStudio } = await import("./features/setupLmStudio.js");
      await setupLmStudio(aiRegistry);
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.runFullSetup", async () => {
      if (!canRunProcesses()) {
        vscode.window.showWarningMessage(
          "この案内はブラウザ版では使えません。AI設定から個別に設定してください。"
        );
        return;
      }
      const { runFullSetup } = await import("./features/setupWizard.js");
      await runFullSetup(aiRegistry);
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.openChatLog",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        const file = chatLogPath(work);
        try {
          await vscode.workspace.fs.stat(path.toUri(file));
        } catch {
          // 無いことと、切ってあることを区別して伝える。
          // 「まだ相談していない」のか「記録していない」のかで対処が違う
          const message = isChatLogEnabled()
            ? "相談のログはまだない。「AIに相談」すると作られる。"
            : "相談のログを残さない設定（novelai.chatLog.enabled）。";
          vscode.window.showInformationMessage(message);
          return;
        }
        await vscode.commands.executeCommand(
          "vscode.open",
          path.toUri(file)
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand("novelai.setupVectorSearch", async () => {
      if (!canRunProcesses()) {
        vscode.window.showWarningMessage(
          "意味検索の設定はブラウザ版では使えません（ローカルで動くAIのため）。"
        );
        return;
      }
      const { setupVectorSearch } = await import(
        "./features/setupVectorSearch.js"
      );
      await setupVectorSearch();
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.showVersion", async () => {
      await showVersion(context, aiRegistry);
    })
  );

  // 使い方のマニュアル。**中身はメニューの定義から作る**ので、
  // 機能を足しても書き足す手間が要らない（features/openManual.ts）
  context.subscriptions.push(
    registerCommand("novelai.openManual", async () => {
      const { openManual } = await import("./features/openManual.js");
      await openManual();
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.chooseChatWork", async () => {
      await workChatPanel.chooseWork();
    })
  );

  // 簡単ステップメニューの最上段（作品選択窓）から呼ばれる。
  // **選ぶのはIDだけ**で、実在の確認は表示のたびにメニュー側が行う
  context.subscriptions.push(
    registerCommand("novelai.chooseStepWork", async () => {
      const works = registry.list();
      if (works.length === 0) {
        vscode.window.showInformationMessage("作品が登録されていません。");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [
          ...works.map((work) => ({
            // 長い作品名は省略し、全文は2行目（detail）に出す（2026-09-06）
            label: abbreviateTitle(work.title),
            description: work.folderPath,
            detail: isAbbreviated(work.title) ? work.title : undefined,
            work,
          })),
          // Escでも閉じられるが、それを知らない人には出口が無いように見える
          cancelItem(),
        ],
        { title: "簡単ステップメニューで使う作品" }
      );
      if (!picked || !("work" in picked)) return;
      stepProvider.selectWork(picked.work.id);
      // **末尾の件数は選んだ作品のもの**なので、切り替えたら数え直す
      // （そうしないと、前の作品の件数が並んだままになる）
      refreshActionBadges();
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.buildVectorIndex",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        if (!isVectorSearchEnabled()) {
          const open = "準備を開く";
          // **ボタンが押されるのを待たない**（ノートPCの実機、2026-09-23。
          // 抽出の完了の知らせと同じ直し）。待つと、知らせを閉じるまで
          // 索引づくりの「動いている」札を持ったままになる
          whenNoticePicked(
            vscode.window.showInformationMessage(
              "意味検索が「切」になっています。切のままでも相談は語句一致で場面を探すので、索引は要りません。",
              open
            ),
            async (picked) => {
              if (picked === open) {
                await vscode.commands.executeCommand("novelai.setupVectorSearch");
              }
            },
            { label: "検索用の索引", workFolder: work.folderPath }
          );
          return;
        }
        const result = await buildVectorIndex(work);
        if (!result) return;
        const size = (result.bytes / 1024 / 1024).toFixed(1);
        const head = result.cancelled ? "途中まで保存しました" : "索引ができました";
        vscode.window.showInformationMessage(
          `${head}：新しく${result.built}件、そのまま使えたもの${result.reused}件、` +
            `古くなって消したもの${result.removed}件（全${result.total}件・` +
            `${result.seconds.toFixed(0)}秒・${size}MB）`
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.clearVectorIndex",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        const yes = "削除する";
        const picked = await vscode.window.showWarningMessage(
          `「${work.title}」の検索用の索引を削除します。本文や設定資料は変わりません。`,
          { modal: true },
          yes
        );
        if (picked !== yes) return;
        await removeVectorIndex(work);
        notifyDone("索引を削除しました。");
      }
    )
  );

  context.subscriptions.push(
    registerCommand("novelai.openExtensionSettings", async () => {
      // この拡張機能の設定だけに絞る。VS Code全体の設定を開くと、
      // 作者は目的の項目にたどり着けない。
      //
      // **IDを書き下さない。** `local.novel-ai-assistant` と決め打ちして
      // あったが、Marketplaceへ出すために publisher を `nonahisa` へ
      // 変えたときに追随せず、**設定画面が空になっていた**
      // （2026-08-18、配布直前の統合テストで発覚）。
      // `context.extension.id` なら publisher が変わっても付いてくる
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${context.extension.id}`
      );
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.manageConfirmSkips", async () => {
      // 作品に紐づかない（覚え書きは環境ごとの設定）ので、作品は取らない
      await manageConfirmSkips();
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.renameWork", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry, {
        title: "名前を変える作品を選択",
      });
      if (!work) return;
      // 一覧の更新は `registry.onDidChange` が受け持つ（登録・解除と同じ）
      await renameWork(registry, work);
    })
  );

  context.subscriptions.push(
    /*
      **シリーズとしてつなぐ**（設計書6.95）。登録時の案内からも、
      作品を引数で受け取れるようにしてある（`WorkEntry` がそのまま渡る）。

      動的importにしているのは、隣のフォルダーを読むところまで抱えており、
      つながない作品では一度も要らないためである（`mergeIntoLibrary` と同じ）。
    */
    registerCommand("novelai.setSeries", async (node?: WorkNode | WorkEntry) => {
      const work =
        node && "folderPath" in node
          ? (node as WorkEntry)
          : await resolveWork(node as WorkNode | undefined, registry, {
              title: "シリーズをつなぐ作品を選択",
            });
      if (!work) return;
      const { setSeries } = await import("./features/setSeries.js");
      if (await setSeries(work)) {
        // 借りた語が変わるので、色分けの索引を作り直す
        highlighter.invalidate();
      }
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.removeWork",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        const answer = await vscode.window.showWarningMessage(
          `「${work.title}」の登録を解除しますか？\nフォルダとファイルは削除されません。`,
          { modal: true },
          "登録を解除"
        );
        if (answer !== "登録を解除") return;

        await registry.remove(work.id);
        treeProvider.refresh();
      }
    )
  );

  context.subscriptions.push(
    registerCommand("novelai.refresh", () => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.gitSync",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry, {
          title: "同期する作品を選択",
          // **一覧の印をそのまま使う。** この先の同期メニューは記録・送信・
          // 受け取りのどれにも進めるので、状態を丸ごと見せるのが合っている。
          // 言い回しを作り直さないので、作品一覧の印と読み合わせられる
          annotate: canRunProcesses()
            ? async (candidate) => {
                const status = gitSync.statusFor(candidate.id);
                return {
                  // gitを使っていない作品には何も出さない（印と同じ扱い）
                  note: describeSyncBadge(status),
                  order: hasPendingSync(status) ? 1 : 0,
                };
              }
            : undefined,
        });
        if (!work) return;
        if (!canRunProcesses()) {
          // 行き止まりにせず、VS Code のソース管理へ案内する（設計書5.8.9）
          const { showWebSyncGuide } = await import("./features/webSync.js");
          await showWebSyncGuide(work);
          return;
        }
        const { showGitSyncActions } = await import("./features/gitSync.js");
        await showGitSyncActions(gitSync as GitSyncMonitor, work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.resolveConflicts",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        if (!canRunProcesses() || !conflictProvider) {
          vscode.window.showWarningMessage(
            "競合の解決はブラウザ版では使えません。"
          );
          return;
        }
        const { resolveWorkConflicts } = await import(
          "./features/resolveConflicts.js"
        );
        await resolveWorkConflicts(work, { provider: conflictProvider });
        treeProvider.refresh(work.id);
      }
    )
  );

  // Gitの操作でファイルが入れ替わったら、走査結果と用語の索引を作り直す。
  // pullで大量に変わるため、変わったことに気づかないまま
  // 古い文字数・古いハイライトを見せ続けないようにする（設計書5.5.8）
  context.subscriptions.push(
    gitSync.onDidChangeFiles(({ work }) => {
      // **開いている設定資料パネルも読み直す**（0.45.0）。取り込みの最中は
      // 外部変更の知らせを止めている（設計書5.5.18）ので、ここで読み直さないと
      // 受け取った資料が画面に出ないまま、古い写しを見せ続ける
      void reloadAfterExternalChange(work);
      // 取り込んだ分は「この環境で書いた量」ではない。
      // 数えると同じ文章を2台ぶん数えることになるので、基準だけ置き直す
      void progress.rebaseline(work).then(() => updateStatusBar());
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.gitPull",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry, {
          title: "GitHubから受け取る作品を選択",
          annotate: canRunProcesses()
            ? async (candidate) => {
                const status = trackedSyncStatus(candidate.id);
                if (!status) return {};
                // **その作品ぶんの数を主に出す。** 書庫（1つの置き場に複数の
                // 作品）では `behind` が置き場ぜんぶの合計になり、全作品に
                // 同じ数字が並ぶ。作品一覧の印で実際に起きた失敗で
                // （11作品すべてに「送信待ち13」と出た）、いま直している
                // 「どれを選べばよいか分からない」と同じことになる
                if (status.behindHere > 0) {
                  return {
                    note:
                      `受け取り ${status.behindHere}件` +
                      (status.behind !== status.behindHere
                        ? `（置き場ぜんぶでは ${status.behind}件）`
                        : ""),
                    order: status.behindHere,
                  };
                }
                // 取り込みは置き場が単位なので、**この作品を選んでも
                // 他作品の分が入ってくる。** 「ありません」とだけ言うと、
                // 実際には取り込めることを隠すことになる
                if (status.behind > 0) {
                  return {
                    note: `この作品ぶんはありません（置き場ぜんぶでは受け取り ${status.behind}件）`,
                    order: 0,
                  };
                }
                return { note: "受け取るものはありません", order: 0 };
              }
            : undefined,
        });
        if (!work) return;
        if (!canRunProcesses()) {
          vscode.window.showWarningMessage(
            "GitHub同期はブラウザ版では使えません。"
          );
          return;
        }
        const { describeStatus } = await import("./features/gitSync.js");
        // 押した時点の状態で判断させるため、先に取得し直す
        const status = await gitSync.refresh(work, {
          fetch: true,
          notify: false,
        });
        if (status.kind !== "tracked" || status.behind === 0) {
          vscode.window.showInformationMessage(
            `${work.title}: ${describeStatus(status)}`
          );
          return;
        }
        await gitSync.pull(work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.gitPush",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry, {
          title: "GitHubへ送る作品を選択",
          annotate: canRunProcesses()
            ? async (candidate) => {
                const status = trackedSyncStatus(candidate.id);
                if (!status) return {};
                // 受け取り側と同じ理由で、その作品ぶんの数を主に出す
                return pushWaitingNote(status);
              }
            : undefined,
        });
        if (!work) return;
        if (!canRunProcesses()) {
          vscode.window.showWarningMessage(
            "GitHub同期はブラウザ版では使えません。"
          );
          return;
        }
        const { describeStatus } = await import("./features/gitSync.js");
        const status = await gitSync.refresh(work, {
          fetch: true,
          notify: false,
        });
        if (status.kind !== "tracked" || status.ahead === 0) {
          vscode.window.showInformationMessage(
            `${work.title}: ${describeStatus(status)}`
          );
          return;
        }
        await gitSync.push(work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.openWorkFolder",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        // ブラウザではOSのフォルダーを開けないので、
        // VS Code の中のエクスプローラーで見せる（設計書5.8.10）
        await revealFolder(work.folderPath);
      }
    )
  );


  context.subscriptions.push(
    registerCommand(
      "novelai.showWritingStats",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        // 「AIに助言をもらう」（設計書6.79.7.3）は相談と同じ割当・同じ助言方針を使う
        await openWritingStatsPanel(context, work, deviceId, {
          ai: aiRegistry,
          advicePolicies,
        });
      }
    )
  );

  context.subscriptions.push(
    registerCommand("novelai.showAllWorksWritingStats", async () => {
      await openAllWorksWritingStatsPanel(context, registry, deviceId);
    })
  );

  // 執筆再開支援と単話プロット（設計書6.36）。**どちらもAIを呼ばない**。
  // 再開の1枚は読むだけ、単話プロットは新規作成だけ（上書きしない）
  context.subscriptions.push(
    registerCommand("novelai.resumeWriting", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await resumeWriting(work, deviceId);
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.createEpisodePlot", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return CHECK_CANCELLED;
      await createEpisodePlot(work);
      return CHECK_COMPLETED;
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.addEpisode",
      async (node?: WorkNode | EpisodeNode) => {
        const work =
          node instanceof EpisodeNode
            ? node.work
            : await resolveWork(node as WorkNode | undefined, registry);
        if (!work) return;

        const config = await readWorkConfig(work);
        const p = workPaths(work, config);

        // 本文フォルダを持たない既存作品では、作品ルートへ話数を追加する
        const manuscriptDir = (await pathExists(p.manuscript))
          ? p.manuscript
          : p.root;

        const episodes = await treeProvider.getEpisodes(work);
        const parsed = episodes.map((e) =>
          parseEpisodeFileName(e.fileName)
        );
        const next = nextChapterNumber(parsed);

        const cfg = vscode.workspace.getConfiguration("novelai");
        const digits = cfg.get<number>("episodeNumberDigits", 3);
        const configuredExt = cfg.get<string>("episodeFileExtension", ".txt");

        // SNS記事は投稿日で管理する（設計書6.4.6）。**同じ日に何本でも書ける**ので、
        // 今日の日付が埋まっていれば `_2`, `_3` と番号を足す。
        // 創作メモ集は題名で並ぶ（設計書6.70）ので「無題」から始める
        const format = await readWorkFormat(work);
        // メモだけは `.md`（設計書6.70。設定は「原稿をどの形で書くか」の話）
        const ext = newEpisodeExtension(format, configuredExt);
        const defaultName =
          format === "sns"
            ? `${nextDatedName(parsed, statsDayKey(new Date(), boundaryHour()))}${ext}`
            : format === "memo"
              ? nextUntitledName(
                  episodes.map((e) => e.fileName),
                  "無題",
                  ext
                )
              : // 既存の話の名前の流儀に揃える（実機確認 2026-09-07）
                nextEpisodeFileNameLike({
                  latestFileName: findLatestEpisode(episodes)?.fileName ?? null,
                  number: next,
                  fallback: { digits, extension: ext },
                });
        const fileName = await askText({
          prompt:
            format === "sns"
              ? "新規投稿ファイルの名前"
              : format === "memo"
                ? "新規メモの名前（題名がそのままファイル名になります）"
                : "新規話数ファイルの名前",
          value: defaultName,
          valueSelection: [0, defaultName.length - ext.length],
          validateInput: (v) => {
            const t = v.trim();
            if (t.length === 0) return "ファイル名を入力してください";
            if (/[/\\:*?"<>|]/.test(t))
              return "ファイル名に使えない文字が含まれています";
            const e = path.extname(t).toLowerCase();
            if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(e))
              return "拡張子は .txt か .md にしてください";
            return null;
          },
        });
        if (!fileName) return;

        const filePath = path.join(manuscriptDir, fileName.trim());
        if (await pathExists(filePath)) {
          vscode.window.showErrorMessage(
            "同じ名前のファイルがすでに存在します。"
          );
          return;
        }

        await vscode.workspace.fs.writeFile(
          path.toUri(filePath),
          // 脚本だけは柱・ト書き・セリフの雛形から始める（設計書6.70）
          new TextEncoder().encode(newEpisodeTemplate(format))
        );

        treeProvider.refresh(work.id);
        // **執筆量の基準を置き直す**（設計書6.3.2）。記録は「ファイル数が
        // 変わった回は数えない」ので、置き直さないと、このあと作者が書いて
        // 保存した回がその決まりに当たり「今日 +0字」になって消える
        await progress.rebaseline(work);
        // **本文は原稿エディタで開く**（作者の指定、2026-08-29。作品一覧の
        // クリックと同じ既定に揃える）。向きはタイプで決まる（脚本は縦書き）
        await vscode.commands.executeCommand(
          "vscode.openWith",
          path.toUri(filePath),
          manuscriptViewTypeFor(format)
        );
      }
    )
  );

  // ─── AI関連コマンド ───

  context.subscriptions.push(
    registerCommand("novelai.setupAI", async () => {
      await runSetupWizard(aiRegistry);
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.assignFeatureAI", async () => {
      const { assignFeatureAI } = await import("./features/assignFeatureAI.js");
      await assignFeatureAI(aiRegistry);
    })
  );

  context.subscriptions.push(
    // AIチューニング（設計書6.27.11・6.49）。作品は要らない。
    //
    // **機能キーを受け取る。** 時間切れの通知から呼ばれたときは、その機能の
    // 割当先（設計書6.28.9）を測らないと、測ったAIと切れたAIが別物になる。
    // コマンドパレットからは引数なしで来るので、そのときは既定を測る
    registerCommand("novelai.measureContext", async (feature?: unknown, target?: unknown) => {
      const { askTuningScope, isMeasureTarget, measureContext } = await import(
        "./features/measureContext.js"
      );
      // **何を測るかを先に訊く**（作者の依頼、2026-09-13）。読める長さは
      // 数分だが、書ける長さは遅いモデルで1時間以上かかる。押した瞬間に
      // 両方始まる形だと、数分で済ませたい作者が1時間付き合わされる
      const scope = await askTuningScope();
      if (!scope) return;
      // **測定に作品は要らないが、ログの置き場所には要る**（設計書6.53）。
      // 出力パネルはVS Codeを閉じると消えるので、点滅や時間切れの原因を
      // 作者が後から追えるよう、`actions.log` にも残す。作品が決まらない
      // ときは保管庫へ倒す（`setFallbackLogRoot`）——書庫に作品が複数ある
      // 実機で、チューニングの記録が1行も残らなかった
      const logFolder = logTargetWorkFolder(registry);
      useLogFile(logFolder);
      /*
        **始まりと終わりを、呼ぶ側から残す。**

        測定の中身（判定・保存）は `features/measureContext.ts` の持ち物
        なので触らない。ここで要るのは「押したのに何も起きていないのか、
        まだ測っているのか」を後から見分けられることで、それは外側から
        1行ずつ書けば足りる。

        終わりの行は `finally` に置く。失敗や中止で抜けたときこそ
        「いつ終わったか」が要る（実機では反映待ちのダイアログに気づかず
        10分待った）。
      */
      logStep(`AIチューニング 開始（${describeTuningScope(scope)}）`);
      try {
        await measureContext(
          aiRegistry,
          isAssignableFeature(feature) ? feature : "default",
          logFolder,
          scope,
          // 確認画面の「この大きいモデルの速さを測る」から来たときだけ名指しがある
          // （A3④）。割当を変える前に測るため
          isMeasureTarget(target) ? target : undefined
        );
      } finally {
        useLogFile(logFolder);
        logStep("AIチューニング 終了");
      }
    })
  );

  context.subscriptions.push(
    // AIチューニングの実測一覧（作者の要望、2026-09-06）。
    // **測り直さない**ので、作品もAIの呼び出しも要らない
    registerCommand("novelai.showTuningStats", async () => {
      const { showTuningStats } = await import("./features/showTuningStats.js");
      await showTuningStats(aiRegistry);
    })
  );

  context.subscriptions.push(
    // 測った記録を、モデルごとに消す（作者の裁定、2026-09-18）。
    // 台帳を設定から保管庫のファイルへ移したぶん、**設定画面から
    // 消せなくなった**ので、消す口をこちらで持つ
    registerCommand("novelai.forgetTuning", async () => {
      const { forgetTuning } = await import("./features/forgetTuning.js");
      await forgetTuning(aiRegistry);
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.showLog", () => {
      showLog();
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.mergeIntoLibrary", async () => {
      const { mergeIntoLibrary } = await import(
        "./features/mergeIntoLibrary.js"
      );
      if (await mergeIntoLibrary(registry)) {
        treeProvider.refresh();
        highlighter.invalidate();
      }
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.diagnoseWeb", async () => {
      // 作品が登録されていればその中で試す。無ければ開いているフォルダーで
      const { diagnoseWeb } = await import("./features/diagnoseWeb.js");
      await diagnoseWeb(registry.list());
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.exportImeDictionary",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry, {
          title: "IME辞書を書き出す作品を選択",
          // **印は「何作品が古いか」しか言わない。** どの作品を書き出し直せば
          // よいのかは、選ぶ場面でしか分からなかった（作者の指摘、2026-08-27）。
          // 数え方は `ActionDecorationProvider` の staleImeDictionary と
          // 同じ式にする。別の式で見ると、印と内訳が食い違う
          annotate: async (candidate) => {
            try {
              const config = await readWorkConfig(candidate);
              const freshness = await checkDictionaryFreshness(
                workPaths(candidate, config).settings
              );
              return imeDictionaryNote(freshness);
            } catch {
              // 読めない作品は無印で返す。補足が出ないだけで実害はない
              return {};
            }
          },
        });
        if (!work) return;
        // 保管庫を渡すと、作者が外した語を覚えて次からも外したままにする
        await exportImeDictionary(work, context.globalState);
        // 書き出したので「辞書が古い」の印を消す。
        // 残ったままだと、押しても消えない印を作者が気にし続けることになる
        refreshActionBadges();
      }
    )
  );

  context.subscriptions.push(
    registerCommand("novelai.exportPdf", async (node?: WorkRef) => {
      // メニューでは灰色にしてあるが、コマンドパレットからは押せてしまう。
      // 理由を出して止める（`gitRestore` と同じ形）
      if (!canRunProcesses()) {
        void vscode.window.showWarningMessage(
          describeProcessesBlocked("novelai.exportPdf")
        );
        return;
      }
      const work = await resolveWork(node, registry, {
        title: "PDFにする作品を選択",
      });
      if (!work) return;
      await exportPdf(work);
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.exportEpub", async (node?: WorkRef) => {
      // **`canRunProcesses()` で止めない。** PDF出力は外のブラウザを
      // 起こすので手元のVS Codeが要るが、こちらは作品フォルダへ
      // ファイルを1つ書くだけで、ブラウザ版でも成立する
      const work = await resolveWork(node, registry, {
        title: "EPUBにする作品を選択",
      });
      if (!work) return;
      await exportEpub(work);
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.openEpubEditor", async (node?: WorkRef) => {
      // 書き出しと同じく、外のアプリを起こさないのでブラウザ版でも開ける
      const work = await resolveWork(node, registry, {
        title: "EPUBエディターで開く作品を選択",
      });
      if (!work) return;
      await openEpubEditorPanel(context, work);
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.manageCustomFields",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await manageCustomFields(work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.applyPendingUpdates",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry, {
          title: "更新分を反映する作品を選択",
          annotate: async (candidate) => {
            let count = 0;
            try {
              count = await new PendingUpdateStore(candidate).count();
            } catch {
              // 読めない作品は0件として扱う。補足が出ないだけ
            }
            return {
              note: count > 0 ? `未反映 ${count}件` : "未反映なし",
              order: count,
            };
          },
        });
        if (!work) return CHECK_CANCELLED;
        await applyPendingCharacterUpdates(work, proposalPanel);
        treeProvider.refresh(work.id);
        // 名前や別名が変われば、本文で光る範囲も変わる
        highlighter.invalidate();
        // 承認待ちが減ったので、操作メニューの件数を数え直す
        refreshActionBadges();
        return CHECK_COMPLETED;
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.unifyCharacters",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry, {
          title: "重複をまとめる作品を選択",
          // **印（例：13）は全作品の合計**なので、どの作品に何組あるかは
          // ここで出さないと分からない（作者の指摘、2026-08-27）。
          // 数え方は `ActionDecorationProvider` の mergeCandidates と
          // 同じ式にする。別の式で数えると、印の合計と内訳が食い違い、
          // どちらが正しいのか作者に判断できなくなる
          annotate: async (candidate) => {
            let count: number;
            try {
              const loaded = await new CharacterStore(candidate).loadAll();
              count = findMergeCandidates(loaded.characters).length;
            } catch {
              // **読めない作品は無印で返す。** ここで0組と同じ言葉を出すと、
              // 「候補が無い」のか「読み取りに失敗した」のかを作者が
              // 区別できなくなる。補足が出ないだけで実害はない
              return {};
            }
            // 0組の作品も選択肢に残す（消さずに案内する）。
            // **0組でも言葉にする。** 見本（承認待ちの「未反映なし」）と
            // 同じ流儀で、空白は「読めなかった」の意味に取っておく
            return {
              note:
                count > 0 ? `同じ人物とみられる組が ${count}組` : "重複の候補なし",
              order: count,
            };
          },
        });
        if (!work) return CHECK_CANCELLED;
        await unifyCharacterRecords(work);
        treeProvider.refresh(work.id);
        // まとめた側の名前は別名になる。索引を作り直さないと光らないままになる
        highlighter.invalidate();
        // 開いたままのパネルは自分では気づかない。
        // 消えたはずの人物が一覧に残り続ける
        await findOpenSettingsPanel(work.id)?.refreshFromDisk();
        refreshActionBadges();
        return CHECK_COMPLETED;
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.selectOllamaExecutable",
      async () => {
        if (!canRunProcesses()) {
          vscode.window.showWarningMessage(
            "Ollamaの選択はブラウザ版では使えません（ローカルで動くAIのため）。"
          );
          return;
        }
        const { selectOllamaExecutable } = await import(
          "./features/selectOllamaExecutable.js"
        );
        await selectOllamaExecutable();
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.openSettingsPanel",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;
        // **戻り値（画面そのもの）は結果ではない。** 開けたかどうかしか
        // 分からないので、済んだこととして返す
        await openSettingsPanel(context, work, aiRegistry);
        return CHECK_COMPLETED;
      }
    )
  );

  // 人物相関図（設計書6.38）。引数に人物を取れる——設定資料パネルの
  // 「相関図」は、この道を通ってその人を中心に開く
  context.subscriptions.push(
    registerCommand(
      "novelai.openRelationGraph",
      async (node?: WorkNode, characterId?: string) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await showRelationGraph(work, characterId);
      }
    )
  );

  // 年表（設計書6.39）。AIは使わない——材料はすべて既にある記録である
  context.subscriptions.push(
    registerCommand("novelai.openChronicle", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await showChronicle(work);
    })
  );

  /*
    シーンメモ（設計書6.40）。AIは使わない——材料は本文の中の付箋だけ。

    **「次へ」「戻る」はパネルが開いていなくても効く。** 作者がキー割当
    （VS Code の設定）だけで使う道であり、そのために画面を開かせない。
  */
  context.subscriptions.push(
    registerCommand("novelai.openSceneMemos", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await showSceneMemos(work);
    }),
    /*
      古い指摘を片づける（設計書6.96.4）。

      **期限切れは隠れているだけで、ファイルには在る。** 消えるのはここを
      押したときだけで、機械は勝手に消さない——時計のずれや、ノートPCを
      久しぶりに開いたときに、**作者が見る前に消える**のを防ぐため。
    */
    registerCommand("novelai.pruneFindings", async (node?: WorkNode) => {
      // 作品の右クリックからは、その作品だけ
      if (node && node.type === "work") return pruneFindings(node.work);
      const works = registry.list();
      if (works.length === 0) {
        vscode.window.showInformationMessage("作品が登録されていません。");
        return;
      }
      if (works.length === 1) return pruneFindings(works[0]);
      /*
        **メニューから押したときは、必ず訊く**（作者の依頼、2026-09-23
        「全作品を選択できるようにしてください」）。`resolveWork` は画面で
        指している作品があれば訊かずにそれを使うので、そのままでは
        「すべての作品」を選ぶ機会が来ない。消す操作なので、黙って
        1作品に決めないほうが安全でもある。
      */
      const target = await chooseFindingsTarget(works);
      if (!target) return;
      if (target === "all") return pruneFindingsAcrossWorks(works);
      return pruneFindings(target);
    }),
    registerCommand("novelai.nextSceneMemo", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await jumpSceneMemo(work, "next", sceneMemoDeps);
    }),
    registerCommand("novelai.prevSceneMemo", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await jumpSceneMemo(work, "prev", sceneMemoDeps);
    }),
    /*
      「ここにメモを足す」。

      **原稿エディタを先に見る。** あちらは `TextEditor` を持たないので
      `activeTextEditor` からは辿れない（見ているのが原稿エディタでも、
      素のエディタで開いた別のファイルが「作業中」として返る）。
    */
    registerCommand("novelai.addSceneMemo", async () => {
      if (await addMemoToOpenManuscript()) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage(
          "メモを足す本文を開いてから実行してください。"
        );
        return;
      }
      await insertMemoLineAbove(
        editor.document,
        editor.selection.active.line + 1
      );
    })
  );

  // 時期・系統を作る流れ（6.39.3）。年表の中からも同じ関数を呼ぶ
  context.subscriptions.push(
    registerCommand("novelai.editTimeline", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await editTimeline(work);
      // 開きっぱなしの年表が古いままでは、作った手応えがない
      await refreshChronicle(work.id);
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.generateSettingsDocs",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await generateSettingsDocs(work);
      }
    )
  );

  // 提供先を選んだ書き出し（設計書6.75）。全部入りとは別のファイルを作る
  context.subscriptions.push(
    registerCommand(
      "novelai.exportSettingsForAudience",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await exportSettingsForAudience(work);
      }
    )
  );

  // 種別ごとの書き出し。JSONを1種類だけ直したときに、
  // その一覧だけを作り直せるようにする
  for (const [command, kind] of [
    ["novelai.generateCharacterDocs", "characters"],
    ["novelai.generateLocationDocs", "locations"],
    ["novelai.generateAbilityDocs", "abilities"],
    ["novelai.generateWorldDocs", "world"],
  ] as const) {
    context.subscriptions.push(
      registerCommand(command, async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await generateSettingsDocs(work, { kinds: [kind] });
      })
    );
  }

  /**
   * 種別ごとのAI抽出。
   *
   * **AIへの問い合わせは絞らない。** 1回の応答に全種別が入っており、
   * 応答はチャンク単位でキャッシュされる。そのため「人物を抽出」の
   * あとに「場所を抽出」を実行してもAIは呼ばれず、同じ応答から
   * 場所を取り出して保存するだけになる（料金も待ち時間も増えない）。
   */
  for (const [command, kind, label] of [
    ["novelai.extractCharactersOnly", "characters", "人物"],
    ["novelai.extractLocationsOnly", "locations", "場所"],
    ["novelai.extractAbilitiesOnly", "abilities", "スキル"],
    ["novelai.extractOrganizationsOnly", "organizations", "組織"],
    ["novelai.extractWorldOnly", "world", "世界観"],
  ] as const) {
    context.subscriptions.push(
      registerCommand(command, async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        if (!(await saveDirtyDocumentsBeforeExtraction(work, `${label}の抽出`)))
          return;

        const saved = await extractCharacters(work, aiRegistry, {
          kinds: [kind],
          // 抽出後の「提案を見る」を提案パネルへ通す（設計書6.57.1）
          proposalPanel,
        });
        if (!saved) return;

        // 保存した種別の資料（Markdown）だけを作り直す
        await generateSettingsDocs(work, { kinds: [kind] });
        treeProvider.refresh(work.id);
        highlighter.invalidate();
        refreshActionBadges();
      })
    );
  }

  context.subscriptions.push(
    registerCommand("novelai.testAI", async () => {
      // 接続の確認は「AI設定で選んだAI」に対して行う。
      // 機能ごとの割当は、それぞれ割り当てるときに生成まで試している
      const resolved = aiRegistry.resolve("default");
      if (!resolved) {
        vscode.window.showInformationMessage(
          "AIが設定されていません。「AI設定」から設定してください。"
        );
        return;
      }
      const result = await withProgress("接続を確認しています…", () =>
        resolved.provider.testConnection()
      );
      if (!result.ok) {
        vscode.window.showErrorMessage(result.message);
        return;
      }

      // モデル一覧が引けても生成できるとは限らない。
      // 残高不足・権限不足は一覧では表に出ず、
      // 抽出を走らせたあとで初めて分かることになる（実際に起きた）
      const probe = await withProgress("実際に生成できるか試しています…", () =>
        probeGeneration(resolved.provider, resolved.model)
      );
      if (!probe.ok) {
        if (probe.error) {
          logFailure("AI接続の確認（生成の試行）", {
            種別: probe.error.kind,
            詳細: probe.error.detail,
            モデル: resolved.model,
          });
        }
        const action = await vscode.window.showErrorMessage(
          probe.message ?? "生成できませんでした。",
          "ログを表示",
          "閉じる"
        );
        if (action === "ログを表示") showLog();
        return;
      }

      const info = await aiRegistry.resolveModelInfo("default");
      const detail = info
        ? `${info.displayName}（${info.parameterSize ?? "?"} / 文脈 ${
            info.contextWindow
          }）`
        : resolved.model;
      vscode.window.showInformationMessage(
        `${result.message}\n使用中: ${detail}\n生成も確認しました。`
      );
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.extractSettings",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 保存の確認で「やめる」を選んだ回も取りやめである
        if (!(await saveDirtyDocumentsBeforeExtraction(work))) {
          return CHECK_CANCELLED;
        }

        const extracted = await extractCharacters(work, aiRegistry, {
          // 抽出後の「提案を見る」を提案パネルへ通す（設計書6.57.1）
          proposalPanel,
        });
        treeProvider.refresh(work.id);
        // 抽出で承認待ちが増えることがある。押さなくても気づけるよう数え直す
        refreshActionBadges();
        // 抽出で増えた用語を本文のハイライトへ反映する。
        // 設定JSONは拡張機能が直接書くのでエディタの保存イベントが起きず、
        // ここで作り直さないと再読み込みまで古い索引のままになる
        highlighter.invalidate();

        // 抽出したJSONから資料Markdownまで一度に作る。
        // 抽出結果の要約はすでに出しているので、成功は再通知しない。
        if (extracted) {
          await generateSettingsDocs(work, { silent: true });
          return CHECK_COMPLETED;
        }
        /*
          **抽出できなかった回を「済んだ」と言わない。** `extractCharacters`
          が返すのは真偽だけで、AIが未設定だったのか・確認で取りやめたのか・
          走って失敗したのかを見分けられない。**失敗と名乗る**——
          まとめ実行は失敗では止まらないので、残りの段はこれまでどおり走る。
          見分けが付くようにするのは、あちらの戻り値を変える別の作業である。
        */
        return CHECK_FAILED;
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.manageKeepWords",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;
        await manageKeepWords(work);
        return CHECK_COMPLETED;
      }
    )
  );

  /*
    作家タイプ診断と、はじめの案内（設計書6.90。作者の依頼 2026-09-13）。

    **6.86 とは別の診断である。** あちらは人柄（AIの言い方を変える）、
    こちらはやり方（はじめに案内する操作を変える）。AIは呼ばない——
    はじめて使う日に、AIの準備ができていなくても最後まで通れるようにしてある。
  */
  context.subscriptions.push(
    registerCommand("novelai.runWriterDiagnosis", async () => {
      const { runWriterDiagnosis } = await import(
        "./features/writerDiagnosis.js"
      );
      await runWriterDiagnosis(writerDiagnosisDeps());
    })
  );

  /**
   * 診断の画面へ渡すもの。**押せない案内を並べないため**に、
   * 作品があるかと、いまの助言方針を見せる
   */
  function writerDiagnosisDeps() {
    return {
      profiles: writerProfiles,
      hasWork: () => registry.list().length > 0,
      /*
        **9問の答えは、作者ごとの既定へ置く**（設計書6.90.2）。
        使用開始時にはまだ作品が1つも無いので、作品ごとの置き場には書けない。
        作品ができたら相談がここから始まる（`getEffective`）。
      */
      adviceDefault: {
        get: () => advicePolicies.getDefault(),
        set: (profile: AdviceProfile) => advicePolicies.setDefault(profile),
      },
    };
  }

  // 相談の助言方針（設計書6.86）。AIは呼ばない——答えるのは作者本人だけで、
  // 会話ログからの推定はしない
  context.subscriptions.push(
    registerCommand(
      "novelai.setAdvicePolicy",
      async (node?: WorkRef) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await setAdvicePolicy(work, advicePolicies);
      }
    )
  );

  /*
    作者自身の読者タイプ（設計書6.101）。AIは呼ばない——答えるのは作者本人。

    **作品を選ばせに行かない。** ここで保存するのは作者ごとの答えで、
    作品の情報ではない。作品が一つに定まるとき（節点から呼ばれた／
    登録が1作だけ）にだけ、その作品のターゲット読者と突き合わせて見せる。
    作品ごとの見え方は、ターゲット読者診断の紙のほうに出る。
  */
  context.subscriptions.push(
    registerCommand(
      "novelai.setAuthorReaderType",
      async (node?: WorkRef) => {
        const works = registry.list();
        const work =
          node && node.type === "work"
            ? node.work
            : works.length === 1
              ? works[0]
              : undefined;

        const { setAuthorReaderType } = await import(
          "./features/authorReaderTypeDiagnosis.js"
        );
        await setAuthorReaderType(authorReaderTypes, work);
      }
    )
  );

  // 伏線追跡（設計書6.35）。台帳と一覧・手で足す口・矛盾からの転送に加え、
  // 配置と回収の自動検知（P-25/P-26）。**検知は何も自動で保存しない**
  context.subscriptions.push(
    registerCommand(
      "novelai.openForeshadows",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await openForeshadows(work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.addForeshadow",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await addForeshadowByHand(work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.setForeshadowStatus",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await setForeshadowStatus(work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkForeshadows",
      async (node?: WorkNode, options?: CheckRunOptions) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う本文から伏線を拾ってしまう
        const unsaved = await saveBeforeCheck(work, "伏線の検知");
        if (unsaved) return unsaved;

        const suiteConfirmed = isSuiteConfirmed(options);
        // **まとめ実行が札を持っているなら、機能側は取らない**（設計書6.76）
        const suiteHoldsRun = isSuiteHoldingRun(options);
        // **範囲を選べるのは誤字脱字だけではない**（設計書6.8.7）
        const scope = await resolveCheckScope(work, "foreshadow", {
          suiteConfirmed,
        });
        if (!scope) return CHECK_CANCELLED;
        const result = await withPanelProgress(
          work,
          "伏線を検知",
          (onProgress) =>
            checkForeshadows(work, aiRegistry, {
              filePaths: scope.filePaths,
              onProgress,
              suiteConfirmed,
              suiteHoldsRun,
            })
        );
        if (!result || result.cancelled) return CHECK_CANCELLED;

        // **絞って見たときも「検知した」と記録する**（誤字脱字と同じ）
        await recordCheck(work, "foreshadow");

        showForeshadowCandidates(proposalPanel, work, result.candidates);

        const parts = [`候補 ${result.candidates.length}件`];
        if (result.duplicateCount > 0) {
          // 黙って落とすと「なぜ出ないのか」が分からない
          parts.push(`既に登録済み ${result.duplicateCount}件を除外`);
        }
        if (result.rejectedCount > 0) {
          // 本文に無い箇所を「引用」してくることがある
          parts.push(`本文と合わない候補 ${result.rejectedCount}件を除外`);
        }
        if (result.failedChunks > 0) {
          parts.push(`読み取れなかった ${result.failedChunks}件`);
        }
        // **本文を開けなかった話は黙らない。** その話だけ検知の対象から
        // 抜けているのに、作者には「何も無かった」と見える
        if (result.unreadableEpisodes > 0) {
          parts.push(`読めなかった話 ${result.unreadableEpisodes}件（ログ参照）`);
        }
        notifyRunCompletion({
          headline: `伏線の検知${describeChosenScope(scope.kind)}`,
          parts,
          failedCount: result.failedChunks,
          tail:
            result.candidates.length > 0
              ? "台帳へはまだ入れていません。 「提案」パネルで登録するものを選んでください。"
              : "",
        });
        return CHECK_COMPLETED;
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkForeshadowResolution",
      async (node?: WorkNode) => {
        /*
          **対になる `novelai.checkForeshadows` と流儀を揃えてある**
          （2026-09-21）。隣り合う機能なのにこちらだけ何も返さず、
          取りやめたことが呼んだ側へ伝わらなかった（設計書6.104）。
        */
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う本文で回収を判定してしまう
        if (
          !(await saveDirtyDocumentsBeforeExtraction(work, "伏線の回収の確認"))
        ) {
          return CHECK_CANCELLED;
        }

        const result = await withPanelProgress(
          work,
          "伏線の回収を確認",
          (onProgress) =>
            checkForeshadowResolution(work, aiRegistry, { onProgress }),
          "か所"
        );
        if (!result || result.cancelled) return CHECK_CANCELLED;

        showForeshadowResolutions(proposalPanel, work, result.proposals);

        const parts = [
          `未回収 ${result.openCount}件のうち、回収されたと読める ${result.proposals.length}件`,
        ];
        if (result.rejectedCount > 0) {
          parts.push(`本文と合わない ${result.rejectedCount}件を除外`);
        }
        if (result.failedChunks > 0) {
          parts.push(`読み取れなかった ${result.failedChunks}件`);
        }
        if (result.unreadableEpisodes > 0) {
          parts.push(`読めなかった話 ${result.unreadableEpisodes}件（ログ参照）`);
        }
        notifyRunCompletion({
          headline: "伏線の回収の確認",
          parts,
          failedCount: result.failedChunks,
          tail:
            result.proposals.length > 0
              ? "台帳はまだ変えていません。 「提案」パネルで確かめてから決めてください。"
              : "",
        });
        return CHECK_COMPLETED;
      }
    )
  );

  /*
    校正のまとめ実行（設計書6.80）。

    **ここでは処理を持たない。** 走らせるのは既にあるコマンドで、確認・
    見積もり・札・通知は各機能のものをそのまま通す。まとめ側が持つのは
    「どれを・どの順で」と「終わったあとの内訳」だけである。
  */
  context.subscriptions.push(
    registerCommand(
      PROOFREADING_SUITE_COMMAND,
      async (node?: WorkRef) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;
        await runProofreadingSuite(work, {
          memento: context.globalState,
          // 内訳は提案パネルの残り件数から数える（設計書6.37.3）。
          // 各機能の戻り値を覗くと、機能ごとに違う数え方を写すことになる
          remainingIn: (category) => proposalPanel.remainingIn(work, category),
          // 確認に出す量の見積もり。**取れなくても確認は出す**ので、
          // ここで失敗しても呼び出し側は止まらない
          estimate: (checks) => collectSuiteEstimate(work, aiRegistry, checks),
        });
        /*
          **まとめ実行そのものは、走り切ったことしか名乗れない。**
          中の1つ1つが取りやめられたかは `runProofreadingSuite` が
          内訳として作者へ出しており、戻り値では返ってこない。
          ここで作り直すと数え方が2通りになる（設計書6.80）。
        */
        return CHECK_COMPLETED;
      }
    )
  );

  /*
    新しい作品を、ひと通り仕上げる（作者の指示、2026-09-19）。

    **まとめ実行と同じで、ここでは処理を持たない。** 走らせるのは既にある
    コマンドで、確認・見積もり・札・通知は各機能のものをそのまま通す。
    まとめ側が持つのは「どの段を・どの順で」「既にある段を飛ばす判断」
    「終わったあとの1枚」だけである。
  */
  context.subscriptions.push(
    registerCommand(FINISH_NEW_WORK_COMMAND, async (node?: WorkRef) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await runFinishNewWork(work, {
        // 内訳は提案パネルの残り件数から数える（設計書6.37.3）
        remainingIn: (category) => proposalPanel.remainingIn(work, category),
        // 確認に出す量の見積もり。**取れなくても確認は出す**
        estimate: (steps) => collectFinishEstimate(work, aiRegistry, steps),
      });
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkTypos",
      async (node?: WorkNode, options?: CheckRunOptions) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う本文を検知してしまう
        const unsaved = await saveBeforeCheck(work, "誤字脱字の検知");
        if (unsaved) return unsaved;

        // **前回から書いた分だけに絞れる**（設計書6.8.7）。
        // 聞く意味があるときだけ聞く（一度も検知していない・全部が対象・
        // 1件も無い、のいずれでも聞かない）
        const suiteConfirmed = isSuiteConfirmed(options);
        // **まとめ実行が札を持っているなら、機能側は取らない**（設計書6.76）
        const suiteHoldsRun = isSuiteHoldingRun(options);
        const scope = await resolveTypoScope(work, { suiteConfirmed });
        if (!scope) return CHECK_CANCELLED;

        const result = await withPanelProgress(
          work,
          "誤字脱字を検知",
          (onProgress) =>
            checkTypos(work, aiRegistry, {
              filePaths: scope.filePaths,
              onProgress,
              suiteConfirmed,
              suiteHoldsRun,
            })
        );
        if (!result) return CHECK_CANCELLED;

        // **絞って見たときも「検知した」と記録する。**
        // 記録しないと、次回また同じ話が「前回から書いた分」に出る
        await recordCheck(work, "typo");

        const shown = proposalPanel.showResults(work, result.issues);
        reportTypoCheckResult(
          `誤字脱字検知${describeChosenScope(scope.kind)}`,
          result,
          shown
        );
        return CHECK_COMPLETED;
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkNotation",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う本文を数えてしまう
        const unsaved = await saveBeforeCheck(work, "表記ゆれの検知");
        if (unsaved) return unsaved;

        const result = await checkNotation(work);
        if (!result || result.cancelled) return CHECK_CANCELLED;
        // **0組のまま確定は「今回は揃えない」**（作者の実機報告、2026-09-05）。
        // 選択画面が既に理由を伝えているので知らせを重ねず、提案パネルも
        // 触らない。ただし止める意思ではないので、まとめ実行は次へ進む
        if (result.noGroupsChosen) return CHECK_COMPLETED;

        const shown = proposalPanel.showResults(work, result.issues, "表記ゆれ");

        /*
          **0組でも黙らない**（作者の報告、2026-08-21。「黙ると壊れていると
          受け取られる」）。ここは長く「知らせるものが無い」として打ち切って
          おり、相談パネルからの道だけが言い切っていた——同じ機能で言うことが
          違う状態だったので、**言い方の持ち主を `describeNotationResult` に
          一本化した**（設計書6.8.16）。

          件数は**提案パネルに残った数**を渡す。検知が作った数をそのまま
          言うと、前に適用済み・解消済みだったものまで数えて、パネルの
          見出しと食い違う（0.35.1でほかの検知に入れた数え方）。
        */
        vscode.window.showInformationMessage(
          describeNotationResult(result, shown)
        );
        return CHECK_COMPLETED;
      }
    )
  );

  /**
   * 名前の付け替え（設計書6.37.3）。
   *
   * **本文は提案パネル経由でしか書き換えない。** ここでするのは
   * 「置き換えの候補を作ってパネルへ渡す」ことと、資料の対応表を
   * 待ちとして覚えておくことだけである。
   */
  const runRenameFlow = async (
    work: WorkEntry,
    characterId?: string,
    suggested?: { name: string; reading?: string }
  ): Promise<void> => {
    // **待ちは作品ごとに1つしか持てない。** 黙って上書きすると、前の
    // 付け替えの資料が旧名のまま取り残され、対応表も消えて直しようがなくなる
    const waiting = loadPendingRename(context.workspaceState, work.id);
    if (waiting) {
      const answer = await vscode.window.showWarningMessage(
        `「${waiting.oldName}」→「${waiting.newName}」の資料への反映が、` +
          "まだ済んでいません。",
        {
          modal: true,
          detail:
            `この待ちは ${describeCreatedAt(waiting.createdAt)} に作りました。\n` +
            "新しい付け替えを作り終えると、この対応表は置き換わります" +
            "（前の付け替えは、資料に反映できなくなります）。\n" +
            "先に「名前の付け替えを資料にも反映」を実行することもできます。\n" +
            "ここで取りやめれば、いまの待ちはそのまま残ります。",
        },
        "破棄して新しく始める"
      );
      if (answer !== "破棄して新しく始める") return;
    }

    // 未保存のまま読むと、画面と違う本文を走査してしまう
    if (!(await saveDirtyDocumentsBeforeExtraction(work, "名前の付け替え"))) {
      return;
    }

    const result = await renameCharacter(work, {
      characterId,
      suggestedName: suggested?.name,
      suggestedReading: suggested?.reading,
    });
    if (!result) return;

    // 資料を直すのは本文の適用が終わってから。対応表をここで預かる
    await savePendingRename(context.workspaceState, work.id, result.pending);

    if (result.issues.length > 0) {
      proposalPanel.showResults(work, result.issues, "名前の付け替え");
    }
    vscode.window.showInformationMessage(
      result.issues.length > 0
        ? `本文の置き換え ${result.issues.length}件を提案パネルに出しました。` +
            "適用が済んだら「名前の付け替えを資料にも反映」を実行してください。"
        : "本文に置き換えるところはありませんでした。" +
            "「名前の付け替えを資料にも反映」で資料だけ直せます。"
    );
  };

  context.subscriptions.push(
    registerCommand("novelai.checkNames", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return CHECK_CANCELLED;
      await openNameCheckPanel(context, work, {
        registry: aiRegistry,
        // 「登場箇所」は提案パネルの「本文を見る」と同じ道を通す
        revealInManuscript: (filePath, line) =>
          manuscriptProvider.revealLine(filePath, line),
        startRename: (target, characterId, suggested) =>
          runRenameFlow(target, characterId, suggested),
      });
      return CHECK_COMPLETED;
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.renameCharacter", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await runRenameFlow(work);
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.applyRenameToRecords",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        const pending = loadPendingRename(context.workspaceState, work.id);
        if (!pending) {
          vscode.window.showInformationMessage(
            "待っている付け替えがありません。先に「名前を付け替える」を実行してください。"
          );
          return;
        }

        // **本文が残っているうちに資料だけ直すと、両者が食い違う。**
        // 止めはしないが、数を出してから決めてもらう
        const remaining = proposalPanel.remainingIn(work, "名前の付け替え");
        const answer = await vscode.window.showWarningMessage(
          `「${pending.oldName}」→「${pending.newName}」を資料にも反映します。`,
          {
            modal: true,
            detail:
              (remaining > 0
                ? `提案パネルに、まだ適用していない本文の置き換えが${remaining}件あります。\n`
                : // **0件は「全部当てた」とは限らない。** 提案パネルの一覧は
                  // 端末に残らないので、閉じて開き直すと0件になる
                  isFromEarlierSession(pending.createdAt)
                  ? "提案パネルの一覧は VS Code を閉じると消えます。" +
                    `この待ちは ${describeCreatedAt(pending.createdAt)} に作った` +
                    "ものなので、本文の適用が済んでいるか確かめてから進めてください。\n"
                  : "") +
              "人物・能力・場所・組織・世界観・プロット・あらすじ・伏線を直します。\n" +
              "作者メモ（authorNotes）と資料用の補足には触れません。\n" +
              "取り消しは Git の「復元」から行えます。",
          },
          "資料も直す"
        );
        if (answer !== "資料も直す") return;

        const result = await applyRenameToRecords(work, pending);
        // **直せなかったものが残っているうちは、待ちを消さない。** 消すと
        // 対応表ごと失われ、作者は同じ入力をやり直すしかなくなる。
        // 済んだ資料は二度目に当たらない（旧い名前がもう無い）ので、
        // 直してからもう一度実行すれば、残りだけが直る
        if (result.failures.length === 0) {
          await clearPendingRename(context.workspaceState, work.id);
        }

        highlighter.invalidate();
        treeProvider.refresh(work.id);
        refreshActionBadges();
        await refreshNameCheckPanel(work);
        // 開きっぱなしの相関図は、旧名のノードを出したままになる（6.38）
        await refreshRelationGraph(work.id);

        vscode.window.showInformationMessage(
          describeRenameRecordsResult(pending, result) +
            (result.failures.length > 0
              ? " 直してから、もう一度「名前の付け替えを資料にも反映」を" +
                "実行してください（対応表は預かったままにしてあります）。"
              : "")
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkDeviations",
      async (node?: WorkNode, options?: CheckRunOptions) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う本文を照らしてしまう
        const unsaved = await saveBeforeCheck(work, "プロット逸脱の検知");
        if (unsaved) return unsaved;

        // プロットが無いときの理由を受ける口（矛盾検知と同じ形。設計書6.80）
        let missing = "";
        let missingReason = "";
        const suiteConfirmed = isSuiteConfirmed(options);
        // **まとめ実行が札を持っているなら、機能側は取らない**（設計書6.76）
        const suiteHoldsRun = isSuiteHoldingRun(options);
        // **範囲を選べるのは誤字脱字だけではない**（設計書6.8.7）
        const scope = await resolveCheckScope(work, "deviation", {
          suiteConfirmed,
        });
        if (!scope) return CHECK_CANCELLED;
        const result = await withPanelProgress(
          work,
          "プロット逸脱を検知",
          (onProgress) =>
            checkDeviations(work, aiRegistry, {
              filePaths: scope.filePaths,
              onProgress,
              suiteConfirmed,
              suiteHoldsRun,
              noteMissing: (note, reason) => {
                missing = note;
                missingReason = reason ?? "";
              },
            }),
          "話"
        );
        // **「飛ばした」であって「失敗」ではない**（作者の指摘、2026-09-06）
        if (missing) return checkSkipped(missingReason, missing);
        if (!result || result.cancelled) return CHECK_CANCELLED;

        proposalPanel.showDeviations(work, result.issues);

        const parts = [`指摘 ${result.issues.length}件`];
        if (result.ungroundedCount > 0) {
          // 照らした先がプロットに無いものは、根拠を持たない指摘である
          parts.push(
            `プロットに無いものを引いた ${result.ungroundedCount}件を除外`
          );
        }
        if (result.failedChunks > 0) {
          parts.push(`読み取れなかった ${result.failedChunks}話`);
        }
        // **本文を開けなかった話は黙らない。** その話だけ検知の対象から
        // 抜けているのに、作者には「何も無かった」と見える
        if (result.unreadableEpisodes > 0) {
          parts.push(`読めなかった話 ${result.unreadableEpisodes}件（ログ参照）`);
        }
        // **プロットを切ったことも黙らない**（設計書6.77の第2段）。
        // 末尾を落として問うたのに、作者からは「そこには指摘が無かった」と
        // 見える。検知の中で**一度だけ**組み立てた案内をそのまま出す
        if (result.plotTrimmedNote) parts.push(result.plotTrimmedNote);

        // **絞って見たときも「検知した」と記録する**（誤字脱字と同じ）
        await recordCheck(work, "deviation");

        notifyRunCompletion({
          headline: `プロット逸脱の検知${describeChosenScope(scope.kind)}`,
          parts,
          failedCount: result.failedChunks,
          tail:
            result.issues.length > 0
              ? "本文は書き換えていません。 プロットのほうが古いこともあります。"
              : "",
        });
        return CHECK_COMPLETED;
      }
    )
  );

  /**
   * 単話プロットのAI判定2種（P-27・P-28、設計書6.36.3）。
   *
   * **入口は1つにまとめる。** どの話の、どちらの判定かは
   * `pickEpisodePlotTarget` が決める——プロットモードの一覧から来たときは
   * 両方分かっているので訊き返さず、単話プロットを開いた状態の右クリック
   * からはファイル名で話数が分かる。
   */
  context.subscriptions.push(
    registerCommand("novelai.checkEpisodePlot", async (arg?: unknown) => {
      const ref = asEpisodePlotRef(arg);
      // 開いているファイルが単話プロットなら、その話数を使う
      // （右クリック・コマンドパレットのどちらから来ても同じ）
      const uri =
        arg instanceof vscode.Uri
          ? arg
          : vscode.window.activeTextEditor?.document.uri;
      const openedPath = uri ? fromUri(uri) : undefined;
      const openedChapter = openedPath
        ? episodePlotChapterOfPath(openedPath)
        : null;

      const work =
        ref?.work ??
        (openedPath ? inferredWorkOfPath(registry, openedPath) : undefined) ??
        (await resolveWork(
          arg instanceof vscode.Uri ? undefined : (arg as WorkRef | undefined),
          registry
        ));
      if (!work) return;

      const target = ref
        ? { chapter: ref.chapter, check: ref.check }
        : await pickEpisodePlotTarget(work, {
            ...(openedChapter === null ? {} : { chapter: openedChapter }),
          });
      if (!target) return;

      if (target.check === "design") {
        // **本文は読まないが、単話プロットは読む。** 書きかけのまま
        // 走らせると、画面と違う箇条書きを送ることになる
        if (
          !(await saveDirtyDocumentsBeforeExtraction(
            work,
            "単話プロットの検査"
          ))
        ) {
          return;
        }
        const result = await withPanelProgress(
          work,
          "単話プロットを検査",
          (onProgress) =>
            checkEpisodePlotDesign(work, target.chapter, aiRegistry, {
              onProgress,
            }),
          "件"
        );
        if (!result || result.cancelled) return;

        proposalPanel.showEpisodePlotFindings(
          work,
          result.plotPath,
          result.findings
        );
        // 空の節があると、見られる観点が減る。**黙って減らさない**
        const parts = episodePlotCompletionParts({
          findings: result.findings.length,
          rejectedCount: result.rejectedCount,
          rejectSummary: result.rejectSummary,
          blanks: result.blanks,
        });
        notifyRunCompletion({
          headline: `${result.chapterLabel}の単話プロットの検査`,
          parts,
          failedCount: result.failed ? 1 : 0,
          tail:
            result.findings.length > 0
              ? "プロットは書き換えていません。 直すかどうかは作者が決めます。"
              : "",
        });
        return;
      }

      if (
        !(await saveDirtyDocumentsBeforeExtraction(
          work,
          "単話プロットと本文の照合"
        ))
      ) {
        return;
      }
      const result = await withPanelProgress(
        work,
        "本文と単話プロットを照合",
        (onProgress) =>
          contrastEpisodePlot(work, target.chapter, aiRegistry, { onProgress }),
        "件"
      );
      if (!result || result.cancelled) return;

      proposalPanel.showEpisodePlotContrast(
        work,
        result.plotPath,
        result.episodePath,
        result.findings
      );
      // **切った後ろは見ていない。** 0件を「食い違いなし」と読ませない
      const parts = episodePlotCompletionParts({
        findings: result.findings.length,
        rejectedCount: result.rejectedCount,
        rejectSummary: result.rejectSummary,
        droppedChars: result.droppedChars,
      });
      notifyRunCompletion({
        headline: `${result.chapterLabel}の本文と単話プロットの照合`,
        parts,
        failedCount: result.failed ? 1 : 0,
        tail:
          result.findings.length > 0
            ? "本文もプロットも書き換えていません。 箇条書きのほうが古いこともあります。"
            : "",
      });
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkProofread",
      async (node?: WorkNode, options?: CheckRunOptions) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う本文を推敲してしまう
        const unsaved = await saveBeforeCheck(work, "推敲");
        if (unsaved) return unsaved;

        const suiteConfirmed = isSuiteConfirmed(options);
        // **まとめ実行が札を持っているなら、機能側は取らない**（設計書6.76）
        const suiteHoldsRun = isSuiteHoldingRun(options);
        // **範囲を選べるのは誤字脱字だけではない**（設計書6.8.7）
        const scope = await resolveCheckScope(work, "proofread", {
          suiteConfirmed,
        });
        if (!scope) return CHECK_CANCELLED;
        const result = await withPanelProgress(work, "推敲", (onProgress) =>
          checkProofread(work, aiRegistry, {
            filePaths: scope.filePaths,
            onProgress,
            suiteConfirmed,
            suiteHoldsRun,
          })
        );
        if (!result || result.cancelled) return CHECK_CANCELLED;

        // **絞って見たときも「検知した」と記録する**（誤字脱字と同じ）
        await recordCheck(work, "proofread");

        const shown = proposalPanel.showResults(work, result.issues, "推敲");

        // **誤字脱字と同じ数え方にする**（設計書6.8）。前に適用済み・
        // 解消済みだったものを「指摘」に数えると、パネルの見出しと食い違う。
        /*
          **落とした総数も、誤字脱字と同じ関数に言わせる**（0.75.4）。

          以前はここだけ `rejected: 0` を渡し、落とした件数を
          「AIの指摘のうち ◯件を落とした」と直書きしていた。同じことを
          言うのに**推敲だけ言い方が違う**うえ、数え方を直すときに
          ここが取り残される（誤字脱字・矛盾・伏線は
          `describeCheckRunCounts` を通る）。

          落とした総数を出す理由は変わらない（作者の裁定、2026-09-12）
          ——黙ると、**製品が何件捨てたのかを作者が知る手立てが無い**。
          総数を先に出し、下の3行は「うち」を付けて**内数だと分かる**ようにする。
          理由の内訳までは出さない（調べたいときは操作ログにある）。
        */
        const parts = describeCheckRunCounts({
          shown: shown.remaining,
          alreadyHandled: shown.handled,
          rejected: result.rejectedCount,
        });
        if (result.overBudgetCount > 0) {
          // 黙って絞ると「これで全部」と受け取られる
          parts.push(`うち多すぎたぶん ${result.overBudgetCount}件を絞り込み`);
        }
        if (result.monotonyDroppedCount > 0) {
          // AIの「〜た。が5連続」を数え直して外したぶん（2026-09-04）
          parts.push(`うち語尾の数え違い ${result.monotonyDroppedCount}件`);
        }
        if (result.monotonyMergedCount > 0) {
          // 同じ並びに何枚も出ていたぶん（2026-09-05）。黙って減らさない
          parts.push(
            `うち語尾単調の同じ連続 ${result.monotonyMergedCount}件をまとめた`
          );
        }
        if (result.failedChunks > 0) {
          parts.push(`読み取れなかった ${result.failedChunks}件`);
        }
        /*
          **ひらいた語は、作品の中でゆらぐ**（作者の裁定、2026-09-17）。

          推敲は箇所ごとの提案なので、同じ「丁度」でも採った箇所だけが
          ひらがなになる。その受け皿が表記ゆれ検知で、あちらは
          **漢字とかなの2通りが本文に出ている組だけ**を拾う——つまり
          推敲で1件でも採った時点で、作品全体を揃えられる状態になる。

          知らせるのは漢字ひらきの指摘が出たときだけ。無いときに出すと、
          関係のない案内が毎回付いてくることになる。
        */
        const openedKanji = result.issues.some(
          (issue) => issue.reason === "漢字ひらき"
        );
        notifyRunCompletion({
          headline: `推敲${describeChosenScope(scope.kind)}`,
          parts,
          failedCount: result.failedChunks,
          tail: openedKanji
            ? "ひらいた語は、表記ゆれ検知で作品全体を揃えられます。"
            : "",
        });
        return CHECK_COMPLETED;
      }
    )
  );

  /*
    ターゲット読者診断（設計書6.91。作者の依頼、2026-09-13）。

    **作家タイプ診断（6.90）と対になる。** あちらは作者ごと・AIなし、
    こちらは**作品ごと**で、宣言（9問・AIなし）と実像（本文から読む・
    AIを使う）の2階建てである。作品を選ばせるので、作品一覧の節点からも
    詳細メニューからも入れる。
  */
  context.subscriptions.push(
    registerCommand(
      "novelai.runReaderTargetDiagnosis",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        // **結末を名乗って返す**（0.74.12）。手順書きの段になったので、
        // 「画面で案内してもらう」が次へ進んでよいかを判断できる必要がある
        if (!work) return CHECK_CANCELLED;

        const { runReaderTargetDiagnosis } = await import(
          "./features/readerTargetDiagnosis.js"
        );
        // 作者自身の読者タイプ（6.101）を渡す。**未診断なら undefined** で、
        // そのときは紙の突き合わせの節がまるごと出ない（推測で埋めない）
        return runReaderTargetDiagnosis(
          work,
          aiRegistry,
          authorReaderTypes.get()
        );
      }
    )
  );

  /*
    ターゲットシート（設計書6.108）。**AIを呼ばない**——狙い（作者が
    手で書く欄）と、読者像の台帳にある点数だけで組む。

    **結末を名乗って返す**——手順書きの段（`core/procedures.ts`）なので、
    読者像が無くて止めたときに「画面で案内してもらう」が先へ進むと、
    作ってもいない紙を案内することになる。
  */
  context.subscriptions.push(
    registerCommand("novelai.openTargetSheet", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return CHECK_CANCELLED;

      const { openTargetSheet } = await import("./features/targetSheet.js");
      const opened = await openTargetSheet(work);
      return opened ? CHECK_COMPLETED : CHECK_CANCELLED;
    })
  );

  /*
    3つの輪（設計書6.101）。**AIを呼ばない**——材料はどれも既にある
    台帳と実績から取る。**原稿も台帳も書き換えない**（書くのは
    `.aiwriter/generated/` の紙1枚だけ）。

    作家タイプ（6.86）と作者自身の読者タイプ（6.101の1）は保管庫にある
    ので、ここで渡す。**未診断なら undefined** で、そのときは紙の側が
    その行と辺をまるごと落とす（推測で埋めない）。
  */
  context.subscriptions.push(
    registerCommand("novelai.showThreeCircles", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;

      const { showThreeCircles } = await import("./features/threeCircles.js");
      await showThreeCircles(work, deviceId, {
        authorReader: authorReaderTypes.get(),
        advice: advicePolicies.getEffective(work.id),
      });
    })
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkOpening",
      async (node?: WorkNode, options?: CheckRunOptions) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う冒頭を診断してしまう
        const unsaved = await saveBeforeCheck(work, "冒頭診断");
        if (unsaved) return unsaved;

        // **まとめ実行の印を受け取る**（設計書6.80）。受けないと、
        // 「校正の段では確認は出しません」と言った先で確認が出て、
        // 画面を離れた作者を待たせたまま止まる（2026-09-19の実機）。
        // 札は取らない機能なので `suiteHoldsRun` は渡さない
        const suiteConfirmed = isSuiteConfirmed(options);

        // **完了の通知を出さない。** 結果そのものが文書として開くので、
        // 「できました」を重ねると画面の手前に確認が1枚増えるだけになる
        return await checkOpening(work, aiRegistry, { suiteConfirmed });
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkContradictions",
      async (node?: WorkNode, options?: CheckRunOptions) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う本文を突き合わせてしまう
        const unsaved = await saveBeforeCheck(work, "矛盾検知");
        if (unsaved) return unsaved;

        // **前提が無くて走れなかった理由を受ける**（設計書6.80）。まとめ実行
        // では警告のダイアログを出す場が無いので、理由を持ち帰って最後の
        // まとめへ並べる。この口を足すのはコマンドの側である
        let missing = "";
        let missingReason = "";
        const suiteConfirmed = isSuiteConfirmed(options);
        // **まとめ実行が札を持っているなら、機能側は取らない**（設計書6.76）
        const suiteHoldsRun = isSuiteHoldingRun(options);
        // **範囲を選べるのは誤字脱字だけではない**（設計書6.8.7）。
        // 219話で6時間かかる検知こそ、「まず10話だけ試す」が要る
        const scope = await resolveCheckScope(work, "contradiction", {
          suiteConfirmed,
        });
        if (!scope) return CHECK_CANCELLED;
        /*
          **読み方を選ぶ**（作者の裁定 A3⑤、2026-09-23）。分けて読む矛盾検知は
          そのまま残り、まるごと読むのは並ぶ別の選択肢。**まとめ実行では訊かない**
          （これまでどおり分けて読む。画面を離れた作者を待たせない）
        */
        const readMode = suiteConfirmed
          ? "chunked"
          : await pickContradictionReadMode();
        if (!readMode) return CHECK_CANCELLED;
        const result = await withPanelProgress(
          work,
          "矛盾を検知",
          (onProgress, stage) =>
            checkContradictions(work, aiRegistry, {
              filePaths: scope.filePaths,
              readMode,
              onProgress,
              // 検証はAIを1件ずつ呼ぶので、別の札で件数を流す
              onVerifyProgress: stage("検出した矛盾を検証", "件"),
              suiteConfirmed,
              suiteHoldsRun,
              noteMissing: (note, reason) => {
                missing = note;
                missingReason = reason ?? "";
              },
            })
        );
        // **中止ではなく「飛ばした」にする。** 残りの検知はこの前提を
        // 要らないので、ここで列を止めると関係のない機能まで走らずに終わる。
        // 「失敗」とも言わない——壊れてはおらず、設定資料を足せば走る
        if (missing) return checkSkipped(missingReason, missing);
        if (!result || result.cancelled) return CHECK_CANCELLED;

        // 矛盾が実は伏線だったときの逃げ道を添える（設計書6.35.4）
        const shown = proposalPanel.showContradictions(
          work,
          result.issues,
          (source) => registerForeshadowFromContradiction(work, source)
        );

        // **誤字脱字と同じ数え方にする**（設計書6.8）。捨てたぶんは、
        // すぐ下に元からある言い方（「本文と合わない指摘」）をそのまま使う
        const parts = describeCheckRunCounts({
          shown: shown.remaining,
          alreadyHandled: shown.handled,
          rejected: 0,
        });
        if (result.rejectedCount > 0) {
          // 本文に無い箇所を「引用」してくることがある。黙って捨てない
          parts.push(`本文と合わない指摘 ${result.rejectedCount}件を除外`);
        }
        // **検証で消したことを黙らない**（設計書6.10.5）。内訳が見えないと、
        // 指摘が少ないのが「本当に無い」のか「消しすぎ」なのか分からない
        if (result.verifyNote) parts.push(result.verifyNote);
        if (result.failedChunks > 0) {
          parts.push(`読み取れなかった ${result.failedChunks}件`);
        }
        // **本文を開けなかった話は黙らない。** その話だけ検知の対象から
        // 抜けているのに、作者には「何も無かった」と見える
        if (result.unreadableEpisodes > 0) {
          parts.push(`読めなかった話 ${result.unreadableEpisodes}件（ログ参照）`);
        }
        // **絞って見たときも「検知した」と記録する。** 記録しないと、
        // 次回また同じ話が「前回から書いた分」に出る
        await recordCheck(work, "contradiction");

        notifyRunCompletion({
          headline: `矛盾検知${describeChosenScope(scope.kind)}`,
          parts,
          failedCount: result.failedChunks,
          // **突き合わせなかった人物があることを黙らない**（設計書6.10.6）。
          // 結果は「矛盾なし」と出るので、これが無いと作者には
          // 「見て問題が無かった」と区別が付かない。落ちた話が0なら空文字
          tail: [
            result.missedNote,
            result.issues.length > 0
              ? "本文は書き換えていません。 設定と本文のどちらを直すかは作者が決めてください。"
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        });
        return CHECK_COMPLETED;
      }
    )
  );

  /*
    矛盾検知（事実の照合。設計書6.88の第4段）。

    **「矛盾を検知」（P-12）とは別のコマンドにする。** 作者の裁定で
    しばらく並行させるので、片方を押したときにもう片方が動くと
    見比べられない。結果の置き場（提案パネルの分類）も別である。
  */
  context.subscriptions.push(
    registerCommand(
      "novelai.checkFactContradictions",
      async (node?: WorkNode, options?: CheckRunOptions) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う本文から事実を抜いてしまう
        const unsaved = await saveBeforeCheck(work, "矛盾検知（事実の照合）");
        if (unsaved) return unsaved;

        const result = await withPanelProgress(
          work,
          "本文から事実を取り出し",
          (onProgress, stage) =>
            checkFactContradictions(work, aiRegistry, {
              onProgress,
              // 判定はAIを1件ずつ呼ぶので、別の札で件数を流す
              onVerifyProgress: stage("見つかった候補を確かめ", "件"),
              suiteConfirmed: isSuiteConfirmed(options),
              suiteHoldsRun: isSuiteHoldingRun(options),
            })
        );
        if (!result || result.cancelled) return CHECK_CANCELLED;

        const shown = proposalPanel.showFactContradictions(work, result.issues);

        const parts = describeCheckRunCounts({
          shown: shown.remaining,
          alreadyHandled: shown.handled,
          rejected: 0,
        });
        // **どの工程で減ったのかを黙らない**（設計書6.88.1）。この道は
        // 抽出→検算→機械照合→判定の4工程があり、内訳が無いと
        // 「何も出ない」の原因をどこに探せばよいか分からない
        parts.push(`本文から取り出した事実 ${result.acceptedFacts}件`);
        if (result.rejectedFacts > 0) {
          parts.push(
            `読み取れなかった事実 ${result.rejectedFacts}件（${result.rejectionNote}）`
          );
        }
        parts.push(
          result.candidateCount > 0
            ? `機械が挙げた候補 ${result.candidateCount}件（${result.candidateNote}）`
            : "機械が挙げた候補 0件"
        );
        if (result.verifyNote) parts.push(result.verifyNote);
        if (result.failedChunks > 0) {
          parts.push(`読み取れなかった ${result.failedChunks}件`);
        }
        // **本文を開けなかった話は黙らない。** その話だけ対象から抜けている
        if (result.unreadableEpisodes > 0) {
          parts.push(`読めなかった話 ${result.unreadableEpisodes}件（ログ参照）`);
        }
        notifyRunCompletion({
          headline: "矛盾検知（事実の照合）",
          parts,
          failedCount: result.failedChunks,
          tail:
            result.issues.length > 0
              ? "本文は書き換えていません。 どちらを直すかは作者が決めてください。"
              : "",
        });
        return CHECK_COMPLETED;
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkTyposForFile",
      async (node?: EpisodeNode) => {
        if (!node) return;
        const work = node.work;

        // 未保存のまま読むと、画面と違う本文を検知してしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "誤字脱字の検知")))
          return;

        const result = await withPanelProgress(
          work,
          "誤字脱字を検知",
          (onProgress) =>
            checkTypos(work, aiRegistry, {
              filePaths: [node.episode.filePath],
              onProgress,
            })
        );
        if (!result) return;

        const shown = proposalPanel.showResults(work, result.issues);
        reportTypoCheckResult(
          `${node.episode.fileName} の誤字脱字検知`,
          result,
          shown
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.deleteEpisodeFile",
      async (node?: EpisodeNode) => {
        if (!node) return;

        // 削除は取り消せない操作の入口なので、ごみ箱経由にしたうえで
        // 未保存の変更があれば併せて捨てられる旨を伝える
        const dirtyNote = hasUnsavedChanges(node.episode.filePath)
          ? "未保存の変更も破棄されます。"
          : "";
        const answer = await vscode.window.showWarningMessage(
          `${node.episode.fileName} を削除しますか？`,
          {
            modal: true,
            detail: `ごみ箱に移動します。元に戻すことができます。${dirtyNote}`,
          },
          "削除する"
        );
        if (answer !== "削除する") return;

        try {
          await vscode.workspace.fs.delete(
            path.toUri(node.episode.filePath),
            { useTrash: true }
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `削除できませんでした: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return;
        }
        treeProvider.refresh(node.work.id);
        notifyDone(
          `${node.episode.fileName} を削除しました。`
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.generateSynopses",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;

        // 未保存のまま読むと、画面と違う本文からあらすじを作ってしまう。
        // 保存の確認で「やめる」を選んだ回も取りやめである
        if (!(await saveDirtyDocumentsBeforeExtraction(work))) {
          return CHECK_CANCELLED;
        }

        const generated = await generateSynopses(work, aiRegistry);
        // サブタイトルの承認でファイル名が変わることがある
        treeProvider.refresh(work.id);

        // JSONのままでは作者が読めない。読める資料まで作って初めて完成する
        if (generated) {
          await generateSettingsDocs(work, { silent: true });
          return CHECK_COMPLETED;
        }
        // **作れなかった回を「済んだ」と言わない。** `generateSynopses` が
        // 返すのは真偽だけで、形式が合わなかったのか・AIが未設定だったのか・
        // 走って失敗したのかを見分けられない（`extractSettings` と同じ）
        return CHECK_FAILED;
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.openSynopsisDocs",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 紹介文と各話あらすじは1つの文書（設定/synopsis.md）にまとめている。
        // 中身は独立しているので、**それぞれ在るか無いかを別々に見て伝える**。
        // 以前は在るファイルだけを並べており、片方しか無いと黙ってそれを開いて
        // いたため「紹介文がのっていません」と見えていた（実機で発覚、2026-08-14）
        const config = await readWorkConfig(work);
        const settingsDir = workPaths(work, config).settings;
        const file = path.join(settingsDir, SYNOPSIS_FILE);

        let hasBlurb = false;
        try {
          const bytes = await vscode.workspace.fs.readFile(
            path.toUri(file)
          );
          hasBlurb = Boolean(
            parseSynopsisMarkdown(new TextDecoder().decode(bytes)).blurb.trim()
          );
        } catch {
          hasBlurb = false;
        }

        let hasEpisodes = false;
        try {
          hasEpisodes =
            (await new SynopsisStore(work).load()).episodes.length > 0;
        } catch {
          hasEpisodes = false;
        }

        type ViewerItem = vscode.QuickPickItem & {
          run: () => Thenable<unknown>;
        };
        const items: ViewerItem[] = [];

        if (hasBlurb || hasEpisodes) {
          const contains = [
            hasBlurb ? "作品紹介文" : "",
            hasEpisodes ? "各話あらすじ" : "",
          ].filter(Boolean);
          items.push({
            label: "$(book) 開いて読む",
            description: "synopsis.md",
            detail: `${contains.join("と")}が入っています。`,
            // **どのエディターで開くかは決め打ちしない。** `vscode.open` なら
            // 作者がVS Codeの「既定のエディター」に設定したもの（テキスト
            // エディター／Markdown Preview／Markdown Editor）で開く
            run: () =>
              vscode.commands.executeCommand(
                "vscode.open",
                path.toUri(file)
              ),
          });
        }

        // **コマンド経由で呼ばない。** ここでは作品が決まっているのに、
        // コマンドは引数無しだと作品選択からやり直させてしまう
        if (!hasBlurb) {
          items.push({
            label: "$(add) 作品紹介文を作る",
            description: "まだありません（AIを使います）",
            detail:
              "投稿サイトに載せる紹介文。案を見てから採用を決められます。",
            run: () => generateWorkBlurb(work, aiRegistry),
          });
        }
        if (!hasEpisodes) {
          items.push({
            label: "$(add) 各話あらすじを作る",
            description: "まだありません（AIを使います）",
            detail: "話ごとに150字以内のあらすじを作り、この文書へ載せます。",
            run: () => generateSynopses(work, aiRegistry),
          });
        }

        const missing = [
          hasBlurb ? "" : "作品紹介文",
          hasEpisodes ? "" : "各話あらすじ",
        ].filter(Boolean);
        const picked = await vscode.window.showQuickPick(
          [...items, cancelItem()],
          {
            title: `${work.title} の紹介文・あらすじ`,
            placeHolder:
              missing.length === 0
                ? "開くものを選んでください"
                : `${missing.join("・")}はまだありません`,
          }
        );
        if (!picked || !("run" in picked)) return;
        await picked.run();
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.generateWorkBlurb",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;
        await generateWorkBlurb(work, aiRegistry);
        return CHECK_COMPLETED;
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.generateCatchphrases",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return CHECK_CANCELLED;
        await generateCatchphrases(work, aiRegistry);
        return CHECK_COMPLETED;
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.generateAnnouncement",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await generateAnnouncement(work, aiRegistry);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.configureAnnouncement",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await configureAnnouncement(work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand("novelai.addRuby", addRuby),
    registerCommand("novelai.addEmphasis", addEmphasis),
    // **貼り付け先は1度だけ訊く**（設計書6.12.4）。登録済みの投稿先を
    // 先頭に並べたいが、画面側は作品を知らないので、どの作品かはここで引く
    registerCommand("novelai.copyForPosting", async () => {
      const work = activePostingCopyWork(registry);
      const copied = await copyForPosting(
        await registeredPostingSites(work),
        // 合本の1話をコピーしたときの見出しに使う（「第3話」「3本目」）。
        // 作品が引けないことはある——そのときは既定の数え方になるだけ
        work ? await readWorkFormat(work) : undefined,
        // コピーのあとに投稿ページを開くボタンのため（台帳のURL）
        work
      );
      // **原稿が開いていない回と、貼り付け先を閉じた回を数えない**
      // （設計書6.104）。どちらもクリップボードには何も入っていない
      return copied ? CHECK_COMPLETED : CHECK_CANCELLED;
    }),
    registerCommand("novelai.importRuby", importRuby),
    /*
      口述で入れた文を整える（設計書6.83）。

      **原稿エディタの「整える」と同じ関数を通す**（入口2つ・実体1つ）。
      こちらは普通のエディタで使う入口なので、範囲は**選択**で決める
      ——選んでいなければ、どこを整えるのか決めようがない。
    */
    registerCommand("novelai.dictationClean", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage(
          "整える本文を開いてから実行してください。"
        );
        return;
      }
      if (editor.selection.isEmpty) {
        void vscode.window.showInformationMessage(
          "口述で入れたところを選んでから実行してください。" +
            "（原稿エディタなら、下段の「口述」→「整える」で範囲を選ばずに使えます）"
        );
        return;
      }
      const { runDictationClean } = await import("./features/dictationClean.js");
      await runDictationClean(
        {
          document: editor.document,
          range: editor.selection,
          work: workOfPath(registry, fromUri(editor.document.uri)),
          entry: "editor",
        },
        aiRegistry
      );
    })
  );

  // **入口を2つ持たせる**（設計書6.12.1）。ファイルを右クリックしたときは
  // 対象が決まっているので訊かない。操作メニューからは、まとめてか1件かを選ぶ
  context.subscriptions.push(
    registerCommand(
      "novelai.convertToMarkdown",
      async (node?: EpisodeNode | WorkNode) => {
        const { convertOne, convertToMarkdown } = await import(
          "./features/markdownConvert.js"
        );

        if (node && "episode" in node) {
          // 未保存のまま名前を変えると、書きかけが行き場を失う
          if (
            !(await saveDirtyDocumentsBeforeExtraction(node.work, "MD化"))
          ) {
            return;
          }
          if (!(await convertOne(node.episode.filePath))) return;
          treeProvider.refresh(node.work.id);
          return;
        }

        const work = await resolveWork(node as WorkNode | undefined, registry);
        if (!work) return;
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "MD化"))) return;
        if (!(await convertToMarkdown(work))) return;
        treeProvider.refresh(work.id);
      }
    )
  );

  // **改行コードは、作者が押したときだけ揃える**（設計書5.4.2）。
  // 保持が原則なので、同期にも保存にも自動の変換は足していない
  context.subscriptions.push(
    registerCommand("novelai.unifyEol", async (node?: WorkRef) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      const { unifyEol } = await import("./features/eolUnify.js");
      await unifyEol(work);
    })
  );

  // **作品の登録は要らない**（設計書6.85）。Word で書いた原稿は、たいてい
  // まだ作品として登録していない。登録があるときだけ、既定のフォルダーを
  // 決めるために作品を訊く
  context.subscriptions.push(
    registerCommand(
      "novelai.convertDocxToMarkdown",
      async (node?: WorkNode) => {
        const { convertDocxToMarkdown } = await import(
          "./features/docxImport.js"
        );
        let work: WorkEntry | undefined;
        if (registry.list().length > 0) {
          work = await resolveWork(node, registry);
          // 作品を選ばずに閉じたのなら、そこで終わる
          if (!work) return;
        }
        await convertDocxToMarkdown(work);
        if (work) treeProvider.refresh(work.id);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.showEditHistory",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await showEditHistory(context, work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.toggleExternalAccess",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await toggleExternalAccessPermission(work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.writeAiInstructions",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await writeAiInstructions(context, work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.reviewProposals",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry, {
          title: "提案を確認する作品を選択",
          // 提案は作品ごとに溜まる。**この操作には印が無い**ので、
          // 選ぶ場面が「どこに未処理が残っているか」を知る唯一の手がかりになる。
          // `pendingCount()` は提案の1ファイル（JSONL）を読むだけで済むので、
          // 選択肢を出すたびに呼んでも重くならない
          annotate: async (candidate) => {
            let count = 0;
            try {
              count = await new ProposalStore(candidate).pendingCount();
            } catch {
              // 読めない作品は0件として扱う。補足が出ないだけで実害はない
            }
            return pendingProposalNote(count);
          },
        });
        if (!work) return;
        await reviewProposals(work, proposalPanel);
      }
    ),
    registerCommand(
      "novelai.toggleReviewLock",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await toggleReviewLock(work);
      }
    ),
    // 編集部へ渡す／提案を取り込む（設計書5.7.5）。
    // **書庫へ編集部を招けない**ので、その作品だけを切り出して渡す
    registerCommand(
      "novelai.shareWithEditor",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        if (!canRunProcesses()) {
          vscode.window.showWarningMessage(
            "編集部へ渡す操作はブラウザ版では使えません。"
          );
          return;
        }
        const { shareWithEditor } = await import(
          "./features/shareWithEditor.js"
        );
        await shareWithEditor(work);
      }
    ),
    registerCommand(
      "novelai.collectEditorProposals",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        if (!canRunProcesses()) {
          vscode.window.showWarningMessage(
            "編集部の提案の取り込みはブラウザ版では使えません。"
          );
          return;
        }
        const { collectEditorProposals } = await import(
          "./features/shareWithEditor.js"
        );
        await collectEditorProposals(work);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.splitCollectedFile",
      async (node?: EpisodeNode) => {
        if (!node) return;
        // 未保存のまま読むと、画面と違う本文を分けてしまう
        if (
          !(await saveDirtyDocumentsBeforeExtraction(node.work, "ファイルの分割"))
        ) {
          return;
        }
        await splitCollectedFile(node.work, node.episode.filePath);
        treeProvider.refresh(node.work.id);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.copySubtitle",
      async (node?: EpisodeNode) => {
        if (node) await copySubtitle(node.episode);
      }
    ),
    registerCommand(
      "novelai.copyBodyForPosting",
      async (node?: EpisodeNode) => {
        if (!node) return;
        // 未保存のままコピーすると、画面と違う本文を渡してしまう
        if (
          !(await saveDirtyDocumentsBeforeExtraction(node.work, "本文のコピー"))
        ) {
          return;
        }
        await copyBodyForPosting(node.work, node.episode);
      }
    ),
    registerCommand(
      "novelai.renameWithSubtitle",
      async (node?: EpisodeNode) => {
        if (!node) return;
        await renameWithSubtitle(node.work, node.episode);
        treeProvider.refresh(node.work.id);
      }
    )
  );

  /*
    投稿キット（設計書6.68）。**投稿サイトへは書き込まない**——変換と
    コピー、投稿ページを開くこと、記録だけを機械が引き受ける。

    入口は2つある。作品から始めると**未投稿のいちばん古い話**、話から
    始めるとその話。どちらも未保存の本文を先に保存させる
    （画面と違う本文を投稿欄へ渡さないため。`copyBodyForPosting` と同じ）。
  */
  context.subscriptions.push(
    registerCommand("novelai.postNewEpisode", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return CHECK_CANCELLED;
      if (!(await saveDirtyDocumentsBeforeExtraction(work, "投稿の準備"))) {
        return CHECK_CANCELLED;
      }
      const result = await postNewEpisode(work, aiRegistry);
      // 未投稿の印が変わるので、記録したときだけ一覧を作り直す
      if (result.changed) treeProvider.refresh(work.id);
      /*
        **捨てていた戻り値を拾う**（設計書6.104）。台帳が変わらなかった
        回は、途中の窓を閉じたか台帳を読めなかったかで、**投稿の記録は
        残っていない**。済んだことにすると案内が先へ行ってしまう。
      */
      return result.changed ? CHECK_COMPLETED : CHECK_CANCELLED;
    }),
    registerCommand("novelai.postThisEpisode", async (node?: EpisodeNode) => {
      if (!node) return;
      if (!(await saveDirtyDocumentsBeforeExtraction(node.work, "投稿の準備"))) {
        return;
      }
      const result = await postNewEpisode(node.work, aiRegistry, node.episode);
      if (result.changed) treeProvider.refresh(node.work.id);
    }),
    registerCommand(
      "novelai.configurePostingSites",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        // **AIは呼ばない。** サイト・URL・作品情報・基準線を決めるだけ
        const result = await configurePostingSites(work);
        if (!result.changed) return;
        treeProvider.refresh(work.id);
        // 作品情報は執筆量パネルの「サイトの記録」に出る。開いたままの
        // パネルが古い値を映し続けないよう、その場で作り直す
        await refreshWritingStatsPanel(work, deviceId);
      }
    ),
    /*
      ランキングの記録（設計書6.68.5）。**サイトへは取りにいかない**——
      作者が画面で見た順位を台帳へ書き足すだけである。

      一覧は作り直さない。未投稿の印は順位では変わらず、記録のたびに
      作品一覧を組み直しても見た目は同じである。

      **執筆量パネルは作り直す。** 記録した順位が出るのはそこなので、
      開いたままだと「記録しました」と言われた順位が画面に無い。
    */
    registerCommand("novelai.recordRanking", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      const result = await recordRanking(work);
      if (result.changed) await refreshWritingStatsPanel(work, deviceId);
    }),
    /*
      読者の反応（設計書6.79.7）。**順位と同じ扱い**——サイトへは取りに
      いかず、作者が打った値か、作者が自分で開いた管理画面から貼り込み係が
      作った封筒を受けるだけである。

      記録が出るのは執筆量パネルなので、そちらを作り直す（一覧は変わらない）。
    */
    registerCommand("novelai.importReaderStats", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      const result = await importReaderStats(work);
      if (result.changed) await refreshWritingStatsPanel(work, deviceId);
    }),
    registerCommand("novelai.recordReaderStats", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      const result = await recordReaderStats(work);
      if (result.changed) await refreshWritingStatsPanel(work, deviceId);
    })
  );

  /*
    作品ごとのメモ（設計書6.71）。

    **触るのはメモのファイルだけ。** 原稿にも台帳にも書き込まない。
    移管は「移した元」と「移した先」の両方の一覧を作り直す
    ——片方だけだと、移したメモが2つの作品に見えたままになる。
  */
  context.subscriptions.push(
    registerCommand(
      "novelai.addWorkMemo",
      async (node?: WorkRef | MemoFolderNode | MemoFileNode) => {
        // メモの枝からも足せる。そちらは作品が分かっているので訊かない
        const work =
          node && (node.type === "memoFolder" || node.type === "memoFile")
            ? node.work
            : await resolveWork(node, registry);
        if (!work) return;
        if (await addWorkMemo(work)) treeProvider.refresh(work.id);
      }
    ),
    registerCommand("novelai.removeWorkMemo", async (node?: MemoFileNode) => {
      if (!node) return;
      if (await removeWorkMemo(node.work, node.memo)) {
        treeProvider.refresh(node.work.id);
      }
    }),
    registerCommand(
      "novelai.transferMemoToWork",
      async (node?: EpisodeNode) => {
        if (!node) return;
        const moved = await transferMemo(node.work, node.episode, registry);
        if (!moved) return;
        treeProvider.refresh(moved.fromWorkId);
        treeProvider.refresh(moved.toWorkId);
      }
    )
  );

  /*
    章立て（設計書6.66.2）。**木のノードが引数に要る**ので、
    コマンドパレットには出さない（`package.json` の commandPalette）。
    台帳が変わったときだけ作品一覧を作り直す。
  */
  context.subscriptions.push(
    registerCommand("novelai.startChapter", async (node?: EpisodeNode) => {
      if (!node) return;
      if (await startChapterAt(node.work, node.episode)) {
        treeProvider.refresh(node.work.id);
      }
    }),
    registerCommand("novelai.renameChapter", async (node?: ChapterNode) => {
      if (!node) return;
      if (await renameChapter(node.work, node.chapter)) {
        treeProvider.refresh(node.work.id);
      }
    }),
    registerCommand("novelai.removeChapter", async (node?: ChapterNode) => {
      if (!node) return;
      if (await removeChapter(node.work, node.chapter)) {
        treeProvider.refresh(node.work.id);
      }
    })
  );

  /*
    章立てのAIの提案（P-31、設計書6.66.4）。

    **提案は台帳へ直接入らない。** 章分けの提案は提案パネルに並び、
    作者が承認した1件ずつが `ChapterStore` へ入る——入った時点で
    作品一覧を作り直す（折りたたみは台帳から作られるため）。

    章名の提案だけは、章ノードが引数に要るのでコマンドパレットに出さない。
  */
  context.subscriptions.push(
    registerCommand("novelai.proposeChapters", async (node?: WorkNode) => {
      const work = await resolveWork(node, registry);
      if (!work) return;
      await proposeChapters(work, aiRegistry, proposalPanel, {
        onChaptersChanged: () => treeProvider.refresh(work.id),
      });
    }),
    // 分け済みの話ごとのファイルの頭にある【第N章】から章を立てる。
    // AIは呼ばず、台帳が空のときだけ書く（features/chaptersFromHeadings.ts）
    registerCommand(
      "novelai.chaptersFromHeadings",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        if (await chaptersFromHeadings(work)) treeProvider.refresh(work.id);
      }
    ),
    registerCommand(
      "novelai.suggestChapterName",
      async (node?: ChapterNode) => {
        if (!node) return;
        if (await suggestChapterName(node.work, node.chapter, aiRegistry)) {
          treeProvider.refresh(node.work.id);
        }
      }
    )
  );

  /*
    話の挿入と削除（設計書6.67）。**木のノードが引数に要る**ので、
    コマンドパレットには出さない（`package.json` の commandPalette）。

    実装は `node:child_process`（`core/git.ts`）を静的importしているため、
    ここでは動的import（`await import(...)`）を通す
    （`novelai.gitSync` などと同じ約束、設計書5.8.5）。
  */
  context.subscriptions.push(
    registerCommand("novelai.insertEpisodeBefore", async (node?: EpisodeNode) => {
      if (!node) return;
      const episodes = await treeProvider.getEpisodes(node.work);
      const { insertEpisodeBefore } = await import("./features/insertEpisode.js");
      const result = await insertEpisodeBefore(node.work, node.episode, episodes);
      if (result.changed) treeProvider.refresh(node.work.id);
      if (result.newFilePath) {
        // 新規作成した回は「保存でファイル数が変わった回」に当たるため、
        // 執筆量の基準を置き直す（`novelai.addEpisode` と同じ理由、設計書6.3.2）
        await progress.rebaseline(node.work);
        await vscode.commands.executeCommand(
          "vscode.openWith",
          path.toUri(result.newFilePath),
          MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
        );
      }
    }),
    registerCommand(
      "novelai.removeEpisodeAndRenumber",
      async (node?: EpisodeNode) => {
        if (!node) return;
        const episodes = await treeProvider.getEpisodes(node.work);
        const { removeEpisodeAndRenumber } = await import(
          "./features/removeEpisode.js"
        );
        const result = await removeEpisodeAndRenumber(
          node.work,
          node.episode,
          episodes
        );
        if (result.changed) treeProvider.refresh(node.work.id);
      }
    )
  );

  context.subscriptions.push(
    registerCommand("novelai.switchMode", async () => {
      await switchMode();
      // 押せる操作が変わるので、メニューを作り直す
      actionProvider.refresh();
    })
  );

  /*
    **VS Code を開いた時点で点検する**（設計書6.15.1の①）。

    これまでは「取得だけ」だった（`refreshAll({ fetch: true })`）。作者の
    指示（2026-09-21）で、**溜まっていれば送り、リモートだけ進んでいれば
    取り、両方に動きがあってもファイルが重ならなければ揃える**ところまで行う。
    重なっていたら手を止めて訊く。

    await しないのは、回線が遅い環境で拡張機能の起動を待たせないため。

    **ブラウザ版ではgitの子プロセスを起こせない**ので、これまでどおり
    代役の `refreshAll`（何もしない）で済ませる（設計書5.8.5）。
  */
  if (canRunProcesses()) {
    void (async () => {
      const handoff = await import("./features/handoffSync.js");
      const deps = handoffDeps();

      // **印は、状態が変わるたびに付け直す**（設計書6.15.1）。`deactivate()`
      // は待たれないので、そこで書こうとすると印まで残らないことがある。
      // 消えるのは送り残しが無くなったとき＝送信が通ったときだけである
      context.subscriptions.push(
        gitSync.onDidChange(() => void handoff.refreshUnsentMark(deps))
      );
      // **閉じる前の問いは、ここで仕込む。** `deactivate()` は同期関数で
      // 動的importを待てないので、読み込み済みの関数を掴んでおく
      beforeClose = () => handoff.noticeBeforeClose(deps);

      // 起動の所要時間（設計書6.107）。点検は回線の速さに左右されるので、
      // 始まりと終わりの両方を残さないと「遅いのは点検か、その手前か」が
      // 分からない
      startupTiming.mark("点検 開始");
      await handoff.runStartupHandoff(deps);
      noteStartupHandoffDone("点検 終了");
    })().catch((error) => {
      // 点検で落ちても拡張機能の起動は止めない
      logFailure("開いたときの点検", {
        詳細: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    void gitSync.refreshAll({ fetch: true });
  }

  /*
    **はじめて開いたときの声かけは、2つを続けて出す**（設計書6.90.3）。

      1. 作家タイプ診断（作者の依頼、2026-09-13「使用開始時に…」）
      2. 使うAIを選ぶ（作者の指示、2026-08-19）

    **診断を先にする。** 何をしたいかが決まる前にAIを選ばせても、
    何のために要るのかが分からない。診断の案内は**AIを使わない**ので、
    「いまある原稿を取り込む」「編集・校閲で使う」だけなら最後まで通る。

    **同時に2つ出さない。** 通知が2枚並ぶと、どちらに答えたのか分からなくなる。
    診断の声かけが片付いてから、AIの声かけを出す。

    どちらも await しないのは、選び終わるまで拡張機能の初期化が
    止まるのを避けるためである。
  */
  void (async () => {
    const { offerWriterDiagnosis } = await import(
      "./features/writerDiagnosis.js"
    );
    await offerWriterDiagnosis(writerDiagnosisDeps());
    await offerFirstRunSetupInVsCode(context, aiRegistry);
  })();

  /*
    **整備をいつ起こすか、ここで決める**（設計書6.107。0.74.9）。

    ふだんは「作品一覧の初回描画」のあとに起こす。整備の `await` と
    一覧の走査が同じスレッドで取り合い、整備がバラバラの位置で何秒も
    詰まっていたためである。

    - **0件なら、その場で起こす。** 作品が無ければ走査も描画も起きないので、
      合図が当てにならない。整備そのものは0件でも走り、除外設定の知らせ
      だけが出る道になる
    - **1件以上なら、合図を待つ。ただし上限つき**（60秒）。サイドバーを
      一度も開かない起動では合図が来ないので、待ちきったら自分で起こす
  */
  if (registry.list().length === 0) maintenanceTrigger.signal();
  else maintenanceTrigger.arm();

  // ここまでが `activate` 本体（設計書6.107）。**画面が出るのはこのあと**
  // ——VS Code が作品一覧の `getChildren` を呼ぶのは、ここを抜けてからである
  startupTiming.mark("activate 終了");

  // **VS Code 標準のMarkdownプレビューへ差し込む**（設計書6.12）。
  // 独自のプレビュー画面を作らないのは、作者が既に使っている
  // プレビュー（Ctrl+Shift+V）でそのまま見えるほうが良いため
  return {
    extendMarkdownIt<T extends MarkdownItLike>(md: T): T {
      return extendMarkdownItWithRuby(md);
    },
  };
}

/**
 * 作品ごとの整備に何ミリ秒かかったかを、1つの注記にまとめる（設計書6.107）。
 *
 * **合計だけでは、何を疑えばよいかが決まらない。** `stat`（フォルダーが
 * 在るかを訊くだけ）が重いならクラウドの取り寄せ、`.gitignore` が重いなら
 * 書き込みの遅さを疑う。16件が一様に遅いのか1件だけが突出しているのかは、
 * 最長の1件を並べれば読める。
 *
 * 数字の区切りは `formatStartupMillis` に揃える（同じ1行の中で書き方が
 * 混ざらないように）。
 */
function describeMaintainReport(report: WorkRegistryInitReport): string {
  return [
    // **順番待ちを先に出す**（設計書6.107。0.74.9）。ここが大きければ
    // 待たされていただけで、`stat` や `.gitignore` を疑っても始まらない
    `yield 合計 ${formatStartupMillis(report.yieldMs)}ms`,
    `stat 合計 ${formatStartupMillis(report.statMs)}ms`,
    `.gitignore 合計 ${formatStartupMillis(report.ignoreMs)}ms`,
    ...(report.slowestTitle
      ? [
          // **何番目かを添える。** 遅い作品が毎回入れ替わったので、
          // 「1件目だから遅い」のかを1行で見分けられるようにする
          `最長 ${report.slowestOrder}番目 ${
            report.slowestTitle
          } ${formatStartupMillis(report.slowestMs)}ms`,
        ]
      : []),
  ].join("／");
}

/**
 * 整備に回った作品を、回った順に全部並べる（設計書6.107）。
 *
 * **最長の1件だけでは、1回の計測で見分けがつかない。** ノートPCで3回
 * 測ると遅い作品が毎回入れ替わり、どれか1件が必ず8.7秒前後だった
 * （2026-09-21）。**1件目だから遅いのか、その作品が遅い置き場にあるのか**は、
 * 順番と題と数字を全部並べて、次の起動と突き合わせれば決まる。
 *
 * 16作品なら1行が長くなるが、**ログなので構わない**（通知には出さない）。
 * 0件なら空文字を返し、呼び出し側が行ごと落とす。
 */
function describeMaintainOrder(report: WorkRegistryInitReport): string {
  if (report.works.length === 0) return "";
  const parts = report.works.map(
    (item) =>
      `${item.order} ${item.title} yield ${formatStartupMillis(
        item.yieldMs
      )}／stat ${formatStartupMillis(item.statMs)}／ignore ${formatStartupMillis(
        item.ignoreMs
      )}`
  );
  return `順に：${parts.join(" → ")}`;
}

/**
 * 作品一覧の走査に何ミリ秒かかったかを、1つの注記にまとめる（設計書6.107）。
 *
 * **「一覧が出るまで25秒」だけでは、次に何を直せばよいか決まらない。**
 * 0.74.7 で読み口を Node の `fs` へ替えても一覧の時間は動かなかったので、
 * **I/O ではなく計算そのもの**が残っている疑いがある。読み・数え・解析を
 * 分けて出せば、次に刻む場所がその場で決まる。
 *
 * 合計は**同時に走った4本ぶんの足し算**なので、壁時計の時間より大きくなる。
 * それでよい——読みたいのは「どの作業がどれだけ CPU を食ったか」である。
 *
 * ファイルを1つも読んでいなければ、走査の部分は付けない（`undefined` を
 * 返すと、`mark` 側が括弧ごと落とす）。
 *
 * 0.74.11 で2つ足した。**読みを「下ごしらえ」と「読み」に割った**のと、
 * **イベントループの遅れ**（`core/loopLag.ts`）である。遅れの合計が読みの
 * 待ちと釣り合えば「握られている」、釣り合わなければ「読み口が遅い」。
 */
function describeScanSummary(
  summary: ScanTiming,
  lag?: LoopLagReport
): string | undefined {
  /*
    **遅れは、走査が0件でも出す**（設計書6.107。0.74.11）。作品が無くても
    「起動と同時に誰かが握っている」なら、それは読み口の話ではない。
  */
  const lagPart = lag
    ? [
        `ループの遅れ 合計 ${formatStartupMillis(
          lag.totalLagMs
        )}ms／最大 ${formatStartupMillis(lag.maxLagMs)}ms`,
      ]
    : [];
  if (summary.files === 0) {
    return lagPart.length > 0 ? lagPart[0] : undefined;
  }
  return [
    `走査 合計 ${formatStartupMillis(summary.totalMs)}ms（下ごしらえ ${
      formatStartupMillis(summary.prepMs)
    }／読み ${formatStartupMillis(summary.readMs)}／数え ${
      formatStartupMillis(summary.countMs)
    }／解析 ${formatStartupMillis(summary.parseMs)}）`,
    ...(summary.slowestFile
      ? [
          `最長 ${summary.slowestFile} ${formatStartupMillis(
            summary.slowestMs
          )}ms`,
        ]
      : []),
    `ファイル ${summary.files}`,
    ...lagPart,
  ].join("／");
}

/**
 * 閉じる前に、未送信を問う仕掛け（設計書6.15.1の④）。
 *
 * **`deactivate()` は同期関数で、動的importを待てない。** 起動時に
 * `features/handoffSync.ts` を読み込んだ時点で、ここへ関数を掴んでおく。
 * ブラウザ版では読み込まないので `undefined` のまま（gitが無いので問う相手もいない）。
 */
let beforeClose: (() => void) | undefined;

/**
 * 窓の札を消す（MCP の windows.list）。起動時に掴んでおく。
 *
 * **消すのは非同期なので、`deactivate()` から約束を返して待ってもらう。**
 * 待ち切られないこともあるが、そのときは札の `updatedAt` が古くなり、
 * MCP が「たぶん閉じた」と印を付ける（それが受け皿）。
 */
let closeWindowCard: (() => Promise<void>) | undefined;

export function deactivate(): Promise<void> | undefined {
  /*
    **閉じる前に未送信を問う**（設計書6.15.1、作者の裁定 2026-09-21）。

    **これは確実には動かない。** VS Code は `deactivate()` の非同期の完了を
    待ち切らないので、問いが出ないまま閉じることがある。**通信や電池が
    切れる場面と同じ形の危なさである。**

    だから**これを唯一の守りにしていない**——出なかったときの受け皿が
    「送らずに閉じた」印（`globalState`）と、次に開いたときの点検である。

    **ここで落ちても後片付けは続ける。** 問いのために閉じ際の始末を
    落とすほうが重い
  */
  try {
    beforeClose?.();
  } catch (error) {
    logFailure("閉じる前の未送信の確認", {
      詳細: error instanceof Error ? error.message : String(error),
    });
  }

  // 後片付けは context.subscriptions に任せる。
  // ログだけは遅延生成でsubscriptionsに載っていないので個別に閉じる
  disposeLog();

  // 札は最後に消す（上の問いやログの片づけを、札の消去の待ちで遅らせない）
  return closeWindowCard?.().catch(() => undefined);
}

/**
 * 「作品を追加」に渡された、場所と作品名（設計書5.8.13）。
 *
 * **ブラウザ版の実動テストのための口である。** `npm run test:web` は
 * ブラウザのVS Codeを立ち上げて拡張機能を動かすが、選択画面や入力画面を
 * 押す手が無い。そこでコマンドに引数を渡せるようにして、その2つを飛ばす。
 *
 * **形を確かめてから使う。** このコマンドは詳細メニュー・コマンドパレット・
 * 右クリックからも呼ばれ、そこでは別のもの（`Uri` など）が渡ってくる。
 * 欄が揃っていないものは「引数なし」と同じに扱い、これまでの画面を出す。
 */
function parseAddWorkArgument(
  arg: unknown
): { folderPath: string; title?: string } | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const candidate = arg as { folderPath?: unknown; title?: unknown };
  if (typeof candidate.folderPath !== "string") return undefined;
  if (candidate.folderPath.trim().length === 0) return undefined;
  const title =
    typeof candidate.title === "string" && candidate.title.trim().length > 0
      ? candidate.title.trim()
      : undefined;
  return { folderPath: candidate.folderPath, title };
}

/**
 * プロットモードの一覧から渡された引数か（設計書6.36.3）。
 *
 * **形を確かめてから使う。** 右クリック（`Uri`）・詳細メニュー（`WorkRef`）・
 * コマンドパレット（引数なし）と同じ口を通るので、名前だけで信じない。
 */
function asEpisodePlotRef(arg: unknown): EpisodePlotCheckRef | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const candidate = arg as Partial<EpisodePlotCheckRef>;
  if (candidate.type !== "episodePlot") return undefined;
  if (!candidate.work || typeof candidate.chapter !== "number") return undefined;
  if (candidate.check !== "design" && candidate.check !== "contrast") {
    return undefined;
  }
  return candidate as EpisodePlotCheckRef;
}

/**
 * そのファイルが属する作品を探す。
 * 深い作品フォルダを先に見て、入れ子の場合は内側を選ぶ。
 */
function findWorkForPath(
  registry: WorkRegistry,
  filePath: string
): WorkEntry | undefined {
  // 比べ方は `paths.normalizeForComparison` の1か所に任せる（2026-09-23）。
  // 以前はここに写しがあり、`process.platform` を素で読んでいたので、
  // ブラウザ版では作品の見分けが `process is not defined` で落ちた
  const normalize = path.normalizeForComparison;
  return [...registry.list()]
    .sort((a, b) => b.folderPath.length - a.folderPath.length)
    .find((work) => {
      const normalizedWork = normalize(work.folderPath);
      const relative = path.relative(normalizedWork, normalize(filePath));
      return relative.length > 0 && !path.goesOutside(normalizedWork, relative);
    });
}

/**
 * 開いているファイルから、**処理の対象として**作品を決める。
 *
 * `findWorkForPath` と引き方は同じで、**推し量ったという印**を付けて返す
 * （作者の裁定、2026-09-23。`core/workTarget.ts` の `markInferredWork`）。
 * 開いていたファイルが別の作品のものだっただけで、「以降は訊かない」の
 * 確認が黙って通らないようにする。
 *
 * **ステータスバーや保存時の記録には使わない**——そちらは確認を出さないので
 * 印は要らず、`findWorkForPath` のままでよい。
 */
function inferredWorkOfPath(
  registry: WorkRegistry,
  filePath: string
): WorkEntry | undefined {
  const work = findWorkForPath(registry, filePath);
  return work ? markInferredWork(work, "file") : undefined;
}

/**
 * いま作者が見ている本文（作者の実機報告、2026-09-06）。
 *
 * **素のエディタと原稿エディタの、どちらで開いていても同じ答えを返す。**
 * 原稿エディタはWebView（カスタムエディタ）なので `activeTextEditor` は
 * undefined になり、これを直に見ているコマンドは、原稿エディタで書いている
 * 作者に「本文のファイルを開いてから実行してください」と言い返していた
 * （「縦書きで開く」が原稿エディタから一度も使えなかった）。
 *
 * **VS Code 1.131 の新しいMarkdown編集画面（hybrid Markdown editor）も同じ。**
 * あちらも `TextEditor` を持たないので、エクスプローラーから `.md` を開いた
 * 作者が「縦書きで開く」を押すと、同じ断り文句で止まっていた
 * （実機、2026-09-12）。開き直すだけの操作に、場所以上のものは要らない。
 *
 * **判定を1本にまとめてあるので、同じ形のコマンドを足すときはここを通す。**
 * 順は素のエディタが先——タブが原稿エディタでも、作者がカーソルを置いて
 * いるのは素のエディタ側、ということがある。
 */
function activeManuscriptUri(): vscode.Uri | undefined {
  return (
    vscode.window.activeTextEditor?.document.uri ?? activeManuscriptTabUri()
  );
}

/**
 * 作品を持たない操作のログを、どの作品フォルダへ残すか。
 *
 * **作者に問いかけない。** AIチューニング（設計書6.49）のように作品を
 * 要さない操作でも、ログがファイルに残らないと原因を追えない
 * （出力パネルはVS Codeを閉じると消える）。かといって
 * 「どの作品のログに書きますか」と訊くのは、作者にとって意味の無い問いである
 * ——測っているのはモデルの性質であって、どの作品を選んでも結果は同じ。
 *
 * そこで**迷いようが無いときだけ**決める。開いているファイルの作品、
 * それも無ければ登録が1つのときのその作品。決められなければ undefined を
 * 返し、これまでどおり出力パネルにだけ残す（無理に書き先を作らない）。
 */
function logTargetWorkFolder(registry: WorkRegistry): string | undefined {
  // 原稿エディタで書いているときも、その作品のログへ残す
  const uri = activeManuscriptUri();
  const opened = uri ? findWorkForPath(registry, fromUri(uri)) : undefined;
  if (opened) return opened.folderPath;
  const works = registry.list();
  return works.length === 1 ? works[0].folderPath : undefined;
}

/**
 * 実行の結果を通知する。**一部でも失敗していれば「完了」と言わない。**
 *
 * 実データで、誤字脱字検知が3件中2件タイムアウトした回に
 * 「完了しました。指摘 0件 / 失敗 2チャンク」と出ていた
 * （作者のログ、2026-08-29）。作者からは「誤字が無かった」と読めるが、
 * 実際には**本文の3分の2を見ていない**。同じ形が伏線・逸脱・推敲・矛盾にも
 * あったので、通知の入口をここへ集めた（0.28.8）。
 *
 * 失敗があるときは、①見出しを「一部を処理できませんでした」に変え
 * ②通知そのものを警告にし ③**見ていない部分があること**を言葉で伝える。
 *
 * @param headline 「伏線の検知」のような処理の名前（「が完了しました」は付けない）
 * @param tail 成功時にだけ添える案内（「台帳へはまだ入れていません」など）
 */
function notifyRunCompletion(options: {
  headline: string;
  parts: string[];
  failedCount: number;
  /** 全体の件数。分かるときだけ渡す（「3件中2件」と言えるようにする） */
  totalCount?: number;
  tail?: string;
  /** 失敗に時間切れが混じっていたか。混じっていればチューニングへ誘う（6.49） */
  timedOut?: boolean;
  /** いま使うAIが有料か。**渡さないときは中立に言う**（誤って「無料」と言わない） */
  isPaid?: boolean;
  /** どの機能のAIを測らせるか。**渡さないと既定のAIを測って空振りする**（6.28.9） */
  tuningFeature?: AssignableFeature;
}): void {
  const summary = options.parts.join(" / ");

  if (options.failedCount > 0) {
    const total =
      options.totalCount !== undefined && options.totalCount > 0
        ? `${options.totalCount}件中`
        : "";
    // 時間切れが混じっているときだけ、チューニングへ誘う。
    // 料金の断りは、有料と分かっているときだけ強く言う
    const tuningNote = options.timedOut
      ? "時間切れが起きています。「AIチューニングを実行」で、" +
        "このモデルに合った待ち時間を測れます" +
        (options.isPaid === true
          ? "（AIを呼ぶので料金がかかります）。"
          : options.isPaid === false
            ? "（AIを呼びますが、このAIは無料です）。"
            : "（AIを呼びます。有料のAIでは料金がかかります）。")
      : "";
    const buttons = options.timedOut ? ["AIチューニングを実行"] : [];
    void vscode.window
      .showWarningMessage(
        `${options.headline}は一部を処理できませんでした（${total}${options.failedCount}件が失敗）。` +
          `${summary}。` +
          "失敗した部分は見ていないので、そこに何かあっても出ていません。" +
          "ログで理由を確かめ、もう一度実行してください（成功した部分は再利用されます）。" +
          tuningNote,
        ...buttons
      )
      .then((answer) => {
        if (answer === "AIチューニングを実行") {
          // **その機能の割当先を測らせる。** 引数なしだと既定のAIを測り、
          // 割当が別なら「測ったのに直らない」ことになる
          void vscode.commands.executeCommand(
            "novelai.measureContext",
            options.tuningFeature
          );
        }
      });
    return;
  }

  void vscode.window.showInformationMessage(
    `${options.headline}が完了しました。${summary}。${options.tail ?? ""}`
  );
}

/**
 * コマンドの引数として来たものが、機能別割当のキーか。
 *
 * **一覧はコマンド側で持たない**（`ASSIGNABLE_FEATURES` が唯一の定義）。
 * コマンドは外から任意の値で叩けるので、知らない値は「既定」に落とす。
 */
function isAssignableFeature(value: unknown): value is AssignableFeature {
  return (
    typeof value === "string" &&
    (ASSIGNABLE_FEATURES as string[]).includes(value)
  );
}

/**
 * 誤字脱字検知の結果を要約して通知する。作品全体・1話単位のどちらからも呼ぶ。
 *
 * **件数は提案パネルに出たものを言う**（設計書6.8）。検知が返した件数を
 * そのまま言うと、前に適用済み・解消済みだったものまで数えてしまい、
 * 通知が「指摘 1件」なのにパネルの見出しは「誤字脱字 0件」になる
 * （2026-09-06、作者の実機報告）。
 *
 * @param shown `proposalPanel.showResults` が返した、一覧に残った件数
 */
function reportTypoCheckResult(
  label: string,
  result: TypoCheckRunResult,
  shown: IncomingCount
): void {
  const parts = describeCheckRunCounts({
    shown: shown.remaining,
    // 本文へ当てる前に落としたぶんと、パネルで既に片付いていたぶんの両方
    alreadyHandled: result.alreadyAppliedCount + shown.handled,
    rejected: result.rejectedCount,
  });
  notifyRunCompletion({
    headline: label,
    parts,
    failedCount: result.failedChunks,
    totalCount: result.totalChunks,
    // **時間切れが1件でもあれば、測って直せることを伝える。**
    // 有料かどうかも渡す——「実行しますか」と誘う以上、押す前に
    // 料金が出るのかどうかが分かっていなければならない
    timedOut: result.timedOutChunks > 0,
    isPaid: result.usedPaidProvider,
    // 誤字脱字に割り当てたAIを測らせる（既定とは別のことがある）
    tuningFeature: "typo",
  });
}

/**
 * いま画面で「この作品」と指しているものを訊く口（設計書6.68.2）。
 *
 * **`resolveWork` はモジュールの関数で、画面を持たない。** ツリーも相談
 * パネルも `activate()` の中にしか無いので、起動のときにここへ訊き方だけを
 * 預ける。預ける前（起動の途中）は `undefined` で、これまでどおり作者に訊く。
 */
let workTargetHints:
  | (() => { treeSelectedId?: string; chatTargetId?: string })
  | undefined;

/** ツリーから呼ばれた場合はそのノード、コマンドパレットからは選択させる */
interface ResolveWorkOptions {
  /**
   * 作品ごとの補足。どれを選ぶべきかの判断材料を出す。
   *
   * **件数の印は全作品を合わせた数なので、それだけではどの作品に
   * 溜まっているのか分からない**（実機で発覚、2026-08-14）。
   * 承認待ちのように作品ごとに数が違うものは、選ぶ場面で内訳を見せる。
   */
  annotate?: (work: WorkEntry) => Promise<{ note?: string; order?: number }>;
  title?: string;
}

/**
 * コマンドへ「この作品で」と指定するための最小の入れ物。
 *
 * ツリーから呼ばれるときは `WorkNode` が来るが、相談パネルからのように
 * 作品だけが分かっている場合もある。`resolveWork` は種別と作品しか見ないので、
 * この形だけを要求する（`WorkNode` はそのまま渡せる）。
 */
export type WorkRef = Pick<WorkNode, "type" | "work">;

/**
 * 相談パネルから起動できる機能と、対応するコマンド。
 *
 * **校正・校閲だけは別扱い**（結果を提案パネルへ出すところまでが
 * 一続きで、そのパネルはここが持っているため）。それ以外は
 * **既にあるコマンドへそのまま渡す**。処理を二重に持つと、
 * 片方だけ直したときに「メニューからは動くのに相談からは動かない」
 * という食い違いが出る。
 */
const CHAT_RUN_COMMANDS: Partial<Record<ChatRunKind, string>> = {
  // 検知は 2026-09-06 にここへ寄せた（設計書6.8.16）。相談側に写しを置くと、
  // 件数の数え方・完了の知らせが片方だけ古くなる。**寄せられないのは
  // 「いま開いている話だけ」（checkTyposForFile）だけで、その理由は
  // `run` に書いてある**
  checkTypos: "novelai.checkTypos",
  // 表記ゆれは、コマンド側が0組で黙っていたので寄せられなかった。
  // その口を `describeNotationResult` に揃えて寄せた（2026-09-06）
  checkNotation: "novelai.checkNotation",
  checkProofread: "novelai.checkProofread",
  checkDeviations: "novelai.checkDeviations",
  checkContradictions: "novelai.checkContradictions",
  extractSettings: "novelai.extractSettings",
  extractCharacters: "novelai.extractCharactersOnly",
  extractLocations: "novelai.extractLocationsOnly",
  extractAbilities: "novelai.extractAbilitiesOnly",
  extractOrganizations: "novelai.extractOrganizationsOnly",
  extractWorld: "novelai.extractWorldOnly",
  generateSettingsDocs: "novelai.generateSettingsDocs",
  openSettingsPanel: "novelai.openSettingsPanel",
  unifyCharacters: "novelai.unifyCharacters",
  applyPendingUpdates: "novelai.applyPendingUpdates",
  generateSynopses: "novelai.generateSynopses",
  generateWorkBlurb: "novelai.generateWorkBlurb",
  generateCatchphrases: "novelai.generateCatchphrases",
  openSynopsisDocs: "novelai.openSynopsisDocs",
  generatePlot: "novelai.generatePlot",
};

/**
 * いま開いている本文の作品（設計書6.68.2）。
 *
 * 投稿先の台帳を読むのは `features/postingCopyRegistered.ts` に寄せてある——
 * 入口が3つあるので、読み方と失敗の扱いを写さない。
 */
function activePostingCopyWork(registry: WorkRegistry): WorkEntry | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;

  return workOfPath(registry, fromUri(editor.document.uri));
}

/**
 * そのファイルが属する作品（登録簿で引く）。
 *
 * **引き方を1か所に置く。** 普通のエディタ（`activePostingCopyWork`）と
 * 原稿エディタ（`ManuscriptEditorDeps.workOf`）が別々に引くと、同じ操作の
 * 結果が画面によって変わる。比べ方は前方一致では足りない（`isInsideWork`）。
 */
function workOfPath(
  registry: WorkRegistry,
  filePath: string
): WorkEntry | undefined {
  return registry
    .list()
    .find((entry) => isInsideWork(entry.folderPath, filePath));
}

/**
 * いま開いている本文の話数（設計書6.92）。
 *
 * **数え方を増やさない。** ファイル名の解釈は `episodeParser.ts` の
 * `parseEpisodeFileName` が持っており、合本・日付名・範囲（第3〜4話）の
 * 扱いもそこで決まっている。ここで正規表現を書くと、一覧や統計と
 * 食い違う話数が資料の絞り込みにだけ出る。
 *
 * 範囲のある話は先頭（`chapterStart`）で見る。日付で名付けた記事は
 * 話数を持たないので `null` になり、絞り込みは掛からない。
 */
function chapterOfPath(filePath: string): number | null {
  return parseEpisodeFileName(path.basename(filePath)).chapterStart;
}

async function resolveWork(
  node: WorkRef | undefined,
  registry: WorkRegistry,
  options: ResolveWorkOptions = {}
): Promise<WorkEntry | undefined> {
  if (node && node.type === "work") return node.work;

  const works = registry.list();
  if (works.length === 0) {
    vscode.window.showInformationMessage("作品が登録されていません。");
    return undefined;
  }

  /*
    **画面で既に指している作品があれば、選び直させない**（0.75.4。
    設計書6.68.2／6.104）。

    作者の指摘：相談パネルから案内の札でターゲット読者診断へ入ると、
    **いま相談している作品をもう一度選ばされる**。引数の無い呼び出しは
    「作品が分からない」と決めつけていたが、画面には作品名が出ている。

    順（引数 → ツリーの選択 → 相談の対象 → 訊く）は `pickHintedWork` が持つ。
    **見えているものだけを当てにする**——畳んだままのツリーや、閉じた相談の
    選択は、作者の目には入っていない。外すと別の作品の資料が書き換わる。
  */
  const hinted = pickHintedWork({
    registeredIds: works.map((work) => work.id),
    ...workTargetHints?.(),
  });
  if (hinted) {
    const found = works.find((work) => work.id === hinted.workId);
    /*
      **推し量った作品には印を付けて返す**（作者の裁定、2026-09-23）。
      作品一覧の行を誤って選んでいただけで、「以降は訊かない」の確認が
      黙って通り、1時間30分の抽出が別の作品で走りうる。印の付いた作品は、
      覚えていても確認が出る（`views/notify.ts` の `confirmRun`）。

      **1作品しか無いときは付けない。** 取り違える相手がいない
    */
    if (found) {
      return hinted.source === "single"
        ? found
        : markInferredWork(found, hinted.source);
    }
  }

  const title = options.title ?? "作品を選択";
  if (!options.annotate) {
    const picked = await vscode.window.showQuickPick(
      [
        ...works.map((w) => ({
          label: abbreviateTitle(w.title),
          description: w.folderPath,
          // 省略したときだけ全文を添える。短い題にまで2行目を足すと、
          // 選ぶだけの窓が縦に伸びて読みにくくなる
          detail: isAbbreviated(w.title) ? w.title : undefined,
          work: w,
        })),
        // Escでも閉じられるが、それを知らない人には出口が無いように見える
        cancelItem(),
      ],
      { title }
    );
    return picked && "work" in picked ? picked.work : undefined;
  }

  const notes = await Promise.all(works.map((work) => options.annotate!(work)));
  // 溜まっている作品を上に出す。作者はたいていそれを選びたい
  const items = sortByPickOrder(
    works.map((work, index) => ({
      // **長い作品名は省略する**（作者の裁定、2026-09-06）。右に出る
      // 「未反映3件」などの補足が、幅の外へ押し出されて読めなくなるため
      label: abbreviateTitle(work.title),
      description: notes[index].note ?? "",
      // 全文は2行目に出す（省略していなければ、これまでどおり置き場だけ）
      detail: isAbbreviated(work.title)
        ? `${work.title}（${work.folderPath}）`
        : work.folderPath,
      order: notes[index].order ?? 0,
      work,
    }))
  );

  const picked = await vscode.window.showQuickPick(
    [...items, cancelItem()],
    { title }
  );
  return picked && "work" in picked ? picked.work : undefined;
}
