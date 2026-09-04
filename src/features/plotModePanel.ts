import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import type { Chapter } from "../models/chapter";
import type { ChapterSynopsis } from "../models/synopsis";
import type { WorkFormatKey } from "../core/workFormat";
import { PLOT_SECTIONS } from "../core/plotDoc";
import { readPlotText, writePlotText } from "../core/plotFile";
import {
  EPISODE_PLOT_CHECK_LABELS,
  PLOT_MODE_AI_COMMANDS,
  appendPlotSection,
  buildPlotEpisodeRows,
  episodePlotChapterOf,
  listPlotHeadings,
  unusedPlotSections,
  type EpisodePlotCheckAction,
  type PlotEpisodeRow,
} from "../core/plotMode";
import { computeMinimalEdit } from "../core/textEdit";
import { scanWork } from "../core/scanner";
import { ChapterStore } from "../core/chapterStore";
import { SynopsisStore } from "../core/synopsisStore";
import { readWorkFormat } from "../core/workFormatStore";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { EPISODE_PLOTS_DIR, episodePlotFileName } from "../core/resumeSheet";
import { currentCountMode, pickCount } from "../core/countSettings";
import { episodeUnit } from "../core/episodeLabel";
import { logFailure } from "../core/logger";
import { buildPlotModePanelHtml } from "../views/plotModePanelHtml";
import { openInDefaultEditor } from "../views/openDocument";
import { allActions } from "../views/actionList";
import { ensurePlotFile } from "./startWork";
import { createEpisodePlot } from "./resumeWriting";
import type { EpisodePlotCheckRef } from "./checkEpisodePlot";
import { syncPlotCharacters } from "./plotCharacterSync";

/**
 * プロットモードの画面（設計書6.4.8）。
 *
 * 作者の依頼：「プロットモードを実装してください。単話プロットにも
 * 対応してください」。
 *
 * ## 欄ではなく、横に並ぶ作業パネルにする
 *
 * **文書を欄に閉じ込めない**（6.4.3）。plot.md は左の普通のエディタで
 * 開き、パネルは「どこに何があるか」——節の目次・まだ立てていない見出しの
 * 名前・話の見取り図——だけを持つ。中身をパネルへ写した時点で、
 * この文書は記入用紙に戻る。
 *
 * ## 書き込みは、既存の道だけを通る
 *
 * - 見出しを足す：`updatePlotMarkdown`（`core/plotMode.ts` の
 *   `appendPlotSection` が包む）。**末尾へ足すだけ**で、触らない節は
 *   1文字も変えない
 * - 単話プロットを作る：既存の `createEpisodePlot`（6.36.2。新規作成だけ）
 * - AIの3つ：既存コマンドを `executeCommand` するだけ（写しを作らない）
 *
 * 新しい書き込み経路は作らない。
 */

const openPanels = new Map<string, PlotModePanel>();

export async function openPlotMode(
  context: vscode.ExtensionContext,
  work: WorkEntry
): Promise<void> {
  // **左に plot.md、右にパネル。** 先に文書を開くのは、パネルが
  // 開いた側（ViewColumn.Two）へ収まるようにするためである
  const plotFile = await ensurePlotFile(work);
  await showPlotDocument(plotFile);

  const existing = openPanels.get(work.id);
  if (existing) {
    await existing.revealAndReload();
    return;
  }
  const panel = new PlotModePanel(context, work, plotFile);
  openPanels.set(work.id, panel);
  await panel.initialize();
}

/**
 * plot.md（と単話プロット）の保存で、目次と印を作り直す。
 *
 * **開いているパネルだけが読み直す**（シーンメモと同じ）。見ていない
 * 画面のために作品を走査する必要はない。
 */
export async function refreshPlotMode(filePath: string): Promise<void> {
  for (const panel of openPanels.values()) {
    if (panel.covers(filePath)) await panel.reload();
  }
}

