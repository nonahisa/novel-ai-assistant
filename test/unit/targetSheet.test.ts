import { describe, expect, test } from "vitest";
import {
  READER_AXIS_ORDER,
  READER_GAP_THRESHOLD,
  READER_TYPE_TABLE,
  resolveReaderType,
  type ReaderTypeId,
} from "../../src/core/readerTarget";
import { READER_TYPE_IDS } from "../../src/core/readerTypeNeighbors";
import {
  rankReaderTypes,
  readerTypeAffinity,
  readerTypeAffinityOf,
  readerTypeGaps,
  READER_TYPE_CENTERS,
  targetSheetFor,
} from "../../src/core/targetSheet";
import type { ReaderScores } from "../../src/models/readerProfile";

/**
 * ターゲットシートの一致度（設計書6.108、第1段と第2段）。
 *
 * **いちばん大事なのは総当たり**である。一致度の表といちばん上の行が
 * 食い違うと、作者から見て「同じ紙の中で答えが2つある」ことになる。
 * 軸の取りうる値（0〜6）を全部回して、`resolveReaderType` の答えが
 * 必ず最大になることを見張る。
 */

/** 軸の取りうる値を全部回した、343通りの点数 */
function allScores(): ReaderScores[] {
  const found: ReaderScores[] = [];
  for (let familiarity = 0; familiarity <= 6; familiarity += 1) {
    for (let posture = 0; posture <= 6; posture += 1) {
      for (let craving = 0; craving <= 6; craving += 1) {
        found.push({ familiarity, posture, craving });
      }
    }
  }
  return found;
}

describe("11型の中心", () => {
  test("主軸＝上限・副軸＝中ほど・残り＝下限（表から導いている）", () => {
    for (const [key, type] of Object.entries(READER_TYPE_TABLE)) {
      const [main, sub] = key.split(":");
      const center = READER_TYPE_CENTERS[type];
      for (const axis of READER_AXIS_ORDER) {
        const wanted = axis === main ? 6 : axis === sub ? 3 : 0;
        expect(center[axis], `${type}/${axis}`).toBe(wanted);
      }
    }
  });

  test("すきま層は全部下、雑食層は全部中ほど", () => {
    // **雑食層は「全部上」ではない。** `resolveReaderType` が雑食層を
    // 返すのは3軸がそろって「中」のときだけである
    expect(READER_TYPE_CENTERS.light).toEqual({
      familiarity: 0,
      posture: 0,
      craving: 0,
    });
    expect(READER_TYPE_CENTERS.omnivore).toEqual({
      familiarity: 3,
      posture: 3,
      craving: 3,
    });
  });

  test("11型ぶんある（足りない型が黙って落ちていない）", () => {
    expect(Object.keys(READER_TYPE_CENTERS).sort()).toEqual(
      [...READER_TYPE_IDS].sort()
    );
  });

  test("中心そのものを診断に掛けると、その型が返る", () => {
    // 中心が型の外にあると、一致度100の点が別の型に分類される
    for (const type of READER_TYPE_IDS) {
      expect(resolveReaderType(READER_TYPE_CENTERS[type]), type).toBe(type);
    }
  });

  test("中心の一致度は100", () => {
    for (const type of READER_TYPE_IDS) {
      expect(readerTypeAffinityOf(READER_TYPE_CENTERS[type], type), type).toBe(
        100
      );
    }
  });
});

