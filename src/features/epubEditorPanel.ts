import * as vscode from "vscode";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { parseBookConfig, type BookConfig } from "../models/book";
import { BookStore, BookStoreError } from "../core/bookStore";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { bookHeading, episodeGroupLabel } from "../core/episodeLabel";
import { notationModeFor } from "../core/manuscriptRender";
import {
  buildChapterFragment,
  escapeXml,
  type EpubChapterSource,
} from "../core/epubXhtml";
import {
  buildColophonFragment,
  buildCoverFragment,
  buildEpubCss,
  buildTitlePageFragment,
  buildTocFragment,
  scopeCssForPreview,
} from "../core/epubPackage";
import { buildEpubEditorPanelHtml } from "../views/epubEditorPanelHtml";
import { exportEpub } from "./exportEpub";
import { logFailure } from "../core/logger";

/**
 * EPUBエディター（設計書6.65.6。第2段）。
 *
 * 左の欄で本の設計図（`設定/書籍/book.json`）を編み、右で本の見た目を
 * 確かめる。**プレビューは書き出しと同じ断片・同じCSS**を使う
 * （`core/epubPackage.ts`）。画面用の組版をもう1つ持つと、直したほうだけが
 * 本物になり「見た目どおり」が壊れる。
 *
 * ## 道を2本にしない
 *
 * 「EPUBを書き出す」ボタンは第1段のコマンドと同じ `exportEpub` を呼ぶ。
 * こちらで組み立て直すと、メニューから書き出した本と画面から書き出した本が
 * 別物になる。
 *
 * ## 本文は読むだけ
 *
 * プレビューの本文は1話目の冒頭だけを読む。原稿には一切書き込まない。
 * 本文の変更は、パネルを開き直したときに取り込む（欄を触るたびに全話を
 * 読み直すと、題名を打つだけで作品全体を走査することになる）。
 */

/**
 * 開いているパネルとその状態。
 *
 * **状態をパネルと一緒に持つ。** 受け取り手（`onDidReceiveMessage`）は
 * 1度しか登録できないので、開き直しで読み直した設計図を受け取り手へ
 * 届けるには、両方が同じ入れ物を見ている必要がある。
 */
interface PanelState {
  panel: vscode.WebviewPanel;
  store: BookStore;
  /** 画面の中のいまの値 */
  current: BookConfig;
  /** 最後にファイルへ書いた値。こことの差が「未保存」 */
  saved: BookConfig;
  source: PreviewSource;
}

/** プレビューに使う本文の材料。パネルを開いたときに1度だけ集める */
interface PreviewSource {
  entries: Array<{ label: string; group: string }>;
  /** 1話目（競合を含まない最初の話）。無ければ null */
  firstChapter: EpubChapterSource | null;
  notice: string | null;
}

const openPanels = new Map<string, PanelState>();

