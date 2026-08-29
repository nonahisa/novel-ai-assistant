import * as vscode from "vscode";
import { pickFolder } from "./features/pickFolder";
import { fromUri } from "./core/paths";
import * as path from "./core/paths";
import { describeSyncTarget } from "./core/syncTarget";
import {
  WorkRegistry,
  readWorkConfig,
  scaffoldWorkFolder,
  workPaths,
} from "./core/workRegistry";
import { checkDictionaryFreshness } from "./core/imeDictionaryStatus";
import { WorkTreeProvider, WorkNode, EpisodeNode } from "./views/workTree";
import {
  countChars,
  formatCount,
  toManuscriptPages,
} from "./core/charCount";
import {
  formatChapterNumber,
  nextChapterNumber,
  nextDatedName,
  parseEpisodeFileName,
} from "./core/episodeParser";
import { scanWork } from "./core/scanner";
import { SUPPORTED_EXTENSIONS, WorkEntry } from "./models/types";
import { AIRegistry, runSetupWizard } from "./ai/registry";
import {
  extractCharacters,
  saveDirtyDocumentsBeforeExtraction,
} from "./features/extractCharacters";
// Node専用（node:child_process / node:path）。選ぶ操作の中で動的importする（設計書5.8.5）
import {
  chooseWorkStartMode,
  createFirstEpisodeFile,
  openPlotFile,
  type WorkStartMode,
} from "./features/startWork";
import { generateSettingsDocs } from "./features/generateSettingsDocs";
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
} from "./features/sceneMemoPanel";
import { editTimeline } from "./features/chronicleEdit";
import { unifyCharacterRecords } from "./features/unifyCharacters";
import { findMergeCandidates } from "./core/characterMerge";
import { CharacterStore } from "./core/characterStore";
import type { ChatRunKind } from "./core/chatEdit";
import { applyPendingCharacterUpdates } from "./features/applyPendingUpdates";
import { exportImeDictionary } from "./features/exportImeDictionary";
import { exportPdf } from "./features/exportPdf";
import { manageCustomFields } from "./features/manageCustomFields";
import { TermHighlighter } from "./views/termHighlight";
import { ActionListProvider, nodeKey } from "./views/actionList";
import {
  StepMenuProvider,
  stepNodeKey,
  stepViewDescription,
} from "./views/stepMenu";
import { ActionDecorationProvider } from "./views/actionDecorations";
import { PendingUpdateStore } from "./core/pendingUpdates";
// 作品を選ぶ場面で「未処理の提案が何件あるか」を出すために使う。
// 提案パネル（features/proposalPanel）が既に読んでいるので、束は増えない
import { ProposalStore } from "./core/proposalStore";
// gitコマンドが要る。動的importする（設計書5.8.5）
import { tryRegisterAsCollection } from "./features/addCollection";
import {
  currentCountMode,
  countModeLabel,
  excludeRubyFromCount,
  pickCount,
  needsRedraw,
  needsRescan,
} from "./core/countSettings";
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
import { disposeLog, logFailure, showLog } from "./core/logger";
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
import { describeProcessesBlocked } from "./core/processAvailability";
// nextSetupStep, runSetupStep も core/git.ts 経由。動的importする

import { resolveDeviceId } from "./core/device";
import {
  SessionStore,
  describeOtherDeviceSession,
} from "./core/sessionStore";
// CONFLICT_SCHEME・ConflictContentProvider・resolveWorkConflicts も
// core/git.ts 経由。競合はgit操作でしか起きないので、動的importする
import type { ConflictContentProvider as ConflictContentProviderType } from "./features/resolveConflicts";
import { checkTypos, type TypoCheckRunResult } from "./features/checkTypos";
import {
  checkNotation,
  describeNotationResult,
} from "./features/checkNotation";
import { generatePlot } from "./features/generatePlot";
import { WORK_CHAT_VIEW_ID, WorkChatPanel } from "./features/workChatPanel";
import { ChatterService } from "./features/chatterService";
import { setPlotBasics } from "./features/setPlotBasics";
import {
  invalidateWorkFormat,
  readWorkFormat,
} from "./core/workFormatStore";
import { statsDayKey } from "./core/writingStats";
import { setWorkGoals } from "./features/setWorkGoals";
import { checkContradictions } from "./features/checkContradictions";
import { checkProofread } from "./features/checkProofread";
import { checkDeviations } from "./features/checkDeviations";
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
  addMemoToOpenManuscript,
  insertMemoLineAbove,
  openManuscriptForReading,
  refreshManuscriptCounts,
  type ManuscriptEditorDeps,
} from "./features/manuscriptEditor";
import { showEditHistory } from "./features/editHistoryPanel";
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
import { countUnextractedEpisodes } from "./features/extractionFreshness";
import { chooseScope, recordCheck } from "./features/typoCheckScope";
import { switchMode } from "./features/switchMode";
import {
  revealFolder,
  setGeneratedStorageRoot,
} from "./views/openDocument";
import { GENERATED_DIR } from "./core/generatedFiles";
import { formatDayTime } from "./core/timestampedFileName";

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

