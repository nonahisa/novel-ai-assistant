import iconv = require("iconv-lite");
import { decodeBytes, type Encoding } from "./textDecode";

/**
 * Shift_JIS の原稿を UTF-8 にする**バイト列の作り方**（設計書5.4.2、0.149.0）。`vscode` に触らない。
 *
 * ## 生のバイトを復号して、そのまま UTF-8 にする
 *
 * 本文の書き戻し（`textEncodePreserving.ts`）は「変わった所だけ置き換える」が、文字コードを
 * 変えるときは**全部の字の符号が変わる**ので、その作りは使えない（元バイトを置く所が無い）。
 * そこで、改行を LF に揃える前の生の本文を復号し、そのまま UTF-8 に符号化する。
 * 改行のバイト（CRLF・LF・CR。混在も）と末尾の改行の有無は ASCII で、どちらの符号でも
 * 同じバイトなので**1つも変わらない**。LF に揃えた本文と `eol` から組み直すと、混在が潰れる
 * （`workZip.ts` の `toUtf8` はそちらの形なので、ここでは使わない）。
 *
 * ## 読めないバイトがある話は変えない
 *
 * 製品の読み方（`decodeBytes`）は、壊れたバイトを U+FFFD にして読み進める。そのまま UTF-8 に
 * すると、壊れた所が U+FFFD の字として**本当に原稿へ焼き付く**。次のどれかなら変えない：
 *
 * - ブラウザの読み方（`TextDecoder("shift_jis", { fatal: true })`）で読めない
 * - 読んだ本文に U+FFFD がある
 * - VS Code 自身の読み方（iconv-lite。VS Code が Shift_JIS の文書を開くときの系統）と読み方が割れる
 *   （全符号で数えると、割れるのは制御の3バイト 0x1A・0x1C・0x7F と外字の領域だけ。Node の
 *   TextDecoder は古い DOS のファイルの終わりの 0x1A を U+001C と読む。2026-11-12）
 *
 * バイトの往復（UTF-8 にした本文を Shift_JIS へ戻して元と比べる）では確かめない。CP932 には
 * 同じ字の符号が2つある字（NEC 選定 IBM 拡張と IBM 拡張）があり、正しい原稿まで飛ばすため。
 *
 * UTF-8 として読めないものは全部 Shift_JIS と判定する作りなので、EUC-JP などの別の文字コードは
 * 見分けられない（読めてしまえば変える）。控え（`.novelai-recovery`）に元のバイトが残る。
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

export type Utf8ConversionSkip = "not_shift_jis" | "undecodable" | "conflict_markers";

export type Utf8ConversionPlan =
  | { kind: "convert"; bytes: Uint8Array }
  | { kind: "skip"; reason: Utf8ConversionSkip };

export function planUtf8Conversion(
  bytes: Uint8Array,
  options: { bom: boolean }
): Utf8ConversionPlan {
  const read = decodeBytes(bytes);
  if (read.encoding !== "shift_jis") return { kind: "skip", reason: "not_shift_jis" };
  if (read.hasConflictMarkers) return { kind: "skip", reason: "conflict_markers" };
  const raw = decodeShiftJisStrictly(bytes);
  if (raw === undefined) return { kind: "skip", reason: "undecodable" };

  const body = new TextEncoder().encode(raw);
  if (!options.bom) return { kind: "convert", bytes: body };
  const withBom = new Uint8Array(UTF8_BOM.length + body.length);
  withBom.set(UTF8_BOM);
  withBom.set(body, UTF8_BOM.length);
  return { kind: "convert", bytes: withBom };
}

/** 2つの読み方がそろって読めたときだけ、その本文（改行は生のまま）。読めなければ undefined */
function decodeShiftJisStrictly(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (text.includes("�")) return undefined;
  // `Buffer` は使わない（ブラウザ版に無い）。書き戻し（`textEncodePreserving.ts`）と同じく、そのまま渡す
  if (iconv.decode(bytes, "shift_jis") !== text) return undefined;
  return text;
}

/**
 * BOM を付けるか。
 *
 * - 設定 `files.encoding`（その話に効く値）が `shiftjis` なら**付ける**。BOM が無い UTF-8 は、
 *   VS Code がこの設定で Shift_JIS と読み、化けた本文を開く。化けたまま打って保存すると、
 *   保存の受け口（`shiftJisSave.ts`）が「Shift_JIS の文書」として扱い、原稿が壊れる。
 *   BOM があれば VS Code は設定によらず UTF-8 と読む。作品の設定（`.vscode/settings.json`）は
 *   作者のものなので書き換えない（確かめの窓で知らせる）
 * - それ以外は、作品のほかの UTF-8 の話の多いほうに合わせる（同数なら付けない）
 * - ほかに UTF-8 の話が無ければ付けない
 */
export function chooseUtf8Bom(
  otherEncodings: readonly Encoding[],
  configuredEncoding: string | undefined
): { bom: boolean; reason: "setting_shiftjis" | "match_others" | "no_others" } {
  if (configuredEncoding === "shiftjis") return { bom: true, reason: "setting_shiftjis" };
  const withBom = otherEncodings.filter((encoding) => encoding === "utf8-bom").length;
  const withoutBom = otherEncodings.filter((encoding) => encoding === "utf8").length;
  if (withBom + withoutBom === 0) return { bom: false, reason: "no_others" };
  return { bom: withBom > withoutBom, reason: "match_others" };
}
