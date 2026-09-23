import { unzipSync } from "fflate";
import {
  buildCollectedTextFromAlphapolis,
  parseAlphapolisBackup,
} from "./alphapolisBackup";
import {
  checkBackupEncoding,
  type BackupEncodingEntry,
  type BackupEncodingReport,
} from "./backupEncoding";
import { detectBackupSite } from "./backupSite";
import { parseCollectedFile, parseEpisodeTitle } from "./collectedFile";
import type { OutlineEpisode } from "./chapterOutline";
import { countEpisodeChars } from "./episodeCharCount";
import {
  checkEpisodeNumbers,
  type EpisodeNumberEntry,
  type EpisodeNumberReport,
} from "./episodeNumberCheck";
import { parseEpisodeFileName } from "./episodeParser";
import { parseEpisodeMetadata } from "./metadataParser";
import { parseNarouBackup, type NarouBackup } from "./narouBackup";
import { decodeBytes, type Encoding } from "./textDecode";
import { isWorkInfoFile } from "./workInfoFile";
import { parseWorkInfo, type WorkInfo } from "./workInfoParse";
import type { PostingSiteId } from "../models/posting";
import type { Eol } from "../models/types";

/**
 * バックアップの中を確かめて、作品として取り込める形にする（設計書6.99）。
 *
 * **入れ物はサイトによって違う**（0.69.10）。カクヨム・なろうは ZIP、
 * **アルファポリスは `.txt` 直**（`alphapolisBackup.ts`）。入口は
 * `inspectWorkBackup` の1つで、どちらも同じ `WorkZipInspection` を返す。
 *
 * 作者の言葉（2026-09-19）：
 * 「初心者が初めて使うところを魅せたい」——**ダウンロードしたものを、
 * そのまま渡せば作品になる**のが、いちばん最初の体験である。
 *
 * ## ZIPの中のファイル名を信じない
 *
 * ZIPは名前をそのまま持っているだけなので、`../../autoexec` のような
 * 名前も、`C:\Windows\...` のような名前も入れられる。展開する側が
 * 素直に繋ぐと、**作品フォルダーの外へ書き出してしまう**（zip slip）。
 * 見つけたら**1件も展開せずに止める**——半分だけ展開して「危ないものが
 * ありました」と言われても、作者には後始末のしようがない。
 *
 * ## 入れるのは .txt と .md だけ
 *
 * 画像や実行ファイルは、そもそも書き出さない。中身の分からないものを
 * 作品フォルダーへ置かないで済むうえ、**小説に見えないZIPを断る**判断
 * （テキストが1つも無い）もここで自然に付く。
 *
 * ## 文字コードはUTF-8とShift_JISの両方を試す
 *
 * なろう・カクヨムの古いダウンロードファイルはShift_JISのことがある。
 * 判定は製品と同じ `textDecode.ts` を通す（写しを作ると、製品と
 * 取り込みで読み方が食い違う）。
 *
 * VS Code APIに依存しない。
 */

/** 取り込む拡張子。これ以外は書き出さない */
const TEXT_EXTENSIONS = [".txt", ".md"];

/**
 * 取り込める入れ物の拡張子。**置き場は `backupFileKinds.ts`**（相談パネルの
 * 受け口が、ZIPの展開の部品を読み込まずに使えるように分けた）。ここからも
 * これまでどおり取れるよう、出し直しておく。
 */
export { BACKUP_FILE_EXTENSIONS } from "./backupFileKinds";

export class WorkZipError extends Error {
  constructor(
    message: string,
    /** 作者に見せる詳しい理由（ダイアログの小さい字に出す） */
    readonly detail?: string
  ) {
    super(message);
    this.name = "WorkZipError";
  }
}

/** 取り込む1ファイル */
export interface ZipTextFile {
  /** 作品フォルダーからの相対パス（`/` 区切り。共通の入れ物は剥がしてある） */
  readonly name: string;
  /** そのまま書き出すバイト列 */
  readonly bytes: Uint8Array;
  /** ZIPの中での文字コード */
  readonly encoding: Encoding;
  /** 作品情報（`about.txt`）か。話としては数えない */
  readonly isWorkInfo: boolean;
  /** 本文の純文字数。作品情報は 0 */
  readonly charCount: number;
}

