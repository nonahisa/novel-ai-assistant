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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const registry = new WorkRegistry(context);
  await registry.initialize();
  const treeProvider = new WorkTreeProvider(registry);
  const aiRegistry = new AIRegistry(context);

  // 本文中の用語を種類ごとに色分けし、ホバーで設定を出す
  const highlighter = new TermHighlighter(registry);
  context.subscriptions.push(highlighter);
  void highlighter.refresh();

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

  // コマンドパレットにしかない操作は作者が存在に気づけないため、分類して一覧に出す
  context.subscriptions.push(
    vscode.window.createTreeView("novelai.actions", {
      treeDataProvider: new ActionListProvider(registry),
    })
  );

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
    vscode.workspace.onDidSaveTextDocument(() => {
      updateStatusBar();
      treeProvider.refresh();
    })
  );
  updateStatusBar();

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

        // 抽出したJSONから資料Markdownまで一度に作る。
        // 抽出結果の要約はすでに出しているので、成功は再通知しない。
        if (extracted) {
          await generateSettingsDocs(work, { silent: true });
        }
      }
    )
  );
}

export function deactivate(): void {
  // 後片付けは context.subscriptions に任せる。
  // ログだけは遅延生成でsubscriptionsに載っていないので個別に閉じる
  disposeLog();
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
