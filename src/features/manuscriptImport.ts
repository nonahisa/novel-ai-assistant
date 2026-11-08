import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import type { EpisodeFile, WorkEntry } from "../models/types";
import type { MissingEpisodeFile } from "../core/backupMissingEpisodes";
import { NOTATION_CLASH_ADVICE, describeNotationClashLines } from "../core/docxToMarkdown";
import { countEpisodeChars } from "../core/episodeCharCount";
import {
  IMPORT_CANCEL_LABEL,
  IMPORT_CHOICE_LABELS,
  IMPORT_MAX_BYTES,
  adaptImportedNotation,
  appendSubtitle,
  decodeImportedText,
  describeImportChoices,
  erasedCharCount,
  importedNotationOf,
  isEpisodeBodyEmpty,
  planEpisodeImport,
  replaceEpisodeBody,
  replaceEpisodeTitle,
  titleCandidate,
  trimImported,
  type ImportChoice,
  type ImportSource,
} from "../core/episodeImport";
import { nextChapterNumber, parseEpisodeFileName } from "../core/episodeParser";
import { renameEpisodeFile, renamedFileName } from "../core/episodeRename";
import { pathExists } from "../core/fileSystem";
import { episodeTitleSlot } from "../core/metadataParser";
import { copyEmphasisFor } from "../core/postingCopyTargets";
import type { EmphasisSite } from "../core/ruby";
import {
  episodeNameStyleOf,
  episodeNumberOf,
  insertedEpisodeFileName,
  nextEpisodeFileNameLike,
  planInsertion,
} from "../core/episodeRenumber";
import { messageOf } from "../core/errorMessage";
import { findLatestEpisode } from "../core/latestEpisode";
import { logFailure, logStep, useLogFile } from "../core/logger";
import {
  encodeForNewFile,
  readTextFile,
  writeTextFilePreservingFormat,
  type TextFileContent,
  type WriteTextFileResult,
} from "../core/textFile";
import { canRunProcesses } from "../core/runtime";
import { readWordManuscript } from "../core/wordManuscript";
import { withCancellableProgress } from "../views/progress";
import { nameNewEpisodes, writeNewEpisodes } from "./addEpisodeFiles";
import { followEpisodeFileRenames, renameFollowNotice } from "./episodeLedgers";
import { registeredPostingSites } from "./postingCopyRegistered";
import { reloadOpenDocumentAfterWrite } from "./reloadAfterWrite";

/**
 * 原稿エディターの［入力］→「テキストファイルから」「Word から」（作者の決定 2026-11-08。
 * 設計書6.25.13）。外のファイルを1つ選び、開いている話へ取り込む。
 *
 * ## 流れ
 *
 * 1. ファイルを選ぶ窓（テキストは .txt・.md、Word は .docx を1つ）
 * 2. 読む。テキストは原稿と同じ読み分け（`decodeImportedText`）、Word は
 *    「Word 原稿の変換」と同じ部品（`readWordManuscript`。ブラウザ版でも動く）。
 *    **読めない・化けるものは取り込まない**
 * 3. 開いている話の本文が空なら、訊かずにその話へ入れる（題・冒頭の欄は残す）
 * 4. 入っていれば［次の話として足す］［最後に加える］［上書きする］［やめる］を訊く
 *    （並べ方は `planEpisodeImport`）
 *
 * ## 書き方（実装ルール1・2）
 *
 * - **開いている話へ書く**（空の話・上書き）：`writeTextFilePreservingFormat`。
 *   読んだときのハッシュで照らし、文字コードと改行を保ち、本文の欄だけを差し替える。
 *   書く前の本文はこの関数が控え（`.novelai-recovery`）へ退避する——それが
 *   「書き換える前のバックアップ」で、タイムラインの「書き換える前の控え」から戻せる
 * - **次の話として足す**：「この話の前に挿入」と同じ道（`prepareInsertion`／
 *   `runInsertion`。名前の付け替え・台帳と単話プロットの追従・名前だけのコミット）。
 *   **途中で止まったら新しい話は作らない**。どこまで済んだかを出す
 * - **最後に加える**：バックアップの「手元に無い話」と同じ道（`addEpisodeFiles.ts`。
 *   `mode: "create"` だけ）。ほかの話には触らない
 * - **取り込み元のファイルは書き換えない**（読むだけ）
 *
 * **`insertEpisode.ts` は［次の話として足す］の中で動的importする**（`core/git.ts`＝
 * `node:child_process` に届く。設計書5.8.5）。静的に読むと、ブラウザ版ではこのファイルの
 * 読み込み自体が失敗し、git の要らない空の話・上書き・最後に加えるまで動かなくなる。
 * ブラウザ版では［次の話として足す］を並べない（使えない操作は出さない。作者の裁定 2026-10-31）
 */

