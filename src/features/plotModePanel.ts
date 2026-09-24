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
  episodePlotGoalHead,
  listPlotHeadings,
  nextPlannedEpisodeNumber,
  parsePlannedEpisodeNumber,
  plannedEpisodePlotChapters,
  unusedPlotSections,
  type EpisodePlotCheckAction,
  type PlannedEpisodePlot,
  type PlotEpisodeRow,
} from "../core/plotMode";
import { SUPPORTED_EXTENSIONS } from "../models/types";
import { readTextFile } from "../core/textFile";
import { computeMinimalEdit } from "../core/textEdit";
import { scanWork } from "../core/scanner";
import { ChapterStore } from "../core/chapterStore";
import { SynopsisStore } from "../core/synopsisStore";
import { readWorkFormat } from "../core/workFormatStore";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import {
  EPISODE_PLOTS_DIR,
  episodePlotChapterFromFileName,
  episodePlotFileName,
  episodePlotTitleFromText,
} from "../core/resumeSheet";
import {
  applyEpisodePlotRenames,
  planPlannedEpisodeInsert,
  planPlannedEpisodeStep,
  type EpisodePlotRename,
  type PlannedEpisodeMovePlan,
} from "../core/episodePlotOrder";
import { createForeshadowStore } from "../core/foreshadowStore";
import {
  foreshadowCountsByChapter,
  lastWrittenChapter,
  overdueForeshadows,
  type ForeshadowChapterCounts,
} from "../core/foreshadowPlan";
import { currentCountMode, pickCount } from "../core/countSettings";
import { episodeUnit } from "../core/episodeLabel";
import { logFailure, useLogFile } from "../core/logger";
import { buildPlotModePanelHtml } from "../views/plotModePanelHtml";
import { openInDefaultEditor } from "../views/openDocument";
import { askText } from "../views/dialogs";
import { allActions } from "../views/actionList";
import { ensurePlotFile } from "./startWork";
import { createEpisodePlot } from "./resumeWriting";
import type { EpisodePlotCheckRef } from "./checkEpisodePlot";
import { syncPlotCharacters } from "./plotCharacterSync";
import { EpisodePlotFolderWatcher } from "./episodePlotWatch";
import { sharedFolderWatchHub } from "./folderWatchHub";
import {
  renameEpisodePlotFile,
  renumberEpisodePlotHeadings,
} from "./episodePlotFiles";

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
 * - 予定の話を足す：同じ `createEpisodePlot` に題を渡すだけ。**本文は作らない**
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
  | { type: "addPlannedEpisode" }
  | { type: "openEpisodePlot"; chapter: number | null }
  | {
      type: "checkEpisodePlot";
      chapter: number | null;
      check: EpisodePlotCheckAction;
    }
  /** 予定の話を1つ上・下へ（設計書6.4.8。単話プロットの話数だけを動かす） */
  | { type: "movePlanned"; chapter: number | null; direction: "up" | "down" }
  /** 予定の話を、指定の話数へ差し込む */
  | { type: "insertPlanned"; chapter: number | null }
  /** 伏線の一覧を開く（一覧の数・回収予定を過ぎた知らせから） */
  | { type: "openForeshadows" };

class PlotModePanel {
  private readonly panel: vscode.WebviewPanel;

