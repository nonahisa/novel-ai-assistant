import * as vscode from "vscode";
import {
  describeCurrentFont,
  listChoices,
} from "../core/manuscriptFonts";
import { markFontFor } from "../core/markFont";
import { cancelItem, isCancelItem } from "../views/dialogs";
import * as paths from "../core/paths";
import { fromUri } from "../core/paths";
import { scanWork } from "../core/scanner";
import { pathExists } from "../core/fileSystem";
import { nextEpisodeFileNameLike } from "../core/episodeRenumber";
import {
  isBlankEpisode,
  isBlankText,
  planLatestEpisode,
  findLatestEpisode,
} from "../core/latestEpisode";
import { buildManuscriptEditorHtml } from "../views/manuscriptEditorHtml";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
  manuscriptViewTypeFor,
} from "../core/manuscriptViewTypes";
import {
  existingManuscriptTab,
  manuscriptLedgerKey,
  manuscriptTabColumns,
  openManuscriptFile,
  revealManuscriptPanelInPlace,
} from "./manuscriptTab";
import {
  collectTermSpans,
  notationModeFor,
  renderTermMarks,
} from "../core/manuscriptRender";
import {
  resolveInitialAppearance,
  settleCarriedAppearance,
  takeCarriedAppearance,
} from "../core/manuscriptAppearance";
import type {
  ManuscriptAppearance,
  SavedAppearance,
} from "../core/manuscriptAppearance";
import { isNoteStyleTarget } from "../core/noteStyle";
import { renderNotePreview } from "../core/notePreview";
import { readWorkFormat } from "../core/workFormatStore";
import { readWorkKind } from "../core/workKindStore";
import type { WorkKindKey } from "../core/workKind";
import { measureKindText } from "../core/kindMeasure";
import { TERM_COLORS } from "../core/termColors";
import {
  computeDocumentEdit,
  fromLfOffset,
  toLf,
  toLfOffset,
} from "../core/eolSpace";
import {
  applySentEdit,
  combineSentEdits,
  createEditQueue,
  type ApplyOutcome,
  type EditAck,
  type SentEdit,
} from "../core/editQueue";
import {
  createScreenEditLedger,
  textFingerprint,
  type ScreenEditLedger,
} from "../core/screenEditRebase";
import {
  SAVE_APPLY_WAIT_MS,
  createAppliedTracker,
  describeSaveResult,
  runSaveRequest,
  type AppliedTracker,
} from "../core/manuscriptSave";
import { createBurstGate } from "../core/burstGate";
import { KeyedLedger } from "../core/keyedLedger";
import {
  currentCountMode,
  excludeRubyFromCount,
  pickCount,
} from "../core/countSettings";
import { countEpisodeChars } from "../core/episodeCharCount";
import {
  collectedEpisodeStarts,
  planCollectedStep,
} from "../core/collectedFile";
import {
  findRubyAt,
  rubyEditReplacement,
  rubyNotationFor,
  validateEmphasis,
  findEmphasisSpans,
  validateRuby,
} from "../core/ruby";
import { postingCopySource } from "../core/episodeCopy";
// 合本の見出しの作り方は1か所に置く（写しを作らない）
import { collectedEpisodeLabel } from "./pickCollectedEpisode";
// 貼り付け先ごとの分岐は、入口ではなく変換の側に置く（設計書6.84）
import { convertForPosting } from "../core/postingConvert";
import { showPostingCopyNotice } from "./postingCopyNotice";
// 開く列の決め方は素のエディタと1本にする（`editorColumn.ts`）
import { columnForLocation } from "./editorColumn";
import {
  MEMO_LINE_PREFIX,
  memoColorVars,
  memoLineRemoval,
  memoLineRestorePoint,
  type RemovedMemoLine,
} from "../core/sceneMemo";
import { READ_ALOUD_MEMO_TEXT, buildReadingPlan } from "../core/readAloud";
import { pickPostingTarget } from "./ruby";
import { registeredPostingSites } from "./postingCopyRegistered";
import { copyEmphasisFor } from "../core/postingCopyTargets";
import { askText } from "../views/dialogs";
import { logLine, useLogFile } from "../core/logger";
import { readTextFile } from "../core/textFile";
import type { TermHighlighter } from "../views/termHighlight";
import type { TermKind } from "../core/termIndex";
import type { EpisodeFile, WorkEntry, WorkStats } from "../models/types";
import {
  describeMarkdownSuggestion,
  shouldSuggestMarkdown,
} from "../core/markdownConversion";
import { auditEol, describeEolMismatch } from "../core/eolAudit";
import { countSiteNotation } from "../core/ruby";
import { notifyDone, suggestAction } from "../views/notify";
import {
  buildManuscriptEditorsCard,
  manuscriptLocation,
  parseManuscriptStatusMessage,
  type ManuscriptEditorsCard,
  type ManuscriptStatusReport,
  type ManuscriptTabSnapshot,
} from "../core/manuscriptEditorStatus";
import {
  MANUSCRIPT_RESOLVE_GRACE_MS,
  confirmDisconnectedTabs,
  sameManuscriptFaceNote,
  unresolvedActiveTabs,
  type ManuscriptTabLook,
} from "../core/manuscriptDisconnect";

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

/*
  入口のIDは `core/manuscriptViewTypes.ts` にある。**作品一覧も同じIDを使う**
  （本文は横書きの原稿エディタで開く）ので、views から features を引かずに
  済むよう外へ出した。ここからは、これまでどおりの名前で再輸出する。
*/
export {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  MANUSCRIPT_EDITOR_VIEW_TYPE,
};

/*
  台帳の鍵と、原稿を開く共通の口は `manuscriptTab.ts` にある（2026-10-03。
  作品一覧・統計・第1話の作成など、この大きなファイルを取り込まない所からも
  同じ口を通すため）。鍵はこれまでどおりの名前で再輸出する。
*/
export { manuscriptLedgerKey };

/**
 * いま開いている原稿エディタ（原稿の場所 → その画面）。
 *
 * **入口ごとの provider ではなく、ここ1つに集める。** 縦書きと横書きで
 * `ManuscriptEditorProvider` の実体は2つあり、片方だけが台帳を持つと
 * 「横書きで開いていた原稿へは飛べない」という取りこぼしが出る。
 *
 * **同じ原稿に面がいくつあっても、全部を載せておく**（作者の報告、2026-10-03。
 * 設計書6.25.11）。縦と横の入口で1枚ずつ、または別の列にもう1枚開くと、
 * VS Code は同じ文書の面をもう1つ作る（`supportsMultipleEditorsPerDocument:
 * false` でも止まらない。1.138.0 で確かめた）。以前は `Map<鍵, 面>` で、
 * **2枚目が1枚目を上書きし、2枚目を閉じると鍵ごと消えた**——1枚目はまだ
 * 開いているのに台帳に無く、飛ぶ道がもう1枚開いていた。
 * 引くときは、前面・見えている面・最後に使った面の順に選ぶ。
 */
const openManuscripts = new KeyedLedger<OpenManuscript>((entry) => {
  try {
    return entry.panel.active ? 2 : entry.panel.visible ? 1 : 0;
  } catch {
    // 閉じかけの面は読めないことがある。いちばん後ろに回す
    return -1;
  }
});

/** 行へ飛んだときのカーソルの置き場（行の頭か、末尾か） */
export type RevealCaret = "head" | "end";

/** 台帳に載せる、開いている原稿エディター1枚ぶん */
interface OpenManuscript {
  panel: vscode.WebviewPanel;
  /**
   * その行を示す。
   *
   * **画面が動き出す前に頼まれることがある**（開いた直後に飛んでくる）。
   * まだ `ready` が来ていなければ覚えておき、来たときに出す。
   * 送っても捨てられるだけなので、待つほかにやりようがない。
   *
   * **画面は行を選ばず、カーソルを置いて行をしばらく光らせる**（作者の裁定、
   * 2026-10-03。設計書6.25.11）。`caret` は置き場で、既定は行の頭。
   * メモの行を足した直後だけ "end"（印のあとから打ち始める）。
   */
  revealLine(line: number, caret?: RevealCaret): void;
  /**
   * 下段の字数を測り直す（作者の指示、2026-08-29）。
   *
   * **保存のあと、執筆量を記録し終えてから呼ぶ**（`extension.ts`）。
   * 保存の知らせを自分で拾うと、記録より先に読むことがあり、
   * 「今日 +◯字」が1回分ずつ古くなる。
   */
  refreshCounts(): void;
  /**
   * 作品の種類を読み直し、下段の字数と目安を送り直す（2026-09-25）。
   *
   * 種類を変えても、開いている画面は開いたときの種類で目安を測り続け、
   * エッセイに変えた直後に「読了 約N分」が出なかった。**組み方（縦横・
   * 台本の組み分け）は変えない**——組み直すには画面を開き直す必要があり、
   * 種類を変えたときの知らせもそう案内している。
   */
  refreshKind(): Promise<void>;
  /**
   * 読み上げの列を出す（設計書6.42）。
   *
   * **`revealLine` と同じで、`ready` を待ってから送る。** 開いた直後の
   * 画面へ送っても、まだスクリプトが走っていないので捨てられる。
   * 詳細メニューの「原稿を読み上げる」は開くのと同時に頼むので、
   * ここを待たないと**開いたのに列が出ない**。
   */
  showReading(): void;
  /**
   * この画面が持っている文書（設計書6.40.4）。
   *
   * シーンメモの「済みにする」が、**打ちかけのまま開いている原稿**を
   * 書き換えるために要る。ディスクを直に書くと、開いている面の
   * （まだ保存していない）本文が勝った瞬間に消える。
   */
  document: vscode.TextDocument;
  /**
   * この画面がいま使っている見た目（設計書6.25.5）。
   *
   * 前後の話へ移るときに、そのまま次の画面へ持って行く。**画面が
   * 知らせてくるまでは `undefined`**（開いた直後の一瞬だけ）。
   */
  appearance(): ManuscriptAppearance | undefined;
  /**
   * 前の話から持って来た見た目を、**この画面へ直に当てる**（設計書6.25.5）。
   *
   * 開くときの見た目は `pendingAppearance` に置き、画面側が立ち上がりに
   * 1回だけ取り出す。**既に生きている画面は取りに来ない**——`openWith` は
   * そのタブを前に出すだけだからである。タブが開いているかどうかで
   * 引き継ぎが効いたり効かなかったりすると、作者には壊れて見える
   * （2026-09-12、9巡目に実機で確認）。
   */
  applyAppearance(next: ManuscriptAppearance): void;
  /**
   * 未送信の状態（窓の札に載せる。作者の裁定、2026-10-01）。
   * 画面からの知らせと、こちらで記録する時刻を持つ。**本文は持たない。**
   */
  status: ManuscriptEditorStatusState;
  /**
   * この画面から届いた便を、文書へ当て終わるまで待つ（設計書5.5.19）。
   *
   * 「すべて同期」が記録の前に保存するとき、**画面にだけある字を残したまま
   * 保存しない**ために使う。［保存］と同じ見張り（`AppliedTracker`）で待つ。
   */
  settle(timeoutMs: number): Promise<ManuscriptSettle>;
}

/** 画面の便を待った結果（`settleOpenManuscripts`） */
export type ManuscriptSettle = "applied" | "rejected" | "timeout" | "unsent";

/** 原稿エディター1つぶんの、窓の札に載せる状態（設計書6.25.9・6.87.17） */
interface ManuscriptEditorStatusState {
  /** 画面から最後に届いた状態（`unsentStatus`）。まだなら undefined */
  report?: ManuscriptStatusReport;
  reportedAt?: Date;
  /** こちらが最後に「入った」（editApplied の ok）と返した時刻 */
  lastAppliedAt?: Date;
  /** この画面から何か届いた最後の時刻 */
  lastHeardAt?: Date;
}

/*
  ── 窓の札へ原稿エディターの状態を載せる（作者の裁定、2026-10-01） ──

  2026-10-01 ノートPCで、拡張機能ホストが起動し直したあと打った約100字が
  原稿に届かず、作者が気づくまで外から分からなかった。画面の知らせは
  作者の目にしか届かないので、MCP の windows.list の札に載せる。

  **札を書き直すきっかけは「変わったとき」だけ**（画面からの状態・開け閉め・
  タブの出入り）。「最後に届いた時刻」と「最後に入った時刻」は打鍵のたびに
  進むが、それでは知らせない——札の門（`windowCardChangeKey`）も時刻を除いて
  比べるので、何か別の理由で書くときと5分ごとの打ち直しに一緒に載る。
*/

/** 原稿エディターのどれかから最後に何か届いた時刻（閉じた画面のぶんも残す） */
let lastHeardFromAnyManuscript: Date | undefined;
const statusListeners = new Set<() => void>();

function fireManuscriptStatusChanged(): void {
  for (const listener of [...statusListeners]) {
    try {
      listener();
    } catch {
      // 札を書く側の失敗で、原稿エディターを止めない
    }
  }
}

/**
 * 原稿エディターの状態が変わったとき（窓の札を書き直す合図）。
 * `vscode.Event<void>` と同じ形で渡せる。
 */
export function onDidChangeManuscriptStatus(listener: () => void): vscode.Disposable {
  statusListeners.add(listener);
  return { dispose: () => void statusListeners.delete(listener) };
}

/**
 * タブの出入りを見張る（受け持っていない原稿エディターを札に書くため）。
 *
 * **拡張機能ホストが起動し直すと、生きている画面に `resolveCustomTextEditor` が
 * 呼ばれ直さない**ので、新しいホストはタブの一覧からしか、その画面があることを
 * 知れない。タブの切り替えでも知らせは来るが、札の門が中身の変わらない書き込みを
 * 止める。
 */
export function watchManuscriptTabs(): vscode.Disposable {
  try {
    return vscode.window.tabGroups.onDidChangeTabs(() =>
      fireManuscriptStatusChanged()
    );
  } catch {
    // タブを読めない環境（古いVS Code・試験の代役）では見張らない
    return { dispose: () => undefined };
  }
}

/**
 * この拡張機能ホストで、つながりに来た（`resolveCustomTextEditor` が呼ばれた）
 * 原稿の鍵（`manuscriptLedgerKey`）。縦書き・横書きの入口で共有する。
 *
 * **台帳（`openManuscripts`）とは別に持つ。** 台帳へ載せるのは作品の種類を
 * 引くなどの await のあとなので、つながりに来てから数秒載らないことがある。
 * 台帳で判定すると、つながっている画面を「切れた」と見てしまう。こちらは
 * `resolveCustomTextEditor` の先頭（最初の await より前）で記録する。
 * 閉じても消さない——閉じたタブは一覧から消えるので判定に出てこない。
 */
const resolvedManuscriptKeys = new Set<string>();

/** 切れた原稿エディターの知らせの、既定のボタン */
const RELOAD_WINDOW_ITEM = "ウィンドウを再読み込み";

/**
 * つながりの切れた原稿エディターを見張り、見つけたら知らせる
 * （作者の裁定、2026-10-02「起動し直したら、開いていた原稿エディターを
 * 開き直す」。設計書6.25.9）。判定の決まりは `core/manuscriptDisconnect.ts`。
 *
 * **起動した直後と、タブが変わるたびに見る。** 背景に回っていた切れた画面は、
 * 作者が前に出したときに初めて見られる（背景のタブは、ふつうに開いた
 * ウィンドウでもまだつながっていないので、見分けられない）。
 *
 * **勧めるのはウィンドウの再読み込み。** 再読み込みなら画面の控え（`setState` の
 * `rescue`）が残り、開き直したときに［戻す］で打った字を取り戻せる。タブを
 * 閉じて開き直すと控えが消えるので、その道は勧めない。
 */
export function watchDisconnectedManuscripts(
  /**
   * 作品の引き方。**記録の書き先を向けるのに使う**——起動し直した直後は書き先が
   * まだどこへも向いておらず、2026-10-03 の実機ではこの知らせの行が出力パネルに
   * しか残らなかった。引けなければ保管庫のログへ書く
   */
  workOf?: (filePath: string) => WorkEntry | undefined
): vscode.Disposable {
  const warned = new Set<string>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const look = (): Array<ManuscriptTabLook & { uri: vscode.Uri }> =>
    manuscriptEditorTabs().map((tab) => ({
      key: manuscriptLedgerKey(tab.uri),
      active: tab.visible,
      uri: tab.uri,
    }));

  const check = (): void => {
    // 見張りの猶予が走っている間は重ねない（タブの知らせは保存のたびにも来る）。
    // 猶予が切れたときに、あとから前に出たタブを見直す
    if (disposed || pending) return;
    const earlier = unresolvedActiveTabs(look(), resolvedManuscriptKeys).filter(
      (key) => !warned.has(key)
    );
    if (earlier.length === 0) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (disposed) return;
      const tabs = look();
      const lost = confirmDisconnectedTabs({
        earlier,
        tabs,
        resolved: resolvedManuscriptKeys,
        warned,
      });
      if (lost.length > 0) {
        for (const key of lost) warned.add(key);
        const names = lost.map((key) => {
          const found = tabs.find((tab) => tab.key === key);
          return found ? paths.basename(fromUri(found.uri)) : key;
        });
        // 書き先を向けてから記録する（作品が引けなければ保管庫へ倒れる）
        const first = tabs.find((tab) => tab.key === lost[0]);
        useLogFile(first ? workOf?.(fromUri(first.uri))?.folderPath : undefined);
        void warnDisconnected(names);
      }
      // 猶予の間に別のタブが前に出ていたら、そちらを見直す
      check();
    }, MANUSCRIPT_RESOLVE_GRACE_MS);
  };

  check();
  let subscription: vscode.Disposable | undefined;
  try {
    subscription = vscode.window.tabGroups.onDidChangeTabs(() => check());
  } catch {
    // タブを読めない環境（古いVS Code・試験の代役）では見張らない
  }
  return {
    dispose: () => {
      disposed = true;
      if (pending) clearTimeout(pending);
      pending = undefined;
      subscription?.dispose();
    },
  };
}

async function warnDisconnected(names: readonly string[]): Promise<void> {
  logLine(
    `原稿エディター：つながりの切れた画面を見つけた（${names.length}件。拡張機能ホストの起動し直しの見込み）`
  );
  /*
    **モーダルにして、再読み込みを既定のボタンにする。** 画面の下の欄の赤字は
    4秒で出るが、作者はそのまま打ち続け、タブを閉じて控えを失うことがある。
    右下の知らせは見落とされやすいので、手を止めてもらう。
  */
  const choice = await vscode.window.showWarningMessage(
    "拡張機能が更新・再起動されたため、開いていた原稿エディターとのつながりが切れました。",
    {
      modal: true,
      detail:
        `対象：${names.join("、")}\n\n` +
        "このままでは、打った字が原稿に入りません。ウィンドウを再読み込みすると、つなぎ直せます。" +
        "届いていなかった字は、開き直したときに［戻す］で取り戻せます。\n\n" +
        "タブは閉じないでください（閉じると、届いていなかった字の控えが消えます）。",
    },
    RELOAD_WINDOW_ITEM
  );
  if (choice === RELOAD_WINDOW_ITEM) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

/** 原稿エディターのタブ（縦書き・横書きの入口のもの）。前に出ているかも添える */
function manuscriptEditorTabs(): Array<{ uri: vscode.Uri; visible: boolean }> {
  try {
    const found: Array<{ uri: vscode.Uri; visible: boolean }> = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input: unknown = tab.input;
        if (
          input instanceof vscode.TabInputCustom &&
          (input.viewType === MANUSCRIPT_EDITOR_VIEW_TYPE ||
            input.viewType === MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE)
        ) {
          found.push({ uri: input.uri, visible: tab.isActive });
        }
      }
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * 窓の札に載せる、原稿エディターの状態（`core/manuscriptEditorStatus.ts`）。
 *
 * - **受け持っている画面**：台帳（`openManuscripts`）にあるもの
 * - **受け持っていない画面**：原稿エディターのタブはあるのに台帳に無いもの。
 *   拡張機能ホストが起動し直したあとの画面か、再読み込みのあとまだ作られて
 *   いない背景のタブ。どちらか見分ける手だてが無いので「状態は不明」と書く
 *
 * @param workOf 作品の引き方（文書の場所を作品からの相対にする）
 */
export function collectManuscriptEditorsCard(
  workOf: (filePath: string) => WorkEntry | undefined
): ManuscriptEditorsCard {
  const where = (uri: vscode.Uri): { work: string | null; location: string } => {
    const filePath = fromUri(uri);
    return manuscriptLocation(filePath, uri.toString(), workOf(filePath));
  };
  const editors = [...openManuscripts.values()].map((entry) => ({
    ...where(entry.document.uri),
    report: entry.status.report,
    reportedAt: entry.status.reportedAt,
    lastAppliedAt: entry.status.lastAppliedAt,
    lastHeardAt: entry.status.lastHeardAt,
  }));
  const tabs: ManuscriptTabSnapshot[] = manuscriptEditorTabs().map((tab) => ({
    key: manuscriptLedgerKey(tab.uri),
    ...where(tab.uri),
    visible: tab.visible,
  }));
  return buildManuscriptEditorsCard({
    editors,
    tabs,
    ownedKeys: openManuscripts.keys(),
    lastHeardAt: lastHeardFromAnyManuscript,
  });
}

/**
 * 次に開く原稿へ持って行く見た目（設計書6.25.5）。
 *
 * 「← 前の話」「次の話 →」で移るときに、**次に開くファイルの場所を
 * キーにして**置く。開いた画面が `ready` のときに1回だけ取り出す。
 *
 * **`openManuscripts` と同じで、provider ごとではなくここ1つに集める。**
 * 縦書きと横書きで `ManuscriptEditorProvider` の実体は2つあり、片方だけが
 * 持つと入口をまたいだときに取りこぼす。
 */
const pendingAppearance = new Map<string, ManuscriptAppearance>();

/**
 * 原稿に入らなかった字の控え（設計書6.25.9）。画面が作り、画面が使う。
 *
 * `baseLength`・`baseHash` は**その本文の元になった文書**（画面に最後に
 * 届いた本文）の字数と指紋。戻すときに今の文書と比べ、控えたあとで原稿が
 * 外で変わっていたら確かめる。指紋の計算は画面側にあり、こちらは運ぶだけ。
 */
export interface ManuscriptRescue {
  docKey: string;
  text: string;
  at: number;
  baseLength: number;
  baseHash: string;
  /** 重なって原稿に入らなかった字の控え（帯の控え）か */
  conflict?: true;
}

/**
 * 画面から届いた控えの形を確かめる。**別の文書の控えは受け取らない**
 * （`docKey` が開いている文書と違えば捨てる）。
 */
export function parseManuscriptRescue(
  value: unknown,
  docKey: string
): ManuscriptRescue | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.docKey !== docKey ||
    typeof record.text !== "string" ||
    typeof record.at !== "number" ||
    typeof record.baseLength !== "number" ||
    typeof record.baseHash !== "string"
  ) {
    return undefined;
  }
  return {
    docKey,
    text: record.text,
    at: record.at,
    baseLength: record.baseLength,
    baseHash: record.baseHash,
    // 重なって入らなかった字の控えか（画面は［戻す］で必ず確かめを挟む）
    ...(record.conflict === true ? { conflict: true } : {}),
  };
}

