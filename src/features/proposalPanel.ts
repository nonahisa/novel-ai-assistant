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
} from "../core/proposalBuckets";

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
 * 画面へ送る直前に、違うところを計算して添える。
 *
 * **修正案の無い指摘がある**（推敲の「長すぎる文」など）。そのときは
 * 比べる相手がいないので、何も添えない。
 */
function withDiff(item: ProposalViewItem): ProposalViewItem {
  if (!item.suggestion) return item;
  return { ...item, diff: diffChars(item.target, item.suggestion) };
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
  status: "pending" | "applied" | "failed" | "dismissed";
  statusDetail?: string;
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
}

type OutgoingMessage = {
  type: "issues";
  workTitle: string;
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
};

type IncomingMessage =
  | { type: "jump"; id: string }
  | { type: "apply"; id: string }
  | { type: "undo"; id: string }
  | { type: "dismiss"; id: string }
  | { type: "keepWord"; id: string }
  | { type: "openSettings"; id: string }
  | { type: "applyAll" }
  /** 別の分類へ切り替える */
  | { type: "selectCategory"; category: string }
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
}

function emptyBucket(): CategoryBucket {
  return { items: [], contradictions: [], recordUpdates: [] };
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
  private category = "誤字脱字";
  /**
   * 分類ごとの置き場（設計書6.11.3）。
   *
   * **上の4つは「いま出している分」で、こちらが控えである。**
   * 既存の処理はすべて `this.items` などを直に触るので、切り替えのたびに
   * 入れ替える形にした。配列そのものを共有しているため、1件を適用した
   * ときの状態の変化は、控えの側にもそのまま残る。
   *
   * `Map` は入れた順を保つので、タブの並びは**走らせた順**になる。
   */
  private buckets = new Map<string, CategoryBucket>();

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
    }
  ): void {
    // **作品が変われば、前の作品の指摘は意味を持たない。**
    // ファイルの場所ごと違うので、残しても開けない。
    // **控えだけでなく、いま出している分も落とす**——落とさないと、
    // すぐ下の `stashCurrent()` が前の作品の指摘を控えへ戻してしまう
    if (this.work && this.work.id !== work.id) {
      this.buckets.clear();
      this.items = [];
      this.contradictions = [];
      this.recordUpdates = [];
      this.applyRecordUpdate = undefined;
    }
    this.work = work;

    this.stashCurrent();
    const bucket = this.buckets.get(category) ?? emptyBucket();
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
    this.buckets.set(category, bucket);

    this.activate(category);
    // パネルが開いていなければ前面に出す。開いていれば余計なフォーカス移動はしない
    void vscode.commands.executeCommand(`${PROPOSALS_VIEW_ID}.focus`);
  }

  /**
   * いま画面に出している分の状態を、置き場へ書き戻す。
   *
   * **配列は同じものを共有しているが、`applyRecordUpdate` は別**なので、
   * ここで揃える。切り替えのたびに必ず通す。
   */
  private stashCurrent(): void {
    if (this.items.length === 0 &&
        this.contradictions.length === 0 &&
        this.recordUpdates.length === 0 &&
        !this.buckets.has(this.category)) {
      return;
    }
    this.buckets.set(this.category, {
      items: this.items,
      contradictions: this.contradictions,
      recordUpdates: this.recordUpdates,
      applyRecordUpdate: this.applyRecordUpdate,
    });
  }

  /** その分類を画面に出す */
  private activate(category: string): void {
    const bucket = this.buckets.get(category) ?? emptyBucket();
    this.category = category;
    this.items = bucket.items;
    this.contradictions = bucket.contradictions;
    this.recordUpdates = bucket.recordUpdates;
    this.applyRecordUpdate = bucket.applyRecordUpdate;
    this.postItems();
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
  showContradictions(work: WorkEntry, issues: ContradictionIssue[]): void {
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
      leftLabel: "設定では",
      rightLabel: "本文では",
      openTarget: "settings",
    }));
    this.replaceContents(work, "矛盾", { contradictions });
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
    apply: (id: string) => Promise<{ ok: boolean; reason?: string }>
  ): void {
    this.replaceContents(work, "設定資料の更新", {
      recordUpdates: items,
      applyRecordUpdate: apply,
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
    const seen = new Set([...this.buckets.keys(), this.category]);
    for (const name of seen) {
      const bucket =
        name === this.category
          ? {
              items: this.items,
              contradictions: this.contradictions,
              recordUpdates: this.recordUpdates,
            }
          : (this.buckets.get(name) ?? emptyBucket());
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

  private updateBadge(summaries: readonly CategorySummary[]): void {
    if (!this.view) return;
    const remaining = summaries.reduce(
      (total, summary) => total + summary.remaining,
      0
    );

    this.view.badge =
      remaining > 0
        ? { value: remaining, tooltip: describeBadgeTooltip(summaries) }
        : undefined;
  }

  private postItems(): void {
    const summaries = summarizeCategories(
      this.countByCategory(),
      this.category
    );
    this.updateBadge(summaries);
    if (!this.view) return;
    const contradictionMode = this.contradictions.length > 0;
    const updateMode = this.recordUpdates.length > 0;
    const message: OutgoingMessage = {
      type: "issues",
      workTitle: this.work?.title ?? "",
      category: this.category,
      items: updateMode
        ? this.recordUpdates
        : contradictionMode
          ? this.contradictions
          : this.items.map(withDiff),
      // 設定資料の更新は、まとめて反映できる（1件ずつだと19話ぶんで手が止まる）
      canApplyAll: !contradictionMode,
      // **1つしか無いときはタブを出さない。** 選ぶものが無いのに
      // 場所だけ取ると、下段の狭い画面がさらに狭くなる
      categories: summaries.length > 1 ? summaries : [],
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
      case "applyAll":
        await this.applyVisible();
        return;
      case "selectCategory":
        this.switchTo(message.category);
        return;
      case "clearCategory":
        await this.clearCurrentCategory();
        return;
    }
  }

  /** タブを押されたとき。控えへ書き戻してから入れ替える */
  private switchTo(category: string): void {
    if (category === this.category) return;
    if (!this.buckets.has(category)) return;
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

    this.buckets.delete(this.category);
    // 残っている分類があれば、そちらへ移る。無ければ空のまま出す
    const next = [...this.buckets.keys()][0];
    this.items = [];
    this.contradictions = [];
    this.recordUpdates = [];
    this.applyRecordUpdate = undefined;
    if (next) {
      this.activate(next);
      return;
    }
    this.postItems();
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
    const confirm = await vscode.window.showWarningMessage(
      `${targets.length}件の更新をまとめて反映します。`,
      {
        modal: true,
        detail:
          "作者が確定させた記述が書き換わります。 " +
          "内容は一覧に出ています。1件ずつ見てから決めることもできます。",
      },
      "反映する"
    );
    if (confirm !== "反映する") return;

    for (const target of targets) {
      await this.applyIssue(target.id);
    }
    const applied = this.recordUpdates.filter(
      (entry) => entry.status === "applied"
    ).length;
    void vscode.window.showInformationMessage(`${applied}件を反映しました。`);
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
    status: ProposalViewItem["status"],
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
