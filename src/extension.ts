import * as vscode from "vscode";
import * as path from "path";
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
import { selectOllamaExecutable } from "./features/selectOllamaExecutable";
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
  findOpenSettingsPanel,
  openSettingsPanel,
} from "./features/settingsPanel";
import { unifyCharacterRecords } from "./features/unifyCharacters";
import { findMergeCandidates } from "./core/characterMerge";
import { CharacterStore } from "./core/characterStore";
import type { ChatRunKind } from "./core/chatEdit";
import { applyPendingCharacterUpdates } from "./features/applyPendingUpdates";
import { exportImeDictionary } from "./features/exportImeDictionary";
import { manageCustomFields } from "./features/manageCustomFields";
import { TermHighlighter } from "./views/termHighlight";
import { ActionListProvider, nodeKey } from "./views/actionList";
import { ActionDecorationProvider } from "./views/actionDecorations";
import { PendingUpdateStore } from "./core/pendingUpdates";
import { addWorkFromGithub } from "./features/addWorkFromGithub";
import { restoreFromHistory } from "./features/gitRestore";
import { setupOllama } from "./features/setupOllama";
import { setupVectorSearch } from "./features/setupVectorSearch";
import { runFullSetup } from "./features/setupWizard";
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
import {
  GitSyncMonitor,
  describeStatus,
  describeSyncBadge,
  showGitSyncActions,
} from "./features/gitSync";
import { nextSetupStep, runSetupStep } from "./features/gitOnboarding";
import { resolveDeviceId } from "./core/device";
import {
  SessionStore,
  describeOtherDeviceSession,
} from "./core/sessionStore";
import {
  CONFLICT_SCHEME,
  ConflictContentProvider,
  resolveWorkConflicts,
} from "./features/resolveConflicts";
import { checkTypos, type TypoCheckRunResult } from "./features/checkTypos";
import { checkNotation } from "./features/checkNotation";
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
import { askText } from "./views/dialogs";
import { manageKeepWords } from "./features/manageKeepWords";
import {
  extendMarkdownItWithRuby,
  type MarkdownItLike,
} from "./core/markdownItRuby";
import { addRuby, copyForPosting, importRuby } from "./features/ruby";
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

/** 操作メニューで開いている分類の記憶先 */
const ACTION_GROUPS_KEY = "novelai.actions.expandedGroups";

