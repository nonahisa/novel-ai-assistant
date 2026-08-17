import * as vscode from "vscode";
import * as path from "path";
import { WorkEntry } from "../models/types";
import {
  readTextFile,
  sameFilePath,
  writeTextFilePreservingFormat,
  type WriteTextFileResult,
} from "../core/textFile";
import { appendAiActionLog } from "../core/typoIssueHistory";
import { dismissKey, TypoDismissedHistory } from "../core/typoIssueHistory";
import type { TypoCheckIssue } from "./checkTypos";
import type { AcceptedContradiction as ContradictionIssue } from "../core/contradictionValidation";
import type { DeviationIssue } from "./checkDeviations";
import { buildTypoIssuePanelHtml } from "../views/typoIssuePanelHtml";
import { KeepWordStore } from "../core/keepWordStore";
import { validateKeepWord } from "../models/keepWord";

/**
 * AI指摘パネル（誤字脱字）。
 *
 * 出力・デバッグコンソールと同じ下段の領域に表示する
 * `WebviewViewProvider`。設定資料パネル（`settingsPanel.ts`）は
 * エディター領域に開く別方式だが、こちらは本文を編集しながら
 * 常に見えている場所に置きたいという要望のため下段にした。
 *
 * 設計書6.10は誤字脱字／推敲／逸脱・間延び／矛盾を同じパネルに
 * タブ分けで統合する設計。ビューIDとコンテナ名は既にその前提で
 * 汎用の名前にしてあり、今回は誤字脱字だけを実装する。
 */

export const AI_ISSUES_VIEW_ID = "novelai.aiIssuesView";

export interface TypoIssueViewItem {
  id: string;
  filePath: string;
  fileName: string;
  chunkHash: string;
  line: number;
  original: string;
  target: string;
  suggestion: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  status: "pending" | "applied" | "failed" | "dismissed";
  statusDetail?: string;
}

/**
 * 矛盾の1件（設計書6.10.1）。
 *
 * **`suggestion` を持たない。** 誤字脱字と違い、設定と本文のどちらが
 * 正しいかは作者にしか決められないので、置き換える案を出さない。
 */
export interface ContradictionViewItem {
  id: string;
  filePath: string;
  fileName: string;
  chunkHash: string;
  line: number;
  excerpt: string;
  category: string;
  settingSays: string;
  textSays: string;
  note: string;
  confidence: "high" | "medium" | "low";
  status: "pending" | "dismissed";
  /**
   * 並べる2つの見出し。
   *
   * **矛盾とプロット逸脱で言葉が違う**（設定では／本文では、
   * プロットでは／この話では）。同じ描画を使い回すために持たせる。
   */
  leftLabel: string;
  rightLabel: string;
  /** 「設定資料を見る」の代わりに何を開くか */
  openTarget: "settings" | "plot";
}

type OutgoingMessage = {
  type: "issues";
  workTitle: string;
  /** パネルの見出し。誤字脱字か表記ゆれか矛盾かで変わる */
  category: string;
  items: Array<TypoIssueViewItem | ContradictionViewItem>;
  /** 「まとめて適用」を出すか。矛盾では出さない */
  canApplyAll: boolean;
};

type IncomingMessage =
  | { type: "jump"; id: string }
  | { type: "apply"; id: string }
  | { type: "dismiss"; id: string }
  | { type: "keepWord"; id: string }
  | { type: "openSettings"; id: string }
  | { type: "applyAll" };