export interface WorkZipInspection {
  /** 書き出すファイル */
  readonly files: readonly ZipTextFile[];
  /**
   * 取り込む話の数。
   *
   * **ファイルの数ではない。** なろうのバックアップは全話が1ファイルに
   * 入った合本なので、ファイルを数えると4話の作品でも「1話を取り込みました」
   * と出る（2026-09-19、実データで確認）。合本と分かったときは、
   * **中の区切りの数**を使う（`narouBackup.ts` の `episodeCount`）。
   */
  readonly episodeCount: number;
  /**
   * 全話が1ファイルに入っているか（合本）。
   *
   * 作者への説明を変えるために持つ——「4話」と言いながら原稿のファイルが
   * 1つしか無いと、取り込んだあとで数が合わないように見える。
   */
  readonly collected: boolean;
  /** 合計の純文字数 */
  readonly totalChars: number;
  /** 入れなかったファイルの名前（画像など） */
  readonly skipped: readonly string[];
  /** `about.txt` から読み取った作品情報。無ければ null */
  readonly info: WorkInfo | null;
  /**
   * なろうのバックアップから読めたもの（`narouBackup.ts`）。無ければ null。
   *
   * **カクヨムのバックアップには対応するものが無い**（数字が入っていない）。
   */
  readonly narou: NarouBackup | null;
  /**
   * どの投稿サイトのバックアップか（設計書6.99）。**見分けられなければ null。**
   *
   * 「この作品はもうそのサイトに載っている」ことだけを指す。作品IDもURLも
   * バックアップには入っていないので、ここから分かるのはサイトだけである。
   */
  readonly site: PostingSiteId | null;
  /** 採った作品名 */
  readonly title: string;
  /**
   * 題をどこから採ったか。作者への説明に使う。`fileName` は ZIP でない
   * ファイル（相談パネルへ落とされた Word 原稿。`wordManuscript.ts`）の名前
   */
  readonly titleSource: "about" | "zipName" | "fileName";
  /**
   * 話番号の点検——重複と欠番（作者の指示、2026-09-19。0.69.10）。
   *
   * **全サイト共通である。** アルファポリスの実物で見つけた問題だが、
   * なろうの合本にもカクヨムの複数ファイルにも同じ点検を掛ける。
   * **止めない**——飛んでいることを知らせるだけで、取り込みは続く。
   */
  readonly episodeNumbers: EpisodeNumberReport;
  /**
   * 文字コードの点検（作者の指示、2026-09-19。`backupEncoding.ts`）。
   *
   * **サイトに紐づけない。** 見ているのは「Shift_JIS で読んだ」という事実
   * だけなので、アルファポリスの `.txt` でも、なろう・カクヨムの ZIP に
   * Shift_JIS のファイルが混じっていても、同じ助言が出る。
   */
  readonly encodingNotice: BackupEncodingReport;
  /**
   * 中身まで同じだったので取り込みから落とした話の名前。
   *
   * **落としたことは必ず伝える**（作者の指示）。黙って捨てると、
   * 188話のはずが187話になっていても誰も気づけない。
   */
  readonly dropped: readonly string[];
  /**
   * 話の並びと、それぞれが属する章の題（残課題 B7。設計書6.66.6）。
   *
   * **なろうの合本は章の題を持っているのに、ここへ載せていなかった**——
   * `collectedFile.ts` は【第N章】の次の行を `part` で拾っていたが、受け渡しが
   * 話数・題・本文だけで、`part` はここで落ちていた。章立てを取り込む側
   * （`chapterOutline.ts`）はこの並びだけを見る。
   *
   * - なろう：合本の区切りごと（`part` は【第N章】の次の行）
   * - アルファポリス：取り込む話ごと（中身まで同じ重複を落としたあと。書き出す合本と同じ並び）
   * - カクヨム：話ごとのファイル（**章はバックアップに無い**ので `part` は全部 null）
   */
  readonly outline: readonly OutlineEpisode[];
}

