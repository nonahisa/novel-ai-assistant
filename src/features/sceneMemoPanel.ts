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
  nextMemo,
  parseMemos,
  prevMemo,
  removeMemoLine,
  sortMemos,
  type MemoPosition,
  type SceneMemo,
} from "../core/sceneMemo";
import {
  SCENE_MEMO_TITLE,
  sceneMemoToMarkdown,
} from "../core/sceneMemoMarkdown";
import {
  findingCategoryLabel,
  findingColorVars,
  findingHeadline,
  findingNote,
  FINDING_DOT_CLASS,
  markSameLine,
  mergeNoteRows,
  type NoteRow,
  type PlacedFinding,
} from "../core/sceneMemoRows";
import { locateFindings } from "../core/findingLocation";
import { findingFileKey } from "../core/findingSource";
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
 * **AIの指摘を本文へ当てる口は、この画面には無い**（6.96.5）。適用は
 * 種類ごとの道（提案パネル）を通す——6.11.1 の「3つの形を同じ配列へ
 * 混ぜない」は、本文の適用処理が設定資料の更新を掴んで壊れるのを防ぐため
 * にある。ここで本文へ書く道を作ると、その線を画面の側から破ることになる。
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
   * AIの指摘を、**種類ごとの道**（提案パネル）へ渡す口（設計書6.96.5）。
   *
   * **この画面は本文を書き換えない。** 「直す」は指摘を提案パネルへ
   * 送るだけで、当てるのは向こうの既存の処理である——本文への適用を
   * ここへ書き直すと、6.11.1 で分けたはずの3つの形が画面の側で
   * また1つになる。
   *
   * **渡されなければ「直す」を出さない。** 押しても何も起きない口を
   * 作らない（この作品の決まり）。
   */
  handOverFinding?: (
    work: WorkEntry,
    finding: PlacedFinding
  ) => Promise<boolean> | boolean;
}

