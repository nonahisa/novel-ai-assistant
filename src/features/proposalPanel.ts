import * as vscode from "vscode";
import { fromUri } from "../core/paths";
import * as path from "../core/paths";
import { WorkEntry } from "../models/types";
import {
  readTextFile,
  sameFilePath,
  writeTextFilePreservingFormat,
  type WriteTextFileResult,
} from "../core/textFile";
import { appendAiActionLog } from "../core/typoIssueHistory";
import { dismissKey, TypoDismissedHistory } from "../core/typoIssueHistory";
import { parseEpisodeFileName } from "../core/episodeParser";
import type { TypoCheckIssue } from "./checkTypos";
import type { AcceptedContradiction as ContradictionIssue } from "../core/contradictionValidation";
import type { DeviationIssue } from "./checkDeviations";
import { buildProposalPanelHtml } from "../views/proposalPanelHtml";
import { diffChars, type DiffSegment } from "../core/inlineDiff";
import { KeepWordStore } from "../core/keepWordStore";
import { validateKeepWord } from "../models/keepWord";
import { explainProofreadReason } from "../core/proofreadValidation";
import { manualActor, recordEdit } from "../core/actorContext";
import { isEditorMode } from "../core/actorContext";
import { ProposalStore } from "../core/proposalStore";
import { proposalId } from "../models/proposal";
import { FileLockStore } from "../core/fileLockStore";
import { describeLock, normalizeFile } from "../models/fileLock";
import { tryGitUserName } from "../core/gitAttribution";
import { acceptProposal, rejectProposal } from "./reviewProposals";
import {
  describeBadgeTooltip,
  isRemaining,
  mergeProposals,
  summarizeCategories,
  type CategorySummary,
  type WorkSummary,
} from "../core/proposalBuckets";
// **型だけを取る。** `AIRegistry` の実体は呼び出し側（extension.ts）が
// 作ったものを受け取るので、ここで束に取り込む必要がない
import type { AIRegistry } from "../ai/registry";
import { confirmPaidUsage } from "./aiConnectivity";
import {
  recheckProposal,
  type RecheckItem,
  type RecheckOutcome,
} from "./recheckProposal";
import { logFailure, logLine } from "../core/logger";

/**
 * 提案パネル（誤字脱字）。
 *
 * 出力・デバッグコンソールと同じ下段の領域に表示する
 * `WebviewViewProvider`。設定資料パネル（`settingsPanel.ts`）は
 * エディター領域に開く別方式だが、こちらは本文を編集しながら
 * 常に見えている場所に置きたいという要望のため下段にした。
 *
 * 設計書6.11は誤字脱字／推敲／逸脱・間延び／矛盾を同じパネルに
 * タブ分けで統合する設計。ビューIDとコンテナ名は既にその前提で
 * 分類ごとに分けて出す（6.11.3で、分類を切り替えられるようにした）。
 */

export const PROPOSALS_VIEW_ID = "novelai.proposalsView";

/**
 * 画面へ送る直前に、違うところと「再チェックできるか」を添える。
 *
 * **修正案の無い指摘がある**（推敲の「長すぎる文」など）。そのときは
 * 比べる相手がいないので、違うところは添えない。
 *
 * **再チェックは、修正案の有無に関わらず出す。** 作者は誤字脱字の指摘も
 * 手で書き直すし、修正案どおりに直すとも限らない（作者の依頼、2026-08-27）。
 * 出さないのは編集部からの提案だけで、あちらは承認・却下という別の
 * 片付け方を持っている。
 */
function forView(item: ProposalViewItem): ProposalViewItem {
  const shown: ProposalViewItem = {
    ...item,
    canRecheck: !item.proposalId,
  };
  if (!item.suggestion) return shown;
  return { ...shown, diff: diffChars(item.target, item.suggestion) };
}

/**
 * 矛盾・プロット逸脱を、画面へ送る直前に整える。
 *
 * **こちらは常に再チェックを出す。** 矛盾も逸脱も作者へ直に出す指摘で、
 * 編集部の提案のような別の片付け方（承認・却下）を持たない。
 * それでも `forView` と同じく**送る直前に決める**——保存すると、
 * 出し分けの規則が変わったときに古い値を抱えた指摘が残る。
 *
 * 作者の依頼（2026-08-27）：「誤字をなおした後、再確認したい」。
 * 矛盾は「設定の『プラム』と本文の『プリム様』が食い違う」のように、
 * **直し方を作者が決める**指摘なので、直したかどうかは確かめるしかない。
 */
function contradictionForView(
  item: ContradictionViewItem
): ContradictionViewItem {
  return { ...item, canRecheck: true };
}

