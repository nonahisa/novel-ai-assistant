import { parsePlotMarkdown, type PlotSections } from "../core/plotDoc";
import { fromUri } from "../core/paths";
import { readPlotText } from "../core/plotFile";
import { describeProgress, nextQuestion } from "../core/plotInterview";
import * as vscode from "vscode";
import * as path from "../core/paths";
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
  runnableFeatures,
  sanitizeRequestedPaths,
  type ChatEdit,
  type ChatLocate,
  type ChatRunKind,
} from "../core/chatEdit";
import {
  buildChatNoteMarkdown,
  chatNoteFileNameCandidates,
  CHAT_NOTE_DIR,
} from "../core/chatNote";
import { atomicWriteFile } from "../core/atomicWrite";
import { openManual } from "./openManual";
import {
  describeChatReload,
  matchReloadTarget,
  parseChatReload,
  RELOAD_KIND_LABELS,
  type ChatReloadKind,
  type ReloadCandidate,
} from "../core/chatReload";
import {
  createAbilityStore,
  createLocationStore,
  createOrganizationStore,
} from "../core/abilityStore";
import type { Chatter } from "../core/chatter";
import { detectRunIntent } from "../core/chatIntent";
import { findTextRange } from "../core/textLocate";
import { applyChatEdit } from "./applyChatEdit";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import { buildFeatureGuideForQuestion } from "./featureGuide";
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
  | { type: "locate"; id: string }
  | { type: "reload"; id: string }
  /** 大きい画面のツールバー。相談する作品を選び直す */
  | { type: "chooseWork" }
  /**
   * 「できること」の札を押した。
   *
   * **AIの提案と同じ関門を通す。** 画面から届いた文字列でも、
   * 許可した一覧に無いものは起動しない（`parseChatRun`）。
   */
  | { type: "quickRun"; kind: string }
  /** 会話をMarkdownのメモとして残す */
  | { type: "saveNote" }
  /** 使い方のマニュアルを開く */
  | { type: "openManual" }
  /**
   * 横の細いパネルから、本文の領域へ大きく開く（作者の指定、2026-09-03）。
   *
   * 詳細メニューから相談の項目を消したので、**ここが大きく開く入口**になる。
   * 横のパネルはドックされたビューなので、そのまま残る。
   */
  | { type: "showInMain" }
  /**
   * 大きい画面から、横の細いパネルへ戻す。
   *
   * 「戻す」なので**大きい画面は残さない**。両方に同じ会話が並んだまま
   * 場所だけ増えると、どちらを見ればよいのか分からなくなる。
   */
  | { type: "showInSub" };

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
  /**
   * 設定資料の1件を、留意点つきでAIに読み直させる（設計書6.31.3）。
   *
   * **処理は設定資料パネルが持っているものをそのまま使う。** 相談側で
   * 組み立て直すと、片方だけ直したときに「メニューからと相談からで
   * 結果が違う」食い違いが出る（`run` と同じ考え方）。
   */
  reload(
    work: WorkEntry,
    kind: ChatReloadKind,
    recordId: string,
    notes?: string
  ): Promise<void>;
}