describe("一致度", () => {
  test("0〜100の整数（343通り全部）", () => {
    for (const scores of allScores()) {
      for (const type of READER_TYPE_IDS) {
        const affinity = readerTypeAffinityOf(scores, type);
        expect(Number.isInteger(affinity), `${type}/${JSON.stringify(scores)}`).toBe(
          true
        );
        expect(affinity).toBeGreaterThanOrEqual(0);
        expect(affinity).toBeLessThanOrEqual(100);
      }
    }
  });

  test("どの点数でも、診断が返す型の一致度がいちばん高い", () => {
    /*
      **これが崩れると、表といちばん上の行が食い違う。**

      点数（0〜6）の距離で測るとここで落ちる——たとえば
      （読み慣れ1・読む姿勢1・求めるもの2）は原点にいちばん近いので
      「すきま層」が最大になるが、診断の答えは「刺激層」である。
      段階（低・中・高）で測れば食い違わない。
    */
    const broken: string[] = [];
    for (const scores of allScores()) {
      const affinity = readerTypeAffinity(scores);
      const top = resolveReaderType(scores);
      const best = Math.max(...READER_TYPE_IDS.map((type) => affinity[type]));
      if (affinity[top] !== best) {
        broken.push(`${JSON.stringify(scores)}: ${top} が最大でない`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("並べ直しても順が揺れない（同率は決まった並び）", () => {
    const scores: ReaderScores = { familiarity: 6, posture: 3, craving: 0 };
    const first = rankReaderTypes(scores).map((entry) => entry.type);
    const again = rankReaderTypes(scores).map((entry) => entry.type);
    expect(again).toEqual(first);
    // 高い順に並んでいる
    const values = rankReaderTypes(scores).map((entry) => entry.affinity);
    expect([...values].sort((left, right) => right - left)).toEqual(values);
  });
});

describe("ずれ", () => {
  test("2点未満は言わない（6.101と同じ流儀）", () => {
    // 考察層の中心は（6・3・0）。1点ずれは黙る
    const gaps = readerTypeGaps(
      { familiarity: 5, posture: 4, craving: 1 },
      "lore_deep"
    );
    expect(gaps).toEqual([]);
    expect(READER_GAP_THRESHOLD).toBe(2);
  });

  test("幅の大きい順に返る", () => {
    const gaps = readerTypeGaps(
      { familiarity: 2, posture: 6, craving: 5 },
      "lore_deep"
    );
    // 考察層の中心は（6・3・0）。求めるもの＋5、読み慣れ−4、読む姿勢＋3
    expect(gaps.map((gap) => gap.axis)).toEqual([
      "craving",
      "familiarity",
      "posture",
    ]);
  });
});

describe("向かう先", () => {
  test("動かすのは軸1本だけ（343通り全部）", () => {
    for (const scores of allScores()) {
      const sheet = targetSheetFor({ aim: [], scores });
      for (const direction of [sheet.expand, sheet.converge]) {
        expect(direction, JSON.stringify(scores)).toBeDefined();
        // 軸を動かすか、動かせない理由を言うか。**黙って空欄にしない**
        expect(
          Boolean(direction?.move) || Boolean(direction?.note),
          JSON.stringify(scores)
        ).toBe(true);
        if (!direction?.move) continue;
        expect(READER_AXIS_ORDER).toContain(direction.move.axis);
        // 具体の手は、診断の設問（軸ごとに3問）から引く
        expect(direction.move.examples.length).toBe(3);
      }
    }
  });

  test("拡大の行き先は、いまの層の隣", () => {
    // 考察層（読み慣れ高・読む姿勢中）のとき、隣でない層へは向かわない
    const sheet = targetSheetFor({
      aim: [],
      scores: { familiarity: 6, posture: 3, craving: 0 },
    });
    expect(sheet.actual?.top).toBe("lore_deep");
    expect(sheet.expand?.toward).not.toBe("lore_deep");
    expect(READER_TYPE_IDS).toContain(sheet.expand?.toward as ReaderTypeId);
  });

  test("収束の行き先は狙いの層。狙いが無ければ、いちばん高い層", () => {
    const scores: ReaderScores = { familiarity: 6, posture: 3, craving: 0 };
    expect(targetSheetFor({ aim: ["crave_pure"], scores }).converge?.toward).toBe(
      "crave_pure"
    );
    expect(targetSheetFor({ aim: [], scores }).converge?.toward).toBe(
      "lore_deep"
    );
  });

  test("狙いが2つなら、まだ届いていないほうへ寄せる", () => {
    // 考察層には既に届いている。**届いている狙いへ「寄せましょう」は
    // 空振り**なので、絞る先は刺激層のほうになる
    const sheet = targetSheetFor({
      aim: ["lore_deep", "crave_pure"],
      scores: { familiarity: 6, posture: 3, craving: 1 },
    });
    expect(sheet.actual?.top).toBe("lore_deep");
    expect(sheet.converge?.toward).toBe("crave_pure");
    expect(sheet.converge?.move?.axis).toBe("familiarity");
  });

  test("狙いと実態が同じなら、収束は「すでに寄っている」と言う", () => {
    const sheet = targetSheetFor({
      aim: ["lore_deep"],
      scores: { familiarity: 6, posture: 3, craving: 0 },
    });
    expect(sheet.converge?.move).toBeUndefined();
    expect(sheet.converge?.note).toContain("すでに");
  });
});

describe("シートの形", () => {
  test("点数が無ければ、実態も向かう先も出さない", () => {
    const sheet = targetSheetFor({ aim: ["lore_deep"] });
    expect(sheet.actual).toBeUndefined();
    expect(sheet.aims).toEqual([]);
    expect(sheet.expand).toBeUndefined();
    expect(sheet.converge).toBeUndefined();
    // 狙いは残る（作者が書いたものを落とさない）
    expect(sheet.aim).toEqual(["lore_deep"]);
  });

  test("狙いが無くても、実態と向かう先は出る", () => {
    const sheet = targetSheetFor({
      aim: [],
      scores: { familiarity: 0, posture: 0, craving: 0 },
    });
    expect(sheet.aims).toEqual([]);
    expect(sheet.actual?.top).toBe("light");
    expect(sheet.actual?.ranking.length).toBe(11);
    expect(sheet.expand).toBeDefined();
  });

  test("同じ狙いを2度書かれても1つに畳む", () => {
    const sheet = targetSheetFor({
      aim: ["lore_deep", "lore_deep"],
      scores: { familiarity: 6, posture: 3, craving: 0 },
    });
    expect(sheet.aim).toEqual(["lore_deep"]);
    expect(sheet.aims.length).toBe(1);
  });

  test("狙いの一致度とずれが出る", () => {
    const sheet = targetSheetFor({
      aim: ["crave_pure"],
      scores: { familiarity: 6, posture: 3, craving: 0 },
    });
    const aim = sheet.aims[0];
    expect(aim.type).toBe("crave_pure");
    expect(aim.isTop).toBe(false);
    expect(aim.affinity).toBeLessThan(100);
    expect(aim.gaps.map((gap) => gap.axis)).toContain("craving");
  });
});
