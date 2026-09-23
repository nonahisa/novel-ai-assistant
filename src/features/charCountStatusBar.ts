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
    const ext = path.extname(editor.document.fileName).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      this.item.hide();
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
    this.item.text = fileText;
    this.item.tooltip = new vscode.MarkdownString(fileTooltip.join("\n"));
    this.item.show();

    // 今日どれだけ進んだかは、開いているファイルの字数だけでは分からない。
    // 記録が読めたときにだけ添える（統計を切っていれば何も出ない）
    const showProgress = vscode.workspace
      .getConfiguration("novelai")
      .get<boolean>("stats.showInStatusBar", true);
    const work = showProgress
      ? this.deps.findWork(fromUri(editor.document.uri))
      : undefined;
    if (!work) return;

    void this.deps
      .summary(work)
      .then((summary) => {
        if (!summary || generation !== this.generation) return;
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