export class WorkChatPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /**
   * 本文の領域に開いた、大きいほうの画面（作者の要望、2026-08-28）。
   *
   * 「メニューのAI相談を大きいパネルにして」「本文領域に大きく表示できる
   * ようにすること。**現在の領域は残してください**」。そのため横の
   * パネル（`view`）と入れ替えるのではなく、**両方を同時に持てる**形にした。
   * 会話（`history`）と押されるのを待つ提案は1つだけで、2つの画面が
   * それを覗いている——別々に持つと、どちらが本当の会話なのか分からなくなる。
   */
  private panel: vscode.WebviewPanel | undefined;
  private history: WorkChatTurn[] = [];
  /**
   * 対話で埋めようとしているプロットの項目（設計書6.4.7）。
   *
   * **これが無いと、書き込み先をAIが当てずっぽうで決める。**
   * 対話を終えたら空にする（普通の相談で prompt に混ざらないように）。
   */
  private plotFocus:
    | { heading: string; target: string; purpose: string }
    | undefined;
  /** 対話の相手になっている作品。次の項目へ進むときに要る */
  private plotInterviewWork: WorkEntry | undefined;

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
  /**
   * 押されるのを待っている「AIで再読込」の提案（設計書6.31.3）。
   *
   * **持つのは照合済みのレコードのidと名前**である。AIが書いた名前を
   * 押した瞬間に引き直すと、その間に資料が変わっていたときに別の相手を開く。
   */
  private readonly pendingReloads = new Map<
    string,
    {
      work: WorkEntry;
      kind: ChatReloadKind;
      recordId: string;
      name: string;
      notes?: string;
    }
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

  /**
   * AIの切り替えを聞いて、上部のエンジン表示を更新する。
   *
   * 表示は `postContext()` が毎回 `resolve()` し直して正しく作るのに、
   * 呼ぶきっかけが「webviewの初回ready」と「エディターの切り替え」しか
   * 無かったため、AIを切り替えても古いエンジン名が出続けていた（0.22.15）。
   */
  private selectionListener: vscode.Disposable | undefined;

  dispose(): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlight.dispose();
    this.selectionListener?.dispose();
    // 大きい画面は自分で作ったものなので、自分で片づける
    this.panel?.dispose();
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
    this.selectionListener = this.ai.onDidChangeSelection(
      () => void this.postContext()
    );
  }

  /**
   * パネルが画面に出ているか。
   *
   * 独り言は、見ていないところへ書き溜めても意味がない。
   * 畳まれている（`visible === false`）ときは黙る。
   *
   * **どちらか一方でも見えていればよい。** 大きい画面だけを開いて
   * 横のパネルを畳んでいる、という使い方が普通にありうる。
   */
  isVisible(): boolean {
    return (this.view?.visible ?? false) || (this.panel?.visible ?? false);
  }

  /**
   * いま画面を持っている送り先。
   *
   * **送り先を1か所にまとめる。** 以前は `this.view` へ直接送っていたが、
   * 画面が2つになると送り忘れが必ず出る（片方の画面にだけ返事が出ない、
   * という直しにくい不具合になる）。
   */
  private hosts(): vscode.Webview[] {
    const found: vscode.Webview[] = [];
    if (this.view) found.push(this.view.webview);
    if (this.panel) found.push(this.panel.webview);
    return found;
  }

  /** 開いているすべての画面へ送る */
  private postAll(message: unknown): void {
    for (const webview of this.hosts()) void webview.postMessage(message);
  }

  /**
   * 送り元**以外**の画面へ送る。
   *
   * 押した側の画面は自分で表示を済ませている。同じものをもう一度送ると、
   * 作者の発言が二重に並ぶ。
   */
  private postOthers(source: vscode.Webview, message: unknown): void {
    for (const webview of this.hosts()) {
      if (webview === source) continue;
      void webview.postMessage(message);
    }
  }

  /**
   * 本文の領域に、大きい相談の画面を開く（作者の要望、2026-08-28）。
   *
   * すでに開いていれば、作り直さずに前へ出すだけにする。作り直すと
   * その画面に出ていた提案のボタンが消える。
   */
  openLargePanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "novelai.chatPanel",
      "AIに相談",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // 別のタブへ移って戻ったときに、会話が消えていては使い物にならない
        retainContextWhenHidden: true,
      }
    );
    this.panel = panel;
    panel.webview.html = buildWorkChatPanelHtml(
      createNonce(),
      panel.webview.cspSource,
      { large: true }
    );
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handle(message as Incoming, panel.webview);
    });
    panel.onDidDispose(() => {
      // 閉じたものへ送り続けない
      if (this.panel === panel) this.panel = undefined;
    });
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
      void this.handle(message as Incoming, webviewView.webview);
    });
  }

  /**
   * 画面から届いた指示を捌く。
   *
   * `source` は**どちらの画面から届いたか**である。片方だけへ返すもの
   * （読み込み直後の履歴）と、もう片方だけへ知らせるもの（作者の発言・
   * 会話の消去）があるので、送り元が分からないと組み立てられない。
   */
  private async handle(
    message: Incoming,
    source: vscode.Webview
  ): Promise<void> {
    if (message.type === "ready") {
      await this.postContext();
      // **後から開いた画面でも、会話が続きから見えるようにする。**
      // 送るのは読み込んだ画面だけ（既に出ている側へ送ると二重になる）。
      // 押されるのを待っている提案のボタンは作り直さない——提案は出た側の
      // 画面に残っており、同じものが2つ並ぶと、どちらを押したのか分からない
      if (this.history.length > 0) {
        void source.postMessage({
          type: "history",
          turns: this.history.map((turn) => ({
            role: turn.role,
            text: turn.text,
            // AIの返事はMarkdown。記号のまま見せない（`answer` と同じ扱い）
            html:
              turn.role === "assistant"
                ? renderMarkdownLite(turn.text)
                : undefined,
          })),
        });
      }
      return;
    }
    if (message.type === "clear") {
      this.history = [];
      // 会話をやり直すなら、料金の確認も取り直す
      this.paidConfirmedFor = undefined;
      // もう片方の画面にも、消えたことを伝える
      this.postOthers(source, { type: "cleared" });
      return;
    }
    if (message.type === "ask") {
      // 押した側は自分で表示済み。**もう片方にも積んで待ち状態にする**
      this.postOthers(source, { type: "asked", question: message.question });
      await this.ask(message.question);
      return;
    }
    if (message.type === "chooseWork") {
      await this.chooseWork();
      return;
    }
    if (message.type === "quickRun") {
      await this.quickRun(message.kind);
      return;
    }
    if (message.type === "saveNote") {
      await this.saveNote();
      return;
    }
    if (message.type === "openManual") {
      await openManual();
      return;
    }
    if (message.type === "showInMain") {
      /*
        **コマンドを通す。** `openLargePanel()` を直に呼んでも開けるが、
        コマンド側は開く前に「いま開いている本文」を覚えさせている。
        直に呼ぶと、その一手間だけが抜けた別経路が増える。
      */
      await vscode.commands.executeCommand("novelai.openChatPanel");
      return;
    }
    if (message.type === "showInSub") {
      // 先に横のパネルを出す。閉じてから開くと、行き先が無い一瞬ができる
      await vscode.commands.executeCommand("novelai.openChat");
      // 「戻す」なので大きい画面は畳む。押せるのは大きい画面だけなので、
      // 送り元がその画面であることは決まっている
      this.panel?.dispose();
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
      return;
    }
    if (message.type === "reload") {
      await this.reloadRecord(message.id);
    }
  }

  /** いま何について相談できるかを画面に出す */
  private async postContext(): Promise<void> {
    if (this.hosts().length === 0) return;
    const context = await this.resolveContext();
    // 画面に出すエンジン名は、この画面から実際に送るAI（相談の割当）にする
    const resolved = this.ai.resolve("chat");
    this.postAll({
      type: "context",
      label: context ? context.label : "作品のファイルを開いてください",
      provider: resolved
        ? `${resolved.provider.displayName}（${resolved.model}）`
        : "AI未設定",
      // 有料かどうかは、押す前に常に見えている必要がある。
      // 確認は会話ごとに一度しか出さないため、印は出し続ける
      paid: resolved?.provider.isPaid ?? false,
      // 大きい画面の「できること」に並べる。**実装の一覧をそのまま渡す**ので、
      // 機能を足しても画面側を直さなくてよい
      quickRuns: runnableFeatures(),
    });
  }

  private async ask(question: string): Promise<void> {
    if (this.hosts().length === 0) return;

    const resolved = this.ai.resolve("chat");
    if (!resolved) {
      this.postError(
        "AIが設定されていません。詳細メニューの「AIの設定」から設定してください。"
      );
      return;
    }

    /*
      **繋がるかを、費用の確認より先に確かめる**（設計書6.51）。

      止まっているAIへ相談を送っても、パネルの中に赤い文字が出るだけで
      **起こす手立てが無かった**。ここを通せば「Ollamaを起動」
      「LM Studioを起動」を出せる。繋がらないと分かっているのに
      料金の話を先に出しても意味がないので、`confirmPaidUsage` より前に置く
      （ほかの機能と同じ並び。`checkOpening.ts` を参照）。

      **相談1回につき1度だけ。** 下の `call` は材料を求められたときに
      二度目を呼ぶが、この確認はその外側にあるので二重には出ない。

      モデル名を渡すのは、LM Studioをこの場から起こしたあとの読み込みに
      要るため（`aiConnectivity.ts` の `model` 引数の説明）。
    */
    if (
      !(await confirmProviderReachable(
        resolved.provider,
        "AIへの相談",
        resolved.model
      ))
    ) {
      // **黙って戻らない。** 送ったのに何も起きない画面がいちばん困る。
      // 失敗と同じ経路（赤い文字）で伝えると、入力の待ち状態も戻る
      this.postError(
        "AIに接続できないため、相談を送りませんでした。" +
          "AIを起動してから、もう一度お試しください。"
      );
      return;
    }

    // 有料のAIは送るたびに課金される。**会話ごとに一度だけ確認を取る。**
    // 毎回モーダルを出すと相談にならず、一度も出さないと知らないうちに
    // 積み上がる。あわせて画面上部に「有料」と出し続ける（postContext）。
    //
    // **覚えるのはプロバイダとモデルの組。** モデル名だけだと、
    // Ollama と LM Studio のように同じ名前のモデルを持つ相手へ
    // 割当が変わったとき、確認を取り直さずに送ってしまう
    const paidKey = `${resolved.provider.id}:${resolved.model}`;
    if (resolved.provider.isPaid && this.paidConfirmedFor !== paidKey) {
      const ok = await confirmPaidUsage(resolved.provider, {
        actionLabel: "AIへの相談",
        model: resolved.model,
        detail:
          "送信するたびに1回ずつ課金されます。\n" +
          "会話が続くほど、これまでのやり取りも一緒に送るため入力が長くなります。\n" +
          "（この確認はこの会話で一度だけです。「最初から」を押すと再び確認します）",
      });
      if (!ok) {
        this.postAll({ type: "cancelled" });
        return;
      }
      this.paidConfirmedFor = paidKey;
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

      // **使い方の説明は、目次（全操作の名前）＋関係しそうな束だけ渡す。**
      // 全文を毎回渡していたが、機能を足すたびに伸びて6,169字になっていた。
      // 話題は追い質問（「それはどこ？」）だと直前の発言が持っているので、
      // 作者の最後の発言も選ぶ材料にする
      const lastAuthorTurn = [...this.history]
        .reverse()
        .find((turn) => turn.role === "author");
      const guide = buildFeatureGuideForQuestion({
        question,
        recentAuthorTurns: lastAuthorTurn ? [lastAuthorTurn.text] : [],
      });
      // 何を渡したかを残す。答えがおかしいときに、説明が届いていたのかを
      // 後から確かめられないと切り分けられない
      logStep(
        `相談: 使い方の説明 ${guide.reason} / ${guide.text.length}字` +
          (guide.selected.length > 0 ? ` / ${guide.selected.join("、")}` : "")
      );

      const call = (
        requestedFiles?: Array<{ path: string; content: string }>
      ) =>
        resolved.provider.generate({
          systemPrompt: WORK_CHAT_SYSTEM_PROMPT,
          /*
            **考えている中身を画面へ流す**（設計書6.63.2）。

            大きく開いた画面で長い相談をすると、答えが返るまで何も
            起きない時間が続く。思考を流せば、少なくとも「動いている」
            ことと「何を考えているか」が見える。

            **流して受け取る道でしか呼ばれない**（いまは開発ビルド限定）。
            まとめて受け取る形では、応答が全部そろってから届くので
            流す余地が無い——呼ばれなければ、画面はこれまでどおり
            「考えています…」のままである。
          */
          onThinking: (delta) => this.postAll({ type: "thought", delta }),
          // 作品の外のファイルについての相談は、どの作品にも属さないので
          // 記録しない（`workFolder` が無ければ記録されない）
          meta: { feature: "work_chat", workFolder: context?.work.folderPath },
          userPrompt: buildWorkChatPrompt({
            workTitle: context?.work.title ?? "（作品を特定できません）",
            contextKind: context?.kind ?? "outside",
            contextLabel: context?.label ?? "作品のファイル以外",
            excerpt: context?.excerpt ?? "",
            excerptTruncated: context?.truncated ?? false,
            fromSelection: context?.fromSelection ?? false,
            reference: [...(context?.reference ?? []), ...found.reference],
            requestedFiles,
            plotFocus: this.plotFocus,
            history: this.history.slice(-HISTORY_TURNS),
            question,
            featureGuide: guide.text,
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
          this.postAll({ type: "reading", files: readFiles });
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
        // 実在の照合に資料の読み込みが要るので、ここだけ待つ
        reload: await this.stageReload(answer.reloadRecord, context),
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

      this.postAll({
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
    this.postAll({ type: "error", message });
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
        this.postAll({
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

  /**
   * 「AIで再読込」の提案を受け取り、押されるまで持っておく（設計書6.31.3）。
   *
   * **実在するレコードだけをボタンにする。** AIが返した名前をそのまま
   * 操作の対象にしない（`run` と同じ原則）。照合はここ——**応答を受けた
   * 時点**——で済ませる。押されてから探すと、出したボタンが押した瞬間に
   * 「見つかりません」になり、作者には資料が消えたように見える。
   */
  private async stageReload(
    raw: unknown,
    context: ResolvedContext | undefined
  ): Promise<
    | {
        id: string;
        label: string;
        name: string;
        kindLabel: string;
        notes: string;
      }
    | undefined
  > {
    if (raw === undefined || raw === null || !context) return undefined;

    const request = parseChatReload(raw);
    if (!request) return undefined;

    const candidates = await this.loadReloadCandidates(
      context.work,
      request.kind
    );
    const target = matchReloadTarget(candidates, request.name);
    if (!target) {
      // **黙って捨てる。** 「その名前の資料はありません」と画面に出すと、
      // 作者の相談とは関係のない技術的な断りが会話に混ざる
      logStep(
        `相談: 再読込の提案を捨てた（資料に無い名前: ${request.name}）`
      );
      return undefined;
    }

    const id = `reload-${++this.editSeq}`;
    this.pendingReloads.set(id, {
      work: context.work,
      kind: request.kind,
      recordId: target.id,
      name: target.name,
      notes: request.notes,
    });
    return {
      id,
      // 出すのは**照合が通ったレコードの名前**。AIの書き方のまま出すと、
      // 実際に開く記録とボタンの文言が食い違う
      label: describeChatReload(target.name),
      name: target.name,
      kindLabel: RELOAD_KIND_LABELS[request.kind],
      notes: request.notes ?? "",
    };
  }

  /**
   * 照合の相手になる資料を読む。
   *
   * **読めなくても相談は続ける。** 資料が無い作品もあり、
   * そこで例外を投げると質問の答えごと消える。
   */
  private async loadReloadCandidates(
    work: WorkEntry,
    kind: ChatReloadKind
  ): Promise<ReloadCandidate[]> {
    try {
      if (kind === "character") {
        const loaded = await new CharacterStore(work).loadAll();
        return loaded.characters;
      }
      const store =
        kind === "ability"
          ? createAbilityStore(work)
          : kind === "organization"
            ? createOrganizationStore(work)
            : createLocationStore(work);
      const loaded = await store.loadAll();
      return loaded.records;
    } catch (error) {
      logFailure("再読込の照合に使う資料を読めなかった", {
        種別: kind,
        理由: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 作者がボタンを押したときだけ、設定資料パネルで読み直す。
   *
   * ここでは**開いて始めるところまで**で、書き込みは行わない。
   * 提案は設定資料パネルに項目ごとに並び、作者が選んだものだけが入る。
   */
  private async reloadRecord(id: string): Promise<void> {
    const staged = this.pendingReloads.get(id);
    if (!staged) {
      this.postError("この提案はもう使えません。もう一度聞いてください。");
      return;
    }
    this.pendingReloads.delete(id);

    try {
      await this.runner.reload(
        staged.work,
        staged.kind,
        staged.recordId,
        staged.notes
      );
      this.postAll({
        type: "reloadDone",
        id,
        // **「直しました」とは言わない。** 反映されるのは、資料の画面で
        // 作者が選んだ項目だけである
        message:
          `「${staged.name}」を設定資料の画面で開きました。` +
          "読み直した提案はそちらに出ます（選んだ項目だけが反映されます）。",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談からの再読込", { 内容: message });
      this.postAll({
        type: "reloadFailed",
        id,
        message: `読み直せませんでした: ${message}`,
      });
    }
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
        path.toUri(target)
      );
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        // 相談を続けられるよう、パネルからフォーカスを奪わない
        preserveFocus: true,
      });

      if (!staged.locate.text) {
        this.postAll({
          type: "locateDone",
          id,
          message: `${path.basename(target)} を開きました。`,
        });
        return;
      }

      const found = findTextRange(document.getText(), staged.locate.text);
      if (!found) {
        this.postAll({
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

      this.postAll({
        type: "locateDone",
        id,
        message: `${path.basename(target)} の ${found.line + 1}行目を開きました。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postAll({
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
      this.postAll({
        type: "runDone",
        id,
        message: "実行しました。結果は下段の「提案」パネルに出ます。",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談からの機能起動", { 内容: message });
      this.postAll({
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
      this.postAll({
        type: "editApplied",
        id,
        message: `${staged.edit.label.replace(/に書き込む$/, "")}に書き込みました（${where}）`,
      });
      // 対話でプロットを埋めている最中なら、次の項目を尋ねる
      await this.advancePlotInterview(String(staged.edit.target));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談からの書き込み", { 内容: message });
      this.postAll({
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
      if (target !== root && !target.startsWith(root + path.separatorFor(root)))
        continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(
          path.toUri(target)
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
   * 「できること」の札から、標準機能を起動する（大きい画面のツールバー）。
   *
   * **AIの提案と同じ関門を通す。** 画面から届いた文字列であっても、
   * 許可した一覧（`RUNNABLE`）に無いものは黙って捨てる。webviewは
   * 信用できる出どころではない（原理として、任意のコマンドを実行できる
   * 余地をどこにも残さない）。
   *
   * **作者が押したときだけ動く**という原則は、押した時点で満たされている。
   * AIの提案と違い、確認をもう一度挟むことはしない——札そのものに
   * 「AIを使います」と書いてあり、押す前に判断できる。
   */
  private async quickRun(raw: string): Promise<void> {
    const parsed = parseChatRun(raw);
    if (!parsed) return;

    const context = await this.resolveContext();
    if (!context) {
      this.postError(
        "作品のファイルを開くか、「相談する作品を選ぶ」で作品を決めてください。"
      );
      return;
    }

    // 「この話だけ」は本文を開いているときにしか意味がない。
    // 開いていなければ作品全体の検知に読み替える（`stageRun` と同じ規則）
    let kind = parsed.kind;
    let label = parsed.label;
    if (kind === "checkTyposForFile" && context.kind !== "manuscript") {
      kind = "checkTypos";
      label = "誤字脱字を検知する";
    }

    try {
      await this.runner.run(
        context.work,
        kind,
        kind === "checkTyposForFile" ? context.filePath : undefined
      );
      this.postAll({
        type: "note",
        message: `「${label}」を実行しました。結果は下段の「提案」パネルに出ます。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談の「できること」からの機能起動", { 内容: message });
      this.postError(`実行できませんでした: ${message}`);
    }
  }

  /**
   * 会話をMarkdownのメモとして残す（作者の要望、2026-08-28）。
   *
   * **相談の会話は、閉じると消える。** 「最初から」でも消える。
   * いい案が出た回ほど残しておきたいのに、手で写すしかなかった。
   *
   * 置き場所は設定フォルダーの中（`設定/相談メモ/`）。作品と一緒に
   * GitHubへ同期される場所である——**作者が読み返すためのもの**なので、
   * 開発用の記録（`.aiwriter/logs/chat.md`）とは扱いを分ける。
   *
   * **既存ファイルは上書きしない。** `atomicWriteFile` の新規作成だけを使い、
   * 名前がぶつかったら別名にする（`atomicWrite.ts` の置換は必ず失敗する設計で、
   * それ以前に作者のメモを消してよい理由がない）。
   */
  private async saveNote(): Promise<void> {
    if (this.history.length === 0) {
      this.postAll({ type: "note", message: "まだ会話がありません。" });
      return;
    }

    const context = await this.resolveContext();
    if (!context) {
      this.postError(
        "作品のファイルを開くか、「相談する作品を選ぶ」で作品を決めてください。"
      );
      return;
    }

    try {
      const work = context.work;
      const config = await readWorkConfig(work);
      const directory = path.join(
        workPaths(work, config).settings,
        CHAT_NOTE_DIR
      );
      await vscode.workspace.fs.createDirectory(path.toUri(directory));

      const savedAt = new Date();
      const target = await this.freshNotePath(directory, savedAt);
      const markdown = buildChatNoteMarkdown(this.history, {
        workTitle: work.title,
        savedAt,
      });
      await atomicWriteFile(
        target,
        new TextEncoder().encode(markdown),
        { mode: "create" }
      );

      this.postAll({
        type: "note",
        message: `相談メモを「${path.relative(work.folderPath, target)}」に保存しました。`,
      });
      // 保存しただけでは、何が残ったのか分からない。開いて見せる。
      // **相談を続けられるよう、フォーカスは奪わない**
      const document = await vscode.workspace.openTextDocument(
        path.toUri(target)
      );
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談メモの保存", { 内容: message });
      this.postError(`保存できませんでした: ${message}`);
    }
  }

  /**
   * まだ使われていない保存先を決める。
   *
   * 同じ分に2回保存すると名前がぶつかる。**上書きはしない**ので、
   * 秒・連番を足した別名を順に試す（名前の作り方は `chatNote.ts`）。
   */
  private async freshNotePath(
    directory: string,
    savedAt: Date
  ): Promise<string> {
    for (const name of chatNoteFileNameCandidates(savedAt)) {
      const target = path.join(directory, name);
      try {
        await vscode.workspace.fs.stat(path.toUri(target));
      } catch {
        // 読めない＝まだ無い。ここへ書く
        return target;
      }
    }
    throw new Error("相談メモの保存先の名前を決められませんでした。");
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
    if (this.hosts().length === 0) return;

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

    this.postAll({
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
    if (this.hosts().length === 0) return;

    this.postAll({
      type: "chatter",
      who: "AI",
      text:
        `「${work.title}」を始めましたね。プロットを一緒に考えましょうか。\n` +
        "思いついていることを何でも書いてください。断片でかまいません。\n" +
        "下の例を押しても始められます。",
      options: PLOT_ADVICE_OPTIONS,
    });
  }

  /**
   * 対話でプロットを作る（設計書6.4.7）。
   *
   * **AIに筋書きを作らせない。** まだ何も書いていない作品でAIに
   * 「プロットを作って」と頼むと、材料なしに話を丸ごと組み立てることになり、
   * **作者のものではない話**が出てくる（6.21.2で確かめた）。
   *
   * ここでやるのは**引き出すこと**である。まだ書かれていない項目を
   * 1つずつ尋ね、答えを整えて `plot.md` へ置く。書くのは作者が
   * ボタンを押したときだけ。
   */
  async startPlotInterview(work: WorkEntry): Promise<void> {
    await this.focusWork(work);
    if (this.hosts().length === 0) return;

    const sections = await this.readPlotSections(work);
    if (!sections) {
      this.postAll({
        type: "chatter",
        who: "AI",
        text:
          `「${work.title}」にはまだプロットがありません。\n` +
          "「プロットをつくる」を先に実行すると、書く場所ができます。",
        run: "createPlot",
      });
      return;
    }

    this.plotInterviewWork = work;
    await this.askNextPlotQuestion(sections, true);
  }

  /** まだ書かれていない項目を1つ尋ねる。全部埋まっていれば終わりを告げる */
  private async askNextPlotQuestion(
    sections: PlotSections,
    first: boolean
  ): Promise<void> {
    if (this.hosts().length === 0) return;
    const question = nextQuestion(sections);

    if (!question) {
      this.plotFocus = undefined;
      this.plotInterviewWork = undefined;
      this.postAll({
        type: "chatter",
        who: "AI",
        text:
          "プロットの項目はひととおり埋まりました。\n" +
          "書き足したいところがあれば、いつでも聞いてください。",
      });
      return;
    }

    this.plotFocus = {
      heading: question.heading,
      target: `plot.${question.key}`,
      purpose: question.purpose,
    };

    const progress = describeProgress(sections);
    this.postAll({
      type: "chatter",
      who: "AI",
      text:
        (first ? `プロットを一緒に埋めていきましょう。${progress}。\n\n` : "") +
        `【${question.heading}】\n${question.question}`,
      // **飛ばせるようにする。** 決まっていない項目で止まると、
      // 作者はそこで対話ごとやめてしまう
      options: [...question.options, "この項目は飛ばす"],
    });
  }

  /** `plot.md` を読んで節に分ける。無ければ undefined */
  private async readPlotSections(
    work: WorkEntry
  ): Promise<PlotSections | undefined> {
    try {
      return parsePlotMarkdown(await readPlotText(work)).sections;
    } catch {
      return undefined;
    }
  }

  /**
   * 対話の途中で書き込みが済んだら、次の項目へ進む。
   *
   * **読み直してから次を決める。** 作者が同じ間に別の項目を手で
   * 書いていることがあり、覚えている状態で進めると同じことを二度聞く。
   */
  private async advancePlotInterview(target: string): Promise<void> {
    const work = this.plotInterviewWork;
    if (!work || !this.plotFocus) return;
    if (this.plotFocus.target !== target) return;

    const sections = await this.readPlotSections(work);
    if (!sections) return;
    await this.askNextPlotQuestion(sections, false);
  }

  private async resolveContext(): Promise<ResolvedContext | undefined> {
    const editor = this.lastEditor;
    const filePath =
      editor && editor.document.uri.scheme === "file"
        ? fromUri(editor.document.uri)
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
      this.postAll({ type: "searched", summary: retrieval });

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
      // 検索語づくりは相談1回に付随する下ごしらえなので、相談の割当に従う。
      // **ここでは疎通を確かめない**——相談の本体（`ask`）が既に1度通して
      // おり、ここでも出すと同じ確認が二重に出る。失敗しても `[]` を返して
      // 質問文のまま検索へ進む。
      const resolved = this.ai.resolve("chat");
      if (!resolved) {
        // 静かに空を返すと、検索語が効いていないことに誰も気づけない
        logStep("相談: AIが未設定のため検索語を作らず、質問文のまま検索します");
        return [];
      }
      const names = await this.characterNames(work);
      const result = await resolved.provider.generate({
        systemPrompt: SEARCH_TERMS_SYSTEM_PROMPT,
        userPrompt: buildSearchTermsPrompt({ question, knownTerms: names }),
        model: resolved.model,
        temperature: 0.2,
        jsonSchema: SEARCH_TERMS_SCHEMA,
        disableThinking: true,
        meta: { feature: "search_terms", workFolder: work.folderPath },
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
      const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
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
      if (resolved === root || resolved.startsWith(root + path.separatorFor(root))) {
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
  reload?: { label: string; kindLabel: string; notes: string } | undefined;
}): string[] {
  const out: string[] = [];
  if (staged.edit) out.push(`書き込み: ${staged.edit.label}`);
  if (staged.run) {
    out.push(`機能の起動: ${staged.run.label}${staged.run.usesAI ? "（AIを使う）" : ""}`);
  }
  if (staged.locate) out.push(`該当箇所: ${staged.locate.label}`);
  if (staged.reload) {
    // 留意点まで残す。**何を添えて読み直したか**が分からないと、
    // 出てきた提案が妥当だったのかを後から確かめられない
    out.push(
      `再読込: ${staged.reload.kindLabel}${staged.reload.label}` +
        (staged.reload.notes ? `（留意点: ${staged.reload.notes}）` : "")
    );
  }
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