/** 取り込みのあと、呼ぶ側（原稿エディター）がすること */
export interface ManuscriptImportResult {
  /** 作品一覧を読み直す必要があるか（話が増えた・名前が変わった・本文が変わった） */
  readonly changed: boolean;
  /** 新しく作った話。原稿エディターがいまの見た目のまま開く */
  readonly newFilePath?: string;
}

/** 走査の結果のうち、使うもの */
export interface ImportScan {
  readonly episodes: EpisodeFile[];
  /** 本文フォルダー（［最後に加える］の置き場。「最新話」と同じ） */
  readonly manuscriptDir: string;
}

/** 読んで、入れる前の形にした取り込む文 */
interface ImportedText {
  /** 改行を LF にそろえた文（書き方はまだ寄せていない） */
  readonly text: string;
  readonly notation: "markdown" | "plain";
  /** 取り込む文の純文字数（窓に出す） */
  readonly chars: number;
  /** 済んだあとに添える注意（Word で入らなかったもの・Shift_JIS で読んだこと） */
  readonly notes: readonly string[];
}

/**
 * 開いている話へ取り込む。
 *
 * @param input.document 開いている話の文書。**未保存の変更があれば、まず保存する**
 *   （本文が空かを、作者が画面で見ている中身で決めるため。書き戻しの関数は未保存の
 *   文書があると断るので、保存せずには空の話へ入れることもできない）
 */
