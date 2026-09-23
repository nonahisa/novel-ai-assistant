import { describe, expect, test } from "vitest";
import {
  buildThreeCirclesSheet,
  collectReactions,
  needsBridge,
  threeCirclesEdges,
  THREE_CIRCLES_KIND,
  type ThreeCirclesInput,
} from "../../../src/core/threeCirclesSheet";
import {
  emptyPostingLedger,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";
import { authorReaderProfileFromAnswers } from "../../../src/core/authorReaderType";
import type { AuthorReaderProfile } from "../../../src/core/authorReaderType";
import type { ReaderProfile, ReaderScores } from "../../../src/models/readerProfile";

/**
 * 3つの輪の1枚（設計書6.101、実装の順「3」と「4」）。
 *
 * ここで守るのは5つ。どれも**言い方を間違えると製品が壊れる**ところである。
 *
 * 1. **「書けるもの」とは書かない**（作者の裁定、2026-09-19）。実績の
 *    記述に留め、限界の宣告にしない
 * 2. **材料の無い行・節は出さない**——空の作品で、でっち上げの数字が
 *    並ぶことがあってはならない
 * 3. **近づける道は、辺が2本以上あってすべて離れているときだけ**。
 *    1本では「重なりが空」と言い切れない
 * 4. **「重なっていません」とは書かない**——判定ではなく手段を渡す
 * 5. **上下を作らない**
 */

function scores(
  familiarity: number,
  posture: number,
  craving: number
): ReaderScores {
  return { familiarity, posture, craving };
}

/** 作者自身の読者タイプ（点数を直に置く） */
function author(value: ReaderScores): AuthorReaderProfile {
  return {
    ...authorReaderProfileFromAnswers(
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
      new Date("2026-09-19T00:00:00.000Z")
    ),
    scores: value,
  };
}

const UPDATED_AT = "2026-09-19T00:00:00.000Z";

function profile(sides: {
  declared?: ReaderScores;
  actual?: ReaderScores;
}): ReaderProfile {
  return {
    schemaVersion: "1",
    ...(sides.declared
      ? { declared: { scores: sides.declared, answers: [], updatedAt: UPDATED_AT } }
      : {}),
    ...(sides.actual
      ? {
          actual: {
            scores: sides.actual,
            evidence: [],
            basis: "冒頭",
            model: "test",
            updatedAt: UPDATED_AT,
          },
        }
      : {}),
  };
}

/** 考察層（読み慣れが主・読む姿勢が副） */
const LORE_DEEP = scores(6, 4, 0);
/** すきま層（どの軸も低い） */
const LIGHT = scores(0, 0, 0);
/** 開拓層（読み慣れが主・求めるものが副） */
const LORE_CRAVE = scores(6, 0, 6);

/** 何も分かっていない作品 */
const EMPTY: ThreeCirclesInput = {
  workTitle: "無題",
  written: {},
  wanted: {},
};

/** 材料がひととおり揃った作品（作者の手元に近い形） */
function filled(): ThreeCirclesInput {
  return {
    workTitle: "灯台守の娘",
    written: {
      episodes: 19,
      chars: 41000,
      length: { typical: 2100, shortest: 900, longest: 4300 },
      days: { active: 32, streak: 5 },
      settings: [
        { label: "登場人物", count: 12 },
        { label: "場所", count: 5 },
      ],
      narrativePerson: "一人称",
      firstPerson: "僕",
      archaic: false,
    },
    wanted: {
      writerType: {
        label: "題材職人型",
        summary: "書きたい題材を、読まれる形で仕上げたい書き手。",
      },
      genre: "- ハイファンタジー（小説家になろう）",
      motif: "灯台／姉妹",
    },
    profile: profile({ declared: LIGHT, actual: LORE_CRAVE }),
    reactions: [
      {
        site: "小説家になろう",
        metrics: "PV 1,234／ブックマーク 89",
        readAt: "2026-09-19",
      },
    ],
    authorReader: author(LORE_DEEP),
  };
}

/** 見出しから次の見出しまでを切り出す */
function section(sheet: string, heading: string): string {
  const lines = sheet.split("\n");
  const start = lines.findIndex((line) => line === `## ${heading}`);
  expect(start, `節が無い: ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("紙の骨格", () => {
  test("題は種類と作品名（ファイル名と同じ言葉を使う）", () => {
    expect(buildThreeCirclesSheet(filled()).split("\n")[0]).toBe(
      `# ${THREE_CIRCLES_KIND}——灯台守の娘`
    );
  });

  test("3つの輪の見出しは、材料が無くても必ず出る", () => {
    const sheet = buildThreeCirclesSheet(EMPTY);
    for (const heading of [
      "すでに書けたもの",
      "書きたいもの",
      "読者が読みたいもの",
      "重なっているところ",
      "この紙の読み方",
    ]) {
      expect(sheet).toContain(`## ${heading}`);
    }
  });

  test("読めなかった材料は、いちばん上で断る", () => {
    const sheet = buildThreeCirclesSheet({
      ...EMPTY,
      notices: ["設定資料を読めませんでした：壊れています"],
    });
    expect(sheet).toContain("> 設定資料を読めませんでした：壊れています");
  });
});

