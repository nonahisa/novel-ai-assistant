import * as vscode from "vscode";
import * as path from "path";
import {
  WorkRegistry,
  readWorkConfig,
  scaffoldWorkFolder,
  workPaths,
} from "./core/workRegistry";
import { WorkTreeProvider, WorkNode, EpisodeNode } from "./views/workTree";
import {
  countChars,
  formatCount,
  toManuscriptPages,
} from "./core/charCount";
import {
  formatChapterNumber,
  nextChapterNumber,
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
import { generateSettingsDocs } from "./features/generateSettingsDocs";
import {
  findOpenSettingsPanel,
  openSettingsPanel,
} from "./features/settingsPanel";
import { unifyCharacterRecords } from "./features/unifyCharacters";
import { applyPendingCharacterUpdates } from "./features/applyPendingUpdates";
import { exportImeDictionary } from "./features/exportImeDictionary";
import { manageCustomFields } from "./features/manageCustomFields";
import { TermHighlighter } from "./views/termHighlight";
import { ActionListProvider } from "./views/actionList";
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
import { setWriteObserver } from "./core/atomicWrite";
import {
  GitSyncMonitor,
  describeStatus,
  describeSyncBadge,
  showGitSyncActions,
} from "./features/gitSync";
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

/** 操作メニューで開いている分類の記憶先 */
const ACTION_GROUPS_KEY = "novelai.actions.expandedGroups";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const registry = new WorkRegistry(context);
  await registry.initialize();

  // GitHub同期の見張り。自動で走るのはfetch（取得のみ）だけで、
  // 取り込み・送信は作者がボタンを押したときにしか実行しない（設計書3.5.1）
  const gitSync = new GitSyncMonitor(registry);
  context.subscriptions.push(gitSync);

  const treeProvider = new WorkTreeProvider(registry, (workId) =>
    describeSyncBadge(gitSync.statusFor(workId))
  );
  // 同期状態が変わっても本文は変わらないので、再走査はせず描き直すだけにする
  gitSync.onDidChange(() => treeProvider.redraw());
  const aiRegistry = new AIRegistry(context);

  // 端末ID。「どの環境で書いたか」を区別するのに使う（設計書3.5.2）。
  // Gitへは同期しない。全環境が同じIDを名乗ると区別できなくなる
  const deviceId = await resolveDeviceId(context.globalState);

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

  // コマンドパレットにしかない操作は作者が存在に気づけないため、分類して一覧に出す。
  // 分類の開閉は作品をまたいで同じでよいので globalState に置く
  const actionProvider = new ActionListProvider(registry, {
    get: () => context.globalState.get<string[]>(ACTION_GROUPS_KEY, []),
    set: (groups) => void context.globalState.update(ACTION_GROUPS_KEY, groups),
  });
  const actionView = vscode.window.createTreeView("novelai.actions", {
    treeDataProvider: actionProvider,
  });
  // 画面での開閉を控えて次回に引き継ぐ。
  // VS Code は collapsibleState を作った時点の値でしか描かないため、
  // こちら側で覚えておかないと再読み込みで既定へ戻る
  actionView.onDidExpandElement((event) => {
    if (event.element.type === "group") {
      actionProvider.setExpanded(event.element.group, true);
    }
  });
  actionView.onDidCollapseElement((event) => {
    if (event.element.type === "group") {
      actionProvider.setExpanded(event.element.group, false);
    }
  });
  context.subscriptions.push(actionView);

  // ─── ステータスバー（現在開いているファイルの文字数） ───
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.tooltip = "小説AI執筆補助: 現在のファイルの文字数";
  context.subscriptions.push(statusBar);

  const updateStatusBar = () => {
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

    statusBar.text = `$(book) ${label}${formatCount(value)}字${selectionPart}`;
    statusBar.tooltip = new vscode.MarkdownString(
      [
        `**${path.basename(editor.document.fileName)}**`,
        "",
        `- 純文字数: ${formatCount(counts.net)} 字`,
        `- 総文字数: ${formatCount(counts.gross)} 字`,
        `- 段落数: ${counts.paragraphs}`,
        `- 原稿用紙換算: 約 ${formatCount(toManuscriptPages(counts.manuscriptLines))} 枚`,
      ].join("\n")
    );
    statusBar.show();
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
      treeProvider.refresh();
      // 「直前にどの環境で書いていたか」を残す（設計書3.5.2）。
      // 開いただけでは書かない。何も書いていないのに作業ツリーが汚れ、
      // 未コミットの変更を理由に取り込みが止まるようになるため
      void recordEditedSession(document.uri.fsPath);
    })
  );
  updateStatusBar();

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
   * 別の環境が最近書いていたら知らせる（設計書3.5.2）。
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
      const title = await vscode.window.showInputBox({
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
      const parent = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "ここに作品フォルダを作成",
        title: "作品フォルダを作成する場所を選択",
      });
      if (!parent || parent.length === 0) return;

      const title = await vscode.window.showInputBox({
        prompt: "作品名を入力してください（フォルダ名になります）",
        validateInput: (v) => {
          const t = v.trim();
          if (t.length === 0) return "作品名を入力してください";
          if (/[/\\:*?"<>|]/.test(t)) return "フォルダ名に使えない文字が含まれています";
          return null;
        },
      });
      if (!title) return;

      const folderPath = path.join(parent[0].fsPath, title.trim());
      try {
        await scaffoldWorkFolder(folderPath, title.trim());
      } catch (e) {
        vscode.window.showErrorMessage(
          `作品フォルダの作成に失敗しました: ${String(e)}`
        );
        return;
      }

      const entry = await registry.add(folderPath, title.trim());
      if (!entry) return;

      treeProvider.refresh();
      const open = await vscode.window.showInformationMessage(
        `「${title.trim()}」を作成しました。プロットから始めますか？`,
        "plot.mdを開く",
        "後で"
      );
      if (open === "plot.mdを開く") {
        const plotPath = path.join(folderPath, "設定", "plot.md");
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(plotPath)
        );
        await vscode.window.showTextDocument(doc);
      }
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
  // 古い文字数・古いハイライトを見せ続けないようにする（設計書3.5.8）
  context.subscriptions.push(
    gitSync.onDidChangeFiles(({ work }) => {
      treeProvider.refresh(work.id);
      highlighter.invalidate();
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
        await vscode.window.showInformationMessage(lines.join("  /  "), {
          modal: true,
        });
      }
    )
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

        const defaultName = `${formatChapterNumber(next, digits)}${ext}`;
        const fileName = await vscode.window.showInputBox({
          prompt: "新規話数ファイルの名前",
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
        const work = await resolveWork(node, registry);
        if (!work) return;
        await applyPendingCharacterUpdates(work);
        treeProvider.refresh(work.id);
        // 名前や別名が変われば、本文で光る範囲も変わる
        highlighter.invalidate();
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

  context.subscriptions.push(
    vscode.commands.registerCommand("novelai.testAI", async () => {
      const resolved = aiRegistry.resolve();
      if (!resolved) {
        vscode.window.showInformationMessage(
          "AIが設定されていません。「AIの設定」から設定してください。"
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

  // 起動時に一度だけ全作品の同期状態を確かめる（設計書3.5.1）。
  // await しないのは、回線が遅い環境で拡張機能の起動を待たせないため。
  // fetchは取得のみなので、途中で終わってもローカルには何も起きない
  void gitSync.refreshAll({ fetch: true });
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

/** ツリーから呼ばれた場合はそのノード、コマンドパレットからは選択させる */
async function resolveWork(
  node: WorkNode | undefined,
  registry: WorkRegistry
): Promise<WorkEntry | undefined> {
  if (node && node.type === "work") return node.work;

  const works = registry.list();
  if (works.length === 0) {
    vscode.window.showInformationMessage("作品が登録されていません。");
    return undefined;
  }
  if (works.length === 1) return works[0];

  const picked = await vscode.window.showQuickPick(
    works.map((w) => ({ label: w.title, description: w.folderPath, work: w })),
    { title: "作品を選択" }
  );
  return picked?.work;
}