export async function activate(
  context: vscode.ExtensionContext
): Promise<{ extendMarkdownIt<T extends MarkdownItLike>(md: T): T }> {
  const registry = new WorkRegistry(context);
  await registry.initialize();

  // GitHub同期の見張り。自動で走るのはfetch（取得のみ）だけで、
  // 取り込み・送信は作者がボタンを押したときにしか実行しない（設計書5.5.1）
  const gitSync = new GitSyncMonitor(registry);
  context.subscriptions.push(gitSync);

  const treeProvider = new WorkTreeProvider(registry, (workId) =>
    describeSyncBadge(gitSync.statusFor(workId))
  );
  // 同期状態が変わっても本文は変わらないので、再走査はせず描き直すだけにする
  gitSync.onDidChange(() => treeProvider.redraw());
  const aiRegistry = new AIRegistry(context);

  // 端末ID。「どの環境で書いたか」を区別するのに使う（設計書5.5.2）。
  // Gitへは同期しない。全環境が同じIDを名乗ると区別できなくなる
  const deviceId = await resolveDeviceId(context.globalState);

  // 執筆量の記録（設計書6.3）。走査は作品一覧の結果を借りるので、
  // 保存のたびにファイルを2度読むことはない
  const progress = new WritingProgressTracker(deviceId, (work) =>
    treeProvider.getStats(work)
  );

  // 競合の見比べに使う読み取り専用の本文置き場
  const conflictProvider = new ConflictContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      CONFLICT_SCHEME,
      conflictProvider
    ),
    { dispose: () => conflictProvider.clear() }
  );

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
      findOpenSettingsPanel(found.work.id)?.showRecord(
        found.entry.kind,
        found.entry.id
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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
        panel.showRecord(found.entry.kind, found.entry.id);
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

  /** 未反映の件数を数え直す。抽出・反映のあとに呼ぶ */
  const refreshActionBadges = (): void => {
    void actionDecorations.refresh().then(() => actionProvider.refresh());
  };
  // 起動直後にも数える。前回の抽出で溜まったままのことがある
  refreshActionBadges();
  registry.onDidChange(() => refreshActionBadges());

  // 提案パネル（下段・出力やデバッグコンソールと同じ場所）。
  // 誤字脱字検知の結果をここへ表示する。設定資料パネルと違い
  // 作品ごとには分けず、直近に検知した作品の結果を1枚で見せる
  const proposalPanel = new ProposalPanel();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PROPOSALS_VIEW_ID, proposalPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

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
        const result = await checkDeviations(work, aiRegistry);
        if (!result || result.cancelled) return;
        proposalPanel.showDeviations(work, result.issues);
        return;
      }

      if (kind === "checkProofread") {
        const result = await checkProofread(work, aiRegistry);
        if (!result || result.cancelled) return;
        proposalPanel.showResults(work, result.issues, "推敲");
        return;
      }

      if (kind === "checkContradictions") {
        const result = await checkContradictions(work, aiRegistry);
        if (!result || result.cancelled) return;
        proposalPanel.showContradictions(work, result.issues);
        return;
      }

      if (kind === "checkNotation") {
        const result = await checkNotation(work);
        if (!result || result.cancelled) return;
        proposalPanel.showResults(work, result.issues, "表記ゆれ");
        return;
      }

      const result = await checkTypos(
        work,
        aiRegistry,
        kind === "checkTyposForFile" && filePath
          ? { filePaths: [filePath] }
          : {}
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
    vscode.commands.registerCommand("novelai.openChat", async () => {
      // 呼ぶ前に、今開いている本文を確実に覚えさせる。
      // このコマンド自体はエディターのフォーカスを奪わないが、
      // パネルを開いた時点で activeTextEditor は取れなくなる
      workChatPanel.trackEditor(vscode.window.activeTextEditor);
      await vscode.commands.executeCommand(`${WORK_CHAT_VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("novelai.exitChatFocus", async () => {
      await setChatFocus(false);
    })
  );

  /**
   * 相談に集中する表示にする／戻す（設計書6.21.2）。
   *
   * 作品一覧と操作メニューを引っ込め、相談パネルへ場所を譲る。
   * `package.json` のビューの `when` が、この印を見て出し入れする。
   *
   * **戻す口を必ず用意する。** 消えたまま戻し方が分からないと、
   * 拡張機能が壊れたようにしか見えない。相談パネルの見出しに
   * 「作品一覧と操作メニューを出す」ボタンが出る。
   */
  async function setChatFocus(on: boolean): Promise<void> {
    await vscode.commands.executeCommand(
      "setContext",
      "novelai.focusChat",
      on
    );
  }

  // ─── AIの独り言（設計書6.21） ───
  const chatter = new ChatterService({
    resolveAi: () => {
      const resolved = aiRegistry.resolve();
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

    const cfg = vscode.workspace.getConfiguration("novelai");
    const mode = cfg.get<string>("countMode", "net");
    const excludeRuby = cfg.get<boolean>("excludeRubyFromCount", true);

    const counts = countChars(
      editor.document.getText(),
      ext === ".md" ? excludeRuby : false
    );
    const value = mode === "gross" ? counts.gross : counts.net;
    const label = mode === "gross" ? "総" : "";

    // 選択範囲があればその文字数も出す
    const sel = editor.selection;
    let selectionPart = "";
    if (!sel.isEmpty) {
      const selCounts = countChars(
        editor.document.getText(sel),
        ext === ".md" ? excludeRuby : false
      );
      const selValue = mode === "gross" ? selCounts.gross : selCounts.net;
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
    const showProgress = cfg.get<boolean>("stats.showInStatusBar", true);
    const work = showProgress
      ? findWorkForPath(registry, editor.document.uri.fsPath)
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
      void recordEditedSession(document.uri.fsPath);
      // 保存した瞬間が、書いた量を数えられる唯一の機会である（設計書6.3）
      void recordWritingProgress(document.uri.fsPath);
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
      const work = findWorkForPath(registry, editor.document.uri.fsPath);
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

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.addWork", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "この作品フォルダを登録",
        title: "作品フォルダを選択",
      });
      if (!picked || picked.length === 0) return;

      const folderPath = picked[0].fsPath;
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

      const result = await scanWork(entry);
      vscode.window.showInformationMessage(
        `「${entry.title}」を登録しました（${result.stats.fileCount}ファイル / ${formatCount(
          result.stats.totals.net
        )}字）`
      );
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.createWork", async () => {
      await createNewWork();
    })
  );

  // 操作メニューからは始め方を選んだ状態で入る。
  // 「プロットから開始」を押した作者に、もう一度「どちらから始めますか」と
  // 訊き返すのは失礼である
  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.createWorkWithPlot", async () => {
      await createNewWork("plot");
    }),
    vscode.commands.registerCommand(
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
    const parent = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "ここに作品フォルダを作成",
      title: "作品フォルダを作成する場所を選択",
    });
    if (!parent || parent.length === 0) return;

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

    const folderPath = path.join(parent[0].fsPath, title.trim());
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
      await createFirstEpisodeFile(entry);
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
    vscode.commands.registerCommand(
      "novelai.createPlot",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await openPlotFile(work);
      }
    ),
    vscode.commands.registerCommand(
      "novelai.setPlotBasics",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await setPlotBasics(work);
      }
    ),
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand("novelai.addWorkFromGithub", async () => {
      const entry = await addWorkFromGithub(registry);
      if (!entry) return;
      treeProvider.refresh();
      // 取り寄せた作品の設定が用語ハイライトの材料になる
      highlighter.invalidate();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.gitRestore",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await restoreFromHistory(work);
        // 原稿が入れ替わったので、文字数もハイライトも作り直す
        treeProvider.refresh(work.id);
        highlighter.invalidate();
        refreshActionBadges();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.setupGithub",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        // 状態を見てから、足りない一手だけを案内する（設計書5.5.4）
        const status = await gitSync.refresh(work, {
          fetch: false,
          notify: false,
        });
        const step = nextSetupStep(status);
        if (!step) {
          vscode.window.showInformationMessage(
            `「${work.title}」の同期の準備はすでに整っています。${describeStatus(status)}`
          );
          return;
        }
        if (await runSetupStep(work, status)) {
          await gitSync.refresh(work, { fetch: true, notify: false });
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.setupOllama", async () => {
      await setupOllama(aiRegistry);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.runFullSetup", async () => {
      await runFullSetup(aiRegistry);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.openChatLog",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        const file = chatLogPath(work);
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(file));
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
          vscode.Uri.file(file)
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.setupVectorSearch", async () => {
      await setupVectorSearch();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.showVersion", async () => {
      await showVersion(context, aiRegistry);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.chooseChatWork", async () => {
      await workChatPanel.chooseWork();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand("novelai.openExtensionSettings", async () => {
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
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand("novelai.refresh", () => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.gitSync",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await showGitSyncActions(gitSync, work);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.resolveConflicts",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
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
    vscode.commands.registerCommand(
      "novelai.gitPull",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
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
    vscode.commands.registerCommand(
      "novelai.gitPush",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
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
    vscode.commands.registerCommand(
      "novelai.openWorkFolder",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(work.folderPath)
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand(
      "novelai.showWritingStats",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await openWritingStatsPanel(context, work, deviceId);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.showAllWorksWritingStats", async () => {
      await openAllWorksWritingStatsPanel(context, registry, deviceId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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
          vscode.Uri.file(filePath),
          new TextEncoder().encode("")
        );

        treeProvider.refresh(work.id);
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(filePath)
        );
        await vscode.window.showTextDocument(doc);
      }
    )
  );

  // ─── AI関連コマンド ───

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.setupAI", async () => {
      await runSetupWizard(aiRegistry);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.showLog", () => {
      showLog();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.exportImeDictionary",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await exportImeDictionary(work);
        // 書き出したので「辞書が古い」の印を消す。
        // 残ったままだと、押しても消えない印を作者が気にし続けることになる
        refreshActionBadges();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.manageCustomFields",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await manageCustomFields(work);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand(
      "novelai.unifyCharacters",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
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
    vscode.commands.registerCommand(
      "novelai.selectOllamaExecutable",
      async () => {
        await selectOllamaExecutable();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.openSettingsPanel",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await openSettingsPanel(context, work, aiRegistry);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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
      vscode.commands.registerCommand(command, async (node?: WorkNode) => {
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
      vscode.commands.registerCommand(command, async (node?: WorkNode) => {
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
    vscode.commands.registerCommand("novelai.testAI", async () => {
      const resolved = aiRegistry.resolve();
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

      const info = await aiRegistry.resolveModelInfo();
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
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand(
      "novelai.manageKeepWords",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await manageKeepWords(work);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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

        const result = await checkTypos(work, aiRegistry, {
          filePaths: scope.filePaths,
        });
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
    vscode.commands.registerCommand(
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

  context.subscriptions.push(
    vscode.commands.registerCommand(
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

        const result = await checkDeviations(work, aiRegistry);
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
        vscode.window.showInformationMessage(
          `プロット逸脱の検知が完了しました。${parts.join(" / ")}。` +
            (result.issues.length > 0
              ? "**本文は書き換えていません。** プロットのほうが古いこともあります。"
              : "")
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.checkProofread",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文を推敲してしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "推敲"))) return;

        const result = await checkProofread(work, aiRegistry);
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
    vscode.commands.registerCommand(
      "novelai.checkContradictions",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存のまま読むと、画面と違う本文を突き合わせてしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "矛盾検知"))) return;

        const result = await checkContradictions(work, aiRegistry);
        if (!result || result.cancelled) return;

        proposalPanel.showContradictions(work, result.issues);

        const parts = [`指摘 ${result.issues.length}件`];
        if (result.rejectedCount > 0) {
          // 本文に無い箇所を「引用」してくることがある。黙って捨てない
          parts.push(`本文と合わない指摘 ${result.rejectedCount}件を除外`);
        }
        if (result.failedChunks > 0) {
          parts.push(`読み取れなかった ${result.failedChunks}件`);
        }
        vscode.window.showInformationMessage(
          `矛盾検知が完了しました。${parts.join(" / ")}。` +
            (result.issues.length > 0
              ? "**本文は書き換えていません。** 設定と本文のどちらを直すかは作者が決めてください。"
              : "")
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.checkTyposForFile",
      async (node?: EpisodeNode) => {
        if (!node) return;
        const work = node.work;

        // 未保存のまま読むと、画面と違う本文を検知してしまう
        if (!(await saveDirtyDocumentsBeforeExtraction(work, "誤字脱字の検知")))
          return;

        const result = await checkTypos(work, aiRegistry, {
          filePaths: [node.episode.filePath],
        });
        if (!result) return;

        proposalPanel.showResults(work, result.issues);
        reportTypoCheckResult(`${node.episode.fileName} の誤字脱字検知`, result);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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
            vscode.Uri.file(node.episode.filePath),
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
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand(
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
            vscode.Uri.file(file)
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
                vscode.Uri.file(file)
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
        const picked = await vscode.window.showQuickPick(items, {
          title: `${work.title} の紹介文・あらすじ`,
          placeHolder:
            missing.length === 0
              ? "開くものを選んでください"
              : `${missing.join("・")}はまだありません`,
        });
        if (!picked) return;
        await picked.run();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.generateWorkBlurb",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await generateWorkBlurb(work, aiRegistry);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.generateCatchphrases",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await generateCatchphrases(work, aiRegistry);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.addRuby", addRuby),
    vscode.commands.registerCommand("novelai.copyForPosting", copyForPosting),
    vscode.commands.registerCommand("novelai.importRuby", importRuby)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.showEditHistory",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await showEditHistory(context, work);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.reviewProposals",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await reviewProposals(work, proposalPanel);
      }
    ),
    vscode.commands.registerCommand(
      "novelai.toggleReviewLock",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;
        await toggleReviewLock(work);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand(
      "novelai.copySubtitle",
      async (node?: EpisodeNode) => {
        if (node) await copySubtitle(node.episode);
      }
    ),
    vscode.commands.registerCommand(
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
    vscode.commands.registerCommand(
      "novelai.renameWithSubtitle",
      async (node?: EpisodeNode) => {
        if (!node) return;
        await renameWithSubtitle(node.work, node.episode);
        treeProvider.refresh(node.work.id);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.switchMode", async () => {
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
      const relative = path.relative(
        normalize(work.folderPath),
        normalize(filePath)
      );
      return (
        relative.length > 0 &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
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
      works.map((w) => ({ label: w.title, description: w.folderPath, work: w })),
      { title }
    );
    return picked?.work;
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

  const picked = await vscode.window.showQuickPick(items, { title });
  return picked?.work;
}
