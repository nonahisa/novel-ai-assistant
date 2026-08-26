/**
 * 畳んだあとに、触られていないはずのものが触られていないか確かめる（設計書5.5.16）。
 *
 * **改行コードの自動変換（`core.autocrlf`）が効く経路である。** gitが書き戻す
 * ついでに原稿の改行が変わっても、**開いて見ただけでは気づけない。**
 * 「原稿の改行を1バイトも変えない」という決まり（5.4）を、目ではなく機械で守る。
 *
 * ここは純粋関数だけを置く。読み込みとハッシュの計算は呼び出し側で行う
 * （ブラウザ版でも同じ判定が使えるようにするため。5.8）。
 */

/** 競合マーカーの検出。`textFile.ts` と同じ形を使う */
const CONFLICT_PATTERN = /^(<{7}|={7}|>{7})(\s|$)/m;

export function containsConflictMarkers(text: string): boolean {
  return CONFLICT_PATTERN.test(text);
}

/**
 * 指紋を見比べて、**変わるはずのなかったもの**を返す。
 *
 * @param before 畳む前の指紋（ファイル → ハッシュ）
 * @param after  畳んだあとの指紋
 * @param expected 変わってよいファイル（取り込みで入ってきたもの）
 *
 * 消えたファイルも「変わった」に数える。**取り込みで原稿が消えるのは、
 * 中身が変わるより重い。**
 */
export function unexpectedChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  expected: Iterable<string>
): string[] {
  const allowed = new Set([...expected].map(normalize));
  const changed: string[] = [];

  for (const [file, hash] of before) {
    if (allowed.has(normalize(file))) continue;
    const now = after.get(file);
    if (now !== hash) changed.push(file);
  }
  return changed.sort();
}

/**
 * 検査の結果。**どれか1つでも落ちたら畳むのをやめる**ので、
 * 「何が落ちたか」を分けて持つ。
 */
export interface MergeGuardResult {
  ok: boolean;
  /** 競合マーカーが残っていたファイル */
  markers: string[];
  /** 変わるはずのなかったファイル */
  unexpected: string[];
}

export function guardResult(
  markers: string[],
  unexpected: string[]
): MergeGuardResult {
  return { ok: markers.length === 0 && unexpected.length === 0, markers, unexpected };
}

/** 検査に落ちた理由を、作者に読める形で書く */
export function describeGuardFailure(result: MergeGuardResult): string {
  const parts: string[] = [];
  if (result.markers.length > 0) {
    parts.push(
      `競合マーカーが残っていました（${result.markers.length}件）：` +
        result.markers.slice(0, 3).join("、")
    );
  }
  if (result.unexpected.length > 0) {
    parts.push(
      `取り込んでいないはずのファイルが変わっていました（${result.unexpected.length}件）：` +
        result.unexpected.slice(0, 3).join("、")
    );
  }
  return parts.join("\n");
}

function normalize(filePath: string): string {
  // gitは / で返し、こちらは端末の区切りで持つことがある。
  // 大文字小文字はWindowsでは同じものを指すので、そこまで揃える
  return filePath.replace(/[\u005C]/g, "/").toLowerCase();
}