describe("「書けるもの」とは書かない（作者の裁定、2026-09-19）", () => {
  test("実績の節は「すでに書けたもの」で、「書けるもの」とは書かない", () => {
    for (const sheet of [
      buildThreeCirclesSheet(filled()),
      buildThreeCirclesSheet(EMPTY),
    ]) {
      expect(sheet).toContain("## すでに書けたもの");
      expect(sheet).not.toContain("書けるもの");
    }
  });

  test("ここに無いものが書けない、という意味ではないと断る", () => {
    expect(section(buildThreeCirclesSheet(filled()), "すでに書けたもの")).toContain(
      "ここに無いものが書けない、という意味ではありません"
    );
  });
});

describe("材料の無い行・節は出さない", () => {
  test("空の作品で、でっち上げの数字が出ない", () => {
    const written = section(buildThreeCirclesSheet(EMPTY), "すでに書けたもの");

    expect(written).not.toContain("0話");
    expect(written).not.toContain("0字");
    expect(written).not.toContain("合計");
    expect(written).not.toContain("設定資料は");
    // 数えられた行（箇条書き）が1つも無い
    expect(written.split("\n").filter((line) => line.startsWith("- "))).toEqual(
      []
    );
    expect(written).toContain("まだ数えられるものがありません");
  });

  test("話数だけ分かるときは、長さの癖も日数も出さない", () => {
    const sheet = buildThreeCirclesSheet({
      ...EMPTY,
      written: { episodes: 3, chars: 5000 },
    });
    const written = section(sheet, "すでに書けたもの");

    expect(written).toContain("書き切ったのは3話、合計5,000字。");
    expect(written).not.toContain("1話の長さ");
    expect(written).not.toContain("書いた日は");
    expect(written).not.toContain("人称は");
  });

  test("診断していなければ、書きたいものも読者も出さない", () => {
    const sheet = buildThreeCirclesSheet(EMPTY);

    expect(section(sheet, "書きたいもの")).toContain("まだお聞きしていません");
    expect(section(sheet, "読者が読みたいもの")).toContain("まだ分かりません");
  });

  test("材料の無い辺は、小見出しごと出ない", () => {
    // 作者自身の読者タイプだけがあり、作品の読者像が無い
    const sheet = buildThreeCirclesSheet({
      ...EMPTY,
      authorReader: author(LORE_DEEP),
    });
    const overlap = section(sheet, "重なっているところ");

    expect(overlap).not.toContain("###");
    expect(overlap).toContain("いまはまだ、3つを突き合わせられません");
    // 何を済ませると出るかを添える（いまの入口「ターゲット読者」への誘い。
    // 設計書6.108.6 で入口を1つにした）
    expect(overlap).toContain("「ターゲット読者」");
  });

  test("6.86 の受容度・自信度は紙に出さない", () => {
    const sheet = buildThreeCirclesSheet(filled());
    expect(sheet).not.toContain("受容度");
    expect(sheet).not.toContain("自信度");
  });
});

