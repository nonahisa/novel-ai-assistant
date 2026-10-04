import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { readTextFile, writeTextFilePreservingFormat } from "../core/textFile";
import { readWorkFormat } from "../core/workFormatStore";
import {
  collectedLabelIndex,
  episodeTitle,
  formatChapterLabel,
  isCollectedFile,
} from "../core/episodeLabel";
import { logFailure, logLine, useLogFile } from "../core/logger";
import {
  countMemosByTag,
  MEMO_HINT,
  memoColorVars,
  memoTagClass,
  nearestMemo,
  parseMemos,
  memoLineRemoval,
  removeMemoLine,
  restoreMemoLine,
  sortMemos,
  type MemoPosition,
  type RemovedMemoLine,
  type SceneMemo,
} from "../core/sceneMemo";
import {
  SCENE_MEMO_FORMER_TITLES,
  SCENE_MEMO_TITLE,
  sceneMemoToMarkdown,
} from "../core/sceneMemoMarkdown";
import {
  arrangeRows,
  currentFirst,
  findingHeadline,
  findingLabelOf,
  findingNote,
  findingToneClass,
  findingToneVars,
  mergeNoteRows,
  tagTonesOf,
  nextNoteRow,
  prevNoteRow,
  type NoteRow,
  type PlacedFinding,
} from "../core/sceneMemoRows";
import { locateFindings } from "../core/findingLocation";
import { findingAppliesDirectly, findingFileKey } from "../core/findingSource";
import type { FindingFixOutcome } from "./proposalPanel";
import type { FindingAdviceOutcome } from "./findingAdvice";
import type { FindingAdviceExample } from "../core/findingAdviceValidation";
import {
  FindingStore,
  findingsRetentionDays,
  visibleFindings,
} from "./findingStore";
import { buildSceneMemoPanelHtml } from "../views/sceneMemoPanelHtml";
import { openGeneratedMarkdown } from "../views/openDocument";
import { revealTextLocation, type RevealInManuscript } from "./revealLocation";
import {
  lastManuscriptCaret,
  removeMemoLineInOpenManuscript,
  restoreMemoLineInOpenManuscript,
} from "./manuscriptEditor";

/**
 * シーンメモのパネル（設計書6.40.4）。
 *
 * 作者の指示（2026-08-29）：「シーンメモは、フロートチップ方式だけでなく、
 * パネルを横に並べて確認できるようにしてください。パネルには次に飛ばすのと
 * 戻る機能を付けてください」。
 *
 * **原稿エディタの横**（`ViewColumn.Beside`）に開く。作品ごとに1枚。
 *
 * ## AIの指摘も、ここへ位置順で混ぜる（設計書6.96.5）
 *
 * 作者の指示（2026-09-19）：「ファイルを開いたら、そのファイルに関係する
 * 提案を種類にこだわらず、該当位置順でまとめて右側に幅を取らない感じで
 * 並べる機能が欲しい」。置き場の裁定は「シーンメモに統合してください」。
 *
 * **混ぜるのは画面の上だけである。** 付箋は本文の中、指摘は
 * `.aiwriter/findings.jsonl`。並べ方（話数 → 行、同じ行はまとめる）は
 * `core/sceneMemoRows.ts` が決め、ここは**本文を読んで渡す**のと
 * **押されたものを受ける**のを受け持つ（`core` から `vscode` を触らない）。
 *
 * ## 本文の書き換えは、既存の経路だけを通る
 *
 * 「済みにする」はメモの行を本文から消す。**原稿エディタで開いていれば
 * その文書へ `WorkspaceEdit`、開いていなければ
 * `writeTextFilePreservingFormat`**（ハッシュ照合つき）。
 * `atomicWriteFile` を直に呼ぶ道は作らない（規則1・6.40.6）。
 *
 * 修正案の無い指摘の行は［本文へ］で原稿のその行へ飛ぶ（作者の裁定 2026-10-04。
 * 以前の［提案へ］はやめ、提案パネルへ移る口は上の帯の［提案パネル］1つにした）。
 * 修正案の無い推敲の指摘には［AIに相談］も出す（行のすぐ下に短い助言を出す。P-47）。
 *
 * **AIの指摘を本文へ当てる処理は、この画面には書かない**（6.96.5）。
 * 修正案のある指摘の［直す］は1手で本文へ当たるが（作者の裁定、2026-10-03）、
 * 当てるのは提案パネルの［適用］と同じ関数である（`deps.applyFinding`）。
 * 6.11.1 の「3つの形を同じ配列へ混ぜない」は、本文の適用処理が設定資料の
 * 更新を掴んで壊れるのを防ぐためにある。ここに写しの適用処理を作ると、
 * その線を画面の側から破ることになる。
 */

const openPanels = new Map<string, SceneMemoPanel>();

/**
 * 書き出す文書の呼び名と、記録に残すときの出どころ。
 *
 * **呼び名は `core/sceneMemoMarkdown.ts` の1つ**（見出しと置き場が
 * 食い違わないようにする）。
 */
const SCENE_MEMO_KIND = SCENE_MEMO_TITLE;

export interface SceneMemoDeps {
  /**
   * 原稿エディタで本文を示す口。
   *
   * **飛び先の経路は `revealLocation.ts` の1本だけ**（6.37.4）。
   * 引き受けられなければ素のエディタで開く。
   */
  revealInManuscript?: RevealInManuscript;
  /**
   * 提案パネルを開く口（上の帯の［提案パネル］。設計書6.96.5）。
   *
   * 行ごとの［提案へ］はやめた（作者の裁定 2026-10-04「提案へ、というのも
   * おかしい」）。修正案の無い指摘の行は［本文へ］で原稿のその行へ飛ぶ。
   * 矛盾の再チェック・伏線として登録・まとめて適用など、提案パネルにしか無い
   * 操作へ移る口を、パネルの上に1つだけ残す。指摘は置き場から提案パネルにも
   * 並ぶので、渡し直さなくてよい。
   *
   * **渡されなければ出さない**（押しても何も起きない口を作らない）。
   */
  openProposals?: () => void | Promise<void>;
  /**
   * 修正案の無い推敲の指摘について、短い助言を作る口（画面のボタンは
   * ［AIに相談］。P-47、`findingAdvice.ts`）。
   *
   * 答えは**押した指摘の行のすぐ下**に出す（作者の報告 2026-10-04「表示される
   * 位置が離れすぎています」）。本文にも置き場にも入らない。
   * `signal` は［止める］で中止する。
   *
   * **渡されなければ［AIに相談］を出さない。**
   */
  adviseFinding?: (
    work: WorkEntry,
    finding: PlacedFinding,
    signal: AbortSignal
  ) => Promise<FindingAdviceOutcome>;
  /**
   * 助言の下の「相談パネルで続ける」——その指摘を相談パネル（P-21）へ渡す口。
   *
   * 短い助言で足りないときだけ作者が押す。**渡されなければ出さない。**
   */
  consultFinding?: (work: WorkEntry, finding: PlacedFinding) => Promise<void>;
  /**
   * 修正案のあるAIの指摘を、1手で本文へ当てる口（画面のボタンは［直す］。
   * 作者の裁定 2026-10-03「［直す］1手で本文が直る」）。
   *
   * **当てるのは提案パネルの［適用］と同じ関数**（`primeFindings.applyFindingFromMemo`）。
   * 本文への適用をここへ書き直すと、検算・校閲ロック・記録が片方だけ直る日が来る。
   *
   * 渡されなければ、修正案のある指摘も［本文へ］（その行へ飛ぶだけ）になる。
   */
  applyFinding?: (
    work: WorkEntry,
    finding: PlacedFinding
  ) => Promise<FindingFixOutcome>;
  /**
   * ［直す］で当てた1件を戻す口（提案パネルの［戻す］と同じ関数）。
   * 渡されなければ、この画面に［戻す］を出さない（提案パネルの［戻す］は効く）。
   */
  undoFindingFix?: (
    work: WorkEntry,
    finding: PlacedFinding
  ) => Promise<FindingFixOutcome>;
  /**
   * この画面で退けたことを、提案パネルへ伝える口（設計書6.96.5）。
   *
   * **同じ指摘は2つの画面に出る。** こちらで見送っても、向こうの一覧に
   * 残っていると、作者は同じものを二度読むことになる。
   *
   * **呼ぶのは知らせるためだけ**——本文にも置き場にも触らない（置き場への
   * 追記はこの画面が済ませている）。渡されなければ、ただ知らせないだけで
   * 見送りそのものは効く。
   */
  noteFindingDismissed?: (work: WorkEntry, findingId: string) => void;
}