/**
 * plot.md を**普通のエディタ**で開く（設計書6.4.8）。
 *
 * ここだけ `openInDefaultEditor`（`vscode.open`）を使わない。目次から
 * 行へ飛ばすには `TextEditor` の実体が要るためで、`vscode.open` は
 * 何も返さない（`views/openDocument.ts` の但し書きどおりの場面）。
 */
async function showPlotDocument(
  plotFile: string,
  line?: number
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(
    paths.toUri(plotFile)
  );
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
  if (line === undefined) return;

  // 行番号は1始まりで受け取る（画面に出ている数字と揃える）
  const at = new vscode.Position(
    Math.min(Math.max(line - 1, 0), Math.max(document.lineCount - 1, 0)),
    0
  );
  editor.selection = new vscode.Selection(at, at);
  editor.revealRange(
    new vscode.Range(at, at),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

/** 画面から届く用件 */
type PanelMessage =
  | { type: "ready" }
  | { type: "reveal"; line: number }
  | { type: "addSection"; key: string }
  | { type: "command"; command: string }
  | { type: "syncCharacters" }
  | { type: "openEpisode"; filePath: string }
  | { type: "createEpisodePlot"; chapter: number | null }
  | { type: "openEpisodePlot"; chapter: number | null }
  | {
      type: "checkEpisodePlot";
      chapter: number | null;
      check: EpisodePlotCheckAction;
    };

class PlotModePanel {
  private readonly panel: vscode.WebviewPanel;

  private rows: PlotEpisodeRow[] = [];
  private notices: string[] = [];
  private unitNoun = "話";
  private episodePlotsDir = "";

  constructor(
    context: vscode.ExtensionContext,
    private readonly work: WorkEntry,
    private readonly plotFile: string
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "novelai.plotMode",
      `プロット: ${work.title}`,
      // **右に並べる**（設計書6.4.8）。左の plot.md を隠しては、
      // 書く場所と見取り図を同時に見るという目的が消える。
      // **入力の場所は動かさない**（`preserveFocus`）——開いた直後に
      // 打ち始められるのは、プロットを書く画面として当たり前の振る舞いである
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    context.subscriptions.push(this.panel);
    this.panel.onDidDispose(() => openPanels.delete(work.id));

    this.panel.webview.html = buildPlotModePanelHtml(
      createNonce(),
      this.panel.webview.cspSource
    );
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message as PanelMessage);
    });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async reload(): Promise<void> {
    await this.load();
  }

  async revealAndReload(): Promise<void> {
    this.panel.reveal(vscode.ViewColumn.Two, true);
    await this.load();
  }

  /**
   * その保存が、この作品のプロットに関わるものか。
   *
   * plot.md そのものと、単話プロットの置き場の中のファイルを見る
   * （単話プロットを書いて保存したら、一覧の印も追いつくべきである）。
   */
  covers(filePath: string): boolean {
    const key = paths.normalizeForComparison(filePath);
    if (key === paths.normalizeForComparison(this.plotFile)) return true;
    if (!this.episodePlotsDir) return false;
    // **前方一致では見ない。** 区切りはWindowsで `\`、ブラウザ上の作品で
    // `/` と変わる（`paths.normalize`）ので、置き場そのものを突き合わせる
    return (
      paths.normalizeForComparison(paths.dirname(filePath)) ===
      paths.normalizeForComparison(this.episodePlotsDir)
    );
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.load();
          return;
        case "reveal":
          await showPlotDocument(this.plotFile, message.line);
          return;
        case "addSection":
          await this.addSection(message.key);
          return;
        case "command":
          await this.runCommand(message.command);
          return;
        case "syncCharacters":
          // **保存を待たずに積める**（設計書6.4.9）。開いている文書の
          // 中身をそのまま渡す——書きかけの人物欄も反映の対象にする
          await syncPlotCharacters(this.work, {
            plotText: this.openPlotDocument()?.getText(),
            force: true,
          });
          return;
        case "openEpisode":
          // 本文は作者が割り当てた画面で開く（原稿エディタを含む）。
          // **左へ出す**——パネルを覆ってしまっては並べた意味が無い
          await openInDefaultEditor(message.filePath, {
            viewColumn: vscode.ViewColumn.One,
          });
          return;
        case "createEpisodePlot":
          await this.createEpisodePlot(message.chapter);
          return;
        case "openEpisodePlot":
          await this.openEpisodePlot(message.chapter);
          return;
        case "checkEpisodePlot":
          await this.checkEpisodePlot(message.chapter, message.check);
          return;
      }
    } catch (error) {
      const detail = messageOf(error);
      logFailure("プロットモード", { 作品: this.work.title, 内容: detail });
      void vscode.window.showErrorMessage(
        `プロットモードでエラーが起きました。${detail}`
      );
    }
  }

  /**
   * 見出しを1つ、**末尾へ**足す（設計書6.4.8）。
   *
   * 組み立ては `appendPlotSection`（`updatePlotMarkdown` の1本）だけを
   * 通る。届け方は2つある。
   *
   * 1. **エディタで開いていれば、その文書を書き換える**（変わった1か所
   *    だけ。`computeMinimalEdit`）。作者が書きかけの内容を持ったまま
   *    ディスクへ書くと、その未保存の分が消える。Ctrl+Z で戻せるのも
   *    こちらだけである
   * 2. 開いていなければ、既存の書き込み経路（`writePlotText`。
   *    退避→新規作成）でディスクへ書く
   */
  private async addSection(key: string): Promise<void> {
    const def = PLOT_SECTIONS.find((section) => section.key === key);
    if (!def) return;

    const document = this.openPlotDocument();
    const before = document
      ? document.getText()
      : await readPlotText(this.work);
    const after = appendPlotSection(before, def.key, {
      workTitle: this.work.title,
    });
    if (after === before) {
      // 候補は「まだ無い見出し」を指す言葉なので、ここへ来るのは
      // 画面が古かったときだけ。**作者の文章は塗り潰さない**
      void vscode.window.showInformationMessage(
        `「${def.heading}」は、もうプロットにあります。`
      );
      await this.load();
      return;
    }

    if (document) {
      const minimal = computeMinimalEdit(before, after);
      if (minimal) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          new vscode.Range(
            document.positionAt(minimal.start),
            document.positionAt(minimal.end)
          ),
          minimal.insert
        );
        if (!(await vscode.workspace.applyEdit(edit))) {
          void vscode.window.showWarningMessage(
            `「${def.heading}」の見出しを足せませんでした。プロットを開き直してください。`
          );
          return;
        }
      }
    } else {
      await writePlotText(this.plotFile, after);
    }

    await this.load();
    // 足した見出しの場所を見せる。押したのに画面が動かないと、
    // どこへ入ったのか探すことになる
    const added = listPlotHeadings(after).find(
      (entry) => entry.heading === def.heading
    );
    if (added) await showPlotDocument(this.plotFile, added.line);
  }

  /**
   * AIの入口。**既存のコマンドを呼ぶだけ**（設計書6.4.8）。
   *
   * 作品は引数で渡す（`resolveWork` が受ける形）。渡さないと、
   * 作品が複数あるときに押すたびに選択を訊かれる。
   */
  private async runCommand(command: string): Promise<void> {
    if (!PLOT_MODE_AI_COMMANDS.includes(command)) return;
    await vscode.commands.executeCommand(command, {
      type: "work",
      work: this.work,
    });
  }

  private async createEpisodePlot(chapter: number | null): Promise<void> {
    if (chapter === null) return;
    // **既存の口をそのまま呼ぶ**（新規作成だけ・上書きしない、6.36.2）。
    // 開くのは左の面——押したのは右のパネルなので、既定のままだと重なる
    await createEpisodePlot(this.work, chapter, {
      viewColumn: vscode.ViewColumn.One,
    });
    await this.load();
  }

  /**
   * 単話プロットのAI判定（P-27・P-28、設計書6.36.3）。
   *
   * **既存のコマンドを呼ぶだけ**（AIの3つと同じ決まり）。どの話の
   * どちらを掛けるかは、この行が知っているのでそのまま渡す。
   */
  private async checkEpisodePlot(
    chapter: number | null,
    check: EpisodePlotCheckAction
  ): Promise<void> {
    if (chapter === null) return;
    const ref: EpisodePlotCheckRef = {
      type: "episodePlot",
      work: this.work,
      chapter,
      check,
    };
    await vscode.commands.executeCommand("novelai.checkEpisodePlot", ref);
  }

  private async openEpisodePlot(chapter: number | null): Promise<void> {
    if (chapter === null || !this.episodePlotsDir) return;
    await openInDefaultEditor(
      paths.join(this.episodePlotsDir, episodePlotFileName(chapter)),
      { viewColumn: vscode.ViewColumn.One }
    );
  }

  /**
   * いま開いている plot.md の文書。
   *
   * **開いていれば、そちらが正しい。** ディスクを読むと、作者が
   * 打ち込んだばかりの見出しが目次に出ない。
   */
  private openPlotDocument(): vscode.TextDocument | undefined {
    const key = paths.normalizeForComparison(this.plotFile);
    return vscode.workspace.textDocuments.find(
      (document) =>
        paths.normalizeForComparison(paths.fromUri(document.uri)) === key
    );
  }

  private async load(): Promise<void> {
    this.notices = [];
    const document = this.openPlotDocument();
    const text = document ? document.getText() : await readPlotText(this.work);

    const format = await readWorkFormat(this.work);
    this.unitNoun = episodeUnit(format).noun;

    const config = await readWorkConfig(this.work);
    const settings = workPaths(this.work, config).settings;
    this.episodePlotsDir = paths.join(settings, EPISODE_PLOTS_DIR);

    this.rows = await this.buildRows(format);
    this.post(text);
  }

  /**
   * 話の見取り図。
   *
   * **どこで失敗しても画面は出す。** 章立ての台帳が壊れているというだけで
   * 目次まで見られなくなるほうが困る（あらすじの文書と同じ判断）。
   */
  private async buildRows(
    format: WorkFormatKey | undefined
  ): Promise<PlotEpisodeRow[]> {
    let episodes: EpisodeFile[];
    try {
      episodes = (await scanWork(this.work)).episodes;
    } catch (error) {
      this.notices.push(`本文を読めませんでした：${messageOf(error)}`);
      return [];
    }

    let chapters: Chapter[] = [];
    try {
      chapters = (await new ChapterStore(this.work).load()).chapters;
    } catch (error) {
      this.notices.push(
        `章立ての台帳を読めませんでした：${messageOf(error)}（章名は出しません）`
      );
    }

    let synopses: ChapterSynopsis[] = [];
    try {
      synopses = (await new SynopsisStore(this.work).load()).episodes;
    } catch (error) {
      this.notices.push(
        `各話あらすじを読めませんでした：${messageOf(error)}（冒頭は出しません）`
      );
    }

    return buildPlotEpisodeRows({
      episodes,
      chapters,
      workFolder: this.work.folderPath,
      format,
      synopses,
      episodePlotChapters: await this.existingEpisodePlots(episodes),
    });
  }

  /**
   * 単話プロットが既にある話数。
   *
   * **置き場を1度読むだけ**にする（話ごとに有無を尋ねると、19話で
   * 19回の問い合わせになる）。突き合わせるのは `episodePlotFileName` が
   * 作る名前だけで、**`第N話.md` という形をここで読み解かない**
   * ——名前の決め方を変えたときに、片方だけが古くなる。
   */
  private async existingEpisodePlots(
    episodes: readonly EpisodeFile[]
  ): Promise<Set<number>> {
    const found = new Set<number>();
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(
        paths.toUri(this.episodePlotsDir)
      );
    } catch {
      // 置き場がまだ無いのは普通のこと（1つも作っていない作品）
      return found;
    }

    const names = new Set(entries.map(([name]) => name));
    for (const episode of episodes) {
      const chapter = episodePlotChapterOf(episode);
      if (chapter !== null && names.has(episodePlotFileName(chapter))) {
        found.add(chapter);
      }
    }
    return found;
  }

  private post(text: string): void {
    const mode = currentCountMode();
    const headings = listPlotHeadings(text);
    const candidates = unusedPlotSections(text);

    void this.panel.webview.postMessage({
      type: "plotMode",
      data: {
        title: `プロット：${this.work.title}`,
        where: `${paths.basename(this.plotFile)}（左のエディタで書きます）`,
        headingsNote:
          headings.length === 0
            ? "まだ見出しがありません。下の名前を押すと、末尾に見出しを足せます。"
            : "押すと、左のプロットのその行へ移ります。",
        candidates: candidates.map((def) => ({
          key: def.key,
          heading: def.heading,
          title: def.hint
            ? `${def.hint}（末尾に見出しだけ足します）`
            : "末尾に見出しだけ足します",
        })),
        headings,
        aiActions: aiActions(),
        syncActions: SYNC_ACTIONS,
        episodesHeading: `${this.unitNoun}の並び`,
        episodesNote:
          "上から読むと、作品の流れが分かります。" +
          `${this.unitNoun}を押すと本文を、右のボタンで単話プロットを開きます。`,
        episodes: this.rows.map((row) => ({
          ...row,
          chars: pickCount({ ...zeroCounts, net: row.net, gross: row.gross }, mode),
          // ボタンの名前は `core/plotMode.ts` だけが持つ（写しを作らない）
          checks: row.episodePlotChecks.map((check) => ({
            check,
            ...EPISODE_PLOT_CHECK_LABELS[check],
          })),
        })),
        emptyEpisodes: `まだ${this.unitNoun}がありません。`,
        notice: this.notices.join(" "),
      },
    });
  }
}

