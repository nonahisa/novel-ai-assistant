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
 * **AIは何も書き換えない。** 相談の結果を原稿や設定へ反映するのは
 * 作者の操作に任せる。会話の途中でAIが勝手にファイルを触ると、
 * どこが変わったのか追えなくなる。
 */

export const WORK_CHAT_VIEW_ID = "novelai.chatView";

/** 一度に渡す抜粋の上限。長い本文（73万字のファイルがある）を丸ごと渡せない */
const EXCERPT_CHARS = 4_000;
/** 覚えておくやり取りの数。増やすほど入力が伸びて料金がかかる */
const HISTORY_TURNS = 12;

type Incoming =
  | { type: "ready" }
  | { type: "ask"; question: string }
  | { type: "clear" };

export class WorkChatPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private history: WorkChatTurn[] = [];

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
    private readonly ai: AIRegistry
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
      const response = await resolved.provider.generate({
        systemPrompt: WORK_CHAT_SYSTEM_PROMPT,
        userPrompt: buildWorkChatPrompt({
          workTitle: context?.work.title ?? "（作品を特定できません）",
          contextKind: context?.kind ?? "outside",
          contextLabel: context?.label ?? "作品のファイル以外",
          excerpt: context?.excerpt ?? "",
          excerptTruncated: context?.truncated ?? false,
          fromSelection: context?.fromSelection ?? false,
          reference: context?.reference ?? [],
          history: this.history.slice(-HISTORY_TURNS),
          question,
        }),
        model: resolved.model,
        // 相談は考えを広げる場なので、抽出よりは揺らす
        temperature: 0.7,
        jsonSchema: WORK_CHAT_SCHEMA as unknown as object,
        disableThinking: true,
      });

      const answer = parseWorkChatAnswer(response.text);
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