/**
 * 選ばれたファイルを読んで、取り込める形にする。**読むだけで、1文字も書かない。**
 *
 * **入れ物はサイトによって違う**（0.69.10）。
 *
 * - カクヨム・なろう：**ZIP**（`inspectWorkZip`）
 * - アルファポリス：**`.txt` 直**（`inspectWorkTextBackup`）
 * - なろうの ZIP を**展開した `.txt`**（合本そのもの）：`.txt` の道で受け、
 *   中身は ZIP と同じ読み方をする（2026-09-23）
 *
 * どの道も同じ `WorkZipInspection` を返すので、取り込む側
 * （`features/importWorkFromZip.ts`）は入れ物の違いを知らなくてよい。
 *
 * @param bytes 選ばれたファイルそのもの
 * @param fileName 拡張子まで含むファイル名（題の予備として使う）
 */
export function inspectWorkBackup(
  bytes: Uint8Array,
  fileName: string
): WorkZipInspection {
  return extensionOf(fileName) === ".zip"
    ? inspectWorkZip(bytes, fileName)
    : inspectWorkTextBackup(bytes, fileName);
}

/**
 * `.txt` 直のバックアップを読む（アルファポリス 0.69.10、なろうの展開済み合本 2026-09-23）。
 *
 * ## なろうの印を先に見る
 *
 * 作者は、なろうのバックアップ ZIP を**展開して `.txt` のまま保存している**
 * （何作ぶんも。2026-09-23、ノートPCの実機）。はじめはここをアルファポリス
 * 専用にしていたので、ZIP の中身そのものを渡しても「ZIP のまま選んで
 * ください」で弾いていた。
 *
 * 見分けは **`parseNarouBackup` そのもの**（【Nコード】が N＋4桁＋英字2文字で
 * 読めること）を使う。印を写して別に判定すると、ZIP の道と `.txt` の道で
 * 「なろうと読むかどうか」が食い違いうる。読めたら、**ZIP の中の1ファイルと
 * まったく同じ道**（`readTextEntry` → `inspectTextFiles`）へ流す——文字コード
 * （Shift_JIS なら UTF-8 へ直す）も、題・話数・点検も、ZIP で渡したときと
 * 1つも違わない。相談パネルの照合（`backupMatch.ts`）と取り込み
 * （`backupMerge.ts`）は `WorkZipInspection` しか見ないので、ここ1か所で揃う。
 *
 * **なろうを先に見る**のは、なろうの頭（【ユーザ情報】…）はアルファポリスの
 * 形（1行目が章題か話の見出し）には当たらないが、逆の順だとアルファポリスの
 * 読み方が将来ゆるんだときに、なろうの合本を取り違えうるからである。
 *
 * ## 丸ごと復号してから判定する
 *
 * **バイト列を切らない。** 頭だけ切って文字コードを見分けると、最後の
 * 1文字が欠けた並びになって判定が外れ、**全文が化ける**——0.69.9 で
 * なろうの合本を読めなくした穴と同じ形である。作者のアルファポリスの
 * 書き出しは **Shift_JIS 版と UTF-8 版の両方**があるので、ここは特に効く。
 *
 * ## 題はファイル名から採るしかない
 *
 * **作品情報の見出しが1つも無い**（いきなり本文から始まる）。題も作者名も
 * あらすじも書かれていないので、`about.txt` に当たるものが無い。
 */