/** `pickCount` へ渡すための器。使うのは総文字数と純文字数の2つだけ */
const zeroCounts = {
  gross: 0,
  net: 0,
  lines: 0,
  paragraphs: 0,
  manuscriptLines: 0,
};

/**
 * AIを使わない入口（設計書6.4.9）。
 *
 * **コマンドは作らない。** 押す場所はこのパネルの中だけで、操作メニューを
 * 増やさない。押しても資料は変わらない——承認待ちへ積むだけである。
 */
const SYNC_ACTIONS: ReadonlyArray<{
  action: "syncCharacters";
  label: string;
  detail: string;
}> = [
  {
    action: "syncCharacters",
    label: "プロットの人物を資料へ反映",
    detail:
      "「主要登場人物」に書いた人を、設定資料の更新案として積みます。" +
      "AIは使いません。承認するまで資料は変わりません。",
  },
];

/**
 * AIの入口に出す3つ。**名前も説明も `ACTION_TREE` から引く**
 * （設計書6.4.8。写しを作ると、片方だけ直したときに食い違う）。
 */
function aiActions(): Array<{
  command: string;
  label: string;
  detail: string;
}> {
  const actions = allActions();
  return PLOT_MODE_AI_COMMANDS.flatMap((command) => {
    const action = actions.find((entry) => entry.command === command);
    if (!action) return [];
    return [
      {
        command,
        label: action.usesAI ? `${action.label}（AIを使う）` : action.label,
        // `**` はメニューのホバー用の印。素の文にして渡す
        detail: action.detail.replace(/\*\*/g, ""),
      },
    ];
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
