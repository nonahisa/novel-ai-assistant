import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import {
  BOOK_DIR,
  BOOK_FILE,
  defaultBookConfig,
  parseBookConfig,
  type BookConfig,
} from "../models/book";
import { scanWork } from "../core/scanner";
import { readTextFile, type TextFileContent } from "../core/textFile";
import { parseEpisodeMetadata } from "../core/metadataParser";
import { atomicWriteFile } from "../core/atomicWrite";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { readWorkFormat } from "../core/workFormatStore";
import {
  bookHeading,
  episodeGroupLabel,
  episodeTitle,
  formatChapterLabel,
} from "../core/episodeLabel";
import { timestampedFileNameCandidates } from "../core/timestampedFileName";
import { notationModeFor } from "../core/manuscriptRender";
import {
  buildEpub,
  fontMediaType,
  imageMediaType,
  type EpubBookCharacter,
  type EpubChapter,
  type EpubFont,
  type EpubFonts,
  type EpubIllustration,
} from "../core/epubPackage";
import {
  characterIconPath,
  selectBookCharacters,
  toCharacterEntry,
} from "../core/epubCharacterPage";
import { CharacterStore } from "../core/characterStore";
import {
  countParagraphs,
  describeDroppedPlacements,
  describePlacementOverflow,
  missingEpisodeNotices,
  placementsIn,
} from "../core/epubXhtml";
import { episodePathFor } from "../core/bookStore";
import {
  describeCoverUse,
  readCoverSource,
  type CoverSide,
  type CoverSource,
} from "../core/coverBake";
import { randomUuid } from "../core/runtime";
import { revealFolder } from "../views/openDocument";
import { logFailure } from "../core/logger";

/**
 * 本文からEPUB3の電子書籍を組んで書き出す（設計書6.65.4の第1段）。
 *
 * **原稿は読むだけで、1文字も書き換えない。** 空行の詰めもページの
 * 割りも書き出し時の変換であって、原稿ファイルには触れない。挿絵の
 * 位置も book.json が持ち、原稿へ目印を書き込まない（設計書6.65.10）。
 *
 * ## 挿絵の1枚で本を止めない
 *
 * 画像が読めなければ**その挿絵だけ**飛ばし、位置が本文より後ろなら
 * 末尾へ置く。どちらも完了通知で伝える——本が出ないより、ずれたことが
 * 分かるほうがよい。ただし黙って捨てもしない。
 *
 * ## 本の設計図が無くても1回は出せる
 *
 * `設定/書籍/book.json` を読むが、**無ければ作品名から既定値で組む**。
 * 第1段には設計図を作る画面が無い（第2段で作る）ので、ここで止めると
 * 誰も本を出せない。**壊れていたときだけは止める**——勝手に直して
 * 上書きすると、作者が書いた値が黙って消える（他の台帳と同じ約束）。
 *
 * ## 書き出し先は `.aiwriter/exports/`
 *
 * PDF出力と同じ慣習。組み直せるものなので `.gitignore` で除外済み
 * （`core/workRegistry.ts` の `IGNORED_PATHS`）。**既存ファイルへは
 * 書かない**——名前がぶつかったら秒・連番で別名にする。
 */