export async function openSceneMemoPanel(
  context: vscode.ExtensionContext,
  work: WorkEntry,
  deps: SceneMemoDeps,
  options: {
    filePath?: string;
    /**
     * フォーカスを奪わずに出す。検知が終わって自動で開くときは true
     * （作者が Ctrl+Alt+M などで押したときは false＝これまでどおり）
     */
    preserveFocus?: boolean;
  } = {}
): Promise<void> {
  const preserveFocus = options.preserveFocus === true;
  const existing = openPanels.get(work.id);
  if (existing) {
    await existing.revealAndReload(options.filePath, preserveFocus);
    return;
  }
  const panel = new SceneMemoPanel(
    context,
    work,
    deps,
    options.filePath,
    preserveFocus
  );
  openPanels.set(work.id, panel);
  await panel.initialize();
}

/**
 * 原稿エディタのカーソルが動いたことを、開いているパネルへ伝える。
 *
 * **開いていなければ何もしない。** 見ていない画面のために本文を読み直す
 * 必要はない。**片方向**——パネルは光らせるだけで、本文は動かさない。
 */
export function noteSceneMemoCaret(filePath: string, line: number): void {
  for (const panel of openPanels.values()) panel.noteCaret(filePath, line);
}

/**
 * 本文が保存されたら、一覧を作り直す。
 *
 * 開いているパネルのうち、そのファイルを含む作品のものだけが読み直す。
 */
export async function refreshSceneMemos(filePath: string): Promise<void> {
  for (const panel of openPanels.values()) {
    if (panel.covers(filePath)) await panel.reload();
  }
}

/**
 * 指摘の判断が済んだことを、開いているパネルへ伝える（設計書6.96.5）。
 *
 * **同じ指摘は2つの画面に出る。** 提案パネルで採る・退けると置き場には
 * 追記されるが、こちらは**本文の保存でしか読み直さない**ため、片付けた
 * はずの指摘が横に残り続けていた。
 *
 * 開いていなければ何もしない（見ていない画面のために本文を読み直さない）。
 */
export async function refreshSceneMemoFindings(workId: string): Promise<void> {
  const panel = openPanels.get(workId);
  if (panel) await panel.reload();
}

/**
 * 次の／前のメモへ飛ぶ（コマンド。設計書6.40.4）。
 *
 * **パネルが開いていなくても飛べる。** 作者がキー割当だけで使う道である。
 * 開いていれば、そちらの光る行も追いつく（本文が動けばカーソルの
 * 知らせが返ってくる）。
 */
export async function jumpSceneMemo(
  work: WorkEntry,
  direction: "next" | "prev",
  deps: SceneMemoDeps
): Promise<void> {
  const collected = await collectMemos(work);
  /*
    **指摘も回る**（設計書6.96.5）。作者が直したい順は、付箋とAIの指摘を
    分けた順ではなく本文の順である。一覧では位置順に混ぜておきながら、
    飛ぶときだけ付箋しか止まらないのでは、混ぜた意味が半分になる。
  */
  const rows = mergeNoteRows(
    collected.memos,
    collected.findings,
    collected.order
  );
  if (rows.length === 0) {
    void vscode.window.showInformationMessage(
      `「${work.title}」の本文にメモはありません。` +
        `${MEMO_HINT}。`
    );
    return;
  }

  const current = currentPosition(collected.files);
  const target =
    direction === "next"
      ? nextNoteRow(rows, current, collected.order)
      : prevNoteRow(rows, current, collected.order);
  if (!target) return;

  await revealTextLocation(
    target.filePath,
    target.line,
    deps.revealInManuscript,
    SCENE_MEMO_KIND,
    work
  );
}

/* ── 材料を集める ──────────────────────────────── */

interface CollectedMemos {
  memos: SceneMemo[];
  /**
   * いまの本文の位置まで決まったAIの指摘（設計書6.96.3）。
   *
   * **「消えた」ものはもう入っていない**——`locateFindings` が落とす。
   * ここで捨て直す処理を書くと、捨て方が2か所に分かれる。
   */
  findings: PlacedFinding[];
  files: EpisodeFile[];
  /** 話数順のファイルの並び（次へ・戻るの順序の元） */
  order: string[];
  /** 読めなかった話。**黙って落とさない** */
  notices: string[];
  /**
   * 合本ファイルの中身（道 → 生の本文）。**合本のときだけ入れる。**
   *
   * メモの行からその話の見出しを引くのに要る。ばらのファイルでは
   * ファイル単位の見出しで足りるので、抱えない——合本は70万字ある。
   */
  collectedTexts: Map<string, string>;
}

/**
 * `Finding.file`（作品フォルダーからの相対パス）と、走査で得た絶対パスを
 * **同じ表記へ揃える**ための鍵。
 *
 * **ここがずれると、指摘が1件も出ない。** `locateFindings` は
 * 「ファイル表記 → 全文」の Map を `Finding.file` そのままで引くので、
 * 区切り文字が食い違うだけで全件が黙って消える（エラーにもならない）。
 * **表記を決めるのは `core/findingSource.ts` の1か所**で、記録する側も
 * ここも同じ関数を通す——写しを置くと、片方だけが直る日が来る。
 */
function fileKeyOf(work: WorkEntry, filePath: string): string {
  return findingFileKey(work.folderPath, filePath);
}

/**
 * 付箋と指摘を集める。
 *
 * **本文を読むのはここだけ**である。位置の探し直し
 * （`core/findingLocation.ts`）は `vscode` に触れないので、本文は
 * こちらが渡す。読み終えたら手放す——合本は70万字あり、指摘の数だけ
 * 抱え続けると開いている間ずっと居座る。
 */