export class TypoIssuePanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private work: WorkEntry | undefined;
  private items: TypoIssueViewItem[] = [];
  /**
   * 矛盾の指摘。誤字脱字とは別に持つ。
   *
   * **同じ配列へ混ぜない。** 適用・まとめて適用の処理が誤字脱字の形を
   * 前提にしており、混ぜると矛盾を「適用」しようとして壊れる。
   */
  private contradictions: ContradictionViewItem[] = [];
  private category = "誤字脱字";

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const nonce = createNonce();
    webviewView.webview.html = buildTypoIssuePanelHtml(
      nonce,
      webviewView.webview.cspSource
    );
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message as IncomingMessage);
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    // 開いたときに、既にある結果（先に検知が終わっていた場合）を反映する
    this.postItems();
  }

  /** `checkTypos` の結果を差し替えて表示する */
  showResults(
    work: WorkEntry,
    issues: TypoCheckIssue[],
    category = "誤字脱字"
  ): void {
    this.work = work;
    this.category = category;
    this.contradictions = [];
    this.items = issues.map((issue, index) => ({
      id: `${issue.chunkHash}:${issue.line}:${index}`,
      filePath: issue.filePath,
      fileName: path.basename(issue.filePath),
      chunkHash: issue.chunkHash,
      line: issue.line,
      original: issue.original,
      target: issue.target,
      suggestion: issue.suggestion,
      reason: issue.reason,
      confidence: issue.confidence,
      status: "pending",
    }));
    this.postItems();
    // パネルが開いていなければ前面に出す。開いていれば余計なフォーカス移動はしない
    void vscode.commands.executeCommand(`${AI_ISSUES_VIEW_ID}.focus`);
  }

  /**
   * 矛盾の結果を差し替えて表示する。
   *
   * **適用の口を持たせない。** 設定と本文のどちらが正しいかは
   * 作者にしか決められないので、見に行く先を出すだけにする。
   */
  showContradictions(work: WorkEntry, issues: ContradictionIssue[]): void {
    this.work = work;
    this.category = "矛盾";
    this.items = [];
    this.contradictions = issues.map((issue, index) => ({
      id: `c:${issue.chunkHash}:${issue.line}:${index}`,
      filePath: issue.filePath,
      fileName: path.basename(issue.filePath),
      chunkHash: issue.chunkHash,
      line: issue.line,
      excerpt: issue.excerpt,
      category: issue.category,
      settingSays: issue.settingSays,
      textSays: issue.textSays,
      note: issue.note,
      confidence: issue.confidence,
      status: "pending",
      leftLabel: "設定では",
      rightLabel: "本文では",
      openTarget: "settings",
    }));
    this.postItems();
    void vscode.commands.executeCommand(`${AI_ISSUES_VIEW_ID}.focus`);
  }

  /**
   * プロット逸脱・間延びの結果を差し替えて表示する。
   *
   * 矛盾と同じく**適用の口を持たせない。** プロットと本文のどちらが
   * 正しいかは作者にしか決められない（**プロットのほうが古いこともある**）。
   */
  showDeviations(work: WorkEntry, issues: DeviationIssue[]): void {
    this.work = work;
    this.category = "プロット逸脱";
    this.items = [];
    this.contradictions = issues.map((issue, index) => ({
      id: `d:${issue.chunkHash}:${issue.lineStart}:${index}`,
      filePath: issue.filePath,
      fileName: path.basename(issue.filePath),
      chunkHash: issue.chunkHash,
      line: issue.lineStart,
      excerpt: issue.excerpt,
      category: issue.type,
      settingSays: issue.plotReference,
      textSays: issue.reason,
      // 範囲は補足に出す。行番号だけでは、どこまでの話か分からない
      note:
        issue.lineEnd > issue.lineStart
          ? `${issue.lineStart}〜${issue.lineEnd}行目`
          : "",
      confidence: issue.confidence,
      status: "pending",
      leftLabel: "プロットでは",
      rightLabel: "この話では",
      openTarget: "plot",
    }));
    this.postItems();
    void vscode.commands.executeCommand(`${AI_ISSUES_VIEW_ID}.focus`);
  }

  private postItems(): void {
    if (!this.view) return;
    const contradictionMode = this.contradictions.length > 0;
    const message: OutgoingMessage = {
      type: "issues",
      workTitle: this.work?.title ?? "",
      category: this.category,
      items: contradictionMode ? this.contradictions : this.items,
      canApplyAll: !contradictionMode,
    };
    void this.view.webview.postMessage(message);
  }

  /**
   * 矛盾を無視する。
   *
   * **記録も誤字脱字とは分ける。** あちらは「この置き換えは要らない」で、
   * こちらは「この食い違いは矛盾ではない（意図した変化である）」という
   * 別の意味の判断である。
   */
  private async dismissContradiction(
    item: ContradictionViewItem,
    work: WorkEntry
  ): Promise<void> {
    const target = this.contradictions.find((entry) => entry.id === item.id);
    if (target) target.status = "dismissed";
    this.postItems();

    await appendAiActionLog(work, {
      category: "contradiction",
      action: "dismissed",
      file: item.fileName,
      line: item.line,
      target: item.excerpt,
      suggestion: `設定「${item.settingSays}」／本文「${item.textSays}」`,
    });
  }

  /**
   * 照らした相手側を開く。**本文だけを直す道を示さないため。**
   *
   * 矛盾なら設定資料、プロット逸脱ならプロット。
   */
  private async openSettingsFor(id: string): Promise<void> {
    const item = this.contradictions.find((entry) => entry.id === id);
    if (!item || !this.work) return;
    const ref = { type: "work", work: this.work };
    await vscode.commands.executeCommand(
      item.openTarget === "plot"
        ? "novelai.createPlot"
        : "novelai.openSettingsPanel",
      ref
    );
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case "jump":
        await this.jumpTo(message.id);
        return;
      case "apply":
        await this.applyIssue(message.id);
        return;
      case "keepWord":
        await this.keepWord(message.id);
        break;
      case "dismiss":
        await this.dismissIssue(message.id);
        return;
      case "openSettings":
        await this.openSettingsFor(message.id);
        return;
      case "applyAll":
        await this.applyVisible();
        return;
    }
  }

  private async jumpTo(id: string): Promise<void> {
    // 矛盾も同じ「その行へ飛ぶ」を使う。**両方から探す**
    const item: { filePath: string; line: number } | undefined =
      this.items.find((entry) => entry.id === id) ??
      this.contradictions.find((entry) => entry.id === id);
    if (!item) return;
    try {
      const doc = await vscode.workspace.openTextDocument(item.filePath);
      const editor = await vscode.window.showTextDocument(doc, {
        preserveFocus: false,
      });
      const lineIndex = Math.min(Math.max(item.line - 1, 0), doc.lineCount - 1);
      const range = doc.lineAt(lineIndex).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch {
      vscode.window.showWarningMessage("該当のファイルを開けませんでした。");
    }
  }

  /**
   * 表示中（無視・失敗以外）の指摘のうち、high/medium confidence のものだけを
   * まとめて適用する。既定では画面に出さず、作者が確認ダイアログを経てから呼ぶ。
   */
  private async applyVisible(): Promise<void> {
    const targets = this.items.filter(
      // **修正案の無い指摘は掴まない**（推敲）。適用しても何も起きない
      (item) =>
        item.status === "pending" &&
        item.confidence !== "low" &&
        Boolean(item.suggestion)
    );
    if (targets.length === 0) return;
    const confirm = await vscode.window.showWarningMessage(
      `確信度「高」「中」の指摘 ${targets.length} 件をまとめて適用します。` +
        "作者による個別確認なしに本文が書き換わります。",
      { modal: true },
      "適用する"
    );
    if (confirm !== "適用する") return;
    for (const item of targets) {
      await this.applyIssue(item.id);
    }
  }

  private async applyIssue(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item || !this.work) return;
    if (item.status === "applied") return;
    const work = this.work;

    let file;
    try {
      file = await readTextFile(item.filePath);
    } catch {
      this.markStatus(id, "failed", "本文を読み込めませんでした。");
      return;
    }

    const lines = file.text.split("\n");
    const lineIndex = item.line - 1;
    const lineText = lines[lineIndex];

    // 検知からここまでの間に本文が変わっている可能性がある。
    // 該当行に original がまだ実在するかを再確認してから書き換える
    if (lineText === undefined || !lineText.includes(item.original)) {
      this.markStatus(
        id,
        "failed",
        "本文が変更されているため、この指摘の位置を特定できませんでした。" +
          `もう一度「${this.category}を検知」をやり直してください。`
      );
      return;
    }

    const originalIndexInLine = lineText.indexOf(item.original);
    const targetIndexInOriginal = item.original.indexOf(item.target);
    if (targetIndexInOriginal === -1) {
      this.markStatus(id, "failed", "指摘の位置を特定できませんでした。");
      return;
    }

    const absoluteTargetIndex = originalIndexInLine + targetIndexInOriginal;
    lines[lineIndex] =
      lineText.slice(0, absoluteTargetIndex) +
      item.suggestion +
      lineText.slice(absoluteTargetIndex + item.target.length);

    const result = await writeTextFilePreservingFormat(
      item.filePath,
      lines.join("\n"),
      file,
      file.hash
    );
    if (!result.ok) {
      this.markStatus(id, "failed", describeWriteFailure(result));
      return;
    }

    await revertIfOpen(item.filePath);

    this.markStatus(id, "applied");
    await appendAiActionLog(work, {
      category: "typo",
      action: "applied",
      file: item.fileName,
      line: item.line,
      target: item.target,
      suggestion: item.suggestion,
    });
  }

  /**
   * この語を「今後直さない」として登録する。
   *
   * **方言・口癖は固有名詞の辞書では守れない。** 作者の10作品で測ったところ、
   * 設定資料を抽出して固有名詞113語を渡してもなお「はよ」→「早く」、
   * 「急いどるんやろ？」→「急いでるんやろ？」が出た（2026-08-17）。
   * **作者が名指しで守るしかない。**
   *
   * 登録したうえで、この指摘は無視したものとして畳む。
   */
  private async keepWord(id: string): Promise<void> {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || !this.work) return;
    const work = this.work;

    const problem = validateKeepWord(item.target);
    if (problem) {
      void vscode.window.showWarningMessage(problem);
      return;
    }

    try {
      const added = await new KeepWordStore(work).add(
        item.target,
        `「${item.suggestion}」への指摘を断った（${item.fileName}）`
      );
      void vscode.window.showInformationMessage(
        added
          ? `「${item.target}」を今後直しません。` +
              "設定/keep_words.json に控えました。"
          : `「${item.target}」は既に登録されています。`
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    await this.dismissIssue(id);
  }

  private async dismissIssue(id: string): Promise<void> {
    const contradiction = this.contradictions.find((entry) => entry.id === id);
    if (contradiction && this.work) {
      await this.dismissContradiction(contradiction, this.work);
      return;
    }

    const item = this.items.find((i) => i.id === id);
    if (!item || !this.work) return;
    const work = this.work;

    await new TypoDismissedHistory(work).add([
      dismissKey(item.chunkHash, item),
    ]);
    this.markStatus(id, "dismissed");
    await appendAiActionLog(work, {
      category: "typo",
      action: "dismissed",
      file: item.fileName,
      line: item.line,
      target: item.target,
      suggestion: item.suggestion,
    });
  }

  private markStatus(
    id: string,
    status: TypoIssueViewItem["status"],
    detail?: string
  ): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    item.status = status;
    item.statusDetail = detail;
    this.postItems();
  }
}

