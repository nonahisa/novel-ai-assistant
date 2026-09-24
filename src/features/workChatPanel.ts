import {
  emptyPlotSections,
  parsePlotMarkdown,
  type ParsedPlot,
  type PlotSectionKey,
} from "../core/plotDoc";
import { fromUri } from "../core/paths";
import { readPlotText } from "../core/plotFile";
import {
  composeSectionContents,
  describePlotDialogueEnd,
  describePlotSummary,
  describePlotTurn,
  describeWrittenPlot,
  isOptionReply,
  planSectionWrite,
  PLOT_CONTINUE_OPTION,
  PLOT_END_OPTION,
  PLOT_IDEA_SECTION,
  PLOT_MORE_OPTION,
  PLOT_RETRY_OPTION,
  PLOT_SKIP_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_SUMMARY_OPTION,
  PLOT_WRITE_OPTION,
  PLOT_WRITE_SUMMARY_OPTION,
  type PlotAskedPoint,
  type PlotDecision,
  type PlotDialogueSection,
} from "../core/plotInterview";
import {
  describeFixedDone,
  describeFixedProgress,
  describePlotFrameChoice,
  describePlotSeedAsk,
  describePlotStyleChoice,
  frameOfReply,
  nextFixedPoint,
  nextGuidedPoint,
  plotFrame,
  plotFrameOptions,
  plotSeedOptions,
  plotStyleDef,
  plotStyleOptions,
  PLOT_FRAME_TOPIC,
  styleOfReply,
  type PlotDialogueStyle,
  type PlotFixedPoint,
  type PlotFrameKey,
} from "../core/plotDialogueStyles";
import {
  describePlotDialogueFailure,
  describeRetryNote,
  validatePlotDialogueAnswer,
  validatePlotSummary,
  type PlotDialogueTurn,
  type PlotTurnRequest,
} from "../core/plotDialogueValidation";
import {
  buildPlotDialoguePrompt,
  buildPlotDialogueSystemPrompt,
  PLOT_DIALOGUE_SCHEMA,
  PLOT_DIALOGUE_TEMPERATURE,
  PLOT_DIALOGUE_VERSION,
} from "../prompts/plotDialogue";
import {
  buildPlotSummaryPrompt,
  PLOT_SUMMARY_SCHEMA,
  PLOT_SUMMARY_SYSTEM_PROMPT,
  PLOT_SUMMARY_TEMPERATURE,
  PLOT_SUMMARY_VERSION,
} from "../prompts/plotSummary";
import * as vscode from "vscode";
import { wideViewColumn } from "./editorColumn";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import { findWorkForFile, readWorkConfig, workPaths } from "../core/workRegistry";
import { AIRegistry } from "../ai/registry";
import { AIError, recoveryForAIError } from "../ai/types";
import {
  maxTimeoutSeconds,
  resolveTimeoutSeconds,
  saveModelTuning,
  timeoutSettingKey,
  tunedTimeoutSeconds,
} from "../core/modelTuning";
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
import { PostingStore } from "../core/postingStore";
import { readerReactionChatBlockFor } from "../core/readerAdviceChat";
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
  describeChatEditButton,
  describeChatEditDestination,
  describeChatEditRejection,
  parseChatEdit,
  parseChatLocate,
  parseChatRun,
  runnableFeatures,
  sanitizeRequestedPaths,
  type ChatEdit,
  type FileHint,
  type ChatLocate,
  type ChatRunKind,
} from "../core/chatEdit";
import {
  CHARACTER_NAMES_HEADING,
  CHAT_OVERVIEW_DOCUMENTS,
  MAX_REQUESTED_FILES,
  OVERVIEW_HEADING,
  formatChatOverview,
  missingFileHintsFrom,
  readRequestedFiles,
} from "../core/chatFileRequest";
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
import { describeRetrievedItems } from "../core/retrievalCorpus";
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
import { describeSpotlight, type ActionSpotlight } from "./actionSpotlight";
import { findMenuMentions, type MenuEntry } from "../core/menuMentions";
import { menuEntries } from "../views/actionList";
import { openInDefaultEditor } from "../views/openDocument";
// **受け口の確かめだけを静的に読む。** 取り込みの本体（ZIPの展開など）は
// 落とされたときに初めて読む（`handleBackup` の動的 import）
import {
  BACKUP_DROP_MAX_BYTES,
  BACKUP_FILE_EXTENSIONS,
  DROP_FILE_EXTENSIONS,
  WORD_FILE_EXTENSIONS,
  tooLargeMessage,
} from "../core/backupFileKinds";
import type { ImportAsNewWork, ShowBackupProposals } from "./backupDrop";
import { showBackupOpenDialog } from "./backupPickFolder";

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
/** 該当箇所の印を残す時間。見つけたあとは要らないので消す */
const HIGHLIGHT_MS = 8_000;

/*
  **求められたファイルの上限・候補の数・全体像の組み方・材料の見出しは
  `core/chatFileRequest.ts` が持つ**（0.85.1）。MCP の相談も同じものを通して
  聞き直すので、ここに写しを置かない。

  見出し（`OVERVIEW_HEADING`・`CHARACTER_NAMES_HEADING`）は、送信量の内訳
  （`usage.md`）を取るときにも使う——組み立てる側と数える側で同じ文字列を
  使わないと、内訳が黙って0字になる。
*/

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
  /**
   * エラーの下に出した札を押した（設計書6.27。実装ルール5「次に取れる
   * 操作を1つ示す」）。
   *
   * **届くのは鍵だけ。** 何をどう直すかは拡張機能側が覚えている
   * （`pendingErrorActions`）。画面から届いた文字列がそのまま設定名や
   * コマンド名になる道は作らない——ほかの札（`run`・`locate`）と同じ流儀。
   */
  | { type: "errorAction"; command: string }
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
  /**
   * 案内の「もう一度光らせる」（作者の報告、2026-09-22）。
   *
   * **進めない。** 同じ段をもう一度指すだけである
   */
  | { type: "tourAgain" }
  /**
   * 答えの下の「▶ 光らせる：〈ラベル〉」（作者の指示、2026-09-22。0.75.6）。
   *
   * **光らせるだけで、押さない。** コマンドIDは画面から届くが、
   * `executeCommand` へは渡さない——**メニューに実在するかを確かめてから、
   * ツリーの項目を選んで瞬かせるだけ**である（画面から届いた文字列が
   * そのままコマンドになる道は、ここにも作らない）。
   */
  | { type: "spotlight"; command: string }
  /** 案内の「やめる」。途中でいつでも抜けられる */
  | { type: "tourStop" }
  /**
   * バックアップのファイルが落とされた（作者の依頼、2026-09-23）。
   *
   * **中身はバイト列のまま届く**（`Uint8Array`。VS Code の postMessage は
   * 型付き配列を写し取らずに渡せる）。文字列や数の配列へ直すと、2MBの合本が
   * 何倍にも膨らんで画面が固まる。**形は受け取った側で確かめる**——画面から
   * 届いたものを型の宣言だけで信じない。
   */
  | { type: "backupFile"; name: string; bytes: unknown }
  /**
   * エクスプローラーからファイルが落とされた。**届くのは場所だけ**で、
   * 中身は拡張機能側が読む（画面はそのファイルを読めない）。
   */
  | { type: "backupUri"; uri: string }
  /**
   * 「バックアップを渡す」ボタン（落とせない環境のための入口）。
   * **いまは画面にボタンを置いていない**（隠し機能にした、2026-09-24）。受け口だけ
   * 残してあるので、ボタンを戻すときは画面の側へ送る処理を足せばよい
   */
  | { type: "pickBackup" }
  /**
   * 大きすぎて画面の側で止めた。**中身は送られてこない**（送る前に止めるのが
   * 柵の意味なので）。言い方は拡張機能側の1か所（`tooLargeMessage`）が持つ
   */
  | { type: "backupTooLarge"; name: string }
  /** 結果の「違いを見る」。開く先は拡張機能側が覚えている */
  | { type: "openBackupRecord" };

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

/** 「画面で案内してもらう」の誘い（`tourOffer` の戻り値の中身） */
interface ChatTourOffer {
  key: string;
  title: string;
  steps: number;
}

/**
 * 答えの下に並ぶもののうち、**後から開いた画面でも付け直すもの**。
 *
 * 押されるのを待つ提案（書き込み・起動・読み直し・「そこを見せて」）は
 * 入れない。出た側の画面に残っており、2つの画面に同じものが並ぶと
 * どちらを押したのか分からなくなる（`history` を送るところの説明）。
 */
interface ChatAnswerExtras {
  options: string[];
  tour?: ChatTourOffer;
  readerGlossary?: ReaderTypeGlossaryEntry[];
  spotlight?: MenuEntry[];
}

/** 対話式プロット作成の問答の状態（設計書6.4.7。`WorkChatPanel.plotDialogue`） */
interface PlotDialogueState {
  work: WorkEntry;
  /** 始めたとき、プロットに何か書いてあったか（「プロットから始める」札を出すか） */
  hasPlot: boolean;
  /** 選んだ型。まだ選んでいなければ undefined（`plotDialogueStyles.ts`） */
  style?: PlotDialogueStyle;
  /** 「型に当てはめる」で選んだ型の枠 */
  frame?: PlotFrameKey;
  /**
   * コードが決める型で、いま尋ねている（尋ねようとしている）1点。
   * 尋ね終えたら undefined（`fixedDone`）。AIが選ぶ型でも、コードが割り込んだ
   * 回（場面の3点・目標の文字数。`nextGuidedPoint`）だけ立つ
   */
  pending?: PlotFixedPoint;
  /** コードが決める型で、尋ねる枠・項目が尽きた */
  fixedDone?: boolean;
  /** 作者が最初に書いたこと（着想・場面・結末）。まだなら undefined、プロットから始めたときは空文字 */
  idea?: string;
  decisions: PlotDecision[];
  /** 尋ねた1点すべて。**同じ問いを二度出さない**ために渡し、照合もする */
  asked: PlotAskedPoint[];
  /** いま画面に出している問い。受け取れなかったときは undefined */
  current?: PlotDialogueTurn;
  /** この問答が `plot.md` に書いた中身（作者の記述と見分けるため） */
  written: Map<PlotSectionKey, string>;
  /** 最後に見せたまとめ（P-44）。「このまとめでプロットに書く」で書く */
  summary?: Map<PlotDialogueSection, string>;
}