export async function importIntoEpisode(input: {
  readonly work: WorkEntry;
  readonly filePath: string;
  readonly source: ImportSource;
  readonly scan: ImportScan;
  readonly document?: vscode.TextDocument;
  /**
   * 開いている話の名前に題を付けるときの手当て（原稿エディターの見た目を新しい名前へ
   * 持って行く・古い面を閉じる）。サブタイトルの案と同じものを `extension.ts` が渡す
   */
  readonly renameHooks?: {
    beforeRename?: (from: string, to: string) => void;
    afterRename?: (from: string) => void;
  };
}): Promise<ManuscriptImportResult> {
  const { work, filePath, source, scan } = input;
  const none: ManuscriptImportResult = { changed: false };
  useLogFile(work.folderPath);

  const current = scan.episodes.find((episode) => path.isSamePath(episode.filePath, filePath));
  if (!current) {
    void vscode.window.showWarningMessage(
      "この原稿は作品の話として認識できないため、取り込めません。作品の本文フォルダーにある話を開いてください。"
    );
    return none;
  }

  const picked = await pickImportFile(source);
  if (!picked) return none;
  const sourceName = path.basename(fromUri(picked));

  const imported = await readImported(source, picked, sourceName);
  if (!imported.ok) {
    logStep(`原稿エディター：「${sourceName}」を取り込めませんでした：${imported.reason}`);
    void vscode.window.showWarningMessage(
      `「${sourceName}」は取り込めませんでした。${imported.reason}`
    );
    return none;
  }

  /*
    **未保存の変更があれば先に保存する**（検知の前の「保存してから実行」と同じ考え。
    設計書6.80）。空かどうかを作者が画面で見ている中身で決め、そのうえで同じ中身を
    ハッシュで照らして書くため。保存できなければ何もしない
  */
  if (input.document?.isDirty) {
    const saved = await input.document.save();
    if (!saved || input.document.isDirty) {
      void vscode.window.showWarningMessage(
        "開いている話を保存できなかったため、取り込みをやめました（何も書いていません）。保存してからもう一度お試しください。"
      );
      return none;
    }
  }

  let disk: TextFileContent;
  try {
    disk = await readTextFile(filePath);
  } catch (error) {
    logFailure("原稿エディターの取り込み：開いている話を読めなかった", {
      ファイル: filePath,
      詳細: messageOf(error),
    });
    void vscode.window.showErrorMessage(
      `開いている話（${current.fileName}）を読めなかったため、取り込みをやめました：${messageOf(error)}`
    );
    return none;
  }
  if (disk.hasConflictMarkers) {
    void vscode.window.showErrorMessage(
      `開いている話（${current.fileName}）に同期の競合の印（<<<<<<< など）が残っているため、取り込みをやめました。先に競合を解決してください。`
    );
    return none;
  }

  // 話の並び（次の話として足すときの番号・名前の変わる話の数）
  const folder = path.dirname(current.filePath);
  const number = episodeNumberOf(current.fileName);
  const pivot = number === null ? null : number + 1;
  // ブラウザ版では番号ずらし（名前だけのコミットの確認が git を使う）を出さない
  const shiftPlan =
    pivot === null || !canRunProcesses() ? null : planInsertion(scan.episodes, pivot, folder);
  const latest = findLatestEpisode(scan.episodes);
  const collected = (current.collectedCount ?? 0) > 1;
  const plan = planEpisodeImport({
    bodyEmpty: isEpisodeBodyEmpty(disk.text),
    collected,
    numbered: number !== null,
    isLatest: latest !== undefined && path.isSamePath(latest.filePath, current.filePath),
    shiftCount: shiftPlan?.renames.length ?? 0,
  });

  /*
    ルビと傍点は作品の投稿先に合わせる（作者の答え 2026-11-08「作品の投稿先に合わせる」）。
    決め方は原稿エディターの写しと同じ `copyEmphasisFor`——投稿状態の台帳に**最初に登録した**
    投稿先のうち、ルビの記法を持つもの（note は飛ばす）。登録が無ければカクヨムの形。
    台帳が読めなくても止めない（`registeredPostingSites` が空を返す）
  */
  const emphasis = copyEmphasisFor(await registeredPostingSites(work));

  /*
    頭の題らしい行は、題にするかを訊く（作者の答え 2026-11-08「題として扱うか訊く」）。
    空の話では、開いている話に題の置き場（冒頭の欄の題・サブタイトルの無いファイル名）が
    あるときだけ訊く。置き場の無い話で題にすると、題がどこにも残らない
  */
  const candidate = titleCandidate(imported.text, imported.notation);
  const currentTitlePlace = candidate
    ? await titlePlaceOf(current, disk.text, candidate.title, collected)
    : null;
  let title: string | null = null;
  let body = imported;
  if (candidate && (plan.kind === "ask" || currentTitlePlace !== null)) {
    const useTitle = await askTitle(candidate.title);
    if (useTitle === undefined) return none;
    if (useTitle) {
      title = candidate.title;
      body = { ...imported, text: candidate.rest, chars: charsOf(candidate.rest, imported.notation) };
    }
  }

  const latestSeparator = latest ? (episodeNameStyleOf(latest.fileName)?.separator ?? null) : null;
  const nextFileName =
    pivot === null ? undefined : nextEpisodeName(scan.episodes, current, folder, pivot, title);
  const lastNaming = nameLastEpisode(scan, sourceName, title, latestSeparator);

  let choice: ImportChoice | "fill";
  if (plan.kind === "fill") {
    choice = "fill";
  } else {
    const picked = await askImportChoice(plan.choices, {
      sourceName,
      importedChars: body.chars,
      next: pivot !== null && nextFileName ? { number: pivot, fileName: nextFileName } : undefined,
      shiftCount: shiftPlan?.renames.length ?? 0,
      lastFileName: lastNaming.ok ? lastNaming.named.name : undefined,
      erasedChars: erasedCharCount(disk.text, current.ext),
    });
    if (!picked) return none;
    choice = picked;
  }

  return withCancellableProgress(`「${sourceName}」を取り込んでいます…`, async (_progress, token) => {
    switch (choice) {
      case "fill":
      case "overwrite":
        return writeIntoCurrent({
          work,
          current,
          disk,
          // 題の置き場の無い話へは、題にすると選んでいても1行目ごと本文に入れる（題を失わない）
          imported: title !== null && currentTitlePlace === null ? imported : body,
          title: currentTitlePlace === null ? null : title,
          titlePlace: currentTitlePlace,
          keptTitleInBody: title !== null && currentTitlePlace === null,
          emphasis,
          renameHooks: input.renameHooks,
          sourceName,
          overwrite: choice === "overwrite",
          cancelled: () => token.isCancellationRequested,
        });
      case "next":
        if (pivot === null || !nextFileName) return none;
        return addAsNext({
          work,
          episodes: scan.episodes,
          folder,
          pivot,
          fileName: nextFileName,
          reference: disk,
          imported: body,
          emphasis,
          sourceName,
          cancelled: () => token.isCancellationRequested,
        });
      case "last":
        if (!lastNaming.ok) {
          void vscode.window.showErrorMessage(
            `最後の話のあとへ足せませんでした：${lastNaming.reason}`
          );
          return none;
        }
        if (token.isCancellationRequested) return cancelledBeforeWriting();
        return addAsLast(work, scan, lastNaming.named, body, emphasis, sourceName);
    }
  });
}

