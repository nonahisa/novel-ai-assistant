/**
 * 別名ごとの読み（設計書6.42.2。作者の指示、2026-10-24）。
 *
 * 設定資料の `reading` は**名前の読み**なので、別名（「姫」）には当てられない。
 * 別名の読みはこれまでIMEの控え（`.aiwriter/imeReadings.json`）にしか無く、控えは
 * PCごと（同期しない）なので、別のPCの読み上げでは効かなかった。そこで設定資料に
 * 別名ごとの読みを持たせる。設定資料は同期するので、どのPCでも同じ読みで読む。
 *
 * ## 作者のデータとして扱う
 *
 * AIの抽出・マージはこの欄を書かない・消さない（CLAUDE.md 実装ルール2）。
 * 書くのは作者（設定資料パネル）と、IMEで打った読み（AIが作った項目で、
 * その別名の読みが空のときだけ。名前の `reading` と同じ裁定）だけ。
 *
 * ## 別名と一緒に動く
 *
 * 鍵は別名の表記そのまま。**別名から消えた鍵は読みも消す**（`pruneAliasReadings`）。
 * 残すと、作者が消したはずの別名の読みがファイルに残り続け、同じ表記を別の
 * 項目へ足したときに、どこから来たか分からない読みが付いて見える。
 *
 * ## 無いときは欄ごと持たない
 *
 * `{}` を毎回書くと、同期している全部のファイルに中身の変わらない差分が出る
 * （場所の `relations`、追加項目の `customFields` と同じ形）。
 */

export type AliasReadings = Record<string, string>;

function invalid(path: string): never {
  throw new Error(`${path} の形式が正しくありません。`);
}

/**
 * 作者が編集できるJSONの `aliasReadings` を検証する。**壊れていれば投げる**
 * （直さずに止める。CLAUDE.md 実装ルール2）。無ければ undefined。
 *
 * 値が空の文字列のものは「読みなし」とみて落とす（投げない）——画面で欄を
 * 空にしたのと同じ意味で、壊れた形ではない
 */
export function parseOptionalAliasReadings(
  value: unknown,
  path = "aliasReadings"
): AliasReadings | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(path);
  const out: AliasReadings = {};
  for (const [key, reading] of Object.entries(value as Record<string, unknown>)) {
    if (typeof reading !== "string") invalid(`${path}.${key}`);
    const alias = key.trim();
    const text = reading.trim();
    if (alias && text) out[alias] = text;
  }
  return out;
}

/**
 * いまの別名に無い鍵を落とした写し。名前と同じ鍵も落とす（名前の読みは `reading`）。
 * 比べるのは前後の空白を外した表記（別名の扱いと同じ）
 */
export function pruneAliasReadings(
  readings: Readonly<AliasReadings> | undefined,
  name: string,
  aliases: readonly string[]
): AliasReadings {
  const out: AliasReadings = {};
  if (!readings) return out;
  const own = name.trim();
  const known = new Set(aliases.map((alias) => alias.trim()).filter(Boolean));
  for (const [key, reading] of Object.entries(readings)) {
    const alias = key.trim();
    const text = typeof reading === "string" ? reading.trim() : "";
    if (!alias || !text || alias === own || !known.has(alias)) continue;
    out[alias] = text;
  }
  return out;
}

/**
 * 別名の読みを入れる。**いまの別名に合わせて刈り込み、空なら欄ごと外す**。
 *
 * `readings` は必ず渡す（undefined は「読みなし」）。レコードがいま持っている
 * 読みを刈り込むだけなら `record.aliasReadings` を渡す。省いたら自分の読みを
 * 使う形にしないのは、「読みなし」のつもりで undefined を渡した呼び手が、
 * 写しの側の読みを黙って残してしまうため（承認待ちの案の写しで実際に起きかけた）
 */
export function withOptionalAliasReadings<
  T extends { name: string; aliases: string[]; aliasReadings?: AliasReadings },
>(record: T, readings: Readonly<AliasReadings> | undefined): T {
  const copy = { ...record };
  const pruned = pruneAliasReadings(readings, record.name, record.aliases);
  if (Object.keys(pruned).length > 0) copy.aliasReadings = pruned;
  else delete copy.aliasReadings;
  return copy;
}

/** 別名の読みを引く（無ければ null）。鍵は前後の空白を外して比べる */
export function aliasReadingOf(
  record: { aliasReadings?: Readonly<AliasReadings> },
  alias: string
): string | null {
  const readings = record.aliasReadings;
  if (!readings) return null;
  const key = alias.trim();
  const direct = readings[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const [entry, reading] of Object.entries(readings)) {
    if (entry.trim() === key && reading.trim()) return reading.trim();
  }
  return null;
}
