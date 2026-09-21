import {
  parsePlotMarkdown,
  type PlotSectionKey,
  type PlotSections,
} from "../core/plotDoc";
import { fromUri } from "../core/paths";
import { readPlotText } from "../core/plotFile";
import {
  describeProgress,
  isPlotSkipReply,
  nextQuestion,
  PLOT_SKIP_OPTION,
} from "../core/plotInterview";
import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { AIRegistry } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import {
  resolveOutputLimitForSend,
  resolveOutputTokensForPlanning,
  resolveOutputTokensForSend,
  truncatedOutputAdvice,
} from "../ai/outputLimit";
import { scanWork } from "../core/scanner";
import { pathExists } from "../core/fileSystem";
import {
  episodeNumberFromHint,
  resolveEpisodeByNumber,
} from "../core/locateEpisode";
import { collectedEpisodeLineOf } from "../core/collectedFile";
import { isCollectedFile } from "../core/episodeLabel";
import { readTextFile } from "../core/textFile";
import { episodeLabel } from "../core/manuscriptSources";
import { SYNOPSIS_FILE } from "../core/synopsisDoc";
import { CharacterStore } from "../core/characterStore";
import { measureParts } from "../core/usageLog";
import {
  advicePolicyLogLines,
  applyProfileSignals,
  describeAdvicePolicyUpdate,
  describeAdviceTypeChange,
  type AdviceProfileSignals,
} from "../core/advicePolicy";
import type { AdvicePolicyStore } from "../core/advicePolicyStore";
import {
  applyWriterStyleSignals,
  describeWriterStyleChange,
  writerStyleChatLogLines,
  writerStyleUpdateLogLine,
  type WriterStyleSignals,
} from "../core/writerStyle";
import type { WriterProfileStore } from "../core/writerProfileStore";
import {
  readerTypeChatLogLines,
  readerTypeGlossaryEntries,
  type ReaderTypeGlossaryEntry,
} from "../core/readerTarget";
import { ReaderTargetStore } from "../core/readerTargetStore";
import { hasReaderProfile, type ReaderProfile } from "../models/readerProfile";
import { chatExamplesFor } from "../core/chatExamples";
import { notifyDone } from "../views/notify";
import { buildAdvicePolicyPrompt } from "../prompts/advicePolicy";
import { buildWriterStylePrompt } from "../prompts/writerStyle";
import {
  buildReaderTypeGlossaryPrompt,
  buildReaderTypePrompt,
  buildReaderTypeUnknownPrompt,
  questionMentionsReader,
} from "../prompts/readerTarget";
import {
  buildExcerpt,
  classifyChatContext,
  describeChatContext,
  type ChatContextKind,
} from "../core/chatContext";
import {
  buildWorkChatPrompt,
  buildWorkChatSystemPrompt,
  parseWorkChatAnswer,
  WORK_CHAT_SCHEMA,
  WORK_CHAT_TEMPERATURE,
  WORK_CHAT_VERSION,
  type WorkChatTurn,
} from "../prompts/workChat";
import {
  describeChatEditDestination,
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
import { applyChatEdit, readChatEditTarget } from "./applyChatEdit";
import {
  applyChatToSettings,
  type ChatSettingsSyncResult,
} from "./chatSettingsSync";
import { confirmPaidUsage, confirmProviderReachable } from "./aiConnectivity";
import {
  buildFeatureGuideForQuestion,
  procedureActionLookup,
} from "./featureGuide";
import { startTourByKey } from "../core/guidedTour";
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
  SEARCH_TERMS_TEMPERATURE,
} from "../prompts/searchTerms";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { renderMarkdownLite } from "../core/markdownLite";
import { buildWorkChatPanelHtml } from "../views/workChatPanelHtml";
import { cancelItem } from "../views/dialogs";
import { GuidedTourHost } from "./guidedTour";
import type { ActionSpotlight } from "./actionSpotlight";

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

/**
 * 相談パネルが現れるのを待つ上限（`ensureChatVisible`）。
 *
 * ビューを出すコマンドが返っても、VS Code が `resolveWebviewView` を
 * 呼ぶのはそのあとである。**待たないと「開いたのに送り先が無い」まま
 * 進む。** 3秒は、開かないと分かるまでに作者を待たせてよい上限として
 * 取った（普段は数十ミリ秒で現れるので、ここまで待つのは
 * 開けなかったときだけ）。
 */
const HOST_WAIT_MS = 3_000;

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

/*
  **材料の見出しは定数で持つ。**

  `reference` は種類の違う材料（全体像・登場人物名）が1つの配列に入って
  いる。送信量の内訳（`usage.md`）を取るときに、どれがどれかを見出しで
  見分けるので、**組み立てる側と数える側で同じ文字列を使う**。
  片方だけ直すと、内訳が黙って0字になる。
*/
const OVERVIEW_HEADING = "【作品の全体像】";
const CHARACTER_NAMES_HEADING = "登場人物: ";

