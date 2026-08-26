import * as vscode from "vscode";
import { fromUri } from "../core/paths";
import { buildManuscriptEditorHtml } from "../views/manuscriptEditorHtml";
import {
  renderManuscript,
  TERM_LABELS,
} from "../core/manuscriptRender";
import { computeMinimalEdit } from "../core/textEdit";
import { createEditQueue } from "../core/editQueue";
import { countChars, formatCount } from "../core/charCount";
import {
  countModeLabel,
  currentCountMode,
  excludeRubyFromCount,
  pickCount,
} from "../core/countSettings";
import {
  hasEmphasis,
  toSiteNotation,
  validateEmphasis,
  validateRuby,
  type EmphasisSite,
} from "../core/ruby";
import { pickEmphasisSite, pickStyle } from "./ruby";
import { askText } from "../views/dialogs";
import { logLine } from "../core/logger";
import type { TermHighlighter } from "../views/termHighlight";
import type { TermKind } from "../core/termIndex";
import type { WorkEntry } from "../models/types";

/**
 * 原稿エディタ（設計書6.25）。
 *
 * 作者の指摘（2026-08-23）：VS Code 1.131 で入った Markdown の編集画面
 * （hybrid Markdown editor）では、用語ハイライト・右クリックの設定資料・
 * ルビの表示が**どれも効かない**。あちらは拡張機能から手を出せる作りに
 * なっていないので、**縦書きと投稿サイト対応まで含めて自前で持つ**。
 *
 * ## 原稿は VS Code に保存させる
 *
 * `CustomTextEditorProvider` を使う。**自前で書き込まない。**
 *
 * この拡張機能でいちばん重い決まりは「作者の原稿を壊さない」である。
 * 自分でファイルへ書くと、文字コード・改行・外で編集されたときの扱いを
 * すべて自分で正しくやることになる（`atomicWrite.ts` の上書き禁止も
 * 含めて）。`CustomTextEditorProvider` は**普通のテキストエディタと同じ
 * 文書（`TextDocument`）の上で動く**ので、
 *
 * - 保存・元に戻す（Ctrl+Z）・変更の印は VS Code のものがそのまま効く
 * - 外部ツールで書き換えられたときの読み直しも VS Code がやる
 * - 文字コードと改行の扱いは、普通に開いたときと1文字も変わらない
 *
 * **書き換えは `WorkspaceEdit` で、変わった1か所だけ**を当てる
 * （`textEdit.ts`）。全文を差し替えると、1文字打つたびに「全文を
 * 書き換えた」1手になり、Ctrl+Z が使い物にならなくなる。
 *
 * ## 既定のエディタにはしない
 *
 * `priority` は `option`。**`.md` を開いたら勝手にこれになる、という
 * ことにはしない。** 作者は普通のエディタも使う。開き方は
 * 「縦書きで開く」か、VS Code の「エディターを再度開く」から選ぶ。
 */

/** 用語の色。`termHighlight.ts` と同じ色を使う（画面ごとに違う色にしない） */
const TERM_COLORS: Record<TermKind, { light: string; dark: string }> = {
  character: { light: "#1a5fb4", dark: "#7cb7ff" },
  location: { light: "#1c7c3c", dark: "#7ee08a" },
  ability: { light: "#7a3ea3", dark: "#d3a4f5" },
  organization: { light: "#9a5b00", dark: "#e8b06a" },
};

export const MANUSCRIPT_EDITOR_VIEW_TYPE = "novelai.manuscriptEditor";

/** 画面から届く用件 */
type Incoming =
  | { type: "ready" }
  | { type: "edit"; text: string }
  | { type: "count"; text: string }
  | { type: "ruby"; text: string; start: number; end: number }
  | { type: "emphasis"; text: string; start: number; end: number }
  | { type: "copyForPosting" }
  | { type: "openTerm"; id: string; kind: TermKind }
  | { type: "chat"; start: number; end: number };

export interface ManuscriptEditorDeps {
  highlighter: TermHighlighter;
  /** 用語から設定資料を開く。extension.ts の登録と同じ道を通す */
  openSettings(work: WorkEntry, kind: TermKind, id: string): Promise<void>;
  /**
   * 選んだところをAIに相談する。
   *
   * **相談パネルは「いま開いている本文」を普通のエディタから受け取る。**
   * 原稿エディタには `TextEditor` が無いので、同じ文書を横に開いてから
   * 渡す。開かずに相談を始めると、**前に開いていた別の作品について
   * 答えることになる**。
   */
  openChat(
    document: vscode.TextDocument,
    range: vscode.Range | undefined
  ): Promise<void>;
}