async function collectMemos(work: WorkEntry): Promise<CollectedMemos> {
  // **先に指摘を読む。** どのファイルの全文が要るかは、指摘が決める
  const stored = await loadVisibleFindings(work);
  const wanted = new Set(stored.map((finding) => fileKeyOf(work, finding.file)));

  const scan = await scanWork(work);
  const memos: SceneMemo[] = [];
  const notices: string[] = [];
  const order: string[] = [];
  const collectedTexts = new Map<string, string>();
  /** 指摘の位置を探し直すための本文（鍵 → 全文）。使い終えたら捨てる */
  const findingTexts = new Map<string, string>();
  /** 鍵 → 絶対パス。指摘は相対パスしか持たないので、開くために要る */
  const absolutePaths = new Map<string, string>();

  for (const episode of scan.episodes) {
    order.push(episode.filePath);
    const key = fileKeyOf(work, episode.filePath);
    absolutePaths.set(key, episode.filePath);
    if (episode.hasConflictMarkers) {
      // どちらが本文か決められないファイルは触らない（原稿を壊さない）
      notices.push(`${episode.fileName} は未解決の競合を含むため読みません。`);
      continue;
    }
    try {
      const content = await readTextFile(episode.filePath);
      memos.push(...parseMemos(content.text, episode.filePath));
      if (isCollectedFile(episode.collectedCount)) {
        collectedTexts.set(
          paths.pathKeyForComparison(episode.filePath),
          content.text
        );
      }
      if (wanted.has(key)) findingTexts.set(key, content.text);
    } catch (error) {
      // **数えて残す。** 黙って落とすと、その話のメモが無いことにされる
      notices.push(`${episode.fileName} を読めませんでした。`);
      logFailure("校正・メモパネル：本文の読み込み", {
        ファイル: episode.filePath,
        詳細: messageOf(error),
      });
    }
  }

  const located = locateFindings(
    // 鍵の表記を揃えてから渡す（`fileKeyOf` の言い分）
    stored.map((finding) => ({ ...finding, file: fileKeyOf(work, finding.file) })),
    findingTexts
  );
  findingTexts.clear();

  const findings: PlacedFinding[] = [];
  for (const finding of located) {
    const filePath = absolutePaths.get(finding.file);
    // 走査に無いファイルの指摘は、開く先が無いので出さない
    if (!filePath) continue;
    findings.push({ ...finding, filePath });
  }

  return {
    memos: sortMemos(memos, order),
    findings,
    files: scan.episodes,
    order,
    notices,
    collectedTexts,
  };
}

/**
 * 残してある指摘のうち、**並べてよいもの**だけを読む（設計書6.96.4）。
 *
 * 期限切れと、判断の済んだものは `visibleFindings` が落とす。
 * **ファイルからは消さない**——消えるのは作者が明示の操作をしたときだけ。
 */
async function loadVisibleFindings(work: WorkEntry) {
  const store = new FindingStore(work);
  return visibleFindings(await store.load(), findingsRetentionDays());
}

/**
 * いまの位置（次へ・戻るの起点）。
 *
 * **原稿エディタは `TextEditor` を持たない**ので、まずそちらが覚えている
 * カーソルを見る。無ければ素のエディタ、それも無ければ**その話の先頭**
 * として扱う（設計書6.40.4）。
 */
function currentPosition(files: readonly EpisodeFile[]): MemoPosition | null {
  const caret = lastManuscriptCaret();
  if (caret && belongsTo(files, caret.filePath)) return caret;

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const filePath = paths.fromUri(editor.document.uri);
    if (belongsTo(files, filePath)) {
      return { filePath, line: editor.selection.active.line + 1 };
    }
  }
  return null;
}

function belongsTo(
  files: readonly EpisodeFile[],
  filePath: string
): boolean {
  const key = paths.pathKeyForComparison(filePath);
  return files.some(
    (file) => paths.pathKeyForComparison(file.filePath) === key
  );
}

/* ── 画面 ──────────────────────────────────── */

/** 画面から届く用件 */
type PanelMessage =
  | { type: "ready" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "reveal"; filePath: string; line: number }
  | { type: "done"; filePath: string; line: number; raw: string }
  /** 修正案のあるAIの指摘を、提案パネルの［適用］と同じ道で本文へ当てる（6.96.5） */
  | { type: "fix"; findingId: string }
  /** 修正案の無い推敲の指摘について、行の下に短い助言を出す（P-47。設計書6.96.5） */
  | { type: "consult"; findingId: string }
  /** 考えている途中の助言を止める */
  | { type: "stopAdvice"; findingId: string }
  /** 行の下の助言を閉じる */
  | { type: "closeAdvice"; findingId: string }
  /** 助言の下の「相談パネルで続ける」 */
  | { type: "consultInChat"; findingId: string }
  /** 上の帯の［提案パネル］ */
  | { type: "openProposals" }
  /** 帯に出ている直近の1手（［直す］か［済み］）を戻す */
  | { type: "undoFix" }
  /** AIの指摘を退ける。**追記で残す**だけで、指摘の行は書き換えない */
  | { type: "dismissFinding"; findingId: string }
  | { type: "filter"; onlyCurrent: boolean; tag: string; query: string }
  | { type: "export" };

/** ［済み］で消したメモ（帯の［戻す］で元へ差し込む） */
interface DoneStep {
  kind: "done";
  filePath: string;
  /** 元の位置を確かめるための控え（上下の隣の行を含む） */
  removed: RemovedMemoLine;
  /** 帯に出す話の呼び名。消す前に引いておく（読み直すと引けなくなる） */
  label: string;
}

/**
 * 行の下に出している助言（P-47）。
 *
 * **拡張機能の側で持つ。** 画面は一覧を届くたびに作り直す（カーソルが
 * 動いただけでも描き直す）ので、画面の中に置くと消える。鍵は指摘の id
 * （行番号は読み直しで変わる）。
 */
type AdviceView =
  | { status: "thinking" }
  | {
      status: "answered";
      point: string;
      examples: FindingAdviceExample[];
      noNeed: boolean;
      cached: boolean;
    }
  | { status: "failed"; reason: string };

/** 上の帯の［戻す］で戻せる、直近の1手 */
type UndoableStep = { kind: "fix"; finding: PlacedFinding } | DoneStep;

/**
 * シーンメモの画面の種類。**提案パネルが、シーンメモの列を探すのに使う**
 * （右の列を基準にする。作者の指示、2026-09-23）
 */
export const SCENE_MEMO_VIEW_TYPE = "novelai.sceneMemos";

class SceneMemoPanel {
  private readonly panel: vscode.WebviewPanel;

  private memos: SceneMemo[] = [];
  /** いまの本文の位置まで決まったAIの指摘（設計書6.96.5） */
  private findings: PlacedFinding[] = [];
  private files: EpisodeFile[] = [];
  private order: string[] = [];
  private notices: string[] = [];
  private chapterLabels = new Map<string, { label: string; title: string }>();
  /**
   * 合本の中のメモだけ、1件ずつの見出しを持つ（`memoKey` を鍵にする）。
   *
   * ファイル単位の見出しは合本では「第1〜219話」という範囲表記になり、
   * どの話のメモか分からなかった（2026-09-12）。
   */
  private memoLabels = new Map<string, { label: string; title: string }>();

  /** いま開いている話。カーソルの知らせで動く */
  private currentFile: string | null = null;
  /** 光らせる付箋（カーソルにいちばん近いもの） */
  private activeKey = "";

  private onlyCurrent = false;
  private tag = "";
  private query = "";

  /**
   * 上の帯に出す、戻せる直近の1手（「直しました ［戻す］」「メモを済みに
   * しました ［戻す］」）。
   *
   * **一覧の行には置けない**——当てた指摘は判断が済み、済ませたメモは
   * 本文から消えて、どちらも一覧から外れる。
   *
   * **［直す］と［済み］で1つの枠を分け合う**（作者の裁定 2026-10-04
   * 「［直す］と同じ形にする」）。次の手がこの枠を取るので、帯は次の操作で
   * 入れ替わる。それより前の［直す］は提案パネルの［戻す］で戻せる
   * （行が「適用済み」で残っている）。それより前の［済み］は Git の復元か、
   * VS Code の「元に戻す」（開いている話のとき）で戻す。
   */
  private lastUndoable: UndoableStep | null = null;

