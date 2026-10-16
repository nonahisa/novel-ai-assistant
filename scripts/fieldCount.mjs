/**
 * 実機確認の残数・済み・全体・進捗率を数える（2026-10-17）。
 *
 *   node scripts/fieldCount.mjs
 *
 * 済みの項目は引継ぎ書2章へ写して一覧から消す決まりなので、一覧の `- [x]` を
 * 数えるだけでは済みが減って見える。消した数は一覧の冒頭の印に置いてあり、
 * ここではそれを足す：
 *
 *   <!-- field-moved-done: N -->          2026-10-17 から、項目の文のまま2章へ写した数
 *   <!-- field-moved-done-earlier: M -->  それより前に、要約の形で2章へ写した数
 *
 * 数え方は、これまでの報告（1,248／1,369 など）と同じにしてある：
 * `- [ ]`／`- [x]` で始まる行を、字下げした子の行も含めて数える。
 * 〔保留〕（ChatGPT。作者の裁定 2026-10-16）は `- 〔保留〕` の印で、どちらにも入らない。
 *
 * 毎回手で数えると、移した分を足し忘れたり二重に足したりして率がぶれた
 * （10-10 には「移した分 53」を含めて、10-16 には含めずに数えていた）。
 */
import fs from "node:fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIST_PATH = path.join(root, "docs", "実機確認リスト.md");

/** 一覧の冒頭の印を読む。無ければ null（0 と区別する：印を消したことに気づけるように） */
export function readMarker(text, name) {
  const m = new RegExp(`<!--\\s*${name}:\\s*(\\d+)\\s*-->`).exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * 一覧の文から数を出す。
 * @param {string} text 実機確認リストの全文
 */
export function countField(text) {
  const lines = text.split(/\r?\n/);
  const remaining = lines.filter((l) => /^\s*- \[ \]/.test(l)).length;
  const doneInList = lines.filter((l) => /^\s*- \[[xX]\]/.test(l)).length;
  const movedNow = readMarker(text, "field-moved-done");
  const movedEarlier = readMarker(text, "field-moved-done-earlier");
  if (movedNow === null || movedEarlier === null) {
    throw new Error("実機確認リストの冒頭に field-moved-done／field-moved-done-earlier の印がありません");
  }
  const done = doneInList + movedNow + movedEarlier;
  const total = done + remaining;
  // 前の要約の分は項目の数と1対1に突き合わせられないので、除いた率も出す
  // （2026-10-16 までの報告はこちらの数え方）
  const doneWithoutEarlier = doneInList + movedNow;
  const totalWithoutEarlier = doneWithoutEarlier + remaining;
  return {
    remaining,
    doneInList,
    movedNow,
    movedEarlier,
    done,
    total,
    rate: total === 0 ? 0 : (done / total) * 100,
    doneWithoutEarlier,
    totalWithoutEarlier,
    rateWithoutEarlier: totalWithoutEarlier === 0 ? 0 : (doneWithoutEarlier / totalWithoutEarlier) * 100,
  };
}

const n = (v) => v.toLocaleString("ja-JP");
const pct = (v) => `${v.toFixed(2)}%`;

/** 人に見せる1〜3行 */
export function formatCount(c) {
  return [
    `実機確認：残り ${n(c.remaining)}件／済み ${n(c.done)}件／全体 ${n(c.total)}件（進捗率 ${pct(c.rate)}）`,
    `  済みの内訳：一覧の [x] ${n(c.doneInList)}＋引継ぎ書2章へ移した ${n(c.movedNow)}＋それより前に移した ${n(c.movedEarlier)}`,
    `  前に移した分を除くと：${n(c.doneWithoutEarlier)}／${n(c.totalWithoutEarlier)}（${pct(c.rateWithoutEarlier)}。2026-10-16 までの報告と同じ数え方）`,
  ].join("\n");
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.stdout.write(formatCount(countField(fs.readFileSync(LIST_PATH, "utf-8"))) + "\n");
}
