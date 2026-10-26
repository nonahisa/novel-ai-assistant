import { describe, expect, it } from "vitest";
import { screenPlotNameCandidates } from "../../../src/core/plotNameCandidates";
import { planNameOrigin } from "../../../src/core/nameOriginFit";
import type { NameEntry } from "../../../src/core/nameCollision";
import type { NameCandidate } from "../../../src/prompts/nameSuggest";

/**
 * プロットの名前の候補（P-45）を揃えて絞る（設計書6.4.8）。
 * **AIの答えを信用しない**——落としたものは理由つきで残す。
 */
function candidate(name: string, reading: string, origin = "和風"): NameCandidate {
  return { name, reading, origin, note: "" };
}

const WAFU = planNameOrigin({ chosen: "和風", existingNames: [], setting: "" });
const OPEN = planNameOrigin({ existingNames: [], setting: "" });

describe("人物ごとの候補を絞る", () => {
  it("先の人物に残した候補と響きが重なる候補は、あとの人物から落とす", () => {
    const result = screenPlotNameCandidates(
      [
        { id: "1", label: "主人公", candidates: [candidate("相馬誠", "そうままこと")] },
        {
          id: "2",
          label: "ヒロイン",
          candidates: [candidate("相馬真琴", "そうままこと"), candidate("白井澪", "しらいみお")],
        },
      ],
      WAFU,
      []
    );

    expect(result.people[0].kept.map((entry) => entry.name)).toEqual(["相馬誠"]);
    expect(result.people[1].kept.map((entry) => entry.name)).toEqual(["白井澪"]);
    expect(result.people[1].dropped[0].name).toBe("相馬真琴");
    // 相手が資料の人物でなく、ほかの人物の候補だと分かるように添える
    expect(result.people[1].dropped[0].reason).toContain("「主人公」の候補です");
  });

  it("既にある名前と響きが重なる候補を落とす", () => {
    const existing: NameEntry[] = [
      { id: "char_001", kind: "character", name: "ミナ", reading: "みな" },
    ];
    const result = screenPlotNameCandidates(
      [{ id: "1", candidates: [candidate("ミナモト", "みなもと", "架空語"), candidate("リオ", "りお", "架空語")] }],
      planNameOrigin({ chosen: "架空語", existingNames: [], setting: "" }),
      existing
    );
    expect(result.people[0].kept.map((entry) => entry.name)).toEqual(["リオ"]);
    expect(result.people[0].dropped[0].reason).toContain("「ミナ」と重なります");
  });

  it("役名そのもの・指示の言葉は名前として残さない", () => {
    const result = screenPlotNameCandidates(
      [{ id: "1", candidates: [candidate("主人公", "しゅじんこう"), candidate("相馬誠", "そうままこと")] }],
      WAFU,
      []
    );
    expect(result.people[0].kept.map((entry) => entry.name)).toEqual(["相馬誠"]);
    expect(result.people[0].dropped[0].reason).toContain("役割を表す言葉");
  });

  it("読みの無い漢字の名前は落とす。カタカナの名前は表記から読みを作る", () => {
    const result = screenPlotNameCandidates(
      [
        {
          id: "1",
          candidates: [
            candidate("相馬誠", ""),
            candidate("リオ", "", "架空語"),
            candidate("白井澪", "シライミオ"),
          ],
        },
      ],
      OPEN,
      [],
      "和風"
    );
    // 系統は和風で揃えるので、架空語の「リオ」は系統で落ちる
    expect(result.origin).toBe("和風");
    expect(result.people[0].kept).toEqual([
      { name: "白井澪", reading: "しらいみお", origin: "和風", note: "" },
    ]);
    const reasons = result.people[0].dropped.map((entry) => entry.reason).join("／");
    expect(reasons).toContain("読みが返らなかった");
    expect(reasons).toContain("系統が揃っていません");
  });

  it("カタカナの名前は、読みが無くても表記から読みを作って残す", () => {
    const result = screenPlotNameCandidates(
      [{ id: "1", candidates: [candidate("リオ", "", "架空語")] }],
      planNameOrigin({ chosen: "架空語", existingNames: [], setting: "" }),
      []
    );
    expect(result.people[0].kept).toEqual([
      { name: "リオ", reading: "りお", origin: "架空語", note: "" },
    ]);
  });

  it("系統は全員で1つに揃える（人物ごとに割れない）", () => {
    const result = screenPlotNameCandidates(
      [
        { id: "1", candidates: [candidate("相馬誠", "そうままこと", "和風")] },
        { id: "2", candidates: [candidate("フレイヤ", "ふれいや", "北欧")] },
      ],
      OPEN,
      [],
      "和風"
    );
    expect(result.origin).toBe("和風");
    expect(result.people[1].kept).toEqual([]);
    expect(result.people[1].dropped[0].reason).toContain("系統が揃っていません");
  });
});