  /** 行の下に出している助言（指摘の id → 中身） */
  private readonly advice = new Map<string, AdviceView>();
  /** 考えている途中の助言の止め口（［止める］） */
  private readonly adviceAborts = new Map<string, AbortController>();

  constructor(
    context: vscode.ExtensionContext,
    private readonly work: WorkEntry,
    private readonly deps: SceneMemoDeps,
    filePath?: string,
    preserveFocus = false
  ) {
    this.currentFile = filePath ?? lastManuscriptCaret()?.filePath ?? null;

    this.panel = vscode.window.createWebviewPanel(
      SCENE_MEMO_VIEW_TYPE,
      `校正・メモパネル: ${work.title}`,
      // **原稿エディタの横へ開く**（作者の指示）。書きながら見るものなので、
      // 本文の上に重なっては用をなさない。検知が終わって自動で開くときは
      // フォーカスを原稿に残す（打っている手を止めない）
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    context.subscriptions.push(this.panel);
    this.panel.onDidDispose(() => {
      openPanels.delete(work.id);
      // 閉じたら考えている途中の助言も止める（答えを出す先が無い）
      for (const controller of this.adviceAborts.values()) controller.abort();
      this.adviceAborts.clear();
    });

    this.panel.webview.html = buildSceneMemoPanelHtml(
      createNonce(),
      this.panel.webview.cspSource
    );
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message as PanelMessage);
    });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async reload(): Promise<void> {
    await this.load();
  }

  async revealAndReload(filePath?: string, preserveFocus = false): Promise<void> {
    this.panel.reveal(this.revealColumn(preserveFocus), preserveFocus);
    if (filePath) this.currentFile = filePath;
    // 開きっぱなしのパネルは、そのあと書かれた付箋を知らない
    await this.load();
  }

  /**
   * 開いているパネルを前に出す列。
   *
   * **作者が押して開くとき**（Ctrl+Alt+M など。`preserveFocus` が偽）は
   * これまでどおり `ViewColumn.Beside`（いま前面の列の横）。
   *
   * **検知が終わって自動で前に出すとき**（作者の裁定 2026-10-04）は、
   * **パネルがいま居る列のまま**前に出す。`Beside` で前に出すと、同じ右の列に
   * 提案パネルが重なっていたときに、パネルがさらに右の3列目へ移った
   * （画面の自動テスト `test/e2e/checkOpensMemoPanel.test.ts` で見つかった）。
   * ただし、その列の前面が原稿（原稿エディター・素のエディター）なら、原稿の上に
   * 重ねないよう、これまでどおり横へ出す（6.25.11 の「原稿の列を空けない」）。
   *
   * 「前面の列」（`activeTabGroup`）では決めない。原稿エディターの中の
   * キー（Ctrl+Alt+T など）は画面から拡張機能へ渡る道もあり、そのとき前面の
   * 列が原稿の列とは限らない。見るのは、パネルが居る列に何が出ているかだけ
   */
  private revealColumn(preserveFocus: boolean): vscode.ViewColumn {
    if (!preserveFocus) return vscode.ViewColumn.Beside;
    const own = this.panel.viewColumn;
    if (own === undefined) return vscode.ViewColumn.Beside;
    try {
      const group = vscode.window.tabGroups.all.find(
        (candidate) => candidate.viewColumn === own
      );
      const input: unknown = group?.activeTab?.input;
      const manuscriptInFront =
        input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText;
      return manuscriptInFront ? vscode.ViewColumn.Beside : own;
    } catch {
      // 列を読めない環境では、これまでどおり横へ出す
      return vscode.ViewColumn.Beside;
    }
  }

  /** その本文が、この作品の話か（保存の知らせを振り分ける） */
  covers(filePath: string): boolean {
    return belongsTo(this.files, filePath);
  }

  /**
   * 原稿エディタのカーソルが動いた（設計書6.40.4）。
   *
   * **読み直さない。** 位置が変わっただけで本文は変わっていないので、
   * 光る行を付け替えて描き直すだけでよい。
   */
  noteCaret(filePath: string, line: number): void {
    if (!this.covers(filePath)) return;
    // **話が変わったら、件数と並びも変わる**（「この話 N件」「この話だけ」）。
    // 光る行が同じでも描き直す必要がある
    const movedFile =
      this.currentFile === null ||
      paths.pathKeyForComparison(this.currentFile) !==
        paths.pathKeyForComparison(filePath);
    this.currentFile = filePath;

    const near = nearestMemo(this.memos, filePath, line);
    const key = near ? memoKey(near) : "";
    if (key === this.activeKey && !movedFile) return;
    this.activeKey = key;
    this.post();
  }

  private async load(): Promise<void> {
    try {
      const collected = await collectMemos(this.work);
      this.memos = collected.memos;
      this.findings = collected.findings;
      this.files = collected.files;
      this.order = collected.order;
      this.notices = collected.notices;
      await this.loadLabels(collected.collectedTexts);
      // **提案パネルの［戻す］で戻されたら、帯を下げる**（指摘がまた並んでいる）。
      // 残すと、もう戻っているものに［戻す］が出たままになる。
      // ［済み］の帯は、ここでは下げない——開いている話の［済み］は未保存で、
      // ディスクから読み直した一覧にはそのメモがまだ居るので、同じ見方を
      // すると出した瞬間に消える
      const step = this.lastUndoable;
      if (
        step?.kind === "fix" &&
        this.findings.some((finding) => finding.id === step.finding.id)
      ) {
        this.lastUndoable = null;
      }
      // 一覧から消えた指摘（直した・見送った）の助言は捨てる
      for (const id of [...this.advice.keys()]) {
        if (!this.findings.some((finding) => finding.id === id)) {
          this.adviceAborts.get(id)?.abort();
          this.adviceAborts.delete(id);
          this.advice.delete(id);
        }
      }
      // 消えた付箋を光らせたままにしない
      if (!this.memos.some((memo) => memoKey(memo) === this.activeKey)) {
        this.activeKey = "";
      }
      this.post();
    } catch (error) {
      const detail = messageOf(error);
      logFailure("校正・メモパネル", { 作品: this.work.title, 内容: detail });
      void vscode.window.showErrorMessage(
        `校正・メモパネルを読み込めませんでした。${detail}`
      );
    }
  }

  /**
   * 話の呼び名。**作品の形式に従う**（SNS記事は「投稿3」になる）。
   *
   * **合本の中のメモは、行からその話の見出しを引く**（設計書6.40.4）。
   * ファイル単位の見出しを使い回すと、全メモに範囲表記（「第1〜219話」）が
   * 付いて、どの話のメモか分からない。題は付けない——合本のファイルが持つ
   * 題は**その話の題ではない**ので、「第2話　全話まとめ」と並んでしまう。
   *
   * @param collectedTexts 合本ファイルの中身（`collectMemos` が読んだもの）。
   *   ここで作り終えたら手放す——70万字を抱え続けない
   */
  private async loadLabels(collectedTexts: Map<string, string>): Promise<void> {
    const format = await readWorkFormat(this.work);
    this.chapterLabels = new Map();
    this.memoLabels = new Map();
    for (const file of this.files) {
      const key = paths.pathKeyForComparison(file.filePath);
      const label = formatChapterLabel(file, format) || file.fileName;
      this.chapterLabels.set(key, {
        label,
        title: episodeTitle(file, label) ?? "",
      });

      const text = collectedTexts.get(key);
      if (text === undefined) continue;
      // 索引は1ファイルにつき1度だけ作る（メモの数だけ解析し直さない）
      const index = collectedLabelIndex(text, label, format);
      for (const memo of this.memos) {
        if (paths.pathKeyForComparison(memo.filePath) !== key) continue;
        this.memoLabels.set(memoKey(memo), {
          label: index.labelAt(memo.line),
          title: "",
        });
      }
    }
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.post();
          return;
        case "next":
        case "prev":
          await this.jump(message.type);
          return;
        case "reveal": {
          // **押した行を先に光らせる**（「次へ」の jump と同じ理由。2026-10-03）。
          // カーソルの知らせが返るまでの間、前の行が光ったままだと
          // どの行へ飛んだのかが本文の光りと結びつかない
          const pressed = this.memos.find(
            (memo) =>
              memo.line === message.line &&
              paths.pathKeyForComparison(memo.filePath) ===
                paths.pathKeyForComparison(message.filePath)
          );
          if (pressed) {
            this.activeKey = memoKey(pressed);
            this.currentFile = message.filePath;
            this.post();
          }
          await this.reveal(message.filePath, message.line);
          return;
        }
        case "done":
          await this.markDone(message.filePath, message.line, message.raw);
          return;
        case "fix":
          await this.fix(message.findingId);
          return;
        case "consult":
          await this.consult(message.findingId);
          return;
        case "stopAdvice":
          this.adviceAborts.get(message.findingId)?.abort();
          return;
        case "closeAdvice":
          this.adviceAborts.get(message.findingId)?.abort();
          this.adviceAborts.delete(message.findingId);
          this.advice.delete(message.findingId);
          this.post();
          return;
        case "consultInChat":
          await this.consultInChat(message.findingId);
          return;
        case "openProposals":
          await this.deps.openProposals?.();
          return;
        case "undoFix":
          // 名前は［直す］の帯のころのまま（画面の部品を同じにしたため）。
          // 戻すのは、帯に出ている直近の1手である
          await this.undoLast();
          return;
        case "dismissFinding":
          await this.dismissFinding(message.findingId);
          return;
        case "filter":
          this.onlyCurrent = message.onlyCurrent;
          this.tag = message.tag;
          this.query = message.query;
          this.post();
          return;
        case "export":
          await this.exportMarkdown();
          return;
      }
    } catch (error) {
      const detail = messageOf(error);
      logFailure("校正・メモパネル", { 作品: this.work.title, 内容: detail });
      void vscode.window.showErrorMessage(
        `校正・メモパネルでエラーが起きました。${detail}`
      );
    }
  }

  /**
   * 「次へ」「戻る」（設計書6.96.5）。
   *
   * **付箋だけでなく、AIの指摘にも止まる。** 直したい順は本文の順であって、
   * 誰が書いたかの順ではない。
   *
   * **絞り込みは効かせる。** 「この話だけ」にしているのに話をまたいで
   * 飛ぶと、一覧に無い行へ連れて行かれる。
   */
  private async jump(direction: "next" | "prev"): Promise<void> {
    const rows = mergeNoteRows(
      this.matchedMemos(),
      this.matchedFindings(),
      this.order
    );
    const current = currentPosition(this.files);
    const target =
      direction === "next"
        ? nextNoteRow(rows, current, this.order)
        : prevNoteRow(rows, current, this.order);
    if (!target) return;
    // **光る行は先に付け替える。** 本文が動いてカーソルの知らせが返るまで
    // 少し間があり、その間だけ前の行が光っていると押した手応えが無い
    // （光らせるのは付箋だけ——指摘は開くたびに位置が決まり直すので、
    // `nearestMemo` の付け直しと噛み合わない）
    this.activeKey = target.kind === "memo" ? memoKey(target.memo) : "";
    this.currentFile = target.filePath;
    this.post();
    await this.reveal(target.filePath, target.line);
  }

  private async reveal(filePath: string, line: number): Promise<void> {
    await revealTextLocation(
      filePath,
      line,
      this.deps.revealInManuscript,
      SCENE_MEMO_KIND,
      this.work
    );
  }

  /**
   * 「済みにする」——メモの行を本文から消す（設計書6.40.4）。
   *
   * **1件ずつ確認しない。** メモは作者の付箋で、消えても原稿は無傷である
   * （取り消しは上の帯の［戻す］。作者の裁定 2026-10-04）。ただし
   * **消す前に、その行が読み込んだときのものかは必ず確かめる。**
   *
   * 消せたら帯を出す。**原稿エディタの中の Ctrl+Z では戻らない**——あれは
   * 画面の取り消しで、拡張機能の側から書き換えた［済み］の記録を持たない。
   */
  private async markDone(
    filePath: string,
    line: number,
    raw: string
  ): Promise<void> {
    // 帯の見出しは**消す前に**引いておく。読み直したあとは、合本の
    // メモ1件ずつの見出し（`memoLabels`）からこのメモが消えて引けない
    const label = this.doneLabelOf(filePath, line);

    // 1. 原稿エディタで開いていれば、その文書を書き換える
    const inEditor = await removeMemoLineInOpenManuscript(filePath, line, raw);
    if (inEditor.kind === "removed") {
      this.lastUndoable = {
        kind: "done",
        filePath,
        removed: inEditor.removed,
        label,
      };
      await this.load();
      return;
    }
    if (inEditor.kind === "changed") {
      void vscode.window.showWarningMessage(
        "本文が変わっているため、このメモを消しませんでした。" +
          "一覧を作り直します。"
      );
      await this.load();
      return;
    }

    // 2. 開いていなければ、ディスクを書き換える。
    //    **ハッシュ照合つきの経路だけを通る**（規則1）
    const content = await readTextFile(filePath);
    const next = removeMemoLine(content.text, line, raw);
    const removed = memoLineRemoval(content.text, line, raw);
    if (next === null || removed === null) {
      void vscode.window.showWarningMessage(
        "本文が変わっているため、このメモを消しませんでした。" +
          "一覧を作り直します。"
      );
      await this.load();
      return;
    }

    const result = await writeTextFilePreservingFormat(
      filePath,
      next,
      content,
      content.hash
    );
    if (result.ok) {
      this.lastUndoable = { kind: "done", filePath, removed, label };
    } else {
      // 作品のログファイルへ残す（49 の指摘、2026-09-08）
      useLogFile(this.work.folderPath);
      logLine(
        `校正・メモパネル：${filePath} の ${line}行目のメモを消せませんでした（${result.reason}）。`
      );
      void vscode.window.showWarningMessage(
        describeWriteFailure(result.reason)
      );
    }
    await this.load();
  }

  /**
   * ［直す］——修正案のある指摘を、1手で本文へ当てる（設計書6.96.5。
   * 作者の裁定 2026-10-03「［直す］1手で本文が直る」）。
   *
   * **当てるのは提案パネルの［適用］と同じ関数**（`deps.applyFinding`）。
   * ここに写しの適用処理を書かない。位置は**保存してある `hintLine` ではなく、
   * いまの行**を渡す（6.96.3）。
   *
   * 当てたら置き場に「採った」が足され、一覧から消える（読み直しは向こうが
   * 知らせてくるが、ここでも読み直す——知らせは開いているパネルにしか届かない）。
   */
  private async fix(findingId: string): Promise<void> {
    const finding = this.findings.find((item) => item.id === findingId);
    if (!finding) return;
    const applyFinding = this.deps.applyFinding;
    // 当てる口が無い・当てられない種類は、本文のその行へ飛ぶだけにする
    // （［本文へ］と同じ。直し方は作者が決める）
    if (!applyFinding || !findingAppliesDirectly(finding)) {
      await this.reveal(finding.filePath, finding.line);
      return;
    }

    const outcome = await applyFinding(this.work, finding);
    if (outcome.ok) {
      this.lastUndoable = { kind: "fix", finding };
      if (outcome.detail) void vscode.window.showInformationMessage(outcome.detail);
    } else if (outcome.reason) {
      void vscode.window.showWarningMessage(
        `この指摘を本文へ当てられませんでした。${outcome.reason}`
      );
    }
    await this.load();
  }

  /**
   * 上の帯の［戻す］。帯に出ている直近の1手（［直す］か［済み］）を戻す。
   */
  private async undoLast(): Promise<void> {
    const step = this.lastUndoable;
    if (!step) return;
    if (step.kind === "done") {
      await this.undoDone(step);
      return;
    }
    await this.undoFix(step.finding);
  }

  /**
   * ［直す］で当てた1件を戻す（設計書6.96.5）。
   *
   * **戻すのは提案パネルの［戻す］と同じ関数**（`deps.undoFindingFix`）。
   * 戻すと置き場に「戻した」が足され、その指摘がまた一覧に並ぶ。
   */
  private async undoFix(fixed: PlacedFinding): Promise<void> {
    const undo = this.deps.undoFindingFix;
    if (!undo) return;
    const outcome = await undo(this.work, fixed);
    if (outcome.ok) {
      this.lastUndoable = null;
    } else if (outcome.reason) {
      void vscode.window.showWarningMessage(
        `直したところを戻せませんでした。${outcome.reason}`
      );
    }
    await this.load();
  }

  /**
   * ［済み］で消したメモの行を、元の位置へ戻す（設計書6.40.4。作者の裁定
   * 2026-10-04「［済み］の直後に戻す帯を出す。［直す］と同じ形にする」）。
   *
   * **書き戻しは［済み］と同じ2つの経路**——原稿エディタで開いていれば
   * その文書へ `WorkspaceEdit`、開いていなければ
   * `writeTextFilePreservingFormat`（ハッシュ照合つき）。
   *
   * **元の位置が分からなければ、理由を出して何もしない**（実装ルール1）。
   * 位置は上下の隣の行で確かめる（`core/sceneMemo.ts` の
   * `memoLineRestorePoint`。2つの経路で同じ判定を使う）。
   */
  private async undoDone(step: DoneStep): Promise<void> {
    // 1. 原稿エディタで開いていれば、その文書へ差し込む
    const inEditor = await restoreMemoLineInOpenManuscript(
      step.filePath,
      step.removed
    );
    if (inEditor.kind === "restored") {
      this.lastUndoable = null;
      await this.load();
      return;
    }
    if (inEditor.kind === "changed") {
      // 位置が分からないものは、何度押しても戻らない。帯は下げる
      this.lastUndoable = null;
      void vscode.window.showWarningMessage(
        describeRestoreRefusal(step.removed.raw)
      );
      await this.load();
      return;
    }

    // 2. 開いていなければ、ディスクを書き直す。**ハッシュ照合つきの経路だけ**
    const content = await readTextFile(step.filePath);
    const next = restoreMemoLine(content.text, step.removed);
    if (next === null) {
      this.lastUndoable = null;
      void vscode.window.showWarningMessage(
        describeRestoreRefusal(step.removed.raw)
      );
      await this.load();
      return;
    }
    const result = await writeTextFilePreservingFormat(
      step.filePath,
      next,
      content,
      content.hash
    );
    if (result.ok) {
      this.lastUndoable = null;
    } else {
      // 帯は残す——未保存の変更などは、作者が片づければもう一度押せる
      useLogFile(this.work.folderPath);
      logLine(
        `校正・メモパネル：${step.filePath} の ${step.removed.line}行目のメモを戻せませんでした（${result.reason}）。`
      );
      void vscode.window.showWarningMessage(
        describeWriteFailure(result.reason, "戻す")
      );
    }
    await this.load();
  }

  /**
   * ［済み］の帯に出す場所（「第3話　2行目」の「第3話」）。
   * 押された行の付箋から引く（合本ではメモ1件ずつの見出し）。
   */
  private doneLabelOf(filePath: string, line: number): string {
    const memo = this.memos.find(
      (item) =>
        item.line === line &&
        paths.pathKeyForComparison(item.filePath) ===
          paths.pathKeyForComparison(filePath)
    );
    return memo ? this.labelOf(memo).label : this.labelAt(filePath).label;
  }

  /**
   * ［AIに相談］——修正案の無い推敲の指摘について、短い助言を行のすぐ下に出す
   * （P-47。作者の報告 2026-10-04「くどすぎます」「表示される位置が離れすぎて
   * います」。設計書6.96.5）。
   *
   * **本文にも置き場にも書かない。** 助言を読んで直すかどうかを決めるのは
   * 作者である。位置は**いまの行**を渡す（6.96.3）。
   * 同じ指摘で考えている途中なら、もう一度押しても重ねて呼ばない。
   */
  private async consult(findingId: string): Promise<void> {
    const finding = this.findings.find((item) => item.id === findingId);
    const advise = this.deps.adviseFinding;
    if (!finding || !advise) return;
    if (this.adviceAborts.has(findingId)) return;

    const controller = new AbortController();
    this.adviceAborts.set(findingId, controller);
    this.advice.set(findingId, { status: "thinking" });
    this.post();
    try {
      const outcome = await advise(this.work, finding, controller.signal);
      // 待つ間に閉じられた（止め口が外れた）なら、何もしない
      if (this.adviceAborts.get(findingId) !== controller) return;
      if (outcome.kind === "answered") {
        this.advice.set(findingId, {
          status: "answered",
          point: outcome.advice.point,
          examples: outcome.advice.examples,
          noNeed: outcome.advice.noNeed,
          cached: outcome.cached,
        });
      } else if (outcome.kind === "failed") {
        this.advice.set(findingId, { status: "failed", reason: outcome.reason });
      } else {
        // 断った・止めた——伝わっているので、行の下には何も残さない
        this.advice.delete(findingId);
      }
    } catch (error) {
      if (this.adviceAborts.get(findingId) !== controller) return;
      logFailure("校正・メモパネル：AIに相談", {
        作品: this.work.title,
        詳細: messageOf(error),
      });
      this.advice.set(findingId, {
        status: "failed",
        reason: "AIに相談できませんでした。ログに理由が残っています。",
      });
    } finally {
      if (this.adviceAborts.get(findingId) === controller) {
        this.adviceAborts.delete(findingId);
      }
    }
    this.post();
  }

  /**
   * 助言の下の「相談パネルで続ける」。押したときだけ、今までの相談パネルへ渡す。
   */
  private async consultInChat(findingId: string): Promise<void> {
    const finding = this.findings.find((item) => item.id === findingId);
    if (!finding || !this.deps.consultFinding) return;
    await this.deps.consultFinding(this.work, finding);
  }

  /**
   * 「見送る」——退けたことを追記で残す（設計書6.96.4）。
   *
   * **指摘の行は書き換えない。** 追記だけの作りなので、同期の衝突で
   * どちらかの記録が消えることがない。片方の機械で退けたものは、
   * もう片方でも退く。
   */
  private async dismissFinding(findingId: string): Promise<void> {
    const finding = this.findings.find((item) => item.id === findingId);
    if (!finding) return;
    await new FindingStore(this.work).decide([
      {
        findingId,
        time: new Date().toISOString(),
        status: "dismissed",
        // 覚え書きを訊かない。1件ずつ理由を求めると、見送りが面倒になって
        // 指摘が溜まる（溜まった指摘は結局読まれない）
        note: "",
      },
    ]);
    // **向こうの一覧からも下げる**（6.96.5）。置き場への追記は済んでいるので、
    // ここは知らせるだけである
    this.deps.noteFindingDismissed?.(this.work, findingId);
    await this.load();
  }

  /**
   * 書き出す1枚。**いま絞り込んで出ているものだけ**を、話ごとに並べる。
   *
   * **Markdownの組み立ては `core/sceneMemoMarkdown.ts` が持つ。**
   * ここへ記法を書くと、この feature のすべての文言が
   * 「記号を含んでよいもの」になってしまう。
   */
  private async exportMarkdown(): Promise<void> {
    await openGeneratedMarkdown(
      SCENE_MEMO_KIND,
      sceneMemoToMarkdown({
        workTitle: this.work.title,
        memos: this.visibleMemos(),
        totalCount: this.memos.length,
        placeOf: (memo) => this.labelOf(memo),
      }),
      { preview: false },
      // 前の名前（シーンメモ）の写しも片づける（2026-10-03 に名前を変えた）
      { work: this.work, formerKinds: SCENE_MEMO_FORMER_TITLES }
    );
  }

  /**
   * そのメモを置く場所の呼び名。
   *
   * **メモ1件ずつを鍵にする。** 合本では同じファイルの中でも話が変わるので、
   * ファイル単位では引けない。
   */
  private labelOf(memo: SceneMemo): { label: string; title: string } {
    return (
      this.memoLabels.get(memoKey(memo)) ??
      this.chapterLabels.get(paths.pathKeyForComparison(memo.filePath)) ?? {
        label: paths.basename(memo.filePath),
        title: "",
      }
    );
  }

  /** いま開いている話（比べるための表記） */
  private get currentKey(): string | null {
    return this.currentFile
      ? paths.pathKeyForComparison(this.currentFile)
      : null;
  }

  /** 絞り込みに当てはまる付箋（並べ替えはしない） */
  private matchedMemos(): SceneMemo[] {
    const currentKey = this.currentKey;
    const query = this.query.trim();
    return this.memos.filter((memo) => {
      const key = paths.pathKeyForComparison(memo.filePath);
      if (this.onlyCurrent && currentKey && key !== currentKey) return false;
      if (this.tag && memo.tag !== this.tag) return false;
      if (query && !`${memo.tag} ${memo.text}`.includes(query)) return false;
      return true;
    });
  }

  /**
   * 絞り込みに当てはまるAIの指摘。
   *
   * **タグの絞り込みは、指摘にも同じ言葉で効かせる**（種類の呼び名を
   * タグの代わりに見る）。片方にしか効かないと、絞り込んだ瞬間に
   * 指摘だけが消えて、消えた理由が画面から読み取れない。
   */
  private matchedFindings(): PlacedFinding[] {
    const currentKey = this.currentKey;
    const query = this.query.trim();
    return this.findings.filter((finding) => {
      const key = paths.pathKeyForComparison(finding.filePath);
      if (this.onlyCurrent && currentKey && key !== currentKey) return false;
      const label = findingLabelOf(finding);
      if (this.tag && label !== this.tag) return false;
      if (
        query &&
        !`${label} ${findingHeadline(finding)} ${finding.message} ${finding.original}`.includes(
          query
        )
      ) {
        return false;
      }
      return true;
    });
  }

  /** 書き出す1枚の材料。**並びは「この話 → その他」**（付箋だけ） */
  private visibleMemos(): SceneMemo[] {
    return currentFirst(
      sortMemos(this.matchedMemos(), this.order),
      this.currentKey
    );
  }

  /**
   * 画面へ出す一覧。**付箋とAIの指摘を、話数 → 行の順に混ぜたもの**
   * （設計書6.96.5）。
   *
   * 並べ方そのものは `core/sceneMemoRows.ts` が決める。ここでするのは
   * 「いま開いている話を先頭へ」の入れ替えだけである。
   */
  private visibleRows(): NoteRow[] {
    /*
      **入れ替えと印の付け直しは、`core` が順番ごと持っている**
      （`arrangeRows`。0.74.11）。ここで2つを呼び分けていたころは、
      順番を取り違えても画面を動かすまで気づけなかった。
    */
    return arrangeRows(
      mergeNoteRows(this.matchedMemos(), this.matchedFindings(), this.order),
      this.currentKey
    );
  }

  private post(): void {
    const rows = this.visibleRows();
    const currentKey = this.currentKey;
    const currentCount = currentKey
      ? this.memos.filter(
          (memo) => paths.pathKeyForComparison(memo.filePath) === currentKey
        ).length
      : 0;

    const byTag = countMemosByTag(this.memos);
    const breakdown = byTag
      .map((entry) => `${entry.tag} ${entry.count}`)
      .join("／");
    const total = this.memos.length + this.findings.length;

    void this.panel.webview.postMessage({
      type: "memos",
      data: {
        title: `校正・メモパネル：${this.work.title}`,
        countsLabel:
          (currentKey ? `この話 ${currentCount}件／` : "") +
          `作品 ${this.memos.length}件` +
          (breakdown ? `　（${breakdown}）` : "") +
          // **指摘は付箋と別に数える。** 作者が書いた件数と機械が挙げた
          // 件数が1つの数字に溶けると、どちらが増えたのか分からない
          (this.findings.length > 0
            ? `　AIの指摘 ${this.findings.length}件`
            : ""),
        rows: rows.map((row) => this.toRow(row, currentKey)),
        hasCurrent: currentKey !== null,
        // 書き出すのは付箋だけなので、指摘しか出ていないときは押せない
        hasMemosToExport: rows.some((row) => row.kind === "memo"),
        // 上の帯の［提案パネル］。開く口が渡されていなければ出さない
        canOpenProposals: this.deps.openProposals !== undefined,
        onlyCurrent: this.onlyCurrent,
        tag: this.tag,
        tags: this.tagChoices(byTag),
        // 選び口の項目ごとの色の印（作者の要望 2026-10-04「表示ジャンルすべてです」）
        tagTones: tagTonesOf(
          byTag.map((entry) => entry.tag),
          this.findings.map(findingLabelOf)
        ),
        query: this.query,
        activeKey: this.activeKey,
        totalCount: this.memos.length,
        notice: this.notices.join(" "),
        // 戻せる直近の1手（［直す］か［済み］）。戻す口が無ければ帯も出さない
        fixed: this.undoBanner(),
        emptyMessage:
          total === 0
            ? `この作品にメモはありません。${MEMO_HINT}（読者向けの出力とAIには渡りません）。`
            : "絞り込みに当てはまるものがありません。",
        // 付箋の色（明暗を選ぶ）と、指摘の種類の色（テーマの色そのもの）
        colors: { ...colorsFor(), ...findingToneVars() },
      },
    });
  }

  /**
   * 上の帯（設計書6.40.4・6.96.5）。**［直す］と［済み］で同じ部品を使う**
   * （作者の裁定 2026-10-04）。文言とボタンの説明だけが違う。
   */
  private undoBanner(): { text: string; undoTitle: string } | null {
    const step = this.lastUndoable;
    if (!step) return null;
    if (step.kind === "done") {
      return {
        text: `メモを済みにしました（${step.label}　${step.removed.line}行目）`,
        undoTitle: "済みにしたメモの行を、元の位置へ戻します",
      };
    }
    if (!this.deps.undoFindingFix) return null;
    return {
      text: `${findingHeadline(step.finding)}に直しました（${
        this.labelAt(step.finding.filePath).label
      }　${step.finding.line}行目）`,
      undoTitle: "直す前の本文へ戻します（指摘はまた一覧に並びます）",
    };
  }

  /**
   * 絞り込みの選択肢。**付箋のタグと、AIの指摘の種類を同じ一覧に並べる。**
   *
   * 並べ替えは種類で分けないが（6.96.5）、**探すときは種類で絞れたほうが
   * よい**——「矛盾だけ見たい」は直す順序ではなく探し方の話である。
   * いま在るものだけを出す（無い種類を選べても空になるだけ）。
   */
  private tagChoices(
    byTag: ReadonlyArray<{ tag: string; count: number }>
  ): string[] {
    const choices = byTag.map((entry) => entry.tag);
    for (const finding of this.findings) {
      const label = findingLabelOf(finding);
      if (!choices.includes(label)) choices.push(label);
    }
    return choices;
  }

  private toRow(row: NoteRow, currentKey: string | null): Record<string, unknown> {
    const isCurrent =
      currentKey !== null &&
      paths.pathKeyForComparison(row.filePath) === currentKey;
    // どの話を書いているか分からないうちは、「その他」と書かない
    // （何に対する「その他」なのかが伝わらない）
    const section =
      currentKey === null
        ? "この作品のメモ"
        : isCurrent
          ? "いま開いている話"
          : "その他の話";

    if (row.kind === "memo") {
      const memo = row.memo;
      const where = this.labelOf(memo);
      return {
        kind: "memo",
        key: memoKey(memo),
        filePath: memo.filePath,
        line: memo.line,
        sameLine: row.sameLine,
        tag: memo.tag,
        tagClass: memoTagClass(memo.tag),
        text: memo.text,
        note: "",
        raw: memo.raw,
        chapterLabel: where.label,
        title: where.title,
        section,
      };
    }

    const finding = row.finding;
    return {
      kind: "finding",
      // 付箋の鍵（`行:道`）と重ならない形にする。同じ一覧で引くため
      key: `f:${finding.id}`,
      findingId: finding.id,
      filePath: finding.filePath,
      line: finding.line,
      sameLine: row.sameLine,
      tag: findingLabelOf(finding),
      // 種類ごとの色（0.98.9 までは指摘は1色だった）
      tagClass: findingToneClass(findingLabelOf(finding)),
      text: findingHeadline(finding),
      note: findingNote(finding),
      raw: "",
      chapterLabel: this.labelAt(finding.filePath).label,
      title: this.labelAt(finding.filePath).title,
      // 修正案があれば［直す］（1手で当てる）、無ければ［本文へ］（6.96.5）。
      // 見送りはこの画面だけで完結するので、常に出る
      fixAction: this.fixActionOf(finding),
      // 修正案の無い推敲の指摘には［AIに相談］も出す（作者の要望 2026-10-04）。
      // **口が無ければ出さない**（押しても何も起きない口を作らない）
      canConsult: this.canConsult(finding),
      // 行のすぐ下に出す助言（P-47）。無ければ出さない
      advice: this.advice.get(finding.id) ?? null,
      // 助言の下の「相談パネルで続ける」。口が無ければ出さない
      canConsultInChat: this.deps.consultFinding !== undefined,
      section,
    };
  }

  /**
   * 指摘の行に出す押し口（設計書6.96.5）。
   *
   * - `"apply"`：［直す］。修正案があり、当てる口が渡されているとき
   * - `"reveal"`：［本文へ］。修正案が無い（または当てる口が無い）とき。
   *   行の場所を押したときと同じ道（`revealTextLocation`）で原稿のその行へ飛ぶ。
   *   作者の裁定 2026-10-04——以前は［提案へ］（提案パネルへ渡す）だった
   */
  private fixActionOf(finding: PlacedFinding): "apply" | "reveal" {
    if (this.deps.applyFinding && findingAppliesDirectly(finding)) return "apply";
    return "reveal";
  }

  /**
   * ［AIに相談］を出すか。**修正案の無い推敲の指摘だけ**（作者の要望
   * 2026-10-04）。修正案のある指摘は［直す］で済み、矛盾・逸脱は直し方の
   * 前に「設定と本文のどちらが正しいか」を作者が決める種類なので出さない。
   */
  private canConsult(finding: PlacedFinding): boolean {
    return (
      this.deps.adviseFinding !== undefined &&
      finding.category === "proofread" &&
      this.fixActionOf(finding) !== "apply"
    );
  }

  /**
   * その場所の呼び名（AIの指摘用）。
   *
   * **付箋のように1件ずつの索引を持たない。** 指摘は開くたびに位置が
   * 決まり直すので、ファイル単位の見出しで引く。合本では範囲表記に
   * なるが、行番号は正しいので飛び先は変わらない。
   */
  private labelAt(filePath: string): { label: string; title: string } {
    return (
      this.chapterLabels.get(paths.pathKeyForComparison(filePath)) ?? {
        label: paths.basename(filePath),
        title: "",
      }
    );
  }
}

