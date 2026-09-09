import { describe, expect, test } from "vitest";
import {
  anyPastSceneReachable,
  buildPastScenes,
  pastSceneMaxChars,
  promptVersionWithPastScenes,
  PastSceneIndex,
  PAST_SCENE_MAX_CHARS,
} from "../../src/core/pastSceneSelect";
import type { ExcerptSource } from "../../src/core/mentionExcerpts";

/**
 * 矛盾検知へ渡す「過去の関連場面」の選抜（設計書6.74）。
 *
 * ここで守りたいのは2つ。
 *
 * - **後の話を渡さない。** 渡すと「あとで判明する事実」との整合が崩れ、
 *   誤検知の種になる（futureFacts の扱いと同じ理屈）
 * - **関連が無ければ渡さない。** 世界観（`worldviewSelect`）と違って、
 *   無関係な本文はノイズにしかならない。空にしない工夫はしない
 */

function source(
  label: string,
  chapter: number | null,
  text: string
): ExcerptSource {
  return { label, chapter, text };
}

/** 第1〜4話ぶんの短い本文。名前で引き分けられるように書き分けてある */
function scenes(): PastSceneIndex {
  return new PastSceneIndex(
    buildPastScenes([
      source(
        "第1話 出会い",
        1,
        "月島灯は左腕の古い傷を袖で隠した。\n「見せられるものではない」と月島灯は言った。"
      ),
      source(
        "第2話 湖畔",
        2,
        "白鷺湖のほとりで舟を借りた。\n白鷺湖の水は冷たく、指先がすぐにかじかんだ。"
      ),
      source(
        "第3話 再会",
        3,
        "月島灯はふたたび白鷺湖へ来た。\n月島灯の左腕の傷は、まだ癒えていなかった。"
      ),
      source(
        "第9話 決着",
        9,
        "月島灯は右腕を吊っていた。\n月島灯はそれ以上なにも語らなかった。"
      ),
      source("番外編", null, "月島灯の子供のころの話である。"),
    ])
  );
}

describe("過去の場面を集める", () => {
  test("話数の読めない出典は、場面にしない", () => {
    // 前後を決められないものを渡すと、後の話を前の話へ混ぜかねない
    const built = buildPastScenes([
      source("第1話", 1, "本文です。"),
      source("番外編", null, "本文です。"),
      source("あとがき", undefined, "本文です。"),
    ]);

    expect(built.map((scene) => scene.chapter)).toEqual([1]);
  });

  test("1つの話を、場面の単位へ割る", () => {
    // 1件が長すぎると、上限のほとんどを1場面が食う
    const built = buildPastScenes([
      source("第1話", 1, Array.from({ length: 40 }, () => "あ".repeat(30)).join("\n")),
    ]);

    expect(built.length).toBeGreaterThan(1);
    expect(new Set(built.map((scene) => scene.id)).size).toBe(built.length);
  });
});

describe("選び方", () => {
  test("いま調べている話より前だけを渡す", () => {
    const selected = scenes().select({
      chapter: 3,
      terms: ["月島灯"],
      maxChars: 4000,
    });

    expect(selected).toContain("第1話 出会い");
    // 同じ話（第3話）も、後の話（第9話）も渡さない
    expect(selected).not.toContain("第3話 再会");
    expect(selected).not.toContain("第9話 決着");
  });

  test("名前で当たる。関係のない場面は入れない", () => {
    const selected = scenes().select({
      chapter: 9,
      terms: ["白鷺湖"],
      maxChars: 4000,
    });

    expect(selected).toContain("第2話 湖畔");
    // 「白鷺湖」を含まない第1話は出さない
    expect(selected).not.toContain("第1話 出会い");
  });

  test("出典を添える", () => {
    const selected = scenes().select({
      chapter: 3,
      terms: ["月島灯"],
      maxChars: 4000,
    });

    expect(selected).toContain("【第1話 出会い】");
    expect(selected).toContain("左腕の古い傷");
  });

  test("上限で切る", () => {
    const wide = scenes().select({
      chapter: 9,
      terms: ["月島灯", "白鷺湖"],
      maxChars: 4000,
    });
    const narrow = scenes().select({
      chapter: 9,
      terms: ["月島灯", "白鷺湖"],
      maxChars: 60,
    });

    expect(narrow.length).toBeLessThanOrEqual(60);
    expect(narrow.length).toBeLessThan(wide.length);
  });

  test("件数の上限で切る", () => {
    const selected = scenes().select({
      chapter: 9,
      terms: ["月島灯"],
      maxChars: 100000,
      maxScenes: 1,
    });

    expect(selected.split("【").length - 1).toBe(1);
  });

  test("名前が1つも無いチャンクでは、何も渡さない", () => {
    // 従来と同じ入力に戻る（欄ごと出さない）
    expect(scenes().select({ chapter: 9, terms: [], maxChars: 4000 })).toBe("");
  });

  test("どの場面にも当たらなければ、空にする", () => {
    // 無関係な本文を足すくらいなら、渡さないほうがよい
    expect(
      scenes().select({ chapter: 9, terms: ["常世神社"], maxChars: 4000 })
    ).toBe("");
  });

  test("話数の分からないチャンクには渡さない", () => {
    // 前後を決められない以上、「前の話だけ」を守れない
    expect(
      scenes().select({ chapter: null, terms: ["月島灯"], maxChars: 4000 })
    ).toBe("");
  });

  test("1文字の検索語では引かない", () => {
    // 索引は文字2つ組みなので、1文字では当たりようがない。
    // 「灯」で全場面が返るような取り違えを防ぐ
    expect(scenes().select({ chapter: 9, terms: ["灯"], maxChars: 4000 })).toBe(
      ""
    );
  });

  test("同じ入力からは同じ文字列を返す", () => {
    // キャッシュの鍵に抜粋のハッシュを混ぜるので、揺れると
    // 同じ鍵に違う材料の答えが入る
    const index = scenes();
    const once = index.select({
      chapter: 9,
      terms: ["月島灯", "白鷺湖"],
      maxChars: 4000,
    });
    const twice = index.select({
      chapter: 9,
      terms: ["白鷺湖", "月島灯"],
      maxChars: 4000,
    });

    expect(twice).toBe(once);
  });

  test("出す順は話数の順にする", () => {
    const selected = scenes().select({
      chapter: 9,
      terms: ["月島灯", "白鷺湖"],
      maxChars: 4000,
    });

    expect(selected.indexOf("【第1話")).toBeLessThan(
      selected.indexOf("【第2話")
    );
    expect(selected.indexOf("【第2話")).toBeLessThan(
      selected.indexOf("【第3話")
    );
  });

  test("場面が1つも無ければ空", () => {
    const empty = new PastSceneIndex([]);

    expect(empty.size).toBe(0);
    expect(empty.select({ chapter: 3, terms: ["月島灯"], maxChars: 4000 })).toBe(
      ""
    );
  });
});