/**
 * 漢字のあいだの「ノ」「ヶ」「ケ」（作者の裁定 2026-10-26「直す」）。
 *
 * プロンプト設計書 P-45 の測定（2026-09-25）で、26b の「一ノ瀬 莉子」が
 * 「カタカナを含む」で落ちた。プロットモードの道（系統を全員で決める →
 * `fitNameCandidates` → 読みを揃える → 響き）を通しても残ることを見張る。
 * 作者が系統を選ばず、人物名から漢字の作品と決まる計画で確かめる。
 */
describe("漢字のあいだの「ノ」「ヶ」「ケ」は和名の一部として残す", () => {
  const KANJI_WORK = planNameOrigin({
    existingNames: ["相馬誠", "白井澪"],
    setting: "",
  });

  it("一ノ瀬・二ノ宮・霞ヶ関・三ケ田は、どの人物の候補でも落とさない", () => {
    const result = screenPlotNameCandidates(
      [
        {
          id: "1",
          label: "主人公",
          candidates: [
            candidate("一ノ瀬 莉子", "いちのせ りこ"),
            candidate("二ノ宮 湊", "にのみや みなと"),
          ],
        },
        {
          id: "2",
          label: "班長",
          candidates: [
            candidate("霞ヶ関 蒼", "かすみがせき あおい"),
            candidate("三ケ田 勝", "みけた まさる"),
          ],
        },
      ],
      KANJI_WORK,
      []
    );

    expect(result.origin).toBe("和風");
    expect(result.people[0].kept.map((entry) => entry.name)).toEqual([
      "一ノ瀬 莉子",
      "二ノ宮 湊",
    ]);
    expect(result.people[1].kept.map((entry) => entry.name)).toEqual([
      "霞ヶ関 蒼",
      "三ケ田 勝",
    ]);
    expect(result.people.flatMap((person) => person.dropped)).toEqual([]);
  });

  it("カタカナの名前・カタカナ混じりの名前は、これまでどおり落とす", () => {
    const result = screenPlotNameCandidates(
      [
        {
          id: "1",
          candidates: [
            candidate("アリス", "ありす"),
            // 「ケ」「ノ」でも、漢字に挟まれていなければ名前の一部ではない
            candidate("佐藤ケン", "さとう けん"),
            candidate("ノ瀬 莉子", "のせ りこ"),
            candidate("結城 紬", "ゆうき つむぎ"),
          ],
        },
      ],
      KANJI_WORK,
      []
    );

    expect(result.people[0].kept.map((entry) => entry.name)).toEqual(["結城 紬"]);
    expect(result.people[0].dropped.map((entry) => entry.name)).toEqual([
      "アリス",
      "佐藤ケン",
      "ノ瀬 莉子",
    ]);
    for (const entry of result.people[0].dropped) {
      expect(entry.reason).toContain("カタカナを含む");
    }
  });
});