/** 一度に預かる控えの数の上限（画面から届く値を信用しない） */
const MAX_CARRIED_RESCUES = 20;

/**
 * ［開き直す］で画面から届いた控えをまとめて確かめる（設計書6.25.9）。
 *
 * 控えの置き場は2つ（帯の控え `bands`・未送信の字の控え `rescue`。作者の裁定
 * 2026-10-04）。**両方を預かる**——片方だけ運ぶと、タブを閉じて開き直したときに
 * もう片方が消える。並びは帯→未送信（画面が開いたときに見せる順と同じ）。
 * 形の悪いもの・別の文書のものは捨てる。
 */
export function parseManuscriptRescues(
  bands: unknown,
  rescue: unknown,
  docKey: string
): ManuscriptRescue[] {
  const raw = [...(Array.isArray(bands) ? bands : []), rescue];
  const parsed: ManuscriptRescue[] = [];
  for (const value of raw) {
    const one = parseManuscriptRescue(value, docKey);
    if (one) parsed.push(one);
    if (parsed.length >= MAX_CARRIED_RESCUES) break;
  }
  return parsed;
}

/**
 * ［開き直す］で新しい画面へ持って行く控え（設計書6.25.9）。
 *
 * **文書の場所をキーに置き、開いた画面が `ready` のときに1回だけ取り出す**
 * （`pendingAppearance` と同じ形）。拡張機能の中のメモリにしか置かない——
 * 拡張機能ホストが起き直す場合は、画面の状態（`setState`）のほうが残る。
 */
const pendingRescue = new Map<string, ManuscriptRescue[]>();

/**
 * 原稿エディタで最後にカーソルがあった場所（設計書6.40.4）。
 *
 * シーンメモの「次へ」「戻る」が、どこを起点にするかを決めるために持つ。
 * **原稿エディタは `TextEditor` を持たない**ので、VS Code の
 * `activeTextEditor` からは取れない。
 *
 * **開いている面が閉じても消さない。** 閉じた直後に「次へ」を押したときに、
 * 作品の先頭へ飛ばされるより、さっきまで居た場所の次へ進むほうが自然である。
 */
let lastCaret: { filePath: string; line: number } | undefined;

export function lastManuscriptCaret():
  | { filePath: string; line: number }
  | undefined {
  return lastCaret;
}

/**
 * 最後に前へ出ていた原稿エディターの面（設計書6.25.11。2026-10-04）。
 *
 * **開いていない話へ飛ぶときの向きを決めるのに使う。** 「いま前に出ている
 * タブ」（`activeManuscriptViewType`）だけを見ていると、提案パネルや
 * 校正・メモパネル（右の列）の行を押したときは前にあるのがパネルなので
 * 向きが分からず、縦書きで書いている人の次の話が横書きで開いた
 * （画面の自動テスト `findingJumpVertical.test.ts` で見つかった）。
 *
 * 向き（viewType）ではなく**面そのもの**を持つのは、その面が閉じたあとに
 * 古い向きを引き継がないため（閉じた面の向きは、もう「書いている向き」ではない）。
 */
let lastFrontPanel: vscode.WebviewPanel | undefined;

/**
 * 開いていない話を、どちらの入口（縦・横）で開くか——**作者がいま書いている向き**。
 *
 * 見る面は、前に出ている原稿エディター、無ければ最後に前へ出ていた原稿エディター
 * （その面が閉じていれば無し）。
 *
 * **入口（viewType）ではなく、画面の見た目の向きで決める。** 横書きの入口で開いた
 * 面も、画面の［縦書きにする］や「縦書きで開く」（既にタブがあれば画面の中で
 * 切り替える。6.25.11）で縦書きになる。入口だけを見ると、縦書きで書いている
 * 人の次の話が横書きで開く。見た目をまだ知らせていない面（開いた直後）だけ、
 * 入口で代える。
 *
 * @returns 見る面が無ければ undefined（呼んだ側が作品のタイプで決める）
 */
function writingManuscriptViewType(): string | undefined {
  const fromTab = activeManuscriptViewType();
  const all = openManuscripts.values();
  const reference =
    all.find((open) => {
      try {
        return open.panel.active;
      } catch {
        return false;
      }
    }) ??
    (lastFrontPanel
      ? all.find((open) => open.panel === lastFrontPanel)
      : undefined);
  const vertical = reference?.appearance()?.vertical;
  if (typeof vertical === "boolean") {
    return vertical
      ? MANUSCRIPT_EDITOR_VIEW_TYPE
      : MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE;
  }
  return fromTab ?? reference?.panel.viewType;
}

/**
 * その原稿を開いている画面の、下段の字数を測り直す。
 *
 * 開いていなければ何もしない。呼ぶのは保存を記録し終えたところ1か所だけ。
 */
export function refreshManuscriptCounts(filePath: string): void {
  // 同じ原稿の面が2枚あれば、両方の下段を揃える（片方だけ古い字数にしない）
  for (const open of openManuscripts.all(manuscriptLedgerKey(filePath))) {
    open.refreshCounts();
  }
}

/**
 * 開いている原稿**すべて**の下段を測り直す（2026-09-25）。
 *
 * 保存で目標に届いたときに呼ぶ。下段の一言（「今日の目標に届きました」）は
 * どの話かを見ない（1日・1月の達成は全作品で共有）ので、同じ日なら
 * どの原稿にも出るのが正しい。保存した原稿だけを測り直していたため、
 * **先に開いてあった別の話の画面には一言が出なかった**（ノートPCの
 * 実機確認：第1話には出て第2話には出なかった）。
 *
 * 達成の無い保存では呼ばない。開いている原稿の数だけ作品の合計を
 * 読みに行くので、保存のたびには重い。
 */
export function refreshAllManuscriptCounts(): void {
  for (const open of openManuscripts.values()) open.refreshCounts();
}

/**
 * 開いている原稿エディターのうち、`isTarget` が選んだ原稿の便を当て終わるまで
 * 待ち、**当て終わらなかった面だけ**を返す（設計書5.5.19。作者の裁定 2026-10-04）。
 *
 * 「すべて同期」が記録の前に保存するときに使う。画面は打った字を待たずに
 * 送る（変換中を除く）ので、ふだんは届いた便を当て終えるのを待てば、
 * 画面の字は文書に入っている。**書き込みはここではしない**——保存は
 * 呼び出し側が VS Code の文書の保存（`TextDocument.save()`）で行う。
 *
 * 変換中（確定前）の字は、画面がまだ送っていないので待ちようがない。
 */
export async function settleOpenManuscripts(
  isTarget: (filePath: string) => boolean,
  timeoutMs: number = SAVE_APPLY_WAIT_MS
): Promise<Array<{ filePath: string; result: Exclude<ManuscriptSettle, "applied"> }>> {
  const faces = openManuscripts
    .values()
    .filter((open) => isTarget(fromUri(open.document.uri)));
  const results = await Promise.all(
    faces.map(async (open) => ({
      filePath: fromUri(open.document.uri),
      result: await open.settle(timeoutMs),
    }))
  );
  return results.filter(
    (one): one is { filePath: string; result: Exclude<ManuscriptSettle, "applied"> } =>
      one.result !== "applied"
  );
}

/**
 * 開いている原稿すべてに、作品の種類を読み直させる（2026-09-25）。
 *
 * 種類を変えたあとに呼ぶ。読み直すのは下段の目安だけ（`refreshKind`）。
 * どの作品の原稿かは見分けない——種類は作品ごとに覚えてあり、変えていない
 * 作品の原稿は同じ種類を読み直すだけで、見た目は変わらない。
 */
export async function refreshManuscriptKinds(): Promise<void> {
  await Promise.all(
    [...openManuscripts.values()].map((open) => open.refreshKind())
  );
}

/**
 * 名前が変わる原稿の見た目を、**新しい名前のほうへ持って行く**
 * （0.51.5。0.47.9 の積み残し⑦。設計書6.25.5）。
 *
 * `.txt` を `.md` にすると、**ファイルの名前が変わる**。見た目（縦横・
 * 大きさ・組んで書く）は原稿ごとに画面が覚えている値なので、名前が変われば
 * 覚えていた値の宛先も変わり、**開き直したときに設定の既定へ戻る**。
 * 中身は同じ原稿なのに縦書きが横書きになるので、作者から見れば壊れている。
 *
 * **名前を変える前に呼ぶ。** 変えたあとでは、元の名前の画面はもう閉じている。
 * 開いていなければ何もしない（覚えている値が無いので、持って行くものも無い）。
 */
export function carryAppearanceToRenamed(from: string, to: string): void {
  const now = openManuscripts.get(manuscriptLedgerKey(from))?.appearance();
  if (!now) return;
  pendingAppearance.set(manuscriptLedgerKey(to), now);
}

/**
 * 名前が変わって**無くなったほう**の原稿の面を閉じる（設計書6.12.1）。
 *
 * ## 閉じないと何が起きるか
 *
 * 残った面は、もう無いファイルを指している。作者がそこへ戻って打ち、
 * 保存した瞬間に**消えたはずの `.txt` が復活する**（VS Code は無くなった
 * ファイルへも保存できる）。同じ話が `.txt` と `.md` の2つになり、走査は
 * 両方を話として数え、以後どちらが本物か分からなくなる。
 *
 * ## ここ1つに集める理由（0.75.4）
 *
 * **MD化の促し（6.12.6）だけがこの始末をしていた。** 詳細メニューや
 * 右クリックから変換したときは面が開いたまま残り、同じ危なさが残っていた
 * （0.75.3 の記録）。**入口は3つ、始末は1つ**にする。呼ぶのは変換の
 * 唯一の口（`renamePreservingContent`）で、1件でもフォルダーまるごとでも通る。
 *
 * **未保存なら閉じない。** 打ちかけを巻き添えにするほうが重い
 * （変換の前に保存を通しているので、ここへ来るのは保存できなかった場合だけ）。
 */
export function closeRenamedManuscript(from: string): void {
  // **同じ原稿の面が2枚あれば、両方閉じる**（6.25.11）。1枚でも残すと、
  // そこから保存したときに消えたはずの .txt が復活する
  const faces = openManuscripts.all(manuscriptLedgerKey(from));
  if (faces.length === 0) return;

  const dirty = vscode.workspace.textDocuments.some(
    (document) =>
      document.isDirty && manuscriptLedgerKey(document.uri) === manuscriptLedgerKey(from)
  );
  if (dirty) {
    logLine(
      `原稿エディタ：${from} は未保存のため、面を閉じませんでした（打ちかけを消さない）。`
    );
    return;
  }

  logLine(`原稿エディタ：名前が変わったため ${from} の面を閉じます。`);
  for (const open of faces) open.panel.dispose();
}

/** 「← 前の話」「次の話 →」を押したときに、次に何をするか */
export type NeighborStep =
  /** その添字の話を開く */
  | { kind: "open"; index: number }
  /** 開かずに、この文言だけを伝える */
  | { kind: "notice"; message: string }
  /** 次の話数を作って開く */
  | { kind: "create" };

/**
 * 前後の話をどうするかを決める（設計書6.25.5）。
 *
 * **端に来たときの文言まで、ここが持つ。** 「最初の話です。」と
 * 「最新話です。」は押した結果そのものなので、画面を開かずに確かめられる
 * 形にしておく。ファイルを開く・作るのは呼び出し側の仕事である。
 *
 * @param currentIsBlank いま開いている本文が白紙か。**保存前の中身で見る**
 *   （打ちかけを白紙と数えない）。最終話のときだけ効く
 */
export function planNeighborStep(input: {
  /** いまの話の添字（0始まり） */
  at: number;
  /** 話の総数 */
  count: number;
  direction: "prev" | "next";
  currentIsBlank: boolean;
  /**
   * 最終話の先へ**新しい話を作らない**（Alt+↑／Alt+↓ から来たとき。
   * 作者の裁定、2026-10-02）。キーは手が滑って押しやすく、押しただけで
   * ファイルが1つ増えるのは困る。作るのはボタン（「次の話 →」）だけにする
   */
  noCreate?: boolean;
}): NeighborStep {
  if (input.direction === "prev") {
    if (input.at === 0) return { kind: "notice", message: "最初の話です。" };
    return { kind: "open", index: input.at - 1 };
  }
  if (input.at < input.count - 1) return { kind: "open", index: input.at + 1 };
  // 最終話。白紙なら作らない（「最新話を書く」と同じ考え方。
  // 押すたびに空のファイルが増えるのを避ける）
  if (input.currentIsBlank) return { kind: "notice", message: "最新話です。" };
  if (input.noCreate) return { kind: "notice", message: "最後の話です。" };
  return { kind: "create" };
}

/**
 * カーソル行の**上**に、空の付箋の行を挿す（設計書6.40.3）。
 *
 * **本文の書き換えは `WorkspaceEdit` を通す。** 打ちかけを抱えた文書へ
 * ディスクから書くと、開いている面の内容が勝った瞬間に消える。
 *
 * 中身を先に訊く形にはしない——思いついたことを打つ前に一手挟むことになる。
 *
 * @param line 1始まり。読めない値なら先頭に置く
 * @param options `body` は印のあとに置く中身（省略すると空の付箋）。
 *   `reveal` を false にすると、挿した行へ**飛ばない**——読み上げ中の
 *   「引っかかった」（設計書6.42）は、聞いている最中に画面が動くと困る
 */
export async function insertMemoLineAbove(
  document: vscode.TextDocument,
  line: number,
  options: { body?: string; reveal?: boolean } = {}
): Promise<boolean> {
  const index = Math.min(
    Math.max((Number.isFinite(line) ? line : 1) - 1, 0),
    Math.max(document.lineCount - 1, 0)
  );

  const change = new vscode.WorkspaceEdit();
  change.insert(
    document.uri,
    new vscode.Position(index, 0),
    `${MEMO_LINE_PREFIX}${options.body ?? ""}\n`
  );
  if (!(await vscode.workspace.applyEdit(change))) {
    // **黙って終わらない。** 押しても何も起きないときの手がかりを残す
    logLine(
      `メモ：${fromUri(document.uri)} の ${index + 1}行目に付箋を挿せませんでした。`
    );
    void vscode.window.showWarningMessage(
      "メモの行を挿せませんでした。もう一度お試しください。"
    );
    return false;
  }

  // 挿した行へカーソルを送る（原稿エディタで開いていれば）。
  // **打ち始められる場所に居ないと、付箋を足した意味がない**——行の頭に
  // 置くと打った字が「//」の前に入って印が壊れるので、**末尾**（印のあと）に置く
  if (options.reveal !== false) {
    openManuscripts.get(manuscriptLedgerKey(document.uri))?.revealLine(index + 1, "end");
  }
  return true;
}

/**
 * 原稿エディタが最後に居た場所へ、付箋を挿す（コマンドの受け口）。
 *
 * 原稿エディタで開いていなければ `false`。呼んだ側が、素のエディタで
 * 挿す道へ回る。
 */
export async function addMemoToOpenManuscript(): Promise<boolean> {
  const caret = lastCaret;
  if (!caret) return false;
  const key = manuscriptLedgerKey(caret.filePath);
  const open = openManuscripts.get(key);
  if (!open) return false;
  // 列を渡して前に出す（列なしだと前面の列に2枚目ができる。6.25.11）
  revealManuscriptPanelInPlace(open.panel, key);
  return await insertMemoLineAbove(open.document, caret.line);
}

/**
 * 前面の原稿エディターに、選んでいる語へルビ・傍点を付ける頼みを出させる
 * （傍点のキー Ctrl+Alt+K。設計書6.25.10）。
 *
 * **選んでいる語は画面の中にしかない**（原稿エディターは `TextEditor` を
 * 持たない）ので、こちらでは付けられない。画面へ送り返し、画面がキーの道
 * （選んでいなければ一言出す）を通して、右クリックと同じ頼みを送ってくる。
 *
 * @returns 前面に原稿エディターがあって送れたら true。無ければ呼んだ側が
 *   素のエディターの道へ回る
 */
export function askNotationInActiveManuscript(kind: "ruby" | "emphasis"): boolean {
  for (const open of openManuscripts.values()) {
    let active = false;
    try {
      active = open.panel.active;
    } catch {
      // 閉じかけの面は読めないことがある。飛ばす
      continue;
    }
    if (!active) continue;
    void open.panel.webview.postMessage({ type: "askNotation", kind });
    return true;
  }
  return false;
}

/**
 * 「縦書き表示」（`novelai.openVertical`）で原稿を縦書きにして見せる。
 *
 * その原稿のタブが無ければ、これまでどおり縦書きの入口で開く。
 * **あれば、そのタブを前に出して画面の中で縦書きへ切り替える**
 * （作者の裁定、2026-10-03。設計書6.25.11）。
 */
export async function openManuscriptVertical(uri: vscode.Uri): Promise<void> {
  const key = manuscriptLedgerKey(uri);
  const { reused } = await openManuscriptFile(uri, MANUSCRIPT_EDITOR_VIEW_TYPE);
  if (!reused) return;
  /*
    **既にタブがあった**（横書きの入口で開いている等）。そのタブを前に出した
    だけなので、縦書きは画面の中で切り替える——画面の［縦書きにする］と
    同じ結果になる。縦書きの入口でもう1枚開くと、同じ原稿の2枚目ができる
    （作者の裁定、2026-10-03。設計書6.25.11）。
  */
  const live = await waitFor(() => openManuscripts.get(key));
  const now = live?.appearance();
  if (!live || !now) {
    logLine(
      `原稿エディタ：${fromUri(uri)} のタブを前に出しましたが、画面の見た目を読めなかったため縦書きへ切り替えていません。画面の［縦書きにする］を押してください。`
    );
    return;
  }
  if (!now.vertical) live.applyAppearance({ ...now, vertical: true });
}

/**
 * 読み上げのために原稿を開いて、列を出す（設計書6.42。詳細メニューの入口）。
 *
 * **どの原稿を読むかは、作者が「いま見ているもの」に合わせる。** 探す順は3つ。
 *
 * 1. 原稿エディタで最後に居た原稿——**この画面は `TextEditor` を持たない**
 *    ので、`activeTextEditor` からは辿れない（`addSceneMemo` と同じ事情）
 * 2. 素のエディタで開いている本文（.txt / .md）
 * 3. その作品の最後の話（何も開いていないときの受け皿）
 *
 * 開くのは**タイプに合わせた入口**（作品一覧から本文を開いたときと同じ既定。
 * 小説は横書き、脚本は縦書き。設計書6.70）。
 *
 * **読み始めはしない。** 声の一覧は非同期に揃うので、開いた瞬間に読ませると
 * 声が無いまま始めることになる。押していないのに声が出るのも驚く。
 */
