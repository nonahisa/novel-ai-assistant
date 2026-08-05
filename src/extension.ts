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
import { extractCharacters } from "./features/extractCharacters";

export function activate(context: vscode.ExtensionContext): void {
  const registry = new WorkRegistry(context);
  const treeProvider = new WorkTreeProvider(registry);
  const aiRegistry = new AIRegistry(context);

  const treeView = vscode.window.createTreeView("novelai.works", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

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
        `- 原稿用紙換算: 約 ${formatCount(toManuscriptPages(counts.net))} 枚`,
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

      const entry = await registry.add(folderPath, title.trim());
      if (!entry) return;

      // config.json が無ければ作る（既存フォルダを壊さないよう最小限）
      const existing = await readWorkConfig(entry);
      if (!existing) {
        const p = workPaths(entry);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(p.aiwriter));
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(p.configFile),
          new TextEncoder().encode(
            JSON.stringify(
              {
                schemaVersion: "0.1",
                workTitle: title.trim(),
                manuscriptDir: "本文",
                settingsDir: "設定",
                createdAt: new Date().toISOString(),
              },
              null,
              2
            )
          )
        );
      }

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
          `原稿用紙換算: 約 ${formatCount(toManuscriptPages(t.net))} 枚`,
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

        // 本文フォルダが無ければ作る
        const manuscriptDir = (await exists(p.manuscript))
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
        if (await exists(filePath)) {
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
    vscode.commands.registerCommand("novelai.testAI", async () => {
      const resolved = aiRegistry.resolve();
      if (!resolved) {
        vscode.window.showInformationMessage(
          "AIが設定されていません。「AIの設定」から設定してください。"
        );
        return;
      }
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "接続を確認しています…",
        },
        () => resolved.provider.testConnection()
      );
      if (result.ok) {
        const info = await aiRegistry.resolveModelInfo();
        const detail = info
          ? `${info.displayName}（${info.parameterSize ?? "?"} / 文脈 ${
              info.contextWindow
            }）`
          : resolved.model;
        vscode.window.showInformationMessage(`${result.message}\n使用中: ${detail}`);
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "novelai.extractCharacters",
      async (node?: WorkNode) => {
        const work = await resolveWork(node, registry);
        if (!work) return;

        // 未保存の変更があると、ディスクとバッファが食い違った状態で
        // 処理することになるため、先に保存を促す
        const dirty = vscode.workspace.textDocuments.filter(
          (d) => d.isDirty && d.uri.fsPath.startsWith(work.folderPath)
        );
        if (dirty.length > 0) {
          const answer = await vscode.window.showWarningMessage(
            `未保存の変更が ${dirty.length} 件あります。保存してから実行しますか？`,
            "保存して実行",
            "そのまま実行",
            "中止"
          );
          if (answer === "中止" || answer === undefined) return;
          if (answer === "保存して実行") {
            for (const d of dirty) await d.save();
          }
        }

        await extractCharacters(work, aiRegistry);
        treeProvider.refresh(work.id);
      }
    )
  );
}

export function deactivate(): void {
  // 後片付けは context.subscriptions に任せる
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

async function exists(p: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return true;
  } catch {
    return false;
  }
}
