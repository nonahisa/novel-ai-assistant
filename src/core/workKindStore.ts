import type { WorkEntry } from "../models/types";
import { readWorkConfig, writeWorkConfig } from "./workRegistry";
import { readWorkFormat } from "./workFormatStore";
import { resolveWorkKind, type WorkKindKey } from "./workKind";

/**
 * 作品の種類を読む・書く（設計書6.109）。
 *
 * **在り処は作品の設定（`.aiwriter/config.json` の `kind`）ひとつ。**
 * 形式（長さ）はプロットの `## 形式` にあるが、種類はそこへ置かない：
 *
 * - 種類が決めるのは雛形・数え方・組み方・出力で、**機械が読んで使う設定**
 *   である。物語の中身を書く文書（プロット）に混ぜる理由が無い
 * - プロットの無い作品が多い（本文から書き始めた作品・取り込んだ作品）。
 *   設定ファイルは登録した作品なら必ずある
 * - プロットの見出しを増やすと、逆算（P-02）やプロットモードの目次に
 *   新しい節が現れる。種類はそちらへ出すものではない
 *
 * 形式が「脚本」の作品（種類の軸ができる前の作り方）は、設定に何も
 * 書かれていなくても台本として読む（`resolveWorkKind`）。
 */

/**
 * 設定ファイルに書かれた種類を覚えておく（書かれていなければ null）。
 *
 * **覚えるのは設定ファイルの分だけ。** 形式からの読み替え（「脚本」→台本）は
 * 毎回 `readWorkFormat` に訊く——あちらはプロットが保存されるたびに
 * 覚え直すので、ここで答えごと覚えると、形式を書き換えても古い種類が残る。
 */
const configured = new Map<string, WorkKindKey | null>();

/**
 * 作品の種類。**読めなければ小説**（これまでどおりの振る舞い）。
 *
 * 設定ファイルが壊れていても、種類のせいで作品が開けなくなっては困る。
 */
export async function readWorkKind(work: WorkEntry): Promise<WorkKindKey> {
  const written = await readConfiguredWorkKind(work);
  if (written) return written;
  let format;
  try {
    format = await readWorkFormat(work);
  } catch {
    format = undefined;
  }
  return resolveWorkKind(undefined, format);
}

/**
 * 設定ファイルに書かれている種類だけ（形式からの読み替えをしない）。
 * 無い・読めなければ undefined。
 */
export async function readConfiguredWorkKind(
  work: WorkEntry
): Promise<WorkKindKey | undefined> {
  if (configured.has(work.id)) return configured.get(work.id) ?? undefined;
  let kind: WorkKindKey | undefined;
  try {
    kind = (await readWorkConfig(work))?.kind;
  } catch {
    kind = undefined;
  }
  configured.set(work.id, kind ?? null);
  return kind;
}

/**
 * 設定ファイルそのものが無い（壊れているのとは別）。
 *
 * **呼び手が見分けて、次の手を添えられるように型を分ける**（2026-09-24）。
 * 壊れているなら直すのは作者の手（規則2）だが、無いなら登録し直せば
 * 作られる（`addExisting` は設定ファイルが無ければ作る）。同じ `Error` で
 * 投げると、画面には原因しか出せない。
 */
export class WorkConfigMissingError extends Error {
  constructor() {
    super("作品の設定ファイル（.aiwriter/config.json）が見つかりません。");
    this.name = "WorkConfigMissingError";
  }
}

/**
 * 種類を書く。**本文には触れない**（種類を変えても、変わるのは雛形・
 * 数え方・組み方・出力だけ。書いたものは1字も書き換えない）。
 *
 * 設定ファイルが無い作品では `WorkConfigMissingError` を、壊れている作品では
 * 読み込みの失敗をそのまま投げる——壊れたJSONは直さず止める（規則2）。
 */
export async function writeWorkKind(
  work: WorkEntry,
  kind: WorkKindKey
): Promise<void> {
  const config = await readWorkConfig(work);
  if (!config) {
    throw new WorkConfigMissingError();
  }
  await writeWorkConfig(work, { ...config, kind });
  invalidateWorkKind(work.id);
}

/** 設定を書き換えたときに呼ぶ */
export function invalidateWorkKind(workId?: string): void {
  if (workId) {
    configured.delete(workId);
  } else {
    configured.clear();
  }
}