export async function openSceneMemoPanel(
  context: vscode.ExtensionContext,
  work: WorkEntry,
  deps: SceneMemoDeps,
  options: { filePath?: string } = {}
): Promise<void> {
  const existing = openPanels.get(work.id);
  if (existing) {
    await existing.revealAndReload(options.filePath);
    return;
  }
  const panel = new SceneMemoPanel(context, work, deps, options.filePath);
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
  if (collected.memos.length === 0) {
    void vscode.window.showInformationMessage(
      `「${work.title}」の本文にシーンメモはありません。` +
        `${MEMO_HINT}。`
    );
    return;
  }

  const current = currentPosition(collected.files);
  const target =
    direction === "next"
      ? nextMemo(collected.memos, current, collected.order)
      : prevMemo(collected.memos, current, collected.order);
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
          paths.normalizeForComparison(episode.filePath),
          content.text
        );
      }
      if (wanted.has(key)) findingTexts.set(key, content.text);
    } catch (error) {
      // **数えて残す。** 黙って落とすと、その話のメモが無いことにされる
      notices.push(`${episode.fileName} を読めませんでした。`);
      logFailure("シーンメモ：本文の読み込み", {
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
  const key = paths.normalizeForComparison(filePath);
  return files.some(
    (file) => paths.normalizeForComparison(file.filePath) === key
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
  /** AIの指摘を、種類ごとの道（提案パネル）へ渡す（設計書6.96.5） */
  | { type: "fix"; findingId: string }
  /** AIの指摘を退ける。**追記で残す**だけで、指摘の行は書き換えない */
  | { type: "dismissFinding"; findingId: string }
  | { type: "filter"; onlyCurrent: boolean; tag: string; query: string }
  | { type: "export" };

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

  constructor(
    context: vscode.ExtensionContext,
    private readonly work: WorkEntry,
    private readonly deps: SceneMemoDeps,
    filePath?: string
  ) {
    this.currentFile = filePath ?? lastManuscriptCaret()?.filePath ?? null;

    this.panel = vscode.window.createWebviewPanel(
      "novelai.sceneMemos",
      `シーンメモ: ${work.title}`,
      // **原稿エディタの横へ開く**（作者の指示）。書きながら見るものなので、
      // 本文の上に重なっては用をなさない
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    context.subscriptions.push(this.panel);
    this.panel.onDidDispose(() => openPanels.delete(work.id));

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

  async revealAndReload(filePath?: string): Promise<void> {
    this.panel.reveal(vscode.ViewColumn.Beside);
    if (filePath) this.currentFile = filePath;
    // 開きっぱなしのパネルは、そのあと書かれた付箋を知らない
    await this.load();
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
      paths.normalizeForComparison(this.currentFile) !==
        paths.normalizeForComparison(filePath);
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
      // 消えた付箋を光らせたままにしない
      if (!this.memos.some((memo) => memoKey(memo) === this.activeKey)) {
        this.activeKey = "";
      }
      this.post();
    } catch (error) {
      const detail = messageOf(error);
      logFailure("シーンメモ", { 作品: this.work.title, 内容: detail });
      void vscode.window.showErrorMessage(
        `シーンメモを読み込めませんでした。${detail}`
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
      const key = paths.normalizeForComparison(file.filePath);
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
        if (paths.normalizeForComparison(memo.filePath) !== key) continue;
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
        case "reveal":
          await this.reveal(message.filePath, message.line);
          return;
        case "done":
          await this.markDone(message.filePath, message.line, message.raw);
          return;
        case "fix":
          await this.handOver(message.findingId);
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
      logFailure("シーンメモ", { 作品: this.work.title, 内容: detail });
      void vscode.window.showErrorMessage(
        `シーンメモでエラーが起きました。${detail}`
      );
    }
  }

  private async jump(direction: "next" | "prev"): Promise<void> {
    const current = currentPosition(this.files);
    const target =
      direction === "next"
        ? nextMemo(this.memos, current, this.order)
        : prevMemo(this.memos, current, this.order);
    if (!target) return;
    // **光る行は先に付け替える。** 本文が動いてカーソルの知らせが返るまで
    // 少し間があり、その間だけ前の行が光っていると押した手応えが無い
    this.activeKey = memoKey(target);
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
   * （取り消しは原稿エディタの Ctrl+Z か Git の復元）。ただし
   * **消す前に、その行が読み込んだときのものかは必ず確かめる。**
   */
  private async markDone(
    filePath: string,
    line: number,
    raw: string
  ): Promise<void> {
    // 1. 原稿エディタで開いていれば、その文書を書き換える
    const inEditor = await removeMemoLineInOpenManuscript(filePath, line, raw);
    if (inEditor.kind === "removed") {
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
    if (next === null) {
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
    if (!result.ok) {
      // 作品のログファイルへ残す（49 の指摘、2026-09-08）
      useLogFile(this.work.folderPath);
      logLine(
        `シーンメモ：${filePath} の ${line}行目を消せませんでした（${result.reason}）。`
      );
      void vscode.window.showWarningMessage(
        describeWriteFailure(result.reason)
      );
    }
    await this.load();
  }

  /**
   * 「直す」——AIの指摘を、**種類ごとの道**へ渡す（設計書6.96.5）。
   *
   * **ここでは本文へ1文字も書かない。** 当てるのは提案パネルの既存の
   * 処理で、こちらがするのは「いまの位置に直した1件を手渡す」ことだけ
   * である。位置は開くたびに探し直しているので、**保存してある
   * `hintLine` ではなく、いまの行**を渡す（6.96.3）。
   *
   * 「採った」の記録は、**本文へ当てた側が残す**。ここで先に書くと、
   * 作者が提案パネルで見送っても「採った」ことになる。
   */
  private async handOver(findingId: string): Promise<void> {
    const finding = this.findings.find((item) => item.id === findingId);
    if (!finding) return;
    const handOverFinding = this.deps.handOverFinding;
    if (!handOverFinding) return;

    const accepted = await handOverFinding(this.work, finding);
    if (accepted) return;
    void vscode.window.showWarningMessage(
      "この指摘を提案の一覧へ渡せませんでした。" +
        "もう一度、検知をやり直してください。"
    );
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
      { work: this.work }
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
      this.chapterLabels.get(paths.normalizeForComparison(memo.filePath)) ?? {
        label: paths.basename(memo.filePath),
        title: "",
      }
    );
  }

  /** いま開いている話（比べるための表記） */
  private get currentKey(): string | null {
    return this.currentFile
      ? paths.normalizeForComparison(this.currentFile)
      : null;
  }

  /** 絞り込みに当てはまる付箋（並べ替えはしない） */
  private matchedMemos(): SceneMemo[] {
    const currentKey = this.currentKey;
    const query = this.query.trim();
    return this.memos.filter((memo) => {
      const key = paths.normalizeForComparison(memo.filePath);
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
      const key = paths.normalizeForComparison(finding.filePath);
      if (this.onlyCurrent && currentKey && key !== currentKey) return false;
      const label = findingCategoryLabel(finding.category);
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
    return this.currentFirst(sortMemos(this.matchedMemos(), this.order));
  }

  /**
   * 画面へ出す一覧。**付箋とAIの指摘を、話数 → 行の順に混ぜたもの**
   * （設計書6.96.5）。
   *
   * 並べ方そのものは `core/sceneMemoRows.ts` が決める。ここでするのは
   * 「いま開いている話を先頭へ」の入れ替えだけである。
   */
  private visibleRows(): NoteRow[] {
    const merged = mergeNoteRows(
      this.matchedMemos(),
      this.matchedFindings(),
      this.order
    );
    if (!this.currentKey) return merged;
    /*
      **入れ替えても、同じ場所の行は離れない。** 並びはファイル単位で
      切れているので、動くのはファイルごとの塊である。ただし
      「直前と同じ場所」の印は先頭でも立ったままになるので、付け直す。
    */
    return markSameLine(this.currentFirst(merged));
  }

  /**
   * いま開いている話を先頭へ寄せる。
   *
   * 書いている場面のものが下のほうにあると、横に並べた意味が薄れる。
   */
  private currentFirst<T extends { filePath: string }>(rows: T[]): T[] {
    const currentKey = this.currentKey;
    if (!currentKey) return rows;
    const here = rows.filter(
      (row) => paths.normalizeForComparison(row.filePath) === currentKey
    );
    const rest = rows.filter(
      (row) => paths.normalizeForComparison(row.filePath) !== currentKey
    );
    return [...here, ...rest];
  }

  private post(): void {
    const rows = this.visibleRows();
    const currentKey = this.currentKey;
    const currentCount = currentKey
      ? this.memos.filter(
          (memo) => paths.normalizeForComparison(memo.filePath) === currentKey
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
        title: `シーンメモ：${this.work.title}`,
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
        onlyCurrent: this.onlyCurrent,
        tag: this.tag,
        tags: this.tagChoices(byTag),
        query: this.query,
        activeKey: this.activeKey,
        totalCount: this.memos.length,
        notice: this.notices.join(" "),
        emptyMessage:
          total === 0
            ? `この作品にシーンメモはありません。${MEMO_HINT}（読者向けの出力とAIには渡りません）。`
            : "絞り込みに当てはまるものがありません。",
        colors: { ...colorsFor(), ...findingColorVars(isDarkTheme()) },
      },
    });
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
      const label = findingCategoryLabel(finding.category);
      if (!choices.includes(label)) choices.push(label);
    }
    return choices;
  }

  private toRow(row: NoteRow, currentKey: string | null): Record<string, unknown> {
    const isCurrent =
      currentKey !== null &&
      paths.normalizeForComparison(row.filePath) === currentKey;
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
      tag: findingCategoryLabel(finding.category),
      tagClass: FINDING_DOT_CLASS,
      text: findingHeadline(finding),
      note: findingNote(finding),
      raw: "",
      chapterLabel: this.labelAt(finding.filePath).label,
      title: this.labelAt(finding.filePath).title,
      // **渡す先が無ければ「直す」を出さない**（押しても何も起きない口を
      // 作らない）。見送りはこの画面だけで完結するので、常に出る
      canFix: this.deps.handOverFinding !== undefined,
      section,
    };
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
      this.chapterLabels.get(paths.normalizeForComparison(filePath)) ?? {
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
  return `${memo.line}:${paths.normalizeForComparison(memo.filePath)}`;
}

/** 書き込みに失敗した理由を、作者の言葉にする */
function describeWriteFailure(reason: string): string {
  if (reason === "unsaved_changes") {
    return (
      "本文に保存していない変更があるため、メモを消しませんでした。" +
      "保存してからもう一度お試しください。"
    );
  }
  if (reason === "modified_externally") {
    return (
      "本文が別のところで変わっているため、メモを消しませんでした。" +
      "一覧を作り直してからもう一度お試しください。"
    );
  }
  if (reason === "conflict_markers") {
    return (
      "本文に未解決の競合が含まれているため、メモを消しませんでした。" +
      "「競合解決」で直してからお試しください。"
    );
  }
  return "メモを消せませんでした。ログに理由が残っています。";
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