export function inspectWorkTextBackup(
  bytes: Uint8Array,
  fileName: string
): WorkZipInspection {
  const decoded = decodeBytes(bytes);
  if (parseNarouBackup(decoded.text)) {
    return inspectNarouTextBackup(bytes, fileName);
  }

  const backup = parseAlphapolisBackup(decoded.text);
  if (!backup) {
    throw new WorkZipError(
      "このファイルは、取り込める形のバックアップではありませんでした。",
      [
        "テキストのまま受けられるのは、次の2つです。",
        "・小説家になろうのバックアップを展開した .txt（先頭に【Nコード】の欄があるもの）",
        "・アルファポリスの書き出し（章と話の見出しで区切られた .txt）",
        "",
        "カクヨムのバックアップは ZIP のまま選んでください。",
      ].join("\n")
    );
  }

  /*
    **既存の合本の形へ載せ替えてから置く**（`alphapolisBackup.ts`）。

    製品の中で「1ファイルに全話」を扱えるのはあの形だけなので、生のまま
    置くと **188話がまるごと1話に見える。** 文字参照（実物に152件）も
    ここでほどけているので、`&#x2014;` が原稿に残ることもない。

    **文字コードは UTF-8 にする。** 載せ替えで全文を作り直している以上、
    Shift_JIS のまま書き戻す意味はない（作者の元ファイルには触らない）。
  */
  const collected = buildCollectedTextFromAlphapolis(backup);
  const title = workTitleFromBackupFileName(fileName);
  const file: ZipTextFile = {
    // **原稿の名前も、ダウンロードの印（`(2)`）を落としたものにする。**
    // 元の名前のままだと `…(2).txt` が本文フォルダーに並ぶ
    name: `${title}.txt`,
    bytes: new TextEncoder().encode(collected),
    encoding: decoded.encoding,
    isWorkInfo: false,
    charCount: countEpisodeChars(collected, {
      ext: ".txt",
      excludeRuby: false,
    }).net,
  };

  return {
    files: [file],
    episodeCount: backup.episodes.length,
    // 全話が1ファイルに入っている（作者への説明が変わる）
    collected: true,
    totalChars: file.charCount,
    skipped: [],
    // **作品情報が無いので、下書きにできるものも無い**（AIに作らせない）
    info: null,
    narou: null,
    site: detectBackupSite({
      zipFileName: fileName,
      workInfoText: null,
      alphapolisHeader: true,
    }),
    title,
    titleSource: "zipName",
    /*
      **点検は「落とす前」の並びに掛ける**（`allEpisodes`）。落としたあとを
      見ると重複そのものが消えてしまい、「同じ話が2回入っています」と
      言えなくなる——作者の指示は「**必ず言う**」である。
    */
    episodeNumbers: checkEpisodeNumbers(
      backup.allEpisodes.map((episode) => ({
        number: episode.number,
        label: episode.label,
        body: episode.body,
      }))
    ),
    /*
      **数えるのは復号したそのままの全文**（`decoded.text`）である。

      載せ替えたあと（`collected`）ではなく元の全文を見るのは、作者が
      ファイルを開いて確かめる相手が**ダウンロードしたそのファイル**
      だからである。件数が食い違うと、確かめようがなくなる。
    */
    encodingNotice: checkBackupEncoding([
      { encoding: decoded.encoding, text: decoded.text },
    ]),
    dropped: backup.dropped,
    // 書き出す合本（`buildCollectedTextFromAlphapolis`）と同じ並び——重複を落としたあと
    outline: backup.episodes.map((episode) => ({
      label: episode.label,
      number: episode.number,
      title: episode.title,
      part: episode.part,
    })),
  };
}

/**
 * ZIPを読んで、取り込める形にする。**読むだけで、1文字も書かない。**
 *
 * @param zipBytes ZIPそのもの
 * @param zipFileName 拡張子まで含むファイル名（題の予備として使う）
 */
export function inspectWorkZip(
  zipBytes: Uint8Array,
  zipFileName: string
): WorkZipInspection {
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(zipBytes);
  } catch (error) {
    throw new WorkZipError(
      "ZIPファイルとして読めませんでした。",
      `ダウンロードが途中で終わっていないか、ご確認ください。（${
        error instanceof Error ? error.message : String(error)
      }）`
    );
  }

  // フォルダーそのものの項目（中身が無く、名前が `/` で終わる）は読み飛ばす
  const names = Object.keys(raw).filter((name) => !name.endsWith("/"));
  if (names.length === 0) {
    throw new WorkZipError("ZIPの中が空でした。");
  }

  // **危ない名前が1つでもあれば、1件も展開しない**（zip slip）
  const unsafe = names.filter(isUnsafeZipEntryName);
  if (unsafe.length > 0) {
    throw new WorkZipError(
      "このZIPには、作品フォルダーの外を指すファイル名が入っています。",
      [
        "安全のため、1件も取り込みませんでした。",
        "",
        `そのような名前：${summarizeNames(unsafe)}`,
      ].join("\n")
    );
  }

  const strip = commonRootStripper(names);
  const files: ZipTextFile[] = [];
  const skipped: string[] = [];

  for (const name of names) {
    const target = strip(name);
    if (!hasTextExtension(target)) {
      skipped.push(target);
      continue;
    }
    files.push(readTextEntry(target, raw[name]));
  }

  if (files.length === 0) {
    throw new WorkZipError(
      "このZIPには、小説の原稿（.txt / .md）が入っていませんでした。",
      skipped.length > 0
        ? `入っていたもの：${summarizeNames(skipped)}`
        : undefined
    );
  }

  return inspectTextFiles(files, skipped, zipFileName);
}

