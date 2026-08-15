import * as vscode from "vscode";
import * as path from "path";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { AIRegistry } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import { scanWork } from "../core/scanner";
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
import { findTextRange } from "../core/textLocate";
import { applyChatEdit } from "./applyChatEdit";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { buildWorkChatPanelHtml } from "../views/workChatPanelHtml";

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
/** 覚えておくやり取りの数。増やすほど入力が伸びて料金がかかる */
const HISTORY_TURNS = 12;
/** AIの求めに応じて読むファイルの上限。読みすぎると入力が膨らむ */
const MAX_REQUESTED_FILES = 3;
/** 1ファイルあたりに渡す上限 */
const REQUESTED_FILE_CHARS = 6_000;
/** 該当箇所の印を残す時間。見つけたあとは要らないので消す */
const HIGHLIGHT_MS = 8_000;

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
 * **相談パネル自身は機能を持たない。** 誤字脱字の検知は結果をAI指摘パネルへ
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

    const context = await this.resolveContext();
    if (context) useLogFile(context.work.folderPath);

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
            reference: context?.reference ?? [],
            requestedFiles,
            history: this.history.slice(-HISTORY_TURNS),
            question,
          }),
          model: resolved.model,
          // 相談は考えを広げる場なので、抽出よりは揺らす
          temperature: 0.7,
          jsonSchema: WORK_CHAT_SCHEMA as unknown as object,
          disableThinking: true,
        });

      let answer = parseWorkChatAnswer((await call()).text);

      // 材料が足りないと言われたら、作品フォルダーの中から渡して聞き直す。
      // **往復は1回だけ。** 際限なく求められると料金と待ち時間が読めなくなる
      const wanted = context
        ? sanitizeRequestedPaths(answer.needFiles, MAX_REQUESTED_FILES)
        : [];
      if (wanted.length > 0) {
        const files = await this.readWorkFiles(context!.work, wanted);
        if (files.length > 0) {
          void this.view.webview.postMessage({
            type: "reading",
            files: files.map((file) => file.path),
          });
          answer = parseWorkChatAnswer((await call(files)).text);
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

      void this.view.webview.postMessage({
        type: "answer",
        reply: answer.reply,
        options: answer.options,
        edit: this.stageEdit(answer.edit, context?.work),
        run: this.stageRun(answer.run, context),
        locate: this.stageLocate(answer.locate, context),
      });
    } catch (error) {
      const message =
        error instanceof AIError
          ? `${error.message} ${recoveryForAIError(error)}`
          : error instanceof Error
            ? error.message
            : String(error);
      logFailure("相談", { 内容: message });
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
        message: "実行しました。結果は下段の「AI指摘」パネルに出ます。",
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
  private async resolveContext(): Promise<ResolvedContext | undefined> {
    const editor = this.lastEditor;
    if (!editor || editor.document.uri.scheme !== "file") return undefined;

    const filePath = editor.document.uri.fsPath;
    const work = this.findWork(filePath);
    if (!work) return undefined;

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

    const selection = editor.document.getText(editor.selection);
    const excerpt = buildExcerpt({
      text: editor.document.getText(),
      selection: selection || undefined,
      caret: editor.document.offsetAt(editor.selection.active),
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
  private async buildReference(
    work: WorkEntry,
    kind: ChatContextKind
  ): Promise<string[]> {
    if (kind === "settingsDoc" || kind === "outside") return [];
    try {
      const loaded = await new CharacterStore(work).loadAll();
      const names = loaded.characters
        .filter((character) => !character.isMob)
        .map((character) => character.name);
      if (names.length === 0) return [];
      return [`登場人物: ${names.slice(0, 40).join("、")}`];
    } catch {
      return [];
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

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
