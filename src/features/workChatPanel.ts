import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { AIRegistry } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import { scanWork } from "../core/scanner";
import { episodeLabel } from "../core/manuscriptSources";
import { SYNOPSIS_FILE } from "../core/synopsisDoc";
import { CharacterStore } from "../core/characterStore";
import {
  buildExcerpt,
  classifyChatContext,
  describeChatContext,
  type ChatContextKind,
} from "../core/chatContext";
import {
  buildWorkChatPrompt,
  parseWorkChatAnswer,
  WORK_CHAT_SCHEMA,
  WORK_CHAT_SYSTEM_PROMPT,
  WORK_CHAT_VERSION,
  type WorkChatTurn,
} from "../prompts/workChat";
import {
  describeChatEditRejection,
  parseChatEdit,
  parseChatLocate,
  parseChatRun,
  sanitizeRequestedPaths,
  type ChatEdit,
  type ChatLocate,
  type ChatRunKind,
} from "../core/chatEdit";
import type { Chatter } from "../core/chatter";
import { detectRunIntent } from "../core/chatIntent";
import { findTextRange } from "../core/textLocate";
import { applyChatEdit } from "./applyChatEdit";
import { confirmPaidUsage } from "./aiConnectivity";
import { buildFeatureGuide } from "./featureGuide";
import {
  prepareRetrieval,
  search,
  type RetrievalContext,
} from "./vectorSearch";
import { describeRetrieval, formatForPrompt } from "../core/retrieval";
import {
  appendChatLog,
  summarizeMaterials,
  type ChatLogMaterial,
} from "../core/chatLog";
import {
  buildSearchQuery,
  buildSearchTermsPrompt,
  parseSearchTerms,
  SEARCH_TERMS_SCHEMA,
  SEARCH_TERMS_SYSTEM_PROMPT,
} from "../prompts/searchTerms";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { renderMarkdownLite } from "../core/markdownLite";
import { buildWorkChatPanelHtml } from "../views/workChatPanelHtml";
import { cancelItem } from "../views/dialogs";

/**
 * 相談パネル（P-21）。
 *
 * **いま開いている画面について、自然文で聞ける場所。** 作者の要望で作った。
 * 設定資料パネルの相談（P-18）は1つのレコードについて聞くものだったが、
 * こちらは本文でもプロットでも設定資料でも、開いているものについて聞ける。
 *
 * 返事には**次の一手の選択肢**が付く。押すだけで話が進むので、
 * 「気に入らないときにどう言い直すか」を作者が毎回考えずに済む。
 *
 * **加筆修正は作者が押したときだけ行う**（作者の許可、2026-08-15）。
 * AIは書き込む内容を提案するところまでで、実際に書くのはボタンが
 * 押されたときである。会話の流れでAIが勝手にファイルを触ると、
 * どこが変わったのか追えなくなる。本文（原稿）は許可の対象外で、
 * この画面からは書き換えられない。
 *
 * **足りない材料はAIから求めさせる。** 作品フォルダーの中に限り、
 * 「このファイルを見せてほしい」と言われたら渡して聞き直す
 * （`needFiles`）。毎回すべてを渡すと入力が膨らんで料金がかかるため、
 * 必要になったときだけ読む。
 */

export const WORK_CHAT_VIEW_ID = "novelai.chatView";

/** 一度に渡す抜粋の上限。長い本文（73万字のファイルがある）を丸ごと渡せない */
const EXCERPT_CHARS = 4_000;

/**
 * 質問に近い場面へ割く文字数。
 *
 * 開いている画面の抜粋（4,000字）とは別枠。合わせて約12,000字で、
 * 既存の抜粋の上限と同じ量に収まる。
 */
const RELATED_MAX_CHARS = 8_000;
/** 覚えておくやり取りの数。増やすほど入力が伸びて料金がかかる */
const HISTORY_TURNS = 12;
/** AIの求めに応じて読むファイルの上限。読みすぎると入力が膨らむ */
const MAX_REQUESTED_FILES = 3;
/** 1ファイルあたりに渡す上限 */
const REQUESTED_FILE_CHARS = 6_000;
/** 該当箇所の印を残す時間。見つけたあとは要らないので消す */
const HIGHLIGHT_MS = 8_000;

/**
 * 全体像に並べる話数の上限。
 *
 * 219話の作品でそのまま並べると4,000字を超え、
 * 肝心の本文の抜粋が入らなくなる。
 */
const OVERVIEW_EPISODE_LIMIT = 40;
/** 全体像に載せる紹介文・プロットの上限 */
const OVERVIEW_FILE_CHARS = 2_000;

type Incoming =
  | { type: "ready" }
  | { type: "ask"; question: string }
  | { type: "clear" }
  | { type: "applyEdit"; id: string }
  | { type: "run"; id: string }
  | { type: "locate"; id: string };