/**
 * なろうの ZIP を展開した `.txt`（合本そのもの）を読む（2026-09-23）。
 *
 * **ZIP の中に1ファイルだけ入っていたのと同じ形にして、同じ道へ流す。**
 * 名前は選ばれたファイルの名前から採る（フォルダーを落とし、ダウンロードの
 * 印 `(2)` も落とす）——展開しただけのファイルなら `N4190FX.txt` で、
 * ZIP の中の名前と同じになる。
 */
function inspectNarouTextBackup(
  bytes: Uint8Array,
  fileName: string
): WorkZipInspection {
  const ext = hasTextExtension(fileName) ? extensionOf(fileName) : ".txt";
  const name = `${workTitleFromBackupFileName(fileName)}${ext}`;
  return inspectTextFiles([readTextEntry(name, bytes)], [], fileName);
}

/**
 * 取り出したテキストのファイルを、取り込める形にまとめる。
 *
 * **ZIP の道と、なろうの展開済み `.txt` の道が共有する。** ここを分けて
 * 写すと、同じ合本を ZIP で渡したときと `.txt` で渡したときで、題や話数や
 * 点検の結果が食い違う。
 *
 * @param zipFileName 選ばれたファイルの名前（題の予備と、出どころの手がかり）
 */
function inspectTextFiles(
  files: ZipTextFile[],
  skipped: string[],
  zipFileName: string
): WorkZipInspection {
  const aboutFile = files.find((file) => file.isWorkInfo);
  const workInfoText = aboutFile ? decodeBytes(aboutFile.bytes).text : null;
  const narou = findNarouBackup(files);
  /*
    **作品情報は `about.txt`、無ければなろうの合本の頭から読む。**

    なろうのバックアップには `about.txt` が無く、題も作者名もあらすじも
    キーワードも**合本の頭**に入っている。ここを繋がないと、作品名がZIPの
    名前（Nコード）になり、書いてある紹介文もタグも下書きに置かれない。
  */
  const infoText = workInfoText ?? narou?.head ?? null;
  const info = infoText === null ? null : parseWorkInfo(infoText);

  const fromAbout = info?.title ? sanitizeWorkFolderName(info.title) : "";
  const title = fromAbout || workTitleFromZipFileName(zipFileName);

  // **並べ替える。** ZIPは書き込んだ順で入っているので、そのまま出すと
  // 確認の画面に並ぶ順が作者の見慣れた話順にならない
  files.sort((a, b) => a.name.localeCompare(b.name, "ja"));

  const fileEpisodes = files.filter((file) => !file.isWorkInfo).length;

  return {
    files,
    /*
      **合本は、中の区切りを数える**（0.69.9）。ZIPに入っているファイルは
      1つでも、作者にとっては4話である——「1話を取り込みました」と出ると、
      3話がどこかへ消えたように見える。

      合本の話が0と読めたとき（区切りが1つも無いなど）はファイルの数へ
      戻す。**0話と言い切らない**のは、原稿は現に入っているからである。
    */
    episodeCount: narou?.episodeCount || fileEpisodes,
    collected: (narou?.episodeCount ?? 0) > fileEpisodes,
    totalChars: files.reduce((total, file) => total + file.charCount, 0),
    skipped,
    info,
    narou,
    // **見分けられたときだけ入る**（`backupSite.ts`）。読むだけで、ここでも
    // まだ1文字も書かない——書き留めるかどうかは取り込む側が決める
    site: detectBackupSite({
      zipFileName,
      workInfoText,
      narouHeader: narou !== null,
    }),
    title,
    titleSource: fromAbout ? "about" : "zipName",
    /*
      **点検はアルファポリス専用にしない**（作者の指示、2026-09-19）。
      なろうの合本にも、カクヨムの複数ファイルにも同じ点検を掛ける。

      **ZIPからは落とさない。** 中身まで同じ重複が見つかっても、落とす
      単位が「ファイル1つ」か「区切り1つぶん」になり、そこには本文以外
      （カクヨムの【公開日時】、なろうの【リアクション】）が付いている
      ——本文が同じでも、落とせば作者の持っていたものが減る。
      **言うだけにして、捨てるのは作者に任せる。**
    */
    episodeNumbers: checkEpisodeNumbers(zipEpisodeEntries(files, narou)),
    encodingNotice: checkBackupEncoding(encodingEntries(files)),
    dropped: [],
    outline: outlineOf(files),
  };
}

