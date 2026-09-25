import { describe, expect, test } from "vitest";
import { buildPastScenes, PastSceneIndex } from "../../../src/core/pastSceneSelect";
import { splitPassages } from "../../../src/core/passages";

/**
 * 矛盾検知の「過去の場面」に、重なった場面が続けて2回渡る（残課題 R8 の後半）。
 *
 * **再現**：場面は400字ずつ、隣と100字重ねて切ってある（`passages.ts`）。
 * 名前が隣り合う2つの場面の両方に出ると、両方が選ばれ、話数の順に並べた
 * ときに**重なりの行が続けて2回**渡っていた（実測：ギルド第10・15・18話、
 * 引継ぎ書 8章 2026-09-25 深夜〈2巡目〉の「8. 小さなこと」）。
 * AIには同じ記述が2回あるように見え、字数の枠も重なりのぶん無駄になる。
 *
 * 隣り合う場面は、重なりを除いて1つの抜粋にまとめる（出典の札も1回）。
 * 同じ文の場面（別の出典に同じ本文がある）も1回だけ渡す。
 */

/** 1行50字ほどの行を並べた、場面が3〜4つに割れる長さの話 */
function longChapter(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 24; i++) {
    lines.push(
      `月島灯は${i}段目の石段を上り、振り返って湖の向こうの灯台を見た。${"風が強い。".repeat(3)}`
    );
  }
  return lines.join("\n");
}

describe("過去の場面：重なった場面を2回渡さない", () => {
  test("前提：この話は隣と重なる場面へ割れる", () => {
    const passages = splitPassages(longChapter());
    expect(passages.length).toBeGreaterThanOrEqual(3);
    // 2つ目の場面の頭の行は、1つ目の場面の終わりにもある（重なり）
    const headOfSecond = passages[1].split("\n")[0];
    expect(passages[0].split("\n").slice(-3)).toContain(headOfSecond);
  });

  test("隣り合う場面が選ばれても、同じ行は1回だけ渡る", () => {
    const index = new PastSceneIndex(
      buildPastScenes([{ label: "第1話 石段", chapter: 1, text: longChapter() }])
    );
    const selected = index.select({ chapter: 5, terms: ["月島灯"], maxChars: 6000 });

    expect(selected).not.toBe("");
    for (let i = 1; i <= 24; i++) {
      const line = `月島灯は${i}段目の石段を上り`;
      const count = selected.split(line).length - 1;
      expect(count, `${i}段目の行が${count}回渡っている`).toBeLessThanOrEqual(1);
    }
    // 続いた場面は1つの抜粋にまとめる（出典の札も1回）
    expect(selected.split("【第1話 石段】").length - 1).toBe(1);
  });

  test("離れた場面は、これまでどおり別の抜粋として渡す", () => {
    const text = longChapter();
    const passages = splitPassages(text);
    // 1つ目と3つ目にだけ出てくる語で引く（2つ目は選ばれない）
    const marked = text
      .split("\n")
      .map((line, at) => (at === 0 ? `${line}白鷺` : line))
      .join("\n");
    const lastLine = marked.split("\n").length - 1;
    const withTail = marked
      .split("\n")
      .map((line, at) => (at === lastLine ? `${line}白鷺` : line))
      .join("\n");
    expect(passages.length).toBeGreaterThanOrEqual(3);
    const index = new PastSceneIndex(
      buildPastScenes([{ label: "第1話 石段", chapter: 1, text: withTail }])
    );
    const selected = index.select({ chapter: 5, terms: ["白鷺"], maxChars: 6000 });

    expect(selected.split("【第1話 石段】").length - 1).toBe(2);
  });

  test("別の出典に同じ本文の場面があっても、1回だけ渡す", () => {
    const text = "月島灯は左腕の古い傷を袖で隠した。\n「見せられるものではない」と月島灯は言った。";
    const index = new PastSceneIndex(
      buildPastScenes([
        { label: "第1話 出会い", chapter: 1, text },
        { label: "第2話 出会い（再掲）", chapter: 2, text },
      ])
    );
    const selected = index.select({ chapter: 5, terms: ["月島灯"], maxChars: 6000 });

    expect(selected.split("左腕の古い傷").length - 1).toBe(1);
  });
});
