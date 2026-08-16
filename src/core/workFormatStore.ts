import type { WorkEntry } from "../models/types";
import { parsePlotMarkdown } from "./plotDoc";
import { readPlotText } from "./plotFile";
import { WORK_FORMATS, type WorkFormatKey } from "./workFormat";

/**
 * 作品の形式を読む（設計書6.4.5）。
 *
 * **在り処はプロット（`設定/plot.md` の `## 形式`）ひとつ。**
 * `.aiwriter/config.json` にも持たせると、作者がプロットを書き換えたときに
 * 二重管理になり、どちらが本当か分からなくなる。プロットは作者の文書で、
 * **作者が書いたものが正しい。**
 *
 * 形式が書かれていない作品は `undefined` を返す。
 * **そのときは今までどおりに振る舞う**（長編を既定にしない。
 * 「決めていない」と「長編と決めた」は違う）。
 */

/**
 * 読んだ結果を覚えておく。
 *
 * 作品一覧は話数ごとに見出しを作るので、毎回プロットを読むと
 * 1回の描画でファイルを何十回も読むことになる。
 */
const cache = new Map<string, WorkFormatKey | undefined>();

export async function readWorkFormat(
  work: WorkEntry
): Promise<WorkFormatKey | undefined> {
  if (cache.has(work.id)) return cache.get(work.id);

  let found: WorkFormatKey | undefined;
  try {
    const sections = parsePlotMarkdown(await readPlotText(work)).sections;
    found = matchWorkFormat(sections.format);
  } catch {
    // プロットが読めなくても執筆は続けられる。形式は「決めていない」扱い
    found = undefined;
  }

  cache.set(work.id, found);
  return found;
}

/** プロットが保存されたときなどに呼ぶ */
export function invalidateWorkFormat(workId?: string): void {
  if (workId) {
    cache.delete(workId);
  } else {
    cache.clear();
  }
}

/**
 * `## 形式` に書かれた文字列から形式を決める。
 *
 * **完全一致では拾えない。** 作者は「長編（連載中）」のように
 * 但し書きを添えて書く。選択肢から選んだ場合は完全一致になるが、
 * 手で書いた場合に読めないのでは、自由に書ける文書にした意味がない。
 *
 * **長いほうから照合する。** 「長編」で先に当てると「大長編」が
 * 拾えない。同じ理由で「短編」と「短編集」も順序が効く。
 */
export function matchWorkFormat(text: string): WorkFormatKey | undefined {
  const body = text.trim();
  if (!body) return undefined;

  const byLength = [...WORK_FORMATS].sort(
    (left, right) => right.label.length - left.label.length
  );
  return byLength.find((format) => body.includes(format.label))?.key;
}