describe("重なっているところ（3本の辺）", () => {
  test("材料が揃えば、3本とも出る", () => {
    const edges = threeCirclesEdges(filled());
    expect(edges.map((edge) => edge.key)).toEqual([
      "wanted-readers",
      "readers-written",
      "wanted-written",
    ]);
  });

  test("宣言しかなければ、辺は1本だけ", () => {
    const edges = threeCirclesEdges({
      profile: profile({ declared: LIGHT }),
      authorReader: author(LORE_DEEP),
    });
    expect(edges.map((edge) => edge.key)).toEqual(["wanted-readers"]);
  });

  test("宣言と実像の両方があっても、辺Aと辺Cは別の突き合わせになる", () => {
    // `chatReaderBasis` は宣言を優先するので、台帳をそのまま渡すと
    // 同じ突き合わせが2本に見える（近づける道を出す条件まで狂う）
    const edges = threeCirclesEdges({
      profile: profile({ declared: LIGHT, actual: LORE_CRAVE }),
      authorReader: author(LORE_DEEP),
    });
    const wantedReaders = edges.find((edge) => edge.key === "wanted-readers");
    const wantedWritten = edges.find((edge) => edge.key === "wanted-written");

    expect(wantedReaders?.lines).not.toEqual(wantedWritten?.lines);
    expect(wantedReaders?.lines.join("\n")).toContain("すきま層");
    expect(wantedWritten?.lines.join("\n")).toContain("開拓層");
  });

  test("重なっていれば、重なっていると言う", () => {
    const edges = threeCirclesEdges({
      profile: profile({ declared: LORE_DEEP }),
      authorReader: author(LORE_DEEP),
    });
    expect(edges[0].apart).toBe(false);
    expect(edges[0].lines.join("\n")).toContain(
      "あなたの直感がそのまま使えます"
    );
  });

  test("層は違うが近いだけのときは、離れているとは言わない", () => {
    // 考察層（6,4,0）と常連層（4,6,0）。どの軸も2点未満しか離れていない
    const edges = threeCirclesEdges({
      profile: profile({ declared: scores(4, 5, 0) }),
      authorReader: author(scores(5, 4, 0)),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].apart).toBe(false);
    expect(edges[0].lines.join("\n")).toContain("離れているとは見ていません");
  });
});

describe("近づける道（実装の順「4」）", () => {
  test("辺が2本以上あって、すべて離れているときだけ出す", () => {
    const three = threeCirclesEdges(filled());
    expect(three.every((edge) => edge.apart)).toBe(true);
    expect(needsBridge(three)).toBe(true);

    expect(buildThreeCirclesSheet(filled())).toContain("## 近づける道");
  });

  test("辺が1本しか無いときは出さない", () => {
    const input: ThreeCirclesInput = {
      ...EMPTY,
      profile: profile({ declared: LIGHT }),
      authorReader: author(LORE_DEEP),
    };
    const edges = threeCirclesEdges(input);

    expect(edges).toHaveLength(1);
    expect(edges[0].apart).toBe(true);
    expect(needsBridge(edges)).toBe(false);
    expect(buildThreeCirclesSheet(input)).not.toContain("## 近づける道");
  });

  test("1本でも離れていなければ出さない", () => {
    const edges = threeCirclesEdges({
      profile: profile({ declared: LORE_DEEP, actual: LORE_CRAVE }),
      authorReader: author(LORE_DEEP),
    });

    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(edges.some((edge) => !edge.apart)).toBe(true);
    expect(needsBridge(edges)).toBe(false);
  });

  test("動かせるところを3つ、隣へ一歩の形で渡す", () => {
    const bridge = section(buildThreeCirclesSheet(filled()), "近づける道");

    expect(bridge).toContain("読者が読みたいものを動かす");
    expect(bridge).toContain("すでに書けたものを動かす");
    expect(bridge).toContain("書きたいものを動かす");
    // いきなり遠くへ飛ばさない（宛先の隣を名指しする）
    expect(bridge).toContain("いきなり寄せず、隣の");
    expect(bridge).toContain("どれを動かすかは作者が決めることです");
  });

  test("「重なっていません」とは書かない", () => {
    for (const sheet of [
      buildThreeCirclesSheet(filled()),
      buildThreeCirclesSheet(EMPTY),
    ]) {
      expect(sheet).not.toContain("重なっていません");
    }
  });
});

