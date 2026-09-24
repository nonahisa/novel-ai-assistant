import * as vscode from "vscode";
import { fromUri } from "../core/paths";
import * as path from "../core/paths";
import {
  countChars,
  formatCount,
  toManuscriptPages,
} from "../core/charCount";
import {
  currentCountMode,
  countModeLabel,
  excludeRubyFromCount,
  pickCount,
} from "../core/countSettings";
import { TypingPause } from "../core/typingPause";
import { SUPPORTED_EXTENSIONS, type WorkEntry } from "../models/types";
import { measureKindText, type KindMeasure } from "../core/kindMeasure";
import type { WorkKindKey } from "../core/workKind";
import {
  describeStatusBarProgress,
  type WritingSummary,
} from "./writingProgress";

/**
 * **打鍵が止まってから字数を数えるまでの待ち時間**（作者の報告、2026-09-23）。
 *
 * 以前は打鍵のたびに、その場で本文全体の字数を数えていた。長い話ほど
 * 1回が重く、日本語の変換中の打鍵（標準エディターでは変換中の文字も
 * 1打ごとに本文へ入る）を取りこぼす原因になる。500ms は変換中の打鍵の
 * 間隔より長く、書き終えた字数を確かめたいときには待たされない長さ。
 * 選択範囲の字数も、同じ待ち時間で数える（カーソルの移動も打鍵で起きる）。
 */
export const STATUS_BAR_TYPING_PAUSE_MS = 500;

export interface CharCountStatusBarDeps {
  /** そのファイルが属する作品。今日の執筆量を添えるときだけ使う */
  findWork: (filePath: string) => WorkEntry | undefined;
  /** 今日の執筆量。読めなければ undefined */
  summary: (work: WorkEntry) => Promise<WritingSummary | undefined>;
  /**
   * 作品の種類（設計書6.109.7）。字数の横に種類の目安（エッセイの読了時間・
   * 台本の分数など）を添える。**渡されなければ目安は出さない**
   */
  kindOf?: (work: WorkEntry) => Promise<WorkKindKey | undefined>;
}

/**
 * ステータスバーの字数（いま開いているファイルの字数と、今日の執筆量）。
 *
 * `extension.ts` の中にあったものを、打鍵での動き方をテストで
 * 確かめられるように切り出した。
 */
