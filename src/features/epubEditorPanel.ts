import * as vscode from "vscode";
import * as path from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import {
  AFTERWORD_FILE,
  BOOK_BLOCK_LABELS,
  BOOK_BLOCK_TYPES,
  BOOK_DIR,
  activeBookBlocks,
  canAddBookBlock,
  canRemoveBookBlock,
  canResumeBookBlock,
  canSuspendBookBlock,
  dropBookBlock,
  insertBookBlockAfter,
  isBookBlockSuspended,
  isBookImageBlock,
  moveBookBlock,
  parseBookConfig,
  removeBookBlockAt,
  resolveBookBlocks,
  setBookBlockSuspended,
  type BookBlock,
  type BookBlockType,
  type BookBodyPosition,
  type BookConfig,
  type BookImageBlock,
} from "../models/book";
import { BookStore, BookStoreError, episodePathFor } from "../core/bookStore";
import { ChapterStore } from "../core/chapterStore";
import type { Chapter } from "../models/chapter";
import {
  episodeGroupLabels,
  formatChapterRange,
  groupEpisodesByChapter,
} from "../core/chapterGrouping";
import { startChapterAt } from "./manageChapters";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import {
  BAKED_COVER_FILES,
  bakedCoverInfo,
  deleteBakedCover,
  describeBakedPreview,
  readImageDataUrl,
  saveBakedCover,
  type CoverSide,
} from "../core/coverBake";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { readWorkFormat } from "../core/workFormatStore";
import type { WorkFormatKey } from "../core/workFormat";
import {
  bookHeading,
  episodeTitle,
  formatChapterLabel,
} from "../core/episodeLabel";
import { notationModeFor, tokenizeLine } from "../core/manuscriptRender";
import type { NotationMode } from "../core/manuscriptRender";
import {
  buildChapterFragment,
  countParagraphs,
  describeMissingFaceImage,
  describeMissingIllustrationImage,
  describePlacementOverflow,
  missingEpisodeNotices,
  placementsIn,
  splitParagraphs,
  type EpubChapterSource,
  type EpubIllustrationPlacement,
} from "../core/epubXhtml";
import {
  AFTERWORD_HEADING,
  buildAfterwordFragment,
  buildBackCoverFragment,
  buildColophonFragment,
  buildCoverFragment,
  buildEpubCss,
  buildPlateFragment,
  buildTitlePageFragment,
  buildTocFragment,
  buildTocLabel,
  scopeCssForPreview,
} from "../core/epubPackage";
import {
  buildCharacterPageFragment,
  characterIconPath,
  selectBookCharacters,
  toCharacterEntry,
} from "../core/epubCharacterPage";
import { CharacterStore } from "../core/characterStore";
import { buildEpubEditorPanelHtml } from "../views/epubEditorPanelHtml";
import { openInDefaultEditor } from "../views/openDocument";
import { atomicWriteFile } from "../core/atomicWrite";
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
  /**
   * 話ごとの段落数（設計書6.65.10）。
   *
   * **読んだ話だけが入る。** 数えていない話について「位置が本文より
   * 後ろです」とは言えない（嘘になる）。話を選んだときと、開いた時点で
   * 指定のある話について数える。
   */
  paragraphs: Map<string, number>;
}

/** プレビューに使う本文の材料。パネルを開いたときに1度だけ集める */
interface PreviewSource {
  episodes: PreviewEpisode[];
  /**
   * 走査そのままの話（設計書6.65.15の段C）。
   *
   * **章立ての束ねと、「ここから章を始める」に渡すために持つ。**
   * `PreviewEpisode` は画面へ渡す形なので、台帳の側が必要とする
   * `EpisodeFile` は落ちている。
   */
  episodeFiles: EpisodeFile[];
  /** 話数の言い方を決める作品の形式（章の範囲「第1話〜第5話」に使う） */
  format: WorkFormatKey | undefined;
  /**
   * 話と章の一覧（設計書6.65.15の段C）。
   *
   * **章の行は台帳から写したもの**で、画面では直せない（6.66が正）。
   * 章を足したときだけ組み直す。
   */
  outline: OutlineEntry[];
  /** 1話目（競合を含まない最初の話）。無ければ null */
  firstChapter: EpubChapterSource | null;
  /** その1話目を book.json ではどう指すか（挿絵の絞り込みに使う） */
  firstChapterPath: string | null;
  notice: string | null;
  /**
   * 登場人物一覧に載る人（設計書6.65.11）。
   *
   * **欄を切り替えるたびに台帳を読み直さない**ので、開いたときに1度だけ
   * 集める（本文と同じ扱い）。台帳を直したら、パネルを開き直せば入る。
   */
  characters: PreviewCharacter[];
  /**
   * あとがきの原稿（設計書6.65.15）。**中身が無ければ null**（面も出ない）。
   *
   * 本文と同じで、**開いたときに1度だけ**読む。書いたものをプレビューへ
   * 映すには、パネルを開き直す（欄を触るたびに読み直さない）。
   */
  afterword: PreviewAfterword | null;
}

/** あとがきの原稿。組版は本文とまったく同じ経路を通る */
interface PreviewAfterword {
  text: string;
  notation: NotationMode;
}

/** 一覧に載る人物1人。**台帳の項目を全部は持たない**（設計書6.65.11） */
interface PreviewCharacter {
  name: string;
  reading: string | null;
  summary: string;
  /**
   * 人物イラストの場所（作品フォルダからの相対パス）。
   *
   * **無い・読めない・外を指しているものは null**。その人物は名前だけに
   * なる（本と同じ振る舞い）。
   */
  iconPath: string | null;
}

/** 目次と、挿絵の欄の「話を選ぶ」に出す1話 */
interface PreviewEpisode {
  /** book.json の `episodePath` と同じ形（作品フォルダからの相対パス） */
  path: string;
  /** 番号＋題（挿絵の「話を選ぶ」欄など、目次以外でも使う既定の見え方） */
  label: string;
  /**
   * 目次の見出しの形（設計書6.65.15）。`label` から番号と題を分けて持つ
   * ——目次だけ `tocEntryStyle` に従って組み替えるため。
   */
  numberLabel: string;
  title: string | null;
  group: string;
  /** 絶対パス。**画面へは渡さない**（作品の外を教える必要が無い） */
  filePath: string;
  notation: NotationMode;
  /**
   * 未解決の競合を含むか（設計書6.65.10）。
   *
   * **この話は本から外れる**（`exportEpub` が外す）。走査が既に見ている
   * ので、ここで本文を読み直さずに分かる。
   */
  conflicted: boolean;
}

/**
 * 話と章の一覧の1行（設計書6.65.15の段C）。
 *
 * **章の行は読み取り専用**である。章立ての台帳（6.66）が正なので、
 * 直すのは作品一覧の右クリックからで、この一覧では選ぶこともできない。
 */
type OutlineEntry =
  | { kind: "chapter"; label: string }
  | { kind: "episode"; path: string; label: string };

/**
 * 本の並びの1行（設計書6.65.15の段C）。
 *
 * **呼び名も「消せるか」も拡張機能側で決める。** 画面が面の呼び名を持つと、
 * 種類を増やしたときに2か所を直すことになる（`BOOK_BLOCK_LABELS` が1か所）。
 */
interface BlockRow {
  type: BookBlockType;
  label: string;
  /** 行に添える一言（口絵・扉絵の画像の場所）。無ければ null */
  detail: string | null;
  imagePath?: string;
  caption?: string;
  /** 削除のボタンを出すか。**本文だけ false**（1冊にちょうど1つ） */
  removable: boolean;
  /**
   * 保留中か（設計書6.65.15の段D）。行は薄く出し、「保留」の印を添える
   * ——**消えたのではなく、本に入らないだけ**だと分かるようにする。
   */
  suspended: boolean;
  /**
   * 保留にできるか。**本文だけ false**（本文の無い本になる）。
   *
   * 「本文かどうか」の判断を画面へ写さないための項目である（削除の
   * `removable` と同じ扱い）。
   */
  suspendable: boolean;
}

/**
 * 右クリックの「この後ろに挿入」に並べる種類（設計書6.65.15の段D）。
 *
 * **呼び名も「置けるか」も拡張機能側で決める。** 段Cまでは右のパレットの
 * 押せる・押せないだったものが、段Dでメニューの行になった——出す場所が
 * 変わっただけで、判断の持ち主は変えていない。
 */
interface InsertTypeEntry {
  key: string;
  /** メニューに出す呼び名（`BOOK_BLOCK_LABELS` の1か所から取る） */
  label: string;
  /** 置けるか。**置けないものはメニューに出さない**（作者の指定） */
  enabled: boolean;
  reason: string;
}