describe("上下を作らない", () => {
  test("この紙の読み方に、上下が無いことを必ず書く", () => {
    const how = section(buildThreeCirclesSheet(filled()), "この紙の読み方");

    expect(how).toContain("上下はありません");
    expect(how).toContain("効く相手");
    // 年齢を軸にしない理由は、既にある文言を使い回す（写しを作らない）
    expect(how).toContain("年齢層は軸にしていません");
  });

  test("品定めではないと、はじめに断る", () => {
    expect(buildThreeCirclesSheet(EMPTY)).toContain("この紙は品定めではありません");
  });
});

/**
 * 届いている反応を、台帳からどう選ぶか（設計書6.79.7／6.101）。
 *
 * **0.75.4 までは画面側（`features/threeCircles.ts`）の中にあり、測れなかった。**
 * 前提（新しい順に並べ、`scope: "work"` の最初を採る）は
 * `readerStats.test.ts` が台帳の側で押さえているが、**それを使う側**が
 * 話ごとの行を拾っていないことは、どこでも見ていなかった。
 */
describe("届いている反応の選び方", () => {
  function stats(patch: Partial<ReaderStatsRecord> = {}): ReaderStatsRecord {
    return {
      site: "kakuyomu",
      readAt: "2026-09-05T00:00:00.000Z",
      scope: "work",
      metrics: { pv: 1234 },
      source: "manual",
      ...patch,
    };
  }

  function ledgerWith(records: ReaderStatsRecord[]): PostingLedger {
    return { ...emptyPostingLedger(), readerStats: records };
  }

  /**
   * **話ごとの数字を混ぜない。** 混ぜると「この作品はどれくらい
   * 読まれているか」の欄に1話ぶんの数字が出て、勢いを読み違える。
   */
  test("話ごとの記録のほうが新しくても、作品全体の最新を採る", () => {
    const reactions = collectReactions(
      ledgerWith([
        stats({
          readAt: "2026-09-20T00:00:00.000Z",
          scope: "episode",
          episode: 3,
          metrics: { pv: 7 },
        }),
        stats({ readAt: "2026-09-10T00:00:00.000Z", metrics: { pv: 500 } }),
        stats({ readAt: "2026-09-01T00:00:00.000Z", metrics: { pv: 100 } }),
      ])
    );

    expect(reactions).toHaveLength(1);
    expect(reactions[0].site).toBe("カクヨム");
    expect(reactions[0].metrics).toContain("500");
    // 日付だけを出す（読み取った時刻までは要らない）
    expect(reactions[0].readAt).toBe("2026-09-10");
  });

  test("そのサイトの記録が無ければ、その行は出さない", () => {
    expect(collectReactions(ledgerWith([]))).toEqual([]);
    // 話ごとの記録しか無いサイトも、作品全体の数字が無いので出さない
    expect(
      collectReactions(
        ledgerWith([stats({ scope: "episode", episode: 1 })])
      )
    ).toEqual([]);
  });
});