export async function openManuscriptForReading(work: WorkEntry): Promise<void> {
  const filePath = await pickReadAloudTarget(work);
  if (!filePath) {
    void vscode.window.showInformationMessage(
      "読み上げる本文が見つかりませんでした。本文を開いてから実行してください。"
    );
    return;
  }

  const key = manuscriptLedgerKey(filePath);
  const open = openManuscripts.get(key);
  if (open) {
    // 列を渡して前に出す（列なしだと前面の列に2枚目ができる。6.25.11）
    revealManuscriptPanelInPlace(open.panel, key);
    open.showReading();
    return;
  }

  // タブが既にあれば、その入口と列で前に出す（同じ原稿の2枚目を作らない。
  // 6.25.11）。共通の口がそれを判断する
  await openManuscriptFile(
    filePath,
    // 向きの既定はタイプが決める（設計書6.70。脚本だけ縦書き）。
    // **ここで別の決め方をしない**——作品一覧から開いたときと同じ入口にする
    manuscriptViewTypeFor(await kindOf(work))
  );
  /*
    **台帳に載るまで待つ**（`revealLine` と同じ事情。開いた直後はまだ載らない）。

    **ここは長めに待つ**（0.51.7。作者の報告、2026-09-08）。既定の1.5秒は、
    その原稿をこの起動ではじめて開くとき——画面の組み立てと本文の読み込みが
    同時に走るとき——に足りないことがある。`openWith` は既に返っているので、
    **作者の目にはもう原稿が開いて見えている。** 足りないのは読み上げの列だけ
    なので、数秒待つほうが「押しても何も起きない」より良い。
  */
  const opened = await waitFor(
    () => openManuscripts.get(key),
    READ_ALOUD_LEDGER_WAIT_MS
  );
  if (!opened) {
    /*
      **画面に出す**（0.51.7。作者の依頼、2026-09-08
      「空振りしたときは、ログではなく画面に出してください。
      『押しても何も起きない』は作者がいちばん困る形です」）。

      それまではログ1行だけだった。作者から見ると完全に沈黙する——
      作品を選んだのに何も開かず、知らせも出ない。
      **次にできることまで書く。** 読み上げは原稿エディタの中にもあるので、
      そちらから押せば同じことができる。
    */
    logLine(
      `読み上げ：${filePath} を開けなかったため、読み上げの列を出せませんでした。`
    );
    void vscode.window.showWarningMessage(
      `「${paths.basename(filePath)}」の読み上げを始められませんでした。` +
        "作品一覧からこの話を開いて、上のバーの「読み上げ」を押してください。"
    );
    return;
  }
  opened.showReading();
}

/**
 * そのファイルが、その作品のフォルダーの中にあるか（レビュー指摘、2026-08-29）。
 *
 * **読み上げる原稿を決めるとき、候補は3つとも作品の外を指しうる。**
 * 原稿エディタの台帳は作品をまたいで覚えているし、素のエディタで開いている
 * ファイルは拡張子しか見ていない。濾さないと、READMEや設計書を読み上げる。
 *
 * 比べ方は共通の `paths.isPathInside` に任せる（2026-09-23。以前はここに
 * 同じ判定の写しがあった）。**前方一致では足りない**——`いじめられっ子2` は
 * `いじめられっ子` の中ではない。
 *
 * **同じ道（作品フォルダーそのもの）は false。** 読む対象は本文であって、
 * フォルダーではない。名前を残したのは、呼ぶ側（`extension.ts`）で
 * 「作品の中か」という問いがそのまま読めるようにするため。
 */
export function isInsideWork(folderPath: string, filePath: string): boolean {
  return paths.isPathInside(folderPath, filePath);
}

/** 読み上げる原稿を決める（上の3つの順で探す）。見つからなければ undefined */
async function pickReadAloudTarget(
  work: WorkEntry
): Promise<string | undefined> {
  const caret = lastCaret;
  if (
    caret &&
    openManuscripts.has(manuscriptLedgerKey(caret.filePath)) &&
    // **台帳は作品をまたぐ。** 別の作品を開いたままここへ来ることがある
    isInsideWork(work.folderPath, caret.filePath)
  ) {
    return caret.filePath;
  }

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const filePath = fromUri(active);
    const lower = filePath.toLowerCase();
    if (
      (lower.endsWith(".txt") || lower.endsWith(".md")) &&
      // 拡張子だけを見ると、READMEや設計書を読み上げてしまう
      isInsideWork(work.folderPath, filePath)
    ) {
      return filePath;
    }
  }

  try {
    const { episodes } = await scanWork(work);
    // 走査は作品の本文フォルダーだけを見るが、**受け皿でも同じ濾しを通す**
    // （3つの候補で判定が違うと、どれが通ったのかを追えなくなる）
    for (let i = episodes.length - 1; i >= 0; i--) {
      if (isInsideWork(work.folderPath, episodes[i].filePath)) {
        return episodes[i].filePath;
      }
    }
  } catch (error) {
    // **走査に失敗しても、押しても何も起きないで終わらせない**（下で断る）
    logLine(
      `読み上げ：${work.title} の話を走査できませんでした（${
        error instanceof Error ? error.message : String(error)
      }）。`
    );
  }
  return undefined;
}

/** 「済みにする」がどう終わったか（呼んだ側が理由を出せるようにする） */
export type MemoLineRemoval =
  /** 消した。`removed` は帯の［戻す］で元へ差し込むための控え（6.40.4） */
  | { kind: "removed"; removed: RemovedMemoLine }
  /** この原稿は原稿エディタで開いていない（呼んだ側がディスクを書く） */
  | { kind: "not_open" }
  /** 行が読み込んだときのものと違う（本文が変わっている） */
  | { kind: "changed" };

/**
 * 原稿エディタで開いている本文から、メモの行を消す（設計書6.40.4）。
 *
 * **開いている原稿はディスクではなく文書を書き換える。** 打ちかけを
 * 抱えたまま `writeTextFilePreservingFormat` を通すと、そちらは
 * 「未保存の変更がある」として断るか、断らなければ打ちかけを消す。
 *
 * **消す前に、その行が読み込んだときのものか確かめる。** 一覧を作ってから
 * 押すまでの間に本文が変わっていることがあり、行番号だけで消すと
 * **別の行が消える。**
 *
 * @param line 1始まり
 */
export async function removeMemoLineInOpenManuscript(
  filePath: string,
  line: number,
  expectedRaw: string
): Promise<MemoLineRemoval> {
  const open = openManuscripts.get(manuscriptLedgerKey(filePath));
  if (!open) return { kind: "not_open" };

  const document = open.document;
  const index = line - 1;
  if (index < 0 || index >= document.lineCount) return { kind: "changed" };
  if (document.lineAt(index).text !== expectedRaw) return { kind: "changed" };
  // 戻すための控えは、**消す前の文書の字**から作る（改行も文書のものになる）
  const removed = memoLineRemoval(document.getText(), line, expectedRaw);
  if (!removed) return { kind: "changed" };

  const change = new vscode.WorkspaceEdit();
  // **行まるごと（改行を含めて）消す。** 本文だけを消すと空行が残り、
  // 段落の切れ目が増えてしまう
  change.delete(document.uri, document.lineAt(index).rangeIncludingLineBreak);
  if (!(await vscode.workspace.applyEdit(change))) {
    logLine(
      `原稿エディタ：メモの行を消せませんでした（${filePath} ${line}行目）。`
    );
    return { kind: "changed" };
  }
  return { kind: "removed", removed };
}

/** 帯の［戻す］がどう終わったか（呼んだ側が理由を出せるようにする） */
export type MemoLineRestore =
  /** 戻した */
  | { kind: "restored" }
  /** この原稿は原稿エディタで開いていない（呼んだ側がディスクを書く） */
  | { kind: "not_open" }
  /** 消したあとに本文が変わり、元の位置が確かめられない */
  | { kind: "changed" };

/**
 * ［済み］で消したメモの行を、原稿エディタで開いている文書へ戻す
 * （設計書6.40.4。作者の裁定 2026-10-04「［済み］の直後に戻す帯を出す」）。
 *
 * **消すときと同じく、文書へ `WorkspaceEdit` で差し込む。** 原稿エディタの
 * 中の Ctrl+Z は画面の取り消しで、拡張機能の側から書き換えた［済み］の
 * 記録を持たないので、戻す口はこちらに置く。
 *
 * 元の位置は `core/sceneMemo.ts` の `memoLineRestorePoint` が決める
 * （ディスクを書き直す経路と同じ判定。上下の隣の行が変わっていれば断る）。
 */
export async function restoreMemoLineInOpenManuscript(
  filePath: string,
  removed: RemovedMemoLine
): Promise<MemoLineRestore> {
  const open = openManuscripts.get(manuscriptLedgerKey(filePath));
  if (!open) return { kind: "not_open" };

  const document = open.document;
  const point = memoLineRestorePoint(document.getText(), removed);
  if (!point) return { kind: "changed" };

  const change = new vscode.WorkspaceEdit();
  change.insert(document.uri, document.positionAt(point.offset), point.insert);
  if (!(await vscode.workspace.applyEdit(change))) {
    logLine(
      `原稿エディタ：済みにしたメモの行を戻せませんでした（${filePath} ${removed.line}行目）。`
    );
    return { kind: "changed" };
  }
  return { kind: "restored" };
}

/**
 * 読み上げのために開くときの、待つ上限（0.51.7）。
 *
 * **既定より長くする。** その原稿をこの起動ではじめて開くときは、
 * 画面の組み立てと本文の読み込みが同時に走るので1.5秒では足りないことがある。
 * ここで諦めると、作者には「押しても何も起きない」ように見える。
 */
const READ_ALOUD_LEDGER_WAIT_MS = 5000;

/** 台帳に載るのを待つ上限。これを過ぎたら「開けなかった」とみなす */
const LEDGER_WAIT_MS = 1500;
/** 見に行く間隔 */
const LEDGER_POLL_MS = 50;

/**
 * 取れるようになるまで待つ。上限まで取れなければ undefined。
 *
 * **`vscode.openWith` の完了は、台帳に載ったことを意味しない。**
 * 台帳へ載せるのは `resolveCustomTextEditor` で、そちらは非同期に走る。
 * 待たずに引くと「開いていない」と読めてしまい、呼び出し側が同じ原稿を
 * 素のエディタでも開く（1つの原稿が2つの面で開く）。
 *
 * **台帳を直接見ずに、取り方（`get`）を受け取る。** そうしておけば、
 * VS Codeの画面を作らずに待ち方だけを確かめられる。
 */
export async function waitFor<T>(
  get: () => T | undefined,
  budgetMs: number = LEDGER_WAIT_MS,
  pollMs: number = LEDGER_POLL_MS
): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * MD化の案内をもう出したファイル（この起動中だけ覚える）。
 *
 * 断られたぶんは端末に残す（`deps.markdownDeclined`）。こちらは
 * 「開くたびに同じ案内が出る」のを止めるためだけのもので、
 * VS Code を開き直せば1度は出る——**断りではなく、後回しだから**である。
 */
const markdownAsked = new Set<string>();

/**
 * 改行コードを**もう調べた**ファイル（この起動中だけ覚える）。
 *
 * **「出した」ではなく「調べた」を覚える。** 揃っていたファイルにも印を
 * 付けておかないと、開き直すたびに作品の全話を見に行くことになる。
 *
 * **断りは残さない。** 揃えるかどうかはそのときの都合で決まる話なので、
 * VS Code を開き直せばまた1度だけ出る（`markdownAsked` と同じ考え方）。
 */
const eolNoticeChecked = new Set<string>();

/**
 * 画面へ出す字数。**数え方は作品一覧とまったく同じにする**（作者の裁定
 * 2026-09-06）。ここだけ違う数字が出ると、どちらが本当か分からなくなる。
 *
 * 数え方（頭書きを外す・合本を話ごとに割る・ルビは `.md` のときだけ外す）は
 * `core/episodeCharCount.ts` の1か所に集めてある——ここへ写しを作ると、
 * 片方だけが直る日が来る。実際、頭書きで 5,529字 と 5,672字 に割れ、
 * 合本では後書き・リアクションのぶんが約1万字ずれていた。
 *
 * @param ext 開いているファイルの拡張子（`.md` / `.txt`）。**設定だけで
 *   決めない**——ルビの読みを外すのは Markdown のときだけである
 */
export function countForDisplay(text: string, ext: string): number {
  return pickCount(
    countEpisodeChars(text, { ext, excludeRuby: excludeRubyFromCount() }),
    currentCountMode()
  );
}

/** 開いている原稿の拡張子（小文字・ドット付き）。数え方の判断に使う */
function extensionOf(document: vscode.TextDocument): string {
  return paths.extname(fromUri(document.uri)).toLowerCase();
}

/**
 * 同じファイルを指しているか。
 *
 * **文字列の一致では足りない。** Windowsではドライブ文字の大小や
 * 区切りの表れ方が経路によって違う。ブラウザ版では、開いた文書の場所の
 * 日本語が符号化されて来る（2026-09-24）。比べ方は `paths.isSamePath` の1か所。
 * 取り違えると「いま開いている話」が見つからず、前後の話へ移れない。
 */
function samePath(left: string, right: string): boolean {
  return paths.isSamePath(left, right);
}

/**
 * 話を新しく作るときの名前の決まり。**`novelai.addEpisode` と揃える**
 * （揃えないと、同じ作品の中でファイル名の形が2種類できる）。
 */
function episodeNaming(): { digits: number; extension: string } {
  const config = vscode.workspace.getConfiguration("novelai");
  return {
    digits: config.get<number>("episodeNumberDigits", 3),
    extension: config.get<string>("episodeFileExtension", ".txt"),
  };
}

/**
 * いまアクティブなタブで開いている本文の場所（作者の実機報告、2026-09-06）。
 *
 * **中身は `manuscriptTab.ts` にある。** VS Code 1.131 の新しいMarkdown編集画面
 * （hybrid Markdown editor）でも同じ判定が要るようになり、ルビ側
 * （`features/ruby.ts`）からも使うことになったため切り出した。ここからの
 * 再輸出は、これまでの読み口（`features/manuscriptEditor`）を残すためのもの。
 */
export { activeManuscriptTabUri } from "./manuscriptTab";

/**
 * 開いているタブのうち、本文を開いているもの（原稿エディタ・素のエディタ）。
 * **各グループでアクティブなタブを先に並べる。**
 *
 * `activeManuscriptTabUri` は「いまアクティブなタブ」しか見ない。設定資料
 * パネルの「ルビを追加」のように**WebView の中のボタンから呼ばれる**操作では、
 * 押した時点でアクティブなのは必ずそのパネルなので、原稿エディタで本文を
 * 開いていても一度も見つからなかった（実機、2026-09-06）。
 * 全グループのタブから拾えば、隣のグループで開いている本文も分かる。
 */
export function openManuscriptTabUris(): vscode.Uri[] {
  try {
    const active: vscode.Uri[] = [];
    const others: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = manuscriptTabUri(tab.input);
        if (!uri) continue;
        (tab.isActive ? active : others).push(uri);
      }
    }
    return [...active, ...others];
  } catch {
    // タブを読めない環境（古いVS Code・試験の代役）では「開いていない」扱い
    return [];
  }
}

function manuscriptTabUri(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputText) return input.uri;
  if (
    input instanceof vscode.TabInputCustom &&
    (input.viewType === MANUSCRIPT_EDITOR_VIEW_TYPE ||
      input.viewType === MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE)
  ) {
    return input.uri;
  }
  return undefined;
}

/**
 * いまアクティブなタブが原稿エディタなら、その入口のID。
 *
 * **開いていない原稿へ飛ぶときに、どちらの向きで開くかを決める。**
 * 縦書きで書いている人の画面に横書きが出ると、書いていた向きが変わる。
 */
function activeManuscriptViewType(): string | undefined {
  try {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input: unknown = tab?.input;
    if (!(input instanceof vscode.TabInputCustom)) return undefined;
    if (
      input.viewType === MANUSCRIPT_EDITOR_VIEW_TYPE ||
      input.viewType === MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    ) {
      return input.viewType;
    }
    return undefined;
  } catch {
    // タブの種類を読めない環境（古いVS Code・試験の代役）では、
    // 「原稿エディタではない」として素のエディタへ譲る
    return undefined;
  }
}

/**
 * その作品の種類（設計書6.70・6.109）。**読めなければ undefined。**
 *
 * 設定が無い・壊れている作品でも、開けなくなってはいけない。
 * そのときは小説と同じ扱いで、これまでどおり横書きになる。
 */
async function kindOf(work: WorkEntry): Promise<WorkKindKey | undefined> {
  try {
    return await readWorkKind(work);
  } catch {
    return undefined;
  }
}

/** その入口が、はじめにどちらの向きで開くか */
export type ManuscriptOrientation =
  /** 設定（`manuscriptEditor.vertical`）に従う */
  | "setting"
  /** 必ず横書き */
  | "horizontal";

