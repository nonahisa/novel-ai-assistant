import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import { BOOK_DIR, parseBookConfig, type BookConfig } from "../models/book";
import { BookStore, BookStoreError } from "../core/bookStore";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import {
  BAKED_COVER_FILES,
  readImageDataUrl,
  saveBakedCover,
  type CoverSide,
} from "../core/coverBake";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import { bookHeading, episodeGroupLabel } from "../core/episodeLabel";
import { notationModeFor } from "../core/manuscriptRender";
import {
  buildChapterFragment,
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
  work: WorkEntry;
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
      data: await panelData(existing),
    });
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "novelai.epubEditor",
    `EPUB: ${work.title}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      // **作者のイラストを画面に出すのはここが初めて**（設計書6.65.8）。
      // 作品フォルダを許さないと `asWebviewUri` のURIでも読み込まれない。
      // 許すのは作品フォルダだけ——ここを広げると、作品と関係のない
      // ファイルまでWebViewから読めることになる
      localResourceRoots: [path.toUri(work.folderPath)],
    }
  );
  const state: PanelState = {
    panel,
    work,
    store,
    current: saved,
    saved,
    source,
  };

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
      side?: string;
      dataUrl?: string;
    };

    if (parsed.type === "ready") {
      // HTMLを流し込んだ直後は受け手がまだ居ない。
      // 画面から準備完了を知らせてもらってから送る（ほかのパネルと同じ）
      panel.webview.postMessage({
        type: "book",
        data: await panelData(state),
      });
      return;
    }

    if (!parsed.config) return;

    const merged = mergeConfig(state.current, parsed.config, work.title);
    if (merged.error) {
      // 表紙の場所のように、作者が字で書く欄がある。**読めない値は
      // そのまま伝える**——「読み取れませんでした」だけでは、
      // どこを直せばよいのか分からない
      panel.webview.postMessage({
        type: "status",
        text: merged.error,
        isError: true,
      });
      return;
    }
    state.current = merged.config;

    if (parsed.type === "change") {
      panel.webview.postMessage({ type: "preview", data: previewData(state) });
      return;
    }

    if (parsed.type === "imageData") {
      await sendImageData(state, coverSide(parsed.side));
      return;
    }

    if (parsed.type === "bake") {
      await bakeCover(state, coverSide(parsed.side), parsed.dataUrl ?? "");
      return;
    }

    if (parsed.type === "bakeFailed") {
      // canvas から画像を取り出せなかった。**画面の不具合なので、
      // 作者にできることは開き直すことだけ**である
      const side = coverSide(parsed.side);
      panel.webview.postMessage({
        type: "status",
        text:
          `${sideLabel(side)}の合成結果を取り出せませんでした。` +
          "パネルを開き直してからもう一度お試しください。",
        isError: true,
      });
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

/** 画面から届いた面の名。知らない値は表紙として扱う（無視より安全） */
function coverSide(raw: string | undefined): CoverSide {
  return raw === "back" ? "back" : "front";
}

function sideLabel(side: CoverSide): string {
  return side === "back" ? "裏表紙" : "表紙";
}

/** `設定/` の場所。作品設定でフォルダ名を変えていればそれに従う */
async function settingsDir(work: WorkEntry): Promise<string> {
  return workPaths(work, await readWorkConfig(work)).settings;
}

/**
 * 元イラストの中身を画面へ渡す（`readImageDataUrl` の説明を参照）。
 *
 * **読めなくても止めない。** 画面は「絵の無い合成」として静かに諦める
 * ——ここで通知を出すと、場所を打っている途中の1文字ごとに叱ることになる。
 */
async function sendImageData(
  state: PanelState,
  side: CoverSide
): Promise<void> {
  const relative =
    side === "back"
      ? state.current.backCoverImagePath
      : state.current.coverImagePath;

  let dataUrl: string | null = null;
  if (relative) {
    try {
      dataUrl = await readImageDataUrl(state.work.folderPath, relative);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("表紙の元イラストの読み込み", {
        作品: state.work.title,
        場所: relative,
        内容: message,
      });
    }
  }

  state.panel.webview.postMessage({ type: "imageData", side, dataUrl });
}

/**
 * 合成した画像を `設定/書籍/` へ焼く（設計書6.65.8）。
 *
 * **合成の指定（book.json）はここでは保存しない。** 焼いた画像と設計図は
 * 別の持ち物で、まとめて書くと「保存に失敗したので画像も焼けなかった」の
 * ような分かりにくい止まり方をする。未保存があることは status で伝える。
 */
async function bakeCover(
  state: PanelState,
  side: CoverSide,
  dataUrl: string
): Promise<void> {
  const label = sideLabel(side);

  let target: string;
  try {
    const settings = await settingsDir(state.work);
    target = (await saveBakedCover(settings, side, dataUrl)).filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("表紙の合成", {
      作品: state.work.title,
      面: label,
      内容: message,
    });
    state.panel.webview.postMessage({
      type: "status",
      text: message,
      isError: true,
    });
    await vscode.window.showErrorMessage(`${label}を焼けませんでした。${message}`);
    return;
  }

  const unsaved = isDirty(state)
    ? "（合成の指定はまだ未保存です。「保存」で book.json へ残ります）"
    : "";
  state.panel.webview.postMessage({
    type: "status",
    text: `${label}を焼きました${unsaved}`,
  });
  void vscode.window.showInformationMessage(
    `${label}を焼きました。\n${target}\n` +
      `次の書き出しから、この画像が${label}になります。`
  );
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
async function panelData(state: PanelState) {
  return {
    title: `${state.work.title} の本`,
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
    compose: {
      front: composeState(state, "front"),
      back: composeState(state, "back"),
    },
    notice: state.source.notice,
    dirty: isDirty(state),
  };
}

/**
 * 合成の欄を使えるか、使えないなら理由（設計書6.65.8）。
 *
 * **元イラストが無いときは、欄を消さずに畳んで理由を出す**
 * （`processAvailability.ts` と同じ流儀）。消してしまうと、作者は
 * 「合成ができない画面なのだ」と受け取ってしまう。
 */
function composeState(state: PanelState, side: CoverSide) {
  const label = sideLabel(side);
  const relative =
    side === "back"
      ? state.current.backCoverImagePath
      : state.current.coverImagePath;

  if (!relative) {
    return {
      enabled: false,
      uri: null,
      reason:
        `${label}の元イラストが指定されていないので、合成の欄は使えません。` +
        `作品フォルダに画像を置き、上の欄にその場所（例：素材/${label}.png）を書いてください。`,
    };
  }

  return {
    enabled: true,
    // 作品フォルダの中だけがWebViewから読める（`localResourceRoots`）
    uri: state.panel.webview
      .asWebviewUri(path.toUri(path.join(state.work.folderPath, relative)))
      .toString(),
    reason:
      `「${label}を焼く」を押すと 設定/${BOOK_DIR}/${BAKED_COVER_FILES[side]} へ保存され、` +
      "書き出しはその画像を使います。",
  };
}

interface PreviewPage {
  label: string;
  html: string;
  note: string | null;
  vertical: boolean;
  /**
   * 合成の面のとき、どちらの面か。
   *
   * **中身のHTMLではなく canvas を置く。** 本へ入るのは画像1枚なので、
   * ここに「書き出しと同じ断片」というものが無い（設計書6.65.8）。
   */
  compose?: CoverSide;
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
          // 中身は canvas が描く。**ここで組んだHTMLは使わない**
          html: "",
          compose: "front",
          note:
            "元イラストに、下の欄で選んだ文字を重ねた見た目です。" +
            "「表紙を焼く」を押すまでは、元イラストがそのまま入ります。",
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

  // 裏表紙は本の最終面（設計書6.65.8）。表紙と同じく「焼いた→元→無し」
  // の順で入るので、焼く前でも面そのものは出る
  if (config.backCoverImagePath) {
    pages.push({
      label: "裏表紙",
      html: "",
      compose: "back",
      note:
        "本の最終面（奥付の後ろ）になります。" +
        "「裏表紙を焼く」を押すまでは、元イラストがそのまま入ります。",
      vertical,
    });
  }

  return pages;
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
): { config: BookConfig; error: null } | { config: BookConfig; error: string } {
  try {
    return { config: parseBookConfig({ ...current, ...patch }, workTitle), error: null };
  } catch (error) {
    // 表紙の場所は作者が字で書く欄なので、**読めない値の中身をそのまま
    // 伝える**。画面はいまの値のまま据え置く（勝手に直さない）
    const message = error instanceof Error ? error.message : String(error);
    return { config: current, error: message };
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