export interface ProposalViewItem {
  id: string;
  filePath: string;
  fileName: string;
  chunkHash: string;
  line: number;
  original: string;
  target: string;
  suggestion: string;
  reason: string;
  /**
   * なぜ読みにくいのか（推敲）。
   *
   * **`reason` は種類の一語しか入っていない**（冗長・同語反復・係り受け・
   * 長文）。それだけでは、何と何の話なのかが分からない
   * （2026-08-22、作者の指摘）。AIの説明か、種類ごとの決まり文句が入る。
   */
  detail?: string;
  confidence: "high" | "medium" | "low";
  /**
   * いまの扱い。
   *
   * `"resolved"` は**作者が本文を書き直して片付いた**もの（P-23）。
   * 「適用した」でも「見送った」でもないので分ける——適用は拡張機能が
   * 本文を書き換えたことを、見送りは直さないと決めたことを意味する。
   */
  status: "pending" | "applied" | "failed" | "dismissed" | "resolved";
  statusDetail?: string;
  /**
   * 再チェックした結果（P-23）。
   *
   * **`statusDetail` とは分ける。** あちらは適用に失敗した理由で、画面では
   * 赤く出る。こちらは「確かめた結果」であって不具合ではない。
   */
  recheckNote?: string;
  /**
   * 再チェックの最中か。**押した手応えを返すために要る。**
   * AIの応答は数秒〜数十秒かかるので、無反応だと壊れたようにしか見えない。
   */
  busy?: boolean;
  /**
   * 「再チェック」を出すか。**画面へ送る直前に決める**（`forView`）ので、
   * 保存はしない
   */
  canRecheck?: boolean;
  /**
   * `target` のどこが `suggestion` で変わるか、区間に分けたもの。
   *
   * **画面で「違うところだけ」を塗るために使う。** 計算は拡張機能側で
   * 行う。WebView の中に書くと単体テストが書けないためで、`postItems`
   * で送るたびに作り直す（保存はしない）。
   */
  diff?: DiffSegment[];
  /**
   * 編集部の提案として来たものなら、その番号。
   *
   * **提案は本文への適用だけで終わらない。** 採ったか見送ったかを
   * 提案の側にも書き戻す必要がある（設計書5.6）。
   */
  proposalId?: string;
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
  /**
   * いまの扱い。
   *
   * `"resolved"` は**作者が本文を書き直して片付いた**もの（P-23）。
   * 「無視した」とは分ける——あちらは「この食い違いは矛盾ではない」という
   * 判断で、こちらは「食い違いは本物だったが、もう直した」である。
   */
  status: "pending" | "dismissed" | "resolved";
  /**
   * 再チェックした結果（P-23）。誤字脱字側の `recheckNote` と同じもので、
   * 画面でも同じ `.recheck-note` に出す
   */
  recheckNote?: string;
  /**
   * 再チェックの最中か。**押した手応えを返すために要る。**
   * AIの応答は数秒〜数十秒かかるので、無反応だと壊れたようにしか見えない。
   */
  busy?: boolean;
  /**
   * 「再チェック」を出すか。**画面へ送る直前に決める**
   * （`contradictionForView`）ので、保存はしない
   */
  canRecheck?: boolean;
  /**
   * 「無視しました」の代わりに出す言葉。
   *
   * **片付いた理由が1つではない**（設計書6.35.4）。「この食い違いは
   * 矛盾ではない」で見送ったのか、「これは伏線だった」ので台帳へ移したのかは
   * 別のことである。状態そのものは `dismissed` のまま（＝片付いた）にして、
   * 理由だけを添える。印を増やすと、片付いたかどうかを見る側が全部の
   * 印を知っていなければならなくなる。
   */
  dismissReason?: string;
  /**
   * 「伏線として登録」を出すか（設計書6.35.4）。
   *
   * **矛盾にだけ出す。** プロット逸脱は「プロットと本文の食い違い」であって
   * 「後の展開への示唆」ではないので、伏線の台帳へ入れる意味がない。
   */
  canRegisterForeshadow?: boolean;
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

/**
 * 矛盾から伏線を作るときに渡すもの（設計書6.35.4）。
 *
 * **パネルは伏線の保存を知らない。** 保存の手順は呼び出し側
 * （`extension.ts` が `features/foreshadows.ts` を繋ぐ）が持ち、
 * ここは「何を写すか」だけを決める。設定資料の更新で
 * `applyRecordUpdate` を外から渡しているのと同じ形である。
 */
export interface ForeshadowFromContradiction {
  /** 伏線の短い名 */
  label: string;
  /** 何を示唆しているか。矛盾の内容を写す */
  note: string;
  /** 張った話数。ファイル名から読めなければ null（推測で埋めない） */
  chapter: number | null;
  /** 本文の逐語引用 */
  quote: string;
}

export type RegisterForeshadow = (
  source: ForeshadowFromContradiction
) => Promise<{ ok: boolean; reason?: string }>;

/**
 * 再チェックが触るところだけを取り出した形（P-23）。
 *
 * **誤字脱字の指摘と矛盾では、持っている項目が違う**（あちらは置き換え、
 * こちらは食い違い）。共通なのは「どのファイルの何行目か」と「いま何を
 * しているか」だけなので、そこだけを受け取って処理を1本にまとめる。
 * 2本に分けると、片方だけ直る。
 */
interface RecheckTarget {
  filePath: string;
  fileName: string;
  line: number;
  /**
   * **ここへ書き込むのは `"resolved"` だけ。** 誤字脱字側の広い型で
   * 受けているので「適用済み」なども入れられてしまうが、立てない
   * （矛盾には適用という道が無い）。
   */
  status: ProposalViewItem["status"];
  recheckNote?: string;
  busy?: boolean;
}

/**
 * 設定資料の更新の1件（設計書5.6）。
 *
 * **本文の置き換えとは形が違う。** 行と文字ではなく、レコードと項目である。
 * それでも**作者への提案であることは同じ**なので、同じパネルに出す。
 * 提案の窓口が2つあると、片方を見落とす。
 */
/** 設定資料の1項目が、どう変わるか */
export interface RecordChangePart {
  /** 項目名（「紹介」「性別」など） */
  label: string;
  before: string;
  after: string;
  /** 違うところ。`before` を `after` にするための区間の並び */
  diff: DiffSegment[];
}

export interface RecordUpdateViewItem {
  id: string;
  /** 何のレコードか（人物名など） */
  name: string;
  /** 何が変わるか。1行ずつの説明 */
  changes: string[];
  /**
   * 同じ内容を「項目・前・後」に分けたもの。
   *
   * **紹介文のように長い項目は、変わるのがひと言だけのことが多い。**
   * 前後をまるごと並べると、どこが変わるのか目で追えない（作者の指摘）。
   * ここがあれば、画面は違うところだけを塗る。
   * 無ければ `changes` をそのまま並べる（古い作りへ落ちる）。
   */
  changeParts?: RecordChangePart[];
  /** どこから来た提案か */
  source: string;
  status: "pending" | "applied" | "failed" | "dismissed";
  statusDetail?: string;
  /**
   * 「反映する」の代わりに出す言葉（設計書6.35.2・6.35.3）。
   *
   * **押した結果が何になるかで呼び名が変わる。** 設定資料なら「反映する」だが、
   * 伏線の候補は「登録」、回収の候補は「回収済みにする」である。
   * 同じ描画を使い回すために持たせる（無ければこれまでどおり「反映する」）。
   */
  applyLabel?: string;
}

type OutgoingMessage = IssuesMessage | RunningMessage;

/**
 * 検知の進み具合（作者の報告、2026-08-29）。
 *
 * 「下に動いているときのチャンク数がでないですね」——相談から誤字脱字を
 * 実行し、結果が出る下段の提案パネルを見て待っていたが、進み具合が
 * そこに出なかった。**右下の通知には出ているが、見ているのはこちらである。**
 *
 * `done` が `total` に届いても、この報せだけでは終わったことにならない
 * （検証・後片付けが残る）。**終わりは必ず `runningDone` か `issues` で
 * 消す**——「3/12」が出たまま残るのが、いちばん困る形である。
 */
type RunningMessage = {
  type: "running" | "runningDone";
  /** 何をしているか（「誤字脱字を検知」）。文の側で「〜しています」を足す */
  label: string;
  done: number;
  total: number;
  /** 数えている単位。話ごとに送る検知では「話」になる */
  unit: string;
};

type IssuesMessage = {
  type: "issues";
  workTitle: string;
  /**
   * いま表示している作品のid。
   *
   * **スクロール位置を保つ判定に使う**（0.22.24の積み残し）。別作品の
   * 結果が届いて描き直されるたびに先頭へ戻っていた。題名は同名の作品が
   * ありうるので、判定はidで行う。
   */
  workId: string;
  /** パネルの見出し。誤字脱字か表記ゆれか矛盾かで変わる */
  category: string;
  items: Array<
    ProposalViewItem | ContradictionViewItem | RecordUpdateViewItem
  >;
  /** 「まとめて適用」を出すか。矛盾では出さない */
  canApplyAll: boolean;
  /**
   * 持っている分類の一覧（設計書6.11.3）。
   *
   * **切り替えて見るために要る。** 検知を走らせても前の結果は消えないので、
   * どこに何件残っているかを出して、戻れるようにする。
   */
  categories: CategorySummary[];
  /**
   * 結果を持っている作品の一覧（設計書6.11.3）。
   *
   * **2つ以上あるときだけ中身が入る。** 1作品しか無ければ選ぶものが無く、
   * 下段の狭い画面を取るだけになる。
   */
  works: WorkSummary[];
};

type IncomingMessage =
  | { type: "jump"; id: string }
  | { type: "apply"; id: string }
  | { type: "undo"; id: string }
  | { type: "dismiss"; id: string }
  | { type: "keepWord"; id: string }
  | { type: "openSettings"; id: string }
  /** その食い違いは矛盾ではなく伏線だった（設計書6.35.4） */
  | { type: "registerForeshadow"; id: string }
  /** 作者が本文を手で書き直したあと、その指摘が解消したかを確かめる */
  | { type: "recheck"; id: string }
  | { type: "applyAll" }
  /** 別の分類へ切り替える */
  | { type: "selectCategory"; category: string }
  /** 別の作品へ切り替える（適用・見送りは表示中の作品にしか効かないため） */
  | { type: "switchWork"; workId: string }
  /** いま見ている分類を空にする */
  | { type: "clearCategory" };

/**
 * 1つの分類が持つもの。
 *
 * **3つを混ぜない。** 適用の処理が誤字脱字の形を前提にしており、
 * 混ぜると矛盾を「適用」しようとして壊れる。
 */
interface CategoryBucket {
  items: ProposalViewItem[];
  contradictions: ContradictionViewItem[];
  recordUpdates: RecordUpdateViewItem[];
  applyRecordUpdate?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * 更新を見送る処理（承認待ちから片付ける）。**apply と必ず対にする。**
   * これが無かったころ、「見送る」は押しても黙って何も起きなかった
   * （dismissIssue が本文の指摘しか探さず、素通りしていた。作者の報告、2026-08-28）
   */
  dismissRecordUpdate?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 矛盾を伏線として台帳へ入れる処理（設計書6.35.4）。矛盾の段だけが持つ */
  registerForeshadow?: RegisterForeshadow;
}

function emptyBucket(): CategoryBucket {
  return { items: [], contradictions: [], recordUpdates: [] };
}

/**
 * 1つの作品が持つもの（設計書6.11.3）。
 *
 * **作品ごとに分ける。** 誤字脱字を2つの作品で同時に走らせると、あとから
 * 届いたほうが画面を奪い、**見ている途中の作品の指摘を全部捨てていた**
 * （2026-08-27、作者の指摘）。届いた結果はその作品の段へ入れるだけにして、
 * 画面は作者が選んだときにだけ移す。
 *
 * 作品の情報を一緒に持つのは、**題名と直近の分類を別の入れ物にすると
 * 同期が漏れるため**（一覧を空にしたときに片方だけ残る）。
 */
interface WorkBuckets {
  /** いちばん新しい作品の情報（題名は作者が変えることがある） */
  work: WorkEntry;
  /**
   * 分類ごとの置き場。
   *
   * `Map` は入れた順を保つので、タブの並びは**走らせた順**になる。
   */
  categories: Map<string, CategoryBucket>;
  /**
   * 直近に見ていた分類。
   *
   * **作品を切り替えて戻ったとき、続きから見せる。** 毎回先頭の分類へ
   * 戻ると、どこまで見たかを作者が数え直すことになる。
   */
  lastCategory?: string;
}

/** その作品の全分類で、まだ手を付けていない件数 */
function countRemaining(
  categories: ReadonlyMap<string, CategoryBucket>
): number {
  let total = 0;
  for (const bucket of categories.values()) {
    total += [
      ...bucket.items,
      ...bucket.contradictions,
      ...bucket.recordUpdates,
    ].filter(isRemaining).length;
  }
  return total;
}

export class ProposalPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private work: WorkEntry | undefined;
  private items: ProposalViewItem[] = [];
  /**
   * 矛盾の指摘。誤字脱字とは別に持つ。
   *
   * **同じ配列へ混ぜない。** 適用・まとめて適用の処理が誤字脱字の形を
   * 前提にしており、混ぜると矛盾を「適用」しようとして壊れる。
   */
  private contradictions: ContradictionViewItem[] = [];
  /**
   * 設定資料の更新。**本文の置き換えとは処理がまるごと違う**ので、
   * 同じ配列へ混ぜない（矛盾を別に持つのと同じ理由）
   */
  private recordUpdates: RecordUpdateViewItem[] = [];
  /** 更新を反映する処理。呼び出し側から渡してもらう */
  private applyRecordUpdate:
    | ((id: string) => Promise<{ ok: boolean; reason?: string }>)
    | undefined;
  /** 更新を見送る処理（承認待ちから片付ける）。apply と対 */
  private dismissRecordUpdate:
    | ((id: string) => Promise<{ ok: boolean; reason?: string }>)
    | undefined;
  /**
   * 矛盾を伏線として台帳へ入れる処理（設計書6.35.4）。
   * **パネルは保存の手順を知らない**ので、呼び出し側から渡してもらう
   */
  private registerForeshadow: RegisterForeshadow | undefined;
  private category = "誤字脱字";
  /**
   * 作品ごと・分類ごとの置き場（設計書6.11.3）。
   *
   * **上の4つは「いま出している分」で、こちらが控えである。**
   * 既存の処理はすべて `this.items` などを直に触るので、切り替えのたびに
   * 入れ替える形にした。配列そのものを共有しているため、1件を適用した
   * ときの状態の変化は、控えの側にもそのまま残る。
   *
   * **作品でも段を分ける。** 別の作品の結果が届いても、いま見ている作品の
   * 指摘は控えに残り続ける（2026-08-27）。
   */
  private buckets = new Map<string, WorkBuckets>();
  /**
   * 有料AIの確認を取ったモデル（P-23）。
   *
   * **このパネルを開いている間に一度だけ確認する。** 再チェックは1件ずつ
   * 押す操作なので、毎回モーダルが出ると確かめる気が失せる。かといって
   * 一度も出さないと、知らないうちに料金が積み上がる。
   * モデルを覚えるのは、**切り替えたら確認を取り直す**ため。
   */
  private paidConfirmedFor: string | undefined;