/**
 * 書き込み後、そのファイルがエディターで開いていれば表示を最新化する。
 *
 * `writeTextFilePreservingFormat` は「元の原稿を回復先へ退避 → 新しい内容で
 * 作り直す」手順（同じパスに新しいファイルを作り直す）で書き込む。
 * 単純な上書きと違い、この退避→作り直しの動きはVS Codeの
 * 「外部でファイルが変わったら自動的に読み直す」仕組みで拾われないことがあり、
 * 保存は成功しているのにエディターの表示だけ古いまま、という事故になる
 * （実機で発覚、2026-08-12）。ここで明示的に読み直させる。
 *
 * 対象がエディターで開かれていなければ何もしない。開いていても
 * 未保存の変更があれば触れない（`writeTextFilePreservingFormat` 側の
 * `hasUnsavedChanges` チェックで、そもそもここまで来ないはずだが念のため）。
 *
 * `revert` はスクロール位置・カーソル位置を保たない（実機で確認）ため、
 * 読み直す前の選択位置を控えておき、読み直した後に復元する。
 *
 * スクロール位置そのものを「表示範囲の先頭行をrevealRangeで指定し直す」
 * 形で厳密に復元しようとしたが、`AtTop`が実際にどこへ置くかが実機で
 * 安定せず（範囲全体を渡しても・先頭1行だけに絞っても、復元後の表示が
 * 数行分ずれた）、当てずっぽうの補正を重ねるやり方は行き詰まった
 * （2026-08-13）。そこで方針を変え、「直前の表示範囲を厳密に再現する」
 * のではなく、「編集した行がその後も画面内に見えていればそれで良い」
 * という緩い目標に切り替えた。`InCenterIfOutsideViewport`
 * は対象がすでに画面内にあれば何もしない（＝適用直前の表示位置が
 * そのまま保たれる）ため、通常のケース（適用した行を見ながら「適用」を
 * 押した直後）では一切スクロールが発生しない。対象が画面外に出ていた
 * 場合だけ、その行が見えるように寄せる。
 *
 * **`revert` 前に取得した `TextEditor` を使い回さない。** `revert` の後は
 * 別のエディターインスタンスになっていることがあり、古い参照へ
 * `selection` を代入しても反映されなかった（実機で確認）。復元は
 * 読み直した後に改めて取得したエディターに対して行う。
 */