/**
 * 標準機能を起動する口。
 *
 * **相談パネル自身は機能を持たない。** 誤字脱字の検知は結果を提案パネルへ
 * 出すところまでが一続きで、そのパネルは `extension.ts` が持っている。
 * ここでコマンド名を組み立てて `executeCommand` を呼ぶより、
 * 呼び出し側から起動の口を渡してもらうほうが、**何が起動されうるかが
 * 型で閉じる**（AIの返した文字列がコマンド名になる余地が無い）。
 */
export interface ChatRunner {
  run(work: WorkEntry, kind: ChatRunKind, filePath?: string): Promise<void>;
}

export class WorkChatPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private history: WorkChatTurn[] = [];

  /**
   * 押されるのを待っている書き込みの提案。
   *
   * 会話の中身ではなくここに持つのは、**押した瞬間の内容で書くため**。
   * 画面の文字列から読み直すと、表示の都合で変わった内容を書きかねない。
   */
  private readonly pendingEdits = new Map<
    string,
    { edit: ChatEdit; work: WorkEntry }
  >();
  /** 押されるのを待っている機能起動の提案 */
  private readonly pendingRuns = new Map<
    string,
    { kind: ChatRunKind; work: WorkEntry; filePath?: string }
  >();
  /** 押されるのを待っている「そこを見せて」の提案 */
  private readonly pendingLocates = new Map<
    string,
    { locate: ChatLocate; work: WorkEntry; fallbackPath: string }
  >();
  private editSeq = 0;

  /**
   * 有料のAIについて確認を取り終えたモデル名。
   *
   * モデルを含めて覚えるのは、**AIを切り替えたら確認をやり直すため**。
   * 無料のOllamaから有料のClaudeへ移ったとき、黙って課金が始まっては困る。
   */
  private paidConfirmedFor: string | undefined;

  /** 検索の材料。作品が変わるまで使い回す（毎回読み直すと重い） */
  private retrieval: RetrievalContext | undefined;
  private retrievalWorkId: string | undefined;

  /**
   * ファイルを開いていないときに相談する作品。
   *
   * 覚えておかないと、質問のたびに選び直すことになる。
   */
  private selectedWorkId: string | undefined;

  /**
   * 該当箇所に掛ける色。
   *
   * 選択（カーソル）だけでも位置は分かるが、作者が本文をクリックすると
   * 消えてしまう。話の間だけ残る印として重ねる。
   */
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    borderRadius: "2px",
  });
  private highlightTimer: ReturnType<typeof setTimeout> | undefined;

  dispose(): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlight.dispose();
  }

  /**
   * 直前に開いていた本文エディター。
   *
   * **相談パネルへフォーカスが移ると `activeTextEditor` は undefined になる。**
   * 質問を打っている最中はまさにその状態なので、覚えておかないと
   * 「何について聞かれているか」が毎回分からなくなる。
   */
  private lastEditor: vscode.TextEditor | undefined;

  constructor(
    private readonly registry: WorkRegistry,
    private readonly ai: AIRegistry,
    private readonly runner: ChatRunner
  ) {
    this.lastEditor = vscode.window.activeTextEditor;
  }

  /**
   * パネルが画面に出ているか。
   *
   * 独り言は、見ていないところへ書き溜めても意味がない。
   * 畳まれている（`visible === false`）ときは黙る。
   */
  isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  /** エディターが変わったら覚え直す。拡張機能側から呼ぶ */
  trackEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    if (editor.document.uri.scheme !== "file") return;
    this.lastEditor = editor;
    void this.postContext();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = buildWorkChatPanelHtml(
      createNonce(),
      webviewView.webview.cspSource
    );
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handle(message as Incoming);
    });
  }

  private async handle(message: Incoming): Promise<void> {
    if (message.type === "ready") {
      await this.postContext();
      return;
    }
    if (message.type === "clear") {
      this.history = [];
      // 会話をやり直すなら、料金の確認も取り直す
      this.paidConfirmedFor = undefined;
      return;
    }
    if (message.type === "ask") {
      await this.ask(message.question);
      return;
    }
    if (message.type === "applyEdit") {
      await this.applyEdit(message.id);
      return;
    }
    if (message.type === "run") {
      await this.runFeature(message.id);
      return;
    }
    if (message.type === "locate") {
      await this.showLocation(message.id);
    }
  }

  /** いま何について相談できるかを画面に出す */
  private async postContext(): Promise<void> {
    if (!this.view) return;
    const context = await this.resolveContext();
    const resolved = this.ai.resolve();
    void this.view.webview.postMessage({
      type: "context",
      label: context ? context.label : "作品のファイルを開いてください",
      provider: resolved
        ? `${resolved.provider.displayName}（${resolved.model}）`
        : "AI未設定",
      // 有料かどうかは、押す前に常に見えている必要がある。
      // 確認は会話ごとに一度しか出さないため、印は出し続ける
      paid: resolved?.provider.isPaid ?? false,
    });
  }

  private async ask(question: string): Promise<void> {
    if (!this.view) return;

    const resolved = this.ai.resolve();
    if (!resolved) {
      this.postError(
        "AIが設定されていません。操作メニューの「AIの設定」から設定してください。"
      );
      return;
    }

    // 有料のAIは送るたびに課金される。**会話ごとに一度だけ確認を取る。**
    // 毎回モーダルを出すと相談にならず、一度も出さないと知らないうちに
    // 積み上がる。あわせて画面上部に「有料」と出し続ける（postContext）
    if (resolved.provider.isPaid && this.paidConfirmedFor !== resolved.model) {
      const ok = await confirmPaidUsage(resolved.provider, {
        actionLabel: "AIへの相談",
        model: resolved.model,
        detail:
          "送信するたびに1回ずつ課金されます。\n" +
          "会話が続くほど、これまでのやり取りも一緒に送るため入力が長くなります。\n" +
          "（この確認はこの会話で一度だけです。「最初から」を押すと再び確認します）",
      });
      if (!ok) {
        void this.view.webview.postMessage({ type: "cancelled" });
        return;
      }
      this.paidConfirmedFor = resolved.model;
    }

    const context = await this.resolveContext();
    if (context) useLogFile(context.work.folderPath);

    // **質問に近い場面を作品全体から探して足す。**
    // 開いている画面の前後だけでは、大きい作品でほとんど答えられなかった
    // （78.5万字の作品で、実測3問中0問）。
    const found = context
      ? await this.findRelated(context.work, question)
      : { reference: [], searchTerms: [], materials: [] };
    const started = Date.now();

    try {
      logStep(`相談: v${WORK_CHAT_VERSION} / ${resolved.model}`);

      const call = (
        requestedFiles?: Array<{ path: string; content: string }>
      ) =>
        resolved.provider.generate({
          systemPrompt: WORK_CHAT_SYSTEM_PROMPT,
          userPrompt: buildWorkChatPrompt({
            workTitle: context?.work.title ?? "（作品を特定できません）",
            contextKind: context?.kind ?? "outside",
            contextLabel: context?.label ?? "作品のファイル以外",
            excerpt: context?.excerpt ?? "",
            excerptTruncated: context?.truncated ?? false,
            fromSelection: context?.fromSelection ?? false,
            reference: [...(context?.reference ?? []), ...found.reference],
            requestedFiles,
            history: this.history.slice(-HISTORY_TURNS),
            question,
            // 使い方を聞かれたときに答えられるよう、機能の一覧を渡す。
            // 組み立ては安いので、毎回作り直してよい（実装と食い違わない）
            featureGuide: buildFeatureGuide(),
          }),
          model: resolved.model,
          // 相談は考えを広げる場なので、抽出よりは揺らす
          temperature: 0.7,
          jsonSchema: WORK_CHAT_SCHEMA as unknown as object,
          disableThinking: true,
        });

      let result = await call();
      let answer = parseWorkChatAnswer(result.text);
      let readFiles: string[] = [];

      // 材料が足りないと言われたら、作品フォルダーの中から渡して聞き直す。
      // **往復は1回だけ。** 際限なく求められると料金と待ち時間が読めなくなる
      const wanted = context
        ? sanitizeRequestedPaths(answer.needFiles, MAX_REQUESTED_FILES)
        : [];
      if (wanted.length > 0) {
        const files = await this.readWorkFiles(context!.work, wanted);
        if (files.length > 0) {
          readFiles = files.map((file) => file.path);
          void this.view.webview.postMessage({
            type: "reading",
            files: readFiles,
          });
          result = await call(files);
          answer = parseWorkChatAnswer(result.text);
        }
      }

      if (!answer.reply) {
        this.postError("返事が空でした。もう一度お試しください。");
        return;
      }

      this.history.push(
        { role: "author", text: question },
        { role: "assistant", text: answer.reply }
      );

      // 提案は先に解釈しておく。**記録には解釈後のものを残す。**
      // AIが返した生の値を残しても、実際に押せる形になったかが分からない
      // **AIが run を落としてもこちらで補う。**
      // 「抽出して」と頼まれているのに会話の中で書き出してしまい、
      // 押せるボタンが出ない状態が実機で続いた（2026-08-15）。
      // 「作業を頼まれたか」は規則で見分けられるので、コード側で決める。
      const intended = detectRunIntent(question);
      const staged = {
        edit: this.stageEdit(answer.edit, context?.work),
        run:
          this.stageRun(answer.run, context) ??
          (intended ? this.stageRun(intended, context) : undefined),
        locate: this.stageLocate(answer.locate, context),
      };

      if (context) {
        appendChatLog(context.work, {
          panel: "相談パネル",
          promptVersion: WORK_CHAT_VERSION,
          provider: resolved.provider.displayName,
          model: resolved.model,
          paid: resolved.provider.isPaid,
          target: context.label,
          fromSelection: context.fromSelection,
          searchTerms: found.searchTerms,
          retrieval: found.retrieval,
          materials: found.materials,
          question,
          reply: answer.reply,
          options: answer.options,
          proposals: describeStagedProposals(staged),
          requestedFiles: readFiles,
          elapsedMs: Date.now() - started,
          usage: result.usage,
        });
      }

      void this.view.webview.postMessage({
        type: "answer",
        reply: answer.reply,
        // AIはMarkdownで返してくる。記号のまま見せない
        html: renderMarkdownLite(answer.reply),
        options: answer.options,
        ...staged,
      });
    } catch (error) {
      const message =
        error instanceof AIError
          ? `${error.message} ${recoveryForAIError(error)}`
          : error instanceof Error
            ? error.message
            : String(error);
      logFailure("相談", { 内容: message });
      // 失敗も残す。**うまくいった回だけ記録すると、
      // 何が起きて答えが返らなかったのかを後から追えない**
      if (context) {
        appendChatLog(context.work, {
          panel: "相談パネル",
          promptVersion: WORK_CHAT_VERSION,
          provider: resolved.provider.displayName,
          model: resolved.model,
          paid: resolved.provider.isPaid,
          target: context.label,
          searchTerms: found.searchTerms,
          retrieval: found.retrieval,
          materials: found.materials,
          question,
          reply: "",
          elapsedMs: Date.now() - started,
          error: message,
        });
      }
      this.postError(message);
    }
  }


  private postError(message: string): void {
    void this.view?.webview.postMessage({ type: "error", message });
  }

  /**
   * 書き込みの提案を受け取り、押されるまで持っておく。
   *
   * **ここでは書かない。** 返すのは画面に出すためのボタンの情報だけで、
   * 実際の書き込みは `applyEdit`（作者が押したとき）で行う。
   */
  private stageEdit(
    raw: unknown,
    work: WorkEntry | undefined
  ): { id: string; label: string; preview: string } | undefined {
    if (raw === undefined || raw === null || !work) return undefined;

    const parsed = parseChatEdit(raw);
    if (!parsed.ok) {
      // 本文を書き換えようとした場合など、黙って捨てると理由が伝わらない
      if (parsed.reason === "manuscript_not_allowed") {
        void this.view?.webview.postMessage({
          type: "note",
          message: describeChatEditRejection(parsed.reason),
        });
      }
      return undefined;
    }

    const id = `edit-${++this.editSeq}`;
    this.pendingEdits.set(id, { edit: parsed.edit, work });
    return {
      id,
      label: parsed.edit.label,
      preview: parsed.edit.content,
    };
  }

  /**
   * 標準機能の起動の提案を受け取り、押されるまで持っておく。
   *
   * **許可した一覧に無いものは黙って捨てる。** AIが返した文字列が
   * そのままコマンド名になる余地を残さない。
   */
  private stageRun(
    raw: unknown,
    context: ResolvedContext | undefined
  ): { id: string; label: string; usesAI: boolean } | undefined {
    if (raw === undefined || raw === null || !context) return undefined;

    const parsed = parseChatRun(raw);
    if (!parsed) return undefined;

    // 「この話だけ」は本文を開いているときにしか意味がない。
    // 開いていなければ作品全体の検知に読み替える
    let kind = parsed.kind;
    let label = parsed.label;
    if (kind === "checkTyposForFile" && context.kind !== "manuscript") {
      kind = "checkTypos";
      label = "誤字脱字を検知する";
    }

    const id = `run-${++this.editSeq}`;
    this.pendingRuns.set(id, {
      kind,
      work: context.work,
      filePath: kind === "checkTyposForFile" ? context.filePath : undefined,
    });
    return { id, label, usesAI: parsed.usesAI };
  }

  /** 「そこを見せて」の提案を受け取り、押されるまで持っておく */
  private stageLocate(
    raw: unknown,
    context: ResolvedContext | undefined
  ): { id: string; label: string } | undefined {
    if (raw === undefined || raw === null || !context) return undefined;

    const locate = parseChatLocate(raw);
    if (!locate) return undefined;

    const id = `locate-${++this.editSeq}`;
    this.pendingLocates.set(id, {
      locate,
      work: context.work,
      fallbackPath: context.filePath,
    });
    return { id, label: locate.label };
  }

  /**
   * 該当箇所を開いて光らせる。
   *
   * **AIが引用した文字列が本当にそこにあるかを照合してから光らせる。**
   * 照合せずに位置だけ信じると、少し言い換えた引用に対して別の場所を
   * 光らせることになり、作者は「そこは何も問題ないが」と混乱する。
   * 見つからなければ、ファイルを開くところまでで止めてそう伝える。
   */
  private async showLocation(id: string): Promise<void> {
    const staged = this.pendingLocates.get(id);
    if (!staged) {
      this.postError("この提案はもう使えません。もう一度聞いてください。");
      return;
    }

    const target = staged.locate.path
      ? path.resolve(staged.work.folderPath, staged.locate.path)
      : staged.fallbackPath;

    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(target)
      );
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        // 相談を続けられるよう、パネルからフォーカスを奪わない
        preserveFocus: true,
      });

      if (!staged.locate.text) {
        void this.view?.webview.postMessage({
          type: "locateDone",
          id,
          message: `${path.basename(target)} を開きました。`,
        });
        return;
      }

      const found = findTextRange(document.getText(), staged.locate.text);
      if (!found) {
        void this.view?.webview.postMessage({
          type: "locateFailed",
          id,
          message:
            `${path.basename(target)} を開きましたが、` +
            "その文章は見つかりませんでした（引用が本文と少し違うようです）。",
        });
        return;
      }

      const range = new vscode.Range(
        found.line,
        found.character,
        found.endLine,
        found.endCharacter
      );
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.applyHighlight(editor, range);

      void this.view?.webview.postMessage({
        type: "locateDone",
        id,
        message: `${path.basename(target)} の ${found.line + 1}行目を開きました。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void this.view?.webview.postMessage({
        type: "locateFailed",
        id,
        message: `開けませんでした: ${message}`,
      });
    }
  }

  /**
   * 印を掛ける。しばらく経ったら消す。
   *
   * 消さないと、次に別の話をしていても前の印が残り続ける。
   * 「どこを指しているか」を示すのが目的なので、見つけたあとは要らない。
   */
  private applyHighlight(editor: vscode.TextEditor, range: vscode.Range): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    editor.setDecorations(this.highlight, [range]);
    this.highlightTimer = setTimeout(() => {
      editor.setDecorations(this.highlight, []);
      this.highlightTimer = undefined;
    }, HIGHLIGHT_MS);
  }

  /** 作者がボタンを押したときだけ、標準機能を起動する */
  private async runFeature(id: string): Promise<void> {
    const staged = this.pendingRuns.get(id);
    if (!staged) {
      this.postError("この提案はもう使えません。もう一度聞いてください。");
      return;
    }
    this.pendingRuns.delete(id);

    try {
      await this.runner.run(staged.work, staged.kind, staged.filePath);
      void this.view?.webview.postMessage({
        type: "runDone",
        id,
        message: "実行しました。結果は下段の「提案」パネルに出ます。",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談からの機能起動", { 内容: message });
      void this.view?.webview.postMessage({
        type: "runFailed",
        id,
        message: `実行できませんでした: ${message}`,
      });
    }
  }

  /** 作者がボタンを押したときだけ、ここで実際に書き込む */
  private async applyEdit(id: string): Promise<void> {
    const staged = this.pendingEdits.get(id);
    if (!staged) {
      this.postError("この提案はもう使えません。もう一度聞いてください。");
      return;
    }

    try {
      const where = await applyChatEdit(staged.work, staged.edit);
      this.pendingEdits.delete(id);
      void this.view?.webview.postMessage({
        type: "editApplied",
        id,
        message: `${staged.edit.label.replace(/に書き込む$/, "")}に書き込みました（${where}）`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談からの書き込み", { 内容: message });
      void this.view?.webview.postMessage({
        type: "editFailed",
        id,
        message: `書き込めませんでした: ${message}`,
      });
    }
  }

  /**
   * AIが求めたファイルを、作品フォルダーの中からだけ読む。
   *
   * パスの安全確認は `sanitizeRequestedPaths` で済ませているが、
   * **解決後のパスが本当に作品フォルダーの中かを、ここでもう一度確かめる。**
   * 記号リンクなどで外へ出られる余地を残さないため。
   */
  private async readWorkFiles(
    work: WorkEntry,
    relativePaths: string[]
  ): Promise<Array<{ path: string; content: string }>> {
    const root = path.resolve(work.folderPath);
    const files: Array<{ path: string; content: string }> = [];

    for (const relative of relativePaths) {
      const target = path.resolve(root, relative);
      if (target !== root && !target.startsWith(root + path.sep)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.file(target)
        );
        const text = new TextDecoder().decode(bytes);
        files.push({
          path: relative,
          content:
            text.length > REQUESTED_FILE_CHARS
              ? `${text.slice(0, REQUESTED_FILE_CHARS)}\n（以下省略）`
              : text,
        });
      } catch {
        // 読めないファイルは黙って飛ばす。AIの言うパスが実在するとは限らない
      }
    }
    return files;
  }

  /** 開いているファイルから、相談の材料を組み立てる */
  /**
   * ファイルを開いていないときの相談相手を決める。
   *
   * **登録が1作品ならそれを使う。** わざわざ選ばせる意味がない。
   * 複数あるときは、作者が選ぶまで決めない（別の作品の資料を
   * 抽出し始めては困る）。選んだ作品は覚えておく。
   */
  private async workOnlyContext(): Promise<ResolvedContext | undefined> {
    const works = this.registry.list();
    if (works.length === 0) return undefined;

    const chosen =
      works.find((work) => work.id === this.selectedWorkId) ??
      (works.length === 1 ? works[0] : undefined);
    if (!chosen) return undefined;

    this.selectedWorkId = chosen.id;
    return {
      work: chosen,
      kind: "workOnly",
      filePath: chosen.folderPath,
      label: describeChatContext("workOnly", chosen.title),
      excerpt: "",
      truncated: false,
      fromSelection: false,
      reference: await this.buildReference(chosen, "workOnly"),
    };
  }

  /**
   * 相談する作品を選び直す。
   *
   * 作品を開いていないときの相談相手を、作者が決められるようにする。
   * 開いているファイルがあれば、そちらが優先される（画面と食い違わないため）。
   */
  async chooseWork(): Promise<void> {
    const works = this.registry.list();
    if (works.length === 0) {
      vscode.window.showInformationMessage("作品が登録されていません。");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [
        ...works.map((work) => ({ label: work.title, work })),
        cancelItem(),
      ],
      { title: "どの作品について相談しますか", ignoreFocusOut: true }
    );
    if (!picked || !("work" in picked)) return;
    this.selectedWorkId = picked.work.id;
    await this.postContext();
  }

  /**
   * 相談する作品を、画面を介さずに決める。
   *
   * 新規作品を作った直後に、その作品についてのプロット相談を始めるために使う。
   * 作ったばかりの作品はまだ何も開いていないので、
   * 何について相談しているのかがパネルに出ない。
   */
  async focusWork(work: WorkEntry): Promise<void> {
    this.selectedWorkId = work.id;
    // 別の作品を開いたまま新規作成した場合、そちらが優先されてしまう。
    // 作りたてのほうを見るために、覚えているエディターを手放す
    this.lastEditor = undefined;
    await this.postContext();
  }

  /**
   * AIの独り言を差し込む（設計書6.21）。
   *
   * **作者が聞いていない発言である。** 会話の履歴（`history`）には積まない。
   * 積むと、次の質問のたびに「1,000文字を超えました」まで一緒に
   * AIへ送ることになり、入力が伸びるうえ答えの邪魔になる。
   *
   * 押せる口（`run`）は、質問への答えと同じ仕組みで持っておく。
   * ここでも**一覧に無い操作は起動できない**（`stageRun`）。
   */
  postChatter(
    chatter: Chatter,
    work: WorkEntry,
    filePath?: string
  ): void {
    if (!this.view) return;

    let run: { id: string; label: string; usesAI: boolean } | undefined;
    // 許可した一覧と突き合わせてから持つ。**独り言でも例外にしない。**
    // AIを使うかどうかも一覧側の値を使う（ボタンに出すため）
    const parsed = chatter.run ? parseChatRun(chatter.run.kind) : undefined;
    if (parsed) {
      const id = `run-${++this.editSeq}`;
      this.pendingRuns.set(id, {
        kind: parsed.kind,
        work,
        filePath: parsed.kind === "checkTyposForFile" ? filePath : undefined,
      });
      run = { id, label: parsed.label, usesAI: parsed.usesAI };
    }

    void this.view.webview.postMessage({
      type: "chatter",
      who: "AI（独り言）",
      text: chatter.text,
      run,
    });
  }

  /**
   * プロット作りの相談を始める（設計書6.21.2）。
   *
   * **こちらから最初の一言を出す。** 白紙の入力欄だけ出されても、
   * プロットの何をどう聞けばよいのかは分からない。
   * 聞ける例を並べて、押すだけで始められるようにする。
   *
   * 例はコードで持つ。ここでAIを呼ぶと、作品を作った直後の
   * いちばん待たされたくないところで数十秒待たせることになる。
   */
  async startPlotAdvice(work: WorkEntry): Promise<void> {
    await this.focusWork(work);
    if (!this.view) return;

    void this.view.webview.postMessage({
      type: "chatter",
      who: "AI",
      text:
        `「${work.title}」を始めましたね。プロットを一緒に考えましょうか。\n` +
        "思いついていることを何でも書いてください。断片でかまいません。\n" +
        "下の例を押しても始められます。",
      options: PLOT_ADVICE_OPTIONS,
    });
  }

  private async resolveContext(): Promise<ResolvedContext | undefined> {
    const editor = this.lastEditor;
    const filePath =
      editor && editor.document.uri.scheme === "file"
        ? editor.document.uri.fsPath
        : undefined;
    const work = filePath ? this.findWork(filePath) : undefined;

    // **ファイルを開いていなくても相談できるようにする。**
    // 以前はここで undefined を返しており、作品を開いていないだけで
    // 起動ボタンも材料も出なかった（作者の指摘、2026-08-15）
    if (!work || !filePath) return this.workOnlyContext();

    const config = await readWorkConfig(work);
    const settingsDirName = path.basename(workPaths(work, config).settings);
    const relativePath = path.relative(work.folderPath, filePath);

    let isEpisode = false;
    let chapterLabel: string | null = null;
    try {
      const scan = await scanWork(work);
      const episode = scan.episodes.find(
        (item) => path.resolve(item.filePath) === path.resolve(filePath)
      );
      isEpisode = Boolean(episode);
      chapterLabel =
        episode?.chapterStart !== null && episode?.chapterStart !== undefined
          ? `第${episode.chapterStart}話`
          : null;
    } catch {
      // 走査できなくても相談はできる。本文かどうかが分からないだけ
    }

    const kind = classifyChatContext({
      relativePath,
      settingsDirName,
      isEpisode,
    });

    // ここへ来る時点でファイルは決まっている（上で workOnly へ分けている）
    const document = editor!.document;
    const selection = document.getText(editor!.selection);
    const excerpt = buildExcerpt({
      text: document.getText(),
      selection: selection || undefined,
      caret: document.offsetAt(editor!.selection.active),
      maxChars: EXCERPT_CHARS,
    });

    return {
      work,
      kind,
      filePath,
      label: describeChatContext(
        kind,
        path.basename(filePath),
        chapterLabel
      ),
      excerpt: excerpt.text,
      truncated: excerpt.truncated,
      fromSelection: Boolean(selection.trim()),
      reference: await this.buildReference(work, kind),
    };
  }

  /**
   * 文脈に応じた材料。
   *
   * **本文やプロットの相談では、登場人物の名前が要る。** 名前を知らないと
   * AIは人物を「主人公」としか呼べず、話が噛み合わない。
   * 設定資料そのものを開いているときは、画面の内容に既に入っているので渡さない。
   */
  /**
   * 質問に近い場面を、作品全体から探して渡す。
   *
   * 開いている画面の前後だけでは足りない。実データ（78.5万字・219話）で、
   * 冒頭から詰める従来のやり方は3問中0問しか答えられなかったのに対し、
   * 質問で探した材料を渡すと3問とも答えられた。
   *
   * **失敗しても相談は続ける。** 探せなかっただけで止めると、
   * 今までできていた「開いている画面についての相談」までできなくなる。
   */
  private async findRelated(
    work: WorkEntry,
    question: string
  ): Promise<{
    reference: string[];
    searchTerms: string[];
    retrieval?: string;
    materials: ChatLogMaterial[];
  }> {
    const empty = { reference: [], searchTerms: [], materials: [] };
    try {
      // 作品が変わったら作り直す。前の作品の場面を渡さないため
      if (!this.retrieval || this.retrievalWorkId !== work.id) {
        this.retrieval = await prepareRetrieval(work);
        this.retrievalWorkId = work.id;
      }

      const terms = await this.expandSearchTerms(work, question);
      const found = await search(
        this.retrieval,
        buildSearchQuery(question, terms),
        { maxChars: RELATED_MAX_CHARS }
      );
      if (found.length === 0) return { ...empty, searchTerms: terms };

      // 何を参照したかを作者にも見せる。材料が見えないまま答えが出ると、
      // どこ由来の話なのか確かめようがない
      const retrieval = describeRetrieval(found);
      void this.view?.webview.postMessage({ type: "searched", summary: retrieval });

      return {
        reference: [
          "【質問に近い場面】（出どころを添えています。" +
            "設定資料とあらすじは本文からAIが作ったものなので、" +
            "本文と食い違うときは本文を優先してください）\n" +
            formatForPrompt(found),
        ],
        searchTerms: terms,
        retrieval,
        materials: summarizeMaterials(
          found.map((candidate) => ({
            label: `${candidate.item.source}・${candidate.item.label}`,
            text: candidate.item.text,
          }))
        ),
      };
    } catch (error) {
      logFailure("相談パネルの検索に失敗（開いている画面だけで続行）", {
        理由: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  }

  /** 質問を検索語へ直す。失敗しても質問文のまま検索する */
  private async expandSearchTerms(
    work: WorkEntry,
    question: string
  ): Promise<string[]> {
    try {
      const resolved = await this.ai.resolve();
      if (!resolved) return [];
      const names = await this.characterNames(work);
      const result = await resolved.provider.generate({
        systemPrompt: SEARCH_TERMS_SYSTEM_PROMPT,
        userPrompt: buildSearchTermsPrompt({ question, knownTerms: names }),
        model: resolved.model,
        temperature: 0.2,
        jsonSchema: SEARCH_TERMS_SCHEMA,
        disableThinking: true,
      });
      return parseSearchTerms(result.text);
    } catch (error) {
      logFailure("検索語の作成に失敗（質問文のまま検索）", {
        理由: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async characterNames(work: WorkEntry): Promise<string[]> {
    try {
      const loaded = await new CharacterStore(work).loadAll();
      return loaded.characters
        .filter((character) => !character.isMob)
        .map((character) => character.name);
    } catch {
      return [];
    }
  }

  private async buildReference(
    work: WorkEntry,
    kind: ChatContextKind
  ): Promise<string[]> {
    if (kind === "outside") return [];

    const blocks: string[] = [];

    // **作品の全体像を毎回渡す。** 開いている画面の前後だけでは
    // 「この作品はどういう話か」に答えられず、作者から
    // 「作品全体を読み込んでほしい」という指摘を受けた（2026-08-15）。
    // 全文は渡せないので、**畳んだ形**で渡す。詳しい場面は検索が拾う。
    const overview = await this.buildOverview(work);
    if (overview) blocks.push(overview);

    // 設定資料そのものを開いているときは、画面の内容と重なるので名前は省く
    if (kind !== "settingsDoc") {
      try {
        const loaded = await new CharacterStore(work).loadAll();
        const names = loaded.characters
          .filter((character) => !character.isMob)
          .map((character) => character.name);
        if (names.length > 0) {
          blocks.push(`登場人物: ${names.slice(0, 60).join("、")}`);
        }
      } catch {
        // 設定資料が無い作品もある。名前が無いだけで相談はできる
      }
    }

    return blocks;
  }

  /**
   * 作品の全体像を、畳んだ形で組み立てる。
   *
   * **全文は渡せない**（78.5万字の作品がある）ので、
   * 作品紹介文・プロットの要点・話数の一覧という「目次」を渡す。
   * どこに何があるかが分かれば、AIは needFiles で必要な話を求められる。
   *
   * 話数の一覧は上限を設ける。219話の作品でそのまま並べると
   * 4,000字を超え、肝心の本文の抜粋が入らなくなる。
   */
  private async buildOverview(work: WorkEntry): Promise<string | undefined> {
    const lines: string[] = [];

    try {
      const scan = await scanWork(work);
      const total = scan.episodes.length;
      if (total > 0) {
        lines.push(`全${total}話。`);

        const labels = scan.episodes.map((episode) => episodeLabel(episode));
        // 多いときは先頭と末尾だけ見せる。**間を省いたことを明記する**
        // （省略に気づかないと「これで全部」と誤解する）
        if (labels.length <= OVERVIEW_EPISODE_LIMIT) {
          lines.push(`話の一覧: ${labels.join(" / ")}`);
        } else {
          const head = labels.slice(0, OVERVIEW_EPISODE_LIMIT / 2).join(" / ");
          const tail = labels.slice(-OVERVIEW_EPISODE_LIMIT / 2).join(" / ");
          lines.push(
            `話の一覧（多いため中間を省略）: ${head} …（中略）… ${tail}`
          );
        }
      }
    } catch {
      // 走査できなくても、紹介文とプロットだけで全体像は伝わる
    }

    for (const [label, relative] of [
      ["作品紹介文・各話あらすじ", SYNOPSIS_FILE],
      ["プロット", "plot.md"],
    ] as const) {
      const text = await this.readSettingsFile(work, relative);
      if (!text) continue;
      lines.push(
        `【${label}（${relative}）】\n` +
          (text.length > OVERVIEW_FILE_CHARS
            ? `${text.slice(0, OVERVIEW_FILE_CHARS)}\n（以下省略。全文が要るなら needFiles で求めてください）`
            : text)
      );
    }

    if (lines.length === 0) return undefined;
    return `【作品の全体像】\n${lines.join("\n")}`;
  }

  private async readSettingsFile(
    work: WorkEntry,
    fileName: string
  ): Promise<string | undefined> {
    try {
      const config = await readWorkConfig(work);
      const target = path.join(workPaths(work, config).settings, fileName);
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
      const text = new TextDecoder().decode(bytes).trim();
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  private findWork(filePath: string): WorkEntry | undefined {
    const resolved = path.resolve(filePath);
    // 入れ子になった作品でも正しく選べるよう、長く一致するほうを採る
    let found: WorkEntry | undefined;
    for (const work of this.registry.list()) {
      const root = path.resolve(work.folderPath);
      if (resolved === root || resolved.startsWith(root + path.sep)) {
        if (!found || root.length > path.resolve(found.folderPath).length) {
          found = work;
        }
      }
    }
    return found;
  }
}

interface ResolvedContext {
  work: WorkEntry;
  kind: ChatContextKind;
  label: string;
  /** 開いているファイルの絶対パス。「この話だけ」の検知に渡す */
  filePath: string;
  excerpt: string;
  truncated: boolean;
  fromSelection: boolean;
  reference: string[];
}

/**
 * 押されるのを待っている提案を、記録用の短い行にする。
 *
 * **解釈が通ったものだけを残す。** AIが返した生の値を書いても、
 * 実際に押せる形になったのかが後から分からない。
 */
function describeStagedProposals(staged: {
  edit?: { label: string } | undefined;
  run?: { label: string; usesAI: boolean } | undefined;
  locate?: { label: string } | undefined;
}): string[] {
  const out: string[] = [];
  if (staged.edit) out.push(`書き込み: ${staged.edit.label}`);
  if (staged.run) {
    out.push(`機能の起動: ${staged.run.label}${staged.run.usesAI ? "（AIを使う）" : ""}`);
  }
  if (staged.locate) out.push(`該当箇所: ${staged.locate.label}`);
  return out;
}

/**
 * プロット相談の口火に出す例。
 *
 * **「プロットを作って」を先頭に置かない。** まだ何も書いていない作品では、
 * AIは材料なしに筋書きを丸ごと作ることになり、作者のものではない話が出てくる。
 * **作者の中にあるものを引き出す問いから始める。**
 */
const PLOT_ADVICE_OPTIONS = [
  "書きたい場面が1つだけあります。そこから話を広げるにはどうしますか？",
  "主人公をどう決めればよいか相談したいです",
  "プロットに何を書いておくと、あとで迷わずに済みますか？",
  "似た題材の作品と、どこで差を付ければよいでしょうか",
] as const;

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
