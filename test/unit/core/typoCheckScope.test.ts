import { describe, expect, test } from "vitest";
import {
  TRIAL_EPISODE_COUNT,
  changedSince,
  describeScope,
  describeScopeWithoutLastCheck,
  firstEpisodes,
  scopeKinds,
  shouldAskScope,
} from "../../../src/core/typoCheckScope";

/**
 * 誤字脱字の「差分のみ」（設計書6.8.7）。
 *
 * **キャッシュがあるので、全体を選んでもAIは呼び直さない。**
 * それでも絞りたいのは、219話の作品で一覧が長くなるのと、
 * AIを呼ばなくても全話の読み込みと分割に時間がかかるためである。
 *
 * **gitではなく更新時刻で見る。** Gitを使わずに書いている作品では、
 * gitで見ると絞り込みが一切できなくなる。
 */
const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

function file(name: string, modifiedAt: number | undefined) {
  return { filePath: `C:/works/x/${name}`, modifiedAt };
}

describe("前回より後に書いたものを選ぶ", () => {
  test("新しいものだけを返す", () => {
    const changed = changedSince(
      [
        file("1.txt", NOW - HOUR),
        file("2.txt", NOW + HOUR),
        file("3.txt", NOW + 2 * HOUR),
      ],
      NOW
    );

    expect(changed).toEqual(["C:/works/x/2.txt", "C:/works/x/3.txt"]);
  });

  test("同じ時刻は「新しい」と見なさない", () => {
    expect(changedSince([file("1.txt", NOW)], NOW)).toEqual([]);
  });

  test("**時刻が読めないものは含める**", () => {
    // 取りこぼして誤字が残るより、1話ぶん余計に見るほうがよい
    expect(changedSince([file("1.txt", undefined)], NOW)).toHaveLength(1);
  });

  test("一度も検知していなければ、全部が対象", () => {
    const all = changedSince(
      [file("1.txt", NOW - HOUR), file("2.txt", NOW)],
      undefined
    );

    expect(all).toHaveLength(2);
  });
});

describe("**聞く意味があるときだけ聞く**", () => {
  test("一度も検知していなければ聞かない", () => {
    // 差分が決められない
    expect(shouldAskScope(10, 10, undefined)).toBe(false);
  });

  test("全部が対象なら聞かない", () => {
    // 選んでも結果が変わらない
    expect(shouldAskScope(10, 10, NOW)).toBe(false);
  });

  test("1件も無ければ聞かない", () => {
    // 呼び出し側が「新しく書いた話はありません」と伝える
    expect(shouldAskScope(10, 0, NOW)).toBe(false);
  });

  test("一部だけなら聞く", () => {
    expect(shouldAskScope(10, 3, NOW)).toBe(true);
  });

  test("話が1つも無い作品では聞かない", () => {
    expect(shouldAskScope(0, 0, NOW)).toBe(false);
  });
});

describe("作者への説明", () => {
  test("どれだけ減るのかを数で示す", () => {
    const message = describeScope(219, 3);

    expect(message).toContain("3 話");
    expect(message).toContain("219 話");
  });

  test("一度も検知していないときは「前回から」を持ち出さない", () => {
    // 前に走らせた覚えが無いのにその言葉が出ると、
    // 作者は「記録が消えたのか」と読む
    const message = describeScopeWithoutLastCheck(219);

    expect(message).toContain("219 話");
    expect(message).not.toContain("前回");
  });
});

/**
 * **「はじめの10話だけ試す」**（作者の依頼、2026-09-20）。
 *
 * モデルを替えて比べたい時期に、比べるたび全話へ賭けるのでは試せない。
 * 219話の矛盾検知は6時間規模なので、1回の比較に6時間かかることになる。
 */
describe("試しに、はじめの何話かだけ見る", () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    file(`${i + 1}.txt`, NOW)
  );

  test("先頭から数えて、決めた話数だけを返す", () => {
    const picked = firstEpisodes(many);

    expect(picked).toHaveLength(TRIAL_EPISODE_COUNT);
    expect(picked[0]).toContain("1.txt");
    expect(picked[TRIAL_EPISODE_COUNT - 1]).toContain("10.txt");
  });

  test("話数より多く求められても、あるだけ返す", () => {
    expect(firstEpisodes([file("1.txt", NOW)])).toHaveLength(1);
  });
});

describe("出す選択肢を決める", () => {
  test("**一度も検知していなくても、「試す」は出る**", () => {
    // ここが出ないと、初めて使う作品では全話へ賭けるしかない
    expect(scopeKinds(20, 20, undefined)).toEqual(["first", "all"]);
  });

  test("話数が「試す話数」ちょうどなら出さない（全体と同じものになる）", () => {
    expect(scopeKinds(TRIAL_EPISODE_COUNT, 10, undefined)).toEqual(["all"]);
  });

  test("差分と試すの両方が出せるときは、差分を先に置く", () => {
    expect(scopeKinds(20, 3, NOW)).toEqual(["changed", "first", "all"]);
  });

  test("**全体はいつでも選べる**（絞る道しか無い状態を作らない）", () => {
    for (const kinds of [
      scopeKinds(0, 0, NOW),
      scopeKinds(20, 3, NOW),
      scopeKinds(20, 20, undefined),
    ]) {
      expect(kinds).toContain("all");
    }
  });

  test("短い作品で一度も検知していなければ、聞かない", () => {
    expect(shouldAskScope(5, 5, undefined)).toBe(false);
  });

  test("長い作品なら、差分が無くても聞く（試せるので）", () => {
    expect(shouldAskScope(20, 20, undefined)).toBe(true);
  });
});