type Incoming =
  | { type: "ready" }
  | { type: "ask"; question: string }
  | { type: "clear" }
  /**
   * 書いたものを取り消す（2026-09-21の裁定で、確認を外した代わりに置いた）。
   *
   * **押させるのは「書く」ではなく「戻す」のほうである。** 頼んだ作業を
   * もう一度訊かれるのは意味が無いが、戻せないのは怖い。
   */
  | { type: "undoEdit"; id: string }
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
  /**
   * 相談で決まったことを、設定資料の更新案として積む（設計書6.72）。
   *
   * **資料はここでは変わらない。** 積むのは承認待ちだけで、反映は
   * これまでどおり「更新分を反映」を作者が押したときである。
   */
  | { type: "applyToSettings" }
  /** 使い方のマニュアルを開く */
  | { type: "openManual" }
  /**
   * 上に出ているAIの名前を押した（作者の指摘、2026-09-06）。
   *
   * リンクの色で出ているのに押しても何も起きなかった。行き先はAI設定で、
   * **コマンドを呼ぶのは拡張機能側**である（画面から届いた文字列が
   * そのままコマンド名になる道は作らない。「面を移る」と同じ流儀）。
   */
  | { type: "openAISettings" }
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
  | { type: "showInSub" }
  /**
   * 画面で指しながらの案内を始める（設計書6.104）。
   *
   * **鍵しか渡さない。** 手順の中身は `core/procedures.ts` にあるものを
   * 引き直す——画面から届いた文字列がそのまま手順になる道は作らない
   * （「できること」の札と同じ関門）。
   */
  | { type: "startTour"; key: string }
  /** 案内の「代わりに押して」（作者の裁定、2026-09-21） */
  | { type: "tourRun" }
  /** 案内の「やめる」。途中でいつでも抜けられる */
  | { type: "tourStop" };

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
  /** いま尋ねている項目の鍵。「飛ばす」と言われたときに控えるのに要る */
  private plotFocusKey: PlotSectionKey | undefined;
  /**
   * 作者が「この項目は飛ばす」と答えた項目（設計書6.4.7）。
   *
   * **空のままなので、覚えておかないと同じ問いがまた出る。**
   * `plot.md` へは何も書かない——飛ばしたことを本文に残すと、
   * 作者が後から書き足すときに消す手間が増える。
   */
  private plotSkipped = new Set<PlotSectionKey>();

  /**
   * 解釈が済んだ書き込み。
   *
   * 会話の中身ではなくここに持つのは、**書く瞬間の内容で書くため**。
   * 画面の文字列から読み直すと、表示の都合で変わった内容を書きかねない。
   *
   * **押されるのを待つ場所ではなくなった**（2026-09-21の裁定）。答えを
   * 出したらすぐ書くので、ここに入るのは一瞬である。
   */
  private readonly pendingEdits = new Map<
    string,
    { edit: ChatEdit; work: WorkEntry }
  >();
  /**
   * 取り消せる書き込み（設計書6.4.7・2026-09-21）。
   *
   * **書く前の値を控えておく。** 確認を出さずに書くようになったので、
   * 控えが無いと「元が何だったか」を誰も知らないまま上書きすることになる。
   * `applied` は書いた内容——**いま入っている値がこれと違えば、作者が
   * あとから手で直している**ので取り消さない（実装ルール2）。
   */
  private readonly pendingUndos = new Map<
    string,
    { edit: ChatEdit; work: WorkEntry; before: string; applied: string }
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

  /**
   * 資料への反映が走っている最中か（設計書6.72）。
   *
   * **画面が2つある**ので、画面側でボタンを止めるだけでは足りない。
   * 二重に走ると、同じ会話から同じ更新案を二度積むことになる。
   */
  private applyingToSettings = false;

  /**
   * いま持っている会話が、どの作品についてのものか（設計書6.72）。
   *
   * **会話は「最初から」でしか消えない。** 作品を選び直しても、別の作品の
   * ファイルを開いても残る。ところが資料への反映とメモの保存は、作品を
   * `resolveContext()` から、会話を `this.history` から取っていた——
   * **作品Aの相談で決めたことが、作品Bの承認待ちや `設定/相談メモ/` へ
   * 入る**余地があった（0.32.6のレビュー）。設定資料はGitで同期されるので、
   * 混ざったものは他の端末にも広がる。
   *
   * `retrievalWorkId` と同じ流儀で、会話を積むときに一緒に覚えておく。
   * **どの作品にも属さない相談（作品の外のファイル）では上書きしない**——
   * 一度どこかの作品に結び付いた会話は、そのままにしておく。
   */
  private historyWorkId: string | undefined;

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
    private readonly runner: ChatRunner,
    /**
     * 作者のタイプ別の助言方針（設計書6.86）。
     *
     * **省略できる。** 試験や、まだ診断していない作品では
     * 何も足さず、これまでどおりの相談になる。
     */
    private readonly advicePolicies?: AdvicePolicyStore,
    /**
     * 作家タイプ診断の執筆スタイル（設計書6.90）。
     *
     * **作者ごと**なので、作品を特定できない相談にも足せる。
     * 省略できる（試験や、まだ診断していない作者では何も足さない）。
     */
    private readonly writerProfiles?: WriterProfileStore
  ) {
    this.lastEditor = vscode.window.activeTextEditor;
    this.selectionListener = this.ai.onDidChangeSelection(
      () => void this.postContext()
    );
    // 画面で指しながらの案内（設計書6.104）。**札はこのパネルの中に出す**
    // ——相談から始まる流れなので、専用のパネルを新しく作らない
    this.tour = new GuidedTourHost({
      ensureVisible: () => this.ensureChatVisible(),
      post: (message) => this.postAll(message),
    });
  }

  /**
   * 画面で指しながらの案内（設計書6.104）。
   *
   * **判断は `core/guidedTour.ts` にあり、ここは持たない。** パネルは
   * 札を出す場所を貸しているだけである。
   */
  private readonly tour: GuidedTourHost;

  /** 光らせる先（3つのツリー）を渡す。拡張機能の起動時に一度だけ呼ぶ */
  setTourSpotlight(spotlight: ActionSpotlight): void {
    this.tour.setSpotlight(spotlight);
  }

  /**
   * 答えに添える「画面で案内しましょうか」の誘い（設計書6.104）。
   *
   * **組めない手順は誘わない。** ここで一度組んでみて、段が1つも
   * 残らないなら誘いを出さない——押しても始まらない札を出すと、
   * 作者は壊れていると思う。
   *
   * すでに案内している最中も誘わない（札が二重になる）。
   */
  private tourOffer(
    key: string | undefined
  ): { tour: { key: string; title: string; steps: number } } | undefined {
    if (!key || this.tour.isActive()) return undefined;
    const state = startTourByKey(key, procedureActionLookup);
    if (!state) return undefined;
    return {
      tour: { key: state.key, title: state.title, steps: state.steps.length },
    };
  }

  /**
   * 操作が実行されたことを知らせる（`extension.ts` の `registerCommand`）。
   *
   * **自分で押しても、「代わりに押して」でも、同じここを通る。**
   * どちらを選んでも進み方が同じである、という約束はこれで守られる。
   */
  notifyCommandRun(command: string): void {
    this.tour.notifyCommand(command);
  }

  /**
   * 相談へ渡す読者像の控え（設計書6.91.9）。
   *
   * **毎回ファイルを読まない。** 読者像は作品ごとのファイル
   * （`設定/読者像.json`）にあり、相談のたびに開くとディスクを触る回数が
   * 質問の数だけ増える。中身は診断し直すまで変わらないので、**パネルが
   * 開いているあいだだけ持ち、作品が変わったら捨てる**。会話を「最初から」
   * にしたときも捨てる——診断し直した直後に、それがすぐ効くようにするため。
   *
   * **読めなかったことも覚える**（`profile` が undefined）。壊れた台帳を
   * 質問のたびに読み直しても、同じ失敗がログに並ぶだけである。
   */
  private readerProfileCache:
    | { workId: string; profile: ReaderProfile | undefined }
    | undefined;

  /**
   * 読者像を1回だけ読む。
   *
   * **読めなければ黙って諦める。** 台帳が無い・壊れている・まだ診断して
   * いない——どれも「これまでどおりの相談」になるだけで、相談は止めない
   * （助言方針が未診断のときに何も足さないのと同じ扱い）。
   * 原因は操作ログにだけ残す（作者の画面には出さない）。
   */
  /**
   * 答えの下に出す「読者タイプの区分」の一覧（設計書6.91.9.2）。
   *
   * **AIへ一覧を添えた回にだけ出す**（絞り方は buildPrompt と同じ
   * ——作品があり、読者の話をしている回）。読者の話でない回にまで
   * 11行の一覧が並ぶと、答えが押し下げられる。
   *
   * **中身はAIに書かせない。** 区分はこの拡張機能が持っている決まりで、
   * AIに並べさせると聞くたびに名前も件数も揺れる。
   */
  private async readerGlossaryFor(
    work: WorkEntry | undefined,
    question: string
  ): Promise<ReaderTypeGlossaryEntry[] | undefined> {
    if (!work || !questionMentionsReader(question)) return undefined;
    // 診断済みなら印を付けたいので、台帳を読む（同じ作品なら控えが効く）
    return readerTypeGlossaryEntries(await this.readerProfileFor(work));
  }

  private async readerProfileFor(
    work: WorkEntry
  ): Promise<ReaderProfile | undefined> {
    if (this.readerProfileCache?.workId === work.id) {
      return this.readerProfileCache.profile;
    }

    let profile: ReaderProfile | undefined;
    try {
      profile = await new ReaderTargetStore(work).load();
    } catch (error) {
      logFailure("相談: 読者像の台帳を読めませんでした", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
    this.readerProfileCache = { workId: work.id, profile };
    return profile;
  }

  /**
   * 相談へ送るシステムプロンプト。
   *
   * 診断の結果を**3つまで**足す。どれも**該当する1つだけ**を送る
   * （全部を毎回送ると数千字が積み上がり、しかも他のタイプの記述に
   * 引きずられる）。診断していなければ、素のプロンプトをそのまま返す。
   *
   * | 足すもの | 見出し | どこから |
   * |---|---|---|
   * | 助言方針（6.86） | `【この作者への助言の方針】` | `globalState`（作品ごと・既定） |
   * | 執筆スタイル（6.90） | `【この作者の書き方】` | `globalState`（作者ごと） |
   * | ターゲット読者（6.91） | `【この作品の読者】` | **作品ごとのファイル**（非同期） |
   *
   * **どれも創作の相談・操作の相談の両方へ送る**（作者の裁定、2026-09-14）。
   * 話題で出し分けないのは、作者の人柄・やり方・宛先が「どちらの話か」で
   * 変わるものではないためである。
   *
   * **使い方の節は、目次を渡す回にだけ入る**（`featureIndex`）。目次を
   * 渡さないのに「目次に無い機能は存在しません」と書いてあると嘘になる。
   */
  private async buildSystemPrompt(
    work: WorkEntry | undefined,
    featureIndex: boolean,
    /**
     * 作者のいまの質問。**読者の区分の一覧を添えるかどうか**にだけ使う
     * （設計書6.91.9）。話題で出し分けるのはここ1か所だけで、
     * 人柄・やり方・宛先は話題に関わらず送る
     */
    question: string
  ): Promise<string> {
    const base = buildWorkChatSystemPrompt({ featureIndex });
    const blocks: string[] = [];
    const now = new Date();

    // **何を足したかを必ず記録する**——方針が効いているかを作者が確かめる
    // 唯一の手掛かりで、答えの調子が変わった理由がここにしか無い。
    // 文言はどれも core 側が持つ（features の中に書くと試験から見られない）

    if (work && this.advicePolicies) {
      // **作品に無ければ、作者の既定を使う**（0.51.1。設計書6.90.2）。
      // 使用開始時の診断で答えた9問は、まだ作品が無いところで答えるので
      // 作者ごとに置いてある。ここで拾わないと、はじめの1作で効かない
      const profile = this.advicePolicies.getEffective(work.id);
      if (profile) {
        for (const line of advicePolicyLogLines(profile, now)) logStep(line);
        blocks.push(buildAdvicePolicyPrompt(profile, now));
      }
    }

    // 執筆スタイル（設計書6.90）。**作者ごとに持つので、作品が
    // 特定できない相談にも足せる。** 渡すのは段取り（S1）と直す時期（S2）
    // だけで、資料の置き場（S3）・出し先（S4）は渡さない
    const writerProfile = this.writerProfiles?.get();
    if (writerProfile) {
      for (const line of writerStyleChatLogLines(writerProfile.style)) {
        logStep(line);
      }
      blocks.push(buildWriterStylePrompt(writerProfile));
    }

    /*
      ターゲット読者（設計書6.91.9）。**作品ごとのファイルにあるので非同期。**

      **決めていない作品でも、決めていないことだけは渡す**（作者の実機報告、
      2026-09-21）。以前は診断していなければ何も足さなかったので、
      相談で「読者型はわかりませんか？」と聞くと、AIはこの拡張機能の区分を
      知らないまま年齢・性別の一般論で答えていた。

      **区分の一覧は、読者の話をしている回にだけ添える**（作者の裁定、
      2026-09-21）。決めていてもいなくても絞り方は同じ——読者の話でない回に
      まで一覧が乗ると、助言の向きが11の区分のあいだで揺れる。
    */
    if (work) {
      const readerProfile = await this.readerProfileFor(work);
      const readerBlock = buildReaderTypePrompt(readerProfile);
      if (readerBlock) {
        for (const line of readerTypeChatLogLines(readerProfile)) logStep(line);
        blocks.push(readerBlock);
      } else {
        logStep("相談: 読者タイプは未診断（決めていないことだけを渡した）");
        blocks.push(buildReaderTypeUnknownPrompt());
      }
      // 読者の話をしている回だけ、隣の区分と比べられるように一覧を添える
      if (questionMentionsReader(question)) {
        logStep("相談: 読者タイプの区分一覧を添えた（読者の話のため）");
        blocks.push(buildReaderTypeGlossaryPrompt());
      }
    }

    return blocks.length === 0 ? base : `${base}\n\n${blocks.join("\n\n")}`;
  }

  /**
   * 相談の答えから読み取った変化を、助言方針へ反映する（設計書6.86）。
   *
   * **送る直前に読んだ値ではなく、保存庫から読み直してから足す。**
   * 相談は横のパネルと大きい画面の2つがあり、待っている間に
   * もう一方が更新していることがある。
   *
   * 動かすのは点数だけで、タイプはコード側の判定に任せる。
   */
  private async updateAdvicePolicy(
    work: WorkEntry | undefined,
    signals: AdviceProfileSignals | undefined
  ): Promise<void> {
    if (!work || !signals || !this.advicePolicies) return;

    // **既定から始まった作品でも、推定は効かせる。** ここで書き写され、
    // 以後その作品が自分の値として持つ（作者の既定は動かない）
    const before = this.advicePolicies.getEffective(work.id);
    if (!before) return; // どこにも方針が無ければ推定も持たない

    const now = new Date();
    const after = applyProfileSignals(before, signals, now);
    if (after === before) return;

    await this.advicePolicies.set(work.id, after);

    // **何がどう動いたかを残す。** 受容度・自信度は出さない
    // （作者に見せないと決めたものを、ログから漏らさない）
    const updated = describeAdvicePolicyUpdate(before, after);
    if (updated) logStep(updated);

    // **タイプが変わったら、その場で作者に見せる。** 黙って変えると、
    // 助言の調子が変わった理由が作者に分からない
    const message = describeAdviceTypeChange(before, after);
    if (message) {
      notifyDone(message);
      this.postAll({ type: "note", message });
    }
  }

  /**
   * 相談の答えから読み取った「直す時期」を、執筆スタイルへ反映する
   * （設計書6.90.1）。
   *
   * **助言方針（6.86）の推定とは重みが違う。** あちらは作者が直接
   * 答えていない推定値を0.5ずつ動かすが、こちらは**作者が5問で選んだ値**
   * である。だから歯止めを2つ置く——**2回続けて同じに読めたときだけ動かし**
   * （数えは `applyWriterStyleSignals` が持つ）、**変わったら必ず見せる**。
   *
   * **作品は要らない。** 執筆スタイルは作者ごとなので、作品を特定できない
   * 相談からでも反映できる（渡すときと同じ扱い）。
   */
  private async updateWriterStyle(
    signals: WriterStyleSignals | undefined
  ): Promise<void> {
    if (!signals?.revise || !this.writerProfiles) return;

    // **送る直前に読んだ値ではなく、保存庫から読み直す**（助言方針と同じ）。
    // 答えを待っているあいだに、作者が診断し直していることがある
    const before = this.writerProfiles.get();
    if (!before) return; // 診断していない人の値は、推定で作らない

    const after = applyWriterStyleSignals(before, signals);
    if (after === before) return;

    await this.writerProfiles.update(after);

    // **まだ動いていない回（1回目）も記録する。** 記録が無いと、
    // 2回目で変わったときに作者には突然変わったように見える
    const line = writerStyleUpdateLogLine(before, after);
    if (line) logStep(line);

    const message = describeWriterStyleChange(before, after);
    if (message) {
      notifyDone(message);
      this.postAll({ type: "note", message });
    }
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

  /**
   * 画面が現れるのを待っている人たち（`ensureChatVisible`）。
   *
   * **画面ができた側から起こす。** ビューを出すコマンドが返った時点では
   * まだ `resolveWebviewView` が呼ばれていないことがあり、繰り返し
   * 覗きに行く（ポーリング）と、間隔の取り方次第で取りこぼす。
   */
  private hostWaiters: Array<() => void> = [];

  /** 画面ができたことを、待っている人へ知らせる */
  private notifyHostReady(): void {
    const waiting = this.hostWaiters;
    this.hostWaiters = [];
    for (const wake of waiting) wake();
  }

  /**
   * 送り先の画面を用意する（2026-09-21の実機確認で見つけた不具合）。
   *
   * **黙って戻らない。** 相談パネルを開かずに「対話でプロットを作る」を
   * 押すと、送り先（`hosts()`）が無いまま処理だけが進み、画面にも通知にも
   * 何も出なかった。作者からは壊れているようにしか見えない。
   *
   * 送り先はあるのに**畳まれている**ときも開き直す。見えていないのは、
   * 作者にとって「何も起きない」と同じである。
   *
   * @returns 送り先を用意できたか
   */
  private async ensureChatVisible(): Promise<boolean> {
    if (this.hosts().length > 0 && this.isVisible()) return true;

    /*
      **コマンドを通す**（`showInSub` と同じ理由）。コマンド側は開く前に
      「いま開いている本文」を覚えさせており、ビューの `focus` を直に
      呼ぶとその一手間だけが抜けた別経路が増える。
    */
    await vscode.commands.executeCommand("novelai.openChat");
    if (this.hosts().length > 0) return true;

    return await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = (): void => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      this.hostWaiters.push(wake);
      timer = setTimeout(() => {
        // 待ち人を片付けてから返す。残すと、次に画面が開いたときに
        // もう誰も見ていない約束を起こすことになる
        this.hostWaiters = this.hostWaiters.filter((each) => each !== wake);
        resolve(this.hosts().length > 0);
      }, HOST_WAIT_MS);
    });
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
    // 大きい画面でも送り先はできる。待っている操作を起こす
    this.notifyHostReady();
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
    // 画面ができるのを待っている操作（`ensureChatVisible`）を起こす
    this.notifyHostReady();
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
      // 会話が消えたら、どの作品のものかも忘れる（次の相談は白紙から）
      this.historyWorkId = undefined;
      // 会話をやり直すなら、料金の確認も取り直す
      this.paidConfirmedFor = undefined;
      // 読者像の控えも捨てる。**診断し直した直後に、それが効く道を残す**
      // （開いたままのパネルで一度読んだきりだと、古い読者像で助言し続ける）
      this.readerProfileCache = undefined;
      // **案内も畳む**（設計書6.104）。会話を消すと案内の札も画面から
      // 消えるので、続けたままにすると「押しても進まない案内」が
      // 見えないところに残る
      this.tour.stop();
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
    if (message.type === "startTour") {
      await this.tour.start(message.key);
      return;
    }
    if (message.type === "tourRun") {
      await this.tour.runCurrent();
      return;
    }
    if (message.type === "tourStop") {
      this.tour.stop();
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
    if (message.type === "applyToSettings") {
      await this.applyToSettings();
      return;
    }
    if (message.type === "openManual") {
      await openManual();
      return;
    }
    if (message.type === "openAISettings") {
      // 「AI設定」（`novelai.setupAI`）。**入口を増やすだけで、
      // 中身は既にあるものをそのまま呼ぶ**——設定の道を2つ持たない
      await vscode.commands.executeCommand("novelai.setupAI");
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
    if (message.type === "undoEdit") {
      await this.undoEdit(message.id);
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
    /*
      聞き方の例（作者の要望、2026-09-22）。**読者像が決まっていれば
      「読者型を決めたい」は出さない**——済んだ仕事を勧めない。
      作品が決まっていない（ファイルも作品も開いていない）ときは、
      決まっていない扱いでよい。札が1つ増えるだけで、押さなければ何も起きない。
    */
    const profile = context
      ? await this.readerProfileFor(context.work)
      : undefined;
    const examples = chatExamplesFor({
      readerTargetDiagnosed: profile !== undefined && hasReaderProfile(profile),
    });
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
      // 入力欄の上に並べる聞き方の例。**両方の面に出す**
      examples,
    });
  }

  private async ask(question: string): Promise<void> {
    if (this.hosts().length === 0) return;

    // **飛ばすだけならAIは要らない**（0.75.3）。書き込みも起きないので、
    // 繋がるかの確認より前に抜ける——止まっているAIのせいで
    // 「飛ばす」すら押せない、という形にしない
    if (await this.skipPlotQuestion(question)) return;

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
        remember: { id: "ai.paid.workChat" },
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
      // 話題（創作か操作か）も残す。目次を落とした回に「そんな機能はない」と
      // 答えていたら、まずここを見て判定の外れを疑う
      // 手順書き（`core/procedures.ts`）を渡したかも残す。順路を教えたのに
      // 見当違いの答えが返ったとき、まずどの手順書きが当たったかを見る
      logStep(
        `相談: 使い方の説明 ${guide.topic}/${guide.reason} / ${guide.text.length}字` +
          (guide.selected.length > 0 ? ` / ${guide.selected.join("、")}` : "") +
          (guide.procedure ? ` / 手順書き: ${guide.procedure}` : "")
      );

      // **診断の結果を、該当するぶんだけ足す**（設計書6.86・6.90・6.91）。
      // 助言方針・執筆スタイル・ターゲット読者の3つで、どれも該当する
      // 文章1つだけを送る。診断していなければ何も足さない（これまでどおりの
      // 相談になる）。足したことを必ず記録する——**方針が効いているかを
      // 作者が確かめる唯一の手掛かり**で、答えの調子が変わった理由が
      // ここにしか無い
      // 目次を渡さない回（創作の相談）は、使い方の節も外す。
      // **切り替えは1つの条件で**——2つに割れると、片方だけ直る日が来る
      const withFeatureIndex = guide.topic !== "craft";
      // 読者像だけは作品ごとのファイルにあるので待つ（開いているあいだは
      // 控えを使い回すので、読むのは作品ごとに1回きり）
      const systemPrompt = await this.buildSystemPrompt(
        context?.work,
        withFeatureIndex,
        question
      );

      // **上限と、その出どころを一度に取る。** 切り詰められたときの案内は
      // 出どころで変わる（実測が効いているのに「設定を大きくして」と言うのは
      // 嘘になる）。判定は `ai/outputLimit.ts` の1か所だけが持つ
      const outputLimit = resolveOutputLimitForSend(
        resolved.provider.id,
        resolved.model,
        "work_chat"
      );

      /*
        **送った量の内訳を残す**（設計書6.27の測り方に合わせる）。

        相談だけ内訳が無く、`usage.md` には「1回23,812字」としか
        残らなかった（2026-09-11）。何が重いのか——抜粋か、全体像か、
        使い方の説明か——が分からないと、**どれを削るかを決められない。**
        誤字脱字検知（`checkTypos.ts`）と同じ形で、渡した部品の長さを測る。

        `reference` は全体像と人物名が1つの配列に入っているので、
        見出しで分ける（上の定数）。
      */
      const referenceChars = (heading: string): number =>
        (context?.reference ?? [])
          .filter((block) => block.startsWith(heading))
          .reduce((sum, block) => sum + block.length, 0);
      // 診断の3つ（助言方針・執筆スタイル・読者タイプ）はシステムプロンプト
      // 側に足している。どれも診断していなければ素のプロンプトなので0になる
      // 引く相手は、この回に組んだ素のプロンプト。使い方の節を外した回に
      // 全部入りの長さを引くと、方針のぶんが打ち消されて0に見える
      const policyChars = Math.max(
        0,
        systemPrompt.length -
          buildWorkChatSystemPrompt({ featureIndex: withFeatureIndex }).length
      );

      const call = (
        requestedFiles?: Array<{ path: string; content: string }>
      ) => {
        const userPrompt = buildWorkChatPrompt({
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
        });

        return resolved.provider.generate({
          systemPrompt,
          /*
            **相談でも思考モードを切る**（作者の裁定、2026-09-13）。

            CLAUDE.md の実装ルール6は「`think: false` で思考モードを
            無効化する」と定めており、**この製品のAI呼び出しは、相談を
            除いて全部それに従っていた。**

            残していた理由は「考えている中身を画面へ流す」ため
            （設計書6.63.2）だったが、**流して受け取る道は開発ビルド限定**
            である。配布版はまとめて受け取るので、思考は走っているのに
            画面には届かない——**時間と出力の枠だけを食っていた。**

            出力の枠は考えごとと答えで分け合う。実測（qwen3:8b、2026-09-13）
            では、思考を切ると答えが9トークンで済むところ、切らないと
            考えごとだけで202トークンを使った。切れば、その枠が全部
            答えに回る。

            **`disableThinking: true` は、もともと下に置いてある。**
            効いていなかったのは流す道だけで、`thinkOptionFor`
            （`ai/ollamaProvider.ts`）が「流す相手がいるなら切らない」を
            優先していたためである。流す相手（`onThinking`）を外したので、
            どちらの道でも切れる。
          */
          // 作品の外のファイルについての相談は、どの作品にも属さないので
          // 記録しない（`workFolder` が無ければ記録されない）
          meta: {
            feature: "work_chat",
            workFolder: context?.work.folderPath,
            parts: {
              ...measureParts(userPrompt, {
                抜粋: context?.excerpt.length ?? 0,
                全体像: referenceChars(OVERVIEW_HEADING),
                近い場面: found.reference.reduce(
                  (sum, block) => sum + block.length,
                  0
                ),
                履歴: this.history
                  .slice(-HISTORY_TURNS)
                  .reduce((sum, turn) => sum + turn.text.length, 0),
                目次と説明: guide.text.length,
                人物名: referenceChars(CHARACTER_NAMES_HEADING),
              }),
              // **方針だけは userPrompt の外**（システムプロンプト側）。
              // 引き算で出す「指示」を狂わせないよう、測ったあとに足す
              ...(policyChars > 0 ? { 方針: policyChars } : {}),
            },
          },
          userPrompt,
          model: resolved.model,
          temperature: WORK_CHAT_TEMPERATURE,
          // **上限と見込みは別物**（設計書6.77の第2段）。上限は実測が
          // あればそこまで、無ければ設定値。見込みはOllamaの `num_ctx` の
          // 確保に使う値で、上限として送ってはいけない
          maxOutputTokens: outputLimit.tokens,
          plannedOutputTokens: resolveOutputTokensForPlanning(
            resolved.provider.id,
            resolved.model,
            "work_chat"
          ),
          jsonSchema: WORK_CHAT_SCHEMA as unknown as object,
          disableThinking: true,
        });
      };

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
        // **切り詰めは、切り詰めとして伝える**（設計書6.77の第2段。
        // あらすじ生成と同じ文言）。「返事が空でした」だけだと、作者からは
        // 出力上限が足りないのかAIの気まぐれなのか区別が付かない
        this.postError(
          result.truncated
            ? truncatedOutputAdvice(outputLimit)
            : "返事が空でした。もう一度お試しください。"
        );
        return;
      }

      this.history.push(
        { role: "author", text: question },
        { role: "assistant", text: answer.reply }
      );
      // **積むのと同じ場所で、どの作品の会話かを覚える。** 別のところで
      // 更新すると、会話と記録がずれる余地が生まれる（設計書6.72）
      if (context) this.historyWorkId = context.work.id;

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

      /*
        **書き込みだけは、答えと一緒に押させない**（作者の裁定、2026-09-21
        「頼んでいるのだから、書き込みはした上で次へ行くべきでは？
        もう一度書き込むかどうか聞くのは意味がわからない」）。

        `edit` が付いて返るのは**作業を頼まれたとき**だけである
        （`prompts/workChat.ts` が「頼まれていない作業を勧めない」と
        歯止めを掛けている）。答えの下に畳んで置くと、開いて押して、
        さらに確認へ答えて、とようやく書かれる。
      */
      /*
        **AIへ添えた回は、作者にも同じ一覧を見せる**（作者の実機報告、
        2026-09-22「相談で読者タイプの一覧が添えられていません」）。
        添えていたのはプロンプトの中なので、記録を開かないと分からなかった。
      */
      const readerGlossary = await this.readerGlossaryFor(
        context?.work,
        question
      );

      const { edit, ...others } = staged;
      this.postAll({
        type: "answer",
        // **案内は誘うだけ。勝手には始めない**（設計書6.104）。
        // 始めるとサイドバーが動いて選択が移るので、聞いただけの回に
        // それをやると、作者の手元を横取りすることになる
        ...(this.tourOffer(guide.procedureKey) ?? {}),
        reply: answer.reply,
        // AIはMarkdownで返してくる。記号のまま見せない
        html: renderMarkdownLite(answer.reply),
        options: answer.options,
        ...(readerGlossary ? { readerGlossary } : {}),
        ...others,
      });
      // 答えを見せてから書く。書き込みで手間取っても、返事は先に読める
      if (edit) await this.applyStagedEdit(edit.id);

      // **答えを見せたあとに反映する。** 保存の失敗で相談の答えが
      // 消えないよう、順番を先にしない（推定は次回に持ち越せる）
      await this.updateAdvicePolicy(context?.work, answer.profileSignals);
      await this.updateWriterStyle(answer.writerStyleSignals);
    } catch (error) {
      const message =
        error instanceof AIError
          ? `${error.message} ${recoveryForAIError(error)}`
          : error instanceof Error
            ? error.message
            : String(error);
      // **手掛かりは記録にだけ足す**（通知は今までどおり短いまま）
      logFailure("相談", { 内容: message, 詳細: failureDetail(error) });
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
      logFailure("相談からの再読込", {
        内容: message,
        詳細: failureDetail(error),
      });
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

    /*
      **開く前に、そのファイルが本当にあるかを確かめる**（作者の指摘、
      2026-09-07）。AIは `episode.4.txt` を指したが、作品にあるのは
      `episode_0004.md` だった。そのまま開こうとしたため、画面には
      URLエンコードされた生のエラーが出ている。**引用文は照合するのに、
      ファイルの実在は見ていなかった。**
    */
    const resolved = await this.resolveLocateTarget(staged);
    if (!resolved) {
      const named = staged.locate.path ?? "";
      logFailure("相談の「そこを見せて」：指されたファイルが無い", {
        指定: named,
        作品: staged.work.title,
      });
      this.postAll({
        type: "locateFailed",
        id,
        // **生のエラー文は出さない。** 作者が読むのは「無い」という事実だけで、
        // `cannot open file:///c%3A/…` は原因の手掛かりにもならない
        message:
          `AI が指したファイル（${named || "指定なし"}）は、この作品にありません。`,
      });
      return;
    }
    const target = resolved.filePath;

    try {
      const document = await vscode.workspace.openTextDocument(
        path.toUri(target)
      );
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        // 相談を続けられるよう、パネルからフォーカスを奪わない
        preserveFocus: true,
      });

      /*
        **合本は、開いただけでは着いたことにならない。** 219話が1ファイルに
        入っているので、先頭が映ったままでは作者は目的の話を探すことになる
        （設計書6.25.5）。引き当てた話の本文の先頭へ寄せてから、引用文の
        照合へ進む（引用が見つかればそちらが優先される）。
      */
      if (resolved.line !== undefined) {
        const at = new vscode.Range(
          resolved.line - 1,
          0,
          resolved.line - 1,
          0
        );
        editor.selection = new vscode.Selection(at.start, at.start);
        editor.revealRange(at, vscode.TextEditorRevealType.InCenter);
      }

      if (!staged.locate.text) {
        this.postAll({
          type: "locateDone",
          id,
          message:
            resolved.line !== undefined
              ? `${path.basename(target)} の ${resolved.line}行目を開きました。`
              : `${path.basename(target)} を開きました。`,
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
      // **生のエラー文は画面に出さない**（作者の指摘、2026-09-07）。
      // 実機に出たのは `cannot open file:///c%3A/Users/…` というURLエンコード
      // された一文で、作者には読めず、次に何をすればよいかも分からない。
      // 中身はログへ残す（開発側はそこで追える）
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談の「そこを見せて」：開けなかった", {
        場所: target,
        内容: message,
      });
      this.postAll({
        type: "locateFailed",
        id,
        message:
          `${path.basename(target)} を開けませんでした。` +
          "ファイルが移動・改名されているかもしれません。",
      });
    }
  }

  /**
   * 「そこを見せて」で開くファイルを決める。無ければ `undefined`。
   *
   * 1. 指されたパスが実在すれば、それを開く
   * 2. 無ければ**話数から引き当てる**（`episode.4.txt` → 第4話 →
   *    `episode_0004.md`）。AIはファイル名を覚えていないが、話数はたいてい
   *    合っている
   * 3. 引き当てられなければ開かない。**近そうなファイルで代用しない**——
   *    別の話を開いて「ここです」と言うのは、開けないより悪い
   *
   * 引き当てたのが合本（1ファイルに全話）なら、**その話の先頭行**まで
   * 返す。ファイルを開くだけでは、219話の先頭が映るだけになる。
   */
  private async resolveLocateTarget(staged: {
    locate: ChatLocate;
    work: WorkEntry;
    fallbackPath: string;
  }): Promise<{ filePath: string; line?: number } | undefined> {
    // パスの指定が無ければ、いま開いているファイルの中の話である
    if (!staged.locate.path) return { filePath: staged.fallbackPath };

    const requested = path.resolve(staged.work.folderPath, staged.locate.path);
    try {
      if (await pathExists(requested)) return { filePath: requested };
    } catch (error) {
      // 実在を確かめられないだけなら、引き当てへ進む（開けるかは次で分かる）
      logFailure("相談の「そこを見せて」：実在を確かめられなかった", {
        指定: staged.locate.path,
        理由: error instanceof Error ? error.message : String(error),
      });
    }

    const chapter = episodeNumberFromHint(staged.locate.path);
    if (chapter === undefined) return undefined;

    try {
      const { episodes } = await scanWork(staged.work);
      const found = resolveEpisodeByNumber(episodes, chapter);
      if (!found) return undefined;
      const line = await this.collectedLineOf(found, chapter);
      // **引き当てたことは残す。** 画面には出さない（作者にとっては
      // 「そこが開いた」だけでよい）が、外したときに追えないと直せない
      logStep(
        `相談: 指されたファイル「${staged.locate.path}」は無いので、` +
          `第${chapter}話（${found.fileName}${line !== undefined ? ` の${line}行目` : ""}）を開きました`
      );
      return { filePath: found.filePath, line };
    } catch (error) {
      logFailure("相談の「そこを見せて」：作品を走査できなかった", {
        理由: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 引き当てたのが合本なら、その話の本文の先頭行（1始まり）。
   *
   * 合本でなければ、読めなければ、話数が中で見つからなければ undefined。
   * **開けること自体は妨げない**——行が分からないだけで、ファイルは開く。
   */
  private async collectedLineOf(
    episode: EpisodeFile,
    chapter: number
  ): Promise<number | undefined> {
    if (!isCollectedFile(episode.collectedCount)) return undefined;
    try {
      const { text } = await readTextFile(episode.filePath);
      return collectedEpisodeLineOf(text, chapter);
    } catch (error) {
      logFailure("相談の「そこを見せて」：合本を読めなかった", {
        場所: episode.fileName,
        理由: error instanceof Error ? error.message : String(error),
      });
      return undefined;
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
      logFailure("相談からの機能起動", {
        内容: message,
        詳細: failureDetail(error),
      });
      this.postAll({
        type: "runFailed",
        id,
        message: `実行できませんでした: ${message}`,
      });
    }
  }

  /**
   * 頼まれた書き込みを、その場で行う（作者の裁定、2026-09-21）。
   *
   * **確認を出さない。** 以前は「何がどこへ入るか」をモーダルで見せてから
   * 書いていた（2026-09-07の指摘への対応）が、実機で通したところ
   * **作者が「これで書いてください」と頼んだあとに、畳まれたボタンを開いて
   * 押し、さらに確認へ答える**という形になっていた。作者の言葉は
   * 「頼んでいるのだから、書き込みはした上で次へ行くべきでは？」。
   *
   * **外したのは作者へ訊く確認だけである。** 書き込み自体の安全
   * （本文は対象外・退避してから新規作成・上限字数）は `parseChatEdit` と
   * `applyChatEdit` がこれまでどおり守る。
   *
   * 代わりに**取り消せる道をその場へ出す**。書く前の値を控え、画面には
   * 「取り消す」を添える（`undoEdit`）。
   */
  private async applyStagedEdit(id: string): Promise<void> {
    const staged = this.pendingEdits.get(id);
    if (!staged) {
      this.postError("この書き込みはもう使えません。もう一度聞いてください。");
      return;
    }
    this.pendingEdits.delete(id);

    const where = describeChatEditDestination(staged.edit.target);
    try {
      // **書く前に控える。** 書いたあとでは元の値がもう読めない
      const before = await readChatEditTarget(staged.work, staged.edit.target);
      const written = await applyChatEdit(staged.work, staged.edit);
      this.pendingUndos.set(id, {
        edit: staged.edit,
        work: staged.work,
        before,
        applied: staged.edit.content,
      });
      this.postAll({
        type: "editDone",
        id,
        label: staged.edit.label,
        // 何が入ったのかを、その場で読める形で出す。訊かずに書くぶん、
        // **入った中身は必ず見せる**
        preview: staged.edit.content,
        message: `${written} の「${where.item}」を書き換えました。`,
      });
      // 対話でプロットを埋めている最中なら、次の項目を尋ねる
      // **target はオブジェクト。** `String()` すると "[object Object]" になり
      // `plotFocus.target`（"plot.theme"）と永久に一致せず、対話でプロットを
      // 埋めている最中に書き込んでも次の項目を尋ねなかった（0.40.5 で修正）
      if (staged.edit.target.kind === "plot") {
        await this.advancePlotInterview(`plot.${staged.edit.target.section}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談からの書き込み", {
        内容: message,
        詳細: failureDetail(error),
      });
      // 押されたボタンが無いので、会話の場へ赤い文字で出す
      this.postError(
        `${where.file} の「${where.item}」を書き込めませんでした: ${message}`
      );
    }
  }

  /**
   * 書いたものを元へ戻す（設計書6.4.7）。
   *
   * **作者が手で直したあとは戻さない。** いま入っている値がこちらの書いた
   * ものと違えば、取り消しは作者の書いたものを消すことになる
   * （実装ルール2「作者が書いたデータを上書きしない」）。
   *
   * 戻し方は書き込みと同じ経路（`applyChatEdit`）を通す。**別の書き込みの
   * 道を作らない**——退避や上限の扱いが2通りになると、片方だけ直る日が来る。
   */
  private async undoEdit(id: string): Promise<void> {
    const undo = this.pendingUndos.get(id);
    if (!undo) {
      this.postError("この書き込みはもう取り消せません。");
      return;
    }

    const where = describeChatEditDestination(undo.edit.target);
    try {
      const current = await readChatEditTarget(undo.work, undo.edit.target);
      if (current !== undo.applied) {
        this.postAll({
          type: "undoFailed",
          id,
          message:
            `${where.file} の「${where.item}」は、書いたあとに変わっています。` +
            "取り消すと、そちらの変更が消えてしまうので止めました。",
        });
        return;
      }

      const written = await applyChatEdit(
        undo.work,
        { ...undo.edit, content: undo.before },
        // **空でも書く。** 書く前が未記入だったなら、未記入へ戻すのが
        // 「取り消し」である（設計書6.4.7。普通の書き込みでは空を弾く）
        { allowEmpty: true }
      );

      /*
        **戻ったことを確かめてから言う**（実機、2026-09-21）。
        `updatePlotMarkdown` が空の更新を捨てていたため、**中身は元のまま
        なのに「書く前（未記入）へ戻しました」と出た**。書き込みが通った
        ことと、狙った値になったことは別である。
      */
      const after = await readChatEditTarget(undo.work, undo.edit.target);
      if (after !== undo.before) {
        logFailure("相談からの書き込みの取り消し", {
          内容: "書き戻したが、値が元へ戻っていない",
          場所: `${where.file} / ${where.item}`,
        });
        this.postAll({
          type: "undoFailed",
          id,
          message:
            `${where.file} の「${where.item}」を元へ戻せませんでした。` +
            "ファイルを開いて確かめてください。",
        });
        return;
      }

      this.pendingUndos.delete(id);
      this.postAll({
        type: "undoDone",
        id,
        message:
          undo.before === ""
            ? `${written} の「${where.item}」を、書く前（未記入）へ戻しました。`
            : `${written} の「${where.item}」を書く前へ戻しました。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談からの書き込みの取り消し", {
        内容: message,
        詳細: failureDetail(error),
      });
      this.postAll({
        type: "undoFailed",
        id,
        message: `取り消せませんでした: ${message}`,
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
   * **いま相談の対象にしている作品のID**（設計書6.104／6.68.2）。
   *
   * 相談から案内の札（ターゲット読者診断など）へ入ったとき、
   * **いま画面に出ている作品をもう一度選ばせない**ために使う
   * （作者の指摘。`resolveWork` の当てどころの1つ）。
   *
   * 順は `resolveContext` と同じ——**開いているファイルの作品が先**で、
   * 無ければ選んである作品。画面の上部に出ている作品名と食い違わせない。
   * どちらも無ければ `undefined`（当てどころが無いので、作者に訊く）。
   *
   * **軽い問い合わせにする。** `resolveContext` は走査までするので、
   * 「どの作品か」を知りたいだけの呼び出しからは通せない。
   */
  currentWorkId(): string | undefined {
    const editor = this.lastEditor;
    const filePath =
      editor && editor.document.uri.scheme === "file"
        ? fromUri(editor.document.uri)
        : undefined;
    const opened = filePath ? this.findWork(filePath) : undefined;
    return opened?.id ?? this.selectedWorkId;
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
      logFailure("相談の「できること」からの機能起動", {
        内容: message,
        詳細: failureDetail(error),
      });
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
    // **別の作品の `設定/` へメモを書かない。** 同期されるので、
    // 混ざったものは他の端末にも広がる
    if (!this.isHistoryAbout(context.work, "保存")) return;

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
   * 相談で決まったことを、設定資料の更新案として積む（設計書6.72）。
   *
   * **ここでは資料を書き換えない。** 積むのは承認待ちで、台帳へ入るのは
   * 作者が「更新分を反映」で承認したときである（抽出・プロット反映と
   * まったく同じ道）。
   *
   * 中身は `features/chatSettingsSync.ts` が持つ。パネル側の仕事は
   * **どの作品の、どの会話について押されたか**を渡すことだけである。
   */
  private async applyToSettings(): Promise<void> {
    // 押している最中にもう一度押されたら、走らせない。画面側でもボタンを
    // 止めているが、**2つの画面から同時に押せる**ので、こちらでも見る。
    //
    // **黙って戻らない。** もう片方の画面はボタンを押せない状態にして
    // 返事を待っているので、何も返さないとそのまま固まる（0.32.6のレビュー）
    if (this.applyingToSettings) {
      this.postAll({
        type: "note",
        message: "資料への反映を実行中です。終わるまでお待ちください。",
      });
      this.postAll({ type: "applyToSettingsDone" });
      return;
    }

    if (this.history.length === 0) {
      this.postAll({ type: "note", message: "まだ会話がありません。" });
      this.postAll({ type: "applyToSettingsDone" });
      return;
    }

    const context = await this.resolveContext();
    if (!context) {
      this.postError(
        "作品のファイルを開くか、「相談する作品を選ぶ」で作品を決めてください。"
      );
      this.postAll({ type: "applyToSettingsDone" });
      return;
    }
    // **別の作品の承認待ちへ積まない**（設計書6.72）
    if (!this.isHistoryAbout(context.work, "反映")) {
      this.postAll({ type: "applyToSettingsDone" });
      return;
    }

    this.applyingToSettings = true;
    try {
      const result = await applyChatToSettings(context.work, this.history, {
        ai: this.ai,
      });
      // 通知は反映の側が出す。ここには**会話の場に残る一行**を置く
      // （通知は消えるので、何をしたのかが会話から追えなくなる）
      this.postAll({ type: "note", message: describeChatSync(result) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談から資料への反映", {
        内容: message,
        詳細: failureDetail(error),
      });
      this.postError(`資料へ反映できませんでした: ${message}`);
    } finally {
      this.applyingToSettings = false;
      this.postAll({ type: "applyToSettingsDone" });
    }
  }

  /**
   * いま持っている会話が、この作品についてのものか（設計書6.72）。
   *
   * **違うなら、書き出す前に止める。** 資料への反映も相談メモの保存も、
   * 作品を「いま開いているもの」から、会話を「覚えているもの」から取る。
   * 会話は作品を切り替えても残るので、**押した瞬間の作品へ、別の作品の
   * 相談が流れ込む**（0.32.6のレビュー）。設定資料もメモもGitで同期される
   * ため、混ざったものは他の端末にも広がる。
   *
   * **黙って止めない。** どの作品の会話なのかを名指しで伝えないと、
   * 作者は何を直せばよいのか分からない（「最初から」を押すか、その作品を
   * 開き直すか、のどちらかである）。
   *
   * どの作品にも結び付いていない会話（作品の外のファイルについての相談）は
   * 通す。混ざる相手が無く、止めても作者にできることが無い。
   */
  private isHistoryAbout(work: WorkEntry, action: string): boolean {
    if (!this.historyWorkId || this.historyWorkId === work.id) return true;

    const owner = this.registry
      .list()
      .find((entry) => entry.id === this.historyWorkId);
    this.postAll({
      type: "note",
      message:
        `この会話は「${owner?.title ?? "別の作品"}」についてのものです。` +
        `その作品を開いてから${action}してください` +
        `（この作品の相談として始めるなら「最初から」を押してください）。`,
    });
    return false;
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
    /*
      **送り先を先に用意する**（`startPlotInterview` と同じ穴。2026-09-21）。
      呼び出し側（`extension.ts`）は相談ビューを前へ出してから呼ぶが、
      **その時点で `resolveWebviewView` が済んでいる保証はない。**
      間に合わなければ、作品を作ったのに最初の一言が出ない。
    */
    if (!(await this.ensureChatVisible())) {
      void vscode.window.showInformationMessage(
        "相談パネルを開けませんでした。左の「AIに相談」を開くと、" +
          "プロットの相談を始められます。"
      );
      return;
    }
    await this.focusWork(work);

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
    /*
      **先に送り先を用意する**（2026-09-21の実機確認）。`focusWork()` は
      どの作品の話かを覚えて画面へ知らせるだけで、パネルは開かない。
      開いていないまま進むと以降の投稿がすべてどこにも届かず、
      「押しても何も起きない」になっていた。
    */
    if (!(await this.ensureChatVisible())) {
      void vscode.window.showInformationMessage(
        "相談パネルを開けませんでした。左の「AIに相談」を開いてから、" +
          "もう一度「対話でプロットを作る」を押してください。"
      );
      return;
    }
    await this.focusWork(work);

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
    // **始め直したら、飛ばした項目も聞き直す。** 前回飛ばしたのは
    // 「そのとき決まっていなかった」からで、今日も決まっていないとは限らない
    this.plotSkipped.clear();
    await this.askNextPlotQuestion(sections, true);
  }

  /**
   * 「この項目は飛ばす」と答えられたときに、次の項目へ進む（0.75.3）。
   *
   * **0.75.2 までは、この言葉を受け取る処理が無かった。** 問いの選択肢に
   * 足してはいたが、次へ進む道は `advancePlotInterview` だけで、そちらは
   * **AIの提案を実際に書き込めたときにしか呼ばれない。** 押しても普通の
   * 相談としてAIへ送られ、面談はその項目で止まったままだった。
   *
   * @returns 飛ばしとして扱ったら true（呼び出し側はAIを呼ばない）
   */
  private async skipPlotQuestion(reply: string): Promise<boolean> {
    if (!this.plotInterviewWork || !this.plotFocus || !this.plotFocusKey) {
      return false;
    }
    if (!isPlotSkipReply(reply)) return false;

    const heading = this.plotFocus.heading;
    this.plotSkipped.add(this.plotFocusKey);

    // **送っていないので、入力を待ち状態から戻す**（料金の確認で
    // 取りやめたときと同じ道。ここを送らないと入力欄が固まる）
    this.postAll({ type: "cancelled" });
    this.postAll({
      type: "chatter",
      who: "AI",
      text:
        `【${heading}】は飛ばします。空のままにしておくので、` +
        "決まったらいつでも書き足せます。",
    });

    const sections = await this.readPlotSections(this.plotInterviewWork);
    // 読めなくなっていたら、面談だけを閉じる（書き込みは一切していない）
    if (!sections) {
      this.plotFocus = undefined;
      this.plotFocusKey = undefined;
      this.plotInterviewWork = undefined;
      return true;
    }
    await this.askNextPlotQuestion(sections, false);
    return true;
  }

  /** まだ書かれていない項目を1つ尋ねる。全部埋まっていれば終わりを告げる */
  private async askNextPlotQuestion(
    sections: PlotSections,
    first: boolean
  ): Promise<void> {
    if (this.hosts().length === 0) return;
    // 飛ばした項目は空のままなので、除かないと同じ問いがまた出る
    const question = nextQuestion(sections, this.plotSkipped);

    if (!question) {
      this.plotFocus = undefined;
      this.plotFocusKey = undefined;
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
    this.plotFocusKey = question.key;

    const progress = describeProgress(sections);
    this.postAll({
      type: "chatter",
      who: "AI",
      text:
        (first ? `プロットを一緒に埋めていきましょう。${progress}。\n\n` : "") +
        `【${question.heading}】\n${question.question}`,
      // **飛ばせるようにする。** 決まっていない項目で止まると、
      // 作者はそこで対話ごとやめてしまう。受け取るのは `skipPlotQuestion`
      options: [...question.options, PLOT_SKIP_OPTION],
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

      /*
        **どの資料・どの話を見たのかを、名前で残す**（作者の指摘、
        2026-09-07）。画面に出るのは「設定資料4件・本文5件を参照」という
        件数だけで、**壊れた資料（同じ人物の3レコード）を読んで答えたことに、
        誰も気づけなかった。** 画面は変えない——会話の邪魔になるうえ、
        件数で足りることのほうが多い。追う必要が出たときのために、
        ログには名前を置く。
      */
      logStep(
        `相談: ${retrieval}（` +
          found
            .map((candidate) => `${candidate.item.source}・${candidate.item.label}`)
            .join("、") +
          "）"
      );

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
        temperature: SEARCH_TERMS_TEMPERATURE,
        // **相談の本体と同じ2欄を渡す**（設計書6.77の第2段）。ここは相談1回に
        // 付随してもう1回呼ぶ道なので、本体だけに配ると**相談1回のうち半分は
        // 設定値のまま**という、外から見えない食い違いが残る
        maxOutputTokens: resolveOutputTokensForSend(
          resolved.provider.id,
          resolved.model,
          "search_terms"
        ),
        plannedOutputTokens: resolveOutputTokensForPlanning(
          resolved.provider.id,
          resolved.model,
          "search_terms"
        ),
        jsonSchema: SEARCH_TERMS_SCHEMA,
        disableThinking: true,
        meta: { feature: "search_terms", workFolder: work.folderPath },
      });
      return parseSearchTerms(result.text);
    } catch (error) {
      logFailure("検索語の作成に失敗（質問文のまま検索）", {
        理由: error instanceof Error ? error.message : String(error),
        // ここもAIを呼ぶ。空の応答なら理由（finish_reason）が要る
        詳細: failureDetail(error),
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
          blocks.push(
            `${CHARACTER_NAMES_HEADING}${names.slice(0, 60).join("、")}`
          );
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
    return `${OVERVIEW_HEADING}\n${lines.join("\n")}`;
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
 * 記録に残す、失敗の**手掛かり**（実装ルール5「エラーの本文を捨てない」）。
 *
 * `AIError` の `detail` には `finish_reason=length` のような、通知へ出すには
 * 長いが原因にたどり着くには要るものが入っている。受け取る側が `message`
 * しか読んでおらず、実機では「AIから空の応答が返りました。」の一文しか
 * 残らなかった（2026-09-21）。
 *
 * **通知には足さない。** 作者に見せる文が長くなるほうが困る。
 * `detail` は作者に見せてよい文（`ai/types.ts`）なので、伏せ字は生成側で
 * 済んでおり、ここでは何もしない。`logFailure` は空の欄を捨てるため、
 * そのまま渡してよい。
 */
function failureDetail(error: unknown): string | undefined {
  return error instanceof AIError ? error.detail : undefined;
}

/*
  書き込みの確認モーダル（`previewForConfirm` と `CONFIRM_PREVIEW_CHARS`）は
  2026-09-21の裁定で無くなった。**入った中身は、確認ではなく結果として
  会話の場へ全文を出す**（`editDone` の `preview`）ので、切り詰めも要らない。
*/

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
 * 資料への反映の結果を、会話の場に残す一行にする（設計書6.72）。
 *
 * **通知は消えるが、会話は残る。** 何件積んだのかが会話から追えないと、
 * あとで承認待ちを開いたときに「これはどの相談から来たのか」が分からない。
 */
function describeChatSync(result: ChatSettingsSyncResult): string {
  if (result.unchanged) return "この相談は反映済みです。";
  if (result.failed) return "資料への反映は行いませんでした。";

  const total = result.staged + result.creations.length;
  if (total === 0) return "相談から反映できる決定は見つかりませんでした。";
  return (
    `相談から人物${total}件の更新案を積みました` +
    `（新規${result.creations.length}件・更新${result.staged}件）。` +
    "「更新分を反映」で確認できます。"
  );
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
