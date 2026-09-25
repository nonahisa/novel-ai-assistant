import type { WorkEntry } from "../models/types";
import type { NameOrigin } from "../prompts/nameSuggest";
import { parseNameOrigin } from "./nameOriginFit";
import { readWorkConfig, writeWorkConfig } from "./workRegistry";

/**
 * 作品の名前の系統を覚える・読む（設計書6.37.2。作者の裁定、2026-09-25 昼）。
 *
 * **在り処は作品の設定（`.aiwriter/config.json` の `nameOrigin`）。**
 *
 * - 系統は**作品の性格**である（ギルドの作品はドイツ風、のように）。
 *   作品と一緒に同期してよく、むしろ別の機械で名前を付けたときも同じ系統で
 *   揃ってほしい。`.aiwriter/cache/`（同期しない）には置かない
 * - 設定資料（`設定/`）には置かない。資料は作者が読む物語の中身で、
 *   系統は機械が名前の候補を揃えるための設定である（作品の種類 `kind` と同じ判断）
 * - 書くときは `writeWorkConfig` を通す——読んだままの改行の形
 *   （`jsonFileFormat.ts`）で書き戻すので、1項目の追記で全行が差分にならない
 *
 * **読めなくても名前の候補は止めない**（覚えていないのと同じに扱う）。
 * 設定ファイルが壊れていれば書かない——壊れたJSONは直さず止める（規則2）。
 */

/** 覚えている系統。無い・読めなければ undefined */
export async function readRememberedNameOrigin(
  work: WorkEntry
): Promise<NameOrigin | undefined> {
  try {
    return parseNameOrigin((await readWorkConfig(work))?.nameOrigin);
  } catch {
    return undefined;
  }
}

/** 覚えた結果。書けなかった理由は、呼び手がログへ残す */
export type RememberNameOriginResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "failed"; detail?: string };

/**
 * 系統を覚える。**本文にも設定資料にも触れない**（設定ファイルの1項目だけ）。
 */
export async function rememberNameOrigin(
  work: WorkEntry,
  origin: NameOrigin
): Promise<RememberNameOriginResult> {
  try {
    const config = await readWorkConfig(work);
    if (!config) return { ok: false, reason: "missing" };
    if (parseNameOrigin(config.nameOrigin) === origin) return { ok: true };
    await writeWorkConfig(work, { ...config, nameOrigin: origin });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