export async function activate(
  context: vscode.ExtensionContext
): Promise<{ extendMarkdownIt<T extends MarkdownItLike>(md: T): T }> {
  /**
   * F5の開発ホストで、押した操作を記録する（作者の依頼、2026-08-27）。
   *
   * **本番の束には1バイトも入らない。** 本番ビルドでは `__DEV_HELPERS__` が
   * `false` に畳まれ、この枝ごと（中の動的importも）落ちる。残るのは
   * `logOperation` が `undefined` のままの変数だけで、下の包みは素通りになる。
   *
   * 記録は node:fs で書く。ブラウザの開発ビルド（vscode.dev）には fs が無いので
   * 記録しない——F5の「拡張機能開発ホスト」は常にデスクトップなので実害はない。
   */
  let logOperation: ((command: string) => void) | undefined;
  if (__DEV_HELPERS__ && canRunProcesses()) {
    const dev = await import("./dev/operationLog.js");
    dev.initOperationLog(context.extensionPath);
    logOperation = dev.logOperation;
  }

  /**
   * コマンド登録の包み。**登録の入口を1か所にまとめて、押された事実を残す。**
   *
   * 個々のハンドラへ記録を書き足す形にすると、80か所のうち書き忘れたものだけが
   * 静かに記録されなくなる（しかも気づけない）。入口で包めば、
   * **新しく足したコマンドも自動で記録の対象になる。**
   *
   * 残すのは「実行した事実」だけで、通ったかどうかは残さない
   * （判断は作者がする。`src/dev/checkRunner.ts`）。
   */
  const registerCommand: typeof vscode.commands.registerCommand = (
    command,
    callback,
    thisArg
  ) =>
    vscode.commands.registerCommand(command, (...args: unknown[]) => {
      logOperation?.(command);
      return callback.apply(thisArg, args);
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

  const registry = new WorkRegistry(context);
  await registry.initialize();

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

  const treeProvider = new WorkTreeProvider(
    registry,
    (workId) => describeSyncBadge(gitSync.statusFor(workId)),
    (workId) => describeSyncTooltip(gitSync.statusFor(workId))
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

  const settingsWatcher = new SettingsWatcher(
    registry,
    selfWrites,
    (work, files) => {
      void notifyExternalChange(work, files, {
        // 中身を見て取り込むかを決める。勝手に確定させない
        review: async () => {
          await openSettingsPanel(context, work, aiRegistry);
          highlighter.invalidate();
          treeProvider.refresh(work.id);
        },
        // **編集部の直しをAIから守る**（設計書5.5）。
        // GitHub経由の編集は拡張機能の画面を通らないので、
        // 印を付けないと次の抽出で上書きされる
        protect: async () => {
          await protectExternalEdits(work);
          highlighter.invalidate();
          treeProvider.refresh(work.id);
        },
        reload: () => {
          highlighter.invalidate();
          treeProvider.refresh(work.id);
        },
      });
    }
  );
  context.subscriptions.push(settingsWatcher);

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
      await findOpenSettingsPanel(found.work.id)?.showRecord(
        found.entry.kind,
        found.entry.id
      );
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
    openSettings: async (work, kind, id) => {
      const panel = await openSettingsPanel(context, work, aiRegistry, {
        beside: true,
      });
      // **用語から開くときは、一覧を畳んで出す**（作者の依頼、2026-08-28）。
      // 本文の隣に並ぶ狭い幅を一覧に取られると、肝心の資料が読めない
      await panel.showRecord(kind, id, { collapseList: true });
    },
    // 右クリックの時点で、**開いているパネルだけ**を追従させる
    // （作者の指示、2026-08-28）。開いていなければ何もしない——
    // 右クリックのたびに新しいパネルが開いては、作者の画面を奪う。
    // 一覧の畳みも触らない（作者が開けた一覧と喧嘩しないため）
    previewTerm: async (work, kind, id) => {
      await findOpenSettingsPanel(work.id)?.showRecord(kind, id);
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
    todayFileCount: (work, filePath) => progress.todayFileCount(work, filePath),
    // 空の話を作った直後に基準を置き直す（設計書6.3.2）。
    // **置き直さないと、そのあと書いた分が「今日 +0字」になって消える**
    rebaseline: (work) => progress.rebaseline(work),
    // MD化は**既存の変換と同じ経路**を通す（中のルビも直る。設計書6.12.4）
    convertToMarkdown: async (filePath) => {
      const { convertOne } = await import("./features/markdownConvert.js");
      return convertOne(filePath);
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

  // **開発用の道具は、配布物に入れない**（作者の指定、2026-08-26）。
  // 本番ビルドでは `__DEV_HELPERS__` が false に畳まれ、この枝ごと落ちる
  // （中の動的importも消えるので、`src/dev/` は束に入らない）
  if (__DEV_HELPERS__) {
    const { registerCheckRunner } = await import("./dev/checkRunner.js");
    context.subscriptions.push(registerCheckRunner(context));
    // 操作ログを確認リストへ書き戻す道具。**合否の印には触らない**
    const { registerReflectOperationLog } = await import(
      "./dev/reflectOperationLog.js"
    );
    context.subscriptions.push(registerReflectOperationLog(context));
  }

  context.subscriptions.push(
    registerCommand("novelai.syncAllWorks", async () => {
      const { syncAllWorks } = await import("./features/syncAllWorks.js");
      await syncAllWorks({ registry, monitor: gitSync });
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
                if (status.ahead > 0 && status.behind > 0) {
                  return {
                    note:
                      `分かれています（送信待ち ${status.ahead}件・` +
                      `受け取り ${status.behind}件）`,
                    order: 1,
                  };
                }
                return { note: "分かれていません", order: 0 };
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
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        void vscode.window.showWarningMessage(
          "本文のファイルを開いてから実行してください。"
        );
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
  context.subscriptions.push(treeView);

  // 操作の末尾に出す印（「AI」と未反映の件数）。
  // 件数は全作品を合わせて数える。作品を選ばずにメニューを見るため、
  // 「どこかに溜まっている」ことが分かればよい
  const actionDecorations = new ActionDecorationProvider(async (counter) => {
    let total = 0;
    for (const work of registry.list()) {
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
    (counter) => actionDecorations.countOf(counter),
    // 「テスト中」はF5（開発ホスト）だけに出す（作者の指示、2026-08-29）
    context.extensionMode === vscode.ExtensionMode.Development
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
    (counter) => actionDecorations.countOf(counter)
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

  /** 未反映の件数を数え直す。抽出・反映のあとに呼ぶ */
  const refreshActionBadges = (): void => {
    void actionDecorations.refresh().then(() => {
      actionProvider.refresh();
      // 同じ操作が2つのメニューに出るので、両方を引き直す
      stepProvider.refresh();
    });
  };
  // 起動直後にも数える。前回の抽出で溜まったままのことがある
  refreshActionBadges();
  registry.onDidChange(() => refreshActionBadges());

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
  const sceneMemoDeps = {
    revealInManuscript: (filePath: string, line: number) =>
      manuscriptProvider.revealLine(filePath, line),
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
    (filePath, line) => manuscriptProvider.revealLine(filePath, line)
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
      onProgress: (done: number, total: number) => void,
      stage: (
        stageLabel: string,
        stageUnit: string
      ) => (done: number, total: number) => void
    ) => Promise<T>,
    unit = "チャンク"
  ): Promise<T> {
    const reporter =
      (stageLabel: string, stageUnit: string) => (done: number, total: number) =>
        proposalPanel.showRunning(work, stageLabel, done, total, stageUnit);
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
  const workChatPanel = new WorkChatPanel(registry, aiRegistry, {
    run: async (work, kind, filePath) => {
      // 校正・校閲以外は、既にコマンドとして登録されているものへ渡す。
      // **ここで処理を書き直さない。** 二重に持つと、片方だけ直したときに
      // 「メニューからは動くのに相談からは動かない」という食い違いが出る
      const command = CHAT_RUN_COMMANDS[kind];
      if (command) {
        // 作品を指定して呼ぶ。引数無しだと作品選択からやり直させてしまう
        const ref: WorkRef = { type: "work", work };
        await vscode.commands.executeCommand(command, ref);
        return;
      }

      // 未保存のまま読むと、画面と違う本文を検知してしまう
      const label =
        kind === "checkNotation"
          ? "表記ゆれの検知"
          : kind === "checkContradictions"
            ? "矛盾検知"
            : kind === "checkProofread"
              ? "推敲"
              : kind === "checkDeviations"
                ? "プロット逸脱の検知"
            : "誤字脱字の検知";
      if (!(await saveDirtyDocumentsBeforeExtraction(work, label))) return;

      if (kind === "checkDeviations") {
        const result = await withPanelProgress(
          work,
          "プロット逸脱を検知",
          (onProgress) => checkDeviations(work, aiRegistry, { onProgress }),
          "話"
        );
        if (!result || result.cancelled) return;
        proposalPanel.showDeviations(work, result.issues);
        return;
      }

      if (kind === "checkProofread") {
        const result = await withPanelProgress(work, "推敲", (onProgress) =>
          checkProofread(work, aiRegistry, { onProgress })
        );
        if (!result || result.cancelled) return;
        proposalPanel.showResults(work, result.issues, "推敲");
        return;
      }

      if (kind === "checkContradictions") {
        const result = await withPanelProgress(
          work,
          "矛盾を検知",
          (onProgress, stage) =>
            checkContradictions(work, aiRegistry, {
              onProgress,
              // 検証はAIを1件ずつ呼ぶので、別の札で件数を流す
              onVerifyProgress: stage("検出した矛盾を検証", "件"),
            })
        );
        if (!result || result.cancelled) return;
        // 矛盾が実は伏線だったときの逃げ道を添える（設計書6.35.4）
        proposalPanel.showContradictions(work, result.issues, (source) =>
          registerForeshadowFromContradiction(work, source)
        );
        // 検証で消したことは、こちらの入口からでも伝える（設計書6.10.5）
        if (result.verifyNote) {
          void vscode.window.showInformationMessage(
            `矛盾検知が完了しました。指摘 ${result.issues.length}件 / ${result.verifyNote}。`
          );
        }
        return;
      }

      if (kind === "checkNotation") {
        const result = await checkNotation(work);
        if (!result || result.cancelled) return;
        proposalPanel.showResults(work, result.issues, "表記ゆれ");
        // **黙って終わらない。** 0件のときに理由を言わないと、作者は
        // 壊れていると受け取る（2026-08-21、作者の報告）
        void vscode.window.showInformationMessage(
          describeNotationResult(result)
        );
        return;
      }

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
      proposalPanel.showResults(work, result.issues);
      reportTypoCheckResult(
        kind === "checkTyposForFile"
          ? `${path.basename(filePath ?? "")} の誤字脱字検知`
          : "誤字脱字検知",
        result
      );
    },
    // 相談からの「AIで再読込」（設計書6.31.3）。
    // **設定資料パネルの再読込をそのまま呼ぶ。** ここで処理を書き直すと、
    // 画面のボタンから押したときと結果が食い違う
    reload: async (work, kind, recordId, notes) => {
      const panel = await openSettingsPanel(context, work, aiRegistry);
      await panel.reloadRecordFromChat(kind, recordId, notes);
    },
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
    await vscode.commands.executeCommand(
      "setContext",
      "novelai.focusChat",
      on
    );
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
   */
  async function setSoloView(view: string | undefined): Promise<void> {
    await vscode.commands.executeCommand(
      "setContext",
      "novelai.soloView",
      view
    );
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
  });
  chatter.start();
  context.subscriptions.push(chatter);

  // ─── ログの整理（設計書8.3） ───
  // **起動のときに1回だけ。** 書き込みのたびに全体を読み直すと、
  // 抽出のように何十回も書く処理が遅くなる。
  // 失敗しても何も言わない（整理できないことを知らせる必要はない）
  void pruneAllLogs(registry.list()).catch(() => undefined);

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
  async function registerFolderAsWork(folderPath: string): Promise<void> {
    // **書庫かもしれない。** 中に作品フォルダーが並んでいたら、
    // まとめて登録する（設計書5.7）。作品そのものならこれまで通り進む
    const collection = await tryRegisterAsCollection(registry, folderPath);
    if (collection.handled) {
      if (collection.added.length > 0) {
        treeProvider.refresh();
        highlighter.invalidate();
      }
      return;
    }

    const defaultTitle = path.basename(folderPath);
    const title = await askText({
      prompt: "作品名を入力してください",
      value: defaultTitle,
      validateInput: (v) =>
        v.trim().length === 0 ? "作品名を入力してください" : null,
    });
    if (title === undefined) return;

    let entry: WorkEntry | undefined;
    try {
      entry = await registry.addExisting(folderPath, title.trim());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(
        `作品フォルダを登録できませんでした。登録状態は変更されていません。\n${detail}`
      );
      return;
    }
    if (!entry) return;

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
  }

  context.subscriptions.push(
    registerCommand("novelai.addWork", async () => {
      // ブラウザ版では、開いているフォルダーから選ぶ（設計書5.8.8）
      const folderPath = await pickFolder(
        "作品フォルダを選択",
        "この作品フォルダを登録"
      );
      if (!folderPath) return;
      await registerFolderAsWork(folderPath);
    })
  );

  context.subscriptions.push(
    registerCommand("novelai.createWork", async () => {
      await createNewWork();
    })
  );

  // 操作メニューからは始め方を選んだ状態で入る。
  // 「プロットから開始」を押した作者に、もう一度「どちらから始めますか」と
  // 訊き返すのは失礼である
  context.subscriptions.push(
    registerCommand("novelai.createWorkWithPlot", async () => {
      await createNewWork("plot");
    }),
    registerCommand(
      "novelai.createWorkFromManuscript",
      async () => {
        await createNewWork("manuscript");
      }
    )
  );

  /**
   * 新規作品を作る。
   *
   * @param mode 始め方。渡されなければ作者に選んでもらう
   *   （コマンドパレットの「新規作品を作成」から来た場合）
   */
  async function createNewWork(mode?: WorkStartMode): Promise<void> {
    // ブラウザ版では、開いているフォルダーから選ぶ（設計書5.8.8）
    const parentPath = await pickFolder(
      "作品フォルダを作成する場所を選択",
      "ここに作品フォルダを作成"
    );
    if (!parentPath) return;

    const title = await askText({
      prompt: "作品名を入力してください（フォルダ名になります）",
      validateInput: (v) => {
        const t = v.trim();
        if (t.length === 0) return "作品名を入力してください";
        if (/[/\\:*?"<>|]/.test(t)) return "フォルダ名に使えない文字が含まれています";
        return null;
      },
    });
    if (!title) return;

    // 始め方はフォルダーを作る前に訊く。作ったあとで取り消されると、
    // 中身の無い作品フォルダーだけが残る
    const startMode = mode ?? (await chooseWorkStartMode(title.trim()));
    if (!startMode) return;

    const folderPath = path.join(parentPath, title.trim());
    try {
      await scaffoldWorkFolder(folderPath, title.trim(), {
        withPlot: startMode === "plot",
      });
    } catch (e) {
      vscode.window.showErrorMessage(
        `作品フォルダの作成に失敗しました: ${String(e)}`
      );
      return;
    }

    const entry = await registry.add(folderPath, title.trim());
    if (!entry) return;

    treeProvider.refresh();
    if (startMode === "plot") {
      await openPlotFile(entry);
      await startPlotAdvice(entry);
    } else {
      // 空の第1話を作ったら、執筆量の基準を置き直す（設計書6.3.2）。
      // **置き直さないと、作者が書いて最初に保存した分が消える**
      await createFirstEpisodeFile(entry, (work) => progress.rebaseline(work));
    }
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
    // 対話でプロットを埋める（設計書6.4.7）。**AIに筋書きを作らせず、
    // まだ書かれていない項目を1つずつ尋ねて引き出す**
    registerCommand(
      "novelai.plotInterview",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await workChatPanel.startPlotInterview(work);
      }
    ),
    registerCommand(
      "novelai.setPlotBasics",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await setPlotBasics(work);
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
            ? "相談のログはまだありません。AIに相談すると作られます。"
            : "相談のログは残さない設定になっています（novelai.chatLog.enabled）。";
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
            label: work.title,
            description: work.folderPath,
            work,
          })),
          // Escでも閉じられるが、それを知らない人には出口が無いように見える
          cancelItem(),
        ],
        { title: "簡単ステップメニューで使う作品" }
      );
      if (!picked || !("work" in picked)) return;
      stepProvider.selectWork(picked.work.id);
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
          const picked = await vscode.window.showInformationMessage(
            "意味検索が「切」になっています。切のままでも相談は語句一致で場面を探すので、索引は要りません。",
            open
          );
          if (picked === open) {
            await vscode.commands.executeCommand("novelai.setupVectorSearch");
          }
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
        vscode.window.showInformationMessage("索引を削除しました。");
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
      treeProvider.refresh(work.id);
      highlighter.invalidate();
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
                if (status.aheadHere > 0) {
                  return {
                    note:
                      `送信待ち ${status.aheadHere}件` +
                      (status.ahead !== status.aheadHere
                        ? `（置き場ぜんぶでは ${status.ahead}件）`
                        : ""),
                    order: status.aheadHere,
                  };
                }
                // **送信は置き場が単位で、1つ送ると同じ置き場の作品は
                // まとめて出ていく**（設計書5.7.9）。この作品ぶんが0でも
                // 送信そのものは動くので、「ありません」で終わらせない
                if (status.ahead > 0) {
                  return {
                    note: `この作品ぶんはありません（置き場ぜんぶでは送信待ち ${status.ahead}件）`,
                    order: 0,
                  };
                }
                return { note: "送信するものはありません", order: 0 };
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
      "novelai.showWorkStats",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        const result = await scanWork(work);
        const t = result.stats.totals;
        const lines = [
          `作品: ${work.title}`,
          `ファイル数: ${result.stats.fileCount}`,
          `純文字数: ${formatCount(t.net)} 字`,
          `総文字数: ${formatCount(t.gross)} 字`,
          `段落数: ${formatCount(t.paragraphs)}`,
          `原稿用紙換算: 約 ${formatCount(toManuscriptPages(t.manuscriptLines))} 枚`,
        ];
        const action = await vscode.window.showInformationMessage(
          lines.join("  /  "),
          { modal: true },
          "執筆量を見る"
        );
        if (action === "執筆量を見る") {
          await openWritingStatsPanel(context, work, deviceId);
        }
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.showWritingStats",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await openWritingStatsPanel(context, work, deviceId);
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
      if (!work) return;
      await createEpisodePlot(work);
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
        const ext = cfg.get<string>("episodeFileExtension", ".txt");

        // SNS記事は投稿日で管理する（設計書6.4.6）。**同じ日に何本でも書ける**ので、
        // 今日の日付が埋まっていれば `_2`, `_3` と番号を足す
        const format = await readWorkFormat(work);
        const defaultName =
          format === "sns"
            ? `${nextDatedName(parsed, statsDayKey(new Date(), boundaryHour()))}${ext}`
            : `${formatChapterNumber(next, digits)}${ext}`;
        const fileName = await askText({
          prompt:
            format === "sns" ? "新規投稿ファイルの名前" : "新規話数ファイルの名前",
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
          new TextEncoder().encode("")
        );

        treeProvider.refresh(work.id);
        // **執筆量の基準を置き直す**（設計書6.3.2）。記録は「ファイル数が
        // 変わった回は数えない」ので、置き直さないと、このあと作者が書いて
        // 保存した回がその決まりに当たり「今日 +0字」になって消える
        await progress.rebaseline(work);
        // **本文は原稿エディタ（横書き）で開く**（作者の指定、2026-08-29。
        // 作品一覧のクリックと同じ既定に揃える）
        await vscode.commands.executeCommand(
          "vscode.openWith",
          path.toUri(filePath),
          MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
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
    // 実際に読める長さの測定（設計書6.27.11）。作品は要らない
    registerCommand("novelai.measureContext", async () => {
      const { measureContext } = await import("./features/measureContext.js");
      await measureContext(aiRegistry);
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
              if (freshness.stale) {
                return { note: "設定資料が辞書より新しい", order: 1 };
              }
              // 一度も書き出していない作品は「古い」と言わない（催促にならない
              // ため、印でも数えていない）。ただし**この場面では判断材料になる**
              // ので、書き出し済みかどうかは伝える。並び順は上げない
              return {
                note: freshness.exported
                  ? "書き出し済み"
                  : "まだ書き出していない",
                order: 0,
              };
            } catch {
              // 読めない作品は無印で返す。補足が出ないだけで実害はない
              return {};
            }
          },
        });
        if (!work) return;
        await exportImeDictionary(work);
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
        if (!work) return;
        await applyPendingCharacterUpdates(work, proposalPanel);
        treeProvider.refresh(work.id);
        // 名前や別名が変われば、本文で光る範囲も変わる
        highlighter.invalidate();
        // 承認待ちが減ったので、操作メニューの件数を数え直す
        refreshActionBadges();
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
        if (!work) return;
        await unifyCharacterRecords(work);
        treeProvider.refresh(work.id);
        // まとめた側の名前は別名になる。索引を作り直さないと光らないままになる
        highlighter.invalidate();
        // 開いたままのパネルは自分では気づかない。
        // 消えたはずの人物が一覧に残り続ける
        await findOpenSettingsPanel(work.id)?.refreshFromDisk();
        refreshActionBadges();
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
        if (!work) return;
        await openSettingsPanel(context, work, aiRegistry);
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
        if (!work) return;

        if (!(await saveDirtyDocumentsBeforeExtraction(work))) return;

        const extracted = await extractCharacters(work, aiRegistry);
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
        }
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.manageKeepWords",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await manageKeepWords(work);
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
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文から伏線を拾ってしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "伏線の検知"))) {
          return;
        }

        const result = await withPanelProgress(
          work,
          "伏線を検知",
          (onProgress) => checkForeshadows(work, aiRegistry, { onProgress })
        );
        if (!result || result.cancelled) return;

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
        vscode.window.showInformationMessage(
          `伏線の検知が完了しました。${parts.join(" / ")}。` +
            (result.candidates.length > 0
              ? "台帳へはまだ入れていません。 「提案」パネルで登録するものを選んでください。"
              : "")
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkForeshadowResolution",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文で回収を判定してしまう
        if (
          !(await saveDirtyDocumentsBeforeExtraction(work, "伏線の回収の確認"))
        ) {
          return;
        }

        const result = await withPanelProgress(
          work,
          "伏線の回収を確認",
          (onProgress) =>
            checkForeshadowResolution(work, aiRegistry, { onProgress }),
          "か所"
        );
        if (!result || result.cancelled) return;

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
        vscode.window.showInformationMessage(
          `伏線の回収の確認が完了しました。${parts.join(" / ")}。` +
            (result.proposals.length > 0
              ? "台帳はまだ変えていません。 「提案」パネルで確かめてから決めてください。"
              : "")
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkTypos",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文を検知してしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "誤字脱字の検知")))
          return;

        // **前回から書いた分だけに絞れる**（設計書6.8.7）。
        // 聞く意味があるときだけ聞く（一度も検知していない・全部が対象・
        // 1件も無い、のいずれでも聞かない）
        const scope = await chooseScope(work);
        if (!scope) return;

        const result = await withPanelProgress(
          work,
          "誤字脱字を検知",
          (onProgress) =>
            checkTypos(work, aiRegistry, {
              filePaths: scope.filePaths,
              onProgress,
            })
        );
        if (!result) return;

        // **絞って見たときも「検知した」と記録する。**
        // 記録しないと、次回また同じ話が「前回から書いた分」に出る
        await recordCheck(work);

        proposalPanel.showResults(work, result.issues);
        reportTypoCheckResult(
          scope.kind === "changed" ? "誤字脱字検知（前回から書いた分）" : "誤字脱字検知",
          result
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkNotation",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文を数えてしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "表記ゆれの検知")))
          return;

        const result = await checkNotation(work);
        if (!result || result.cancelled) return;

        proposalPanel.showResults(work, result.issues, "表記ゆれ");

        if (result.groupCount === 0) return;
        const parts = [`${result.groupCount}組を検出`];
        if (result.unifiedCount > 0) {
          parts.push(`${result.unifiedCount}組を揃える`);
        }
        parts.push(`指摘 ${result.issues.length}件`);
        if (result.dismissedCount > 0) {
          parts.push(`無視済み ${result.dismissedCount}件を除外`);
        }
        vscode.window.showInformationMessage(
          `表記ゆれ検知が完了しました。${parts.join(" / ")}`
        );
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
      if (!work) return;
      await openNameCheckPanel(context, work, {
        registry: aiRegistry,
        // 「登場箇所」は提案パネルの「本文を見る」と同じ道を通す
        revealInManuscript: (filePath, line) =>
          manuscriptProvider.revealLine(filePath, line),
        startRename: (target, characterId, suggested) =>
          runRenameFlow(target, characterId, suggested),
      });
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
        const remaining = proposalPanel.remainingIn(work.id, "名前の付け替え");
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
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文を照らしてしまう
        if (
          !(await saveDirtyDocumentsBeforeExtraction(work, "プロット逸脱の検知"))
        ) {
          return;
        }

        const result = await withPanelProgress(
          work,
          "プロット逸脱を検知",
          (onProgress) => checkDeviations(work, aiRegistry, { onProgress }),
          "話"
        );
        if (!result || result.cancelled) return;

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
        vscode.window.showInformationMessage(
          `プロット逸脱の検知が完了しました。${parts.join(" / ")}。` +
            (result.issues.length > 0
              ? "本文は書き換えていません。 プロットのほうが古いこともあります。"
              : "")
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkProofread",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文を推敲してしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "推敲"))) return;

        const result = await withPanelProgress(work, "推敲", (onProgress) =>
          checkProofread(work, aiRegistry, { onProgress })
        );
        if (!result || result.cancelled) return;

        proposalPanel.showResults(work, result.issues, "推敲");

        const parts = [`指摘 ${result.issues.length}件`];
        if (result.overBudgetCount > 0) {
          // 黙って絞ると「これで全部」と受け取られる
          parts.push(`多すぎたぶん ${result.overBudgetCount}件を絞り込み`);
        }
        if (result.failedChunks > 0) {
          parts.push(`読み取れなかった ${result.failedChunks}件`);
        }
        vscode.window.showInformationMessage(
          `推敲が完了しました。${parts.join(" / ")}。`
        );
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkOpening",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う冒頭を診断してしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "冒頭診断"))) return;

        // **完了の通知を出さない。** 結果そのものが文書として開くので、
        // 「できました」を重ねると画面の手前に確認が1枚増えるだけになる
        await checkOpening(work, aiRegistry);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.checkContradictions",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文を突き合わせてしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "矛盾検知"))) return;

        const result = await withPanelProgress(
          work,
          "矛盾を検知",
          (onProgress, stage) =>
            checkContradictions(work, aiRegistry, {
              onProgress,
              // 検証はAIを1件ずつ呼ぶので、別の札で件数を流す
              onVerifyProgress: stage("検出した矛盾を検証", "件"),
            })
        );
        if (!result || result.cancelled) return;

        // 矛盾が実は伏線だったときの逃げ道を添える（設計書6.35.4）
        proposalPanel.showContradictions(work, result.issues, (source) =>
          registerForeshadowFromContradiction(work, source)
        );

        const parts = [`指摘 ${result.issues.length}件`];
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
        vscode.window.showInformationMessage(
          `矛盾検知が完了しました。${parts.join(" / ")}。` +
            (result.issues.length > 0
              ? "本文は書き換えていません。 設定と本文のどちらを直すかは作者が決めてください。"
              : "")
        );
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

        proposalPanel.showResults(work, result.issues);
        reportTypoCheckResult(`${node.episode.fileName} の誤字脱字検知`, result);
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
        vscode.window.showInformationMessage(
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
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文からあらすじを作ってしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work))) return;

        const generated = await generateSynopses(work, aiRegistry);
        // サブタイトルの承認でファイル名が変わることがある
        treeProvider.refresh(work.id);

        // JSONのままでは作者が読めない。読める資料まで作って初めて完成する
        if (generated) {
          await generateSettingsDocs(work, { silent: true });
        }
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
        if (!work) return;
        await generateWorkBlurb(work, aiRegistry);
      }
    )
  );

  context.subscriptions.push(
    registerCommand(
      "novelai.generateCatchphrases",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await generateCatchphrases(work, aiRegistry);
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
    registerCommand("novelai.copyForPosting", copyForPosting),
    registerCommand("novelai.importRuby", importRuby)
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
            return {
              note: count > 0 ? `未処理の提案 ${count}件` : "未処理なし",
              order: count,
            };
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
        await copyBodyForPosting(node.episode);
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

  context.subscriptions.push(
    registerCommand("novelai.switchMode", async () => {
      await switchMode();
      // 押せる操作が変わるので、メニューを作り直す
      actionProvider.refresh();
    })
  );

  // 起動時に一度だけ全作品の同期状態を確かめる（設計書5.5.1）。
  // await しないのは、回線が遅い環境で拡張機能の起動を待たせないため。
  // fetchは取得のみなので、途中で終わってもローカルには何も起きない
  void gitSync.refreshAll({ fetch: true });

  // **はじめて開いたときだけ、使うAIを選んでもらう**（作者の指示、2026-08-19）。
  // await しないのは、選び終わるまで拡張機能の初期化が止まるのを避けるため
  void offerFirstRunSetupInVsCode(context, aiRegistry);

  // **VS Code 標準のMarkdownプレビューへ差し込む**（設計書6.12）。
  // 独自のプレビュー画面を作らないのは、作者が既に使っている
  // プレビュー（Ctrl+Shift+V）でそのまま見えるほうが良いため
  return {
    extendMarkdownIt<T extends MarkdownItLike>(md: T): T {
      return extendMarkdownItWithRuby(md);
    },
  };
}

export function deactivate(): void {
  // 後片付けは context.subscriptions に任せる。
  // ログだけは遅延生成でsubscriptionsに載っていないので個別に閉じる
  disposeLog();
}

/**
 * そのファイルが属する作品を探す。
 * 深い作品フォルダを先に見て、入れ子の場合は内側を選ぶ。
 */
function findWorkForPath(
  registry: WorkRegistry,
  filePath: string
): WorkEntry | undefined {
  const normalize = (value: string) => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return [...registry.list()]
    .sort((a, b) => b.folderPath.length - a.folderPath.length)
    .find((work) => {
      const normalizedWork = normalize(work.folderPath);
      const relative = path.relative(normalizedWork, normalize(filePath));
      return relative.length > 0 && !path.goesOutside(normalizedWork, relative);
    });
}

/** 誤字脱字検知の結果を要約して通知する。作品全体・1話単位のどちらからも呼ぶ */
function reportTypoCheckResult(label: string, result: TypoCheckRunResult): void {
  const parts = [`指摘 ${result.issues.length}件`];
  if (result.failedChunks > 0) parts.push(`失敗 ${result.failedChunks}チャンク`);
  if (result.rejectedCount > 0) parts.push(`除外 ${result.rejectedCount}件`);
  vscode.window.showInformationMessage(`${label}が完了しました。${parts.join(" / ")}`);
}

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
  if (works.length === 1) return works[0];

  const title = options.title ?? "作品を選択";
  if (!options.annotate) {
    const picked = await vscode.window.showQuickPick(
      [
        ...works.map((w) => ({
          label: w.title,
          description: w.folderPath,
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
  const items = works
    .map((work, index) => ({
      label: work.title,
      description: notes[index].note ?? "",
      detail: work.folderPath,
      order: notes[index].order ?? 0,
      work,
    }))
    // 溜まっている作品を上に出す。作者はたいていそれを選びたい
    .sort((left, right) => right.order - left.order);

  const picked = await vscode.window.showQuickPick(
    [...items, cancelItem()],
    { title }
  );
  return picked && "work" in picked ? picked.work : undefined;
}