  private rows: PlotEpisodeRow[] = [];
  private notices: string[] = [];
  private unitNoun = "話";
  private episodePlotsDir = "";
  private settingsDir = "";
  /** 直近に読んだ本文の並び。予定の話数を決めるときに使う */
  private episodes: EpisodeFile[] = [];
  /** 直近に読んだ、単話プロットのある話数（予定の話を含む） */
  private plotChapters: number[] = [];
  /** 本文を読めたか。読めないまま予定を足すと、本文のある話数と重なりうる */
  private episodesLoaded = false;
  /** 回収予定を過ぎても未回収の伏線の数（設計書6.35）。一覧の上に出す */
  private overdueCount = 0;
  /**
   * 単話プロットの置き場の見張り（2026-09-23）。**外から**書き換えた単話
   * プロット（別のエディタ・同期・Git の復元）でも一覧を作り直す。
   * VS Code での保存は `refreshPlotMode` が拾うので、二重に走っても
   * 読み直しが1回増えるだけで害は無い
   */
  private readonly plotWatcher = new EpisodePlotFolderWatcher(() => {
    // 作者が何も押していないのに出る失敗なので、通知は出さずに記録だけ残す
    void this.reload().catch((error: unknown) => {
      useLogFile(this.work.folderPath);
      logFailure("プロットモード", {
        作品: this.work.title,
        内容: `単話プロットの外からの変更で読み直せませんでした：${messageOf(error)}`,
      });
    });
    // 作品フォルダーの見張り（本文・同期・設定資料が分け合う1本）から
    // 受け取る。新しく張らない（残課題 C2、0.84.4）
  }, sharedFolderWatchHub());

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
    this.panel.onDidDispose(() => {
      openPanels.delete(work.id);
      this.plotWatcher.dispose();
    });

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
    // 保存された文書の場所は `fromUri` 由来（ブラウザ版では日本語が
    // 符号化された形）。比べ方は `isSamePath` にそろえる
    if (paths.isSamePath(filePath, this.plotFile)) return true;
    if (!this.episodePlotsDir) return false;
    // **前方一致では見ない。** 区切りはWindowsで `\`、ブラウザ上の作品で
    // `/` と変わる（`paths.normalize`）ので、置き場そのものを突き合わせる
    if (paths.isSamePath(paths.dirname(filePath), this.episodePlotsDir)) {
      return true;
    }
    return this.isNewManuscript(filePath);
  }

  /**
   * 見取り図にまだ無い本文が保存されたか（設計書6.4.8、予定の話）。
   *
   * **予定の話の本文を書き始めたら、同じ行へ結びつける。** 結びつき自体は
   * 話数で決まるので読み直すだけでよいが、読み直さないと、本文ができたのに
   * 「予定」の印が残って見える。
   *
   * **既に並んでいる本文の保存では読み直さない。** 書いている最中の保存の
   * たびに作品を走査しないためである（シーンメモと同じく、開いている
   * パネルの都合で書く手を重くしない）。
   */
  private isNewManuscript(filePath: string): boolean {
    const ext = paths.extname(filePath).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return false;
    if (!paths.isPathInside(this.work.folderPath, filePath)) return false;
    // 設定資料（単話プロットの置き場を除く）は本文ではない
    if (this.settingsDir && paths.isPathInside(this.settingsDir, filePath)) {
      return false;
    }
    return !this.rows.some(
      (row) => !row.planned && paths.isSamePath(row.filePath, filePath)
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
            viewColumn: this.documentColumn(),
          });
          return;
        case "createEpisodePlot":
          await this.createEpisodePlot(message.chapter);
          return;
        case "addPlannedEpisode":
          await this.addPlannedEpisode();
          return;
        case "openEpisodePlot":
          await this.openEpisodePlot(message.chapter);
          return;
        case "checkEpisodePlot":
          await this.checkEpisodePlot(message.chapter, message.check);
          return;
        case "movePlanned":
          await this.movePlanned(message.chapter, message.direction);
          return;
        case "insertPlanned":
          await this.insertPlanned(message.chapter);
          return;
        case "openForeshadows":
          // **既存のコマンドを呼ぶだけ**（一覧の作り方を写さない）
          await vscode.commands.executeCommand("novelai.openForeshadows", {
            type: "work",
            work: this.work,
          });
          return;
      }
    } catch (error) {
      const detail = messageOf(error);
      // **記録の直前に書き先を向ける**（0.43.3 と同じ）
      useLogFile(this.work.folderPath);
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
      viewColumn: this.documentColumn(),
    });
    await this.load();
  }

  /**
   * 予定の話を足す（設計書6.4.8。作者の依頼、2026-09-23）。
   *
   * **作るのは単話プロットだけ**で、本文のファイルは作らない。書き込みは
   * `createEpisodePlot` の1本（新規作成だけ・上書きしない、6.36.2）を通る。
   * 本文の無い話数のプロットがそのまま「予定」になるので、台帳は持たない。
   *
   * 何話目かを先に訊く。**本文のある話数・プロットが既にある話数は、
   * 打っているあいだに断る**（押してから「既にあります」と言うより早い）。
   */
  private async addPlannedEpisode(): Promise<void> {
    // 押す直前の状態で決める（パネルを開いたあとに話が増えていることがある）
    await this.load();
    if (!this.episodesLoaded) {
      // どの話数に本文があるか分からないまま足すと、予定のつもりが
      // 書いた話のプロットになる。読めない理由はパネルの上に出ている
      void vscode.window.showWarningMessage(
        "本文を読めなかったため、予定の話を足せません。パネルの上の知らせを確かめてください。"
      );
      return;
    }
    const episodes = this.episodes;
    const plotChapters = this.plotChapters;
    const noun = this.unitNoun;

    const numberText = await askText({
      title: `予定の${noun}を足す（1/2）：何${noun}目にしますか`,
      prompt:
        `本文のまだ無い${noun}数を入れてください。既定は最後の${noun}の次です。` +
        "本文のファイルは作りません（単話プロットだけを作ります）。",
      value: String(nextPlannedEpisodeNumber(episodes, plotChapters)),
      validateInput: (text) =>
        parsePlannedEpisodeNumber(text, episodes, plotChapters).problem ?? null,
    });
    if (numberText === undefined) return;
    const parsed = parsePlannedEpisodeNumber(numberText, episodes, plotChapters);
    if (parsed.chapter === undefined) return;

    const title = await askText({
      title: `予定の${noun}を足す（2/2）：第${parsed.chapter}${noun}の題`,
      prompt: "空のままでも足せます。題は単話プロットの見出しに入ります。",
    });
    if (title === undefined) return;

    await createEpisodePlot(
      this.work,
      parsed.chapter,
      { viewColumn: this.documentColumn() },
      { title }
    );
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

  /**
   * 本文・単話プロットを開く列。**パネルの列と重ならない列**にする
   * （作者の依頼、2026-09-23）。パネルは既定で2列目に住むので1列目、
   * 作者がパネルを1列目へ動かしていたら2列目へ開く。
   */
  private documentColumn(): vscode.ViewColumn {
    return this.panel.viewColumn === vscode.ViewColumn.One
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;
  }

  /**
   * 予定の話を1つ上・下へ動かす（設計書6.4.8。作者の依頼、2026-09-23）。
   *
   * **動かすのは予定の話の単話プロットの話数（ファイル名）だけ。** 本文の
   * ファイルには一切触れない。本文のある話の話数を変えることになるなら、
   * 計画（`core/episodePlotOrder.ts`）が理由を返し、ここで止める。
   */
  private async movePlanned(
    chapter: number | null,
    direction: "up" | "down"
  ): Promise<void> {
    if (chapter === null) return;
    // 押す直前の状態で決める（開いたあとに本文が増えていることがある）
    await this.load();
    if (!this.episodesLoaded) {
      void vscode.window.showWarningMessage(
        "本文を読めなかったため、予定の話を動かせません。パネルの上の知らせを確かめてください。"
      );
      return;
    }
    await this.applyMovePlan(
      planPlannedEpisodeStep(this.episodes, this.plotChapters, chapter, direction)
    );
  }

  /** 予定の話を、指定の話数へ差し込む（設計書6.4.8） */
  private async insertPlanned(chapter: number | null): Promise<void> {
    if (chapter === null) return;
    await this.load();
    if (!this.episodesLoaded) {
      void vscode.window.showWarningMessage(
        "本文を読めなかったため、予定の話を動かせません。パネルの上の知らせを確かめてください。"
      );
      return;
    }
    const noun = this.unitNoun;
    const text = await askText({
      title: `第${chapter}${noun}（予定）を差し込む：何${noun}目へ動かしますか`,
      prompt:
        `予定の${noun}がいる${noun}数なら、そこから後ろの予定を1つずつずらします。` +
        `本文のある${noun}数へは動かせません（本文のファイルには触れません）。`,
      value: String(chapter),
      validateInput: (value) => {
        const flat = value.normalize("NFKC").trim();
        const matched = /^第?\s*(\d+)\s*話?$/.exec(flat);
        if (!matched) return "話数を数字で入れてください（例：12）。";
        const plan = planPlannedEpisodeInsert(
          this.episodes,
          this.plotChapters,
          chapter,
          Number(matched[1])
        );
        // **打っているあいだに断る**（押してから止めるより早い）
        return plan.kind === "blocked" ? plan.reason : null;
      },
    });
    if (text === undefined) return;
    const matched = /^第?\s*(\d+)\s*話?$/.exec(text.normalize("NFKC").trim());
    if (!matched) return;
    await this.applyMovePlan(
      planPlannedEpisodeInsert(
        this.episodes,
        this.plotChapters,
        chapter,
        Number(matched[1])
      )
    );
  }

  /**
   * 計画を確かめてから付け替える。
   *
   * 1. 止める計画なら理由を出す（押しても効かない不具合に見せない）
   * 2. **書きかけの単話プロットがあれば止める**——名前を変えると、保存したときに
   *    元の名前で作り直されて同じ話が2つになる
   * 3. 何をどう付け替えるかを並べて確認を取る
   * 4. 名前を付け替える（`applyEpisodePlotRenames`。一時名を通し、途中で
   *    失敗したら戻す）。**上書きはしない**
   * 5. 見出しの「第N話」を新しい話数に合わせる（題は保つ）。本文と同じ
   *    書き戻しの口（`writeTextFilePreservingFormat`：退避→新規作成・
   *    ハッシュ照合・文字コードと改行の保持）を通る
   */
  private async applyMovePlan(plan: PlannedEpisodeMovePlan): Promise<void> {
    if (plan.kind === "blocked") {
      void vscode.window.showWarningMessage(plan.reason);
      return;
    }
    if (plan.kind === "noop") {
      void vscode.window.showInformationMessage(plan.reason);
      return;
    }

    const dirty = plan.renames
      .map((entry) =>
        paths.join(this.episodePlotsDir, episodePlotFileName(entry.from))
      )
      .filter((filePath) => this.isDirtyDocument(filePath));
    if (dirty.length > 0) {
      void vscode.window.showWarningMessage(
        `保存していない単話プロットがあります（${dirty
          .map((filePath) => paths.basename(filePath))
          .join("、")}）。保存してから動かしてください。`
      );
      return;
    }

    const noun = this.unitNoun;
    const listing = [...plan.renames]
      .sort((left, right) => left.from - right.from)
      .map((entry) => `第${entry.from}${noun} → 第${entry.to}${noun}`)
      .join("\n");
    const ok = "付け替える";
    const picked = await vscode.window.showWarningMessage(
      "予定の話の単話プロットを付け替えます。",
      {
        modal: true,
        detail:
          `${listing}\n\n` +
          "動かすのは単話プロットのファイル名と見出しの話数だけです。本文のファイルには触れません。" +
          "伏線の回収予定の話数は変えません（必要なら「伏線状態変更」で決め直してください）。",
      },
      ok
    );
    if (picked !== ok) return;

    const outcome = await applyEpisodePlotRenames(plan.renames, {
      rename: (fromName, toName) => this.renamePlotFile(fromName, toName),
    });
    if (!outcome.ok) {
      useLogFile(this.work.folderPath);
      logFailure("予定の話の付け替えに失敗", {
        作品: this.work.title,
        止まった所: outcome.failedStep,
        内容: outcome.detail,
        戻せなかったもの: outcome.stranded
          .map((entry) => `${entry.now}（元は ${entry.original}）`)
          .join("、"),
      });
      void vscode.window.showErrorMessage(
        outcome.rolledBack
          ? `付け替えられませんでした（${outcome.failedStep}：${outcome.detail}）。元の名前に戻してあります。`
          : `付け替えが途中で止まり、元に戻せなかったファイルがあります：${outcome.stranded
              .map((entry) => `${entry.now} は元の ${entry.original}`)
              .join("、")}。${EPISODE_PLOTS_DIR} の中で名前を戻してください。`
      );
      await this.load();
      return;
    }

    const headingFailures = await this.renumberHeadings(outcome.renames);
    await this.load();
    if (headingFailures.length > 0) {
      void vscode.window.showWarningMessage(
        `付け替えました。ただし見出しの話数を直せなかったものがあります（${headingFailures.join("、")}）。見出しを手で直してください。`
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `予定の${noun}を付け替えました（${outcome.renames.length}件）。本文のファイルには触れていません。`
    );
  }

  /** 置き場の中で名前を変える（口は `episodePlotFiles.ts` の1本。上書きしない） */
  private async renamePlotFile(fromName: string, toName: string): Promise<void> {
    await renameEpisodePlotFile(this.episodePlotsDir, fromName, toName);
  }

  /** 見出しの話数を合わせる。直せなかったファイル名を返す */
  private async renumberHeadings(
    renames: readonly EpisodePlotRename[]
  ): Promise<string[]> {
    return renumberEpisodePlotHeadings(this.work, this.episodePlotsDir, renames);
  }

  /** その場所の文書を、保存していない変更つきで開いているか */
  private isDirtyDocument(filePath: string): boolean {
    return vscode.workspace.textDocuments.some(
      (document) =>
        document.isDirty && paths.isSamePath(paths.fromUri(document.uri), filePath)
    );
  }

  private async openEpisodePlot(chapter: number | null): Promise<void> {
    if (chapter === null || !this.episodePlotsDir) return;
    await openInDefaultEditor(
      paths.join(this.episodePlotsDir, episodePlotFileName(chapter)),
      { viewColumn: this.documentColumn() }
    );
  }

  /**
   * いま開いている plot.md の文書。
   *
   * **開いていれば、そちらが正しい。** ディスクを読むと、作者が
   * 打ち込んだばかりの見出しが目次に出ない。
   */
  private openPlotDocument(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((document) =>
      paths.isSamePath(paths.fromUri(document.uri), this.plotFile)
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
    this.settingsDir = settings;
    this.episodePlotsDir = paths.join(settings, EPISODE_PLOTS_DIR);
    // 置き場は作品の設定で変わりうるので、読むたびに合わせる（同じなら張り直さない）
    this.plotWatcher.watch(this.episodePlotsDir);

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
    this.episodes = [];
    this.plotChapters = [];
    this.episodesLoaded = false;
    try {
      episodes = (await scanWork(this.work)).episodes;
    } catch (error) {
      this.notices.push(`本文を読めませんでした：${messageOf(error)}`);
      return [];
    }
    this.episodes = episodes;
    this.episodesLoaded = true;

    let chapters: Chapter[] = [];
    try {
      chapters = (await new ChapterStore(this.work).load()).chapters;
    } catch (error) {
      this.notices.push(
        `章立ての記録を読めませんでした：${messageOf(error)}（章名は出しません）`
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

    const plotChapters = await this.existingEpisodePlots();
    this.plotChapters = plotChapters;
    const plotTexts = await this.readEpisodePlotTexts(plotChapters);
    // 目標の1行（設計書6.4.8）。**書いた話も予定の話も、同じ読み方**
    // （`episodePlotGoalHead`）で出す。問いかけのまま・空なら出さない
    const goals = new Map<number, string>();
    for (const [chapter, text] of plotTexts) {
      const goal = episodePlotGoalHead(text);
      if (goal) goals.set(chapter, goal);
    }
    return buildPlotEpisodeRows({
      episodes,
      chapters,
      workFolder: this.work.folderPath,
      format,
      synopses,
      episodePlotChapters: new Set(plotChapters),
      plannedEpisodes: this.plannedEpisodes(episodes, plotChapters, plotTexts, goals),
      episodePlotGoals: goals,
      foreshadowCounts: await this.loadForeshadows(episodes),
    });
  }

  /**
   * 伏線の台帳を読み、話ごとの数と「回収予定を過ぎた伏線」を作る（設計書6.35）。
   *
   * **読めなくても一覧は出す**（数を出さないだけ）。読めないファイルが
   * あることは黙らずに知らせる（伏線の一覧と同じ）。
   */
  private async loadForeshadows(
    episodes: readonly EpisodeFile[]
  ): Promise<Map<number, ForeshadowChapterCounts>> {
    this.overdueCount = 0;
    let loaded;
    try {
      loaded = await createForeshadowStore(this.work).loadAll();
    } catch (error) {
      this.notices.push(
        `伏線の記録を読めませんでした：${messageOf(error)}（伏線の数は出しません）`
      );
      return new Map();
    }
    if (loaded.errors.length > 0) {
      this.notices.push(
        `読み込めない伏線が ${loaded.errors.length} 件あります（残りだけを数えています）。`
      );
    }
    this.overdueCount = overdueForeshadows(
      loaded.records,
      lastWrittenChapter(episodes)
    ).length;
    return foreshadowCountsByChapter(loaded.records);
  }

  /**
   * 単話プロットの中身（話数 → 本文）。**置き場のファイルを1度ずつ読むだけ**。
   *
   * 読めなかったものは断り書きを足して飛ばす——1つ読めないだけで一覧を
   * 出さないほうが困る。
   */
  private async readEpisodePlotTexts(
    plotChapters: readonly number[]
  ): Promise<Map<number, string>> {
    const texts = new Map<number, string>();
    for (const chapter of plotChapters) {
      const filePath = paths.join(this.episodePlotsDir, episodePlotFileName(chapter));
      try {
        texts.set(chapter, (await readTextFile(filePath)).text);
      } catch (error) {
        this.notices.push(
          `第${chapter}話の単話プロットを読めませんでした：${messageOf(error)}（題と目標は出しません）`
        );
      }
    }
    return texts;
  }

  /**
   * 単話プロットが既にある話数（本文の無い、予定の話を含む）。
   *
   * **置き場を1度読むだけ**にする（話ごとに有無を尋ねると、19話で
   * 19回の問い合わせになる）。名前から話数を読むのは、作る側の隣に
   * 置いた `episodePlotChapterFromFileName` だけ——**`第N話.md` という形を
   * ここで読み解かない**（名前の決め方を変えたときに、片方だけが古くなる）。
   */
  private async existingEpisodePlots(): Promise<number[]> {
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(
        paths.toUri(this.episodePlotsDir)
      );
    } catch {
      // 置き場がまだ無いのは普通のこと（1つも作っていない作品）
      return [];
    }

    const found = new Set<number>();
    for (const [name] of entries) {
      const chapter = episodePlotChapterFromFileName(name);
      if (chapter !== null) found.add(chapter);
    }
    return [...found].sort((left, right) => left - right);
  }

  /**
   * 予定の話（本文の無い話数の単話プロット）と、その題（設計書6.4.8）。
   *
   * **題を出すのは予定の話だけ。** 本文のある話は本文の題を出す。
   * 読めなかったら題を空にして並べる——題が読めないだけで予定を消して
   * 見せると、作ったのに無いことになる。
   */
  private plannedEpisodes(
    episodes: readonly EpisodeFile[],
    plotChapters: readonly number[],
    plotTexts: ReadonlyMap<number, string>,
    goals: ReadonlyMap<number, string>
  ): PlannedEpisodePlot[] {
    return plannedEpisodePlotChapters(episodes, plotChapters).map((chapter) => {
      const text = plotTexts.get(chapter);
      return {
        chapter,
        title: text === undefined ? "" : episodePlotTitleFromText(text),
        filePath: paths.join(this.episodePlotsDir, episodePlotFileName(chapter)),
        goal: goals.get(chapter) ?? "",
      };
    });
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
          `${this.unitNoun}を押すと本文を、右のボタンで単話プロットを開きます。` +
          `「予定」の${this.unitNoun}は本文がまだ無く、押すと単話プロットが開きます。` +
          `予定の${this.unitNoun}は ↑↓ で並べ替え、「位置」で話数を指定して差し込めます（本文のファイルには触れません）。`,
        addPlanned: {
          label: `＋ 予定の${this.unitNoun}を足す`,
          detail:
            `これから書く${this.unitNoun}を、単話プロットだけ先に作って並べます。` +
            "本文のファイルは作りません。その話数の本文を作ると、同じ行に結びつきます。",
        },
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
        // 回収予定を過ぎた伏線（設計書6.35）。0件なら出さない
        overdue:
          this.overdueCount > 0
            ? {
                label: `回収予定を過ぎた伏線 ${this.overdueCount} 件`,
                detail:
                  "回収予定の話数が、書いた最後の話より前なのに、まだ未回収の伏線です。押すと伏線の一覧を開きます。",
              }
            : null,
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