/**
 * 話の並びと章の題を取り出す（`WorkZipInspection.outline`）。
 *
 * **読み方は取り込みと同じ部品を通す**（合本は `parseCollectedFile`、話ごとの
 * ファイルは `parseEpisodeMetadata`）。並びは確認の画面と同じ、ファイル名の順
 * （`inspectTextFiles` で並べ替えたあと）。
 */
function outlineOf(files: readonly ZipTextFile[]): OutlineEpisode[] {
  const outline: OutlineEpisode[] = [];
  for (const file of files) {
    if (file.isWorkInfo) continue;
    const text = decodeBytes(file.bytes).text;
    const collected = parseCollectedFile(text);
    if (collected) {
      /*
        **【第N章】は章の最初の話にしか付かない**（作者の `N5078JI.txt` で、5章31話に
        見出し5つ）。`part` は「その話が属する章」なので、次の見出しまで引き継ぐ
        ——アルファポリスの `part` と同じ意味に揃える
      */
      let part: string | null = null;
      for (const episode of collected) {
        part = episode.part?.trim() || part;
        outline.push({
          label: outlineLabel(episode.chapter, episode.title, episode.order),
          number: episode.chapter,
          title: episode.title,
          part,
        });
      }
      continue;
    }
    const metadata = parseEpisodeMetadata(text);
    const fromTitle = parseEpisodeTitle(metadata.title);
    outline.push({
      label: metadata.title ?? file.name,
      // 題に話数が無ければファイル名から（`episode_0012.txt`）。並び順では埋めない
      number:
        fromTitle.chapter ??
        parseEpisodeFileName(file.name.replace(/^.*\//, "")).chapterStart,
      title: fromTitle.title,
      part: null,
    });
  }
  return outline;
}

/** 「3話　嵐の夜」。話数が読めなければ題、題も無ければ「3番目の話」 */
function outlineLabel(
  number: number | null,
  title: string | null,
  order: number
): string {
  if (number !== null) return title ? `${number}話　${title}` : `${number}話`;
  return title ?? `${order}番目の話`;
}

/**
 * 文字コードの点検（`backupEncoding.ts`）に渡す形にする。
 *
 * **UTF-8 のファイルは文字へ直さない。** 数えるのは Shift_JIS で読んだ
 * ぶんだけなので、合本（実物で2MB近い）をもう一度復号する意味がない。
 *
 * Shift_JIS だったファイルの `bytes` は既に UTF-8 へ直してあるが
 * （`readTextEntry`）、**本文そのものは1文字も変わっていない**ので、
 * ここで読み直しても件数は同じである。
 */
function encodingEntries(
  files: readonly ZipTextFile[]
): BackupEncodingEntry[] {
  return files.map((file) => ({
    encoding: file.encoding,
    text: file.encoding === "shift_jis" ? decodeBytes(file.bytes).text : "",
  }));
}

/**
 * ZIPの中身を、話番号の点検にかけられる形にする。
 *
 * **合本（なろう）と、話ごとのファイル（カクヨム）で読み方が違う。**
 * 合本は中の区切りが1話ぶんで、ファイルは1つしか無い——ファイルを
 * 数えると「1話」になってしまうのと同じ理由である（0.69.9）。
 */
function zipEpisodeEntries(
  files: readonly ZipTextFile[],
  narou: NarouBackup | null
): EpisodeNumberEntry[] {
  if (narou) {
    // 合本は1つしか無いので、読むのもその1つだけでよい
    const collectedFile = files.find((file) => !file.isWorkInfo);
    const episodes = collectedFile
      ? parseCollectedFile(decodeBytes(collectedFile.bytes).text)
      : null;
    if (episodes) {
      return episodes.map((episode) => ({
        /*
          **題から話数を読めなければ、区切り行の番号を使う**（0.70.1）。

          実データで確かめた（2026-09-19、作者のなろう作品2つ）。
          `N2600GO` は「１話　転生」で219話すべて読めるが、`N4190FX` は
          「１　自殺の後始末」と**「話」を伴わない**ので1つも読めず、
          取り込むたびに「話数を読み取れなかった話が4件あります」と
          出ていた——**題の付け方の癖であって、作者の落ち度ではない。**

          区切り行の「エピソードN開始」のNは**なろう自身が書いた掲載順**で、
          必ず入っている（`narouBackup.ts` に同じ理由が書いてある）。
          ファイルの並び順で埋めるのとは違う——あちらは当てにならないので
          下の枝では null のままにしてある。
        */
        number: episode.chapter ?? episode.order,
        label: episode.title ?? `${episode.order}番目の話`,
        body: episode.body,
      }));
    }
  }

  return files
    .filter((file) => !file.isWorkInfo)
    .map((file) => {
      const text = decodeBytes(file.bytes).text;
      const metadata = parseEpisodeMetadata(text);
      const fromTitle = parseEpisodeTitle(metadata.title);
      return {
        // 題に話数が無ければファイル名から採る（`episode_0012.txt`）。
        // **どちらからも読めなければ null**——並び順では埋めない
        number:
          fromTitle.chapter ??
          parseEpisodeFileName(file.name.replace(/^.*\//, "")).chapterStart,
        label: metadata.title ?? file.name,
        body: metadata.hasMetadata ? metadata.body : text,
      };
    });
}

/**
 * なろうのバックアップの頭を探す。
 *
 * **頭だけを読む。** 合本は全話が1ファイルに入っているので、丸ごと文字へ
 * 直すと大きい作品では無駄が大きい——【Nコード】は必ずファイルの先頭に
 * 並ぶ欄の中にある（`narouBackup.ts` が最初の区切り行で読むのをやめる）。
 */
function findNarouBackup(files: readonly ZipTextFile[]): NarouBackup | null {
  for (const file of files) {
    /*
      **丸ごと文字へ直してから読む。**

      はじめは「頭の8KBだけ見れば速い」と書いたが、**実データで読めなかった**
      （2026-09-19、作者の `N4190FX.zip`）。バイト列を途中で切ると、最後の
      1文字が欠けた並びになり、**文字コードの見分け（`textDecode.ts`）が
      UTF-8ではないほうへ倒れる**——全文が化けるので、見出しが1つも見つからない。
      速さのために切った数キロバイトが、機能そのものを黙って止めていた。

      読むところ（`parseNarouBackup`）は最初の区切り行で止まるので、
      大きい合本でも余計に見るのは文字コードの変換だけである。
    */
    const parsed = parseNarouBackup(decodeBytes(file.bytes).text);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * その名前は、作品フォルダーの外へ出ようとしているか。
 *
 * **迷ったら弾く。** ここで通してよいのは「ふつうの原稿ファイルの名前」
 * だけで、判断に迷う名前を通す利得は無い（作者は展開してから渡せる）。
 */
export function isUnsafeZipEntryName(rawName: string): boolean {
  // ZIPは `/` 区切りと決まっているが、Windowsで作られたものは `\` のことがある
  const name = rawName.replace(/\\/g, "/");
  if (name.trim() === "") return true;
  // 絶対パス（`/etc/passwd`・`C:/Windows/...`）
  if (name.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(name)) return true;
  // 制御文字。**生の制御文字は書かない**ので、コード上はエスケープで置く
  if (/[\u0000-\u001f\u007f]/.test(name)) return true;

  for (const segment of name.split("/")) {
    if (segment === "..") return true;
    // Windowsでは `:` はファイル名に使えない（副ストリームの指定になる）
    if (segment.includes(":")) return true;
  }
  return false;
}

/**
 * ZIPのファイル名から作品名を採る。
 *
 * カクヨムのバックアップは `作品名_20260919.zip` のように、末尾へ
 * 取り出した日を付ける。**日付は作品名ではない**ので落とす。
 */
export function workTitleFromZipFileName(fileName: string): string {
  return workTitleFromBackupFileName(fileName);
}

/**
 * バックアップのファイル名から作品名を採る（ZIPでも `.txt` でも同じ）。
 *
 * **アルファポリスは、ここが唯一の題の出どころである**——ファイルの中に
 * 作品情報の見出しが1つも無い（`alphapolisBackup.ts`）。
 *
 * 落とすもの：
 *
 * - 拡張子（`.zip` / `.txt` / `.md`）
 * - 末尾の日付（カクヨムの `作品名_20260919.zip`）
 * - **末尾の `(2)`**（同じファイルを2度ダウンロードするとブラウザが付ける印。
 *   作者の実物が `… (2).txt` だった）
 */
export function workTitleFromBackupFileName(fileName: string): string {
  const base = fileName
    // 入れ子のフォルダーごと渡されても、最後の名前だけを見る
    .replace(/^.*[/\\]/, "")
    .replace(/\.(zip|txt|md)$/i, "")
    .replace(/[_-]\d{8}$/, "")
    // **半角の丸括弧に入った数字だけを落とす。** 作者が題に付けた
    // 「（上）」「（2）」は全角なので残る——題の一部を削らないための線引き
    .replace(/\s*\(\d{1,3}\)$/, "");
  return sanitizeWorkFolderName(base) || "取り込んだ作品";
}

/**
 * フォルダー名に使えない文字を落とす。
 *
 * **落とすだけで、別の文字へ置き換えない。** `:` を `：` に変えると、
 * 作者の題が黙って書き換わる。落とした結果は入力欄の既定値として
 * 見せるので、直したい人はその場で直せる。
 */
export function sanitizeWorkFolderName(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, "").trim();
}

/** 1件ぶんを読む。**バイト列は、できるだけそのまま持ち回る** */
function readTextEntry(name: string, bytes: Uint8Array): ZipTextFile {
  const decoded = decodeBytes(bytes);
  const fileName = name.replace(/^.*\//, "");
  const isWorkInfo = isWorkInfoFile(fileName, decoded.text);

  return {
    name,
    // **UTF-8のファイルは1バイトも触らない。** Shift_JISのときだけ
    // 書き換える（この拡張機能はUTF-8で読み書きするため）。改行は
    // 元のまま戻す——変換のついでに全行を書き換えたことにしない
    bytes:
      decoded.encoding === "shift_jis"
        ? toUtf8(decoded.text, decoded.eol)
        : bytes,
    encoding: decoded.encoding,
    isWorkInfo,
    // **作品情報は字数に入れない**（`workInfoFile.ts` の理由そのまま）。
    // 数え方は `episodeCharCount.ts` の1つを通す——ここで自前に数えると、
    // 取り込みの画面に出る字数と、登録後の作品一覧の字数が食い違う
    charCount: isWorkInfo
      ? 0
      : countEpisodeChars(decoded.text, {
          ext: extensionOf(name),
          // ルビを外すかは作者の設定（`vscode` が要る）で決まるので、
          // **見積もりのここでは外さない**。多めに出る側へ倒しておく
          excludeRuby: false,
        }).net,
  };
}

/** LFで持っている本文を、元の改行に戻してUTF-8にする */
function toUtf8(text: string, eol: Eol): Uint8Array {
  const restored = eol === "\n" ? text : text.split("\n").join(eol);
  return new TextEncoder().encode(restored);
}

function hasTextExtension(name: string): boolean {
  return TEXT_EXTENSIONS.includes(extensionOf(name));
}

/** 小文字・ドット付きの拡張子（`episodeCharCount.ts` が待っている形） */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * 全部が同じフォルダーの中にあるなら、そのフォルダーを剥がす。
 *
 * ZIPには「作品名フォルダーを丸ごと固めたもの」と「ファイルを直に
 * 並べたもの」の両方がある。剥がさないと、**作品フォルダーの中に
 * 同じ名前のフォルダーがもう1つ**できて、話が1つも見つからなくなる。
 */
function commonRootStripper(names: readonly string[]): (name: string) => string {
  const normalized = names.map((name) => name.replace(/\\/g, "/"));
  const roots = new Set(
    normalized.map((name) => (name.includes("/") ? name.split("/")[0] : ""))
  );
  // 直置きのものが1つでも混ざっていれば、剥がす共通の入れ物は無い
  if (roots.size !== 1 || roots.has("")) {
    return (name) => name.replace(/\\/g, "/");
  }
  const prefix = `${[...roots][0]}/`;
  return (name) => name.replace(/\\/g, "/").slice(prefix.length);
}

/** 一覧は先頭3件まで。全部並べると、肝心の件数まで読んでもらえない */
function summarizeNames(names: readonly string[]): string {
  return (
    names.slice(0, 3).join("、") +
    (names.length > 3 ? ` ほか${names.length - 3}件` : "")
  );
}