describe("キャッシュの鍵", () => {
  test("抜粋が0件なら、鍵はこれまでのまま", () => {
    // 抜粋を渡していないチャンクの鍵まで変えると、処理済みが無駄に飛ぶ
    expect(promptVersionWithPastScenes("1.5:abc", "")).toBe("1.5:abc");
  });

  test("抜粋を渡したら鍵が変わる", () => {
    expect(promptVersionWithPastScenes("1.5:abc", "【第1話】本文")).not.toBe(
      "1.5:abc"
    );
  });

  test("過去の話を書き直したら鍵が変わる", () => {
    // 書き直す前の抜粋で出した指摘が、出続けないようにする
    const before = promptVersionWithPastScenes("1.5:abc", "【第1話】左腕の傷");
    const after = promptVersionWithPastScenes("1.5:abc", "【第1話】右腕の傷");

    expect(after).not.toBe(before);
  });

  test("同じ抜粋なら同じ鍵", () => {
    expect(promptVersionWithPastScenes("1.5:abc", "【第1話】本文")).toBe(
      promptVersionWithPastScenes("1.5:abc", "【第1話】本文")
    );
  });
});

describe("上限の決め方", () => {
  test("モデルの上限に対する割合で決める", () => {
    // 固定字数だと、小さいモデルへ替えたときにそのまま溢れる
    expect(pastSceneMaxChars(32768)).toBeLessThan(pastSceneMaxChars(131072));
  });

  test("世界観より控えめにする", () => {
    // 本文の抜粋は1件が長い。まずは小さく渡して、実測で決め直す
    expect(pastSceneMaxChars(131072)).toBeLessThanOrEqual(PAST_SCENE_MAX_CHARS);
    expect(PAST_SCENE_MAX_CHARS).toBeLessThan(30000);
  });

  test("コンテキスト長が分からなければ、固定の頭打ちを使う", () => {
    expect(pastSceneMaxChars(undefined)).toBe(PAST_SCENE_MAX_CHARS);
    expect(pastSceneMaxChars(0)).toBe(PAST_SCENE_MAX_CHARS);
  });
});

/**
 * 1件でも渡りうるか（0.32.6のレビューで見つかった）。
 *
 * **合本（1ファイルに全話）の作品では、抜粋は必ず0件になる。** チャンクの
 * 話数はファイル単位に決まるので、全チャンクが「その合本の最小話数」を
 * 名乗り、`scene.chapter < chunk.chapterStart` を満たす場面が存在しない。
 * それでも確認ダイアログは「前の話の本文からも…渡します」と告げていた。
 *
 * **告げるのも、索引を組むのも、実際に渡りうるときだけにする。**
 */
describe("渡りうるかを先に見る", () => {
  const built = buildPastScenes([
    source("第1話", 1, "本文です。"),
    source("第2話", 2, "本文です。"),
    source("第3話", 3, "本文です。"),
  ]);

  test("話ごとにファイルが分かれていれば、渡りうる", () => {
    expect(anyPastSceneReachable(built, [1, 2, 3])).toBe(true);
  });

  test("合本1ファイルなら、どのチャンクにも渡らない", () => {
    // 全チャンクが同じ話数（＝合本の中の最小話数）を名乗る
    expect(anyPastSceneReachable(built, [1, 1, 1])).toBe(false);
  });

  test("話数の分からないチャンクだけなら、渡らない", () => {
    expect(anyPastSceneReachable(built, [null, null])).toBe(false);
  });

  test("場面が1つも無ければ、渡らない", () => {
    expect(anyPastSceneReachable([], [1, 2, 3])).toBe(false);
  });

  test("後ろの話のチャンクが1つでもあれば、渡りうる", () => {
    // 話数の読めないチャンクが混ざっていても、判断は変わらない
    expect(anyPastSceneReachable(built, [null, 1, 5])).toBe(true);
  });
});