/** ファイルを選ぶ窓。テキストは .txt・.md、Word は .docx を1つ */
async function pickImportFile(source: ImportSource): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: source === "word" ? "取り込む Word の文書を選ぶ" : "取り込むテキストファイルを選ぶ",
    openLabel: "取り込む",
    filters:
      source === "word"
        ? { "Word の文書": ["docx"] }
        : { "テキストファイル": ["txt", "md"] },
  });
  return picked?.[0];
}

/** 選んだファイルを読み、取り込む文にする。**取り込み元は読むだけ** */
async function readImported(
  source: ImportSource,
  uri: vscode.Uri,
  sourceName: string
): Promise<({ ok: true } & ImportedText) | { ok: false; reason: string }> {
  const lower = sourceName.toLowerCase();
  const expected = source === "word" ? [".docx"] : [".txt", ".md"];
  if (!expected.some((ext) => lower.endsWith(ext))) {
    return {
      ok: false,
      reason:
        source === "word"
          ? "Word の文書（.docx）を選んでください。"
          : "テキストファイル（.txt・.md）を選んでください。",
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    return { ok: false, reason: `ファイルを読めませんでした（${messageOf(error)}）。` };
  }
  if (bytes.length > IMPORT_MAX_BYTES) {
    return {
      ok: false,
      reason: `大きすぎます（${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)}MBまで）。1話ぶんのファイルを選んでください。`,
    };
  }

  const notation = importedNotationOf(source, sourceName);
  let text: string;
  const notes: string[] = [];
  if (source === "word") {
    try {
      const doc = readWordManuscript(bytes, sourceName);
      text = doc.markdown;
      if (doc.skipped.length > 0) notes.push(`入らなかったもの：${doc.skipped.join("、")}`);
      if (doc.notationClashLines.length > 0) {
        notes.push(`${NOTATION_CLASH_ADVICE}：${describeNotationClashLines(doc.notationClashLines)}`);
      }
    } catch (error) {
      return {
        ok: false,
        reason: `Word の文書として読めませんでした（${messageOf(error)}）。`,
      };
    }
  } else {
    const decoded = decodeImportedText(bytes);
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    text = decoded.text;
    if (decoded.encodingLabel !== "UTF-8") {
      notes.push(`取り込み元は ${decoded.encodingLabel} として読みました。`);
    }
  }

  if (trimImported(text) === "") {
    return { ok: false, reason: "本文がありません（空白と改行だけです）。" };
  }
  const chars = countEpisodeChars(text, {
    ext: notation === "markdown" ? ".md" : ".txt",
    excludeRuby: false,
  }).net;
  return { ok: true, text, notation, chars, notes };
}

/**
 * ［次の話として足す］で作る話の名前（設計書6.67.4 の挿入と同じ決め方）。
 *
 * 空く番号に今いる話（付け替えで1つ後ろへずれる話）の名前の書き方に合わせる。
 * その番号の話が無い（番号が飛んでいる）ときは、開いている話の書き方で番号だけを
 * 変える。**サブタイトルは、作者が「1行目を題にする」を選んだときだけ付ける**
 * （区切りは挿入と同じ `insertedEpisodeFileName` の決め方）。
 */
function nextEpisodeName(
  episodes: readonly EpisodeFile[],
  current: EpisodeFile,
  folder: string,
  pivot: number,
  title: string | null
): string {
  const fallback = episodeNaming();
  const neighbor = episodes.find(
    (episode) =>
      path.isSamePath(path.dirname(episode.filePath), folder) &&
      episodeNumberOf(episode.fileName) === pivot
  );
  if (neighbor) {
    return insertedEpisodeFileName({
      neighborFileName: neighbor.fileName,
      number: pivot,
      subtitle: title ?? "",
      fallback,
    });
  }
  const plain = nextEpisodeFileNameLike({ latestFileName: current.fileName, number: pivot, fallback });
  return title
    ? appendSubtitle(plain, title, episodeNameStyleOf(current.fileName)?.separator ?? null)
    : plain;
}

/**
 * ［最後に加える］で作る話の名前（「最新話」「新しい話を作る」と同じ決め方。
 * いちばん新しい話の名前の書き方で、次の番号）。
 */
function nameLastEpisode(
  scan: ImportScan,
  sourceName: string,
  /** 作者が「1行目を題にする」を選んだときの題。名前のサブタイトルにする */
  title: string | null,
  /** いちばん新しい話の名前の、番号とサブタイトルの区切り（読めなければ null で `_`） */
  separator: string | null
):
  | { ok: true; named: { file: MissingEpisodeFile; name: string } }
  | { ok: false; reason: string } {
  const number = nextChapterNumber(
    scan.episodes.map((episode) => parseEpisodeFileName(episode.fileName))
  );
  const naming = episodeNaming();
  const file: MissingEpisodeFile = {
    order: 0,
    label: sourceName,
    part: null,
    number,
    // 手元の流儀が読めない（話が1つも無い・番号の無い名前だけ）ときは設定から作る
    defaultFileName: nextEpisodeFileNameLike({
      latestFileName: null,
      number,
      fallback: naming,
    }),
    renamable: true,
    // 中身は名前（拡張子）が決まってから寄せる
    content: { kind: "text", text: "" },
  };
  const existing = scan.episodes.map((episode) =>
    path.relative(scan.manuscriptDir, episode.filePath).replace(/\\/g, "/")
  );
  const result = nameNewEpisodes([file], scan, existing);
  if (result.named.length === 0) {
    return { ok: false, reason: result.skipped.map((entry) => entry.reason).join("、") };
  }
  const named = result.named[0];
  return {
    ok: true,
    named: title ? { ...named, name: appendSubtitle(named.name, title, separator) } : named,
  };
}

/** 取り込む文の純文字数（窓に出す。下の欄と同じ数え方） */
function charsOf(text: string, notation: "markdown" | "plain"): number {
  return countEpisodeChars(text, {
    ext: notation === "markdown" ? ".md" : ".txt",
    excludeRuby: false,
  }).net;
}

/** 開いている話の題の置き場 */
type TitlePlace = "header" | "rename";

/**
 * 開いている話（空の話・上書き）で、題をどこに置けるか。
 *
 * - 冒頭の欄に題の欄がある → その欄（カクヨム形式などのダウンロードファイル）
 * - 題の欄が無く、ファイル名にサブタイトルが無い → ファイル名のサブタイトル
 *   （サブタイトルの案と同じ `renameEpisodeFile`。名前がぶつかるなら置けない）
 * - どちらでもない（もうサブタイトルがある・合本）→ 置けない（null）。題は本文に残す
 */
async function titlePlaceOf(
  current: EpisodeFile,
  lfText: string,
  title: string,
  collected: boolean
): Promise<TitlePlace | null> {
  if (collected) return null;
  if (episodeTitleSlot(lfText)) return "header";
  if (current.subtitle) return null;
  const renamed = path.join(path.dirname(current.filePath), renamedFileName(current, title));
  if (path.isSamePath(renamed, current.filePath) || (await pathExists(renamed))) return null;
  return "rename";
}

/**
 * 「1行目を題にしますか」を訊く。題にする→true、本文に入れる→false、やめる→undefined。
 */
async function askTitle(title: string): Promise<boolean | undefined> {
  const items: (vscode.MessageItem & { use?: boolean })[] = [
    { title: "題にする", use: true },
    { title: "本文に入れる", use: false },
    { title: IMPORT_CANCEL_LABEL, isCloseAffordance: true },
  ];
  const answer = await vscode.window.showWarningMessage(
    `1行目「${title}」を、この話の題にしますか？`,
    {
      modal: true,
      detail:
        "［題にする］1行目を本文から外し、話の題にします（冒頭の欄に題の欄があればそこへ、" +
        "無ければファイル名のサブタイトルにします）。\n［本文に入れる］1行目も本文として入れます。",
    },
    ...items
  );
  return answer?.use;
}

/** 話を新しく作るときの名前の決まり（`novelai.addEpisode`・「最新話」と同じ設定） */
function episodeNaming(): { digits: number; extension: string } {
  const config = vscode.workspace.getConfiguration("novelai");
  return {
    digits: config.get<number>("episodeNumberDigits", 3),
    extension: config.get<string>("episodeFileExtension", ".txt"),
  };
}

/** 本文が入っている話で訊く。［やめる］・窓を閉じたら undefined */
async function askImportChoice(
  choices: readonly ImportChoice[],
  detail: Omit<Parameters<typeof describeImportChoices>[0], "choices">
): Promise<ImportChoice | undefined> {
  const items: (vscode.MessageItem & { choice?: ImportChoice })[] = [
    ...choices.map((choice) => ({ title: IMPORT_CHOICE_LABELS[choice], choice })),
    { title: IMPORT_CANCEL_LABEL, isCloseAffordance: true },
  ];
  const answer = await vscode.window.showWarningMessage(
    "この話には本文が入っています。取り込んだ文をどうしますか？",
    { modal: true, detail: describeImportChoices({ choices, ...detail }).join("\n") },
    ...items
  );
  return answer?.choice;
}

function cancelledBeforeWriting(): ManuscriptImportResult {
  void vscode.window.showInformationMessage("取り込みを中止しました（何も書いていません）。");
  return { changed: false };
}

/**
 * 開いている話へ書く（本文が空の話・［上書きする］）。
 *
 * **ハッシュは窓を出す前に読んだもので照らす**——作者が「N字が消える」と見て決めた
 * 中身と、書き換える中身が同じであることを確かめるため。そのあいだに外で書き換えられて
 * いれば、書かずに止まる。
 */
async function writeIntoCurrent(input: {
  readonly work: WorkEntry;
  readonly current: EpisodeFile;
  readonly disk: TextFileContent;
  readonly imported: ImportedText;
  /** 題にする字（置き場があるときだけ） */
  readonly title: string | null;
  readonly titlePlace: TitlePlace | null;
  /** 題にすると選んだが置き場が無く、1行目を本文に残した */
  readonly keptTitleInBody: boolean;
  readonly emphasis: EmphasisSite;
  readonly renameHooks?: {
    beforeRename?: (from: string, to: string) => void;
    afterRename?: (from: string) => void;
  };
  readonly sourceName: string;
  readonly overwrite: boolean;
  readonly cancelled: () => boolean;
}): Promise<ManuscriptImportResult> {
  const { work, current, disk, imported, sourceName } = input;
  if (input.cancelled()) return cancelledBeforeWriting();

  const adapted = adaptImportedNotation(
    imported.text,
    imported.notation,
    current.fileName,
    input.emphasis
  );
  const withBody = replaceEpisodeBody(disk.text, adapted);
  // 題は本文と同じ1回の書き込みで冒頭の欄へ入れる（欄が無ければ、書いたあとに名前へ付ける）
  const newText =
    input.title && input.titlePlace === "header"
      ? (replaceEpisodeTitle(withBody, input.title) ?? withBody)
      : withBody;
  // 空のファイル（0バイト）には末尾の改行の流儀がまだ無い。行の終わりで終える
  // （新しく作る話と同じ）。ハッシュは読んだときのままで照らす
  const format =
    disk.text === "" ? { ...disk, hasTrailingNewline: true } : disk;
  const result = await writeTextFilePreservingFormat(current.filePath, newText, format, disk.hash);
  if (!result.ok) {
    logStep(
      `原稿エディター：「${sourceName}」を ${current.fileName} へ書けませんでした（${result.reason}${
        result.detail ? `：${result.detail}` : ""
      }）`
    );
    void vscode.window.showErrorMessage(describeWriteFailure(result, current.fileName));
    return { changed: false };
  }

  // 原稿エディターの表示を最新にする（退避→作り直しは VS Code の読み直しに拾われないことがある）
  await reloadOpenDocumentAfterWrite(current.filePath, work);
  const head = input.overwrite
    ? `${current.fileName} の本文を、「${sourceName}」の文（${imported.chars}字）に置き換えました。` +
      "書き換える前の本文は控え（.novelai-recovery）にあります。タイムラインの「書き換える前の控え」から戻せます。"
    : `「${sourceName}」の文（${imported.chars}字）を ${current.fileName} の本文に入れました。`;
  logStep(`原稿エディター：${head}${result.recoveryPath ? `（控え：${result.recoveryPath}）` : ""}`);
  const notes = [...imported.notes];
  if (input.keptTitleInBody) {
    notes.push("この話には題の置き場（冒頭の題の欄・サブタイトルの無いファイル名）が無いため、1行目は本文に入れました。");
  }

  if (input.title && input.titlePlace === "rename") {
    /*
      題の欄の無い原稿は、サブタイトルの案と同じ道でファイル名に付ける（`renameEpisodeFile`
      ＋パスで話を指す台帳の追従）。**本文を書けてから名前を変える**——名前が変えられなくても
      本文は入っており、題は知らせに出すので作者が付け直せる
    */
    try {
      const renamed = await renameEpisodeFile(current, input.title, input.renameHooks);
      const summary = await followEpisodeFileRenames(work, [
        { fromPath: current.filePath, toPath: renamed },
      ]);
      useLogFile(work.folderPath);
      const notice = renameFollowNotice(
        `${head}題「${input.title}」をファイル名に付けました（${path.basename(renamed)}）。`,
        summary
      );
      logStep(`原稿エディター：${notice.text}`);
      const text = [notice.text, ...notes].join("\n");
      if (notice.warn) void vscode.window.showWarningMessage(text);
      else void vscode.window.showInformationMessage(text);
      return { changed: true, newFilePath: renamed };
    } catch (error) {
      logFailure("原稿エディターの取り込み：題をファイル名に付けられなかった", {
        ファイル: current.filePath,
        詳細: messageOf(error),
      });
      void vscode.window.showWarningMessage(
        [
          `題「${input.title}」はファイル名に付けられませんでした（${messageOf(error)}）。本文は入っています。`,
          head,
          ...notes,
        ].join("\n")
      );
      return { changed: true };
    }
  }

  void vscode.window.showInformationMessage([head, ...notes].join("\n"));
  return { changed: true };
}

/** 書けなかった理由を、作者が次にすることと一緒に言う。**書いていないことを先に** */
function describeWriteFailure(
  result: Extract<WriteTextFileResult, { ok: false }>,
  fileName: string
): string {
  const head = `${fileName} へは取り込んでいません。`;
  switch (result.reason) {
    case "modified_externally":
      return (
        head +
        "読んだあとで、このファイルが外で書き換えられました（ほかのアプリや同期）。" +
        "中身を確かめてから、もう一度お試しください。"
      );
    case "conflict_markers":
      return head + "同期の競合の印（<<<<<<< など）があります。先に競合を解決してください。";
    case "unsaved_changes":
      return head + "保存していない変更があります。保存してからもう一度お試しください。";
    case "encoding_error":
      return (
        head +
        "この話の文字コードでは書けない文字が、取り込む文に入っています。" +
        "取り込む文からその文字を除くか、この話を UTF-8 で保存し直してからお試しください。"
      );
    case "editor_locked":
      return head + (result.detail ?? "編集部が校閲中の話です。");
    case "path_conflict":
      return head + `書き込めませんでした：${result.detail ?? ""}`;
  }
}

/** ［次の話として足す］。付け替えは「この話の前に挿入」と同じ道 */
async function addAsNext(input: {
  readonly work: WorkEntry;
  readonly episodes: EpisodeFile[];
  readonly folder: string;
  readonly pivot: number;
  readonly fileName: string;
  readonly reference: TextFileContent;
  readonly imported: ImportedText;
  readonly emphasis: EmphasisSite;
  readonly sourceName: string;
  readonly cancelled: () => boolean;
}): Promise<ManuscriptImportResult> {
  const { work, episodes, pivot, fileName, imported, sourceName } = input;
  const adapted = trimImported(
    adaptImportedNotation(imported.text, imported.notation, fileName, input.emphasis)
  );
  // **番号をずらす前に、書けるかを確かめる。** ずらしてから書けないと分かると、
  // 番号が1つ空いたまま残る
  const bytes = encodeForNewFile(adapted, input.reference);
  if (!bytes) {
    void vscode.window.showErrorMessage(
      `取り込んでいません。手元の原稿の文字コード（${input.reference.encoding}）では書けない文字が、取り込む文に入っています。`
    );
    return { changed: false };
  }

  const { prepareInsertion, runInsertion } = await import("./insertEpisode.js");
  const prepared = await prepareInsertion(work, episodes, pivot, input.folder);
  if (!prepared.ok) {
    void vscode.window.showErrorMessage(prepared.message);
    return { changed: false };
  }
  if (input.cancelled()) return cancelledBeforeWriting();

  const newFilePath = path.join(input.folder, fileName);
  const result = await runInsertion(
    work,
    episodes,
    prepared,
    {
      filePath: newFilePath,
      bytes,
      commitMessage: `第${pivot}話を取り込んで差し込んだため、第${pivot}話以降の話数を調整`,
    },
    { isCancelled: input.cancelled }
  );

  if (result.stoppedAt) {
    // どこまで済んだかは付け替えの知らせ（`reportRenumberOutcome`）が出している。
    // こちらは、取り込みがまだ入っていないことと、空いた番号を言う
    void vscode.window.showWarningMessage(
      `「${sourceName}」はまだどこにも入れていません。話の番号を途中までずらしたところで止まりました` +
        `（第${result.stoppedAt.rename.newNumber}話の番号が空いています）。本文は1文字も失われていません。` +
        "作品一覧で並びを確かめ、止まった理由を取り除いてから、空いた番号の話を作るか、ずらした話の名前を戻してください。"
    );
    return { changed: result.changed };
  }
  if (!result.newFilePath) return { changed: result.changed };

  logStep(`原稿エディター：「${sourceName}」を第${pivot}話（${fileName}）として差し込みました`);
  void vscode.window.showInformationMessage(
    [`「${sourceName}」を第${pivot}話（${fileName}）として足しました。`, ...imported.notes].join("\n")
  );
  return { changed: true, newFilePath: result.newFilePath };
}

/** ［最後に加える］。ほかの話には触らない（`mode: "create"` だけ） */
async function addAsLast(
  work: WorkEntry,
  scan: ImportScan,
  named: { file: MissingEpisodeFile; name: string },
  imported: ImportedText,
  emphasis: EmphasisSite,
  sourceName: string
): Promise<ManuscriptImportResult> {
  const text = trimImported(
    adaptImportedNotation(imported.text, imported.notation, named.name, emphasis)
  );
  const written = await writeNewEpisodes(work, scan, [
    { name: named.name, file: { ...named.file, content: { kind: "text", text } } },
  ]);
  if (written.added.length === 0) {
    const reason = written.skipped.map((entry) => entry.reason).join("、");
    logStep(`原稿エディター：「${sourceName}」を最後の話のあとへ足せませんでした：${reason}`);
    void vscode.window.showErrorMessage(`取り込んでいません。${reason}`);
    return { changed: false };
  }
  const added = written.added[0].path;
  logStep(`原稿エディター：「${sourceName}」を ${named.name} として最後に加えました`);
  void vscode.window.showInformationMessage(
    [`「${sourceName}」を ${named.name} として最後に加えました。`, ...imported.notes].join("\n")
  );
  return { changed: true, newFilePath: added };
}
