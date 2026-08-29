/**
 * 「いつ作ったか」で名前が決まるファイルの、名前の候補を並べる。
 *
 * **既存ファイルは上書きできない**（`atomicWrite.ts` の設計）。同じ分に
 * 2回書き出すと名前がぶつかるので、秒 → 連番の順に別名を用意する。
 * 名前を作るところと、実在を確かめるところを分けてあるのは、
 * ここだけを単体テストできるようにするため（実在の確認には
 * VS Code API が要る）。
 *
 * 相談メモ（`chatNote.ts`）と印刷用HTML（`printHtml.ts` を書き出す
 * `features/exportPdf.ts`）、そして生成文書（`generatedFiles.ts`）が
 * 同じ規則を要る。**2か所に書くと、片方だけ直したときに
 * 「こちらは秒まで、あちらは分まで」というずれが静かに残る。**
 *
 * VS Code API に依存しない。
 */

/** 同名を避けるために試す名前の数。これを超えることは実際には起きない */
export const TIMESTAMPED_NAME_TRIES = 20;

/** 区切りの既定。作者が名前を読む文書（相談メモ・印刷用）は空白のほうが読みやすい */
const DEFAULT_SEPARATOR = " ";

/**
 * 試す順に名前を並べる。
 *
 * @param prefix 名前の頭に置く言葉（「相談」「印刷用」）
 * @param at 作った時刻
 * @param extension 拡張子（`.md` のように点から書く）
 * @param separator 頭の言葉・日付・時刻をつなぐ字。生成文書（`generatedFiles.ts`）
 *   だけは `_` を使う。**種類の切れ目を機械が見分けるため**——古いものを
 *   消すときに「この種類のものだけ」を前置きで拾うので、境目がはっきり
 *   していないと別の種類を巻き込みかねない
 */
export function timestampedFileNameCandidates(
  prefix: string,
  at: Date,
  extension: string,
  tries: number = TIMESTAMPED_NAME_TRIES,
  separator: string = DEFAULT_SEPARATOR
): string[] {
  const day = formatDayStamp(at);
  const minute = `${pad2(at.getHours())}${pad2(at.getMinutes())}`;
  const second = `${minute}${pad2(at.getSeconds())}`;

  const names = [
    `${prefix}${separator}${day}${separator}${minute}${extension}`,
    `${prefix}${separator}${day}${separator}${second}${extension}`,
  ];
  for (let n = 2; names.length < Math.max(tries, 1); n += 1) {
    names.push(
      `${prefix}${separator}${day}${separator}${second}-${n}${extension}`
    );
  }
  return names.slice(0, Math.max(tries, 1));
}

/** 「2026-08-28」 */
export function formatDayStamp(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/** 「2026-08-28 02:49」。文書の中に書く、人が読むための時刻 */
export function formatDayTime(at: Date): string {
  return `${formatDayStamp(at)} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