async function revertIfOpen(filePath: string): Promise<void> {
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => sameFilePath(doc.uri.fsPath, filePath) && !doc.isDirty
  );
  if (!openDoc) return;
  try {
    const before = await vscode.window.showTextDocument(openDoc, {
      preserveFocus: true,
      preview: false,
    });
    const selection = before.selection;

    await vscode.commands.executeCommand("workbench.action.files.revert");

    const after =
      vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === openDoc.uri.toString()
      ) ??
      (await vscode.window.showTextDocument(openDoc, {
        preserveFocus: true,
        preview: false,
      }));

    after.selection = selection;
    after.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch {
    // 表示の更新に失敗しても、書き込み自体は既に成功している。
    // 作者は手動でタブを閉じて開き直せば最新内容を見られる
  }
}

function describeWriteFailure(
  result: Extract<WriteTextFileResult, { ok: false }>
): string {
  switch (result.reason) {
    case "modified_externally":
      return "本文が読み込み後に変更されています。もう一度検知をやり直してください。";
    case "conflict_markers":
      return "本文にGitの競合マーカーが含まれているため、適用できません。";
    case "unsaved_changes":
      return "エディターに未保存の変更があります。保存してから適用してください。";
    case "encoding_error":
      return "この文字コードで表現できない文字が含まれているため、適用できません。";
    case "path_conflict":
      return (
        "保存先が競合しました。" + (result.detail ? `（${result.detail}）` : "")
      );
    default:
      return "適用に失敗しました。";
  }
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