/** 画面から届く用件 */
type Incoming =
  | {
      type: "ready";
      /**
       * 画面が覚えていた見た目（設計書6.25.5）。
       *
       * **開くときの向き・大きさ・面を決めるのはこちら。** 覚えていた値・
       * 前の話から持って来た値・入口で決まった向き・設定の既定を突き合わせる
       * 規則が2か所にあると、片方だけが直る日が来る。
       */
      saved?: SavedAppearance;
    }
  /**
   * 打たれた本文（LF空間）。`seq` は画面が付けた便の番号で、
   * **入ったかどうかをこの番号で返す**（`editApplied`。設計書6.25.9）
   */
  | {
      type: "edit";
      text: string;
      seq?: number;
      /**
       * 元にした本文の指紋（`core/screenEditRebase.ts`。設計書6.25.9）。
       * 本体の変更が画面へ届く前に打たれた便でも、その変更を戻さないために使う
       */
      base?: string;
    }
  /**
   * 画面の［保存］（設計書6.25.9。作者の裁定 2026-10-01）。`seq` は直前に
   * 送った edit の番号で、**その便まで当て終わってから保存する**。結果は
   * `saveResult` で返す
   */
  | { type: "saveRequest"; seq: number }
  | { type: "count"; text: string }
  | { type: "ruby"; text: string; start: number; end: number }
  | { type: "emphasis"; text: string; start: number; end: number }
  | {
      type: "copyForPosting";
      /**
       * カーソルの行（1始まり。読めなければ0）。
       *
       * **合本のときだけ効く。** 1ファイルに全話が入っていると、どの話を
       * コピーするのかがカーソルの位置でしか分からない（設計書6.12.1）。
       */
      line?: number;
      /**
       * 選んだ範囲（LF空間の位置）。選んでいなければ -1。
       *
       * **選んでいればその範囲だけを変換する**（作者の裁定、2026-09-21）。
       * 右クリックからは話ぜんぶしか写せず、部分を選んでも全文が入っていた。
       */
      start?: number;
      end?: number;
    }
  /**
   * 選んだところを**記法のまま**クリップボードへ（設計書6.12.8）。
   *
   * 普通のコピー（Ctrl+C）は貼り先に合わせて形が変わるので、素の
   * VS Code エディタへ貼ると字だけになる。記法で貼りたいときの逃げ道。
   */
  | { type: "copyNotation"; text: string }
  /**
   * 右クリックの「貼り付け」（作者の裁定、2026-09-28）。画面の中からは
   * クリップボードを読めないので、こちらで読んで `clipboardText` で返す。
   * **本文へ入れるのは画面**（打鍵と同じ送りで `edit` が来る）
   */
  | { type: "clipboardRead" }
  /**
   * 右クリックの「コピー」「切り取り」で、画面の中の copy が断られたときの逃げ道。
   * 写したら `clipboardWritten`（`id` と成否）を返す——**切り取りは、成功の返事が
   * 来るまで字を消さない**（写せなかったのに消すと字がどこにも残らない）
   */
  | { type: "clipboardWrite"; text: string; id?: number }
  | { type: "openTerm"; id: string; kind: TermKind }
  /**
   * 右クリックの時点で、**開いている**資料パネルへ該当項目を出す
   * （作者の指示、2026-08-28）。開いていなければ何もしない——
   * 開くのは品書きの「設定資料を見る」（openTerm）だけ。
   */
  | { type: "previewTerm"; id: string; kind: TermKind }
  | { type: "chat"; start: number; end: number }
  /**
   * 口述で入れた範囲を、AIに整えてもらう（設計書6.83）。
   *
   * `from` は「口述」を押したときのカーソル、`to` は「整える」を押した
   * ときのカーソル（開始より前なら文末）。**どちらもLF空間の位置**で、
   * 文書の位置へ直すのはこちらの仕事である。
   *
   * `text` はその範囲の本文（LF空間）。**位置だけでは足りない**——画面の
   * 打鍵が文書へ届く前に押されると、同じ位置が別の場所を指す。
   */
  | { type: "dictationClean"; from: number; to: number; text: string }
  /**
   * 書体を選ぶ。
   *
   * `installed` は**画面が測った**「この端末に入っている書体」。
   * 測れなかったときは省く（全部並べる。測れないことを「入っていない」と
   * 読み替えると、選べるものが消える）
   */
  | { type: "pickFont"; installed?: string[] }
  /**
   * 見た目が変わった（設計書6.25.5）。
   *
   * 向き・大きさ・面を変えるたびに届く（画面が覚える `remember()` と
   * 同じ場所から出る）。**前後の話へ移ったときに、同じ見た目で開くため**に
   * 持っておく。書体は設定から読むので、ここには入らない。
   */
  | { type: "appearance"; vertical: boolean; size: number; compose: boolean }
  /** 最新話を書く（設計書6.25.5） */
  | { type: "openLatest" }
  /**
   * 前の話・次の話（作者の指示、2026-08-29）。
   *
   * **どの話かを決めるのはこちら。** 画面はファイルの並びを知らない
   * （走査の結果を持っているのは拡張機能側である）。
   */
  | {
      type: "openNeighbor";
      direction: "prev" | "next";
      /**
       * カーソルの行（1始まり。読めなければ0）。
       *
       * **合本のときだけ効く。** 1ファイルに全話が入っているときは、
       * どの話に居るかがカーソルの位置でしか分からない（設計書6.25.5）。
       */
      line?: number;
      /** 最終話の先へ新しい話を作らない（Alt+↑／Alt+↓ から。planNeighborStep） */
      noCreate?: boolean;
    }
  /**
   * 画面側で起きたことを記録する（設計書6.34）。
   *
   * 組んで書く面の安全弁（記法→DOM→記法 の往復が一致しないとき）は、
   * **黙って開かないだけ**では何が起きたか誰にも分からない。通知は出さず、
   * ログには必ず残す。
   */
  | { type: "log"; text: string }
  /**
   * 打った字が原稿に入らないまま、作者が［開き直す］を押した（設計書6.25.9）。
   *
   * `rescue` は画面が控えた本文。**タブを閉じて開き直すと画面の状態は
   * 引き継がれない**ので、こちらで預かって新しい画面へ渡す。形は信用せず
   * `parseManuscriptRescue` で確かめる。`bands` は帯の控え（重なって入らなかった
   * 字・前回の控え。2026-10-04 に未送信の字の控えと置き場を分けた）
   */
  | { type: "reopen"; rescue?: unknown; bands?: unknown }
  /**
   * 未送信の状態が変わった（知らせの出し下げ・段・控えの有無。作者の裁定、
   * 2026-10-01）。窓の札（MCP の `windows.list`）に載せる。形は信用せず
   * `parseManuscriptStatusMessage` で確かめる
   */
  | { type: "unsentStatus"; status?: unknown }
  /** カーソル行の**上**に `// ` の行を挿す（設計書6.40.3） */
  | { type: "addMemo"; line: number }
  /** シーンメモのパネルを横に開く（設計書6.40.4） */
  | { type: "openMemos" }
  /** 執筆再開の資料を開く（設計書6.36。右クリックから。0.76.7） */
  | { type: "resumeWriting" }
  /**
   * この話の単話プロットを右の列に開く（設計書6.36・6.25。上のバーと右クリック）。
   * カーソルの行を添える——合本ではどの話かが位置でしか分からない
   */
  | { type: "openEpisodePlot"; line?: number }
  /**
   * カーソルが動いた（設計書6.40.4）。
   *
   * **画面側で200ミリ秒まとめてから届く。** 打鍵のたびに来ると、
   * パネルが1文字ごとにいちばん近い付箋を数え直すことになる。
   */
  | { type: "caret"; line: number }
  /*
    ── 読み上げ（音読推敲。設計書6.42） ──
  */
  /**
   * 読み上げの計画を作ってほしい。
   *
   * **本文は画面が持っているものを送り返させる。** こちらの文書と画面の
   * 表示は120ミリ秒ずれることがあり（`scheduleSend`）、こちらの本文で
   * 計画を作ると、光らせる位置が打った分だけずれる。
   */
  | { type: "readingPlan"; text: string }
  /** 読んでいる文の行に、シーンメモの印を置く */
  | { type: "readingMark"; line: number }
  /** 選ばれた声を覚える（端末ごと。作品には書かない） */
  | { type: "readingVoice"; name: string }
  /**
   * 「noteに貼ったときの見た目」の面を開いた・閉じた（設計書6.69）。
   *
   * **開いているあいだだけ組む。** 本文ぜんたいをHTMLへ組んで送る道は
   * 0.25.2で一度やめている（打つたびに千の段落を組んでいた）。
   * SNS記事は短いとはいえ、閉じている面のために組む理由は無い。
   */
  | { type: "notePreview"; on: boolean };

export interface ManuscriptEditorDeps {
  highlighter: TermHighlighter;
  /**
   * その本文が属する作品（登録簿で引く。設計書6.68.2）。
   *
   * **用語索引（`highlighter.indexFor`）で代用しない。** あちらは
   * 設定資料を読めたときにしか作品を返さないので、**まだ資料を1件も
   * 抽出していない作品では `undefined` になる**。作品を知りたいだけの
   * ところであれを使うと、書き始めたばかりの作品でだけ挙動が変わる。
   */
  workOf(filePath: string): WorkEntry | undefined;
  /**
   * 用語から設定資料を開く。extension.ts の登録と同じ道を通す。
   *
   * `from` はいま開いている本文。**話数を数え直さずに渡す**（設計書6.92）。
   * 資料の側で「その話に出る人どうし」だけに絞るのに使う。話数の解釈は
   * `episodeParser.ts` の1本に寄せてあるので、ここではファイルの場所だけ渡す。
   */
  openSettings(
    work: WorkEntry,
    kind: TermKind,
    id: string,
    from?: { filePath: string }
  ): Promise<void>;
  /**
   * **開いている**資料パネルへ該当項目を出す（無ければ何もしない）。
   * 右クリックのたびに新しいパネルを開いては、作者の画面を奪ってしまう。
   */
  previewTerm(
    work: WorkEntry,
    kind: TermKind,
    id: string,
    from?: { filePath: string }
  ): Promise<void>;
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
  /**
   * 作品ぜんたいの字数（下段に出す。作者の指示、2026-08-29）。
   *
   * **走査は作品一覧の結果を借りる。** 開いたときと保存したときにしか
   * 呼ばないが、それでも4万字の作品を独立に読み直す理由は無い。
   */
  workStats(work: WorkEntry): Promise<WorkStats>;
  /**
   * 作品の本文ファイル一覧（改行コードの案内に使う。設計書5.4.2）。
   *
   * **`workStats` と同じく、作品一覧の走査結果を借りる。** 開くたびに
   * 全話を読み直すと、19話の作品で1回開くごとに19ファイル読むことになる。
   */
  workEpisodes(work: WorkEntry): Promise<EpisodeFile[]>;
  /**
   * この原稿で今日書いた純文字数（設計書6.3）。
   * 記録を止めている作者には `undefined` が返る（0と書かない）。
   */
  todayFileCount(work: WorkEntry, filePath: string): Promise<number | undefined>;
  /**
   * 目標に届いた日の一言（設計書6.3.8）。下段の字数の隣に出す。
   *
   * **この画面では祝わない**（風船も札も出さない）。書いている最中に
   * 画面が動くと手が止まるので、文字で添えるだけにする。省略できる
   * 形にしてあるのは、祝う係が無くても原稿エディタは成り立つため。
   */
  cheerFor?(work: WorkEntry): Promise<string | undefined>;
  /**
   * 執筆量の基準を置き直す（設計書6.3.2）。
   *
   * **拡張機能が本文ファイルを作った直後に呼ぶ。** 記録は「ファイル数が
   * 変わった回は数えない」（投稿サイトからの取り込みを執筆に数えないため）
   * という決まりで動いている。「次の話 →」や「最新話を書く」で空の話を
   * 作ったあと、作者がそこへ書いて保存すると**その回がこの決まりに当たり、
   * 「今日 +0字」になって以後も数えられない。**
   *
   * ここで空のファイルごと基準に入れておけば、次の保存は差分として数えられる。
   */
  rebaseline(work: WorkEntry): Promise<void>;
  /**
   * 読み仮名の入った `.txt` を `.md` にする（作者の指示、2026-08-29）。
   *
   * **既存の変換と同じ経路を通す**（`features/markdownConvert.ts` の
   * `convertOne`）。ここで名前を変える手順を書き起こすと、
   * 「中のルビも直す」（設計書6.12.4）が抜けた別物ができる。
   * 変換後のパスを返す。断られた・失敗したときは undefined。
   */
  convertToMarkdown(filePath: string): Promise<string | undefined>;
  /** MD化の案内を「今はしない」と断られたファイル（端末に残す） */
  markdownDeclined(): readonly string[];
  /** 断られたことを覚える */
  declineMarkdown(filePath: string): Promise<void>;
  /**
   * 口述で入れた範囲を整える（設計書6.83）。
   *
   * **繋ぐのは `extension.ts` だけ。** ここから整文の機能を直に読み込むと、
   * 原稿エディタがAIの登録簿を抱えることになる（相談・シーンメモと同じ理由）。
   * 省略できる形にしてあるのは、この画面が口述なしでも成り立つため。
   */
  dictationClean?: (
    document: vscode.TextDocument,
    range: vscode.Range
  ) => Promise<void>;
  /**
   * シーンメモのパネルを横に開く（設計書6.40.4）。
   *
   * **繋ぐのは `extension.ts` だけ。** ここからパネルを直に読み込むと、
   * パネル側もこちらを読むので輪になる（相関図・年表と同じ理由）。
   * 省略できる形にしてあるのは、この画面がメモの機能なしでも成り立つため。
   */
  openSceneMemos?: (filePath: string) => Promise<void>;
  /**
   * 執筆再開の資料（設計書6.36）を開く。右クリックの品書きから呼ぶ
   * （作者の依頼、2026-09-23「原稿エディター内でも呼び出せたらいいな」）。
   *
   * **渡すのは原稿のパス。** 作品はこの原稿のものを繋ぎの側が引く——
   * コマンドを引数なしで呼ぶと、作品が複数あるときに訊き直してしまう。
   * **繋ぐのは `extension.ts` だけ**（シーンメモと同じ理由）。
   */
  resumeWriting?: (filePath: string) => Promise<void>;
  /**
   * この話の単話プロットを右の列に開く（設計書6.36。作者の依頼、2026-09-23
   * 「エディターから単話プロット参照したいです」）。
   *
   * **渡すのは原稿の場所・中身・カーソルの行。** どの話か（合本ならカーソルの
   * 行の話）と作品は繋ぎの側が決める。**繋ぐのは `extension.ts` だけ**
   * （シーンメモと同じ理由。ここから単話プロットの機能を直に読むと輪になる）。
   */
  openEpisodePlot?: (filePath: string, rawText: string, line: number) => Promise<void>;
  /**
   * 原稿の画面が前面に来た（別の話へ移った）ことを外へ知らせる（設計書6.36）。
   *
   * **片方向である。** 受け手は、右に単話プロットが見えているときだけ
   * その話のものへ切り替える。見えていなければ何もしない。
   */
  onManuscriptShown?: (filePath: string, rawText: string, line: number) => void;
  /**
   * カーソルが動いたことを外へ知らせる（設計書6.40.4）。
   *
   * **片方向である。** パネルは受けていちばん近い付箋を光らせるだけで、
   * こちらの本文を動かすのは、パネルの行が押されたときだけ。
   */
  onCaretMoved?: (filePath: string, line: number) => void;
  /**
   * 読み上げに使う声の名前（設計書6.42）。
   *
   * **端末に覚える**（`globalState`）。どの声が入っているかは端末ごとに
   * 違うので、作品フォルダーへ書くと同期先で存在しない声を指す。
   * 省略できる形にしてあるのは、この画面が読み上げ無しでも成り立つため。
   */
  readAloudVoice?: () => string | undefined;
  /** 選ばれた声を覚える */
  saveReadAloudVoice?: (name: string) => Promise<void>;
}