export class ManuscriptEditorProvider
  implements vscode.CustomTextEditorProvider
{
  constructor(private readonly deps: ManuscriptEditorDeps) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = buildManuscriptEditorHtml(
      createNonce(),
      panel.webview.cspSource
    );

    const send = async (): Promise<void> => {
      const text = document.getText();
      const found = await this.deps.highlighter.indexFor(
        fromUri(document.uri)
      );
      const index = found?.index;
      const kinds = new Set<TermKind>();
      if (index) {
        for (const entry of index.allEntries()) kinds.add(entry.kind);
      }
      await panel.webview.postMessage({
        type: "update",
        text,
        html: renderManuscript(text, index),
        hasTerms: (index?.size ?? 0) > 0,
        colors: colorsFor(),
        legend: [...kinds].map((kind) => ({
          kind,
          label: TERM_LABELS[kind],
        })),
        ...readAppearance(),
      });
      await this.sendCount(panel, text);
    };

    const subscriptions: vscode.Disposable[] = [];

    /**
     * 文書が変わるたびに送り直すが、**まとめてから送る**。
     *
     * 打った本文はこちらへ即座に届き、文書が変わり、その文書をまた
     * 画面へ送り返す。4万字の本文を1語ごとに組み立て直すと、
     * 打っている手が止まる（作者が実機で当たった「変換が途中で止まる」）。
     *
     * **打っている面は画面側が持っている**ので、少し遅れて届いても困らない。
     */
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSend = (): void => {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(() => {
        sendTimer = undefined;
        void send();
      }, 120);
    };

    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== document.uri.toString()) return;
        scheduleSend();
      }),
      new vscode.Disposable(() => {
        if (sendTimer) clearTimeout(sendTimer);
      })
    );

    // 色はテーマで変わる（明るい配色と暗い配色で読める色が違う）。
    // 切り替わったら送り直す
    subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        void send();
      })
    );

    panel.onDidDispose(() => {
      for (const item of subscriptions) item.dispose();
    });

    /**
     * 画面から届いた本文を、**1つずつ順に**文書へ当てる。
     *
     * ここを通していなかったために、作者が実機で当たった
     * 「改行すると空行が入る」が起きていた（2026-08-24、設計書6.25.2）。
     * 理由は `core/editQueue.ts` に書いてある。
     */
    const queueEdit = createEditQueue((text) => this.applyEdit(document, text));

    panel.webview.onDidReceiveMessage(async (message: Incoming) => {
      switch (message.type) {
        case "ready":
          await send();
          break;

        case "edit":
          await queueEdit(message.text);
          break;

        case "count":
          await this.sendCount(panel, message.text);
          break;

        case "ruby":
          await this.insertRuby(document, panel, message, "ruby");
          break;

        case "emphasis":
          await this.insertRuby(document, panel, message, "emphasis");
          break;

        case "copyForPosting":
          await this.copyForPosting(document);
          break;

        case "openTerm": {
          const found = await this.deps.highlighter.indexFor(
            fromUri(document.uri)
          );
          if (!found) return;
          await this.deps.openSettings(found.work, message.kind, message.id);
          break;
        }

        case "chat":
          await this.deps.openChat(
            document,
            message.start >= 0 && message.end > message.start
              ? new vscode.Range(
                  document.positionAt(message.start),
                  document.positionAt(message.end)
                )
              : undefined
          );
          break;
      }
    });
  }

  /**
   * 画面の本文を文書へ返す。**変わった1か所だけ**を当てる。
   */
  private async applyEdit(
    document: vscode.TextDocument,
    next: string
  ): Promise<void> {
    const edit = computeMinimalEdit(document.getText(), next);
    if (!edit) return;

    const change = new vscode.WorkspaceEdit();
    change.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(edit.start),
        document.positionAt(edit.end)
      ),
      edit.insert
    );
    const applied = await vscode.workspace.applyEdit(change);
    if (!applied) {
      // **黙って捨てない。** 当たらなかった場合、このあと文書の側の本文が
      // 画面へ送り返され、打った内容が消えたように見える。理由が残っていないと
      // 「勝手に消えた」としか分からない
      logLine(
        `原稿エディタ：打った内容を文書へ当てられませんでした（${edit.start}〜${edit.end}）。`
      );
    }
  }

  private async sendCount(
    panel: vscode.WebviewPanel,
    text: string
  ): Promise<void> {
    // **数え方は他の画面と揃える**（純／総の設定、ルビを数えるか）。
    // ここだけ違う数字が出ると、どちらが本当か分からなくなる
    const mode = currentCountMode();
    const counts = countChars(text, excludeRubyFromCount());
    await panel.webview.postMessage({
      type: "count",
      label: `${countModeLabel(mode)}${formatCount(pickCount(counts, mode))}字`,
    });
  }

  /**
   * 選んだところにルビ・傍点を入れる。
   *
   * **「読む」面から押されたときは、位置が分からない。**
   * 組み立てたHTMLの選択範囲を本文の位置へ戻すのは当てにならない
   * （ルビの読み仮名や色分けの印が混ざる）ので、そのときは
   * 「書く面で選んでください」と断る。黙って別のところへ入れない。
   */
  private async insertRuby(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    message: { text: string; start: number; end: number },
    kind: "ruby" | "emphasis"
  ): Promise<void> {
    const label = kind === "ruby" ? "ルビ" : "傍点";

    // **`.txt` へは入れない**（設計書6.12）。投稿サイトから持ってきた形を
    // そのまま保つため、txtはルビ・傍点の対象外と決めてある。この画面は
    // txtも開けるので、ここで断る
    if (!fromUri(document.uri).toLowerCase().endsWith(".md")) {
      void vscode.window.showWarningMessage(
        `${label}はMarkdown（.md）のファイルで使えます。`,
        {
          modal: true,
          detail:
            "テキスト（.txt）は投稿サイトから持ってきた形をそのまま保つため、" +
            "対象外にしています。\n\n" +
            "操作メニューの「執筆AI支援 → その他支援 → 本文を .md にする」で" +
            "変えられます（中身は1文字も変わりません）。",
        }
      );
      return;
    }

    if (message.start < 0) {
      void vscode.window.showInformationMessage(
        `${label}は「書く」面で入れてください。` +
          "読む面の選択は、組み立てた表示の上のものなので、" +
          "本文のどこを指しているかを確かめられません。"
      );
      return;
    }

    let start = message.start;
    let end = message.end;
    let base = message.text;

    if (start === end) {
      if (kind === "emphasis") {
        void vscode.window.showInformationMessage(
          "傍点を付ける文字を選んでから実行してください。"
        );
        return;
      }
      // ルビは、直前の漢字のまとまりを拾う（普通のエディタと同じ扱い）
      const before = document.getText().slice(0, start);
      const match = before.match(/[一-鿿々々ヶ]+$/u);
      if (!match) {
        void vscode.window.showInformationMessage(
          "ルビを振る文字を選んでから実行してください。" +
            "（漢字の直後なら、選ばなくても拾います）"
        );
        return;
      }
      start -= match[0].length;
      base = match[0];
    }

    let inserted: string;
    if (kind === "ruby") {
      const reading = await askText({
        title: `「${base}」の読み`,
        prompt: "ひらがな・カタカナで入力してください",
        placeHolder: "よみがな",
        validateInput: (value) => validateRuby(base, value) ?? undefined,
      });
      if (!reading) return;
      inserted = `{${base}|${reading.trim()}}`;
    } else {
      const problem = validateEmphasis(base);
      if (problem) {
        void vscode.window.showWarningMessage(problem);
        return;
      }
      inserted = `{{${base}}}`;
    }

    // **入れる直前に、選んだところが今もその文字かを確かめる。**
    // 読みを打っている間に、別の経路で本文が変わっていることがある
    const now = document.getText().slice(start, end);
    if (now !== base) {
      void vscode.window.showWarningMessage(
        `${label}を入れませんでした。` +
          "読みを入力している間に本文が変わったため、" +
          "選んだところが同じ文字ではなくなっています。"
      );
      return;
    }

    const change = new vscode.WorkspaceEdit();
    change.replace(
      document.uri,
      new vscode.Range(document.positionAt(start), document.positionAt(end)),
      inserted
    );
    await vscode.workspace.applyEdit(change);

    // 入れたところを選び直す。続けて直したくなることが多い
    await panel.webview.postMessage({
      type: "select",
      start,
      end: start + inserted.length,
    });
  }

  /**
   * 投稿サイトの記法に直してコピーする。
   *
   * **原稿には触らない。** 貼り付ける先はサイトの投稿欄である。
   * 選択は使わず本文全体を出す——画面の選択範囲は「読む」面と
   * 「書く」面で意味が違い、どちらの意味で出したのかが作者に伝わらない。
   */
  private async copyForPosting(document: vscode.TextDocument): Promise<void> {
    // **訊き方は普通のエディタと同じものを使う**（`features/ruby.ts`）。
    // 画面ごとに選択肢の言葉が違うと、同じ操作に見えなくなる
    const style = await pickStyle();
    if (!style) return;

    const source = document.getText();

    // **傍点が入っているときだけ、貼り付け先を訊く**（設計書6.12.4）。
    // ルビはどのサイトでも同じ書き方で通る
    let site: EmphasisSite = "kakuyomu";
    if (style.id === "site" && hasEmphasis(source)) {
      const picked = await pickEmphasisSite();
      if (!picked) return;
      site = picked;
    }

    await vscode.env.clipboard.writeText(
      toSiteNotation(source, style.id, site)
    );
    void vscode.window.showInformationMessage(
      `本文全体を${style.label}に変換して、クリップボードへ入れました。` +
        "原稿はそのままです。"
    );
  }
}

/**
 * 見た目の設定を読む。
 *
 * **縦書きかどうかは「はじめの向き」だけ**を決める。画面で切り替えた
 * 状態はその原稿ごとに覚える（`vscode.setState`）ので、設定を書き換えても
 * すでに開いている原稿の向きは変わらない。
 */
function readAppearance(): { verticalDefault: boolean; fontFamily: string } {
  const config = vscode.workspace.getConfiguration("novelai");
  return {
    verticalDefault: config.get<boolean>("manuscriptEditor.vertical", true),
    fontFamily: config.get<string>("manuscriptEditor.fontFamily", "").trim(),
  };
}

/** いまのテーマに合う色を選ぶ */
function colorsFor(): Record<string, string> {
  const dark =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
  const colors: Record<string, string> = {};
  for (const [kind, pair] of Object.entries(TERM_COLORS)) {
    colors[kind] = dark ? pair.dark : pair.light;
  }
  return colors;
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