export class CharCountStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pause = new TypingPause(() => this.update());
  /**
   * 表示を作り直した回数。
   *
   * 今日の執筆量は記録を読んでから添えるため、書いている最中に
   * 何度も呼ばれると古い結果が新しい表示を上書きしうる。
   * 自分より新しい呼び出しがあれば、その結果は捨てる。
   */
  private generation = 0;

  constructor(private readonly deps: CharCountStatusBarDeps) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.tooltip = "小説AI執筆補助: 現在のファイルの文字数";

    this.disposables.push(
      // ファイルを切り替えたときは、すぐ出す（打鍵ではないので割り込む心配が無い）
      vscode.window.onDidChangeActiveTextEditor(() => this.pause.runNow()),
      // 打鍵でもカーソルは動くので、選択の変化も打鍵と同じく止まってから数える
      vscode.window.onDidChangeTextEditorSelection(() =>
        this.pause.typed(STATUS_BAR_TYPING_PAUSE_MS)
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.pause.typed(STATUS_BAR_TYPING_PAUSE_MS);
        }
      })
    );
  }

  /** いま数え直す（保存・設定の変更など、打鍵ではない知らせから呼ぶ） */
  refreshNow(): void {
    this.pause.runNow();
  }

  private update(): void {
    const generation = ++this.generation;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.item.hide();
      return;
    }
    /*
      **場所は `document.uri` から取る。`document.fileName` は使わない**（2026-09-24）。
      `fileName` は `uri.fsPath` で、ブラウザ版（Windows の上のブラウザ）では
      `\仮作品\episode_0001.txt` のような `\` 区切りになる。ブラウザ束の `path` は
      posix なので `\` で割れず、吹き出しの先頭に道まるごとが出ていた。
      作品の引き当ても同じ場所の文字列を使う
    */
    const location = fromUri(editor.document.uri);
    const ext = path.extname(location).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      this.item.hide();
      return;
    }

    // 作品一覧と同じ部品を使う。別々に読むと、片方だけ直したときにずれる
    const mode = currentCountMode();
    const excludeRuby = excludeRubyFromCount();

    // 目安（設計書6.109.7）も同じ本文から測るので、1回だけ取り出す
    const text = editor.document.getText();
    const counts = countChars(text, ext === ".md" ? excludeRuby : false);
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

    /*
      種類の目安（設計書6.109.7）は**字数のすぐ横**に添える（原稿エディタの
      下段「このファイル 1,234字（約5分）」と同じ並び）。選択範囲の字数は
      その後ろ——目安はファイルぜんたいの値で、選択の値ではない。
    */
    const fileTextWith = (measure?: KindMeasure): string =>
      `$(book) ${label}${formatCount(value)}字${
        measure ? `（${measure.short}）` : ""
      }${selectionPart}`;
    const fileTooltipWith = (measure?: KindMeasure): string[] => [
      // URI の日本語は符号化されて来るので、解いてから名前を出す
      `**${path.basename(path.decodeUriEscapes(location))}**`,
      "",
      `- 純文字数: ${formatCount(counts.net)} 字`,
      `- 総文字数: ${formatCount(counts.gross)} 字`,
      `- 段落数: ${counts.paragraphs}`,
      `- 原稿用紙換算: 約 ${formatCount(toManuscriptPages(counts.manuscriptLines))} 枚`,
      ...(measure ? [`- ${measure.detail}`] : []),
    ];
    this.item.text = fileTextWith();
    this.item.tooltip = new vscode.MarkdownString(fileTooltipWith().join("\n"));
    this.item.show();

    // 今日どれだけ進んだかは、開いているファイルの字数だけでは分からない。
    // 記録が読めたときにだけ添える（統計を切っていれば何も出ない）
    const showProgress = vscode.workspace
      .getConfiguration("novelai")
      .get<boolean>("stats.showInStatusBar", true);
    const kindOf = this.deps.kindOf;
    // 作品の外のファイル（作品一覧の外の .md）には、執筆量も目安も無い
    const work =
      showProgress || kindOf ? this.deps.findWork(location) : undefined;
    if (!work) return;

    /*
      **執筆量と種類を両方待ってから、1回で書く**（設計書6.109.7）。

      どちらも記録や設定を読んでから分かる。別々に後から重ねると、
      先に届いた側の書き込みを遅れて届いた側が上書きして、目安か執筆量の
      どちらかが消える（0.81.0 でステータスバーに目安を出さなかった理由）。
      どちらが読めなくても、読めた側だけで書く。
    */
    void Promise.all([
      showProgress
        ? this.deps.summary(work).catch(() => undefined)
        : Promise.resolve(undefined),
      kindOf
        ? kindOf(work).catch(() => undefined)
        : Promise.resolve(undefined),
    ])
      .then(([summary, kind]) => {
        if (generation !== this.generation) return;
        // 小説では目安が undefined——これまでどおり何も足さない
        const measure = kind ? measureKindText(kind, text, counts) : undefined;
        if (!summary && !measure) return;
        const fileText = fileTextWith(measure);
        const fileTooltip = fileTooltipWith(measure);
        if (!summary) {
          this.item.text = fileText;
          this.item.tooltip = new vscode.MarkdownString(fileTooltip.join("\n"));
          return;
        }
        this.item.text = `${fileText}  ${describeStatusBarProgress(summary)}`;
        this.item.tooltip = new vscode.MarkdownString(
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
      })
      // 執筆量が読めなくても字数は出ている。ここで通知を出すと打鍵のたびに出る
      .catch(() => undefined);
  }

  dispose(): void {
    this.pause.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.item.dispose();
  }
}