/**
 * 焼いた画像を画面で見せるための一式（設計書6.65.8）。
 *
 * **中身は持たない。** 画面は `asWebviewUri` で読むので、要るのは在りかと
 * 「いつ焼いたか」だけである。
 */
interface BakedPreview {
  uri: string;
  bakedAt: Date;
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
  // 指定のある話だけ、開いた時点で段落数を数えておく。**位置のずれを
  // 書き出して初めて知るのでは遅い**（設計書6.65.10）
  const paragraphs = await countPlacedEpisodes(source, saved);

  const existing = openPanels.get(work.id);
  if (existing) {
    // **開き直しは読み直しである。** 外で直された設計図と、書き足された
    // 本文をここで取り込む（画面の未保存の変更は捨てる）
    existing.store = store;
    existing.saved = saved;
    existing.current = saved;
    existing.source = source;
    existing.paragraphs = paragraphs;
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
    paragraphs,
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
      episodePath?: string;
      /** 並びの編集（設計書6.65.15の段C）。位置は画面が覚えている */
      index?: number;
      direction?: number;
      /** ドラッグ（設計書6.65.15の段D）。掴んだ面と、落とした隙間 */
      from?: number;
      before?: number;
      blockType?: string;
      imagePath?: string;
      caption?: string;
      /** 保留の切り替え（設計書6.65.15の段D）。真なら保留、偽なら解除 */
      suspended?: boolean;
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

    if (parsed.type === "episode") {
      // 段落の一覧は**本文を読まないと作れない**。選ばれた話だけ読む
      // （欄を触るたびに全話を読み直すと、題名を打つだけで作品全体を
      // 走査することになる）
      await sendParagraphs(state, parsed.episodePath ?? "");
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
      panel.webview.postMessage({
        type: "preview",
        data: await previewData(state),
      });
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

    if (parsed.type === "unbake") {
      await removeBakedCover(state, coverSide(parsed.side));
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

    // 並びの編集（設計書6.65.15の段C）。**どれも `blocks` を作り直すだけ**で、
    // 原稿にも台帳にも触らない（章区切りだけが例外で、下の `addChapter`）
    if (parsed.type === "insertBlock") {
      await insertBlock(state, parsed.blockType ?? "", parsed.index ?? -1);
      return;
    }

    if (parsed.type === "moveBlock") {
      await moveBlockAt(
        state,
        parsed.index ?? -1,
        parsed.direction === -1 ? -1 : 1
      );
      return;
    }

    if (parsed.type === "dropBlock") {
      // ドラッグで落とした（設計書6.65.15の段D）。取りやめ（Escや枠の外）は
      // 画面が知らせてこないので、ここへ来る＝どこかへ落ちた、である
      await dropBlockAt(state, parsed.from ?? -1, parsed.before ?? -1);
      return;
    }

    if (parsed.type === "removeBlock") {
      await removeBlockAt(state, parsed.index ?? -1);
      return;
    }

    if (parsed.type === "suspendBlock") {
      // 保留の切り替え（設計書6.65.15の段D）。**面は消えない**
      await setSuspended(state, parsed.index ?? -1, parsed.suspended === true);
      return;
    }

    if (parsed.type === "blockEdit") {
      await editImageBlock(state, parsed.index ?? -1, {
        imagePath: parsed.imagePath ?? "",
        caption: parsed.caption ?? "",
      });
      return;
    }

    if (parsed.type === "addChapter") {
      // **章は blocks に入らない**（台帳が正。設計書6.65.15・6.66）
      await addChapter(state);
      return;
    }

    if (parsed.type === "openAfterword") {
      // **原稿は作者が書く**（設計書6.65.15）。ここは入口だけを用意する
      await openAfterword(state);
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

/* ---- 本の並びを編む（設計書6.65.15の段C） -------------------------- */

/** 画面の右上に出す一言。ここを通しておくと、送り忘れの形が揃う */
function status(state: PanelState, text: string, isError = false): void {
  state.panel.webview.postMessage({ type: "status", text, isError });
}

/**
 * 並びを差し替える。**必ず `parseBookConfig` を通す**（`mergeConfig`）。
 *
 * 画面から来た並びをそのまま設計図へ入れると、**受け取ってもらえない
 * book.json を保存してしまう**（絵の場所が空の口絵、2つある表紙）。
 * 読めない形なら、そう言って画面の値は据え置く。
 *
 * @param selectBlock 直したあとに選ばせたい行。省略すると画面の選びが残る
 */
async function applyBlocks(
  state: PanelState,
  blocks: readonly BookBlock[],
  selectBlock?: number
): Promise<boolean> {
  const merged = mergeConfig(
    state.current,
    { blocks: [...blocks] },
    state.work.title
  );
  if (merged.error) {
    status(state, merged.error, true);
    return false;
  }

  state.current = merged.config;
  // **面を出し直してから status を送る**（先に送ると、面の出し直しが消す。
  // 焼いた画像を消すときと同じ順序）
  const data = await previewData(state);
  state.panel.webview.postMessage({
    type: "preview",
    data: selectBlock === undefined ? data : { ...data, selectBlock },
  });
  return true;
}

/** 画面から届いた種類。知らない値は受け取らない（黙って別の面にしない） */
function blockTypeOf(raw: string): BookBlockType | null {
  return (BOOK_BLOCK_TYPES as readonly string[]).includes(raw)
    ? (raw as BookBlockType)
    : null;
}

/**
 * 選んでいる面の後ろへ1つ挿す。
 *
 * **口絵・扉絵は、絵の場所を先に訊く。** 絵の無い面は設計図が受け取らない
 * ので（`models/book.ts`）、空のまま挿すと保存できない本ができる。
 */
async function insertBlock(
  state: PanelState,
  rawType: string,
  index: number
): Promise<void> {
  const type = blockTypeOf(rawType);
  if (!type) return;

  const blocks = resolveBookBlocks(state.current);
  const label = BOOK_BLOCK_LABELS[type];

  let block: BookBlock;
  if (type === "frontIllustration" || type === "sectionArt") {
    const imagePath = await askText({
      title: `${label}を入れる`,
      prompt: `${label}にする画像の場所を、作品フォルダからの相対パスで書いてください。`,
      placeHolder: "素材/口絵.png",
      validateInput: (value) =>
        value.trim() ? undefined : "画像の場所を書いてください。",
    });
    if (!imagePath?.trim()) return;
    block = { type, imagePath: imagePath.trim(), caption: "" };
  } else {
    block = { type };
  }

  const next = insertBookBlockAfter(blocks, index, block);
  if (!next) {
    status(state, `${label}は1冊に1つだけです。既に本の並びに入っています。`, true);
    return;
  }

  const at = index < 0 || index >= blocks.length ? blocks.length : index + 1;
  if (!(await applyBlocks(state, next, at))) return;
  status(
    state,
    `${label}を入れました（「保存」を押すと book.json に残ります）`
  );
}

/** 面を1つ上下へ動かす。端では何も起きない（画面でも押せなくしてある） */
async function moveBlockAt(
  state: PanelState,
  index: number,
  direction: -1 | 1
): Promise<void> {
  const blocks = resolveBookBlocks(state.current);
  const next = moveBookBlock(blocks, index, direction);
  if (!next) return;
  await applyBlocks(state, next, index + direction);
}

/**
 * 掴んだ面を、落とした隙間へ動かす（設計書6.65.15の段D。作者の指定）。
 *
 * **並びの計算は `dropBookBlock` が持つ**（画面は「どの行のどちら側で
 * 離したか」だけを測る）。落とし先が元と同じ・範囲の外なら null が返り、
 * **何も起きない**——Escで取りやめたときや枠の外で離したときに、並びが
 * 黙って変わらないのはこの一本道による。
 *
 * **本文も動かせる**（外せないだけ）。章の後ろに置く本のように、本文の
 * 位置を変える組み方があるので、移動まで縛らない。
 */
async function dropBlockAt(
  state: PanelState,
  from: number,
  before: number
): Promise<void> {
  const blocks = resolveBookBlocks(state.current);
  const next = dropBookBlock(blocks, from, before);
  if (!next) return;

  // 動かした面をそのまま選ばせる（続けて設定を触れるように）
  await applyBlocks(state, next, before > from ? before - 1 : before);
}

/** 面を1つ外す。**本文は外せない**（画面にも削除のボタンを出していない） */
async function removeBlockAt(state: PanelState, index: number): Promise<void> {
  const blocks = resolveBookBlocks(state.current);
  if (!canRemoveBookBlock(blocks, index)) {
    status(
      state,
      "本文は1冊にちょうど1つなので、本の並びから外せません。",
      true
    );
    return;
  }

  const label = BOOK_BLOCK_LABELS[blocks[index].type];
  const next = removeBookBlockAt(blocks, index);
  if (!next) return;
  // 消した行の1つ手前を選ばせる（末尾を消したときに選びが宙に浮かない）
  if (!(await applyBlocks(state, next, Math.max(0, index - 1)))) return;
  status(state, `${label}を本の並びから外しました`);
}

/**
 * 面の保留を切り替える（設計書6.65.15の段D。作者の依頼、2026-09-04）。
 *
 * **保留は消すことの代わりではない。** 面は並びに残り、選べば編集画面も
 * プレビューも出る——表紙を2案持って見比べるための道である。本へ入らない
 * のは書き出しとプレビューの組み立て（`activeBookBlocks`）が外すから。
 *
 * **断るときは必ず理由を言う。** できないことは2つあり、直し方が違う：
 * 本文の保留（そもそもできない）と、同じ種類の有効な面が居る解除
 * （もう片方を先に保留か削除にすれば通る）。
 */
async function setSuspended(
  state: PanelState,
  index: number,
  suspended: boolean
): Promise<void> {
  const blocks = resolveBookBlocks(state.current);
  const block = blocks[index];
  if (!block) return;

  const label = BOOK_BLOCK_LABELS[block.type];
  const next = setBookBlockSuspended(blocks, index, suspended);
  if (!next) {
    const reason = suspendRefusal(blocks, index, suspended, label);
    if (reason) status(state, reason, true);
    return;
  }

  // 切り替えた面をそのまま選ばせる（2案を見比べる流れが途切れない）
  if (!(await applyBlocks(state, next, index))) return;
  status(
    state,
    suspended
      ? `${label}を保留にしました（本には入りませんが、選べば見比べられます）`
      : `${label}の保留を解除しました（本に入ります）`
  );
}

/**
 * 保留を切り替えられない理由（設計書6.65.15の段D）。
 *
 * **言えることが無ければ null。** 範囲の外や、既にその状態になっている
 * ときは「押しても何も起きない」でよい（並びが変わらないので、作者に
 * できることも無い）。
 */
function suspendRefusal(
  blocks: readonly BookBlock[],
  index: number,
  suspended: boolean,
  label: string
): string | null {
  const block = blocks[index];
  if (!block) return null;

  if (suspended) {
    return block.type === "body"
      ? "本文は保留にできません（本文の無い本になります）。"
      : null;
  }
  // 解除できないのは「同じ種類の有効な面が居る」ときだけである
  // （`canResumeBookBlock`）。**黙って2つ有効にしない**
  return isBookBlockSuspended(block) && !canResumeBookBlock(blocks, index)
    ? `${label}は1冊に1つだけです。先にもう片方を保留にするか、削除してください。`
    : null;
}

/** 口絵・扉絵の欄（絵の場所と解説文）を書き換える */
async function editImageBlock(
  state: PanelState,
  index: number,
  values: { imagePath: string; caption: string }
): Promise<void> {
  const blocks = resolveBookBlocks(state.current);
  const block = blocks[index];
  if (!block || !isBookImageBlock(block)) return;

  const next = blocks.map((entry, position) =>
    position === index
      ? {
          ...(entry as BookImageBlock),
          imagePath: values.imagePath.trim(),
          caption: values.caption.trim(),
        }
      : entry
  );
  await applyBlocks(state, next);
}

/**
 * 章区切りを入れる（設計書6.65.15・6.66）。
 *
 * **並びには入れない。** 章立ての台帳（`設定/章立て.json`）が正なので、
 * 書き込みは作品一覧と同じ道（`startChapterAt`）を通す——ハッシュ照合も
 * 重複の判定も、そちらが1か所で持っている。
 */
async function addChapter(state: PanelState): Promise<void> {
  const episodes = state.source.episodeFiles;
  if (episodes.length === 0) {
    status(state, "本文の話が見つからないので、章を始められません。", true);
    return;
  }

  const items = episodes.map((episode) => ({
    label: bookHeading(episode, state.source.format),
    description: episode.fileName,
    episode,
  }));
  const picked = await vscode.window.showQuickPick(
    [...items, cancelItem()],
    {
      title: "章区切りを入れる",
      placeHolder: "どの話から章を始めますか？",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return;

  const chosen = (picked as { episode?: EpisodeFile }).episode;
  if (!chosen) return;
  if (!(await startChapterAt(state.work, chosen))) return;

  // 台帳が変わった。一覧を組み直し、作品一覧にも反映させる
  await refreshChapterViews(state);
  state.panel.webview.postMessage({
    type: "preview",
    data: await previewData(state),
  });
  await vscode.commands.executeCommand("novelai.refresh");
  status(state, "章立ての台帳へ書きました（本の並びには入りません）");
}

/**
 * 台帳を読み直して、章に関わる画面の材料を作り直す（設計書6.66.4の3）。
 *
 * **一覧の行と目次の束ねを、必ず一緒に直す。** 章を足したのに目次の
 * 束ねが古いままだと、同じ画面の中で章の切れ目が2通りに見える。
 */
async function refreshChapterViews(state: PanelState): Promise<void> {
  const chapters = await loadChapterLedger(state.work);
  const labels = episodeGroupLabels(
    state.source.episodeFiles,
    chapters,
    state.work.folderPath
  );
  for (const episode of state.source.episodes) {
    episode.group = labels.get(episode.path) ?? "";
  }
  state.source.outline = collectOutline(state.work, state.source, chapters);
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
  // **焼いたら面を出し直す。** 本へ入るのは焼いた画像なので、プレビューも
  // そちらへ切り替わらないと、画面と本の中身が食い違う（設計書6.65.8）
  state.panel.webview.postMessage({
    type: "preview",
    data: await previewData(state),
  });
  state.panel.webview.postMessage({
    type: "status",
    text: `${label}を焼きました${unsaved}`,
  });
  void vscode.window.showInformationMessage(
    `${label}を焼きました。\n${target}\n` +
      `次の書き出しから、この画像が${label}になります。`
  );
}

/**
 * 焼いた画像を消す（設計書6.65.8）。
 *
 * ## なぜ消す道が要るのか
 *
 * 焼いた画像は元イラストより先に拾われる。**焼いたあとで元イラストを
 * 差し替えても、`coverImagePath` を空にしても、本には古い焼き上がりが
 * 入り続ける**（作者からは「直したのに変わらない」と見える）。消す道を
 * 置けば、どちらの場合も「画面で見えているもの＝本に入るもの」へ戻せる。
 *
 * **消すのは `設定/書籍/` の `_合成済み` の2つだけ**である。場所は
 * `bakedCoverPath` から取り（`core/coverBake.ts`）、組み立てでは作らない
 * ——作者が手で置いた表紙を消す道を、間違っても作らないため。
 */
async function removeBakedCover(
  state: PanelState,
  side: CoverSide
): Promise<void> {
  const label = sideLabel(side);

  let removed: string | null;
  try {
    removed = await deleteBakedCover(await settingsDir(state.work), side);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("焼いた表紙の削除", {
      作品: state.work.title,
      面: label,
      内容: message,
    });
    state.panel.webview.postMessage({
      type: "status",
      text: message,
      isError: true,
    });
    await vscode.window.showErrorMessage(
      `${label}の焼いた画像を消せませんでした。${message}`
    );
    return;
  }

  if (!removed) {
    // 消すものが無い。**画面は何も変わらない**ので、出し直しもしない
    state.panel.webview.postMessage({
      type: "status",
      text: `${label}の焼いた画像はありません。`,
    });
    return;
  }

  // 面を出し直してから status を送る（先に送ると、面の出し直しが消す）
  state.panel.webview.postMessage({
    type: "preview",
    data: await previewData(state),
  });
  state.panel.webview.postMessage({
    type: "status",
    text: `${label}の焼いた画像を消しました`,
  });
  void vscode.window.showInformationMessage(
    `${label}の焼いた画像を消しました。\n${removed}\n${describeAfterUnbake(
      state,
      side
    )}`
  );
}

/** 消したあと、次の書き出しで何が入るか。**本と同じ拾い順で言う** */
function describeAfterUnbake(state: PanelState, side: CoverSide): string {
  const label = sideLabel(side);
  const source =
    side === "back"
      ? state.current.backCoverImagePath
      : state.current.coverImagePath;

  if (source) {
    return `次の書き出しからは、元イラスト（${source}）が${label}になります。`;
  }
  return side === "back"
    ? "元イラストの指定も無いので、裏表紙の面は本に入りません。"
    : "元イラストの指定も無いので、題名だけの扉が表紙になります。";
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
    data: await previewData(state),
  });
  return true;
}

/** 画面へ渡すもの一式（最初の1回だけ。欄の値も含む） */
async function panelData(state: PanelState) {
  return {
    title: `${state.work.title} の本`,
    filePath: await state.store.filePath(),
    config: state.current,
    ...(await previewData(state)),
  };
}

/**
 * 欄を触るたびに作り直すもの（面とCSS）。
 *
 * **ファイルを見に行くので非同期である。** 焼いた画像があるか、挿絵の
 * 画像が置かれているか——どちらも「いま」の状態を見せないと、画面と本の
 * 中身が食い違う（覚え込むと、作者が画像を置いても警告が消えない）。
 */
async function previewData(state: PanelState) {
  const vertical = state.current.writingMode === "vertical";
  const baked = await bakedCovers(state);
  const missingImages = await missingIllustrationImages(state);
  // 口絵・扉絵の画像（設計書6.65.15）。**面ごと本に入らない**ので、
  // 画面でも面を出さずに理由を言う（挿絵と同じ「覚え込まない」扱い）
  const missingFaces = await missingFaceImages(state);
  const blocks = resolveBookBlocks(state.current);

  return {
    // 本の並び（右の縦の列）と、右クリックで挿せる種類（設計書6.65.15の段D）
    blocks: blockRows(blocks),
    insertTypes: insertTypeEntries(blocks),
    // **書き出しと同じCSS**を、画面の枠の中へ閉じ込めただけのもの。
    // 同梱する書体も当てる（設計書6.65.11）——本と同じ字面で確かめられ
    // ないと、書体を選ぶ意味が無い
    css: scopeCssForPreview(
      buildEpubCss(vertical, {
        bodyHref: fontUri(state, state.current.fonts.body),
        headingHref: fontUri(state, state.current.fonts.heading),
      }),
      ".epub-page"
    ),
    pages: buildPages(state, vertical, baked, missingFaces),
    characterNotice: characterNotice(state),
    compose: {
      front: composeState(state, "front", baked.front),
      back: composeState(state, "back", baked.back),
    },
    // 本文の面で選ぶ話と、その間に挟まる章（設計書6.65.15の段C）。
    // **絶対パスは渡さない**（作品の外を画面へ教える必要が無い）
    outline: state.source.outline,
    placementWarnings: placementWarnings(state, missingImages, missingFaces),
    notice: state.source.notice,
    dirty: isDirty(state),
  };
}

/**
 * 本の並びの行（設計書6.65.15の段C）。
 *
 * **呼び名は `BOOK_BLOCK_LABELS` の1か所から取る。** 通知にも画面にも
 * 同じ言葉が出る（種類を増やしたときに直す場所を増やさない）。
 */
function blockRows(blocks: readonly BookBlock[]): BlockRow[] {
  return blocks.map((block, index) => ({
    type: block.type,
    label: BOOK_BLOCK_LABELS[block.type],
    // 口絵・扉絵は同じ呼び名の面が並ぶので、どの絵かを添える
    detail: isBookImageBlock(block) ? block.imagePath : null,
    imagePath: isBookImageBlock(block) ? block.imagePath : undefined,
    caption: isBookImageBlock(block) ? block.caption : undefined,
    removable: canRemoveBookBlock(blocks, index),
    // 保留（設計書6.65.15の段D）。**解除できるかはここで決めない**
    // ——同じ種類の有効な面が居るかは押したときに見て、理由を言って断る
    // （「押しても無反応」を作らないための、挿入と同じ扱い）
    suspended: isBookBlockSuspended(block),
    suspendable: canSuspendBookBlock(blocks, index),
  }));
}

/**
 * 「この後ろに挿入」に並べる種類（設計書6.65.15の段D）。
 *
 * **置ける種類だけがメニューに出る**（作者の指定）——1冊に1つの面が既に
 * 置いてあれば、その行は出さない。理由の文言は残してある：断るときに
 * 同じ言葉を使うためで（`insertBlock`）、言い方を2つ持たない。
 */
function insertTypeEntries(blocks: readonly BookBlock[]): InsertTypeEntry[] {
  const entries: InsertTypeEntry[] = BOOK_BLOCK_TYPES.map((type) => {
    const label = BOOK_BLOCK_LABELS[type];
    if (canAddBookBlock(blocks, type)) {
      return {
        key: type,
        label,
        enabled: true,
        reason: `${label}の面を、右クリックした面の後ろへ入れます。`,
      };
    }
    return {
      key: type,
      label,
      enabled: false,
      reason:
        type === "body"
          ? "本文は1冊にちょうど1つです（増やすことも外すこともできません）。"
          : `${label}は1冊に1つだけです。既に本の並びに入っています。`,
    };
  });

  // 章区切りは面ではない（台帳が正。設計書6.66）ので、いつでも挿せる
  entries.push({
    key: "chapter",
    label: "章区切り",
    enabled: true,
    reason:
      "どの話から章を始めるかを訊いて、章立ての台帳へ書きます（本の並びには入りません）。",
  });
  return entries;
}

/**
 * 話を選ぶ欄に出す名前（設計書6.65.10）。
 *
 * **競合の印がある話は本から外れる**（`exportEpub` が外す）のに、欄には
 * ふつうに並んでいた。挿絵や改ページを置いても入らない理由が分からない。
 *
 * **選べなくはしない。** 競合を直せばそのまま入るので、指定は残してよい
 * ——伝えるのは「いまのままでは本に入らない」ことだけである。
 */
function episodeChoiceLabel(episode: PreviewEpisode): string {
  return episode.conflicted
    ? `${episode.label}（競合のため本から外れます）`
    : episode.label;
}

/**
 * 焼いた画像の在りかと時刻（設計書6.65.8）。
 *
 * **読めなくても画面は開く。** 作品設定が読めないときは「焼いていない」と
 * 同じ扱いにする——本へ入らないことに変わりはない。
 */
async function bakedCovers(
  state: PanelState
): Promise<Record<CoverSide, BakedPreview | null>> {
  let settings: string;
  try {
    settings = await settingsDir(state.work);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("焼いた表紙の確認", { 作品: state.work.title, 内容: message });
    return { front: null, back: null };
  }

  const read = async (side: CoverSide): Promise<BakedPreview | null> => {
    const info = await bakedCoverInfo(settings, side);
    if (!info) return null;
    return {
      // 焼いた画像は `設定/書籍/` の中、つまり作品フォルダの中にある
      // （`localResourceRoots` が許している範囲）
      uri: state.panel.webview
        .asWebviewUri(path.toUri(info.filePath))
        .toString(),
      bakedAt: info.bakedAt,
    };
  };

  return { front: await read("front"), back: await read("back") };
}

/**
 * 画像の見つからない挿絵（設計書6.65.10）。
 *
 * **本に入らないことを、書き出す前に伝える。** 欄には行があるので、
 * 場所を打ち間違えていても「入る」ように見えていた。
 *
 * **覚え込まない。** 作者が画像を置いた瞬間に警告が消えてほしいので、
 * 面を作り直すたびに見に行く（同じ場所は1度だけ）。
 */
async function missingIllustrationImages(state: PanelState): Promise<string[]> {
  const checked = new Set<string>();
  const missing: string[] = [];

  for (const item of state.current.illustrations) {
    if (checked.has(item.imagePath)) continue;
    checked.add(item.imagePath);
    if (!(await exists(state.work, item.imagePath))) {
      missing.push(item.imagePath);
    }
  }

  return missing;
}

/**
 * 画像の見つからない口絵・扉絵（設計書6.65.15）。
 *
 * 返すのは「場所 → 面の呼び名」である。**面を出さない判断と、警告の文の
 * 両方が同じものを見る**——片方だけ直すと、面が消えているのに理由が
 * 出ない（またはその逆）ことになる。
 *
 * 挿絵と同じく**覚え込まない**（作者が画像を置いた瞬間に警告が消える）。
 *
 * **保留の面は見ない**（設計書6.65.15の段D）。本に入らないものについて
 * 「絵が見つかりません」と言っても、作者にできることは無い——書き出し側と
 * 同じ判断（`activeBookBlocks`）に揃える。
 */
async function missingFaceImages(
  state: PanelState
): Promise<Map<string, string>> {
  const missing = new Map<string, string>();
  const checked = new Set<string>();

  for (const block of activeBookBlocks(resolveBookBlocks(state.current))) {
    if (block.type !== "frontIllustration" && block.type !== "sectionArt") {
      continue;
    }
    if (checked.has(block.imagePath)) continue;
    checked.add(block.imagePath);
    if (!(await exists(state.work, block.imagePath))) {
      missing.set(block.imagePath, BOOK_BLOCK_LABELS[block.type]);
    }
  }

  return missing;
}

/**
 * 指定がそのとおりに入らないもの（設計書6.65.10）。
 *
 * **書き出しを待たずに、欄で見せる。** 原稿を書き直せば位置はずれ、
 * 改題すれば指し先が消える。言い方は `epubXhtml.ts` が1か所で持つので、
 * 書き出しの通知と食い違わない。
 *
 * 並びは「入らないもの（指し先が無い・画像が無い）」→「ずれたもの（位置の
 * 超過）」。入らないほうが直す用が大きい。
 */
function placementWarnings(
  state: PanelState,
  missingImages: readonly string[],
  missingFaces: ReadonlyMap<string, string>
): string[] {
  const labels = new Map(
    state.source.episodes.map((episode) => [episode.path, episode.label])
  );
  const notes: string[] = missingEpisodeNotices(labels.keys(), state.current);
  // 画像が置かれていない挿絵も「入らないもの」である（言い方は
  // `epubXhtml.ts` が1か所で持つので、書き出しの通知と食い違わない）
  notes.push(...missingImages.map(describeMissingIllustrationImage));
  // 口絵・扉絵は面ごと入らない（設計書6.65.15）
  for (const [imagePath, label] of missingFaces) {
    notes.push(describeMissingFaceImage(label, imagePath));
  }

  const check = (
    kind: "illustration" | "pageBreak",
    item: BookBodyPosition
  ): void => {
    const count = state.paragraphs.get(item.episodePath);
    // **数えていない話については黙る。** 読んでもいないのに
    // 「本文より後ろです」と言うと、当たっていても偶然になる
    if (count === undefined || item.afterParagraph <= count) return;
    notes.push(
      describePlacementOverflow(labels.get(item.episodePath) ?? item.episodePath, {
        kind,
        afterParagraph: item.afterParagraph,
      })
    );
  };

  for (const item of state.current.illustrations) check("illustration", item);
  for (const item of state.current.pageBreaks) check("pageBreak", item);
  return notes;
}

/**
 * 選ばれた話の段落を画面へ渡す（設計書6.65.10の「段落の一覧」）。
 *
 * **原稿は読むだけ。** 冒頭20字ほどを見せるのは、番号だけでは
 * どこを指しているのか作者に分からないためである。
 */
async function sendParagraphs(
  state: PanelState,
  episodePath: string
): Promise<void> {
  const episode = state.source.episodes.find(
    (entry) => entry.path === episodePath
  );
  if (!episode) {
    state.panel.webview.postMessage({
      type: "paragraphs",
      episodePath,
      items: [],
      notice: "この話の本文が見つかりません。",
    });
    return;
  }

  const body = await readEpisodeBody(episode);
  if (body === null) {
    state.panel.webview.postMessage({
      type: "paragraphs",
      episodePath,
      items: [],
      notice:
        "この話は読めませんでした（未解決の競合を含む話は本にも入りません）。",
    });
    return;
  }

  const items = splitParagraphs(body).map((paragraph) =>
    paragraphPreview(paragraph, episode.notation)
  );
  state.paragraphs.set(episodePath, items.length);

  state.panel.webview.postMessage({
    type: "paragraphs",
    episodePath,
    items,
    notice: null,
  });
  // 段落数が分かった。ずれの知らせを出し直す
  state.panel.webview.postMessage({
    type: "preview",
    data: await previewData(state),
  });
}

/**
 * 段落の冒頭。
 *
 * **記法は外して見せる。** `{漢字|かんじ}` のままでは20字のうち何字かが
 * 記号に食われ、どの場面なのか読み取れない（組むときと同じ `tokenizeLine`
 * を使う——記法の定義を増やさない）。
 */
function paragraphPreview(paragraph: string, notation: NotationMode): string {
  const plain = paragraph
    .split("\n")
    .map((line) =>
      tokenizeLine(line, notation)
        .map((token) => (token.kind === "ruby" ? token.base : token.text))
        .join("")
    )
    .join(" ")
    .trim();

  return plain.length > PREVIEW_CHARS
    ? `${plain.slice(0, PREVIEW_CHARS)}…`
    : plain;
}

const PREVIEW_CHARS = 20;

/** 話の本文。読めない話・競合のある話は null（本にも入らない） */
async function readEpisodeBody(episode: PreviewEpisode): Promise<string | null> {
  try {
    const file = await readTextFile(episode.filePath);
    if (file.hasConflictMarkers) return null;
    return parseEpisodeMetadata(file.text).body;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("EPUBエディターの段落一覧", {
      ファイル: episode.path,
      内容: message,
    });
    return null;
  }
}

/**
 * 位置指定のある話だけ、先に段落数を数える。
 *
 * 全話を読むと、開くたびに作品全体を走査することになる。**指定のある話
 * だけ**なら、たいていは数話で済む。
 */
async function countPlacedEpisodes(
  source: PreviewSource,
  config: BookConfig
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const wanted = new Set(
    [...config.illustrations, ...config.pageBreaks].map(
      (item) => item.episodePath
    )
  );

  for (const episode of source.episodes) {
    if (!wanted.has(episode.path) || counts.has(episode.path)) continue;
    const body = await readEpisodeBody(episode);
    if (body !== null) counts.set(episode.path, countParagraphs(body));
  }

  return counts;
}

/**
 * 合成の欄を使えるか、使えないなら理由（設計書6.65.8）。
 *
 * **元イラストが無いときは、欄を消さずに畳んで理由を出す**
 * （`processAvailability.ts` と同じ流儀）。消してしまうと、作者は
 * 「合成ができない画面なのだ」と受け取ってしまう。
 */
function composeState(
  state: PanelState,
  side: CoverSide,
  baked: BakedPreview | null
) {
  const label = sideLabel(side);
  const relative =
    side === "back"
      ? state.current.backCoverImagePath
      : state.current.coverImagePath;

  // 焼いた画像は**元イラストの指定が無くても残っている**（本にも入る）。
  // 消す道は、合成の欄が畳まれていても押せるところに置く（設計書6.65.8）
  const bakedNote = baked
    ? {
        note: describeBakedPreview(baked.bakedAt),
        fileName: BAKED_COVER_FILES[side],
      }
    : null;

  if (!relative) {
    return {
      enabled: false,
      uri: null,
      reason:
        `${label}の元イラストが指定されていないので、合成の欄は使えません。` +
        `作品フォルダに画像を置き、上の欄にその場所（例：素材/${label}.png）を書いてください。`,
      baked: bakedNote,
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
    baked: bakedNote,
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
  /**
   * 本の並びの何行目の面か（設計書6.65.15の段C）。
   *
   * **画面は選んだ面のプレビューだけを出す。** 行と面を突き合わせるのは
   * 番号でしかできない——同じ呼び名の面（扉絵）が並ぶことがある。
   */
  blockIndex?: number;
  /**
   * 保留の面か（設計書6.65.15の段D）。
   *
   * **本には入らないが、選べば見える。** 見えなければ2案を見比べられない
   * ——保留を入れた目的そのものが果たせない。画面はこの印で「本には
   * 入りません」と添える（黙って入らないのが、いちばん困る）。
   */
  suspended?: boolean;
}

/**
 * プレビューに出す面。
 *
 * **本に入る面と、順番まで同じにする。** ここで足したり省いたりすると、
 * 見た目どおりに編集しているつもりで別の本ができる。並びは設計図の
 * `blocks`（設計書6.65.15）——書いていない本は既定の並び（表紙→
 * タイトルページ→目次→人物紹介→本文→あとがき→奥付→裏表紙）になる。
 *
 * **中身の無い面は、本と同じ条件で出さない**（載せる人の居ない人物一覧、
 * 画像の無い口絵、まだ書いていないあとがき、画像の無い裏表紙）。
 *
 * ## 保留の面は「出すが、本の組み立てには入れない」（設計書6.65.15の段D）
 *
 * 面そのものは作る——選べば見えないと、2案を見比べるという保留の目的が
 * 果たせない。**外れるのは本の組み立てのほう**で、たとえば保留の人物紹介は
 * 目次の「登場人物」の行を作らない（本には無い行を見ていることになる）。
 */
function buildPages(
  state: PanelState,
  vertical: boolean,
  baked: Record<CoverSide, BakedPreview | null>,
  missingFaces: ReadonlyMap<string, string>
): PreviewPage[] {
  const config = state.current;
  const source = state.source;
  const pages: PreviewPage[] = [];
  const blocks = resolveBookBlocks(config);
  // **本に入る面だけで、本の中身を決める**（設計書6.65.15の段D）
  const active = activeBookBlocks(blocks);
  // 登場人物一覧の面が本に入るか。**目次の行と面の有無を同じ条件で決める**
  // （片方だけ出ると、目次から飛べない行ができる。設計書6.65.11）。
  // **並びに置いてあるかで決める**——段Cで blocks が正になったので、
  // チェック欄（`characterPage.enabled`）はもう見ない
  const hasCharacters =
    active.some((block) => block.type === "characters") &&
    source.characters.length > 0;

  let index = -1;
  let suspended = false;
  const add = (page: PreviewPage | null): void => {
    if (page) pages.push({ ...page, blockIndex: index, suspended });
  };

  for (const block of blocks) {
    index++;
    suspended = isBookBlockSuspended(block);
    switch (block.type) {
      case "cover":
        add(coverPage(state, vertical, baked.front));
        break;
      case "halfTitle":
        add({
          label: "タイトルページ",
          html: buildTitlePageFragment(config),
          note: null,
          vertical,
        });
        break;
      case "toc":
        add(tocPage(state, vertical, hasCharacters));
        break;
      // **保留でも、載る人が居れば面は出す**（比較のため。段D）。目次の
      // 行に出るかどうかは `hasCharacters`（本に入る面だけ）が決める
      case "characters":
        add(source.characters.length > 0 ? charactersPage(state, vertical) : null);
        break;
      case "frontIllustration":
      case "sectionArt":
        add(platePage(state, block, vertical, missingFaces));
        break;
      case "body":
        add(bodyPage(state, vertical));
        break;
      case "afterword":
        add(afterwordPage(state, vertical));
        break;
      case "colophon":
        add({
          label: "奥付",
          html: buildColophonFragment(config, vertical),
          note: null,
          vertical,
        });
        break;
      case "backCover":
        add(backCoverPage(state, vertical, baked.back));
        break;
    }
  }

  return pages;
}

/**
 * 表紙の面。**書き出しと同じ拾い順**（焼いた→元→無し。設計書6.65.8）。
 *
 * 焼いたあとも合成の途中経過を見せていたので、元イラストを差し替えたり
 * `coverImagePath` を空にしたりすると、画面と本の中身が食い違っていた。
 */
function coverPage(
  state: PanelState,
  vertical: boolean,
  baked: BakedPreview | null
): PreviewPage {
  const config = state.current;
  if (baked) {
    return {
      label: "表紙",
      // 本へ入るのと同じ組み方（画像1枚を敷く断片）で見せる
      html: buildCoverFragment(config, { href: baked.uri }),
      note: describeBakedPreview(baked.bakedAt),
      vertical,
    };
  }
  if (config.coverImagePath) {
    return {
      label: "表紙",
      // 中身は canvas が描く。**ここで組んだHTMLは使わない**
      html: "",
      compose: "front",
      note:
        "元イラストに、下の欄で選んだ文字を重ねた見た目です。" +
        "「表紙を焼く」を押すまでは、元イラストがそのまま入ります。",
      vertical,
    };
  }
  return {
    label: "表紙",
    html: buildCoverFragment(config, null),
    note:
      "表紙の画像が指定されていないので、題名だけの扉が表紙になります" +
      "（次のタイトルページと同じ組み方です）。",
    vertical,
  };
}

/** 目次の面。**競合の印がある話は、本にも目次にも入らない** */
function tocPage(
  state: PanelState,
  vertical: boolean,
  hasCharacters: boolean
): PreviewPage {
  const config = state.current;
  const source = state.source;
  // プレビューに並べると、本には無い行を見ていることになる
  const listed = source.episodes.filter((entry) => !entry.conflicted);
  const dropped = source.episodes.length - listed.length;

  return {
    label: "目次",
    html: buildTocFragment(
      listed.map((entry) => ({
        // プレビューでは飛ばない。見た目は行き先で変わらない
        href: "#",
        // **書き出しと同じ組み替えを通す**（`tocEntryStyle`。設計書
        // 6.65.15）。ここだけ `entry.label`（番号＋題の固定形）を出すと、
        // 見た目どおりに編集できるという要件が崩れる
        label: buildTocLabel(
          {
            heading: entry.label,
            fileName: entry.path,
            numberLabel: entry.numberLabel,
            title: entry.title,
          },
          config.tocEntryStyle
        ),
        group: entry.group,
      })),
      {
        pattern: config.tocPattern,
        ornament: config.tocOrnament,
        colophonHref: "#",
        vertical,
        // **登場人物一覧・あとがきの行は、書き出しと同じ条件で入れる**
        // （6.65.11・6.65.15）。片方だけ入れると、本には有る行が
        // プレビューだけ無い（あるいはその逆）ことになる
        charactersHref: hasCharacters ? "#" : null,
        afterwordHref: state.source.afterword ? "#" : null,
      }
    ),
    note: tocNote(source.episodes.length, dropped),
    vertical,
  };
}

/** 登場人物一覧の面（設計書6.65.11） */
function charactersPage(state: PanelState, vertical: boolean): PreviewPage {
  const config = state.current;
  return {
    label: "登場人物",
    html: buildCharacterPageFragment(
      state.source.characters.map((character) => ({
        name: character.name,
        reading: character.reading,
        summary: character.summary,
        iconHref:
          config.characterPage.showIcons && character.iconPath
            ? imageUri(state, character.iconPath)
            : null,
      }))
    ),
    note:
      "設定資料から組んだ面です（名前と紹介文だけが入ります）。" +
      "内容を直すときは設定資料の側を直してください。",
    vertical,
  };
}

/**
 * 口絵・扉絵の面（設計書6.65.15）。**画像が無ければ面を出さない**
 * （本と同じ。理由は欄の警告で言う）。
 */
function platePage(
  state: PanelState,
  block: BookImageBlock,
  vertical: boolean,
  missingFaces: ReadonlyMap<string, string>
): PreviewPage | null {
  const label = BOOK_BLOCK_LABELS[block.type];
  if (missingFaces.has(block.imagePath)) return null;

  return {
    label,
    html: buildPlateFragment(
      {
        // 画面は `asWebviewUri` のURIで読む（本ではZIPの中の機械名になる）
        href: imageUri(state, block.imagePath),
        caption: block.caption,
        label,
      },
      vertical
    ),
    note: `${label}は1枚で1つの面になります（本文の組み方には入りません）。`,
    vertical,
  };
}

/** 本文の面。**冒頭に収まっている指定だけを出す**（設計書6.65.10） */
function bodyPage(state: PanelState, vertical: boolean): PreviewPage | null {
  const source = state.source;
  if (!source.firstChapter) return null;

  // プレビューが読んでいるのは1話目の冒頭だけなので、その先の指定まで
  // 当てはめると「本文より後ろだから末尾へ」が働いて、実際の本と違う
  // 場所に挿絵が出る
  const shown = countParagraphs(source.firstChapter.body);
  const placed = placementsFor(state, source.firstChapterPath, shown);

  return {
    label: "本文の冒頭",
    html: buildChapterFragment(source.firstChapter, {
      collapseBlankLines: state.current.collapseBlankLines,
      illustrations: placed.illustrations,
      pageBreaks: placed.pageBreaks,
      // 画面は1枚の面なので実際には割れない。印だけ置く（6.65.10）
      markPageBreaks: true,
      vertical,
    }),
    note:
      "1話目の冒頭だけを出しています（本には全話が入ります）。" +
      (placed.hidden
        ? "冒頭より後ろの挿絵・改ページは、ここには出ません。"
        : ""),
    vertical,
  };
}

/**
 * あとがきの面（設計書6.65.15）。**原稿が無ければ面ごと出ない。**
 *
 * 組版は本文とまったく同じ（`buildAfterwordFragment`）。原稿を読むのは
 * パネルを開いたときだけなので、書いたものを映すには開き直す。
 */
function afterwordPage(
  state: PanelState,
  vertical: boolean
): PreviewPage | null {
  const afterword = state.source.afterword;
  if (!afterword) return null;

  return {
    label: AFTERWORD_HEADING,
    html: buildAfterwordFragment(afterword, {
      collapseBlankLines: state.current.collapseBlankLines,
      vertical,
    }),
    note:
      `設定/${BOOK_DIR}/${AFTERWORD_FILE} を組んだ面です。` +
      "書き直したら、このパネルを開き直すと反映されます。",
    vertical,
  };
}

/**
 * 裏表紙の面（設計書6.65.8）。表紙と同じく「焼いた→元→無し」の順で
 * 入るので、焼く前でも面そのものは出る。
 */
function backCoverPage(
  state: PanelState,
  vertical: boolean,
  baked: BakedPreview | null
): PreviewPage | null {
  if (baked) {
    return {
      label: "裏表紙",
      html: buildBackCoverFragment({ href: baked.uri }),
      note:
        "本の最終面（奥付の後ろ）になります。" +
        describeBakedPreview(baked.bakedAt),
      vertical,
    };
  }
  if (state.current.backCoverImagePath) {
    return {
      label: "裏表紙",
      html: "",
      compose: "back",
      note:
        "本の最終面（奥付の後ろ）になります。" +
        "「裏表紙を焼く」を押すまでは、元イラストがそのまま入ります。",
      vertical,
    };
  }
  return null;
}

/**
 * 目次の面に添える一言。
 *
 * **入らない話があることは、目次を見た時点で分かるようにする**
 * （設計書6.65.10）。競合を直せば入るので、消えたのではなく「いまは
 * 入らない」と言う。
 */
function tocNote(total: number, dropped: number): string | null {
  const notes: string[] = [];
  if (total === 0) notes.push("本文が見つからないので、目次は空です。");
  if (dropped > 0) {
    notes.push(`競合の印がある${dropped}話は、本にも目次にも入りません。`);
  }
  return notes.length > 0 ? notes.join("") : null;
}

/**
 * 挿絵と改ページのうち、プレビューに出せるもの（設計書6.65.10）。
 *
 * 画像は `asWebviewUri` で見せる。**作品フォルダの中だけ**がWebViewから
 * 読める（`localResourceRoots`）ので、外を指すパスはそもそも book.json の
 * 検証で弾かれている。
 */
function placementsFor(
  state: PanelState,
  episodePath: string | null,
  shownParagraphs: number
): {
  illustrations: EpubIllustrationPlacement[];
  pageBreaks: number[];
  hidden: boolean;
} {
  if (!episodePath) return { illustrations: [], pageBreaks: [], hidden: false };

  const withinView = <T extends BookBodyPosition>(items: readonly T[]): T[] =>
    items.filter((item) => item.afterParagraph <= shownParagraphs);

  // 話の突き合わせ方は `epubXhtml.ts` が1か所で持つ（書き出しと同じ規則）
  const illustrations = placementsIn(state.current.illustrations, episodePath);
  const pageBreaks = placementsIn(state.current.pageBreaks, episodePath);
  const shownIllustrations = withinView(illustrations);
  const shownBreaks = withinView(pageBreaks);

  return {
    illustrations: shownIllustrations.map((item) => ({
      afterParagraph: item.afterParagraph,
      href: imageUri(state, item.imagePath),
      caption: item.caption,
    })),
    pageBreaks: shownBreaks.map((item) => item.afterParagraph),
    hidden:
      shownIllustrations.length < illustrations.length ||
      shownBreaks.length < pageBreaks.length,
  };
}

/** 作品フォルダの中の画像を、WebViewから読める形にする */
function imageUri(state: PanelState, relativePath: string): string {
  return state.panel.webview
    .asWebviewUri(path.toUri(path.join(state.work.folderPath, relativePath)))
    .toString();
}

/**
 * 同梱する書体を、WebViewから読める形にする（設計書6.65.11）。
 *
 * 画面のCSPに `font-src` を足してある（`views/epubEditorPanelHtml.ts`）。
 * **読めなくても止めない**——`@font-face` が空振りするだけで、`serif` が
 * 受け止める（本のときと同じ）。
 */
function fontUri(state: PanelState, relativePath: string | null): string | null {
  return relativePath ? imageUri(state, relativePath) : null;
}

/**
 * 登場人物一覧の欄に出す一言（設計書6.65.11）。
 *
 * **「出す」を選んだのに何も起きない**ことがあるので、その理由をここで
 * 伝える。台帳の絞り（登場済み・モブでない・公開）は本と同じなので、
 * 画面で見えないものは本にも入らない。
 */
function characterNotice(state: PanelState): string | null {
  // **本に入るときだけ言う**（設計書6.65.15の段C・段D）。並びに置いて
  // いない面や、保留にした面について「◯人が載ります」と言うと、出ない面の
  // 話をしたことになる（`activeBookBlocks` を通して書き出しと揃える）
  const placed = activeBookBlocks(resolveBookBlocks(state.current)).some(
    (block) => block.type === "characters"
  );
  if (!placed) return null;

  const characters = state.source.characters;
  if (characters.length === 0) {
    return (
      "載せられる人物が居ないので、この面は本に入りません" +
      "（載るのは「登場済み・モブでない・公開」の人物だけです）。"
    );
  }

  const missing = state.current.characterPage.showIcons
    ? characters.filter((character) => character.iconPath === null).length
    : 0;
  const base = `${characters.length}人が載ります。`;
  // イラストが無い人物は名前だけになる。**黙って名前だけにしない**
  return missing > 0
    ? `${base}うち${missing}人はイラストが見つからないので、名前だけになります。`
    : base;
}

/**
 * プレビューの材料を集める。
 *
 * **原稿は読むだけ**で、読むのも1話目の冒頭までである。見出しは
 * 走査の結果（ファイル名とヘッダー）から作れるので、全話を開く必要はない
 * （挿絵の欄で話を選んだときだけ、その話を読む）。
 */
async function collectSource(work: WorkEntry): Promise<PreviewSource> {
  const scan = await scanWork(work);
  const format = await readWorkFormat(work);

  if (scan.episodes.length === 0) {
    return {
      episodes: [],
      episodeFiles: [],
      format,
      outline: [],
      firstChapter: null,
      firstChapterPath: null,
      notice: `「${work.title}」に本文のファイルが見つかりません。`,
      // 本文がまだ無くても、人物一覧の欄は使える（設定資料は別に育つ）
      characters: await collectCharacters(work),
      afterword: await collectAfterword(work),
    };
  }

  // **台帳は1度だけ読む。** 目次の束ねと段Cの一覧が別々に読むと、
  // 読んだ間に外で直されたときに画面の中で食い違う
  const chapters = await loadChapterLedger(work);
  const groupLabels = episodeGroupLabels(
    scan.episodes,
    chapters,
    work.folderPath
  );

  const episodes: PreviewEpisode[] = scan.episodes.map((episode) => {
    const numberLabel = formatChapterLabel(episode, format);
    const relative = episodePathFor(work.folderPath, episode.filePath);
    return {
      // book.json の `episodePath` と同じ作り方を通す（書き出しと共用）
      path: relative,
      label: bookHeading(episode, format),
      numberLabel,
      title: episodeTitle(episode, numberLabel),
      // 目次の束ね名は**台帳が正**（設計書6.66.4の3）。台帳が無ければ
      // 従来のファイル名由来の束ねに倒れる。**書き出しと同じ部品**を通す
      group: groupLabels.get(relative) ?? "",
      filePath: episode.filePath,
      notation: notationModeFor(episode.fileName),
      // **走査が既に見ている**ので、ここで本文を読み直さなくてよい
      // （競合のある話は本から外れる。設計書6.65.10）
      conflicted: episode.hasConflictMarkers,
    };
  });

  const first = await readFirstChapter(scan.episodes, format, work.folderPath);
  const source: PreviewSource = {
    episodes,
    episodeFiles: [...scan.episodes],
    format,
    // 章立ては台帳から写す（下で組む。段Cの一覧に章の行が挟まる）
    outline: [],
    firstChapter: first.chapter,
    firstChapterPath: first.episodePath,
    notice: first.notice,
    characters: await collectCharacters(work),
    afterword: await collectAfterword(work),
  };
  source.outline = collectOutline(work, source, chapters);
  return source;
}

/**
 * 章立ての台帳を読む。**読めなくても画面は開く**（章の無い作品として扱う）。
 *
 * 章はまとめ方であって話ではないので、本文の一覧が空に見えるほうが
 * 害が大きい（作品一覧と同じ判断）。
 */
async function loadChapterLedger(work: WorkEntry): Promise<Chapter[]> {
  try {
    return (await new ChapterStore(work).load()).chapters;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("EPUBエディターの章立て", { 作品: work.title, 内容: message });
    return [];
  }
}

/**
 * 話と章の一覧を組む（設計書6.65.15の段C・6.66）。
 *
 * **章の束ね方は作品一覧と同じ部品**（`groupEpisodesByChapter`）を通す。
 * ここで別に束ねると、一覧の章の切れ目とこの画面の切れ目がずれる。
 *
 * **台帳が読めなくても話は出す**（`loadChapterLedger` が空を返す）。章は
 * まとめ方であって話ではないので、本文の一覧が空に見えるほうが害が大きい
 * （作品一覧と同じ判断）。
 */
function collectOutline(
  work: WorkEntry,
  source: PreviewSource,
  chapters: readonly Chapter[]
): OutlineEntry[] {
  const labels = new Map(
    source.episodes.map((episode) => [
      episode.path,
      episodeChoiceLabel(episode),
    ])
  );
  const out: OutlineEntry[] = [];
  const addEpisodes = (list: readonly EpisodeFile[]): void => {
    for (const episode of list) {
      const relative = episodePathFor(work.folderPath, episode.filePath);
      out.push({
        kind: "episode",
        path: relative,
        label: labels.get(relative) ?? episode.fileName,
      });
    }
  };

  const grouping = groupEpisodesByChapter(
    source.episodeFiles,
    chapters,
    work.folderPath
  );
  // 最初の章より前の話は章なし。作品一覧と同じ並べ方である
  addEpisodes(grouping.ungrouped);
  for (const group of grouping.groups) {
    out.push({
      kind: "chapter",
      // 指し先の無い章も**黙って消さない**（作品一覧と同じ言い方）
      label: group.missingStart
        ? `${group.chapter.name}（開始の話が見つかりません）`
        : `${group.chapter.name}（${formatChapterRange(
            group.episodes,
            source.format
          )}）`,
    });
    addEpisodes(group.episodes);
  }
  return out;
}

/**
 * あとがきの原稿を読む（設計書6.65.15）。**中身が無ければ null。**
 *
 * 空かどうかは**本へ出る段落があるか**で見る（書き出しと同じ判断。
 * 付箋（`//`）だけの雛形は「まだ書いていない」）。読めなくても画面は
 * 開く——あとがきの面が出ないだけで、ほかの欄は使える。
 */
async function collectAfterword(
  work: WorkEntry
): Promise<PreviewAfterword | null> {
  let target: string;
  try {
    target = path.join(await settingsDir(work), BOOK_DIR, AFTERWORD_FILE);
  } catch {
    return null;
  }

  try {
    const file = await readTextFile(target);
    // 未解決の競合を含む原稿は本にも入らない（本文と同じ扱い）
    if (file.hasConflictMarkers) return null;
    if (countParagraphs(file.text) === 0) return null;
    return { text: file.text, notation: notationModeFor(AFTERWORD_FILE) };
  } catch {
    // まだ書いていないのが普通の状態である（通知も記録もしない）
    return null;
  }
}

/**
 * あとがきの原稿を開く（設計書6.65.15）。**無ければ雛形を作ってから開く。**
 *
 * 作るのは `mode: "create"`（新規作成だけ）である——既にある原稿を
 * 上書きする道は、間違っても作らない（作者が書いたものを消さない）。
 * 雛形は**見出しの無い空**で、付箋の行を1つだけ置く（付箋は本に入らない
 * ので、書き出しても面は増えない）。
 */
async function openAfterword(state: PanelState): Promise<void> {
  const work = state.work;
  let target: string;
  try {
    target = path.join(await settingsDir(work), BOOK_DIR, AFTERWORD_FILE);
  } catch (error) {
    await reportAfterwordFailure(work, state.panel, error);
    return;
  }

  try {
    await vscode.workspace.fs.stat(path.toUri(target));
  } catch {
    try {
      await vscode.workspace.fs.createDirectory(
        path.toUri(path.dirname(target))
      );
      await atomicWriteFile(
        target,
        new TextEncoder().encode(AFTERWORD_TEMPLATE),
        { mode: "create" }
      );
    } catch (error) {
      await reportAfterwordFailure(work, state.panel, error);
      return;
    }
  }

  await openInDefaultEditor(target);
  state.panel.webview.postMessage({
    type: "status",
    text: `${AFTERWORD_FILE} を開きました（書いたらパネルを開き直すとプレビューに入ります）`,
  });
}

/**
 * あとがきの雛形。
 *
 * **見出しは書かない**（本の側で「あとがき」を立てる）。行頭の `//` は
 * シーンメモの印（設計書6.40）で、本にも字数にも入らない。
 */
const AFTERWORD_TEMPLATE = [
  "// ここにあとがきを書いてください。この行（先頭が「//」）は本に入りません。",
  "// 見出しの「あとがき」は本の側で付くので、書かなくてかまいません。",
  "",
  "",
].join("\n");

async function reportAfterwordFailure(
  work: WorkEntry,
  panel: vscode.WebviewPanel,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logFailure("あとがきの原稿を開く", { 作品: work.title, 内容: message });
  panel.webview.postMessage({
    type: "status",
    text: `${AFTERWORD_FILE} を開けませんでした。${message}`,
    isError: true,
  });
  await vscode.window.showErrorMessage(
    `${AFTERWORD_FILE} を開けませんでした。${message}`
  );
}

/**
 * 登場人物一覧に載る人を集める（設計書6.65.11）。
 *
 * **台帳は読むだけ**である。絞り方（登場済み・モブでない・公開）は
 * `epubCharacterPage.ts` が1か所で持つので、書き出しと食い違わない。
 *
 * **読めなくても画面は開く。** 人物一覧が空になるだけで、書誌情報や
 * 本文のプレビューは使える（設定資料の不具合で編集できなくなるほうが困る）。
 */
async function collectCharacters(
  work: WorkEntry
): Promise<PreviewCharacter[]> {
  let characters: Character[];
  try {
    characters = (await new CharacterStore(work).loadAll()).characters;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("EPUBエディターの登場人物一覧", {
      作品: work.title,
      内容: message,
    });
    return [];
  }

  const out: PreviewCharacter[] = [];
  for (const character of selectBookCharacters(characters)) {
    const entry = toCharacterEntry(character);
    const iconPath = characterIconPath(character.icon);
    out.push({
      name: entry.name,
      reading: entry.reading,
      summary: entry.summary,
      // **画面でも「読めるか」を先に見る。** 本では読めない絵を落として
      // 名前だけにするので、見えているものと出来上がりを揃える
      iconPath: iconPath && (await exists(work, iconPath)) ? iconPath : null,
    });
  }
  return out;
}

/** 作品フォルダの中のファイルがあるか。読めないものは「無い」と同じ */
async function exists(work: WorkEntry, relativePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(
      path.toUri(path.join(work.folderPath, relativePath))
    );
    return true;
  } catch {
    return false;
  }
}

/** 冒頭に出す1話。競合マーカーのある話は本にも入らないので飛ばす */
async function readFirstChapter(
  episodes: readonly EpisodeFile[],
  format: WorkFormatKey | undefined,
  workFolder: string
): Promise<{
  chapter: EpubChapterSource | null;
  episodePath: string | null;
  notice: string | null;
}> {
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
        episodePath: null,
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
      episodePath: episodePathFor(workFolder, episode.filePath),
      notice: null,
    };
  }

  return {
    chapter: null,
    episodePath: null,
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
    return {
      config: parseBookConfig(
        { ...current, ...patch, characterPage: characterPagePatch(current, patch) },
        workTitle
      ),
      error: null,
    };
  } catch (error) {
    // 表紙の場所は作者が字で書く欄なので、**読めない値の中身をそのまま
    // 伝える**。画面はいまの値のまま据え置く（勝手に直さない）
    const message = error instanceof Error ? error.message : String(error);
    return { config: current, error: message };
  }
}

/**
 * 登場人物一覧の指定だけは、**中を混ぜて重ねる**（設計書6.65.15の段C）。
 *
 * 画面が送ってくるのはイラストの有無（`showIcons`）だけである。丸ごと
 * 差し替えると、作者が book.json に手で書いた `enabled` が既定へ落ちる
 * ——「チェック欄の値は書き換えない」という段Cの約束をここで守る。
 */
function characterPagePatch(
  current: BookConfig,
  patch: Record<string, unknown>
): unknown {
  const incoming = patch.characterPage;
  if (incoming === undefined || incoming === null) return current.characterPage;
  if (typeof incoming !== "object") return incoming;
  return { ...current.characterPage, ...(incoming as Record<string, unknown>) };
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