  /**
   * @param ai 再チェック（P-23）で使う。**渡されなければ
   *   「再チェック」を押したときにAI未設定として断る。** 検知の結果を
   *   出すだけなら要らないので、必須にはしていない
   */
  /**
   * @param onCountsChanged 反映で承認待ちの件数が変わったときに呼ぶ。
   * メニューの印（更新分を反映 残りN）はコマンド実行時にしか数え直されず、
   * **パネルから全部反映しても印が残る**不具合があった（作者の報告、2026-08-27）
   */
  /**
   * @param revealInManuscript 原稿エディタで開いて、その行を示す口
   * （作者の依頼、2026-08-28）。**引き受けられたときだけ true を返す**——
   * 素のエディタで書いている作者まで、勝手に縦書きの画面へ移さないため。
   * パネルは原稿エディタの都合（どの向きで開くか・画面が動き出したか）を
   * 知らなくてよいので、判断ごと外へ出してある。
   */
  constructor(
    private readonly ai?: AIRegistry,
    private readonly onCountsChanged?: () => void,
    private readonly revealInManuscript?: (
      filePath: string,
      line: number
    ) => Promise<boolean>
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const nonce = createNonce();
    webviewView.webview.html = buildProposalPanelHtml(
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

  /**
   * 検知の結果を、その分類へ足す（設計書6.11.3）。
   *
   * **消さずに足す。** 以前はパネルの中身を丸ごと入れ替えており、
   * 誤字脱字を1件ずつ見ている途中で推敲を実行すると、**適用済み・
   * 見送り済みの判断も、まだ見ていない指摘も、すべて失われていた**
   * （2026-08-22、作者の指摘）。
   *
   * 分類ごとに置き場を持ち、切り替えて見る。同じ分類をもう一度
   * 走らせたときは、作者の判断が入っているものを残して足す
   * （`core/proposalBuckets.ts`）。
   *
   * **入れ替えは、ここ1か所に集める。** 以前は表示口ごとに「他の入れ物を
   * 空にする」処理を書いており、5つのうち4つが `recordUpdates` を
   * 空にし忘れていた（2026-08-21）。入れ物を増やしたときに書き忘れる形の
   * 失敗なので、口を1つにしてある。
   *
   * ## 別の作品の結果が届いても、画面は奪わない
   *
   * 以前は、届いた作品が表示中と違うと**表示中の作品の指摘を全部捨てて**
   * 届いた作品へ切り替えていた。そのため、2つの作品で同時に誤字脱字を
   * 走らせると、提案を1件ずつ確認している最中に画面が入れ替わり、
   * それまでの判断ごと消えた（2026-08-27、作者の指摘）。
   *
   * 捨てていた理由は「作品が変われば前の指摘は開けない」だったが、これは
   * 誤りだった。指摘はファイルの絶対パスを持っており、前の作品のファイルも
   * そのまま開ける。**届いた結果はその作品の段へ入れるだけにして、
   * 画面を移すかどうかは作者に選ばせる。**
   */
  private replaceContents(
    work: WorkEntry,
    category: string,
    contents: {
      items?: ProposalViewItem[];
      contradictions?: ContradictionViewItem[];
      recordUpdates?: RecordUpdateViewItem[];
      applyRecordUpdate?: (
        id: string
      ) => Promise<{ ok: boolean; reason?: string }>;
      dismissRecordUpdate?: (
        id: string
      ) => Promise<{ ok: boolean; reason?: string }>;
      registerForeshadow?: RegisterForeshadow;
    }
  ): void {
    // **表示中の作品の作業を、先に控えへ戻す。** 届いたのがどちらの作品でも通す
    this.stashCurrent();

    const entry = this.workBucketsOf(work);
    const bucket = entry.categories.get(category) ?? emptyBucket();
    bucket.items = mergeProposals(bucket.items, contents.items ?? []);
    bucket.contradictions = mergeProposals(
      bucket.contradictions,
      contents.contradictions ?? []
    );
    bucket.recordUpdates = mergeProposals(
      bucket.recordUpdates,
      contents.recordUpdates ?? []
    );
    // 反映の手順は、いちばん新しく渡されたものを使う（古い閉包を握らない）
    if (contents.applyRecordUpdate) {
      bucket.applyRecordUpdate = contents.applyRecordUpdate;
    }
    if (contents.dismissRecordUpdate) {
      bucket.dismissRecordUpdate = contents.dismissRecordUpdate;
    }
    if (contents.registerForeshadow) {
      bucket.registerForeshadow = contents.registerForeshadow;
    }
    entry.categories.set(category, bucket);

    // まだ何も出していないとき、または同じ作品なら、これまでどおり前面へ
    if (!this.work || this.work.id === work.id) {
      this.work = work;
      this.activate(category);
      // パネルが開いていなければ前面に出す。開いていれば余計なフォーカス移動はしない
      void vscode.commands.executeCommand(`${PROPOSALS_VIEW_ID}.focus`);
      return;
    }

    // **画面には触らない。** 切り替え口の一覧だけ作り直し、届いたことは通知で伝える
    this.postItems();
    // **答えを待たない。** 待つと、検知を終えた側の処理が作者の返事まで止まる
    void this.offerToShow(
      work,
      category,
      (contents.items?.length ?? 0) +
        (contents.contradictions?.length ?? 0) +
        (contents.recordUpdates?.length ?? 0)
    );
  }

  /**
   * 別の作品の結果が届いたことを伝え、移るかどうかを選ばせる。
   *
   * **呼ぶ側は待たない。** 待つと、検知を終えた側の処理が作者の返事まで
   * 止まる（19話ぶんの実行がここで止まっては困る）。
   */
  private async offerToShow(
    work: WorkEntry,
    category: string,
    arrived: number
  ): Promise<void> {
    const answer = await vscode.window.showInformationMessage(
      arrived > 0
        ? `「${work.title}」の${category}の結果が届きました（${arrived}件）`
        : `「${work.title}」の${category}は、指摘がありませんでした。`,
      "表示する",
      "あとで"
    );
    if (answer !== "表示する") return;

    // 答えるまでの間に、作者がその一覧を空にしていることがある
    const entry = this.buckets.get(work.id);
    if (!entry?.categories.has(category)) return;

    this.stashCurrent();
    this.work = entry.work;
    this.activate(category);
    void vscode.commands.executeCommand(`${PROPOSALS_VIEW_ID}.focus`);
  }

  /** その作品の置き場（無ければ作る）。題名はいちばん新しいものへ揃える */
  private workBucketsOf(work: WorkEntry): WorkBuckets {
    const found = this.buckets.get(work.id);
    if (found) {
      found.work = work;
      return found;
    }
    const created: WorkBuckets = { work, categories: new Map() };
    this.buckets.set(work.id, created);
    return created;
  }

  /** いま表示している作品の、分類ごとの置き場（まだ何も無ければ空） */
  private currentCategories(): Map<string, CategoryBucket> {
    const entry = this.work ? this.buckets.get(this.work.id) : undefined;
    return entry?.categories ?? new Map();
  }

  /**
   * いま画面に出している分の状態を、置き場へ書き戻す。
   *
   * **配列は同じものを共有しているが、`applyRecordUpdate` は別**なので、
   * ここで揃える。切り替えのたびに必ず通す。
   */
  private stashCurrent(): void {
    const work = this.work;
    if (!work) return;
    const entry = this.buckets.get(work.id);
    if (this.items.length === 0 &&
        this.contradictions.length === 0 &&
        this.recordUpdates.length === 0 &&
        !entry?.categories.has(this.category)) {
      return;
    }
    this.workBucketsOf(work).categories.set(this.category, {
      items: this.items,
      contradictions: this.contradictions,
      recordUpdates: this.recordUpdates,
      applyRecordUpdate: this.applyRecordUpdate,
      dismissRecordUpdate: this.dismissRecordUpdate,
      registerForeshadow: this.registerForeshadow,
    });
  }

  /** その分類を画面に出す（表示中の作品の中で） */
  private activate(category: string): void {
    const entry = this.work ? this.buckets.get(this.work.id) : undefined;
    const bucket = entry?.categories.get(category) ?? emptyBucket();
    this.category = category;
    // 作品を切り替えて戻ったとき、続きから見せるために覚えておく
    if (entry) entry.lastCategory = category;
    this.items = bucket.items;
    this.contradictions = bucket.contradictions;
    this.recordUpdates = bucket.recordUpdates;
    this.applyRecordUpdate = bucket.applyRecordUpdate;
    this.dismissRecordUpdate = bucket.dismissRecordUpdate;
    this.registerForeshadow = bucket.registerForeshadow;
    this.postItems();
  }

  /**
   * 別の作品へ移る（画面の切り替え口から）。
   *
   * **適用・見送りは表示中の作品にしか効かない。** 別の作品の指摘に手を
   * 付けるには、まずここで移ってもらう。
   */
  private switchWork(workId: string): void {
    if (workId === this.work?.id) return;
    const entry = this.buckets.get(workId);
    if (!entry) return;
    this.stashCurrent();
    this.work = entry.work;
    this.activate(this.categoryToShow(entry));
  }

  /**
   * その作品で最初に出す分類。
   *
   * **直近に見ていたものへ戻す。** 無ければ、その作品が持っている先頭
   * （＝いちばん先に走らせた分類）。
   */
  private categoryToShow(entry: WorkBuckets): string {
    if (entry.lastCategory && entry.categories.has(entry.lastCategory)) {
      return entry.lastCategory;
    }
    return [...entry.categories.keys()][0] ?? this.category;
  }

  /**
   * 検知の進み具合を、このパネルに出す（作者の報告、2026-08-29）。
   *
   * 「下に動いているときのチャンク数がでないですね」。結果が出る場所で
   * 待っているのだから、進み具合もそこに出ていなければならない。
   * **右下の通知は今までどおり出す**（片方に寄せない）。
   *
   * 出す場所は画面側が決める。一覧が空なら中央、前の結果が出ているときは
   * 見出しの横に小さく——**読んでいる指摘の場所を奪わない**ため。
   *
   * @param work どの作品の検知か。表示中の作品と違えば、画面には出さない
   *   （別の作品を見ている最中に、見えている件数と関係のない数が動くと
   *   何の数字か分からなくなる）
   * @param unit 数えている単位。話ごとに送る検知（プロット逸脱）は「話」
   */
  showRunning(
    work: WorkEntry,
    label: string,
    done: number,
    total: number,
    unit = "チャンク"
  ): void {
    // **まだ何も出していないときは、これから届く作品の進みを出してよい。**
    // 初めての検知では `this.work` がまだ無く、ここで弾くと1回目だけ
    // 何も出ないことになる
    if (this.work && this.work.id !== work.id) return;
    this.post({ type: "running", label, done, total, unit });
  }

  /**
   * 進み具合の表示を消す。
   *
   * **中止しても失敗しても必ず通す**（呼び出し側の `finally`）。
   * 結果が届けば画面側が消すが、中止・失敗のときは結果が来ない。
   * 「3/12」が出たまま残るのが、いちばん困る形である。
   */
  finishRunning(): void {
    this.post({ type: "runningDone", label: "", done: 0, total: 0, unit: "" });
  }

  /** 画面へ送る（開いていなければ何もしない） */
  private post(message: OutgoingMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** `checkTypos` / `checkProofread` / `checkNotation` の結果を出す */
  showResults(
    work: WorkEntry,
    /** 推敲は `explanation`（なぜ読みにくいか）を持つ。誤字脱字は持たない */
    issues: Array<TypoCheckIssue & { explanation?: string }>,
    category = "誤字脱字"
  ): void {
    const items: ProposalViewItem[] = issues.map((issue, index) => ({
      id: `${issue.chunkHash}:${issue.line}:${index}`,
      filePath: issue.filePath,
      fileName: path.basename(issue.filePath),
      chunkHash: issue.chunkHash,
      line: issue.line,
      original: issue.original,
      target: issue.target,
      suggestion: issue.suggestion,
      reason: issue.reason,
      detail: proposalDetail(issue),
      confidence: issue.confidence,
      status: "pending",
    }));
    this.replaceContents(work, category, { items });
  }

  /**
   * 矛盾の結果を差し替えて表示する。
   *
   * **適用の口を持たせない。** 設定と本文のどちらが正しいかは
   * 作者にしか決められないので、見に行く先を出すだけにする。
   */
  showContradictions(
    work: WorkEntry,
    issues: ContradictionIssue[],
    /**
     * 「伏線として登録」を押されたときの保存（設計書6.35.4）。
     *
     * **渡されなければボタンを出さない。** 押しても何も起きない口を
     * 作らないため（「見送る」が黙って素通りしていた失敗と同じ形）。
     */
    registerForeshadow?: RegisterForeshadow
  ): void {
    const contradictions: ContradictionViewItem[] = issues.map((issue, index) => ({
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
      // **矛盾が実は伏線だった、という道を残す**（設計書6.35.4）。
      // プロット逸脱には付けない（`showDeviations` を参照）
      canRegisterForeshadow: Boolean(registerForeshadow),
      leftLabel: "設定では",
      rightLabel: "本文では",
      openTarget: "settings",
    }));
    this.replaceContents(work, "矛盾", { contradictions, registerForeshadow });
  }

  /**
   * プロット逸脱・間延びの結果を差し替えて表示する。
   *
   * 矛盾と同じく**適用の口を持たせない。** プロットと本文のどちらが
   * 正しいかは作者にしか決められない（**プロットのほうが古いこともある**）。
   */
  showDeviations(work: WorkEntry, issues: DeviationIssue[]): void {
    const contradictions: ContradictionViewItem[] = issues.map((issue, index) => ({
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
    this.replaceContents(work, "プロット逸脱", { contradictions });
  }

  /**
   * 編集部からの提案を表示する（設計書5.6）。
   *
   * **誤字脱字の指摘と形が同じ**なので、適用・無視の道をそのまま使える。
   * 本文を書き換える処理を新しく作らない。
   */
  showProposals(work: WorkEntry, items: ProposalViewItem[]): void {
    const resolved: ProposalViewItem[] = items.map((item) => ({
      ...item,
      // 提案のファイルは作品フォルダーからの相対パス。開くには繋ぐ
      filePath: path.isAbsolute(item.filePath)
        ? item.filePath
        : path.join(work.folderPath, item.filePath),
    }));
    this.replaceContents(work, "編集部からの提案", { items: resolved });
  }

  /**
   * 設定資料の更新を表示する（設計書5.6）。
   *
   * **提案の窓口を1つにする。** 本文の直しは提案パネル、設定資料の更新は
   * 別のダイアログ、では作者が片方を見落とす。
   */
  showRecordUpdates(
    work: WorkEntry,
    items: RecordUpdateViewItem[],
    apply: (id: string) => Promise<{ ok: boolean; reason?: string }>,
    /** 見送る（承認待ちから片付ける）。渡さないと「見送る」は押せても効かない */
    dismiss: (id: string) => Promise<{ ok: boolean; reason?: string }>,
    /**
     * どの分類として出すか。
     *
     * **本文の置き換えではない提案は、みなこの形に載る**（設計書6.35.2）。
     * 伏線の候補・回収の候補も「1件ずつ承認して保存する」点は設定資料の
     * 更新と同じなので、描画と適用の道をそのまま使い、見出しだけを変える。
     */
    category = "設定資料の更新"
  ): void {
    this.replaceContents(work, category, {
      recordUpdates: items,
      applyRecordUpdate: apply,
      dismissRecordUpdate: dismiss,
    });
  }

  /**
   * 未処理が残っていることを、パネルのタブに出す（設計書6.8.13）。
   *
   * **開いていないと残りに気づけない**（作者の指摘、2026-08-21）。
   * 提案パネルは下段にあり、他のタブ（ターミナル・出力）へ切り替えると
   * 見えなくなる。**問題タブと同じように、数を出す。**
   *
   * ## 数えるのは「まだ手を付けていないもの」だけ
   *
   * 適用したものと見送ったものは、作者の判断が済んでいる。
   * **失敗したものは残りに数える。** 手を付けたが片付いていない。
   *
   * ## 0件のときは印を消す
   *
   * 残っていないのに数字が出ていると、見に行っても何も無い。
   */
  /**
   * 分類ごとの件数を数える。
   *
   * **いま出している分は、控えではなく手元の配列から数える。** 切り替えの
   * たびに書き戻してはいるが、1件を適用した直後のように書き戻す前の
   * 瞬間があるため、そこだけは手元を見る。
   */
  private countByCategory(): Map<string, { remaining: number; total: number }> {
    const counts = new Map<string, { remaining: number; total: number }>();
    // **数えるのは表示中の作品の分だけ。** 別の作品の残りは切り替え口に出す
    const categories = this.currentCategories();
    const seen = new Set([...categories.keys(), this.category]);
    for (const name of seen) {
      const bucket =
        name === this.category
          ? {
              items: this.items,
              contradictions: this.contradictions,
              recordUpdates: this.recordUpdates,
            }
          : (categories.get(name) ?? emptyBucket());
      const all = [
        ...bucket.items,
        ...bucket.contradictions,
        ...bucket.recordUpdates,
      ];
      counts.set(name, {
        remaining: all.filter(isRemaining).length,
        total: all.length,
      });
    }
    return counts;
  }

  private updateBadge(
    summaries: readonly CategorySummary[],
    remaining: number
  ): void {
    if (!this.view) return;
    this.view.badge =
      remaining > 0
        ? { value: remaining, tooltip: describeBadgeTooltip(summaries) }
        : undefined;
  }

  /**
   * 切り替え口に並べる作品。
   *
   * **表示中の作品だけは手元の配列から数える**（`countByCategory` と同じ理由。
   * 1件を適用した直後は、まだ控えへ書き戻していない瞬間がある）。
   */
  private summarizeWorks(currentRemaining: number): WorkSummary[] {
    return [...this.buckets].map(([id, entry]) => ({
      id,
      title: entry.work.title,
      remaining:
        id === this.work?.id
          ? currentRemaining
          : countRemaining(entry.categories),
      active: id === this.work?.id,
    }));
  }

  private postItems(): void {
    const summaries = summarizeCategories(
      this.countByCategory(),
      this.category
    );
    const remaining = summaries.reduce(
      (total, summary) => total + summary.remaining,
      0
    );
    this.updateBadge(summaries, remaining);
    if (!this.view) return;
    const works = this.summarizeWorks(remaining);
    const contradictionMode = this.contradictions.length > 0;
    const updateMode = this.recordUpdates.length > 0;
    const message: IssuesMessage = {
      type: "issues",
      workTitle: this.work?.title ?? "",
      workId: this.work?.id ?? "",
      category: this.category,
      items: updateMode
        ? this.recordUpdates
        : contradictionMode
          ? this.contradictions.map(contradictionForView)
          : this.items.map(forView),
      // 設定資料の更新は、まとめて反映できる（1件ずつだと19話ぶんで手が止まる）
      canApplyAll: !contradictionMode,
      // **1つしか無いときはタブを出さない。** 選ぶものが無いのに
      // 場所だけ取ると、下段の狭い画面がさらに狭くなる
      categories: summaries.length > 1 ? summaries : [],
      // 作品の切り替え口も同じ（1作品なら、これまでと同じ見た目のまま）
      works: works.length > 1 ? works : [],
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
      // 「設定／本文」と決め打ちしない。プロット逸脱を無視したとき
      // 「設定」と記録されてしまう（見出しは leftLabel/rightLabel が正しい）
      suggestion: describeContradiction(item),
    });
  }

  /**
   * その食い違いは矛盾ではなく伏線だった、として台帳へ移す（設計書6.35.4）。
   *
   * **作者が押した時点で承認済みなので、その場で保存してよい。**
   * 検知結果の自動保存は禁じているが、ここは作者の操作そのものである。
   *
   * 保存できてから片付ける。**順序を逆にしない**——先に片付けると、
   * 保存に失敗したときに矛盾も伏線も残らない。
   */
  private async registerForeshadowFor(id: string): Promise<void> {
    const item = this.contradictions.find((entry) => entry.id === id);
    if (!item || !this.work) return;
    if (item.status !== "pending") return;

    if (!this.registerForeshadow) {
      // 押したのに無反応だと「壊れている」としか見えない
      void vscode.window.showWarningMessage(
        "伏線の登録が繋がっていません。矛盾検知をやり直してください。"
      );
      return;
    }

    const work = this.work;
    const outcome = await this.registerForeshadow({
      label: foreshadowLabelOf(item),
      note: describeContradiction(item),
      // ファイル名から話数を読む。読めなければ null のまま（推測で埋めない）
      chapter: parseEpisodeFileName(item.fileName).chapterStart,
      quote: item.excerpt,
    });

    if (!outcome.ok) {
      void vscode.window.showWarningMessage(
        `伏線として登録できませんでした。${outcome.reason ?? ""}`.trim()
      );
      return;
    }

    // 片付いたことは「無視」と同じ状態で表す。**理由だけを分ける**
    item.status = "dismissed";
    item.dismissReason = "伏線として登録しました";
    this.postItems();

    await appendAiActionLog(work, {
      category: "contradiction",
      // **「無視した」とは別に記録する。** あとで一覧を見た作者が、
      // 消えた指摘の行方をたどれるようにする
      action: "foreshadowed",
      file: item.fileName,
      line: item.line,
      target: item.excerpt,
      suggestion: describeContradiction(item),
    });

    void vscode.window.showInformationMessage(
      "伏線として登録しました（伏線の一覧で見られます）。"
    );
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
      case "undo":
        await this.undoIssue(message.id);
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
      case "registerForeshadow":
        await this.registerForeshadowFor(message.id);
        return;
      case "recheck":
        await this.recheckIssue(message.id);
        return;
      case "applyAll":
        await this.applyVisible();
        return;
      case "selectCategory":
        this.switchTo(message.category);
        return;
      case "switchWork":
        this.switchWork(message.workId);
        return;
      case "clearCategory":
        await this.clearCurrentCategory();
        return;
    }
  }

  /** タブを押されたとき。控えへ書き戻してから入れ替える */
  private switchTo(category: string): void {
    if (category === this.category) return;
    if (!this.currentCategories().has(category)) return;
    this.stashCurrent();
    this.activate(category);
  }

  /**
   * いま見ている分類を空にする。
   *
   * **足していく作りなので、片付ける口が要る。** 全部に手を付け終えても、
   * 済んだものは薄くなって残り続ける。**確認してから消す**——見送ったものは
   * ともかく、まだ見ていないものが混じっていることがある。
   */
  private async clearCurrentCategory(): Promise<void> {
    const remaining =
      this.items.filter(isRemaining).length +
      this.contradictions.filter(isRemaining).length +
      this.recordUpdates.filter(isRemaining).length;

    const answer = await vscode.window.showWarningMessage(
      `「${this.category}」の一覧を空にしますか？`,
      {
        modal: true,
        detail:
          remaining > 0
            ? `まだ手を付けていないものが${remaining}件あります。\n本文は書き換わりません（一覧から消えるだけです）。`
            : "本文は書き換わりません（一覧から消えるだけです）。",
      },
      "空にする"
    );
    if (answer !== "空にする") return;

    const entry = this.work ? this.buckets.get(this.work.id) : undefined;
    entry?.categories.delete(this.category);
    this.items = [];
    this.contradictions = [];
    this.recordUpdates = [];
    this.applyRecordUpdate = undefined;
    this.dismissRecordUpdate = undefined;

    // 同じ作品に残っている分類があれば、そちらへ移る
    const next = entry ? [...entry.categories.keys()][0] : undefined;
    if (next) {
      this.activate(next);
      return;
    }

    // **空になった作品は、切り替え口から外す。** 選べるのに何も無い作品が
    // 並んでいると、押してみるまで空だと分からない
    if (entry && this.work) this.buckets.delete(this.work.id);
    const other = [...this.buckets.values()][0];
    if (other) {
      this.work = other.work;
      this.activate(this.categoryToShow(other));
      return;
    }
    this.postItems();
  }

  private async jumpTo(id: string): Promise<void> {
    // 矛盾も同じ「その行へ飛ぶ」を使う。**両方から探す**
    const item: { filePath: string; line: number } | undefined =
      this.items.find((entry) => entry.id === id) ??
      this.contradictions.find((entry) => entry.id === id);
    if (!item) {
      // **押しても何も起きない、を黙って起こさない**（作者の報告、2026-08-29）。
      // 一覧の描き直しと押した瞬間がすれ違うと、ここへ来ることがある
      logLine(`提案パネル：飛び先の指摘が見つかりませんでした（id: ${id}）。`);
      return;
    }

    /*
      **原稿エディタで書いているなら、その画面のまま示す**（作者の依頼、
      2026-08-28）。素のエディタが横に開くと、書いていた面から目を離すことに
      なる。引き受けられなかったとき（素のエディタで書いている・原稿を
      開けなかった）だけ、これまでどおり下の道を通る。
    */
    try {
      if (await this.revealInManuscript?.(item.filePath, item.line)) return;
    } catch (error) {
      // 原稿エディタ側で転んでも、飛べる道は残す（下で素のエディタを開く）。
      // **理由は残す。** 残さないと「押しても何も起きない」で終わる
      logLine(
        `提案パネル：原稿エディタで示せませんでした（${item.filePath} ${
          item.line
        }行目：${error instanceof Error ? error.message : String(error)}）。`
      );
    }

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
    // **設定資料の更新も「まとめて」の対象である。**
    // ここを見ていなかったため、更新の一覧で押しても何も起きなかった
    // （2026-08-19、作者が実機で発見）
    if (this.recordUpdates.length > 0) {
      await this.applyAllRecordUpdates();
      return;
    }

    const pending = this.items.filter((item) => item.status === "pending");
    const targets = pending.filter(
      // **修正案の無い指摘は掴まない**（推敲）。適用しても何も起きない
      (item) => item.confidence !== "low" && Boolean(item.suggestion)
    );

    // **黙って何もしない、をやめる。**
    // 押したのに無反応だと「壊れている」としか見えない
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(
        this.describeNoTarget(pending)
      );
      return;
    }

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

    // **終わったことを伝える。** 何件入って何件入らなかったのかが
    // 分からないと、作者は一覧を上から数え直すことになる
    const applied = targets.filter(
      (item) =>
        this.items.find((entry) => entry.id === item.id)?.status === "applied"
    ).length;
    void vscode.window.showInformationMessage(
      applied === targets.length
        ? `${applied}件を適用しました。`
        : `${applied}/${targets.length}件を適用しました。` +
            "残りは一覧に理由が出ています。"
    );
  }

  /**
   * まとめて適用できるものが無い理由。
   *
   * **「ありません」だけでは、作者は何をすればよいか分からない。**
   * 推敲は修正案の無い指摘が多く、そのときは1件ずつ見るしかない。
   */
  private describeNoTarget(pending: readonly ProposalViewItem[]): string {
    if (pending.length === 0) {
      return "まとめて適用できる指摘がありません（未処理の指摘がありません）。";
    }
    const low = pending.filter((item) => item.confidence === "low").length;
    const noFix = pending.filter((item) => !item.suggestion).length;

    const reasons: string[] = [];
    if (noFix > 0) {
      reasons.push(
        `${noFix}件は修正案がありません（直し方は作者が決めるものです）`
      );
    }
    if (low > 0) reasons.push(`${low}件は確信度が「低」です`);

    return (
      "まとめて適用できる指摘がありません。" +
      (reasons.length > 0 ? reasons.join("。") + "。" : "") +
      "1件ずつご確認ください。"
    );
  }

  /** 設定資料の更新をまとめて反映する */
  private async applyAllRecordUpdates(): Promise<void> {
    const targets = this.recordUpdates.filter(
      (entry) => entry.status === "pending" || entry.status === "failed"
    );
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(
        "反映できる更新がありません。"
      );
      return;
    }
    // **押した結果が何になるかで、確認の言葉も変わる**（設計書6.35.2）。
    // 伏線の候補に「作者が確定させた記述が書き換わります」と出すと、
    // 何が起きるのかを取り違えたまま押させることになる
    const label = targets[0].applyLabel ?? "反映する";
    const confirm = await vscode.window.showWarningMessage(
      `${targets.length}件をまとめて${conjugate(label, "します")}。`,
      {
        modal: true,
        detail:
          (targets[0].applyLabel
            ? ""
            : "作者が確定させた記述が書き換わります。 ") +
          "内容は一覧に出ています。1件ずつ見てから決めることもできます。",
      },
      label
    );
    if (confirm !== label) return;

    for (const target of targets) {
      await this.applyIssue(target.id);
    }
    const applied = this.recordUpdates.filter(
      (entry) => entry.status === "applied"
    ).length;
    void vscode.window.showInformationMessage(
      `${applied}件を${conjugate(label, "しました")}。`
    );
  }

  private async applyIssue(id: string): Promise<void> {
    // 設定資料の更新は、本文ではなくレコードを書き換える
    const update = this.recordUpdates.find((entry) => entry.id === id);
    if (update && this.applyRecordUpdate) {
      if (update.status === "applied") return;
      const outcome = await this.applyRecordUpdate(id);
      this.markStatus(
        id,
        outcome.ok ? "applied" : "failed",
        outcome.ok ? undefined : outcome.reason
      );
      // 承認待ちが1件減ったので、メニューの印を数え直してもらう
      if (outcome.ok) this.onCountsChanged?.();
      return;
    }

    const item = this.items.find((i) => i.id === id);
    if (!item || !this.work) return;
    if (item.status === "applied") return;
    const work = this.work;

    // **編集者モードでは本文を書き換えない。提案として置く**（設計書5.6）。
    // 作者の意向に反して勝手に書き換えられることが、構造として起きない。
    // **競合も起きない。** 編集部が触るのは提案のファイルだけである
    if (isEditorMode()) {
      await this.proposeIssue(item, work);
      return;
    }

    // 編集部が校閲中のファイルは、作者も触らない（設計書5.6）。
    // 触ると、届いた提案が本文と合わなくなる
    if (!(await this.confirmNotLocked(item.filePath, work))) return;

    // **提案は、本文への適用と「採った」の記録が対になる**（設計書5.6）
    if (item.proposalId) {
      const outcome = await acceptProposal(work, {
        id: item.proposalId,
        file: path.relative(work.folderPath, item.filePath),
        line: item.line,
        original: item.original,
        target: item.target,
        suggestion: item.suggestion,
      });
      if (!outcome.ok) {
        this.markStatus(id, "failed", outcome.reason);
        return;
      }
      this.markStatus(id, "applied", "提案を採り入れました。");
      await revertIfOpen(item.filePath);
      return;
    }

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
    // **同期される編集履歴にも残す**（設計書5.6）。
    // ai_actions.log は .gitignore で同期から外れているので、
    // これだけでは作者にも編集部にも互いの操作が見えない。
    // AIの提案を人が承諾して反映したものなので、種別は "ai"
    await recordEdit(work, {
      actor: "ai",
      action: `${this.category}の指摘を反映した`,
      file: item.fileName,
      detail: `${item.line}行 「${item.target}」→「${item.suggestion}」`,
    });
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
   * 適用した直しを、元の語へ戻す（設計書6.8.12）。
   *
   * **適用したあとに気が変わることがある**（作者の指摘、2026-08-21）。
   * 直した箇所を1件ずつ元へ戻せるようにする。
   *
   * ## 適用の鏡像にする
   *
   * 置き換える向きが逆なだけで、**通す安全策は同じ**である。
   *
   * - 書き戻す直前に本文を読み直し、**修正案がその行にまだ実在するか**を確かめる
   * - 読み込み時のハッシュと突き合わせてから書く（外で直されていたら中止）
   * - 文字コードと改行はそのまま保つ
   *
   * **作者が手で直したあとなら、戻さない。** 修正案が見つからなければ
   * それは既に別の文になっているということで、機械が判断してよい話ではない。
   *
   * ## ファイルまるごとは戻さない
   *
   * 回復先（`.novelai-recovery/`）には適用前のファイルが残っているが、
   * **まるごと戻すと、そのあと作者が別の箇所へ書いた分まで消える。**
   * 行の中のその1か所だけを戻す。
   */
  private async undoIssue(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item || !this.work) return;
    if (item.status !== "applied") return;
    const work = this.work;

    // 編集部が校閲中のファイルは、作者も触らない（適用と同じ）
    if (!(await this.confirmNotLocked(item.filePath, work))) return;

    let file;
    try {
      file = await readTextFile(item.filePath);
    } catch {
      this.markStatus(id, "applied", "本文を読み込めませんでした。");
      return;
    }

    const lines = file.text.split("\n");
    const lineIndex = item.line - 1;
    const lineText = lines[lineIndex];

    // **修正案がその行に無ければ、既に別の文になっている。** 触らない
    if (lineText === undefined || !lineText.includes(item.suggestion)) {
      this.markStatus(
        id,
        "applied",
        "この行はそのあと書き換えられているため、戻せませんでした。" +
          "本文を直接お直しください。"
      );
      return;
    }

    const at = lineText.indexOf(item.suggestion);
    lines[lineIndex] =
      lineText.slice(0, at) +
      item.target +
      lineText.slice(at + item.suggestion.length);

    const result = await writeTextFilePreservingFormat(
      item.filePath,
      lines.join("\n"),
      file,
      file.hash
    );
    if (!result.ok) {
      this.markStatus(id, "applied", describeWriteFailure(result));
      return;
    }

    await revertIfOpen(item.filePath);

    // **もう一度適用できる状態に戻す。** 戻したあとで考え直すこともある
    this.markStatus(id, "pending");

    await recordEdit(work, {
      actor: "author",
      action: `${this.category}の反映を戻した`,
      file: item.fileName,
      detail: `${item.line}行 「${item.suggestion}」→「${item.target}」`,
    });
    await appendAiActionLog(work, {
      category: "typo",
      action: "reverted",
      file: item.fileName,
      line: item.line,
      target: item.target,
      suggestion: item.suggestion,
    });
  }

  /**
   * 作者が本文を手で書き直したあと、その指摘が解消したかを確かめる
   * （P-23）。
   *
   * 作者の依頼（2026-08-27）：「なおし方を作者が決める系のものは『再チェック』
   * ボタンを追加してください。なおして解消されたか確認したいです」
   * 「誤字脱字の提案パネルでも、違うそうじゃないという提案がきます。
   * 手書きで書き直して解消したか確認したいです」。
   *
   * ## 安い順に確かめる
   *
   * 1. **引用がまだそのまま在るか**を照合する（無料）。在れば直し忘れである
   * 2. 変わっていたら、該当箇所の前後だけを添えてAIに1問だけ聞く
   *
   * 検知をやり直しても分かるが、あちらは作品まるごとを何十チャンクにも
   * 割って走らせる。**1件のために全部を走らせ直すのは高い。**
   *
   * ## 判定は、この1件にしか及ぼさない
   *
   * 解消と分かっても、片付けるのはこの指摘だけである。**似た指摘まで
   * まとめて消さない**——同じ語でも話ごとに事情が違う。
   *
   * ## 矛盾・プロット逸脱も同じ道を通す
   *
   * 作者の依頼（2026-08-27）：「誤字をなおした後、再確認したい」。
   * 矛盾は描画が別（`ContradictionViewItem`）だが、**確かめることは同じ**
   * なので、渡す形（`RecheckItem`）へ寄せてから1本の処理へ入れる。
   */
  private async recheckIssue(id: string): Promise<void> {
    const item = this.items.find((entry) => entry.id === id);
    if (item) {
      // **編集部からの提案には出さない。** あちらは承認・却下という別の
      // 片付け方を持っており、結果を提案の側へ書き戻す必要もある
      if (item.proposalId) return;
      await this.runRecheck(
        item,
        {
          line: item.line,
          original: item.original,
          target: item.target,
          suggestion: item.suggestion,
          reason: [item.reason, item.detail].filter(Boolean).join("："),
        },
        {
          category: "typo",
          target: item.target,
          suggestion: item.suggestion,
        }
      );
      return;
    }

    const contradiction = this.contradictions.find((entry) => entry.id === id);
    if (!contradiction) return;
    await this.runRecheck(
      contradiction,
      {
        line: contradiction.line,
        // **引用は1つしか無い。** 矛盾は「行の中のこの語」ではなく
        // 「この場面がこう書かれている」という指摘なので、抜粋がそのまま
        // 問題とされた範囲でもある
        original: contradiction.excerpt,
        target: contradiction.excerpt,
        // **置き換える案が無い。** どちらが正しいかは作者にしか決められない
        suggestion: "",
        reason: describeContradiction(contradiction),
      },
      {
        category: "contradiction",
        target: contradiction.excerpt,
        suggestion: describeContradiction(contradiction),
      }
    );
  }

  /**
   * 1件を確かめる本体（誤字脱字・推敲・表記ゆれ・矛盾・プロット逸脱で共通）。
   *
   * @param target 画面の状態を書き換える先（指摘そのもの）
   * @param item AIへ渡す形。指摘の種類ごとの組み立ては呼び出し側で済ませる
   * @param log 作業記録へ残す中身
   */
  private async runRecheck(
    target: RecheckTarget,
    item: RecheckItem,
    log: {
      category: "typo" | "contradiction";
      target: string;
      suggestion: string;
    }
  ): Promise<void> {
    if (!this.work) return;
    // 二重に押されても、1回だけ走らせる
    if (target.busy) return;
    const work = this.work;
    // **作品と分類は、押された時点のものを覚えておく。** AIの答えを待つ間に
    // 作者がタブや作品を切り替えることがあり、`this` を見に行くと
    // 別の分類の名前でAIに問い合わせることになる
    const category = this.category;

    // プロンプトは分類共通の1本だが、**割当はいま見ている指摘の分類に従う**。
    // 誤字脱字を無料AIに割り当てた作者が、誤字の再チェックだけ矛盾検知の
    // （有料の）AIで動いては驚く。`log.category` は "typo" | "contradiction" で、
    // そのまま割当のキーになる
    const resolved = this.ai?.resolve(log.category);
    if (!resolved) {
      void vscode.window.showWarningMessage(
        "AIが設定されていません。詳細メニューの「AIの設定」から設定してください。"
      );
      return;
    }

    // **プロバイダとモデルの組で覚える。** 同じモデル名を持つ別のAIへ
    // 割当が変わったとき、モデル名だけでは切り替わりを見落とす
    const paidKey = `${resolved.provider.id}:${resolved.model}`;
    if (resolved.provider.isPaid && this.paidConfirmedFor !== paidKey) {
      const ok = await confirmPaidUsage(resolved.provider, {
        actionLabel: "指摘の再チェック",
        model: resolved.model,
        calls: 1,
        detail:
          "本文が書き直されていれば、その1件についてAIへ1回だけ問い合わせます。\n" +
          "書き直されていなければ、AIは呼びません。\n" +
          "（この確認は、このパネルで一度だけです）",
      });
      if (!ok) return;
      this.paidConfirmedFor = paidKey;
    }

    this.setBusy(target, true);
    try {
      let file;
      try {
        file = await readTextFile(target.filePath);
      } catch {
        this.noteRecheck(target, "本文を読み込めませんでした。");
        return;
      }

      const outcome = await recheckProposal({
        provider: resolved.provider,
        model: resolved.model,
        workFolder: work.folderPath,
        category,
        fileName: target.fileName,
        content: file.text,
        item,
      });
      await this.applyRecheckOutcome(target, outcome, work, log);
    } finally {
      // **必ず戻す。** 途中で失敗しても、押せないままの行を残さない
      this.setBusy(target, false);
    }
  }

  /** 再チェックの結果を、画面と記録へ反映する */
  private async applyRecheckOutcome(
    target: RecheckTarget,
    outcome: RecheckOutcome,
    work: WorkEntry,
    log: {
      category: "typo" | "contradiction";
      target: string;
      suggestion: string;
    }
  ): Promise<void> {
    const note = describeRecheckNote(outcome);

    if (outcome.kind === "unchanged") {
      // ここに来るのは、AIを呼ばずに済んだ場合である（引用がそのまま残って
      // いた）。**直し忘れは、その場で分かるのがいちばん役に立つ**
      this.noteRecheck(target, note);
      void vscode.window.showInformationMessage(
        `${target.fileName} ${target.line}行目は、まだ書き直されていません。`
      );
      return;
    }

    if (outcome.kind === "failed") {
      // **指摘は残す。** 通信の失敗や応答の崩れで、本物の指摘を消さない
      this.noteRecheck(target, note);
      logFailure("指摘の再チェック", {
        ファイル: target.fileName,
        行: String(target.line),
        詳細: outcome.detail ?? outcome.reason,
      });
      void vscode.window.showWarningMessage(
        `再チェックできませんでした：${outcome.reason}`
      );
      return;
    }

    if (outcome.kind === "unresolved") {
      this.noteRecheck(target, note);
      return;
    }

    // 解消。**一覧から外すのはこの1件だけ**で、本文には何も書かない
    target.status = "resolved";
    target.recheckNote = note;
    this.postItems();
    void vscode.window.showInformationMessage(
      `解消を確認しました（${target.fileName} ${target.line}行目）。` +
        "一覧から外します。"
    );
    await appendAiActionLog(work, {
      category: log.category,
      action: "resolved",
      file: target.fileName,
      line: target.line,
      target: log.target,
      suggestion: log.suggestion,
    });
  }

  /** 再チェックの結果を書き添える（状態は変えない） */
  private noteRecheck(target: RecheckTarget, note: string): void {
    target.recheckNote = note;
    this.postItems();
  }

  /** 再チェック中かどうかを画面へ伝える */
  private setBusy(target: RecheckTarget, busy: boolean): void {
    target.busy = busy;
    this.postItems();
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

    await recordEdit(work, {
      actor: manualActor(),
      action: "「直さない語」に登録した",
      file: item.fileName,
      detail: item.target,
    });
    await this.dismissIssue(id);
  }

  /**
   * 本文を書き換えず、提案として置く（編集者モード）。
   *
   * **作者に届くのは「こう直したい」という申し出だけ。**
   * 採るかどうかは作者が決める。
   */
  private async proposeIssue(
    item: ProposalViewItem,
    work: WorkEntry
  ): Promise<void> {
    // 区切り文字と大文字小文字を揃える（ロックの照合と同じ規則を使う）
    const relative = normalizeFile(
      path.relative(work.folderPath, item.filePath)
    );
    const proposer = (await tryGitUserName(work.folderPath)) ?? "";

    try {
      await new ProposalStore(work).propose([
        {
          id: proposalId(relative, item.line, item.target, item.suggestion),
          time: new Date().toISOString(),
          proposer,
          file: relative,
          line: item.line,
          original: item.original,
          target: item.target,
          suggestion: item.suggestion,
          reason: item.reason,
          category: this.category,
        },
      ]);
    } catch (error) {
      this.markStatus(
        id2(item),
        "failed",
        `提案を書き出せませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    this.markStatus(id2(item), "applied", "提案として作者へ送りました。");
    await recordEdit(work, {
      actor: "editor",
      action: `${this.category}の直しを提案した`,
      file: path.basename(item.filePath),
      detail: `${item.line}行 「${item.target}」→「${item.suggestion}」`,
    });
  }

  /**
   * 編集部が校閲中でないかを確かめる。
   *
   * **作者は自分の判断で進められる。** 止めるのではなく、
   * 誰がいつから見ているかを伝えて選ばせる。
   */
  private async confirmNotLocked(
    filePath: string,
    work: WorkEntry
  ): Promise<boolean> {
    const relative = normalizeFile(path.relative(work.folderPath, filePath));
    const lock = await new FileLockStore(work).lockFor(relative);
    if (!lock || lock.holderKind !== "editor") return true;

    const answer = await vscode.window.showWarningMessage(
      `${path.basename(filePath)} は校閲中です。`,
      { modal: true, detail: describeLock(lock) },
      "それでも直す"
    );
    return answer === "それでも直す";
  }

  private async dismissIssue(id: string): Promise<void> {
    const contradiction = this.contradictions.find((entry) => entry.id === id);
    if (contradiction && this.work) {
      await this.dismissContradiction(contradiction, this.work);
      return;
    }

    // 設定資料の更新。**ここを探さず素通りしていた**ため、「見送る」が
    // 押しても黙って何も起きなかった（作者の報告、2026-08-28）。
    // 見送り＝承認待ちから片付けるので、反映と同じく呼び出し側の処理を通す
    const update = this.recordUpdates.find((entry) => entry.id === id);
    if (update) {
      if (update.status !== "pending" && update.status !== "failed") return;
      if (!this.dismissRecordUpdate) {
        this.markStatus(id, "failed", "見送りの処理が繋がっていません。");
        return;
      }
      const outcome = await this.dismissRecordUpdate(id);
      this.markStatus(
        id,
        outcome.ok ? "dismissed" : "failed",
        outcome.ok ? undefined : outcome.reason
      );
      // 承認待ちが1件減ったので、メニューの印を数え直してもらう
      if (outcome.ok) this.onCountsChanged?.();
      return;
    }

    const item = this.items.find((i) => i.id === id);
    if (!item || !this.work) return;
    const work = this.work;

    if (item.proposalId) {
      // **提案を見送ったことは、編集部にも伝わる必要がある**
      await rejectProposal(work, item.proposalId, item.fileName);
      this.markStatus(id, "dismissed");
      return;
    }
    await new TypoDismissedHistory(work).add([
      dismissKey(item.filePath, item),
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
    /**
     * **再チェックの `"resolved"` はここを通さない。** 設定資料の更新には
     * 無い印なので、両方へ書ける印だけを受け取る（`resolved` は
     * `applyRecheckOutcome` が直に立てる）。
     */
    status: RecordUpdateViewItem["status"],
    detail?: string
  ): void {
    // 本文の指摘・設定資料の更新のどちらでも印を付けられるようにする
    const item =
      this.items.find((i) => i.id === id) ??
      this.recordUpdates.find((entry) => entry.id === id);
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
    (doc) => sameFilePath(fromUri(doc.uri), filePath) && !doc.isDirty
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

/** 表示上の番号。提案の処理では item から引き直す */
function id2(item: ProposalViewItem): string {
  return item.id;
}

/**
 * ボタンの言葉を、文の中で使える形にする。
 *
 * 「登録」「反映する」「回収済みにする」が混ざるので、**文の側で活用させる。**
 * ボタンの言葉をそのまま文へ埋めると「反映するました」になる。
 */
export function conjugate(label: string, tail: "します" | "しました"): string {
  return label.endsWith("する") ? label.slice(0, -2) + tail : label + tail;
}

/**
 * 再チェックした時刻（HH:mm）。
 *
 * **いつ確かめたのかが要る。** 作者は本文を何度も直すので、時刻が無いと
 * 補足に出ている結果が「さっき直す前のもの」なのか分からない。
 * 日付までは出さない——同じ日に何度も押す使い方が前提である。
 */
function clockLabel(now = new Date()): string {
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * 再チェックの結果を、補足に添える一文へ変える（P-23）。
 *
 * **誤字脱字も矛盾も、同じ言い方にする。** 指摘の種類ごとに文を書き分けると、
 * 言い回しを直したときに片方だけが直る。
 */
function describeRecheckNote(
  outcome: RecheckOutcome,
  at = clockLabel()
): string {
  switch (outcome.kind) {
    case "unchanged":
      return `再チェック（${at}）：本文がまだ変わっていません（同じ文のままです）。`;
    case "failed":
      return `再チェック（${at}）：${outcome.reason}`;
    case "unresolved":
      return `再チェック（${at}）：まだ当てはまります。${outcome.reason}`.trim();
    case "resolved":
      return `再チェック（${at}）：解消を確認しました。${outcome.reason}`.trim();
  }
}

/**
 * 矛盾・プロット逸脱の中身を、1つの文にまとめる（再チェックでAIへ渡す）。
 *
 * **見出しは持ち回りのものを使う。** 矛盾は「設定では／本文では」、
 * プロット逸脱は「プロットでは／この話では」で言葉が違う。ここを決め打ちに
 * すると、逸脱の指摘が「設定では」と読める文でAIへ届く。
 *
 * 補足（逸脱の行範囲など）は、あれば後ろへ添える。
 */
function describeContradiction(item: ContradictionViewItem): string {
  const compared = `${item.leftLabel}：${item.settingSays}／${item.rightLabel}：${item.textSays}`;
  return item.note ? `${compared}（補足：${item.note}）` : compared;
}

/** 伏線の短い名に使う長さ。一覧の見出しになるので、長いと折り返す */
const FORESHADOW_LABEL_MAX = 20;

/**
 * 矛盾の1件から、伏線の短い名を決める（設計書6.35.4）。
 *
 * **本文の側を採る。** 伏線になりうるのは「設定と違うことが書かれている」
 * その記述のほうであって、設定に書いてある値ではない。
 * 本文の側が空なら引用へ落ちる（引用は検証済みで必ず入っている）。
 */
function foreshadowLabelOf(item: ContradictionViewItem): string {
  const source = item.textSays.trim() || item.excerpt.trim();
  if (!source) return "矛盾から登録した伏線";
  return source.length > FORESHADOW_LABEL_MAX
    ? `${source.slice(0, FORESHADOW_LABEL_MAX)}…`
    : source;
}

/**
 * 「なぜ読みにくいか」の一文を決める。
 *
 * **AIの説明を優先し、使えなければ種類ごとの決まり文句へ落ちる。**
 * 「空文字」「なし」のような、指示の言葉がそのまま返ってくる形は
 * この作品で繰り返し起きている（`CLAUDE.md`）ので、種類の一語を
 * なぞっただけのものも使えないものとして扱う。
 */
function proposalDetail(issue: {
  reason: string;
  explanation?: string;
}): string | undefined {
  const written = issue.explanation?.trim();
  if (written && written !== issue.reason && !PLACEHOLDER.test(written)) {
    return written;
  }
  return explainProofreadReason(issue.reason);
}

/** 中身の無い言い方。これが来たら説明として扱わない */
const PLACEHOLDER = /^(なし|無し|空文字|特になし|説明)$/;

// 「まだ手を付けていないか」の判定は `core/proposalBuckets.ts` にある
// （分類ごとの件数を数えるのにも使うため、VS Codeに依らない側へ置いた）

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
