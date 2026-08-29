import * as vscode from "vscode";
import * as paths from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { scanWork } from "../core/scanner";
import { readTextFile, writeTextFilePreservingFormat } from "../core/textFile";
import { readWorkFormat } from "../core/workFormatStore";
import { episodeTitle, formatChapterLabel } from "../core/episodeLabel";
import { logFailure, logLine } from "../core/logger";
import {
  countMemosByTag,
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
 * AIは使わない——材料は本文の中の付箋だけである。
 *
 * ## 本文の書き換えは、既存の経路だけを通る
 *
 * 「済みにする」はメモの行を本文から消す。**原稿エディタで開いていれば
 * その文書へ `WorkspaceEdit`、開いていなければ
 * `writeTextFilePreservingFormat`**（ハッシュ照合つき）。
 * `atomicWriteFile` を直に呼ぶ道は作らない（規則1・6.40.6）。
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
        "本文の行頭に // と書くと付箋になります。"
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
    SCENE_MEMO_KIND
  );
}

/* ── 材料を集める ──────────────────────────────── */

interface CollectedMemos {
  memos: SceneMemo[];
  files: EpisodeFile[];
  /** 話数順のファイルの並び（次へ・戻るの順序の元） */
  order: string[];
  /** 読めなかった話。**黙って落とさない** */
  notices: string[];
}

async function collectMemos(work: WorkEntry): Promise<CollectedMemos> {
  const scan = await scanWork(work);
  const memos: SceneMemo[] = [];
  const notices: string[] = [];
  const order: string[] = [];

  for (const episode of scan.episodes) {
    order.push(episode.filePath);
    if (episode.hasConflictMarkers) {
      // どちらが本文か決められないファイルは触らない（原稿を壊さない）
      notices.push(`${episode.fileName} は未解決の競合を含むため読みません。`);
      continue;
    }
    try {
      const content = await readTextFile(episode.filePath);
      memos.push(...parseMemos(content.text, episode.filePath));
    } catch (error) {
      // **数えて残す。** 黙って落とすと、その話のメモが無いことにされる
      notices.push(`${episode.fileName} を読めませんでした。`);
      logFailure("シーンメモ：本文の読み込み", {
        ファイル: episode.filePath,
        詳細: messageOf(error),
      });
    }
  }

  return { memos: sortMemos(memos, order), files: scan.episodes, order, notices };
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
  | { type: "filter"; onlyCurrent: boolean; tag: string; query: string }
  | { type: "export" };

class SceneMemoPanel {
  private readonly panel: vscode.WebviewPanel;

  private memos: SceneMemo[] = [];
  private files: EpisodeFile[] = [];
  private order: string[] = [];
  private notices: string[] = [];
  private chapterLabels = new Map<string, { label: string; title: string }>();

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
      this.files = collected.files;
      this.order = collected.order;
      this.notices = collected.notices;
      await this.loadLabels();
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

  /** 話の呼び名。**作品の形式に従う**（SNS記事は「投稿3」になる） */
  private async loadLabels(): Promise<void> {
    const format = await readWorkFormat(this.work);
    this.chapterLabels = new Map();
    for (const file of this.files) {
      const label = formatChapterLabel(file, format) || file.fileName;
      this.chapterLabels.set(paths.normalizeForComparison(file.filePath), {
        label,
        title: episodeTitle(file, label) ?? "",
      });
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
      SCENE_MEMO_KIND
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
        placeOf: (filePath) => this.labelOf(filePath),
      }),
      { preview: false },
      { work: this.work }
    );
  }

  private labelOf(filePath: string): { label: string; title: string } {
    return (
      this.chapterLabels.get(paths.normalizeForComparison(filePath)) ?? {
        label: paths.basename(filePath),
        title: "",
      }
    );
  }

  /** 絞り込んだあとの一覧。**並びは「この話 → その他」** */
  private visibleMemos(): SceneMemo[] {
    const currentKey = this.currentFile
      ? paths.normalizeForComparison(this.currentFile)
      : null;
    const query = this.query.trim();

    const matched = this.memos.filter((memo) => {
      const key = paths.normalizeForComparison(memo.filePath);
      if (this.onlyCurrent && currentKey && key !== currentKey) return false;
      if (this.tag && memo.tag !== this.tag) return false;
      if (query && !`${memo.tag} ${memo.text}`.includes(query)) return false;
      return true;
    });

    if (!currentKey) return matched;
    // **いま開いている話を先頭へ。** 書いている場面の付箋が
    // 下のほうにあると、横に並べた意味が薄れる
    const here = matched.filter(
      (memo) => paths.normalizeForComparison(memo.filePath) === currentKey
    );
    const rest = matched.filter(
      (memo) => paths.normalizeForComparison(memo.filePath) !== currentKey
    );
    return [...here, ...rest];
  }

  private post(): void {
    const rows = this.visibleMemos();
    const currentKey = this.currentFile
      ? paths.normalizeForComparison(this.currentFile)
      : null;
    const currentCount = currentKey
      ? this.memos.filter(
          (memo) => paths.normalizeForComparison(memo.filePath) === currentKey
        ).length
      : 0;

    const byTag = countMemosByTag(this.memos);
    const breakdown = byTag
      .map((entry) => `${entry.tag} ${entry.count}`)
      .join("／");

    void this.panel.webview.postMessage({
      type: "memos",
      data: {
        title: `シーンメモ：${this.work.title}`,
        countsLabel:
          (currentKey ? `この話 ${currentCount}件／` : "") +
          `作品 ${this.memos.length}件` +
          (breakdown ? `　（${breakdown}）` : ""),
        rows: rows.map((memo) => this.toRow(memo, currentKey)),
        hasCurrent: currentKey !== null,
        onlyCurrent: this.onlyCurrent,
        tag: this.tag,
        tags: byTag.map((entry) => entry.tag),
        query: this.query,
        activeKey: this.activeKey,
        totalCount: this.memos.length,
        notice: this.notices.join(" "),
        emptyMessage:
          this.memos.length === 0
            ? "この作品にシーンメモはありません。本文の行頭に // と書くと付箋になります（読者向けの出力とAIには渡りません）。"
            : "絞り込みに当てはまるメモがありません。",
        colors: colorsFor(),
      },
    });
  }

  private toRow(
    memo: SceneMemo,
    currentKey: string | null
  ): Record<string, unknown> {
    const where = this.labelOf(memo.filePath);
    const isCurrent =
      currentKey !== null &&
      paths.normalizeForComparison(memo.filePath) === currentKey;
    return {
      key: memoKey(memo),
      filePath: memo.filePath,
      line: memo.line,
      tag: memo.tag,
      tagClass: memoTagClass(memo.tag),
      text: memo.text,
      raw: memo.raw,
      chapterLabel: where.label,
      title: where.title,
      // どの話を書いているか分からないうちは、「その他」と書かない
      // （何に対する「その他」なのかが伝わらない）
      section:
        currentKey === null
          ? "この作品のメモ"
          : isCurrent
            ? "いま開いている話"
            : "その他の話",
    };
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
  const dark =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
  return memoColorVars(dark);
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