export async function openEpubEditorPanel(
  context: vscode.ExtensionContext,
  work: WorkEntry
): Promise<void> {
  const store = new BookStore(work);

  let saved: BookConfig;
  try {
    saved = await store.load();
  } catch (error) {
    await reportLoadFailure(work, error);
    return;
  }

  const source = await collectSource(work);

  const existing = openPanels.get(work.id);
  if (existing) {
    // **開き直しは読み直しである。** 外で直された設計図と、書き足された
    // 本文をここで取り込む（画面の未保存の変更は捨てる）
    existing.store = store;
    existing.saved = saved;
    existing.current = saved;
    existing.source = source;
    existing.panel.reveal();
    existing.panel.webview.postMessage({
      type: "book",
      data: await panelData(work, existing),
    });
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "novelai.epubEditor",
    `EPUB: ${work.title}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const state: PanelState = { panel, store, current: saved, saved, source };

  openPanels.set(work.id, state);
  context.subscriptions.push(panel);
  panel.onDidDispose(() => openPanels.delete(work.id));

  panel.webview.html = buildEpubEditorPanelHtml(
    createNonce(),
    panel.webview.cspSource
  );

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const parsed = message as {
      type?: string;
      config?: Record<string, unknown>;
    };

    if (parsed.type === "ready") {
      // HTMLを流し込んだ直後は受け手がまだ居ない。
      // 画面から準備完了を知らせてもらってから送る（ほかのパネルと同じ）
      panel.webview.postMessage({
        type: "book",
        data: await panelData(work, state),
      });
      return;
    }

    if (!parsed.config) return;

    const next = mergeConfig(state.current, parsed.config, work.title);
    if (!next) {
      // 画面の選択肢しか送られてこないはずで、ここへ来るのは不具合である。
      // 黙って直すと、作者は指定が効いていないことに気づけない
      panel.webview.postMessage({
        type: "status",
        text: "設定の値を読み取れませんでした。パネルを開き直してください。",
        isError: true,
      });
      return;
    }
    state.current = next;

    if (parsed.type === "change") {
      panel.webview.postMessage({ type: "preview", data: previewData(state) });
      return;
    }

    if (parsed.type === "save") {
      if (!(await saveDraft(work, state))) return;
      panel.webview.postMessage({ type: "status", text: "保存しました" });
      return;
    }

    if (parsed.type === "export") {
      // **書き出しは `設定/書籍/book.json` を読む。** 画面の中の値と
      // 食い違ったまま書き出すと、見ていたものと違う本が出てくる
      if (isDirty(state)) {
        const answer = await vscode.window.showWarningMessage(
          "画面の変更がまだ保存されていません。保存してから書き出しますか？",
          { modal: true },
          "保存して書き出す"
        );
        if (answer !== "保存して書き出す") return;
        if (!(await saveDraft(work, state))) return;
      }
      await exportEpub(work);
    }
  });
}

/** 画面の値をファイルへ書く。書けたら true（呼び出し側はそこで続ける） */
async function saveDraft(work: WorkEntry, state: PanelState): Promise<boolean> {
  try {
    await state.store.save(state.current);
  } catch (error) {
    await reportSaveFailure(work, state.panel, error);
    return false;
  }
  state.saved = state.current;
  state.panel.webview.postMessage({
    type: "preview",
    data: previewData(state),
  });
  return true;
}

/** 画面へ渡すもの一式（最初の1回だけ。欄の値も含む） */
async function panelData(work: WorkEntry, state: PanelState) {
  return {
    title: `${work.title} の本`,
    filePath: await state.store.filePath(),
    config: state.current,
    ...previewData(state),
  };
}

/** 欄を触るたびに作り直すもの（面とCSS） */
function previewData(state: PanelState) {
  const vertical = state.current.writingMode === "vertical";
  return {
    // **書き出しと同じCSS**を、画面の枠の中へ閉じ込めただけのもの
    css: scopeCssForPreview(buildEpubCss(vertical), ".epub-page"),
    pages: buildPages(state.current, state.source, vertical),
    notice: state.source.notice,
    dirty: isDirty(state),
  };
}

interface PreviewPage {
  label: string;
  html: string;
  note: string | null;
  vertical: boolean;
}

/**
 * プレビューに出す面。
 *
 * **本に入る面と、順番まで同じにする。** ここで足したり省いたりすると、
 * 見た目どおりに編集しているつもりで別の本ができる。並びは
 * 表紙→タイトルページ→（目次）→本文→奥付（設計書6.65.3の表）。
 */
function buildPages(
  config: BookConfig,
  source: PreviewSource,
  vertical: boolean
): PreviewPage[] {
  const pages: PreviewPage[] = [];

  pages.push(
    config.coverImagePath
      ? {
          label: "表紙",
          // 画像そのものは出さない（WebViewへ画像を渡すのは第3段）
          html: coverPlaceholderFragment(config.coverImagePath),
          note:
            "表紙は画像1枚です（書き出した本には入ります）。" +
            "画像の表示と、題名を焼き込む合成は第3段で作ります。",
          vertical,
        }
      : {
          label: "表紙",
          html: buildCoverFragment(config, null),
          note:
            "表紙の画像が指定されていないので、題名だけの扉が表紙になります" +
            "（次のタイトルページと同じ組み方です）。",
          vertical,
        }
  );

  pages.push({
    label: "タイトルページ",
    html: buildTitlePageFragment(config),
    note: null,
    vertical,
  });

  if (config.tocEnabled) {
    pages.push({
      label: "目次",
      html: buildTocFragment(
        source.entries.map((entry) => ({
          // プレビューでは飛ばない。見た目は行き先で変わらない
          href: "#",
          label: entry.label,
          group: entry.group,
        })),
        {
          pattern: config.tocPattern,
          ornament: config.tocOrnament,
          colophonHref: "#",
        }
      ),
      note:
        source.entries.length === 0
          ? "本文が見つからないので、目次は空です。"
          : null,
      vertical,
    });
  }

  if (source.firstChapter) {
    pages.push({
      label: "本文の冒頭",
      html: buildChapterFragment(source.firstChapter, {
        collapseBlankLines: config.collapseBlankLines,
      }),
      note: "1話目の冒頭だけを出しています（本には全話が入ります）。",
      vertical,
    });
  }

  pages.push({
    label: "奥付",
    html: buildColophonFragment(config),
    note: null,
    vertical,
  });

  return pages;
}

/** 表紙画像の代わりに出す枠。**画像そのものは第3段まで出さない** */
function coverPlaceholderFragment(fileName: string): string {
  return (
    '<div class="cover-placeholder">表紙画像：' +
    escapeXml(fileName) +
    "</div>"
  );
}

/**
 * プレビューの材料を集める。
 *
 * **原稿は読むだけ**で、読むのも1話目の冒頭までである。見出しは
 * 走査の結果（ファイル名とヘッダー）から作れるので、全話を開く必要はない。
 */
async function collectSource(work: WorkEntry): Promise<PreviewSource> {
  const scan = await scanWork(work);
  const format = await readWorkFormat(work);

  if (scan.episodes.length === 0) {
    return {
      entries: [],
      firstChapter: null,
      notice: `「${work.title}」に本文のファイルが見つかりません。`,
    };
  }

  const entries = scan.episodes.map((episode) => ({
    label: bookHeading(episode, format),
    group: episodeGroupLabel(episode),
  }));

  const first = await readFirstChapter(scan.episodes, format);
  return {
    entries,
    firstChapter: first.chapter,
    notice: first.notice,
  };
}

/** 冒頭に出す1話。競合マーカーのある話は本にも入らないので飛ばす */
async function readFirstChapter(
  episodes: readonly EpisodeFile[],
  format: WorkFormatKey | undefined
): Promise<{ chapter: EpubChapterSource | null; notice: string | null }> {
  for (const episode of episodes) {
    let text: string;
    let conflicted: boolean;
    try {
      const file = await readTextFile(episode.filePath);
      text = file.text;
      conflicted = file.hasConflictMarkers;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("EPUBエディターのプレビュー", {
        ファイル: episode.fileName,
        内容: message,
      });
      return {
        chapter: null,
        notice: `${episode.fileName} を読めませんでした。${message}`,
      };
    }
    if (conflicted) continue;

    return {
      chapter: {
        heading: bookHeading(episode, format),
        body: excerpt(parseEpisodeMetadata(text).body),
        notation: notationModeFor(episode.fileName),
      },
      notice: null,
    };
  }

  return {
    chapter: null,
    notice:
      "本文はすべて未解決の競合を含んでいます。「競合解決」で直してください。",
  };
}

/** 冒頭だけを取る。全文を画面へ送っても、見えるのは最初の数行である */
function excerpt(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let length = 0;
  for (const line of lines) {
    out.push(line);
    length += line.length;
    if (out.length >= EXCERPT_LINES || length >= EXCERPT_CHARS) break;
  }
  return out.join("\n");
}

const EXCERPT_LINES = 40;
const EXCERPT_CHARS = 800;

/**
 * 画面から届いた値を設計図へ重ねる。
 *
 * **検証は `parseBookConfig` に通す。** 画面の選択肢しか送られてこない
 * はずだが、通しておけば「知らない値が入った設計図」を書かずに済む。
 * 表紙の場所のように画面が持たない項目は、読み込んだ値をそのまま運ぶ。
 */
function mergeConfig(
  current: BookConfig,
  patch: Record<string, unknown>,
  workTitle: string
): BookConfig | null {
  try {
    return parseBookConfig({ ...current, ...patch }, workTitle);
  } catch {
    return null;
  }
}

function isDirty(state: PanelState): boolean {
  return JSON.stringify(state.current) !== JSON.stringify(state.saved);
}

async function reportLoadFailure(
  work: WorkEntry,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logFailure("本の設計図の読み込み", { 作品: work.title, 内容: message });
  await vscode.window.showErrorMessage(message);
}

async function reportSaveFailure(
  work: WorkEntry,
  panel: vscode.WebviewPanel,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logFailure("本の設計図の保存", {
    作品: work.title,
    種類: error instanceof BookStoreError ? error.kind : "unknown",
    内容: message,
  });
  panel.webview.postMessage({ type: "status", text: message, isError: true });
  await vscode.window.showErrorMessage(message);
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