export async function exportEpub(work: WorkEntry): Promise<void> {
  const scan = await scanWork(work);
  if (scan.episodes.length === 0) {
    void vscode.window.showInformationMessage(
      `「${work.title}」に本文のファイルが見つかりません。`
    );
    return;
  }

  let config: BookConfig;
  try {
    config = await readBookConfig(work);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("本の設計図の読み込み", { 作品: work.title, 内容: message });
    await vscode.window.showErrorMessage(
      `設定/${BOOK_DIR}/${BOOK_FILE} を読めませんでした。${message}` +
        "　直してからもう一度お試しください（こちらでは書き換えません）。"
    );
    return;
  }

  const format = await readWorkFormat(work);

  const chapters: EpubChapter[] = [];
  /** 競合マーカーが残っている話。組んでも読めない本になるので外す */
  const conflicted: string[] = [];
  /**
   * 本は出るが、指定どおりにならなかったことを作者へ伝える言葉
   * （設計書6.65.10・6.65.11）。
   *
   * **本は出す。** 挿絵の位置がずれた・画像が1枚読めなかった・人物の
   * イラストが無い・書体が読めない——どれも本ごと出ないほうが困る。
   * ただし黙って捨てもしないので、完了通知にまとめて出す。
   */
  const notices: string[] = [];
  /** 読んだ画像。同じ絵を何話でも使えるので、1度読んだら覚えておく */
  const images = new Map<string, Uint8Array | null>();

  // **指し先の話が無い指定は、どの話にも入らない。** 改題・移動で必ず
  // 起きるので、入らなかったことを先に伝える（設計書6.65.10）。
  // 競合を含む話も「ある」と数える——そちらは別の言葉で既に伝えている
  notices.push(
    ...missingEpisodeNotices(
      scan.episodes.map((episode) =>
        episodePathFor(work.folderPath, episode.filePath)
      ),
      config
    )
  );

  for (const episode of scan.episodes) {
    let file: TextFileContent;
    try {
      file = await readTextFile(episode.filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logFailure("EPUBの組み立て", {
        ファイル: episode.fileName,
        内容: message,
      });
      await vscode.window.showErrorMessage(
        `${episode.fileName} を読めませんでした。${message}`
      );
      return;
    }
    const heading = bookHeading(episode, format);
    // 目次の見出しの形（設計書6.65.15）は番号と題を別々に持つ。
    // **本文側の `<h2>`（= heading）はいつも番号＋題のまま**——ここで
    // 別々に持つのは目次だけの都合である
    const numberLabel = formatChapterLabel(episode, format);
    const title = episodeTitle(episode, numberLabel);
    const episodePath = episodePathFor(work.folderPath, episode.filePath);
    // **未解決の競合をそのまま組まない。** マーカーと両方の版が混ざった本は
    // 読めないうえ、配ってから気づくことになる（PDF出力と同じ）
    if (file.hasConflictMarkers) {
      conflicted.push(episode.fileName);
      // **その話に置いた挿絵・改ページも一緒に消える。** 話が外れたことしか
      // 言わないと、挿絵が入らない理由が作者に分からない（設計書6.65.10）
      const dropped = describeDroppedPlacements(heading, {
        illustrations: placementsIn(config.illustrations, episodePath).length,
        pageBreaks: placementsIn(config.pageBreaks, episodePath).length,
      });
      if (dropped) notices.push(dropped);
      continue;
    }
    // 投稿サイトからDLしたファイルは、先頭にヘッダーが付いている。
    // 本文だけを組む（作品一覧の文字数計測と同じ切り分け）
    const body = parseEpisodeMetadata(file.text).body;
    const placements = await collectPlacements({
      work,
      config,
      episodePath,
      heading,
      body,
      images,
      notes: notices,
    });

    chapters.push({
      heading,
      numberLabel,
      title,
      // 目次を「章ごとに区切る」にしたときの束ね名（設計書6.65.6）。
      // 読み取れなければ空文字が返り、一覧のまま出る
      group: episodeGroupLabel(episode),
      body,
      // **話ごとに記法を見る。** 1つの作品に `.md` と `.txt` が混ざる
      notation: notationModeFor(episode.fileName),
      illustrations: placements.illustrations,
      pageBreaks: placements.pageBreaks,
    });
  }

  if (chapters.length === 0) {
    void vscode.window.showWarningMessage(
      "選んだ本文はすべて未解決の競合を含んでいるため、書き出しませんでした。" +
        "「競合解決」で直してからもう一度お試しください。"
    );
    return;
  }

  // **表紙と裏表紙は別々に捕まえる。** まとめて捕まえていたので、裏表紙が
  // 読めないときにも coverImagePath を直せと案内していた（直す先が違う）
  let settings: string;
  let cover: CoverSource | null;
  try {
    settings = await settingsDir(work);
    cover = await readCoverSource(
      work.folderPath,
      settings,
      "front",
      config.coverImagePath
    );
  } catch (error) {
    await reportCoverFailure(work, "front", error);
    return;
  }

  let backCover: CoverSource | null;
  try {
    // **裏表紙も表紙と同じ拾い方**（焼いた→元→無し）。焼くまで裏表紙が
    // 出ないと、場所を指定した作者に何も起きない理由が分からない
    backCover = await readCoverSource(
      work.folderPath,
      settings,
      "back",
      config.backCoverImagePath
    );
  } catch (error) {
    await reportCoverFailure(work, "back", error);
    return;
  }

  // **登場人物一覧と書体は、どちらも失敗で本を止めない**（設計書6.65.11）。
  // 台帳が読めない・イラストが1枚読めない・書体が読めない——いずれも
  // 本は出し、何が入らなかったかを完了通知で伝える
  const characters = config.characterPage.enabled
    ? await collectCharacters(work, config.characterPage.showIcons, notices)
    : [];
  const fonts = await collectFonts(work, config.fonts, notices);

  let epub: Uint8Array;
  try {
    epub = buildEpub({
      config,
      chapters,
      cover,
      backCover,
      characters,
      fonts,
      // 本を見分ける唯一の札。書き出すたびに新しい本として扱われる
      identifier: `urn:uuid:${randomUuid()}`,
      modified: isoSeconds(new Date()),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("EPUBの組み立て", { 作品: work.title, 内容: message });
    await vscode.window.showErrorMessage(`本を組めませんでした。${message}`);
    return;
  }

  let target: string;
  try {
    target = await writeExport(work, epub);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("EPUBの書き出し", { 作品: work.title, 内容: message });
    await vscode.window.showErrorMessage(
      `EPUBを保存できませんでした。${message}`
    );
    return;
  }

  const droppedNote =
    conflicted.length > 0
      ? `\n未解決の競合を含む${conflicted.length}件は外しました（${conflicted.join(
          "、"
        )}）。`
      : "";
  // 挿絵のずれ・読めなかった画像・入らなかった書体は、
  // **本が出たあとに必ず伝える**
  const noticeText = notices.length > 0 ? `\n${notices.join("\n")}` : "";
  const action = await vscode.window.showInformationMessage(
    `EPUBを書き出しました（${chapters.length}話）。\n${target}` +
      describeCoverUse(cover, backCover) +
      droppedNote +
      noticeText,
    "フォルダーを開く"
  );
  if (action === "フォルダーを開く") await revealFolder(target);
}

/**
 * 表紙・裏表紙が読めなかったことを伝える（設計書6.65.8）。
 *
 * **どちらの面かで、直す先が違う。** 案内する項目名（`coverImagePath` /
 * `backCoverImagePath`）を取り違えると、作者は合っている行を睨むことになる。
 */
async function reportCoverFailure(
  work: WorkEntry,
  side: CoverSide,
  error: unknown
): Promise<void> {
  const label = side === "back" ? "裏表紙" : "表紙";
  const field = side === "back" ? "backCoverImagePath" : "coverImagePath";
  const message = error instanceof Error ? error.message : String(error);

  logFailure("表紙画像の読み込み", {
    作品: work.title,
    面: label,
    内容: message,
  });
  await vscode.window.showErrorMessage(
    `${label}の画像を読めませんでした。${message}` +
      `　設定/${BOOK_DIR}/${BOOK_FILE} の ${field} を確かめてください。`
  );
}

/**
 * その話の挿絵とページ分割を集める（設計書6.65.10）。
 *
 * **1枚の失敗で本を止めない。** 画像が読めなければその挿絵だけ飛ばし、
 * 位置が本文より後ろなら末尾へ置く。どちらも `notes` に積んで、
 * 完了通知で作者へ伝える（黙って捨てない）。
 */
async function collectPlacements(input: {
  work: WorkEntry;
  config: BookConfig;
  episodePath: string;
  heading: string;
  body: string;
  images: Map<string, Uint8Array | null>;
  notes: string[];
}): Promise<{ illustrations: EpubIllustration[]; pageBreaks: number[] }> {
  // 段落の数え方は `epubXhtml.ts` が1か所で持つ（詰める前の段落番号）
  const paragraphs = countParagraphs(input.body);
  const illustrations: EpubIllustration[] = [];

  for (const item of placementsIn(
    input.config.illustrations,
    input.episodePath
  )) {
    const data = await readIllustration(
      input.work,
      input.images,
      item.imagePath,
      input.notes
    );
    // 画像が無い挿絵は入らない。**ずれの警告も出さない**——入らなかった
    // ものの位置を言われても、作者にできることが増えない
    if (!data) continue;

    if (item.afterParagraph > paragraphs) {
      input.notes.push(
        describePlacementOverflow(input.heading, {
          kind: "illustration",
          afterParagraph: item.afterParagraph,
        })
      );
    }
    illustrations.push({
      afterParagraph: item.afterParagraph,
      sourcePath: item.imagePath,
      data,
      caption: item.caption,
    });
  }

  const pageBreaks: number[] = [];
  for (const item of placementsIn(input.config.pageBreaks, input.episodePath)) {
    if (item.afterParagraph > paragraphs) {
      input.notes.push(
        describePlacementOverflow(input.heading, {
          kind: "pageBreak",
          afterParagraph: item.afterParagraph,
        })
      );
    }
    pageBreaks.push(item.afterParagraph);
  }

  return { illustrations, pageBreaks };
}

/**
 * 登場人物一覧に載せる人を集める（設計書6.65.11）。
 *
 * **台帳は読むだけで、1文字も書き換えない**（原稿と同じ扱い）。
 *
 * **台帳が読めなくても本は出す。** 人物一覧が入らなかったことを伝えて、
 * 残りの面で本を組む——設定資料の不具合で本文が配れなくなるほうが困る。
 */
async function collectCharacters(
  work: WorkEntry,
  showIcons: boolean,
  notices: string[]
): Promise<EpubBookCharacter[]> {
  let loaded: Awaited<ReturnType<CharacterStore["loadAll"]>>;
  try {
    loaded = await new CharacterStore(work).loadAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("登場人物一覧の読み込み", { 作品: work.title, 内容: message });
    notices.push(
      `登場人物の設定を読めませんでした（${message}）。登場人物一覧は入れていません。`
    );
    return [];
  }

  // 壊れた人物ファイルは `loadAll` が読み飛ばす。**黙って減らさない**
  if (loaded.errors.length > 0) {
    notices.push(
      `登場人物の設定のうち${loaded.errors.length}件は読めなかったので、一覧から外れています` +
        `（${loaded.errors.map((entry) => entry.file).join("、")}）。`
    );
  }

  const selected = selectBookCharacters(loaded.characters);
  if (selected.length === 0) {
    notices.push(
      "登場人物一覧に載せられる人物が居ませんでした" +
        "（載るのは「登場済み・モブでない・公開」の人物だけです）。"
    );
    return [];
  }

  const characters: EpubBookCharacter[] = [];
  /** 読んだ人物イラスト。同じ絵を2人で使うことは無いが、読み直しは避ける */
  const icons = new Map<string, Uint8Array | null>();

  for (const character of selected) {
    const entry = toCharacterEntry(character);
    const iconPath = showIcons ? characterIconPath(character.icon) : null;
    // **イラストが読めなくても、その人を落とさない。** 名前だけ載せる
    const data = iconPath
      ? await readCharacterIcon(work, icons, iconPath, notices)
      : null;

    characters.push({
      name: entry.name,
      reading: entry.reading,
      summary: entry.summary,
      icon: iconPath && data ? { sourcePath: iconPath, data } : null,
    });
  }

  return characters;
}

/**
 * 人物イラストを読む。**読めなければ null**（その人物は名前だけ）。
 *
 * 1枚につき1度だけ伝える（挿絵と同じ）。
 */
async function readCharacterIcon(
  work: WorkEntry,
  icons: Map<string, Uint8Array | null>,
  iconPath: string,
  notices: string[]
): Promise<Uint8Array | null> {
  const cached = icons.get(iconPath);
  if (cached !== undefined) return cached;

  // **本を組む前に種類を確かめる。** 組み立ての途中で落ちると、
  // イラスト1枚のために本そのものが出ない
  try {
    imageMediaType(iconPath, "人物イラスト");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notices.push(`${message}この人物は名前だけにしました。`);
    icons.set(iconPath, null);
    return null;
  }

  try {
    const data = await vscode.workspace.fs.readFile(
      path.toUri(path.join(work.folderPath, iconPath))
    );
    icons.set(iconPath, data);
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("人物イラストの読み込み", {
      作品: work.title,
      場所: iconPath,
      内容: message,
    });
    notices.push(
      `人物イラスト「${iconPath}」を読めませんでした。この人物は名前だけにしました。`
    );
    icons.set(iconPath, null);
    return null;
  }
}

/**
 * 同梱する書体を読む（設計書6.65.11）。
 *
 * **読めなければ組み込まずに本を出す。** 字が変わらないだけで、本文は
 * 読める（`serif` が最後に控えている）。黙って落とさず、通知に出す。
 *
 * **ライセンスの確認はしない・できない。** 埋め込みが許諾されているかは
 * 作者の責任である（設計書6.65.3。画面に注意書きを常に出してある）。
 */
async function collectFonts(
  work: WorkEntry,
  fonts: BookConfig["fonts"],
  notices: string[]
): Promise<EpubFonts> {
  return {
    body: await readFont(work, fonts.body, "本文用の書体", notices),
    heading: await readFont(work, fonts.heading, "見出し用の書体", notices),
  };
}

async function readFont(
  work: WorkEntry,
  relativePath: string | null,
  label: string,
  notices: string[]
): Promise<EpubFont | null> {
  if (!relativePath) return null;

  // 種類は book.json の検証も見ているが、手編集されるJSONなので
  // 組み立ての前にもう一度確かめる（表紙・挿絵と同じ）
  try {
    fontMediaType(relativePath, label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notices.push(`${message}この書体は組み込んでいません。`);
    return null;
  }

  try {
    return {
      fileName: relativePath,
      data: await vscode.workspace.fs.readFile(
        path.toUri(path.join(work.folderPath, relativePath))
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("書体の読み込み", {
      作品: work.title,
      場所: relativePath,
      内容: message,
    });
    notices.push(
      `${label}「${relativePath}」を読めませんでした。この書体は組み込んでいません。`
    );
    return null;
  }
}

/**
 * 挿絵の画像を読む。**読めなければ null**（その挿絵だけ飛ばす）。
 *
 * 同じ絵を何度でも使えるので、読んだ結果は覚えておく。読めなかったことも
 * 覚えて、1枚につき1度だけ伝える（同じ絵を10か所で使っていたら10回
 * 叱られる、ということにしない）。
 */
async function readIllustration(
  work: WorkEntry,
  images: Map<string, Uint8Array | null>,
  imagePath: string,
  notes: string[]
): Promise<Uint8Array | null> {
  const cached = images.get(imagePath);
  if (cached !== undefined) return cached;

  // **本を組む前に種類を確かめる。** 組み立ての途中で落ちると、
  // 挿絵1枚のために本そのものが出ない
  try {
    imageMediaType(imagePath, "挿絵");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`${message}この挿絵は飛ばしました。`);
    images.set(imagePath, null);
    return null;
  }

  try {
    const data = await vscode.workspace.fs.readFile(
      path.toUri(path.join(work.folderPath, imagePath))
    );
    images.set(imagePath, data);
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailure("挿絵の読み込み", {
      作品: work.title,
      場所: imagePath,
      内容: message,
    });
    notes.push(
      `挿絵の画像「${imagePath}」を読めませんでした。この挿絵は飛ばしました。`
    );
    images.set(imagePath, null);
    return null;
  }
}

/** `設定/` の場所。作品設定でフォルダ名を変えていればそれに従う */
async function settingsDir(work: WorkEntry): Promise<string> {
  return workPaths(work, await readWorkConfig(work)).settings;
}

/**
 * 本の設計図を読む。**無ければ作品名から既定値**、壊れていれば例外。
 */
async function readBookConfig(work: WorkEntry): Promise<BookConfig> {
  const target = path.join(await settingsDir(work), BOOK_DIR, BOOK_FILE);

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(target));
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    ) {
      return defaultBookConfig(work.title);
    }
    throw error;
  }

  return parseBookConfig(
    JSON.parse(new TextDecoder().decode(bytes)),
    work.title
  );
}

/** 書き出し先。**新規作成だけ**を使い、名前がぶつかったら別名にする */
async function writeExport(work: WorkEntry, epub: Uint8Array): Promise<string> {
  const config = await readWorkConfig(work);
  const directory = path.join(workPaths(work, config).aiwriter, EXPORT_DIR);
  await vscode.workspace.fs.createDirectory(path.toUri(directory));

  const target = await freshExportPath(directory, new Date());
  await atomicWriteFile(target, epub, { mode: "create" });
  return target;
}

/** 組み直せるものの置き場所。`.gitignore` で除外済み（PDF出力と同じ） */
const EXPORT_DIR = "exports";

/** まだ使われていない保存先を決める。名前の作り方は `timestampedFileName.ts` */
async function freshExportPath(directory: string, at: Date): Promise<string> {
  for (const name of timestampedFileNameCandidates("電子書籍", at, ".epub")) {
    const target = path.join(directory, name);
    try {
      await vscode.workspace.fs.stat(path.toUri(target));
    } catch {
      // 読めない＝まだ無い。ここへ書く
      return target;
    }
  }
  throw new Error("書き出し先の名前を決められませんでした。");
}

/**
 * `dcterms:modified` の形（`2026-09-03T01:23:45Z`）。
 *
 * **ミリ秒は付けない。** EPUB3の仕様が秒までと決めており、
 * `toISOString()` そのままだと検証器（epubcheck）が警告を出す。
 */
function isoSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}
