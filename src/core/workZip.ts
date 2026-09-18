import { unzipSync } from "fflate";
import { countEpisodeChars } from "./episodeCharCount";
import { decodeBytes, type Encoding } from "./textDecode";
import { isWorkInfoFile } from "./workInfoFile";
import { parseWorkInfo, type WorkInfo } from "./workInfoParse";
import type { Eol } from "../models/types";

/**
 * ZIPの中を確かめて、作品として取り込める形にする（設計書6.99）。
 *
 * 投稿サイトのバックアップは ZIP で降ってくる。作者の言葉（2026-09-19）：
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
  /** 話として数えたファイル数 */
  readonly episodeCount: number;
  /** 合計の純文字数 */
  readonly totalChars: number;
  /** 入れなかったファイルの名前（画像など） */
  readonly skipped: readonly string[];
  /** `about.txt` から読み取った作品情報。無ければ null */
  readonly info: WorkInfo | null;
  /** 採った作品名 */
  readonly title: string;
  /** 題をどこから採ったか。作者への説明に使う */
  readonly titleSource: "about" | "zipName";
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

  const aboutFile = files.find((file) => file.isWorkInfo);
  const info = aboutFile
    ? parseWorkInfo(decodeBytes(aboutFile.bytes).text)
    : null;

  const fromAbout = info?.title ? sanitizeWorkFolderName(info.title) : "";
  const title = fromAbout || workTitleFromZipFileName(zipFileName);

  // **並べ替える。** ZIPは書き込んだ順で入っているので、そのまま出すと
  // 確認の画面に並ぶ順が作者の見慣れた話順にならない
  files.sort((a, b) => a.name.localeCompare(b.name, "ja"));

  return {
    files,
    episodeCount: files.filter((file) => !file.isWorkInfo).length,
    totalChars: files.reduce((total, file) => total + file.charCount, 0),
    skipped,
    info,
    title,
    titleSource: fromAbout ? "about" : "zipName",
  };
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
  const base = fileName
    .replace(/\.zip$/i, "")
    // 入れ子のフォルダーごと渡されても、最後の名前だけを見る
    .replace(/^.*[/\\]/, "")
    .replace(/[_-]\d{8}$/, "");
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