export class ManuscriptEditorProvider
  implements vscode.CustomTextEditorProvider
{
  constructor(
    private readonly deps: ManuscriptEditorDeps,
    /**
     * この入口の向き。
     *
     * **縦書きの入口は設定に従う。** `manuscriptEditor.vertical` は
     * 0.19.0からある設定で、既定は縦。**必ず縦に決め打つと、その設定が
     * 黙って無視される**（横で書く人が設定していたら、その指定が消える）。
     */
    private readonly orientation: ManuscriptOrientation = "setting",
    /** 開き直すときに使う入口のID（「最新話を書く」で同じ向きを保つ） */
    private readonly viewType: string = MANUSCRIPT_EDITOR_VIEW_TYPE
  ) {}

  /**
   * 開いた本文の作品の種類（設計書6.70・6.109）。**引けなければ undefined。**
   *
   * 作品を探す道は、用語索引と同じもの（`indexFor`）を通す。**別の探し方を
   * 増やさない**——同じファイルに対して「色が付く作品」と「組み方を決める
   * 作品」が食い違うと、原因の分からない見た目の違いになる。
   */
  private async kindOfDocument(
    document: vscode.TextDocument
  ): Promise<WorkKindKey | undefined> {
    try {
      const found = await this.deps.highlighter.indexFor(fromUri(document.uri));
      return found ? await kindOf(found.work) : undefined;
    } catch {
      // 索引を作れない作品（設定資料が壊れている等）でも、原稿は開ける
      return undefined;
    }
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // つながりに来たことを、最初の await より前に記録する（`watchDisconnectedManuscripts`）
    resolvedManuscriptKeys.add(manuscriptLedgerKey(document.uri));
    panel.webview.options = { enableScripts: true };
    /*
      **作品の種類は、画面を組み立てる前に決める**（設計書6.70・6.109）。台本は
      柱・ト書き・台詞を組み分けるので、あとから知らせる形にすると
      開いた直後だけ小説の組み方で出て、1拍おいて組み直ることになる。

      引けなければ undefined＝これまでどおりの画面（作品の外のファイルでも、
      開けなくなってはいけない）。下段の目安（台本の分数など）も同じ種類で出す
      ——開いている間に種類を変えても、組み方と目安が別々の種類を指さない。
    */
    const kind = await this.kindOfDocument(document);
    panel.webview.html = buildManuscriptEditorHtml(
      createNonce(),
      panel.webview.cspSource,
      kind
    );
    /*
      **下段の目安を測る種類は、あとから読み直せるように別に持つ**
      （2026-09-25）。組み方（上の `kind`）は画面を組み立てた時点で決まり、
      開き直すまで変わらない。目安は数字を出し直すだけなので、種類を
      変えたらその場で新しい種類に合わせる（`refreshKind`）。
    */
    let measureKind = kind;

    /**
     * この原稿の記法（設計書6.12）。
     *
     * `.txt` は投稿サイトの形をそのまま保つ決まりなので、ルビも傍点も
     * `｜漢字《かんじ》` `《《強調》》` で書かれている。**記法のまま
     * 見せるのではなく、こちらで組んで見せる**（作者の依頼、2026-08-29
     * 「テキストファイルもルビなどを再現して、同様に表示できるように」）。
     *
     * ファイルの名前で決まるので、開いている間は変わらない。
     */
    const notation = notationModeFor(fromUri(document.uri));

    /**
     * 組んで書く面で写したときの、素のテキストの傍点の書き方（設計書6.12.8。
     * 作者の裁定、2026-09-25 朝）。**.md のときだけ効く**——.txt は書いてある
     * 投稿サイトの記法をそのまま載せる。
     *
     * **開いたときに1回だけ引く。** `send` は打つたびに走るので、そのたびに
     * 投稿状態の台帳を読まない。台帳を読めなくても止めない
     * （`registeredPostingSites` が空を返し、カクヨムの書き方になる）。
     */
    const copyEmphasis =
      notation === "curly"
        ? registeredPostingSites(
            this.deps.workOf(fromUri(document.uri))
          ).then(copyEmphasisFor)
        : Promise.resolve(copyEmphasisFor([]));

    /**
     * 「noteに貼ったときの見た目」の面が開いているか（設計書6.69）。
     *
     * 画面から届く知らせで切り替わる。**閉じているあいだは組まない。**
     */
    let notePreviewWanted = false;

    /**
     * 画面がいま使っている見た目（設計書6.25.5）。
     *
     * 変わるたびに画面から届く。前後の話へ移るときに持って行く。
     */
    let appearanceNow: ManuscriptAppearance | undefined;
    /**
     * 最初の `update` に添える、この原稿を開くときの見た目。
     *
     * **添えるのは1回だけ。** 送るたびに添えると、作者がそのあと変えた
     * 大きさや向きを、打鍵のたびに送り返す値が押し戻してしまう。
     */
    let initialAppearance: ManuscriptAppearance | undefined;
    /**
     * ［開き直す］で前の画面から預かった控え（設計書6.25.9）。
     * 最初の `update` に1回だけ添える。
     */
    let carriedRescue: ManuscriptRescue[] | undefined;
    /**
     * 画面の便の「元の本文」の控え帳（設計書6.25.9。作者の裁定「塞ぐ」、2026-10-04）。
     * 画面へ送った本文と、当て終えた画面の本文を覚える。本体の変更が画面へ
     * 届く前に打たれた便を、その変更を戻さずに当て直すために使う
     */
    const ledger: ScreenEditLedger = createScreenEditLedger();

    const send = async (): Promise<void> => {
      const found = await this.deps.highlighter.indexFor(
        fromUri(document.uri)
      );
      const index = found?.index;
      /*
        **この原稿はSNS記事か**（設計書6.69）。形式の在り処はプロットの
        「形式」の節ひとつ（`core/workFormatStore.ts`。読んだ結果は
        向こうが覚えているので、打つたびにファイルを読むことにはならない）。
        作品を引けなければ `undefined` を渡し、判定はファイル名へ落ちる。
      */
      const format = found ? await readWorkFormat(found.work) : undefined;
      const noteLike = isNoteStyleTarget(fromUri(document.uri), format);
      const emphasis = await copyEmphasis;
      /*
        **本文は、待ちが全部済んでから読む**（ノートPCの観測、2026-09-30）。
        先頭で読んでいたときは、先の便が上の待ちで遅れて後の便に追い越され、
        画面へ1字古い本文が遅れて届いた。画面はそれを外からの変更と見て組み直し、
        カーソルがずれ、「！」」が「」！」と入った。読んでから postMessage まで
        待ちを挟まなければ、あとから届く便ほど本文が新しい。

        **画面へはLF区切りで渡す**（core/eolSpace.ts）。textareaは値を
        LFへ正規化するので、CRLFのまま渡すと本文・用語の位置・組んで書く面の
        安全弁がすべて1行ごとに1文字ずつずれる（実際にずれていた）
      */
      const text = toLf(document.getText());
      // 画面はこの本文を取り込めば、次の便の元にする（指紋で送ってくる）
      ledger.rememberSent(text);
      await panel.webview.postMessage({
        type: "update",
        text,
        // note風の組版と、切り替えボタンの出し入れ（設計書6.69）
        noteLike,
        /*
          「noteに貼ったときの見た目」。**開いているあいだだけ組む**
          （閉じている面のために本文ぜんたいを組む理由が無い）。
        */
        ...(noteLike && notePreviewWanted
          ? { notePreview: renderNotePreview(text) }
          : {}),
        // **組んで書く面も、この記法で組む**（画面側に写しを持たせない）
        notation,
        // 写したときの傍点の書き方（素のテキストの側。設計書6.12.8）
        copyEmphasis: emphasis,
        /*
          **組み上がりのHTMLはもう送らない**（0.25.2）。
          送り先だった「読む」面・「並べる」面は、0.24.14で切り替えの
          ボタンが無くなった時点から**開く道が無く**、画面側は届いたHTMLを
          溜めるだけになっていた。4万字の本文では段落が千を超えるので、
          打つたびにそれを組んでいたことになる。
        */
        // **打つ面に重ねる用語の色**（設計書6.25.6）。
        // 打つ面は textarea なので、中の一部だけを飾れない。
        // 同じ本文を重ねて、用語のところだけ色を付ける（それ以外は透明）
        marks: renderTermMarks(text, index),
        // 右クリックで「どの用語の上か」を知るために使う。
        // textarea の中に要素は無いので、当たり判定を要素で取れない
        terms: collectTermSpans(text, index),
        hasTerms: (index?.size ?? 0) > 0,
        // **色分けの凡例は送らない**（作者の指示、2026-08-28
        // 「文字の色分け説明は不要です」）。色の意味は設定資料パネルの
        // タブが同じ色で示す
        colors: colorsFor(),
        ...readAppearance(),
        // **開くときの見た目は、こちらが決めて渡す**（設計書6.25.5）。
        // 前の話から持って来た値・入口の向き・設定の既定を突き合わせるのは
        // core/manuscriptAppearance.ts の仕事で、画面は受け取って当てるだけ
        ...(initialAppearance ? { initialAppearance } : {}),
        // 読み上げの声は設定ではなく**端末の覚え**なので、deps から取る
        // （設計書6.42）。覚えていなければ画面が最初の声を選ぶ
        readAloudVoice: this.deps.readAloudVoice?.(),
        /*
          **取り消し・やり直しで戻ったときだけ添える**（設計書6.25.8）。
          添えてあれば、画面は差分からカーソルをずらすのをやめ、
          ここへ置く。添えなければ今までどおり。
        */
        ...(undoCaret === undefined ? {} : { undoCaret }),
        /*
          **どの文書かを画面へ知らせる**（設計書6.25.9）。画面は原稿に
          入らなかった字を控えるときにこれを添え、開き直したときに同じ
          文書の控えだけを使う
        */
        docKey: key,
        ...(carriedRescue && carriedRescue.length > 0 ? { rescues: carriedRescue } : {}),
      });
      // 添えるのは最初の1回だけ（送り直すたびに当て直させない）
      initialAppearance = undefined;
      carriedRescue = undefined;
      undoCaret = undefined;
      await this.sendCount(panel, text, document, measureKind);
    };

    /**
     * 台帳へ載せる（誤字脱字の提案から、この画面へ飛べるようにする）。
     *
     * **`ready` を待ってから行を示す。** 開いた直後の画面へ送っても、
     * まだスクリプトが走っていないので捨てられる（設定資料パネルの
     * `whenReady` と同じ事情）。
     */
    let webviewReady = false;
    /** この画面から届いた便のうち、いちばん新しい番号（同期の前の待ち。設計書5.5.19） */
    let lastReceivedSeq = 0;
    let pendingReveal: { line: number; caret: RevealCaret } | undefined;
    /** 読み上げの列を頼まれたが、画面がまだ動き出していない（設計書6.42） */
    let pendingReading = false;
    const revealLineNow = (line: number, caret: RevealCaret): void => {
      void panel.webview.postMessage({ type: "revealLine", line, caret });
    };
    const showReadingNow = (): void => {
      void panel.webview.postMessage({ type: "showReading" });
    };
    /** 前の話から持って来た見た目。画面が動き出す前に頼まれたら覚えておく */
    let pendingApply: ManuscriptAppearance | undefined;
    const applyAppearanceNow = (next: ManuscriptAppearance): void => {
      void panel.webview.postMessage({ type: "applyAppearance", appearance: next });
    };
    const key = manuscriptLedgerKey(document.uri);
    const entry = {
      panel,
      revealLine: (line: number, caret: RevealCaret = "head"): void => {
        /*
          **飛んだ先を、こちらで「最後のカーソル」として覚える**（設計書6.40.4。
          画面の自動テスト `sceneMemoJumps.test.ts` で見つかった、2026-10-04）。
          画面のカーソルの知らせを待つと、2つの理由で古い起点が残る。
          ・画面は同じ行に居るあいだは知らせない（`lastCaretLine`）。前に一度
            知らせた行へ飛ばされると黙ったままで、［次へ］が前の話から数え直し、
            同じ行へ何度も戻された（4回目の［次へ］で止まった）
          ・開いたばかりの面の知らせは遅れて届く（2.5秒かかった例がある）
          飛ぶ先はここで決まっているので、知らせを待つ理由が無い。
          作者があとでカーソルを動かせば、その知らせで上書きされる
        */
        if (line > 0) {
          lastCaret = { filePath: fromUri(document.uri), line };
        }
        if (!webviewReady) {
          pendingReveal = { line, caret };
          return;
        }
        /*
          **本文の便が待っていたら、先に送ってから示す**（2026-10-03）。
          メモの行を足した直後（Ctrl+/）は、本文の便（scheduleSend の120ミリ秒）
          より先に「この行を示す」が画面へ着き、あとから着いた本文で組み直す
          ときに、カーソルが元の位置（字数で数えた所）へ戻されていた
        */
        if (sendTimer) {
          void sendNow().then(() => revealLineNow(line, caret));
          return;
        }
        revealLineNow(line, caret);
      },
      showReading: (): void => {
        if (!webviewReady) {
          pendingReading = true;
          return;
        }
        showReadingNow();
      },
      refreshCounts: (): void => {
        void this.sendFootCounts(panel, document);
      },
      refreshKind: async (): Promise<void> => {
        measureKind = await this.kindOfDocument(document);
        // 画面が動き出す前なら送らない（`ready` で最初の字数と一緒に届く）
        if (!webviewReady) return;
        await this.sendCount(
          panel,
          toLf(document.getText()),
          document,
          measureKind
        );
      },
      document,
      appearance: (): ManuscriptAppearance | undefined => appearanceNow,
      applyAppearance: (next: ManuscriptAppearance): void => {
        // **`revealLine` と同じで、`ready` を待ってから送る**
        if (!webviewReady) {
          pendingApply = next;
          return;
        }
        applyAppearanceNow(next);
      },
      status: {} as ManuscriptEditorStatusState,
      settle: async (timeoutMs: number): Promise<ManuscriptSettle> => {
        // 画面が「届いていない」と知らせている（受け手を失った等）。待っても入らない
        if (entry.status.report?.unsent) return "unsent";
        if (lastReceivedSeq === 0) return "applied";
        /*
          「入れられなかった」（rejected）は、画面が見回りで送り直す。通れば
          見張りは「入った」へ戻るので、ここで止めても行き止まりにはならない。
          重なって画面の控え（［戻す］の帯）へ回した便は「入った」扱いで返る
          ——どちらを採るかは作者が帯で選ぶもので、同期では待たない
        */
        return appliedTracker.waitFor(lastReceivedSeq, timeoutMs);
      },
    };
    /*
      **同じ原稿の2枚目なら、記録に残す**（6.25.11）。2026-10-03 の実機では、
      何が2枚目を開いたのかを示す行が1つも無く、台帳から落ちた理由を
      追えなかった。2枚目そのものは止めない——縦と横を並べて見比べたい
      作者もいる。こちらの道（飛ぶ・読み上げ）が2枚目を作らないようにしてある。
      **タブの数でも見る**——拡張機能ホストを起動し直したあとは台帳が空で、
      切れた面の隣に同じ原稿の面がつながっても、台帳だけでは1枚目に見える
    */
    const already = openManuscripts.all(key).length;
    openManuscripts.add(key, entry);
    const faceNote = sameManuscriptFaceNote({
      ledgerFaces: already,
      tabColumns: manuscriptTabColumns(key),
      viewType: this.viewType,
      column: panel.viewColumn,
    });
    if (faceNote) {
      // 載せてから書く（ログの作品を引く await で、台帳に載るのを遅らせない）。
      // 書き先は作品へ向けてから書く（起動し直した直後は、まだどこへも向いていない）
      void this.logForDocument(document, faceNote);
    }
    // 窓の札に「受け持っている原稿エディター」が増えた
    fireManuscriptStatusChanged();
    panel.onDidDispose(() => {
      // **閉じた面だけを外す。** 鍵ごと消すと、同じ原稿のもう1枚が
      // 開いたまま台帳から落ちる（2026-10-03 の不具合）
      openManuscripts.remove(key, entry);
      if (lastFrontPanel === panel) lastFrontPanel = undefined;
      fireManuscriptStatusChanged();
    });
    // 開いた瞬間に前へ出ている面は、前に出た知らせ（onDidChangeViewState）が
    // 来ないことがあるので、ここでも覚える
    try {
      if (panel.active) lastFrontPanel = panel;
    } catch {
      // 試験の代役など、active を読めない面では覚えない
    }

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
    /**
     * 待っている便を取りやめ、いま送る（まとめて送る120ミリ秒を待てないとき）。
     * 失敗は握って返す（呼び出し側は続きの処理を止めない）
     */
    const sendNow = (): Promise<void> => {
      if (sendTimer) {
        clearTimeout(sendTimer);
        sendTimer = undefined;
      }
      return send().catch(() => undefined);
    };

    /**
     * 取り消し・やり直しで戻ったとき、カーソルを置く場所（LF空間の位置）。
     *
     * **取り消しは「外からの書き換え」ではない**（作者の実機報告、2026-09-15。
     * 設計書6.25.8）。画面は届いた本文と手元の本文の差を見て、
     * **共通部分より後ろのカーソルを増減分だけずらす**——別の窓で前に文字が
     * 足されたときは正しいが、**取り消しでは二重に動く**。
     *
     * 作者の言葉：「カーソルが復元する箇所より後ろでだけ起きています。
     * 復元で増えた文字数分、後ろにうごいている印象です」——これは
     * まさにその式（`at + delta`）そのものである。
     *
     * そこで、取り消し・やり直しのときだけ**置くべき位置を添えて送る**。
     * ふつうのエディタと同じで、**戻した箇所へカーソルが行く**のが正しい。
     */
    let undoCaret: number | undefined;
    /*
      外からの変更の記録は、**ひと続きの最初の1回だけ**書く（0.81.4）。
      同じ原稿を普通のエディタでも開いて打つと、1文字ごとに1行入っていた。
      5秒手が止まれば、ひと続きが終わったと見る
    */
    const externalChangeGate = createBurstGate(5000);

    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== document.uri.toString()) return;
        /*
          **取り消し・やり直しは、外からの書き換えと分ける**（設計書6.25.8）。
          戻した箇所の**うしろの端**へカーソルを置く（ふつうのエディタと同じ）。
          複数の変更がまとまって届くので、**いちばん後ろの変更**を採る。
        */
        const undone =
          event.reason === vscode.TextDocumentChangeReason.Undo ||
          event.reason === vscode.TextDocumentChangeReason.Redo;
        if (undone && event.contentChanges.length > 0) {
          const last = event.contentChanges[event.contentChanges.length - 1];
          // **LF空間で数える**（画面へはLFで渡すため。core/eolSpace.ts）
          undoCaret = toLfOffset(
            document.getText(),
            last.rangeOffset + last.text.length
          );
          void this.logForDocument(
            document,
            `原稿エディタ：${event.reason === vscode.TextDocumentChangeReason.Undo ? "取り消し" : "やり直し"}で戻ったので、カーソルを戻した箇所（${undoCaret}文字目）へ置きます`
          );
        }
        // **外からの変更は、送った事実をログに残す**（実機確認 A-20）。
        // 画面が古いままという報告があり、こちらが送っていないのか、
        // 画面が捨てているのかを切り分ける手がかりが無かった。
        // 自分の applyEdit による変更は毎打鍵で起きるので残さない
        if (!selfEditing && !undone && event.contentChanges.length > 0) {
          // **普通のエディタで打っている間は、ひと続きの最初の1回だけ**（0.81.4）。
          // 前のひと続きで書かなかった回数を添える（黙って減らさない）
          const burst = externalChangeGate.hit(Date.now());
          if (burst) {
            void this.logForDocument(
              document,
              `原稿エディタ：${paths.basename(fromUri(document.uri))} が外で変わったので画面へ送り直します（${event.contentChanges.length}か所）` +
                (burst.skippedBefore > 0
                  ? `。前の続けざまの変更${burst.skippedBefore}回は記録を省きました`
                  : "")
            );
          }
        }
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

    // **見た目の設定を変えたら、その場で効かせる**（設計書6.25.3）。
    // 0.19.0の書体の設定は、変えても**開き直すまで効かなかった**。
    // 設定を直したのに何も起きなければ、作者は壊れていると受け取る
    subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("novelai.manuscriptEditor")) return;
        void send();
      })
    );

    /**
     * **このファイルそのものを見張る**（設計書6.25.7、実機確認 A-20）。
     *
     * 本文が外から書き換わったとき（ルビの適用・AIの反映・別の窓・
     * Git の復元）、VS Code は開いている文書を読み直し、その変更が
     * `onDidChangeTextDocument` で届いて画面へ送り直される——はずだが、
     * **ワークスペースの外にある本文は、タブが裏に回っていると読み直されない**
     * （本物の VS Code 1.90 で測った、2026-09-07。ワークスペースの中なら
     * 裏でも読み直される）。ファイル1本ぶんの監視を張るだけで、VS Code は
     * 外の本文も読み直すようになる（同じ実験で確認）。
     *
     * 監視の知らせそのものは使わない。読み直しは VS Code に任せ、
     * こちらは少し待ってから「本当に読み直されたか」を見て、
     * 読み直されていなければログに残す（原因を追う手がかり）。
     */
    try {
      const filePath = fromUri(document.uri);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          paths.toUri(paths.dirname(filePath)),
          paths.basename(filePath)
        )
      );
      let verifyTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleVerify = () => {
        if (verifyTimer) clearTimeout(verifyTimer);
        verifyTimer = setTimeout(() => {
          verifyTimer = undefined;
          void this.verifyReloaded(document);
        }, 1500);
      };
      watcher.onDidChange(scheduleVerify);
      watcher.onDidCreate(scheduleVerify);
      subscriptions.push(
        watcher,
        new vscode.Disposable(() => {
          if (verifyTimer) clearTimeout(verifyTimer);
        })
      );
    } catch {
      // 監視を張れない環境（古い VS Code・試験の代役）では、これまでどおり
      // VS Code の読み直しだけに頼る
    }

    // **表示に戻ったら送り直す。** 裏に回っているあいだに届いた変更を
    // 画面が取りこぼしていても、見えた瞬間に文書の中身へ揃う
    subscriptions.push(
      panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible) {
          void send();
          /*
            **下段（作品の合計・今日・一言）も測り直す**（2026-09-25）。
            裏にいたあいだに別の話の保存で目標に届いても、この画面の一言は
            開いたときのままだった（第1話には出て第2話には出なかった）。
            日が替わったあとの古い一言もここで消える
          */
          void this.sendFootCounts(panel, document);
        }
        // 前面に来た＝この話を書き始めた。右に単話プロットが見えていれば、
        // この話のものへ切り替えてもらう（設計書6.36。片方向）
        if (event.webviewPanel.active) {
          // 前に出た面を「最後に使った面」にする（同じ原稿の面が2枚あるとき、
          // 飛ぶ先として選ぶ。6.25.11）
          openManuscripts.touch(key, entry);
          // 開いていない話へ飛ぶときの向きは、この面に揃える（6.25.11）
          lastFrontPanel = panel;
          const filePath = fromUri(document.uri);
          this.deps.onManuscriptShown?.(
            filePath,
            document.getText(),
            lastCaret?.filePath === filePath ? lastCaret.line : 0
          );
        }
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
    /** 自分の書き換えを文書へ当てている最中か（外からの変更と見分ける） */
    let selfEditing = false;
    /**
     * どの便まで当て終えたか（［保存］が、頼まれた便まで待ってから保存する
     * ために使う。設計書6.25.9、作者の裁定 2026-10-01）
     */
    const appliedTracker = createAppliedTracker();
    /**
     * **入ったかどうかを、便の番号で画面へ返す**（設計書6.25.9。作者の報告、
     * 2026-09-28「×ボタンで消したら400文字ぐらいが消えました」）。
     *
     * 画面は、返事の来ない便があると帯を出して送り直す。こちらが入れられ
     * なかったときも ok:false で返し、**画面にだけ字が残っている**ことを
     * 作者に見える形にする。
     */
    const reportApplied = (ack: EditAck): void => {
      // 窓の札の「最後に入った時刻」。札を書き直す合図にはしない（打鍵のたびに来る）
      if (ack.ok) entry.status.lastAppliedAt = new Date();
      appliedTracker.markApplied(ack.seq, ack.ok);
      try {
        void Promise.resolve(panel.webview.postMessage(ack)).catch(() => {
          /* 閉じたあとに届いた便。返す先はもう無い */
        });
      } catch {
        // 閉じた画面へは返せない（閉じる直前に送った便が遅れて着いたとき）
      }
    };
    /**
     * 1便を当てる（設計書6.25.9。作者の裁定「塞ぐ」、2026-10-04）。
     *
     * 便の元の本文が今の文書と違えば、**画面がまだ知らない変更**（傍点を外した・
     * 提案を当てた・メモの行を足した等。画面へは `scheduleSend` の120ミリ秒で
     * 遅れて届く）がある。そのまま差を当てると、その変更が戻る。打った所だけを
     * 今の文書へ当て直し、重なって当て直せなければ当てずに画面へ控えさせる。
     */
    const applyScreenEdit = async (item: SentEdit): Promise<ApplyOutcome> => {
      // 読んでから当てるまで待ちを挟まない（間に本体の変更が入ると、判断が古くなる）
      const decision = ledger.decide(item, toLf(document.getText()));
      if (decision.kind === "conflict") {
        ledger.rememberRejected(item.text, decision.baseKey);
        void this.logForDocument(
          document,
          decision.reason === "overlap"
            ? `原稿エディタ：打った字が、画面へまだ届いていない変更と同じ所に重なったので、原稿へ入れずに画面の控えへ回しました（${item.text.length}字。画面の［戻す］で打った字のほうへ戻せます）`
            : `原稿エディタ：打った字の元になった本文が分からないので、原稿へ入れずに画面の控えへ回しました（${item.text.length}字。画面の［戻す］で打った字のほうへ戻せます）`
        );
        /*
          画面へ今の本文を届ける（届かないと、画面は古い本文の上に打ち続ける）。
          **断った直後だけは待たずに送る**（作者の裁定、2026-10-04。設計書6.25.9）。
          120ミリ秒まとめる送り（scheduleSend）は続く変更で延びるので、届く前に
          作者が［それでも戻す］を押すと、画面は古い本文を元にした便を送り、
          もう一度断られていた
        */
        sendNow();
        return "conflict";
      }
      const ok = await this.applyEdit(document, decision.text);
      if (ok) {
        ledger.rememberApplied(item.text);
        if (decision.rebased) {
          void this.logForDocument(
            document,
            "原稿エディタ：画面へまだ届いていない変更があったので、打った字をその変更のあとの本文へ当て直しました"
          );
        }
      } else {
        ledger.rememberRejected(item.text, decision.baseKey);
      }
      return ok;
    };
    const queueEdit = createEditQueue<SentEdit>(
      async (item) => {
        selfEditing = true;
        let outcome: ApplyOutcome = false;
        try {
          outcome = await applySentEdit(
            item,
            () => applyScreenEdit(item),
            reportApplied,
            (error) =>
              logLine(
                `原稿エディタ：打った内容を文書へ当てる途中で失敗しました：${
                  error instanceof Error ? error.message : String(error)
                }`
              )
          );
        } finally {
          selfEditing = false;
        }
        if (outcome === false) this.warnEditRejected(document);
      },
      // 当てている間に届いた便は、元の本文をつなげて畳む（core/editQueue.ts）
      (older, newer) => combineSentEdits(older, newer, textFingerprint)
    );

    panel.webview.onDidReceiveMessage(async (message: Incoming) => {
      /*
        **この画面から何か届いた時刻を覚える**（窓の札。作者の裁定 2026-10-01）。
        届かなくなった（拡張機能ホストが受け取れない）ことを外から推し量るため。
        札を書き直す合図にはしない——打鍵のたびに保管庫へ書くことになる
      */
      const heardAt = new Date();
      entry.status.lastHeardAt = heardAt;
      lastHeardFromAnyManuscript = heardAt;
      switch (message.type) {
        case "unsentStatus": {
          // 決めた項目だけを拾う（本文が混ざっていても札へ流さない）
          const report = parseManuscriptStatusMessage(message.status);
          if (!report) break;
          entry.status.report = report;
          entry.status.reportedAt = heardAt;
          fireManuscriptStatusChanged();
          break;
        }

        case "ready":
          /*
            **開くときの見た目は、最初の update に添えて渡す**（設計書6.25.5）。
            画面が覚えていた値（message.saved）はここで初めて届く。
            前の話から持って来た値は**1回きり**で、取り出したら消える。
          */
          initialAppearance = resolveInitialAppearance({
            saved: message.saved,
            carry: takeCarriedAppearance(pendingAppearance, key),
            ...readOrientation(this.orientation),
          });
          // ［開き直す］で預かった控えも、立ち上がりの1回だけ取り出す
          carriedRescue = pendingRescue.get(key);
          pendingRescue.delete(key);
          await send();
          webviewReady = true;
          // 開くのを待ってもらっていた「この行を示す」を、ここで出す
          if (pendingReveal !== undefined) {
            const { line, caret } = pendingReveal;
            pendingReveal = undefined;
            revealLineNow(line, caret);
          }
          // 待ってもらっていた「前の話の見た目を当てる」を、ここで出す
          if (pendingApply) {
            const next = pendingApply;
            pendingApply = undefined;
            applyAppearanceNow(next);
          }
          // 開くのと同時に頼まれていた「読み上げの列」を、ここで出す
          if (pendingReading) {
            pendingReading = false;
            showReadingNow();
          }
          // 「次の話」で新しく開いた画面は、前面に来た知らせ（ViewState）が
          // 出ない。立ち上がった時点で、右の単話プロットに追いついてもらう
          if (panel.active) {
            this.deps.onManuscriptShown?.(
              fromUri(document.uri),
              document.getText(),
              0
            );
          }
          // 下段の字数は**本文より後**でよい（作品ぜんたいの走査が要る）。
          // 待たせると、開いた直後の本文の表示まで遅れる
          void this.sendFootCounts(panel, document);
          // 読み仮名の入った .txt なら、MD化を勧める（作者の指示、2026-08-29）
          void this.suggestMarkdown(document);
          // 改行コードが作品の多数派と違うなら、1度だけ知らせる
          // （作者の依頼、2026-09-12。設計書5.4.2）
          void this.noticeEolMismatch(document);
          break;

        case "edit":
          // 番号の付いた便は、同期の前の待ち（settle）がこの番号まで待つ
          if (typeof message.seq === "number" && message.seq > lastReceivedSeq) {
            lastReceivedSeq = message.seq;
          }
          await queueEdit({
            text: message.text,
            ...(typeof message.seq === "number" ? { seq: message.seq } : {}),
            ...(typeof message.base === "string" ? { base: message.base } : {}),
          });
          break;

        case "count":
          await this.sendCount(panel, message.text, document, measureKind);
          break;

        case "saveRequest":
          await this.saveFromButton(document, panel, message.seq, appliedTracker);
          break;

        case "ruby":
          await this.insertRuby(document, panel, message, "ruby");
          break;

        case "emphasis":
          await this.insertRuby(document, panel, message, "emphasis");
          break;

        case "copyForPosting":
          await this.copyForPosting(document, message.line ?? 0, {
            start: message.start ?? -1,
            end: message.end ?? -1,
          });
          break;

        case "copyNotation": {
          // **記法をそのまま写すだけ。** 変換も検証もしない
          // （投稿サイト用の変換は `copyForPosting` の仕事）
          if (message.text.length === 0) break;
          await vscode.env.clipboard.writeText(message.text);
          notifyDone(
            `選んだ${message.text.length.toLocaleString("ja-JP")}字を、` +
              "ルビと傍点の記法のままクリップボードへ入れました。"
          );
          break;
        }

        case "clipboardRead": {
          // 読めなければ空で返す（画面が「貼れる字がありません」と出す）。
          // 返さないと、画面は頼んだまま待ち続ける
          let text = "";
          try {
            text = await vscode.env.clipboard.readText();
          } catch (error) {
            logLine(
              `原稿エディター：クリップボードを読めませんでした（${
                error instanceof Error ? error.message : String(error)
              }）`
            );
          }
          await panel.webview.postMessage({ type: "clipboardText", text });
          break;
        }

        case "clipboardWrite": {
          let ok = false;
          if (typeof message.text === "string" && message.text.length > 0) {
            try {
              await vscode.env.clipboard.writeText(message.text);
              ok = true;
            } catch (error) {
              logLine(
                `原稿エディター：クリップボードへ写せませんでした（${
                  error instanceof Error ? error.message : String(error)
                }）`
              );
            }
          }
          if (typeof message.id === "number") {
            await panel.webview.postMessage({ type: "clipboardWritten", id: message.id, ok });
          }
          break;
        }

        case "openTerm": {
          const found = await this.deps.highlighter.indexFor(
            fromUri(document.uri)
          );
          if (!found) {
            // **黙って戻らない**（作者の報告、2026-08-28「用語上で右クリック
            // したとき、パネルの説明は切り替わりません」）。ここで落ちると
            // 押しても何も起きないので、どこで止まったかを残す
            logLine(
              "原稿エディタ：右クリックの設定資料——この原稿が属する作品を" +
                "見つけられませんでした"
            );
            return;
          }
          await this.deps.openSettings(found.work, message.kind, message.id, {
            filePath: fromUri(document.uri),
          });
          break;
        }

        case "previewTerm": {
          // 右クリックの時点の追従。作品が分からなければ黙って何もしない
          // （品書き自体は出ており、openTerm 側にログがある）
          const found = await this.deps.highlighter.indexFor(
            fromUri(document.uri)
          );
          if (!found) return;
          await this.deps.previewTerm(found.work, message.kind, message.id, {
            filePath: fromUri(document.uri),
          });
          break;
        }

        case "openLatest":
          await this.openLatestEpisode(document);
          break;

        case "openNeighbor":
          await this.openNeighborEpisode(
            document,
            message.direction,
            message.line ?? 0,
            message.noCreate === true
          );
          break;

        case "pickFont":
          await pickFont(message.installed);
          break;

        case "appearance":
          // 前後の話へ移るときに、この値をそのまま次の画面へ持って行く
          // （設計書6.25.5）。覚えるのは画面の側で、こちらは写しを持つだけ
          appearanceNow = {
            vertical: message.vertical,
            size: message.size,
            compose: message.compose,
          };
          break;

        case "log":
          await this.logForDocument(document, `原稿エディタ：${message.text}`);
          break;

        case "reopen":
          await this.reopenForRescue(
            document,
            panel,
            parseManuscriptRescues(message.bands, message.rescue, key)
          );
          break;

        case "addMemo":
          await insertMemoLineAbove(document, message.line);
          break;

        case "openMemos":
          await this.deps.openSceneMemos?.(fromUri(document.uri));
          break;

        case "resumeWriting":
          await this.deps.resumeWriting?.(fromUri(document.uri));
          break;

        case "openEpisodePlot":
          await this.deps.openEpisodePlot?.(
            fromUri(document.uri),
            document.getText(),
            message.line ?? 0
          );
          break;

        case "readingPlan":
          /*
            **文へ割るのはこちら**（`core/readAloud.ts`）。画面の中に置くと
            確かめようがないうえ、ルビの記法は原稿の種類で違う（設計書6.12）。
            **本文は画面が送ってきたものをそのまま使う**——こちらの文書で
            作ると、打った直後は120ミリ秒ぶん位置がずれる。
          */
          await panel.webview.postMessage({
            type: "readingPlan",
            sentences: buildReadingPlan(message.text, notation),
            // 画面が「自分が送った本文の計画か」を確かめるための目印
            textLength: message.text.length,
          });
          break;

        case "readingMark":
          // **飛ばない**（`reveal: false`）。聞いている最中に画面が動くと、
          // どこを読んでいたのか分からなくなる
          await insertMemoLineAbove(document, message.line, {
            body: READ_ALOUD_MEMO_TEXT,
            reveal: false,
          });
          break;

        case "readingVoice":
          await this.deps.saveReadAloudVoice?.(message.name);
          break;

        case "notePreview":
          // **開いたその場で組んで返す**（次に打つまで空のままにしない）
          notePreviewWanted = message.on;
          if (notePreviewWanted) await send();
          break;

        case "caret": {
          // **覚えるのはこちら。** 画面はファイルの場所を知らない
          if (message.line > 0) {
            lastCaret = { filePath: fromUri(document.uri), line: message.line };
            this.deps.onCaretMoved?.(lastCaret.filePath, lastCaret.line);
          }
          break;
        }

        case "chat": {
          // 画面の位置はLF空間。文書の位置へ直してから範囲にする
          const source = document.getText();
          await this.deps.openChat(
            document,
            message.start >= 0 && message.end > message.start
              ? new vscode.Range(
                  document.positionAt(fromLfOffset(source, message.start)),
                  document.positionAt(fromLfOffset(source, message.end))
                )
              : undefined
          );
          break;
        }

        case "dictationClean": {
          // 画面の位置はLF空間。文書の位置へ直してから範囲にする（相談と同じ）。
          // **前後は入れ替えて受ける**——画面は「カーソルが開始より前なら
          // 文末まで」に直して送るが、逆さの範囲がここまで来ても壊さない
          const source = document.getText();
          const head = Math.min(message.from, message.to);
          const tail = Math.max(message.from, message.to);
          const range = new vscode.Range(
            document.positionAt(fromLfOffset(source, head)),
            document.positionAt(fromLfOffset(source, tail))
          );
          // **画面と文書が揃っているかを確かめてから渡す。** 打鍵が文書へ
          // 届くのは少し遅れるので、話し終えてすぐ押すと位置だけが先に着く
          // ——ずれた範囲を整えると、口述していないところまで書き換わる。
          // 比べるのはLF空間（画面はCRLFを知らない）
          if (toLf(document.getText(range)) !== message.text) {
            void vscode.window.showWarningMessage(
              "本文の反映を待っています。もう一度押してください。"
            );
            break;
          }
          await this.deps.dictationClean?.(document, range);
          break;
        }
      }
    });
  }

  /**
   * その原稿を原稿エディタで開いて、行を示す（作者の依頼、2026-08-28）。
   *
   * 「誤字脱字から開く場合は、現在メインで開いているエディターと同じ
   * エディターで開いたうえで場所を示してください」。提案パネルの「飛ぶ」は
   * 素のテキストエディタしか開かず、**縦書きで書いていた面から追い出されて
   * いた**。
   *
   * 引き受けられたときだけ true を返す。false のときは、呼んだ側が
   * これまでどおり素のエディタで開く——**押しても何も起きない、を作らない。**
   *
   * 引き受けるのは次の3つである。
   *
   * 1. その原稿を原稿エディタで開いている（前に出して、行を示す）
   * 2. 開いてはいないが、**いま見ているタブが原稿エディタ**（＝作者は
   *    この画面で書いている）。同じ向きの入口で開いてから示す
   * 3. どちらでもないが、**その原稿が登録された作品の話**である
   *    （作者の指示、2026-08-29「本文ファイルは原稿エディター横書きで開く」）。
   *    作品一覧から開いたときと同じ既定にそろえる
   *
   * 話でないファイル（プロット・設定資料）は、これまでどおり素のエディタへ譲る。
   *
   * **どの枝で降りたかを必ず残す。** 「押しても何も起きない」が実機で
   * 起きたとき（2026-08-29）、どこで止まったのかを示すものが1つも無かった。
   */
  async revealLine(filePath: string, line: number): Promise<boolean> {
    const uri = paths.toUri(filePath);
    const key = manuscriptLedgerKey(filePath);

    const open = openManuscripts.get(key);
    if (open) {
      /*
        **列を渡して前に出す**（作者の実機、2026-10-03。3回目）。列なしの
        `reveal()` は「いま前面の列」へ開く——校正・メモパネル（右の列）の行を
        押すと、右の列に同じ原稿のタブができて画面がそちらへ移り、左が空白で
        残った。新しい面は作られない（resolve されない）ので、6.25.11 の
        「2枚目」の記録にも出なかった
      */
      revealManuscriptPanelInPlace(open.panel, key);
      open.revealLine(line);
      return true;
    }
    logLine(
      `原稿エディタ：${filePath} は台帳にありません（鍵: ${key}）。開き直します。`
    );

    // タブが既にあれば、そのタブを前に出す（同じ原稿の2枚目を作らない。6.25.11）
    const viaTab = await this.revealInExistingTab(filePath, line);
    if (viaTab !== undefined) return viaTab;

    // **いま開いている向きが最優先**（縦書きで書いている人の画面を横にしない）。
    // 前に出ているのがパネル（右の列）なら、最後に前へ出ていた原稿の向きを使う
    // （向きは入口でなく画面の見た目で見る。`writingManuscriptViewType`）。
    // どちらも無ければ、その作品のタイプに合わせた入口で開く（設計書6.70）
    const episodeWork = await this.registeredEpisodeWork(filePath);
    const viewType =
      writingManuscriptViewType() ??
      (episodeWork
        ? manuscriptViewTypeFor(await kindOf(episodeWork))
        : undefined);
    if (!viewType) {
      logLine(
        `原稿エディタ：${filePath} は作品の話ではないため、素のエディタへ譲ります。`
      );
      return false;
    }

    /*
      **開く列を決めてから開く**（作者の報告、2026-09-19）。ここも列を
      渡しておらず、VS Code の既定どおり「いま前面の列」へ開いていた。
      シーンメモのパネル（原稿の右）から、まだ開いていない話へ飛ぶと、
      原稿がパネルの列へ飛び込んで左の面が置き去りになる。
      既に開いている面を前に出す道（上の `open`）も、列を渡さないと同じことが
      起きる（0.96.19 で列を渡すようにした）。
    */
    const choice = columnForLocation(filePath);
    logLine(`原稿エディタ：${filePath} を開きます（${choice.reason}）。`);
    await openManuscriptFile(uri, viewType, choice.column);
    /*
      **台帳に載るまで待つ。**

      台帳へ載せるのは `resolveCustomTextEditor` で、そちらは非同期に走る。
      `openWith` が戻った時点で載っている保証は無く、載っていないと false を
      返して、呼び出し側が**同じファイルを素のエディタでも開く**（1つの原稿が
      2つの面で開く）。開いた直後に取りに行くのが早すぎるだけなので、
      少しだけ待てばよい。
    */
    const opened = await waitFor(() => openManuscripts.get(key));
    // **開けなかったときは引き受けない。** ここで true を返すと、
    // 押しても何も起きないまま終わる（素のエディタへも行かない）
    if (!opened) {
      logLine(
        `原稿エディタ：${filePath} を開けなかったため、行を示せませんでした（鍵: ${key}）。`
      );
      return false;
    }
    opened.revealLine(line);
    return true;
  }

  /**
   * 台帳に無い原稿でも、**タブが既にあるなら、そのタブを前に出して**行を示す
   * （作者の報告、2026-10-03。設計書6.25.11）。
   *
   * 台帳に無くてもタブが残っていることがある——背景でまだ画面が作られて
   * いないタブや、台帳から落ちた面である。ここで別の入口（縦と横）や別の列を
   * 渡すと、VS Code は**同じ原稿の2枚目**を作る。同じ入口・同じ列の
   * `openWith` は前に出すだけで済む（1.138.0 で確かめた）。
   *
   * @returns タブが無ければ undefined（呼んだ側が今までどおり開く）。
   *   あれば、示せたかどうか
   */
  private async revealInExistingTab(
    filePath: string,
    line: number
  ): Promise<boolean | undefined> {
    const key = manuscriptLedgerKey(filePath);
    const existing = existingManuscriptTab(key);
    if (!existing) return undefined;
    // 前に出すのは共通の口に任せる（タブの入口と列を使う。記録もそちらが残す）
    await openManuscriptFile(filePath, existing.viewType, existing.column);
    const shown = await waitFor(() => openManuscripts.get(key));
    if (!shown) {
      // 拡張機能ホストが起動し直したあとの面は、つながり直さない。
      // 素のエディタへ譲る（切れた面の知らせは別の見張りが出す）
      logLine(
        `原稿エディタ：${filePath} のタブを前に出しましたが、画面とつながりませんでした（鍵: ${key}）。`
      );
      return false;
    }
    shown.revealLine(line);
    return true;
  }

  /**
   * その原稿が、登録された作品の「話」なら、その作品。
   *
   * **開く画面を決めるのは中身であって、拡張機能の都合ではない。**
   * 本文（話）なら原稿エディタ、それ以外（プロット・設定資料）は
   * 素のエディタ、という切り分けを、作品一覧と同じ基準で行う。
   *
   * **作品まで返す。** 開く向きの既定はタイプで決まる（設計書6.70）ので、
   * 「話かどうか」だけでは足りない。
   *
   * 走査は、その原稿を原稿エディタで開いていないときにしか通らない
   * （開いていれば台帳で当たる）ので、飛ぶたびに走ることはない。
   */
  private async registeredEpisodeWork(
    filePath: string
  ): Promise<WorkEntry | undefined> {
    try {
      const found = await this.deps.highlighter.indexFor(filePath);
      if (!found) return undefined;
      const { episodes } = await scanWork(found.work);
      const isEpisode = episodes.some((episode) =>
        samePath(episode.filePath, filePath)
      );
      return isEpisode ? found.work : undefined;
    } catch (error) {
      // **走査に失敗しても、飛べなくならない。** 素のエディタへ譲る
      logLine(
        `原稿エディタ：${filePath} が作品の話かを確かめられませんでした（${
          error instanceof Error ? error.message : String(error)
        }）。`
      );
      return undefined;
    }
  }

  /**
   * 画面の本文を文書へ返す。**変わった1か所だけ**を当てる。
   */
  /**
   * 外で書き換わった本文を、VS Code が読み直したかを確かめる。
   *
   * 読み直されていなければ画面は古いままで、そこから書くと外の変更を
   * 巻き戻しかねない（保存時の VS Code の照合で止まりはする）。直せは
   * しないので、**ログに残して原因を追えるようにする。**
   * 打ちかけ（未保存）の文書は VS Code が読み直さない決まりなので見ない。
   */
  private async verifyReloaded(document: vscode.TextDocument): Promise<void> {
    if (document.isClosed || document.isDirty) return;
    let disk: string;
    try {
      disk = (await readTextFile(fromUri(document.uri))).text;
    } catch {
      // 削除→作り直しの途中。作り直しの知らせで改めて確かめる
      return;
    }
    if (disk === toLf(document.getText())) return;
    await this.logForDocument(
      document,
      `原稿エディタ：${paths.basename(fromUri(document.uri))} が外で書き換えられましたが、VS Code が文書を読み直していません（画面が古いままの恐れ。閉じて開き直してください）`
    );
  }

  /**
   * 原稿エディタのログを、**その原稿の作品の `actions.log` へ**残す
   * （49 の指摘、2026-09-08：この画面は `useLogFile` を一度も呼んでおらず、
   * 「変換中の本文を捨てた」「外で変わった」の手がかりが出力チャンネルにしか
   * 出ていなかった——出力チャンネルは VS Code を閉じると消える）。
   *
   * 書き先は呼ぶたびに引き直す。ほかの機能が別の作品のログへ向け直して
   * いることがあるためで、覚えておくと別の作品のファイルへ書く。
   * 作品が引けなければ、これまでどおり出力チャンネルだけに出る。
   */
  private async logForDocument(
    document: vscode.TextDocument,
    text: string
  ): Promise<void> {
    try {
      const found = await this.deps.highlighter.indexFor(fromUri(document.uri));
      if (found) useLogFile(found.work.folderPath);
    } catch {
      // 作品を引けなくてもログは出す
    }
    logLine(text);
  }

  /**
   * 画面の本文を文書へ当てる。
   *
   * @returns 文書が画面の本文になったか（変わる所が無かったときも true）。
   *   画面へ「入ったか」を返すのに使う（設計書6.25.9）
   */
  private async applyEdit(
    document: vscode.TextDocument,
    next: string
  ): Promise<boolean> {
    // **差分はLF空間で取り、位置だけを文書の空間へ戻す**（core/eolSpace.ts）。
    // 文書ぜんたいをCRLFへ揃えてから差分を取ると、LFだけの行が混ざった
    // ファイルでは、その行から打った位置までが丸ごと差分になり、
    // **触っていない行の改行まで書き換わる**
    const edit = computeDocumentEdit(
      document.getText(),
      next,
      document.eol === vscode.EndOfLine.CRLF
    );
    if (!edit) return true;

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
    return applied;
  }

  /** 最後に「入れられませんでした」と知らせた時刻（原稿ごと） */
  private readonly editRejectedNotified = new Map<string, number>();

  /**
   * 打った字を文書へ入れられなかったことを、作者に知らせる（設計書6.25.9）。
   *
   * **ログだけでは足りない。** 作者はログを見ないまま閉じる（2026-09-28 の
   * 報告では、画面にだけ残った字が×で消えた）。画面の帯（届かない便を
   * 見張っている）と同じことを、VS Code の知らせでも出す——画面の側が
   * 動いていない場合にも見えるようにするため。
   *
   * **1分に1回まで。** 打つたびに失敗していると、語ごとに知らせが積もる。
   */
  /**
   * 画面の［保存］（設計書6.25.9。作者の裁定 2026-10-01）。
   *
   * **頼まれた便まで当て終わってから保存する**（順序と判定は
   * `core/manuscriptSave.ts`）。保存は VS Code の `document.save()` に任せる
   * ——文字コード・改行の保持と、外での変更との突き合わせは VS Code の
   * 保存の道がすでに持っている（Ctrl+S と同じ道。原稿へ自前で書かない）。
   *
   * 結果は字数つきで画面へ返し、操作ログへ1行残す。返せなくても（画面が
   * 閉じた）記録は残す。
   */
  private async saveFromButton(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    seq: number,
    tracker: AppliedTracker
  ): Promise<void> {
    const target = typeof seq === "number" ? seq : 0;
    /*
      **受け取ったその場で受付を返す**（本体の判断、2026-10-01）。画面は受付を
      3秒、結果を30秒待つ。結果だけを返すと、保存に時間がかかったときに
      「拡張機能に届いていません」と誤って出る
    */
    try {
      await panel.webview.postMessage({ type: "saveAccepted", seq: target });
    } catch {
      // 閉じた画面へは返せない。保存は続ける（頼まれた保存はする）
    }
    const result = await runSaveRequest(target, {
      waitApplied: (target) => tracker.waitFor(target, SAVE_APPLY_WAIT_MS),
      isDirty: () => document.isDirty,
      save: () => Promise.resolve(document.save()),
      // 下の欄の「このファイル」と同じ数え方（画面に出す数と食い違わせない）
      chars: () => countForDisplay(toLf(document.getText()), extensionOf(document)),
    });
    await this.logForDocument(
      document,
      `原稿エディタ：${paths.basename(fromUri(document.uri))} を${describeSaveResult(result)}`
    );
    try {
      await panel.webview.postMessage(result);
    } catch {
      // 閉じた画面へは返せない。記録は上で残した
    }
  }

  private warnEditRejected(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const now = Date.now();
    const last = this.editRejectedNotified.get(key);
    if (last !== undefined && now - last < 60_000) return;
    this.editRejectedNotified.set(key, now);
    const name = paths.basename(fromUri(document.uri));
    void this.logForDocument(
      document,
      `原稿エディタ：${name} へ打った字を入れられませんでした。画面にだけ字が残っています`
    );
    void vscode.window.showWarningMessage(
      `原稿エディターで打った字を「${name}」へ入れられませんでした。` +
        "画面の字はまだ原稿ファイルに入っていません。閉じる前に、画面の上に出ている" +
        "「本文をコピー」で控えてください。"
    );
  }

  private async sendCount(
    panel: vscode.WebviewPanel,
    text: string,
    // 画面から届く本文にはファイル名が付いていないので、開いている文書から取る
    document: vscode.TextDocument,
    /** 作品の種類（設計書6.109）。小説・不明なら目安を添えない */
    kind?: WorkKindKey
  ): Promise<void> {
    const ext = extensionOf(document);
    const value = countForDisplay(text, ext);
    /*
      種類ごとの目安（台本の分数・漫画のページ数など）。**字数と同じ数え方の
      本文**（頭書きを外し、ルビは .md のときだけ外す）から測る——字数と
      目安が別の本文を見ていると、同じ話で数字が噛み合わなくなる
    */
    const measure = kind
      ? measureKindText(
          kind,
          text,
          countEpisodeChars(text, { ext, excludeRuby: excludeRubyFromCount() })
        )?.short
      : undefined;
    await panel.webview.postMessage({
      type: "count",
      ...(measure ? { measure } : {}),
      // **下段の「このファイル」はこの数字を使う**（作者の指示、2026-08-29）。
      // 画面側で数え直すと、純／総の設定やルビの扱いが食い違う。
      // 上の帯にも同じ字数を出していたが、重複なので消した（同日の指示）
      value,
    });
  }

  /**
   * 下段の「作品 ◯◯字 ／ 今日 +◯◯字」を送る（作者の指示、2026-08-29）。
   *
   * **打鍵ごとには送らない。** 開いたときと、保存を記録し終えたとき
   * （`refreshManuscriptCounts`）の2回だけ。作品の合計は全話の走査が要り、
   * 1打鍵ごとに数え直すと打つ手が止まる。その間の増減は、画面側が
   * 「このファイルの字数の差」を足して見せる。
   *
   * `fileAtBase` を一緒に送るのは、その差を取るための基準である
   * （測った瞬間のこのファイルの字数）。
   */
  private async sendFootCounts(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument
  ): Promise<void> {
    const filePath = fromUri(document.uri);
    const found = await this.deps.highlighter.indexFor(filePath);
    // 作品に属さない原稿では、このファイルの字数だけを出す（作品も今日も無い）
    if (!found) return;

    try {
      const stats = await this.deps.workStats(found.work);
      const today = await this.deps.todayFileCount(found.work, filePath);
      const cheer = await this.deps.cheerFor?.(found.work);
      await panel.webview.postMessage({
        type: "counts",
        cheer,
        workTotal: pickCount(stats.totals, currentCountMode()),
        fileAtBase: countForDisplay(
          toLf(document.getText()),
          extensionOf(document)
        ),
        today,
      });
    } catch (error) {
      // **字数が出ないだけで、書くほうは止めない。** 黙って諦めずに残す
      logLine(
        `原稿エディタ：下段の字数を出せませんでした（${
          error instanceof Error ? error.message : String(error)
        }）。`
      );
    }
  }

  /**
   * 読み仮名の入った `.txt` を開いたら、MD化を勧める（作者の指示、2026-08-29）。
   *
   * **控えめに1度だけ。** 断られたらそのファイルでは二度と出さないし、
   * 断られていなくても、同じ画面で開き直すたびには出さない
   * （`markdownAsked`）。毎回促すと、案内そのものが邪魔になる。
   */
  private async suggestMarkdown(document: vscode.TextDocument): Promise<void> {
    const filePath = fromUri(document.uri);
    if (markdownAsked.has(paths.pathKeyForComparison(filePath))) return;

    const counts = countSiteNotation(document.getText());
    if (
      !shouldSuggestMarkdown(filePath, counts, this.deps.markdownDeclined())
    ) {
      return;
    }
    markdownAsked.add(paths.pathKeyForComparison(filePath));

    const picked = await suggestAction({
      message: describeMarkdownSuggestion(counts),
      runLabel: ".mdにする",
      laterLabel: "今はしない",
      remember: { id: "suggest.markdownConversion" },
    });
    if (picked === "later") {
      await this.deps.declineMarkdown(filePath);
      return;
    }
    if (picked !== "run") return;

    /*
      **先に保存する。** 変換はディスク上のファイルの名前を変えるので、
      打ちかけを抱えたまま変えると、その中身は行き場を失う（開いていた面が
      無くなったファイルを指したままになる）。操作メニューからのMD化も
      同じ手順を踏んでいる（`saveDirtyDocumentsBeforeExtraction`）。
    */
    if (document.isDirty && !(await document.save())) {
      void vscode.window.showWarningMessage(
        "保存できなかったため、.md にしませんでした。" +
          "保存してから、詳細メニューの「本文 .md 化」でお試しください。"
      );
      return;
    }

    const converted = await this.deps.convertToMarkdown(filePath);
    if (!converted) return;

    /*
      **元の .txt の面は、変換そのものが閉じている**（0.75.4）。

      以前はここで閉じていたが、そうすると**促しから変換したときだけ**
      面が閉じ、詳細メニューや右クリックからでは残っていた。始末は
      変換の唯一の口（`renamePreservingContent` → `closeRenamedManuscript`）
      へ移してある。閉じる時点は変わらない（新しい .md を開く前）。
    */

    // 変換すると元のファイルは消える（名前が変わる）。同じ入口で開き直す
    await this.openAsManuscript(converted);
  }

  /**
   * 改行コードが作品の多数派と違ったら、1度だけ知らせる
   * （作者の依頼、2026-09-12。設計書5.4.2）。
   *
   * **こちらからは変えない。** 出すのは案内と「作品ごと揃える」の入口だけで、
   * 実際に書き換えるのは作者が押したときである（保持が原則）。
   *
   * **同じファイルには、この起動中は1度だけ**（`eolNoticeShown`）。
   * 開き直すたびに出すと、案内そのものが読まれなくなる。
   */
  private async noticeEolMismatch(
    document: vscode.TextDocument
  ): Promise<void> {
    const filePath = fromUri(document.uri);
    const key = paths.pathKeyForComparison(filePath);
    if (eolNoticeChecked.has(key)) return;

    // **作品に属さない原稿では出さない。** 比べる相手（多数派）が無い
    const work = this.deps.workOf(filePath);
    if (!work) return;

    // **調べる前に印を付ける。** 揃っていたファイルにも印が残るので、
    // 開き直すたびに全話を読み直すことがなくなる
    eolNoticeChecked.add(key);

    let entries;
    try {
      const episodes = await this.deps.workEpisodes(work);
      entries = episodes.map((episode) => ({
        filePath: episode.filePath,
        eol: episode.eol ?? null,
        hasMixedEol: episode.hasMixedEol ?? false,
      }));
    } catch {
      // 走査できなくても、書くほうは止めない
      return;
    }

    const mine = entries.find(
      (entry) => paths.pathKeyForComparison(entry.filePath) === key
    );
    if (!mine || mine.eol === null) return;

    const audit = auditEol(entries);
    if (audit.majority === null) return;
    const differs = audit.differing.some(
      (differing) => paths.pathKeyForComparison(differing) === key
    );
    if (!differs) return;

    const majorityCount = entries.filter(
      (entry) =>
        !entry.hasMixedEol &&
        entry.eol === audit.majority &&
        paths.pathKeyForComparison(entry.filePath) !== key
    ).length;

    const picked = await suggestAction({
      message: describeEolMismatch({
        eol: mine.eol,
        hasMixedEol: mine.hasMixedEol,
        majority: audit.majority,
        majorityCount,
      }),
      runLabel: "作品ごと揃える",
      laterLabel: "今はしない",
      remember: { id: "suggest.eolUnify" },
    });
    if (picked !== "run") return;

    // **作品を指定して呼ぶ。** 引数無しだと作品選択からやり直させてしまう
    await vscode.commands.executeCommand("novelai.unifyEol", {
      type: "work" as const,
      work,
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
    const filePath = fromUri(document.uri);

    /*
      **傍点の付いた所で押されたら、外す**（作者の裁定、2026-10-03。設計書6.34.2）。
      `.txt` の確認より先に見る——`.txt` の傍点（《《強調》》）は付けられないが、
      外すのは字を残すだけなので、どちらの書き方でも迷わない。
    */
    if (
      kind === "emphasis" &&
      message.start >= 0 &&
      (await this.removeEmphasisIfAny(document, panel, message))
    ) {
      return;
    }

    /*
      **ルビは `.txt` でも入れられる**（作者の裁定、2026-09-15。0.64.6）。
      `.txt` には投稿サイトの書き方（`｜漢字《かんじ》`）で入るので、
      そのまま貼れば今までどおりルビになる——**書き方をファイルに合わせる**
      ことで、「投稿サイトから持ってきた形をそのまま保つ」という元の狙いは
      保たれる。

      **傍点だけは `.md` のまま。** `.txt` の傍点はサイトごとに書き方が違い
      （カクヨムは `《《強調》》`、なろうは `｜強調《・・》`）、
      どちらで書くかを決められない。
    */
    if (kind === "emphasis" && !filePath.toLowerCase().endsWith(".md")) {
      void vscode.window.showWarningMessage(
        `${label}はMarkdown（.md）のファイルで使えます。`,
        {
          modal: true,
          detail:
            "テキスト（.txt）では、傍点の書き方が投稿サイトごとに違うため、" +
            "どちらで書くかを決められません。\n" +
            "（ルビを振る・直すのは .txt のままでもできます）\n\n" +
            // **できない約束をしない**（0.51.8。作者の報告、2026-09-08）。
            // ここは「中身は1文字も変わりません」と言っていたが、MD化は
            // 投稿サイトの書き方のルビ・傍点を直す（設計書6.12.4）。
            // 言い方は `core/markdownConversion.ts` の促しと揃える
            "詳細メニューの「作品執筆 → 原稿整備 → 本文 .md 化」で" +
            "変えられます（変わるのは読み仮名の書き方だけで、" +
            "本文の言葉は1文字も変わりません）。",
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

    // 画面の位置はLF空間なので、文書の位置へ直してから使う。
    // 直さないと、CRLFの原稿では1行につき1文字ずつ後ろを指し、
    // 下の「今もその文字か」の確認が必ず落ちてルビが振れなかった
    const original = document.getText();
    let start = fromLfOffset(original, message.start);
    let end = fromLfOffset(original, message.end);
    let base = message.text;

    /*
      **すでにルビがあるところで「ルビを振る」は、編集である**（設計書6.34.2）。
      作者の報告（2026-09-12）：「ルビがあるところを選択してルビを打とうとすると、
      重ねられませんと出ます。ユーザーがその操作をするときは編集したいんだと
      思います」。どの記法を指しているかの判定は `findRubyAt` の1か所に置く。

      **編集にするのは、選択が記法の内側に収まっているときだけ。**
      `あ{漢字|かんじ}い` を丸ごと選んだときに編集にすると「あ」「い」が
      黙って落ちるし、新規に振ると記法が入れ子になる。どちらも原稿を壊すので、
      はみ出す選択は何もせずに断る。
    */
    const nearby =
      kind === "ruby" ? findRubyAt(original, start, end) : undefined;
    if (nearby && !nearby.contained) {
      void vscode.window.showInformationMessage(
        "ルビの上には重ねられません。ルビを1つだけ選ぶと読みを直せます。"
      );
      return;
    }
    const editing = nearby;
    if (editing) {
      start = editing.start;
      end = editing.end;
      // 照合（下の「今もその文字か」）は記法まるごとで行う
      base = original.slice(editing.start, editing.end);
    }

    if (!editing && start === end) {
      if (kind === "emphasis") {
        void vscode.window.showInformationMessage(
          "傍点を付ける文字を選んでから実行してください。"
        );
        return;
      }
      // ルビは、直前の漢字のまとまりを拾う（普通のエディタと同じ扱い）
      const before = original.slice(0, start);
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
    if (editing) {
      const reading = await askText({
        title: `「${editing.base}」の読みを直す`,
        prompt: "空にして確定すると、ルビを外します",
        // いまの読みを入れておく。直したいのは多くの場合1文字である
        value: editing.reading,
        placeHolder: "よみがな",
        // **空だけは通す**（ルビを外す道）。それ以外の検算は今までどおり
        validateInput: (value) =>
          value.trim()
            ? (validateRuby(editing.base, value) ?? undefined)
            : undefined,
      });
      // Esc（undefined）は何もしない。空文字は「外す」なので通す
      if (reading === undefined) return;
      // **元の書き方のまま戻す**（0.64.6）。`.txt` の `｜漢字《かんじ》` を
      // `{漢字|かんじ}` に変えると、投稿サイトへ貼ってもルビにならない
      inserted = rubyEditReplacement(editing.base, reading, editing.notation);
    } else if (kind === "ruby") {
      const reading = await askText({
        title: `「${base}」の読み`,
        prompt: "ひらがな・カタカナで入力してください",
        placeHolder: "よみがな",
        validateInput: (value) => validateRuby(base, value) ?? undefined,
      });
      if (!reading) return;
      // **書き方はファイルの種類で決める**（0.64.6）
      inserted = rubyEditReplacement(
        base,
        reading,
        rubyNotationFor(filePath)
      );
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
    // **入れられたかを確かめる。** 直前のハッシュ照合を通っても、
    // 書き込みそのものは失敗しうる（文書が閉じられた・読み取り専用）。
    // 見ないまま先へ進むと、入っていないのに選び直しだけが起きて、
    // 作者には「振ったのに反映されない」としか見えない
    // （シーンメモの挿入と同じ扱いに揃える。0.28.2）
    if (!(await vscode.workspace.applyEdit(change))) {
      logLine(
        `${label}：${fromUri(document.uri)} の ${start}〜${end} に入れられませんでした。`
      );
      void vscode.window.showWarningMessage(
        `${label}を入れられませんでした。もう一度お試しください。`
      );
      return;
    }

    // 入れたところを選び直す。続けて直したくなることが多い。
    // **画面へ返す位置はLF空間へ戻す**（入れた記法に改行は無いので、
    // 長さはどちらの空間でも同じ）
    const lfStart = toLfOffset(document.getText(), start);
    await panel.webview.postMessage({
      type: "select",
      start: lfStart,
      end: lfStart + inserted.length,
    });
  }

  /**
   * 選んだ範囲に傍点が1字でも掛かっていれば、その傍点を外す（設計書6.34.2）。
   *
   * **記法だけを消して字は残す。** 掛かった傍点が複数あれば、全部を1回の
   * 書き換えで外す（Ctrl+Z 1回で戻る）。書き換えは打鍵やルビと同じく
   * 開いている文書への `WorkspaceEdit`（作者自身の編集なので取り消しが効く）。
   *
   * @returns 傍点が掛かっていた（外した・外せなかったを問わず、付ける道へは進まない）
   */
  private async removeEmphasisIfAny(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    message: { start: number; end: number }
  ): Promise<boolean> {
    // 画面の位置はLF空間。文書の位置へ直してから探す（ルビと同じ）
    const original = document.getText();
    const start = fromLfOffset(original, message.start);
    const end = fromLfOffset(original, message.end);
    const spans = findEmphasisSpans(
      original,
      start,
      end,
      notationModeFor(fromUri(document.uri))
    );
    if (spans.length === 0) return false;

    // 探したのと同じ本文へ、間を置かずに当てる（読みを訊く間が無いので、
    // ルビのような「今もその文字か」の確かめは要らない）
    const change = new vscode.WorkspaceEdit();
    for (const span of spans) {
      change.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(span.start),
          document.positionAt(span.end)
        ),
        span.base
      );
    }
    if (!(await vscode.workspace.applyEdit(change))) {
      logLine(
        `傍点：${fromUri(document.uri)} の ${start}〜${end} の傍点を外せませんでした。`
      );
      void vscode.window.showWarningMessage(
        "傍点を外せませんでした。もう一度お試しください。"
      );
      return true;
    }

    // 外したところ（字だけになった範囲）を選び直す。付け直したくなったら
    // そのままもう一度押せばよい
    const first = spans[0];
    const last = spans[spans.length - 1];
    const removed = spans.reduce(
      (sum, span) => sum + (span.end - span.start - span.base.length),
      0
    );
    const now = document.getText();
    const lfStart = toLfOffset(now, first.start);
    const lfEnd = toLfOffset(now, last.end - removed);
    await panel.webview.postMessage({ type: "select", start: lfStart, end: lfEnd });
    return true;
  }

  /**
   * 投稿サイトの記法に直してコピーする。
   *
   * **原稿には触らない。** 貼り付ける先はサイトの投稿欄である。
   * 選択は使わず本文全体を出す——画面の選択範囲は「読む」面と
   * 「書く」面で意味が違い、どちらの意味で出したのかが作者に伝わらない。
   */
  /**
   * 最新話を開く。白紙でなければ、次の話を作って開く（設計書6.25.5）。
   *
   * **同じ向きの入口で開き直す。** 縦書きで書いていた人が、次の話だけ
   * 横書きで開かれると困る。
   */
  private async openLatestEpisode(
    document: vscode.TextDocument
  ): Promise<void> {
    const found = await this.deps.highlighter.indexFor(fromUri(document.uri));
    if (!found) {
      void vscode.window.showWarningMessage(
        "この原稿の作品が分かりませんでした。作品として登録されているかご確認ください。"
      );
      return;
    }

    const { episodes, manuscriptDir } = await scanWork(found.work);

    // **白紙かどうかは、いま開いている本文で判断できることがある。**
    // 同じファイルなら読み直さない（保存前の状態が正しい）
    const current = fromUri(document.uri);
    const plan = planLatestEpisode(
      episodes,
      (episode) =>
        // いま開いている話は、**保存前の中身**で見る（打ちかけを白紙にしない）。
        // ほかは走査が数えた文字数で見る（読み直さない）
        samePath(episode.filePath, current)
          ? isBlankText(document.getText())
          : isBlankEpisode(episode),
      episodeNaming(),
      // **既存の話の名前の流儀に揃える**（`episode_0001_題.md` の作品に
      // `019.txt` を作らない。設定は話が1つも無いときの初期値）
      (chapter, rule) =>
        nextEpisodeFileNameLike({
          latestFileName: findLatestEpisode(episodes)?.fileName ?? null,
          number: chapter,
          fallback: rule,
        })
    );

    if (plan.kind === "open") {
      if (samePath(plan.episode.filePath, current)) {
        void vscode.window.showInformationMessage(
          "いま開いているのが最新話です。このまま書けます。"
        );
        return;
      }
      // **いま見ている見た目のまま開く**（設計書6.25.5）
      await this.openAsManuscript(plan.episode.filePath, document);
      return;
    }

    await this.createAndOpen(
      found.work,
      manuscriptDir,
      plan.fileName,
      document
    );
  }

  /**
   * 前の話・次の話を開く（作者の指示、2026-08-29）。
   *
   * **並びは走査の結果そのまま**（`scanWork` の episodes）。話数で並べ直す
   * のは走査の仕事で、ここでやると2か所に並べ方が生まれる。
   *
   * 次の話の決め方は3通りある。
   *
   * | いまの話 | どうするか |
   * |---|---|
   * | 後ろに話がある | それを開く |
   * | 最終話で、**白紙** | 「最新話です。」と伝えるだけ（作らない） |
   * | 最終話で、本文がある | 次の話数を作って開く |
   *
   * 白紙のときに作らないのは「最新話を書く」と同じ考え方である
   * （押すたびに空のファイルが増えるのを避ける。設計書6.25.5）。
   *
   * **合本（1ファイルに全話）を開いているあいだは、ファイルではなく
   * 話を切り替える**（作者の指示、2026-09-10）。ファイル単位で動かすと、
   * 全話が1つしか無いので「最初の話です。」としか言えない。
   *
   * @param caretLine 画面のカーソル行（1始まり。読めなければ0）。
   *   合本のときだけ使う——どの話に居るかは位置でしか分からない
   */
  private async openNeighborEpisode(
    document: vscode.TextDocument,
    direction: "prev" | "next",
    caretLine = 0,
    noCreate = false
  ): Promise<void> {
    const current = fromUri(document.uri);

    /*
      合本の中を先に見る。**走査より前に見る**のは、合本は作品の中で
      1ファイルにしか当たらず、ファイルの並びを調べても答えが出ないため。
      端（最初の話で「前へ」・最後の話で「次へ」）に来たときだけ、
      これまでどおりファイルの前後へ出る。
    */
    const starts = collectedEpisodeStarts(document.getText());
    if (starts.length >= 2) {
      const step = planCollectedStep({ starts, caretLine, direction });
      if (step.kind === "reveal") {
        // 開き直さない（同じファイルなので、行を示すだけでよい）
        const open = openManuscripts.get(manuscriptLedgerKey(document.uri));
        open?.revealLine(step.line);
        return;
      }
    }

    const found = await this.deps.highlighter.indexFor(current);
    if (!found) {
      void vscode.window.showInformationMessage(
        "この原稿は作品の話として認識できません。"
      );
      return;
    }

    const { episodes, manuscriptDir } = await scanWork(found.work);
    const at = episodes.findIndex((episode) =>
      samePath(episode.filePath, current)
    );
    if (at < 0) {
      // 作品には属しているが、本文フォルダーの外にある（プロットなど）
      void vscode.window.showInformationMessage(
        "この原稿は作品の話として認識できません。"
      );
      return;
    }

    // ここから先は最終話のとき、**保存前の中身で白紙かを見る**
    // （打ちかけを白紙にしない）
    const step = planNeighborStep({
      at,
      count: episodes.length,
      direction,
      currentIsBlank: isBlankText(document.getText()),
      noCreate,
    });
    if (step.kind === "notice") {
      void vscode.window.showInformationMessage(step.message);
      return;
    }
    if (step.kind === "open") {
      // **いま見ている見た目のまま開く**（作者の依頼、2026-09-12。
      // 設計書6.25.5）。話を行き来するたびに縦横や大きさが戻ると、
      // 移るたびに指定し直すことになる
      await this.openAsManuscript(episodes[step.index].filePath, document);
      return;
    }

    /*
      次の話数の決め方は「最新話を書く」と同じものを使う（`planLatestEpisode`）。
      **ここは「最終話に本文がある」と分かっている場面**なので、白紙の判定は
      常に false を返す＝必ず「次を作る」枝へ入る。
    */
    const plan = planLatestEpisode(
      episodes,
      () => false,
      episodeNaming(),
      // **既存の話の名前の流儀に揃える**（`episode_0001_題.md` の作品に
      // `019.txt` を作らない。設定は話が1つも無いときの初期値）
      (chapter, rule) =>
        nextEpisodeFileNameLike({
          latestFileName: findLatestEpisode(episodes)?.fileName ?? null,
          number: chapter,
          fallback: rule,
        })
    );
    if (plan.kind !== "create") return;
    await this.createAndOpen(
      found.work,
      manuscriptDir,
      plan.fileName,
      document
    );
  }

  /**
   * 白紙の話を作って開く。**既にあるなら作らない**（上書き禁止）。
   *
   * 「最新話を書く」と「次の話」で分け合う。作り方が2つあると、
   * 片方だけがファイル名の決まりから外れる日が来る。
   */
  private async createAndOpen(
    work: WorkEntry,
    manuscriptDir: string,
    fileName: string,
    /** ここから移ってきた原稿。見た目を引き継ぐために要る（設計書6.25.5） */
    from?: vscode.TextDocument
  ): Promise<void> {
    const filePath = paths.join(manuscriptDir, fileName);
    if (await pathExists(filePath)) {
      // 走査の取りこぼしなど。**上書きしない**
      await this.openAsManuscript(filePath, from);
      return;
    }
    await vscode.workspace.fs.writeFile(
      paths.toUri(filePath),
      new TextEncoder().encode("")
    );
    // 作った話の作品のログへ（前面の作品や直前の作品へ流さない。0.81.4）
    useLogFile(work.folderPath);
    logLine(`原稿エディタ：${fileName} を作成`);
    // **執筆量の基準を置き直す**（設計書6.3.2）。ここで入れておかないと、
    // このあと作者が書いて保存した回が「ファイル数が変わった」に当たり、
    // その分が「今日 +0字」になって消える
    await this.deps.rebaseline(work);
    notifyDone(`${fileName} を作りました。`);
    await this.openAsManuscript(filePath, from);
  }

  /**
   * 打った字が原稿に入らない画面を、同じ文書のまま開き直す（設計書6.25.9）。
   *
   * **押せる時点で、ここへ届いている。** 届いたことをまず返す（画面は返事が
   * 来なければ「ウィンドウの再読み込み」を案内する）。
   *
   * **閉じるのは VS Code の普通の閉じ方（タブを閉じる）で行う。** 文書に
   * 未保存の変更があれば、VS Code が保存するかを訊く。`panel.dispose()` で
   * 黙って閉じると、未保存の文書をどう扱うかを作者が選べない。
   * 取りやめられたら開き直さず、画面へ「開き直せなかった」を返す。
   *
   * 控えは `pendingRescue` に置き、新しい画面が立ち上がるときに渡す
   * ——**タブを閉じると画面の状態（setState）は引き継がれない**ため。
   */
  private async reopenForRescue(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    rescues: ManuscriptRescue[]
  ): Promise<void> {
    await panel.webview.postMessage({ type: "reopenAccepted" });
    const key = manuscriptLedgerKey(document.uri);
    const column = panel.viewColumn;
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (candidate) =>
          candidate.input instanceof vscode.TabInputCustom &&
          candidate.input.viewType === this.viewType &&
          manuscriptLedgerKey(candidate.input.uri) === key
      );
    if (!tab) {
      await this.logForDocument(
        document,
        "原稿エディタ：開き直そうとしましたが、この原稿のタブが見つかりませんでした"
      );
      await panel.webview.postMessage({ type: "reopenResult", ok: false });
      return;
    }
    if (rescues.length > 0) pendingRescue.set(key, rescues);
    await this.logForDocument(
      document,
      `原稿エディタ：打った字が原稿に入らないため、開き直します（控え${
        rescues.length > 0
          ? `${rescues.length}件：${rescues.map((one) => `${one.text.length}字`).join("・")}`
          : "なし"
      }）`
    );
    const closed = await vscode.window.tabGroups.close(tab);
    if (!closed) {
      // 保存の確認で取りやめた等。控えは画面の状態に残っている
      pendingRescue.delete(key);
      await this.logForDocument(
        document,
        "原稿エディタ：開き直しを取りやめました（タブが閉じられませんでした）"
      );
      await panel.webview.postMessage({ type: "reopenResult", ok: false });
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.openWith",
      document.uri,
      this.viewType,
      column
    );
  }

  /**
   * 同じ向きの原稿エディタで開く。
   *
   * @param from ここから移ってきた原稿。渡すと、その画面の見た目
   *   （縦横・大きさ・組んで書く）を次の画面へ引き継ぐ（設計書6.25.5）
   */
  private async openAsManuscript(
    filePath: string,
    from?: vscode.TextDocument
  ): Promise<void> {
    if (from) this.carryAppearance(from, filePath);
    /*
      **移ってきた原稿エディタの列に開く**（2026-09-23、ノートPCの実機確認）。

      列を渡さないと、VS Code は「いま前面の列」へ開く。［単話プロット］を
      押すと単話プロットが右の列に開いて前面になるので、その直後に
      ［次の話 →］を押すと、次の話が右の列へ入り、左は元の話のまま・
      単話プロットは隠れた。押したのは左の原稿エディタなので、前面が
      どこであれ、その画面が居る列を使う。

      `from` が無い（変換で元の面が閉じた）ときや、列を読めないときは
      これまでどおり VS Code に任せる。
    */
    const column = from
      ? openManuscripts.get(manuscriptLedgerKey(from.uri))?.panel.viewColumn
      : undefined;
    /*
      **移る先の話が既に別の入口・別の列で開いていれば、そのタブを前に出す**
      （作者の裁定、2026-10-03。設計書6.25.11）。入口と列は「タブが無いとき」の
      既定で、あるときは共通の口がタブの入口と列を使う——ここで決め打つと、
      同じ話の2枚目ができる。見た目は上の `carryAppearance` が生きている画面へ
      直に当てるので、入口が違っても縦横は引き継がれる。
    */
    const opened = await openManuscriptFile(
      paths.toUri(filePath),
      this.viewType,
      column
    );
    if (opened.reused) await this.settleCarried(filePath);
  }

  /**
   * 前に出すだけで済んだとき、その原稿へ置いた見た目を片づける（設計書6.25.11）。
   *
   * 台帳に無い背景のタブは、前に出すと画面が立ち上がって `ready` で見た目を
   * 取り出すことがある。**`openWith` が戻った時点ではまだ取り出されていない**
   * （台帳へ載るのも `ready` も後から非同期に来る）ので、すぐ消すと引き継ぎが
   * 落ちる。台帳に載るのを少し待ち、載ればその画面へ直に当て
   * （`ready` の前なら画面側が待つ）、載らなければ捨てる。
   */
  private async settleCarried(filePath: string): Promise<void> {
    const key = manuscriptLedgerKey(filePath);
    // 何も置いていない（生きている画面へ直に当て済み等）なら待つ理由が無い
    if (!pendingAppearance.has(key)) return;
    const live = await waitFor(() => openManuscripts.get(key));
    const outcome = settleCarriedAppearance(pendingAppearance, key, live);
    if (outcome === "discarded") {
      logLine(
        `原稿エディタ：${filePath} のタブを前に出しましたが、画面が立ち上がらなかったため、前の話の見た目は引き継がずに捨てました（後日開いたときに古い見た目が当たらないように）。`
      );
    }
  }

  /**
   * いま見ている画面の見た目を、次に開く原稿へ持たせる（設計書6.25.5）。
   *
   * **置くだけで、当てるのは開いた画面の側**（`ready` のときに1回だけ
   * 取り出す）。開く前に当てる先の画面はまだ無い。
   *
   * 画面がまだ見た目を知らせていなければ何も置かない——そのときは、
   * これまでどおり覚えていた値と設定の既定で開く。
   */
  private carryAppearance(
    from: vscode.TextDocument,
    toFilePath: string
  ): void {
    const now = openManuscripts
      .get(manuscriptLedgerKey(from.uri))
      ?.appearance();
    if (!now) return;
    const to = manuscriptLedgerKey(toFilePath);
    /*
      **既に開いている原稿には、置かずに直に当てる。** そのときの
      `openWith` はそのタブを前に出すだけで、新しい画面は立ち上がらない
      ＝置いても誰も取りに来ない（取り出しは立ち上がりの1回きり）。

      **0.50.3 まではここで素通りしていた。** そのため、いちど開いた
      タブへ移ると縦横・大きさ・面が引き継がれず、作者から見ると
      「効いたり効かなかったりする」状態だった（2026-09-12、9巡目に
      実機で確認——0018 を縦書きにして「次の話 →」を押すと、既に
      開いていた 9901 が横書きで出た）。生きている画面には送る口
      （`applyAppearance`）があるので、置き去りにせずそちらへ渡す。
    */
    const live = openManuscripts.get(to);
    if (live) {
      live.applyAppearance(now);
      return;
    }
    pendingAppearance.set(to, now);
  }

  /**
   * 投稿サイト用に変換してコピー（設計書6.12.1）。
   *
   * @param caretLine 画面のカーソル行（1始まり。読めなければ0）。
   *   **合本のときだけ使う**——どの話をコピーするのかは位置でしか分からない
   * @param selection 選んだ範囲（LF空間。選んでいなければ `start` が負）。
   *   **選んでいればその範囲だけ**を変換する（作者の裁定、2026-09-21）。
   *   右クリックからは話ぜんぶしか写せず、部分を選んでも全文が入っていた
   */
  private async copyForPosting(
    document: vscode.TextDocument,
    caretLine = 0,
    selection: { start: number; end: number } = { start: -1, end: -1 }
  ): Promise<void> {
    /*
      **訊き方は普通のエディタと同じものを使う**（`features/ruby.ts`）。
      画面ごとに選択肢の言葉が違うと、同じ操作に見えなくなる。

      **訊くのは貼り付け先だけ。1度だけ**（設計書6.12.4）。以前は記法を
      先に訊き、傍点が入っているときだけサイトを訊く2段だった。サイトが
      決まれば記法は決まるので、記法を訊く画面は要らない。
    */
    /*
      **作品は登録簿で引く**（`workOf`、設計書6.68.2）。用語索引
      （`highlighter.indexFor`）は**設定資料が1件も無い作品では引けない**
      ので、書き始めたばかりの作品では登録済みの投稿先が先頭に来なかった。
      同じ操作の並びが作品によって変わるのは、作者からは不具合に見える。
    */
    const work = this.deps.workOf(fromUri(document.uri));
    const target = await pickPostingTarget(
      // 作品が引けないことはある（登録していないファイルを開いたとき）。
      // そのときは並びが既定に戻るだけで、コピー自体はできる
      await registeredPostingSites(work)
    );
    if (!target) return;

    /*
      **選んだところがあれば、そこだけ**（作者の裁定、2026-09-21。
      設計書6.12.8）。作者の報告：「部分選択でコピーして右クリックも
      ページ全体」。頭書きも合本の切り分けも通さない——選んだ範囲が
      そのまま作者の言う「ここ」である。
    */
    const whole = document.getText();
    const picked =
      selection.start >= 0 && selection.end > selection.start
        ? // 画面の位置はLF空間。CRLF の原稿でもずれないよう直してから切る
          whole.slice(
            fromLfOffset(whole, selection.start),
            fromLfOffset(whole, selection.end)
          )
        : undefined;

    /*
      **どこを写すかの判断は `core/episodeCopy.ts` が持つ**（設計書6.12.8）。
      選んだところ → 合本のカーソルの居る話 → 頭書きを外した本文、の順。
      画面を持ち込まずに測れるよう、判断だけを外へ出してある。
    */
    const { source, selected, collected } = postingCopySource(
      whole,
      caretLine,
      picked
    );

    /*
      **シーンメモを落とすのは変換の側**（`convertForPosting`、設計書6.84）。
      この画面ではメモを消さずに見せているので、外へ出す唯一の口である
      ここで落としていたが、**noteではコードの中の `//` を落としてはいけない**
      ——記法を読み分けられるところでだけ落とす。

      **貼り付け先ごとの分岐も、入口には書かない。** noteはMarkdownを
      そのまま解釈するので記法の置き換えだけでは足りず、3つの入口が
      別々に分岐を持つと、貼ったときの形が入口によって違うことになる。
    */
    const conversion = convertForPosting(source, target);

    await vscode.env.clipboard.writeText(conversion.text);
    /*
      **何をコピーしたかを出す**（設計書6.12.1）。合本は取り違えに
      その場で気づけるよう、話が分かる言い方にする。**合本でないときの
      文言は変えない**——覚えている言葉を一緒に変えない。
    */
    const length = conversion.text.length.toLocaleString("ja-JP");
    const scope = selected
      ? // 選んだところだけを写したことを、はっきり言う。黙って一部だけを
        // 写すと、作者は全文が入ったつもりで貼る
        `選んだところ（${length}字）`
      : collected
        ? `${collectedEpisodeLabel(
            collected,
            // 作品が引けないことはある。そのときは既定の数え方になるだけ
            work ? await readWorkFormat(work) : undefined
          )}（${length}字）`
        : "本文全体";
    await showPostingCopyNotice({
      conversion,
      sourcePath: fromUri(document.uri),
      site: target.site,
      work,
      summary:
        `${scope}を${target.label}の書き方に変換して、` +
        "クリップボードへ入れました。原稿はそのままです。",
    });
  }
}

/**
 * 見た目の設定を読む。
 *
 * **縦書きかどうかは「はじめの向き」だけ**を決める。画面で切り替えた
 * 状態はその原稿ごとに覚える（`vscode.setState`）ので、設定を書き換えても
 * すでに開いている原稿の向きは変わらない。
 */
/**
 * 書体を選んでもらい、設定へ書き戻す（設計書6.25.3）。
 *
 * **設定を1つの出どころにする。** 原稿ごとに覚える形にすると、
 * 新しい話を開くたびに書体が戻る。作者が選ぶのは「この作品の書体」ではなく
 * 「自分の読み書きする書体」である。
 *
 * **入っていない書体も並べて、入っていないと書く。** 消すと
 * 「あるはずのものが無い」に見え、なぜ選べないのかが分からない
 * （`processAvailability.ts` と同じ考え方）。
 */
async function pickFont(installed?: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration("novelai");
  const current = config.get<string>("manuscriptEditor.fontFamily", "").trim();
  const available = installed ? new Set(installed) : undefined;

  const choices = listChoices(current, available).map((font) => ({
    label: (font.selected ? "$(check) " : "") + font.label,
    description: font.kind,
    detail: font.installed
      ? undefined
      : "この端末には入っていません（選ぶと、近い書体で表示されます）",
    value: font.value,
  }));

  const picked = await vscode.window.showQuickPick(
    [...choices, cancelItem()],
    {
      title: `原稿の書体（いま: ${describeCurrentFont(current)}）`,
      placeHolder: "本文に使う書体を選んでください",
      matchOnDescription: true,
    }
  );
  if (!picked || isCancelItem(picked)) return;

  const value = "value" in picked ? picked.value : undefined;
  if (value === undefined || value === current) return;

  // **全体の設定へ書く。** 作品ごとではなく、作者ごとの好みである
  await config.update(
    "manuscriptEditor.fontFamily",
    value,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * 送るたびに添える見た目の設定。
 *
 * **書体をここで読むから、前の話へ移っても同じ書体で出る。** 書体は作品
 * ごとでも原稿ごとでもなく**作者ごとの好み**として設定に置いてあり
 * （`pickFont`）、どの画面も開くときにここから読む。設定が変わったときは
 * `onDidChangeConfiguration` で開いている画面へ送り直す。
 */
function readAppearance(): {
  fontFamily: string;
  /**
   * ダッシュ「――」と三点リーダ「……」だけに当てる書体（設計書6.34）。
   *
   * **本文の書体と分けて送る。** 游明朝・ＭＳ 明朝・游ゴシックのダッシュは
   * 字送りより線が短く、2本並べても繋がらない（作者の実機、2026-09-21）。
   * 字を持ってはいるので、CSSの引き当てでは後ろへ落ちてくれない
   * ——判定は `core/markFont.ts` が持つ
   */
  markFontFamily: string;
  /** 読み上げの速さの既定（設計書6.42）。列で変えたぶんは書き戻さない */
  readAloudRate: number;
} {
  const config = vscode.workspace.getConfiguration("novelai");
  const fontFamily = config
    .get<string>("manuscriptEditor.fontFamily", "")
    .trim();
  /*
    作者が書体を選んでいないときに、**実際に描かれる書体**（作者の裁定、
    2026-09-22）。作者のノートの既定は切れる書体（等幅）で、選んでいない
    ときだけ隙間が出ていた。VS Code の編集用フォントが画面の既定になるので、
    その設定値をそのまま渡す——先頭を取り出して判定するのは
    `core/markFont.ts` の仕事なので、ここで切り分けない
  */
  const editorFontFamily = vscode.workspace
    .getConfiguration("editor")
    .get<string>("fontFamily", "");
  return {
    fontFamily,
    markFontFamily: markFontFor(fontFamily, editorFontFamily),
    readAloudRate: clampReadAloudRate(
      config.get<number>("manuscriptEditor.readAloudRate", 1)
    ),
  };
}

/**
 * 入口と設定が決める向き（開くときに1度だけ使う。設計書6.25.5）。
 *
 * `forceVertical` は**向きを決め打つ**という意味である。「原稿（横書）」で
 * 開いたなら、その原稿が縦を覚えていても、前の話から縦を持って来ていても
 * 横で開く。選んで開いたのに別の向きが勝つと、選んだ意味が無い。
 * 開いたあとに切り替えれば、そちらを覚える（これまでどおり）。
 */
function readOrientation(orientation: ManuscriptOrientation): {
  verticalDefault: boolean;
  forceVertical?: boolean;
} {
  const config = vscode.workspace.getConfiguration("novelai");
  return {
    verticalDefault:
      orientation === "horizontal"
        ? false
        : config.get<boolean>("manuscriptEditor.vertical", true),
    ...(orientation === "horizontal" ? { forceVertical: false } : {}),
  };
}

/**
 * **設定に書かれた値**を、画面の列が扱える 0.5〜2.0 へ畳む（設計書6.42）。
 *
 * 畳むのは設定の値だけで、作者が列で選んだ速さには触らない（あちらは
 * 0.5〜2 の選択肢しか持たない）。
 *
 * **`package.json` の `minimum`/`maximum` は案内であって、強制ではない。**
 * `settings.json` へ直接 `10` と書けばその値が届く。範囲の外の `rate` は、
 * 環境によっては**声が一言も出ない**（黙って失敗する）ので、ここで畳む。
 */
export function clampReadAloudRate(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0.5, value));
}

/** いまのテーマに合う色を選ぶ */
function colorsFor(): Record<string, string> {
  const dark =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
  // シーンメモの蛍光ペンとタグの色（設計書6.40.3）。
  // **16進は `core/sceneMemo.ts` にしかない**（写しを置かない）
  const colors: Record<string, string> = memoColorVars(dark);
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