/** 最後の問いが失敗したときの赤字（`postError` が送るものと同じ形） */
interface ChatFailure {
  /** 失敗した問い。AIを通さずに返した失敗（未設定など）でも持つ */
  question?: string;
  message: string;
  actions?: Array<{ label: string; command: string }>;
  tour?: ChatTourOffer;
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
   * 会話の「いまの端」——**履歴（`history`）に積まれない**が、画面には
   * 出ているもの（ノートPCの実機、2026-09-23）。
   *
   * 後から開いた画面へ送る履歴が発言の文字だけだったため、［メインに表示］
   * で移すと答えの下の選択肢が消え、考えている途中なら問いも消えていた。
   * **どれも会話の状態なので、画面ではなくここに1つだけ持つ**（`history`
   * と同じ考え方）。画面ごとに違ってよいもの（開いた・閉じた、押した札の
   * 押せなさ）は持たない。
   *
   * - `lastAnswer`：最後の答えの下に並んだもの。次の問いを送ったら捨てる
   *   （画面側も送った瞬間に古い選択肢を消している）
   * - `failure`：最後の問いが失敗した赤字と、その問い（失敗した問いは
   *   `history` に積まれない）
   * - `pending`：送ったまま、答えを待っている問い
   */
  private tail: {
    lastAnswer?: ChatAnswerExtras;
    failure?: ChatFailure;
    pending?: { question: string };
  } = {};
  /**
   * 対話式プロット作成の問答（設計書6.4.7。0.86.2 で作り直した）。
   *
   * **あいだは、相談パネルへ打った言葉はすべて問答の答えとして扱う。**
   * 「問答を終える」か「最初から」で抜ける。
   *
   * **決まったこと（`decisions`）は作者の答えそのものを、コードが持つ。**
   * AIの確かめ直しの文は画面に出すだけで、決まったことには数えない
   * （AIは候補を出す。決めるのは作者）。
   */
  private plotDialogue: PlotDialogueState | undefined;

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
  /**
   * 押されるのを待っている「エラーの直し方」の札。
   *
   * **勝手には直さない。** 押されたときだけ設定を書く（実装ルール5の
   * 「次に取れる操作を1つ示す」を、文章ではなくボタンで出す形）。
   */
  private readonly pendingErrorActions = new Map<
    string,
    {
      kind: "raiseTimeout";
      providerId: string;
      providerName: string;
      model: string;
      seconds: number;
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

  /**
   * 光らせる先。**案内（`tour`）だけのものではなくなった**（0.75.6）。
   *
   * AI の答えの中で名指しされた項目も、ここを通して光らせる
   * ——**同じ関数を通す**（`ActionSpotlight.show`）。写しを作ると、
   * 案内では瞬くのに答えからは瞬かない、という食い違いが出る。
   */
  private spotlight: ActionSpotlight | undefined;

  /** 光らせる先（3つのツリー）を渡す。拡張機能の起動時に一度だけ呼ぶ */
  setTourSpotlight(spotlight: ActionSpotlight): void {
    this.spotlight = spotlight;
    this.tour.setSpotlight(spotlight);
  }

  /**
   * 手順書きの鍵で、画面の案内を始める（ヘルプの「場面別案内」から。2026-09-23）。
   *
   * **相談の札（`startTour` の知らせ）と同じ `GuidedTourHost.start` を通す。**
   * 入口ごとに案内の組み方を持つと、片方だけ直したときに食い違う。
   * 札はこのパネルに出るので、閉じていれば開く（`ensureChatVisible`）。
   */
  async startGuidedTour(key: string): Promise<void> {
    await this.tour.start(key);
  }

  /**
   * 持ち込まれたバックアップを、新しい作品として取り込む口（2026-09-23）。
   *
   * **登録の道は `extension.ts` が持っている**ので、ここでは受け取るだけにする
   * （`setTourSpotlight` と同じ形）。渡されていないあいだは、メニューの
   * 「バックアップから取り込む」を開いて、同じファイルをもう一度選んでもらう。
   */
  private backupImporter: ImportAsNewWork | undefined;

  setBackupImporter(importer: ImportAsNewWork): void {
    this.backupImporter = importer;
  }

  /**
   * バックアップとの本文の違いを、提案パネルへ並べる口（設計書6.99.7。
   * 作者の裁定、2026-09-23）。
   *
   * **提案パネルの実体は `extension.ts` にしか無い**ので、`setBackupImporter`
   * と同じ形で渡してもらう。渡されていないあいだは、違いを記録へ書き出して
   * 「違いを見る」で開くだけ（これまでどおり）。
   */
  private backupProposals: ShowBackupProposals | undefined;

  setBackupProposals(show: ShowBackupProposals): void {
    this.backupProposals = show;
  }

  /**
   * バックアップ（や Word 原稿）から話をファイルとして足したあとに呼ぶ口
   * （作品一覧の読み直しと、執筆量の基準の置き直し）。どちらも `extension.ts`
   * にしか無いので、同じ形で渡してもらう。
   */
  private episodesAdded: ((work: WorkEntry) => Promise<void>) | undefined;

  setEpisodesAdded(after: (work: WorkEntry) => Promise<void>): void {
    this.episodesAdded = after;
  }

  /** バックアップを捌いている最中か。**2つ同時に落とされても1つずつ** */
  private receivingBackup = false;
  /** 直近の「バックアップとの違い」の記録。「違いを見る」で開く */
  private lastBackupRecord: string | undefined;

  /**
   * 答えに添える「画面で案内しましょうか」の誘い（設計書6.104）。
   *
   * **組めない手順は誘わない。** ここで一度組んでみて、段が1つも
   * 残らないなら誘いを出さない——押しても始まらない札を出すと、
   * 作者は壊れていると思う。
   *
   * すでに案内している最中も誘わない（札が二重になる）。
   */
  /**
   * 質問に当てる使い方の説明と、当たった手順書きの鍵。
   *
   * **1か所で組む**（2026-09-23）。相談を送る道と、AIに接続できずに
   * 送らなかった道の両方が手順の鍵を要る。別々に組むと、話題の判定の
   * 材料（直前の作者の発言）が片方だけ変わる日に、案内の誘いが出る・
   * 出ないが道ごとに食い違う。
   *
   * 話題は追い質問（「それはどこ？」）だと直前の発言が持っているので、
   * 作者の最後の発言も選ぶ材料にする。**AIは呼ばない**（字面の照合だけ）。
   */
  private featureGuideFor(question: string) {
    const lastAuthorTurn = [...this.history]
      .reverse()
      .find((turn) => turn.role === "author");
    return buildFeatureGuideForQuestion({
      question,
      recentAuthorTurns: lastAuthorTurn ? [lastAuthorTurn.text] : [],
    });
  }

  /** 当たった手順書きの鍵だけ（AIに接続できなかった道で使う） */
  private procedureKeyFor(question: string): string | undefined {
    return this.featureGuideFor(question).procedureKey;
  }

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
   * 答えの中で名指しされたメニュー項目を光らせる（設計書6.104。0.75.6）。
   *
   * **作者の指示（2026-09-22）**：「AIからの回答で点滅すると良い」。
   *
   * **自動で光らせるのは最初の1件だけ**で、残りは札にして作者に押させる。
   * 答えが3つの操作に触れた回に3つとも光らせることはできない
   * （光るのは画面の1か所）し、順に光らせると最後の1つしか残らない。
   *
   * **案内（`tour`）が動いている回は、自動では光らせない。** 段の案内が
   * すでに「いま押すべき1つ」を指しているので、答えのほうから別の項目を
   * 指すと、印が奪い合いになって作者はどちらを押せばよいか分からなくなる。
   *
   * @returns 答えに添える札の一覧（空なら札を出さない）
   */
  private async spotlightMentions(reply: string): Promise<MenuEntry[]> {
    const mentions = findMenuMentions(reply, menuEntries());
    if (mentions.length === 0 || !this.spotlight) return mentions;
    if (this.tour.isActive()) return mentions;

    const result = await this.spotlight.show(mentions[0].command);
    /*
      **どちらのメニューにも無かった項目は、札にもしない**
      （`describeSpotlight` が「見当たりません」と言う状態）。押しても
      光らない札を出すと、作者は壊れていると思う。**確かめられたのは
      いま光らせた1件だけ**なので、落とすのもその1件に限る。
    */
    return result.shown ? mentions : mentions.slice(1);
  }

  /**
   * 「▶ 光らせる」を押された（0.75.6）。
   *
   * **メニューに実在するコマンドだけを通す。** 画面から届いた文字列を
   * そのまま扱わない、という決まりはここでも同じである
   * （もっとも `show` は光らせるだけで、操作は起こさない）。
   */
  private async spotlightCommand(command: string): Promise<void> {
    if (!this.spotlight) return;
    if (!menuEntries().some((entry) => entry.command === command)) {
      logStep(`相談から知らない操作を光らせようとしました（${command}）`);
      return;
    }
    const result = await this.spotlight.show(command);
    if (!result.shown) {
      this.postAll({
        type: "note",
        message: describeSpotlight(result),
      });
    }
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

    if (this.advicePolicies) {
      // **作品に無ければ、作者の既定を使う**（0.51.1。設計書6.90.2）。
      // 使用開始時の診断で答えた9問は、まだ作品が無いところで答えるので
      // 作者ごとに置いてある。ここで拾わないと、はじめの1作で効かない。
      // **作品が決まらない相談でも既定を乗せる**（2026-09-23）——以前は
      // 作品があるときだけで、執筆スタイル（作者ごと）は乗るのに方針だけ抜けていた
      const profile = this.advicePolicies.getFor(work?.id);
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

      /*
        **読者の反応（PV・離脱・ブクマ・評価）の話なら、その材料を足す**
        （設計書6.79.7.3。作者の依頼「頼む場所は両方」、2026-09-23）。
        材料も約束も、執筆統計の「AIに助言をもらう」と**同じもの**を使う
        （`core/readerAdviceChat.ts` 経由。二重に持たない）。当たりの付け方は
        字面の照合だけで、AIは呼ばない。

        **台帳が読めなくても相談は止めない**（読者像と同じ扱い）。
      */
      const reaction = await readerReactionChatBlockFor(question, async () =>
        new PostingStore(work).load()
      ).catch((error: unknown) => {
        logFailure("相談: 投稿状態の台帳を読めませんでした", {
          作品: work.title,
          詳細: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      });
      if (reaction) {
        logStep(
          `相談: 読者の反応の材料を添えた（${reaction.sites.length > 0 ? reaction.sites.join("・") : "記録なし"} / ${reaction.text.length}字）`
        );
        blocks.push(reaction.text);
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
    // 相談の答えを待つ間に書き先が変わりうる。記録の直前に、この作品へ（0.81.4）
    useLogFile(work.folderPath);
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
      wideViewColumn(),
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
    // 作品の外の文書（無題・設定・出力）は受け取らない。パネルへ
    // フォーカスが移る途中で前に来ることがあり、受け取ると直前まで
    // 見ていた本文を手放してしまう
    if (this.documentPath(editor) === undefined) return;
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
      //
      // **会話の端（`tail`）も一緒に送る**（ノートPCの実機、2026-09-23）。
      // 発言の文字だけを送っていたため、移った先では答えの下の選択肢が消え、
      // 考えている途中なら問いも「考えています…」も無い初期画面になっていた。
      // **発言がまだ1つも無くても、考えている途中・失敗の直後なら送る**
      const { lastAnswer, failure, pending } = this.tail;
      if (this.history.length > 0 || failure || pending) {
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
          ...(lastAnswer ? { lastAnswer: this.withoutStaleTour(lastAnswer) } : {}),
          ...(failure ? { failure: this.withoutStaleTour(failure) } : {}),
          ...(pending ? { pending } : {}),
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
      // 会話の端も捨てる。残すと、開き直した画面に消したはずの選択肢が出る
      this.tail = {};
      // **プロットの問答も抜ける。** 画面から問いが消えたのに問答のままだと、
      // 次に打った相談が問答の答えとして記録される
      this.plotDialogue = undefined;
      // もう片方の画面にも、消えたことを伝える
      this.postOthers(source, { type: "cleared" });
      return;
    }
    if (message.type === "ask") {
      // 押した側は自分で表示済み。**もう片方にも積んで待ち状態にする**
      this.postOthers(source, { type: "asked", question: message.question });
      /*
        **答えを待っている問いを覚える**（ノートPCの実機、2026-09-23）。
        考えている途中に開いた画面へ、問いと待ち状態を出すため。
        前の答えの選択肢と前の赤字は、ここで捨てる——画面側も送った瞬間に
        消しており、移った先にだけ古いボタンが残るとどの返事への選択か
        分からなくなる。
      */
      const pending = { question: message.question };
      this.tail = { pending };
      try {
        await this.ask(message.question);
      } finally {
        // 答えが出た時点で外してある（`ask` の中）。取りやめ・失敗・
        // 「飛ばす」の道はここで外す
        if (this.tail.pending === pending) this.tail.pending = undefined;
      }
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
    if (message.type === "tourAgain") {
      await this.tour.showAgain();
      return;
    }
    if (message.type === "spotlight") {
      await this.spotlightCommand(message.command);
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
    if (message.type === "errorAction") {
      await this.runErrorAction(message.command);
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
      return;
    }
    if (message.type === "backupFile") {
      await this.receiveBackupBytes(message.name, message.bytes);
      return;
    }
    if (message.type === "backupUri") {
      await this.receiveBackupUri(message.uri);
      return;
    }
    if (message.type === "pickBackup") {
      await this.pickBackup();
      return;
    }
    if (message.type === "backupTooLarge") {
      const name = typeof message.name === "string" ? message.name : "そのファイル";
      this.postAll({ type: "note", message: tooLargeMessage(name) });
      return;
    }
    if (message.type === "openBackupRecord") {
      if (this.lastBackupRecord) await openInDefaultEditor(this.lastBackupRecord);
    }
  }

  /* ── バックアップの持ち込み（作者の依頼、2026-09-23） ───── */

  /**
   * 画面に落とされたファイルの中身を受け取る。
   *
   * **形を確かめてから使う。** 届くはずなのは `Uint8Array` だが、古い
   * VS Code や別の経路では `ArrayBuffer` のこともある。それ以外（数の配列の
   * JSONなど）は、読み違えて原稿を壊すより断るほうがよい。
   */
  private async receiveBackupBytes(name: unknown, bytes: unknown): Promise<void> {
    const fileName = typeof name === "string" ? name.trim() : "";
    const data =
      bytes instanceof Uint8Array
        ? bytes
        : bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : undefined;
    if (!fileName || !data) {
      logStep("相談パネル：落とされたファイルの中身を受け取れませんでした");
      this.postAll({
        type: "note",
        // ［バックアップを渡す］はしまった（隠し機能、2026-09-24）。いまある手だけを言う
        message: "落とされたファイルの中身を受け取れませんでした。Shiftを押しながら落とし直してください。",
      });
      return;
    }
    await this.handleBackup(fileName, data);
  }

  /**
   * エクスプローラーから落とされたファイルを読む。**場所は作者のワークスペースの
   * もの**だが、画面から届いた文字列なので、形（ファイルかどうか・拡張子）は
   * `receiveBackup` の側でも確かめる。
   */
  private async receiveBackupUri(raw: unknown): Promise<void> {
    // バックアップは、どの作品のものかがまだ決まっていない。直前に相談した
    // 作品の記録へ紛れないよう、保管庫の記録へ向けてから書く（`backupDrop.ts`）
    useLogFile(undefined);
    let uri: vscode.Uri;
    try {
      if (typeof raw !== "string" || raw.trim() === "") throw new Error("空です");
      uri = vscode.Uri.parse(raw.trim(), true);
    } catch (error) {
      logStep(
        `相談パネル：落とされた場所を読めませんでした（${
          error instanceof Error ? error.message : String(error)
        }）`
      );
      this.postAll({
        type: "note",
        message: "落とされたファイルの場所を読めませんでした。Shiftを押しながら落とし直してください。",
      });
      return;
    }
    await this.readAndHandleBackup(uri);
  }

  /** 「バックアップを渡す」。落とせない環境（ブラウザ版など）の入口 */
  private async pickBackup(): Promise<void> {
    // 前に選んだフォルダーから開く（メニューの取り込みと同じ覚え方。
    // `backupPickFolder.ts`）
    const picked = await showBackupOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "これを渡す",
      title: "相談パネルへ渡すバックアップ・Word 原稿を選ぶ（ZIP／テキスト／.docx）",
      filters: {
        "バックアップ・Word 原稿": [...DROP_FILE_EXTENSIONS],
        "バックアップ（ZIP／テキスト）": [...BACKUP_FILE_EXTENSIONS],
        "Word 原稿（.docx）": [...WORD_FILE_EXTENSIONS],
      },
    });
    if (!picked) return;
    await this.readAndHandleBackup(picked);
  }

  private async readAndHandleBackup(uri: vscode.Uri): Promise<void> {
    // 読めなかったときの記録も、関係の無い作品へ落とさない（上と同じ理由）
    useLogFile(undefined);
    const fileName = path.basename(fromUri(uri));
    let bytes: Uint8Array;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        this.postAll({
          type: "note",
          message: `「${fileName}」はフォルダーです。バックアップのファイル（ZIP／テキスト）を渡してください。`,
        });
        return;
      }
      if (stat.size > BACKUP_DROP_MAX_BYTES) {
        this.postAll({ type: "note", message: tooLargeMessage(fileName) });
        return;
      }
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      logFailure("相談パネル：渡されたバックアップを読めなかった", {
        場所: uri.toString(),
        詳細: error instanceof Error ? error.message : String(error),
      });
      this.postAll({
        type: "note",
        message: `「${fileName}」を読めませんでした。`,
      });
      return;
    }
    // 場所も渡す：Word 原稿が作品フォルダーの中にあれば、その作品の続きと見る手掛かり
    await this.handleBackup(fileName, bytes, fromUri(uri));
  }

  /**
   * 受け取ったバックアップを捌き、結果を会話の中に短く出す。
   *
   * **判断は `backupDrop.ts` が持つ**（このパネルは受け口と結果の表示だけ）。
   * 取り込みの部品（ZIPの展開など）は大きいので、落とされたときに初めて読む
   * ——相談パネルを開くたびに読み込む必要は無い。
   */
  private async handleBackup(
    fileName: string,
    bytes: Uint8Array,
    /** 場所が分かるとき（エクスプローラー・選ぶ画面から）。Word 原稿の照合に使う */
    sourcePath?: string
  ): Promise<void> {
    if (this.receivingBackup) {
      this.postAll({
        type: "note",
        message: "ひとつ前のバックアップを確かめている最中です。終わってからもう一度渡してください。",
      });
      return;
    }
    this.receivingBackup = true;
    try {
      this.postAll({
        type: "note",
        message: `「${fileName}」を受け取りました。どの作品のものか確かめています…`,
      });
      const { receiveBackup } = await import("./backupDrop.js");
      const result = await receiveBackup(
        { fileName, bytes, ...(sourcePath ? { sourcePath } : {}) },
        {
          works: this.registry.list(),
          importAsNew: this.backupImporter,
          showProposals: this.backupProposals,
          afterEpisodesAdded: this.episodesAdded,
        }
      );
      if (!result) {
        this.postAll({ type: "note", message: "バックアップの取り込みを取りやめました。" });
        return;
      }
      if (result.recordPath) this.lastBackupRecord = result.recordPath;
      this.postAll({
        type: "backupResult",
        message: result.message,
        canOpenRecord: result.recordPath !== undefined,
      });
    } catch (error) {
      logFailure("相談パネル：バックアップの取り込み", {
        ファイル: fileName,
        詳細: error instanceof Error ? error.message : String(error),
      });
      this.postAll({
        type: "note",
        message: `バックアップを取り込めませんでした：${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      this.receivingBackup = false;
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

    // **プロットの問答の最中は、問答の答えとして受け取る**（設計書6.4.7）。
    // 相談の指示（P-21）には載せない——選択肢を依頼文にさせる決まりと、
    // 問答の「候補はそのまま答えになる文」がぶつかる（0.86.1 のループの元）
    if (this.plotDialogue) {
      await this.answerPlotDialogue(question);
      return;
    }

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
      //
      // **画面の案内の誘いも添える**（2026-09-23）。手順の当たりは質問の
      // 字面の照合で決まり、AIに依らない。**AIが止まっている機械でこそ、
      // 画面で指す案内が要る**のに、ここは手順の判定より前で抜けていたので
      // 一度も出なかった（失敗の道に誘いを足した 0.75.12 の積み残し）
      this.postError(
        "AIに接続できないため、相談を送りませんでした。" +
          "AIを起動してから、もう一度お試しください。",
        undefined,
        this.tourOffer(this.procedureKeyFor(question))
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
    /*
      当たった手順書きの鍵。**失敗の道でも使うので try の外に置く**（2026-09-23）。

      手順の当たりは質問の字面の照合で決まり、AIの成否に依らない。
      **AIが遅い機械ほど画面の案内が要る**のに、誘いが成功の道にしか
      無かったため、ノートPC（CPUだけの Ollama）では一度も出なかった。
    */
    let procedureKey: string | undefined;
    /*
      **最後に送った量**（2026-09-23）。時間切れの案内に添えるため、
      try の外に置く。量が分からないまま「減らして」と言っても、作者は
      何をどれだけ減らせばよいか判断できない。履歴のぶんを別に持つのは、
      「最初から」で実際に減るのがそこだけだから（抜粋・全体像・近い場面は
      毎回組み直されて、作者の操作では減らない）。
    */
    let sent: { total: number; history: number } | undefined;

    try {
      logStep(`相談: v${WORK_CHAT_VERSION} / ${resolved.model}`);

      // **使い方の説明は、目次（全操作の名前）＋関係しそうな束だけ渡す。**
      // 全文を毎回渡していたが、機能を足すたびに伸びて6,169字になっていた。
      // 話題は追い質問（「それはどこ？」）だと直前の発言が持っているので、
      // 作者の最後の発言も選ぶ材料にする
      const guide = this.featureGuideFor(question);
      procedureKey = guide.procedureKey;
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
        requestedFiles?: Array<{ path: string; content: string }>,
        missingFiles?: {
          paths: string[];
          available: FileHint[];
          availableTotal: number;
        }
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
          missingFiles,
          history: this.history.slice(-HISTORY_TURNS),
          question,
          featureGuide: guide.text,
        });
        const historyChars = this.history
          .slice(-HISTORY_TURNS)
          .reduce((sum, turn) => sum + turn.text.length, 0);
        // 材料を求められた2回目は、1回目より長い。**切れたほうの量を出す**
        sent = {
          total: systemPrompt.length + userPrompt.length,
          history: historyChars,
        };

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
                履歴: historyChars,
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
      let missingFiles: string[] = [];

      // 材料が足りないと言われたら、作品フォルダーの中から渡して聞き直す。
      // **往復は1回だけ。** 際限なく求められると料金と待ち時間が読めなくなる
      //
      // **1つも読めなくても聞き直す**（2026-09-24、実データの測定）。
      // 以前は読めたものが無いと聞き直さず、作者の画面には1往復目の
      // 「本文を提示していただけますか」だけが残った——何が起きたのか
      // 作者には分からない。見つからなかったことと、作品にあるファイルの
      // 候補を渡して、同じ1回の枠の中で答えさせる
      const wanted = context
        ? sanitizeRequestedPaths(answer.needFiles, MAX_REQUESTED_FILES)
        : [];
      if (wanted.length > 0) {
        const { files, missing } = await this.readWorkFiles(
          context!.work,
          wanted
        );
        readFiles = files.map((file) => file.path);
        missingFiles = missing;
        this.postAll({ type: "reading", files: readFiles, missing });
        const hints =
          missing.length > 0
            ? await this.missingFileHints(context!.work, missing)
            : undefined;
        result = await call(
          files,
          hints ? { paths: missing, ...hints } : undefined
        );
        answer = parseWorkChatAnswer(result.text);
      }

      if (!answer.reply) {
        // **切り詰めは、切り詰めとして伝える**（設計書6.77の第2段。
        // あらすじ生成と同じ文言）。「返事が空でした」だけだと、作者からは
        // 出力上限が足りないのかAIの気まぐれなのか区別が付かない
        //
        // **読み取れなかったJSONも、ここへ来る**（2026-09-23）。
        // `parseWorkChatAnswer` がJSONらしい生テキストの `reply` を空に
        // するようになったため——以前はここを素通りして、作者の画面に
        // `"needFiles": [],` がそのまま並んでいた
        this.postError(
          result.truncated
            ? truncatedOutputAdvice(outputLimit)
            : answer.source === "raw"
              ? "AIの返事を読み取れませんでした（形式が崩れています）。" +
                truncatedOutputAdvice(outputLimit)
              : "返事が空でした。もう一度お試しください。",
          undefined,
          // 答えが無くても、手順の当たりは生きている（下の catch と同じ理由）
          this.tourOffer(procedureKey)
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
          missingFiles,
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

      /*
        **答えで名指しされた項目を光らせる**（設計書6.104。0.75.6。
        作者の指示、2026-09-22）。**答えを送る前に光らせる**——先に
        札を出すと、読んでいる間にサイドバーが動いて、どの行が光ったのか
        目で追えない（案内の段（`showCurrent`）と同じ理由）。
      */
      const spotlight = await this.spotlightMentions(answer.reply);

      const { edit, ...others } = staged;
      /*
        答えの下に並ぶもの。**画面へ送るのと同じものを会話の端に覚える**
        （ノートPCの実機、2026-09-23）——後から開いた画面へ付け直すため。
        別々に組み立てると、片方にだけ足したものが移った先で消える。
      */
      const extras: ChatAnswerExtras = {
        // **案内は誘うだけ。勝手には始めない**（設計書6.104）。
        // 始めるとサイドバーが動いて選択が移るので、聞いただけの回に
        // それをやると、作者の手元を横取りすることになる
        ...(this.tourOffer(guide.procedureKey) ?? {}),
        options: answer.options,
        ...(readerGlossary ? { readerGlossary } : {}),
        // **何度でも押せる札**（0.75.6）。目を離している間に選択が動く
        ...(spotlight.length > 0 ? { spotlight } : {}),
      };
      // 答えが出たので、もう待っていない（このあとの書き込みは「考えている」
      // 途中ではない。開き直した画面に「考えています…」を出さない）
      this.tail = { lastAnswer: extras };
      this.postAll({
        type: "answer",
        ...extras,
        reply: answer.reply,
        // AIはMarkdownで返してくる。記号のまま見せない
        html: renderMarkdownLite(answer.reply),
        ...others,
      });
      /*
        **救った回は、救ったと言う**（2026-09-23）。閉じ括弧を足して
        読めたということは、**返事はそこで切れている**——続きがあったのに
        出ていない。黙って出すと、作者は「AIが途中で話をやめた」と読む。

        直し方は `truncatedOutputAdvice` に任せる。**上限の出どころで
        言うべきことが変わる**（実測で頭打ちなのに「設定を大きくして」と
        言うのは嘘になる。0.66.6で踏んだ）ので、文言をここに写さない。
      */
      if (answer.source === "salvaged") {
        this.postAll({
          type: "note",
          message:
            "この返事は途中で切れています（読み取れたところまでを出しました）。" +
            truncatedOutputAdvice(outputLimit),
        });
      }
      // 答えを見せてから書く。書き込みで手間取っても、返事は先に読める
      if (edit) await this.applyStagedEdit(edit.id);

      // **答えを見せたあとに反映する。** 保存の失敗で相談の答えが
      // 消えないよう、順番を先にしない（推定は次回に持ち越せる）
      await this.updateAdvicePolicy(context?.work, answer.profileSignals);
      await this.updateWriterStyle(answer.writerStyleSignals);
    } catch (error) {
      /*
        **タイムアウトだけは、その場で直せる札を添える**（2026-09-23）。
        `recoveryForAIError` が「設定で秒数を延ばしてください」と案内して
        いるが、作者はプログラマではなく、設定画面まで辿り着けていなかった。
        押されたときだけ書く（`runErrorAction`）。

        **文言より先に決める。** 札が出るかどうかで、赤字に書くこと
        （「下の札で延ばせます」か「もう延ばせません」か）が変わる。
      */
      const timedOut = error instanceof AIError && error.kind === "timeout";
      const actions = timedOut
        ? this.timeoutAction(resolved.provider, resolved.model)
        : undefined;
      /*
        **相談の時間切れは、相談向けの案内にする**（ノートPCの実機、
        2026-09-23）。共通の案内（`recoveryForAIError`）は「秒数を延ばす」
        「1チャンクの文字数を小さく」を勧めるが、待ち時間が既に上限なら
        延ばせず、相談はチャンクに分けないので後者は何も変えない。
        **案内どおりにしても何も変わらない**のは実装ルール5に反する。
        ほかの画面の案内は変えない（そちらではチャンクが効く）。
      */
      const message =
        error instanceof AIError
          ? `${error.message} ${
              timedOut
                ? workChatTimeoutAdvice({
                    currentSeconds: resolveTimeoutSeconds(
                      resolved.provider.id,
                      resolved.model
                    ),
                    // **そのAIの上限**（手元1800秒・クラウド600秒）。
                    // 決め打ちの600秒で案内すると、手元のAIでは延ばせるのに
                    // 「もう延ばせません」と言ってしまう
                    maxSeconds: maxTimeoutSeconds(resolved.provider.id),
                    canRaise: actions !== undefined,
                    sentChars: sent?.total,
                    historyChars: sent?.history,
                  })
                : recoveryForAIError(error)
            }`
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
      /*
        **画面の案内の誘いも、失敗の赤字の下に出す**（2026-09-23。実装ルール5
        「作者が次に取れる操作を1つ示す」）。

        手順の当たりは質問の字面の照合で決まる——AIが答えられなかった
        ことと関係が無い。**AIが遅い機械ほど、画面で指してもらうほうが
        早い**のに、誘いが成功の道にしか無かった（ノートPC、0.75.9）。
        手順が当たっていない回には出ない（`tourOffer` が undefined を返す）。
      */
      this.postError(
        message,
        actions ? [actions] : undefined,
        this.tourOffer(procedureKey)
      );
    }
  }


  /**
   * 赤い文字でエラーを出す。`actions` を渡すと、その下に押せる札が並ぶ。
   *
   * **札は「次に取れる操作」を実際に押せるようにするためのもの**である
   * （実装ルール5）。作者はプログラマではないので、設定の場所を文章で
   * 説明しても辿り着けない——実際、Ollamaの待ち時間は900秒に延ばして
   * あるのに、さくらのAIは既定のままで180秒で切れ続けていた（2026-09-23）。
   */
  private postError(
    message: string,
    actions?: Array<{ label: string; command: string }>,
    /** 「画面で案内してもらう」の誘い（`tourOffer` の戻り値をそのまま渡す） */
    offer?: { tour: ChatTourOffer }
  ): void {
    const failure: ChatFailure = {
      message,
      ...(actions && actions.length > 0 ? { actions } : {}),
      ...(offer ?? {}),
    };
    /*
      **答えを待っている最中の赤字は、その問いの失敗として覚える**
      （ノートPCの実機、2026-09-23）。後から開いた画面へ、問いごと出すため
      ——失敗した問いは `history` に積まれないので、覚えておかないと
      移った先では何を聞いて失敗したのかが消える。画面側も赤字で待ちを
      解いているので、ここで待ちも外す。

      待っていないときの赤字（書き込みの取り消しに失敗した等）は覚えない。
      会話の端ではなく、その場の出来事である（`note` と同じ扱い）。
    */
    const pending = this.tail.pending;
    if (pending) {
      this.tail = { failure: { question: pending.question, ...failure } };
    }
    this.postAll({ type: "error", ...failure });
  }

  /**
   * 会話の端を送り直すとき、**もう始まっている案内の誘いは外す**。
   *
   * 誘いは出した時点で案内が動いていないときだけ付く（`tourOffer`）。
   * そのあと片方の画面で案内が始まっていれば、開き直した画面に
   * 「案内してもらう」がもう一度並ぶと、始め直すのか続きなのか分からない。
   */
  private withoutStaleTour<T extends { tour?: ChatTourOffer }>(value: T): T {
    if (!value.tour || !this.tour.isActive()) return value;
    const { tour: _stale, ...rest } = value;
    return rest as T;
  }

  /**
   * タイムアウトで失敗したときに出す「その場で直す」札。
   *
   * **いまの値の倍まで**（上限は `maxTimeoutSeconds`。手元1800秒・クラウド
   * 600秒）。すでに上限なら札を出さない——押しても何も変わらない札は、
   * 直し方を探す邪魔になる。
   */
  private timeoutAction(
    provider: { id: string; displayName: string },
    model: string
  ): { label: string; command: string } | undefined {
    const current = resolveTimeoutSeconds(provider.id, model);
    const ceiling = maxTimeoutSeconds(provider.id);
    if (!Number.isFinite(current) || current >= ceiling) {
      return undefined;
    }
    const seconds = Math.min(ceiling, Math.round(current) * 2);
    if (seconds <= current) return undefined;
    const command = `timeout-${++this.editSeq}`;
    this.pendingErrorActions.set(command, {
      kind: "raiseTimeout",
      providerId: provider.id,
      providerName: provider.displayName,
      model,
      seconds,
    });
    return { label: `タイムアウトを${seconds}秒にする`, command };
  }

  /** エラーの下の札が押された。**押されたときだけ設定を書く** */
  private async runErrorAction(command: string): Promise<void> {
    const action = this.pendingErrorActions.get(command);
    if (!action) {
      this.postError("この操作はもう使えません。もう一度お試しください。");
      return;
    }
    // 一度きり。二度押しで同じ値をもう一度書かない
    this.pendingErrorActions.delete(command);
    try {
      /*
        **書き先は、いま効いているほうへ。** 待ち時間は
        「AIチューニングの台帳 → プロバイダごとの設定」の順に読まれる
        （`resolveTimeoutSeconds`）ので、台帳に値があるときに設定だけ
        書いても**1秒も変わらない**。押したのに何も起きない札にしない。
      */
      if (tunedTimeoutSeconds(action.providerId, action.model) !== undefined) {
        const outcome = await saveModelTuning(action.providerId, action.model, {
          timeoutSeconds: action.seconds,
        });
        if (outcome !== "written") {
          this.postError(
            "待ち時間を書き込めませんでした。" +
              "詳細メニューの「AIチューニング」から設定してください。"
          );
          return;
        }
      } else {
        await vscode.workspace
          .getConfiguration("novelai")
          .update(
            timeoutSettingKey(action.providerId),
            action.seconds,
            vscode.ConfigurationTarget.Global
          );
      }
      this.postAll({
        type: "note",
        message:
          `${action.providerName}のタイムアウトを${action.seconds}秒にしました。` +
          "もう一度お尋ねください。",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("相談の待ち時間の設定", { 内容: message });
      this.postError(`待ち時間を設定できませんでした: ${message}`);
    }
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
      // 案内文だけの書き込み（0.86.2）も、書かなかったことを言う。
      // 黙ると「AIが書くと言ったのに入っていない」になる
      if (
        parsed.reason === "manuscript_not_allowed" ||
        parsed.reason === "placeholder_content"
      ) {
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
        message: "実行しました。結果は右の列の「提案」パネルに出ます。",
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
      /*
        0.86.1 まではここで対話式プロット作成の次の項目を尋ねていた。
        **次へ進む道が「書き込めたとき」だけ**だったため、AIが書き込みを
        返さないと選択肢の往復が続いた（作者の実機の報告、2026-09-24 夜）。
        いまの問答（`answerPlotDialogue`）は書かなくても次の問いへ進む
      */
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
   *
   * 拡張子違いの引き当て・重複の畳み方・長さの上限は
   * `core/chatFileRequest.ts` の `readRequestedFiles`（MCP の相談と同じもの）。
   * ここが持つのは `vscode.workspace.fs` での読み方だけ。
   */
  private async readWorkFiles(
    work: WorkEntry,
    relativePaths: string[]
  ): Promise<{
    files: Array<{ path: string; content: string }>;
    missing: string[];
  }> {
    const root = path.resolve(work.folderPath);
    return readRequestedFiles(relativePaths, {
      readText: async (relative) => {
        const target = path.resolve(root, relative);
        // 判定は `isPathInside` の1か所に寄せてある（写しを作ると網が落とす）。
        // 作品フォルダーそのものはファイルではないので、中に数えなくてよい
        if (!path.isPathInside(root, target)) return undefined;
        try {
          const bytes = await vscode.workspace.fs.readFile(path.toUri(target));
          return new TextDecoder().decode(bytes);
        } catch {
          return undefined;
        }
      },
      // フォルダーごと無い・読めないときは引き当てない（`undefined`）
      siblingNames: async (relative) => {
        const folder = path.dirname(path.resolve(root, relative));
        try {
          const entries = await vscode.workspace.fs.readDirectory(
            path.toUri(folder)
          );
          return entries
            .filter(([, type]) => (type & vscode.FileType.File) !== 0)
            .map(([name]) => name);
        } catch {
          return undefined;
        }
      },
    });
  }

  /**
   * 話の一覧（作品フォルダーからの相対パスと表示名）。
   *
   * **全体像の話の一覧と、見つからなかったときの候補は、この1つから作る。**
   * 別の数え方をすると、全体像には載っているのに候補には無い、という
   * 食い違いが起きる。
   */
  private async episodeHints(work: WorkEntry): Promise<FileHint[]> {
    const root = path.resolve(work.folderPath);
    const scan = await scanWork(work);
    return scan.episodes.map((episode) => ({
      path: path.relative(root, episode.filePath).replace(/\\/g, "/"),
      label: episodeLabel(episode),
    }));
  }

  /**
   * 求められたファイルが見つからなかったとき、AIへ示す候補を組む
   * （選び方は `core/chatFileRequest.ts` の `missingFileHintsFrom`）。
   * AIが次に作者へ「どのファイルか」を正しく伝えられるよう、相対パスを添える。
   */
  private async missingFileHints(
    work: WorkEntry,
    missing: string[]
  ): Promise<{ available: FileHint[]; availableTotal: number }> {
    try {
      return missingFileHintsFrom(missing, await this.episodeHints(work));
    } catch {
      // 走査できなくても「見つからなかった」ことだけは伝えられる
      return { available: [], availableTotal: 0 };
    }
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
    const filePath = this.documentPath(this.lastEditor);
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
        "作品のファイルを開くか、「相談作品選択」で作品を決めてください。"
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
        message: `「${label}」を実行しました。結果は右の列の「提案」パネルに出ます。`,
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
        "作品のファイルを開くか、「相談作品選択」で作品を決めてください。"
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
        "作品のファイルを開くか、「相談作品選択」で作品を決めてください。"
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
   * 対話式プロット作成を始める（設計書6.4.7。0.86.2 で作り直した）。
   *
   * **作者が着想を書き、AIが1点ずつ尋ねる問答にする。** 0.86.1 までは
   * 決まった9項目を順に尋ねる用紙で、どの作品でも同じ選択肢を出していた。
   * 選んでも書ける中身が無く、次へ進むのは「AIが書き込みを返したとき」だけ
   * だったので、選択肢の往復が延々と続いた（作者の実機の報告、2026-09-24 夜
   * 「本題が始まらない」「あまりにかけ離れている」）。
   *
   * ここでは最初の一言（型を選ぶ札）を出すだけで、AIは呼ばない。作品を選んだ
   * 直後のいちばん待たされたくないところで待たせない（`startPlotAdvice` と同じ理由）。
   * 型は5つ（`plotDialogueStyles.ts`。2026-09-25 に作者が選んだ）。
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
          "もう一度「対話式プロット作成」を押してください。"
      );
      return;
    }
    await this.focusWork(work);

    // **プロットが無くても始められる。** 書くときに作られる（`applyChatEdit`）
    const plot = await this.readPlot(work);
    const hasPlot = plot
      ? describeWrittenPlot(plot.sections, plot.extra).length > 0
      : false;

    // **始め直したら、前の問答は持ち越さない。** 尋ねたことの一覧も捨てる——
    // 前回飛ばしたのは「そのとき決まっていなかった」からで、今日も同じとは限らない
    this.plotDialogue = {
      work,
      hasPlot,
      decisions: [],
      asked: [],
      written: new Map(),
    };
    /*
      **最初に型を選ぶ**（作者の指示、2026-09-25「これはプロット作成の
      パターンの一つ。これだけに固定しないで」）。説明は1行ずつ
    */
    this.postAll({
      type: "chatter",
      who: "AI",
      text: describePlotStyleChoice(work.title),
      options: plotStyleOptions(),
    });
  }

  /**
   * 問答の最中に届いた言葉を受け取る（設計書6.4.7）。
   *
   * **決まったことの記録は、作者の答えそのもの。** 候補を押しても、自分で
   * 書いても、組み合わせても、送った文がそのまま「決まったこと」になる。
   * **書かなくても次の問いへ進む**——書くのは「ここまでをプロットに書く」を
   * 押したときだけ（0.86.1 のループの元は「書かないと進まない」だった）。
   *
   * 始めた直後は**型を選ぶ段**、「型に当てはめる」なら**枠を選ぶ段**を通る。
   * ここまではコードが答え、AIは呼ばない。
   */
  private async answerPlotDialogue(text: string): Promise<void> {
    const dialogue = this.plotDialogue;
    if (!dialogue) return;
    const reply = text.trim();
    const current = dialogue.current;

    if (isOptionReply(reply, PLOT_END_OPTION)) {
      this.plotDialogue = undefined;
      // 送っていないので、入力を待ち状態から戻す（料金の確認で取りやめたときと同じ道）
      this.postAll({ type: "cancelled" });
      this.postAll({
        type: "chatter",
        who: "AI",
        text: describePlotDialogueEnd(dialogue.decisions),
      });
      return;
    }

    if (!dialogue.style) {
      const chosen = styleOfReply(reply);
      if (chosen) {
        dialogue.style = chosen.key;
        this.postAll({ type: "cancelled" });
        this.postAll(
          chosen.key === "structure"
            ? {
                type: "chatter",
                who: "AI",
                text: describePlotFrameChoice(),
                options: plotFrameOptions(),
              }
            : {
                type: "chatter",
                who: "AI",
                text: describePlotSeedAsk(chosen.key, dialogue.hasPlot),
                options: plotSeedOptions(chosen.key, dialogue.hasPlot),
              }
        );
        return;
      }
      /*
        **型を選ばずに書き始めたら、「着想から掘る」として受け取る**（その文を
        着想にする）。選び直させると、書いた着想を打ち直させることになる
      */
      dialogue.style = "idea";
    }

    if (dialogue.style === "structure" && !dialogue.frame) {
      const frame = frameOfReply(reply);
      this.postAll({ type: "cancelled" });
      if (!frame) {
        this.postAll({
          type: "chatter",
          who: "AI",
          text: describePlotFrameChoice(true),
          options: plotFrameOptions(),
        });
        return;
      }
      dialogue.frame = frame.key;
      // 選んだ型も作者の答え。plot.md の「あらすじ」に「型：起承転結」と残る
      dialogue.decisions.push({
        topic: PLOT_FRAME_TOPIC,
        answer: frame.label,
        section: PLOT_IDEA_SECTION,
      });
      this.postAll({
        type: "chatter",
        who: "AI",
        text: describePlotSeedAsk("structure", dialogue.hasPlot, frame),
        options: plotSeedOptions("structure", dialogue.hasPlot),
      });
      return;
    }

    if (isOptionReply(reply, PLOT_WRITE_OPTION)) {
      this.postAll({ type: "cancelled" });
      await this.writePlotSections(
        dialogue,
        composeSectionContents(dialogue.decisions),
        "問答で決めたこと"
      );
      this.offerPlotContinue(dialogue);
      return;
    }

    if (isOptionReply(reply, PLOT_WRITE_SUMMARY_OPTION) && dialogue.summary) {
      this.postAll({ type: "cancelled" });
      await this.writePlotSections(dialogue, dialogue.summary, "問答のまとめ");
      this.offerPlotContinue(dialogue);
      return;
    }

    if (isOptionReply(reply, PLOT_CONTINUE_OPTION)) {
      this.postAll({ type: "cancelled" });
      this.offerPlotContinue(dialogue);
      return;
    }

    if (isOptionReply(reply, PLOT_SUMMARY_OPTION) && dialogue.decisions.length > 0) {
      await this.requestPlotSummary(dialogue, reply);
      return;
    }

    // **同じ問いのまま、ほかの案を出してもらう**（何も記録しない）
    if (isOptionReply(reply, PLOT_MORE_OPTION) && current) {
      await this.requestPlotTurn(dialogue, reply, undefined, {
        more: {
          topic: current.topic,
          question: current.question,
          section: current.section,
          shown: current.candidates.map((candidate) => candidate.text),
        },
      });
      return;
    }

    const def = plotStyleDef(dialogue.style);
    /*
      コードが決めた（割り込んだ）1点。AIが選ぶ型では、場面の3点・目標の文字数を
      尋ねようとした回だけ立つ（`requestPlotTurn` が毎回付け直す）
    */
    const pending = dialogue.pending;
    let lastAnswer: { topic: string; answer: string } | undefined;
    let clarifyFor: { topic: string; section: PlotDialogueSection } | undefined;
    if (isOptionReply(reply, PLOT_SKIP_OPTION) && current) {
      // 飛ばした問いも「尋ねたこと」に残す。**残さないと、すぐまた尋ねられる**
      // （確かめ直しの問いは、もとの問いがもう一覧にある）
      if (current.mode === "ask") {
        dialogue.asked.push({
          topic: current.topic,
          question: current.question,
          skipped: true,
        });
      }
      dialogue.current = undefined;
    } else if (isOptionReply(reply, PLOT_SKIP_OPTION) && pending) {
      /*
        **問いを出せなかった枠・項目も飛ばせる。** 飛ばせないと、同じ枠を
        頼み直すか問答を終えるしかない（コードが順を決める型だけの道）
      */
      dialogue.asked.push({ topic: pending.topic, question: pending.note, skipped: true });
    } else if (
      isOptionReply(reply, PLOT_RETRY_OPTION) ||
      isOptionReply(reply, PLOT_SKIP_OPTION) ||
      isOptionReply(reply, PLOT_MORE_OPTION)
    ) {
      // 問いを受け取れていないときの頼み直し。何も記録しない
    } else if (dialogue.idea === undefined) {
      // 最初の返事は着想（型によっては場面・結末）。プロットから始めるなら、着想は plot.md にある
      if (isOptionReply(reply, PLOT_START_FROM_PLOT_OPTION)) {
        dialogue.idea = "";
      } else {
        dialogue.idea = reply;
        dialogue.decisions.push({
          topic: def.seedTopic,
          answer: reply,
          section: PLOT_IDEA_SECTION,
        });
      }
    } else if (current) {
      dialogue.decisions.push({
        topic: current.topic,
        answer: reply,
        section: current.section,
      });
      if (current.mode === "ask") {
        dialogue.asked.push({
          topic: current.topic,
          question: current.question,
          skipped: false,
        });
        /*
          **答えが途中で切れている・どちらにも読めるときは、AIに確かめ直させて
          よい**（作者とリーダーの問答、2026-09-25。「元アイデアを」で切れた答えを
          推測で進めず、解釈の候補を出して確かめた）。**確かめ直しへの答えには
          もう許さない**——確かめ直しが続くと、それ自体が往復のループになる
        */
        clarifyFor = { topic: current.topic, section: current.section };
      }
      dialogue.current = undefined;
      lastAnswer = { topic: current.topic, answer: reply };
    } else if (pending) {
      /*
        問いを出せなかった枠・項目へ、作者が自分で書いた。**その枠の答えとして
        受け取る**——何の枠かは画面に出してあり（`requestPlotTurn`）、補足に
        回すと同じ枠をもう一度尋ねることになる
      */
      dialogue.decisions.push({ topic: pending.topic, answer: reply, section: pending.section });
      dialogue.asked.push({ topic: pending.topic, question: pending.note, skipped: false });
      lastAnswer = { topic: pending.topic, answer: reply };
    } else {
      /*
        問いを受け取れていないあいだに書かれた言葉は、補足として残す。
        **名前を毎回変える**——同じ名前で積むと、書くときに言い直しと
        みなされて前の補足が消える（`composeSectionContents`）
      */
      const extra = dialogue.decisions.filter((item) =>
        item.topic.startsWith("補足")
      ).length;
      const topic = extra === 0 ? "補足" : `補足（${extra + 1}）`;
      dialogue.decisions.push({ topic, answer: reply, section: "outline" });
      lastAnswer = { topic, answer: reply };
    }

    await this.requestPlotTurn(dialogue, reply, lastAnswer, { clarifyFor });
  }

  /**
   * 次の1点・ほかの案・確かめ直しをAIに出してもらう（P-43）。
   *
   * **コードが次の1点を決める型**（型に当てはめる・項目を順に埋める）では、
   * 先に `nextFixedPoint` で尋ねる枠・項目を決め、尽きていればAIを呼ばずに
   * 締めの一言を出す。
   *
   * **受け取れなければ1度だけ頼み直す**（`askPlotAI`）。2度目も駄目なら、
   * 同じ問いを出さずに止めて、作者が次に押せる札を並べる。
   */
  private async requestPlotTurn(
    dialogue: PlotDialogueState,
    authorText: string,
    lastAnswer: { topic: string; answer: string } | undefined,
    options: {
      more?: PlotTurnRequest["more"];
      clarifyFor?: PlotTurnRequest["clarifyFor"];
    }
  ): Promise<void> {
    const style = dialogue.style ?? "idea";
    const def = plotStyleDef(style);
    const frame = plotFrame(dialogue.frame);
    const plot = await this.readPlot(dialogue.work);
    const writtenPlot = plot ? describeWrittenPlot(plot.sections, plot.extra) : "";

    let fixedPoint: PlotFixedPoint | undefined;
    if (def.fixed && !options.more) {
      fixedPoint = nextFixedPoint(
        style,
        frame,
        dialogue.asked,
        plot?.sections ?? emptyPlotSections(),
        dialogue.written
      );
      dialogue.pending = fixedPoint;
      if (!fixedPoint) {
        // 尋ねる枠・項目が尽きた。**AIは呼ばない**（尋ねることが無い）
        dialogue.fixedDone = true;
        dialogue.current = undefined;
        this.postPlotAnswer(dialogue, describeFixedDone(style, frame), authorText);
        return;
      }
    } else if (!options.more) {
      /*
        **AIが1点を選ぶ型でも、型の狙い（場面の3点）と目標の文字数はコードが
        割り込んで決める**（2026-09-25 夜の実接続。頼むだけでは守られなかった）。
        渡し方・検算・問いを出せなかったときの扱いは、コードが決める型と同じ
      */
      fixedPoint = nextGuidedPoint(style, dialogue.asked, dialogue.decisions, writtenPlot);
      dialogue.pending = fixedPoint;
    }

    const request: PlotTurnRequest = {
      asked: dialogue.asked,
      more: options.more,
      clarifyFor: options.clarifyFor,
      fixed: fixedPoint
        ? { topic: fixedPoint.topic, section: fixedPoint.section, note: fixedPoint.note }
        : undefined,
    };

    const result = await this.askPlotAI(dialogue, authorText, {
      label: `対話式プロット作成（${def.label}）`,
      version: `P-43 ${PLOT_DIALOGUE_VERSION}`,
      feature: "plot_dialogue",
      systemPrompt: buildPlotDialogueSystemPrompt(style),
      schema: PLOT_DIALOGUE_SCHEMA as unknown as object,
      temperature: PLOT_DIALOGUE_TEMPERATURE,
      build: (retryNote) =>
        buildPlotDialoguePrompt({
          workTitle: dialogue.work.title,
          style,
          frame,
          fixedPoint,
          idea: dialogue.idea,
          writtenPlot,
          decisions: dialogue.decisions,
          asked: dialogue.asked,
          lastAnswer,
          more: options.more,
          mayClarify: options.clarifyFor !== undefined,
          retryNote,
        }),
      check: (text) => {
        const check = validatePlotDialogueAnswer(text, request);
        return check.ok
          ? { ok: true, value: check.turn }
          : {
              ok: false,
              reason: check.reason,
              detail: check.detail,
              retryNote: describeRetryNote(check.reason, check.detail, fixedPoint?.topic),
              failure: describePlotDialogueFailure(check.reason),
            };
      },
    });
    if (!result) return;

    if (!result.ok) {
      // ほかの案が出せなかっただけなら、いまの問いは生きている
      if (!options.more) dialogue.current = undefined;
      this.postPlotAnswer(
        dialogue,
        fixedPoint
          ? `${result.failure}\n【${fixedPoint.topic}】について思いついたことを書けば、その答えにします。下の札も押せます。`
          : `${result.failure}\n思いついたことを書き足すか、下の札を押してください。`,
        authorText
      );
      return;
    }

    const turn = result.value;
    if (turn.mode === "clarify") {
      /*
        **確かめ直しなら、直前の答えはまだ決まったことにしない。** 作者が
        どちらの意味かを選んだら、その答えで記録し直す（尋ねたことの一覧には
        もとの問いが残っているので、同じ問いは出ない）
      */
      const last = dialogue.decisions[dialogue.decisions.length - 1];
      if (last && last.topic === turn.topic) dialogue.decisions.pop();
    }
    dialogue.current = turn;
    // いまどこかの印は、コードが順を決める型だけ（割り込んだ1点には終わりの数が無い）
    const progress =
      def.fixed && fixedPoint && turn.mode === "ask"
        ? describeFixedProgress(style, frame, fixedPoint)
        : undefined;
    this.postPlotAnswer(
      dialogue,
      describePlotTurn(
        turn,
        dialogue.asked.length === 0 && !options.more,
        Boolean(options.more),
        progress
      ),
      authorText
    );
  }

  /**
   * 決まったことを、ログライン・人物・世界・構成へまとめてもらう（P-44）。
   *
   * **決まったことが抜けていれば、コードが足す**（実装ルール3「マージはAIで
   * なくコードが行う」）。まとめは見せるだけで、書くのは「このまとめで
   * プロットに書く」を押したとき。
   */
  private async requestPlotSummary(
    dialogue: PlotDialogueState,
    authorText: string
  ): Promise<void> {
    const plot = await this.readPlot(dialogue.work);
    const writtenPlot = plot ? describeWrittenPlot(plot.sections, plot.extra) : "";
    const def = plotStyleDef(dialogue.style ?? "idea");

    const result = await this.askPlotAI(dialogue, authorText, {
      label: "対話式プロット作成（まとめ）",
      version: `P-44 ${PLOT_SUMMARY_VERSION}`,
      /*
        **問いとは別の機能名で数える。** 出力の上限は機能ごとの実測から
        見込む（`featureOutputCeiling`）。短い問いの実測で、項目をいくつも
        書くまとめを切らないため
      */
      feature: "plot_summary",
      systemPrompt: PLOT_SUMMARY_SYSTEM_PROMPT,
      schema: PLOT_SUMMARY_SCHEMA as unknown as object,
      temperature: PLOT_SUMMARY_TEMPERATURE,
      build: (retryNote) =>
        buildPlotSummaryPrompt({
          workTitle: dialogue.work.title,
          idea: dialogue.idea,
          ideaHeading: def.seedHeading,
          writtenPlot,
          decisions: dialogue.decisions,
          retryNote,
        }),
      check: (text) => {
        // 着想とプロットに書いてあることも、根ざしてよいもの（補いに数えない）
        const check = validatePlotSummary(text, dialogue.decisions, [
          dialogue.idea ?? "",
          writtenPlot,
        ]);
        return check.ok
          ? { ok: true, value: check }
          : {
              ok: false,
              reason: check.reason,
              retryNote:
                "前の答えは、決められた形になっていませんでした。指定のJSONで、項目ごとのまとめを書いてください。",
              failure: "AIのまとめを読み取れませんでした。",
            };
      },
    });
    if (!result) return;

    if (!result.ok) {
      this.postPlotAnswer(
        dialogue,
        `${result.failure}\n問答を続けるか、決まったことをそのまま書いてください。`,
        authorText
      );
      return;
    }

    dialogue.summary = result.value.contents;
    this.postPlotAnswer(
      dialogue,
      describePlotSummary(
        result.value.contents,
        result.value.restored,
        result.value.marked,
        result.value.dropped
      ),
      authorText,
      [PLOT_WRITE_SUMMARY_OPTION, PLOT_CONTINUE_OPTION, PLOT_END_OPTION]
    );
  }

  /**
   * 問答の AI 呼び出しの共通部分（P-43・P-44）。
   *
   * 繋がるかの確認・有料の確認・**1度だけの頼み直し**・記録・失敗の案内を
   * 1か所に置く。問いとまとめで別々に持つと、片方だけ直る日が来る。
   *
   * @returns 取りやめ・失敗を画面へ出し終えたときは undefined
   */
  private async askPlotAI<T>(
    dialogue: PlotDialogueState,
    authorText: string,
    spec: {
      label: string;
      version: string;
      feature: string;
      systemPrompt: string;
      schema: object;
      temperature: number;
      build: (retryNote?: string) => string;
      check: (
        text: string
      ) =>
        | { ok: true; value: T }
        | { ok: false; reason: string; detail?: string; retryNote: string; failure: string };
    }
  ): Promise<{ ok: true; value: T } | { ok: false; failure: string } | undefined> {
    const resolved = this.ai.resolve("chat");
    if (!resolved) {
      this.postError(
        "AIが設定されていません。詳細メニューの「AIの設定」から設定してください。"
      );
      return undefined;
    }
    if (!(await confirmProviderReachable(resolved.provider, spec.label, resolved.model))) {
      this.postError(
        "AIに接続できないため、問いを出せませんでした。" +
          "AIを起動してから、もう一度送ってください（書いた答えは覚えています）。"
      );
      return undefined;
    }
    // 有料のAIは、相談と同じく**会話ごとに一度だけ**確認する（`ask` と同じ鍵）
    const paidKey = `${resolved.provider.id}:${resolved.model}`;
    if (resolved.provider.isPaid && this.paidConfirmedFor !== paidKey) {
      const ok = await confirmPaidUsage(resolved.provider, {
        actionLabel: spec.label,
        remember: { id: "ai.paid.workChat" },
        model: resolved.model,
        detail:
          "問いを1つ出すたびに1回ずつ課金されます（受け取れなかったときは、もう1回頼み直します）。\n" +
          "（この確認はこの会話で一度だけです。「最初から」を押すと再び確認します）",
      });
      if (!ok) {
        this.postAll({ type: "cancelled" });
        return undefined;
      }
      this.paidConfirmedFor = paidKey;
    }

    const work = dialogue.work;
    useLogFile(work.folderPath);
    const outputLimit = resolveOutputLimitForSend(
      resolved.provider.id,
      resolved.model,
      spec.feature
    );
    const started = Date.now();
    let retryNote: string | undefined;
    let failure = "";
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        logStep(
          `${spec.label}: ${spec.version} / ${resolved.model}` +
            (attempt > 0 ? "（頼み直し）" : "")
        );
        const result = await resolved.provider.generate({
          systemPrompt: spec.systemPrompt,
          userPrompt: spec.build(retryNote),
          model: resolved.model,
          temperature: spec.temperature,
          maxOutputTokens: outputLimit.tokens,
          plannedOutputTokens: resolveOutputTokensForPlanning(
            resolved.provider.id,
            resolved.model,
            spec.feature
          ),
          jsonSchema: spec.schema,
          disableThinking: true,
          meta: { feature: spec.feature, workFolder: work.folderPath },
        });
        const check = spec.check(result.text);
        // **受け取れなかった回も残す。** 何が返って捨てたのかが無いと、
        // 「AIが止めた」と言われたときに確かめようがない
        appendChatLog(work, {
          panel: "相談パネル",
          promptVersion: spec.version,
          provider: resolved.provider.displayName,
          model: resolved.model,
          paid: resolved.provider.isPaid,
          target: spec.label,
          question: authorText,
          reply: result.text,
          elapsedMs: Date.now() - started,
          usage: result.usage,
          ...(check.ok ? {} : { error: `受け取れず（${check.reason}）` }),
        });
        if (check.ok) {
          // 待っているあいだに「最初から」が押された・始め直された
          return this.plotDialogue === dialogue ? { ok: true, value: check.value } : undefined;
        }
        logStep(
          `${spec.label}: 受け取れず（${check.reason}` +
            (check.detail ? `：${check.detail}` : "") +
            "）"
        );
        retryNote = check.retryNote;
        failure = check.failure;
      }
    } catch (error) {
      const timedOut = error instanceof AIError && error.kind === "timeout";
      const actions = timedOut
        ? this.timeoutAction(resolved.provider, resolved.model)
        : undefined;
      const message =
        error instanceof AIError
          ? `${error.message} ${recoveryForAIError(error)}`
          : error instanceof Error
            ? error.message
            : String(error);
      logFailure(spec.label, { 内容: message, 詳細: failureDetail(error) });
      this.postError(message, actions ? [actions] : undefined);
      return undefined;
    }
    return this.plotDialogue === dialogue ? { ok: false, failure } : undefined;
  }

  /** 問答の答えを画面へ出す。**相談と同じ「答え」の形**で送る（待ち状態が解ける） */
  private postPlotAnswer(
    dialogue: PlotDialogueState,
    reply: string,
    authorText: string,
    options?: string[]
  ): void {
    // 普通の相談へ戻ったとき、問答の流れを知っているように会話にも積む
    this.history.push(
      { role: "author", text: authorText },
      { role: "assistant", text: reply }
    );
    this.historyWorkId = dialogue.work.id;

    const extras: ChatAnswerExtras = {
      options: options ?? this.plotDialogueOptions(dialogue),
    };
    this.tail = { lastAnswer: extras };
    this.postAll({
      type: "answer",
      ...extras,
      reply,
      html: renderMarkdownLite(reply),
    });
  }

  /** 書いたあと・まとめを見たあとに、いまの問いへ戻る札を出す */
  private offerPlotContinue(dialogue: PlotDialogueState): void {
    if (this.plotDialogue !== dialogue) return;
    this.postAll({
      type: "chatter",
      who: "AI",
      text: dialogue.current
        ? `続けるなら、【${dialogue.current.topic}】の問いに答えてください。`
        : dialogue.fixedDone
          ? `終えるなら「${PLOT_END_OPTION}」を押してください。思いついたことを書けば、補足として残します。`
          : "続けるなら、思いついたことを書くか、下の札を押してください。",
      options: this.plotDialogueOptions(dialogue),
    });
  }

  /**
   * 問答の札。候補 → ほかの案 → 飛ばす → 書く → まとめる → 終える の順。
   *
   * **「書く」「まとめる」は決まったことがあるときだけ。** 何も決まって
   * いないのに出すと、押しても何も起きない札になる。
   * コードが順を決める型で問いを出せなかったときは、**その枠を飛ばす札も出す**。
   * 枠・項目が尽きたら、頼み直しの札は出さない（頼んでも尋ねることが無い）。
   */
  private plotDialogueOptions(dialogue: PlotDialogueState): string[] {
    const current = dialogue.current;
    const decided = dialogue.decisions.length > 0;
    return [
      ...(current
        ? [
            ...current.candidates.map((candidate) => candidate.text),
            PLOT_MORE_OPTION,
            PLOT_SKIP_OPTION,
          ]
        : dialogue.fixedDone
          ? []
          : // コードが決めた・割り込んだ1点（枠・場面の3点・目標の文字数）は飛ばせる
            dialogue.pending
            ? [PLOT_RETRY_OPTION, PLOT_SKIP_OPTION]
            : [PLOT_RETRY_OPTION]),
      ...(decided ? [PLOT_WRITE_OPTION, PLOT_SUMMARY_OPTION] : []),
      PLOT_END_OPTION,
    ];
  }

  /**
   * 項目ごとの中身を `plot.md` へ書く（決まったこと・まとめの両方）。
   *
   * **書く道は相談の書き込みと同じ**（`applyStagedEdit` → `applyChatEdit`）。
   * 退避・取り消し・書いた中身の表示を2通りにしない。
   * **作者が書いた項目は上書きしない**（`planSectionWrite`）——書かなかった
   * ものは中身ごと見せる（黙って捨てない）。
   */
  private async writePlotSections(
    dialogue: PlotDialogueState,
    contents: ReadonlyMap<PlotDialogueSection, string>,
    note: string
  ): Promise<void> {
    const plot = await this.readPlot(dialogue.work);
    const plan = planSectionWrite(
      contents,
      plot?.sections ?? emptyPlotSections(),
      dialogue.written
    );

    if (plan.write.length === 0 && plan.kept.length === 0) {
      this.postAll({
        type: "note",
        message: "書き足すことはありません（もう plot.md に入っています）。",
      });
      return;
    }

    for (const item of plan.write) {
      const target = { kind: "plot" as const, section: item.section };
      const id = `edit-${++this.editSeq}`;
      this.pendingEdits.set(id, {
        edit: {
          target,
          content: item.content,
          label: describeChatEditButton(target, note),
        },
        work: dialogue.work,
      });
      await this.applyStagedEdit(id);
      // 書けたものだけ控える（書けなかった項目を「この問答が書いた」にしない）
      if (this.pendingUndos.has(id)) dialogue.written.set(item.section, item.content);
    }

    if (plan.kept.length > 0) {
      this.postAll({
        type: "note",
        message:
          "次の項目は作者の書いた文があるので、上書きしませんでした。必要なら手で書き足してください。\n" +
          plan.kept.map((item) => `【${item.heading}】${item.content}`).join("\n"),
      });
    }
  }

  /** `plot.md` を読んで節に分ける。読めなければ undefined（無いファイルは空として読める） */
  private async readPlot(work: WorkEntry): Promise<ParsedPlot | undefined> {
    try {
      return parsePlotMarkdown(await readPlotText(work));
    } catch {
      return undefined;
    }
  }

  private async resolveContext(): Promise<ResolvedContext | undefined> {
    const editor = this.lastEditor;
    const filePath = this.documentPath(editor);
    const work = filePath ? this.findWork(filePath) : undefined;

    // **ファイルを開いていなくても相談できるようにする。**
    // 以前はここで undefined を返しており、作品を開いていないだけで
    // 起動ボタンも材料も出なかった（作者の指摘、2026-08-15）
    if (!work || !filePath) return this.workOnlyContext();

    const config = await readWorkConfig(work);
    const settingsDirName = path.basename(workPaths(work, config).settings);
    // **符号を解いてから相対にする。** ブラウザ版では作品の場所が生の日本語、
    // 開いた本文の場所が百分率符号の形で来るので、そのまま `relative` へ
    // 渡すと作品の外を指す道になり、設定資料を開いていても本文扱いになる
    const relativePath = path.relative(
      path.decodeUriEscapes(work.folderPath),
      path.decodeUriEscapes(filePath)
    );

    let isEpisode = false;
    let chapterLabel: string | null = null;
    try {
      const scan = await scanWork(work);
      // 同じ理由で、話の引き当ても符号を解いて比べる（`isSamePath`）
      const episode = scan.episodes.find((item) =>
        path.isSamePath(item.filePath, filePath)
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
        // 画面の上部に出る名前。ブラウザ版でも `%E7…` ではなく日本語で出す
        path.basename(path.decodeUriEscapes(filePath)),
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
      const foundLabels = describeRetrievedItems(
        found.map((candidate) => candidate.item)
      );
      logStep(`相談: ${retrieval}（` + foundLabels.join("、") + "）");

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
          found.map((candidate, index) => ({
            label: foundLabels[index] ?? "",
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
    let episodes: FileHint[] = [];
    try {
      episodes = await this.episodeHints(work);
    } catch {
      // 走査できなくても、紹介文とプロットだけで全体像は伝わる
    }
    const documents: Array<{ label: string; file: string; text: string }> = [];
    for (const document of CHAT_OVERVIEW_DOCUMENTS) {
      const text = await this.readSettingsFile(work, document.file);
      if (text) documents.push({ ...document, text });
    }
    // 組み方（話数の上限・省略の断り・文書の切り詰め）は core（MCP の相談と同じもの）
    return formatChatOverview({ episodes, documents });
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

  /**
   * 開いているファイルが属する作品。
   *
   * 引き当ては `findWorkForFile`（入れ子なら内側。下の欄と同じ）に任せる。
   * 以前は `resolve`＋`startsWith` の自前の判定で、大小の違い（Windows）も、
   * ブラウザ版で符号化された日本語の場所も、別の作品と見ていた（2026-09-24）
   */
  private findWork(filePath: string): WorkEntry | undefined {
    return findWorkForFile(this.registry.list(), filePath);
  }

  /**
   * 相談の相手にしてよい文書なら、その場所。してはいけないなら `undefined`
   * （作者の裁定、2026-09-24 夜。設計書6.72／5.8）。
   *
   * - **`file` は今までどおり受け取る**（作品の外でも受け取り、作品の
   *   特定は `findWork` に任せる。作品の外なら「選んである作品」の相談になる）
   * - **`file` 以外は、登録済みの作品の中にある文書だけ受け取る。**
   *   以前は `file` しか受け取らず、ブラウザ版（`vscode-vfs://…`）では
   *   本文を開いていても相談の対象がその作品にならなかった
   * - **URI の形をしていないもの（`untitled:Untitled-1`）は受け取らない。**
   *   `fromUri` は `file` 以外を URI の文字列で返すが、斜線の無い形は
   *   手元の相対の道と見分けられず、中にあるかの判定に回すと
   *   いまの場所しだいで「中」と答えうる
   */
  private documentPath(
    editor: vscode.TextEditor | undefined
  ): string | undefined {
    if (!editor) return undefined;
    const uri = editor.document.uri;
    const location = fromUri(uri);
    if (uri.scheme === "file") return location;
    if (!path.isUriString(location)) return undefined;
    return this.findWork(location) ? location : undefined;
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

/**
 * 「最初から」を勧めるのは、これまでのやり取りが送った量のこの割合以上の
 * ときだけ。**相談で作者の操作によって減るのは履歴だけ**である——抜粋
 * （開いている画面の前後、4,000字まで）・作品の全体像・質問に近い場面
 * （8,000字まで）は、毎回組み直されて減らせない。履歴が数百字のときに
 * 「最初から」を勧めても、読み込みの時間はほとんど変わらない。
 *
 * 4分の1にしたのは、実機（約620秒で600秒の上限に当たった）のような
 * 「少し足りない」回なら、それだけ減れば上限の内に収まる見込みがあるため。
 */
const HISTORY_SHARE_FOR_CLEAR = 0.25;

/**
 * 相談の時間切れの案内（ノートPCの実機、2026-09-23）。
 *
 * 共通の案内（`recoveryForAIError`）を使わない理由は2つ。
 * 1. 待ち時間が既に上限（`maxTimeoutSeconds`。手元1800秒・クラウド600秒）
 *    なら、延ばせない。**文言の秒数は `maxSeconds` から出す**（決め打ちしない）
 * 2. 相談はチャンクに分けないので、「1チャンクの文字数」は効かない
 *
 * **実際に効く操作を1つだけ言う**（実装ルール5）。上限未満なら延ばす
 * （札は `timeoutAction` が出す）。上限なら、履歴が重いときは「最初から」、
 * そうでなければ別のAIを選ぶ。サービス名は書かない。
 */
export function workChatTimeoutAdvice(input: {
  /** いま効いている待ち時間（`resolveTimeoutSeconds`。上限で抑えた後の値） */
  currentSeconds: number;
  maxSeconds: number;
  /** 延ばす札が出ているか */
  canRaise: boolean;
  /** 切れた回に送った量（システムプロンプト＋本体）。分からなければ省く */
  sentChars?: number;
  /** そのうち、これまでのやり取りの字数 */
  historyChars?: number;
}): string {
  const atCeiling =
    Number.isFinite(input.currentSeconds) &&
    input.currentSeconds >= input.maxSeconds;

  if (!atCeiling) {
    return input.canRaise
      ? "待ち時間を延ばすと届くことがあります。下の札を押すと延ばせます。"
      : "拡張機能の設定で、お使いのAIの「タイムアウト」の秒数を延ばしてください。";
  }

  const sentChars = input.sentChars;
  const historyChars = input.historyChars ?? 0;
  const head =
    `待ち時間はすでに上限（${input.maxSeconds}秒）で、これ以上は延ばせません` +
    (sentChars !== undefined && sentChars > 0
      ? `（この相談で送った量は${formatChars(sentChars)}字）。`
      : "。");

  if (
    sentChars !== undefined &&
    sentChars > 0 &&
    historyChars / sentChars >= HISTORY_SHARE_FOR_CLEAR
  ) {
    return (
      head +
      `そのうち${formatChars(historyChars)}字はこれまでのやり取りです。` +
      "「最初から」を押して会話を空にすると、そのぶんを送らずに済みます。"
    );
  }
  return (
    head +
    "このAIでは、この量の相談が上限の時間内に終わりません。" +
    "より速いAIを選んでください（パネルの上に出ているAIの名前を押すと、" +
    "AIの設定を開けます）。"
  );
}

/** 24209 → 「24,209」。作者が読む数なので桁を区切る */
function formatChars(value: number): string {
  return Math.round(value).toLocaleString("ja-JP");
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
    "「設定資料更新分反映」で確認できます。"
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