/**
 * 一覧の中で1件を指す鍵。**場所と行が決まれば1つに決まる。**
 *
 * **行番号を先に置く。** 場所を先にすると、道の中に区切りと同じ文字が
 * あったときに切れ目が読めなくなる。数字が先なら、最初の区切りで必ず割れる。
 */
function memoKey(memo: SceneMemo): string {
  return `${memo.line}:${paths.pathKeyForComparison(memo.filePath)}`;
}

/**
 * 書き込みに失敗した理由を、作者の言葉にする。
 *
 * @param action 「消す」（［済み］）か「戻す」（帯の［戻す］）。理由の言い方は同じ
 */
function describeWriteFailure(
  reason: string,
  action: "消す" | "戻す" = "消す"
): string {
  const didNot = action === "消す" ? "消しませんでした" : "戻しませんでした";
  const could = action === "消す" ? "消せませんでした" : "戻せませんでした";
  if (reason === "unsaved_changes") {
    return (
      `本文に保存していない変更があるため、メモを${didNot}。` +
      "保存してからもう一度お試しください。"
    );
  }
  if (reason === "modified_externally") {
    return (
      `本文が別のところで変わっているため、メモを${didNot}。` +
      "一覧を作り直してからもう一度お試しください。"
    );
  }
  if (reason === "conflict_markers") {
    return (
      `本文に未解決の競合が含まれているため、メモを${didNot}。` +
      "「競合解決」で直してからお試しください。"
    );
  }
  return `メモを${could}。ログに理由が残っています。`;
}

/**
 * 元の位置が確かめられず、済みにしたメモを戻さなかったときの案内。
 *
 * **メモの字を添える。** 戻せなかったメモは本文のどこにも残っていないので、
 * 作者が手で書き直せるように、ここで見せる。
 */
function describeRestoreRefusal(raw: string): string {
  return (
    "済みにしたあとで本文が変わり、元の位置が分からないため、メモを戻しませんでした。" +
    `戻すなら、手で書き直すか Git の復元をお使いください（消したメモ：${raw}）。`
  );
}

/**
 * いまのテーマに合う色を選ぶ（原稿エディタの `colorsFor` と同じ考え方）。
 *
 * **16進の値も選び方も `core/sceneMemo.ts` にしかない。** ここが決めるのは
 * 明るい配色と暗い配色のどちらか、だけである。
 */
function colorsFor(): Record<string, string> {
  return memoColorVars(isDarkTheme());
}

/** いま暗い配色か。**色の選び方は `core` にあり、ここは明暗を見るだけ** */
function isDarkTheme(): boolean {
  return (
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
