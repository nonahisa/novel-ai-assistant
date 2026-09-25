import { describe, expect, test } from "vitest";
import {
  MIN_VERDICTS_FOR_RATE,
  acceptanceRate,
  asVerdictFeature,
  buildVerdictStatsMarkdown,
  describeVerdictCount,
  findVerdictCount,
  parseVerdictLines,
  recordVerdictSubject,
  tallyVerdicts,
  verdictFeatureOf,
  type VerdictLine,
} from "../../../src/core/verdictTally";
import { FACT_CONTRADICTION_CATEGORY } from "../../../src/core/factContradiction";
import {
  findingId,
  parseFindingLines,
} from "../../../src/models/finding";

/**
 * 作者が採った・退けた指摘を、モデルごとに数える（設計書6.49.7。
 * 作者の判断、2026-09-26）。
 *
 * **作者の手間なくAIの当たりを知る**ための記録なので、数え方がずれると
 * 作者は誤った数字でモデルを選ぶことになる。ここで固定するのは3つ：
 *
 * 1. 同じ指摘への判断は最後の1つだけを数える（採ってから戻したら数えない）
 * 2. モデル・機能ごとに分けて数える
 * 3. 件数が少ないうちは率を出さない
 */

function line(partial: Partial<VerdictLine>): VerdictLine {
  return {
    time: "2026-09-26T10:00:00.000Z",
    subject: "f1",
    providerId: "ollama",
    model: "gemma4:12b",
    feature: "typo",
    status: "accepted",
    ...partial,
  };
}

describe("数え方", () => {
  test("モデルと機能ごとに、採った・退けたを分けて数える", () => {
    const counts = tallyVerdicts([
      [
        line({ subject: "a", status: "accepted" }),
        line({ subject: "b", status: "accepted" }),
        line({ subject: "c", status: "dismissed" }),
        line({ subject: "d", model: "gemma4:e4b", status: "dismissed" }),
        line({ subject: "e", feature: "proofread", status: "accepted" }),
      ],
    ]);
    expect(findVerdictCount(counts, "ollama", "gemma4:12b", "typo")).toMatchObject({
      accepted: 2,
      dismissed: 1,
    });
    expect(findVerdictCount(counts, "ollama", "gemma4:e4b", "typo")).toMatchObject({
      accepted: 0,
      dismissed: 1,
    });
    expect(
      findVerdictCount(counts, "ollama", "gemma4:12b", "proofread")
    ).toMatchObject({ accepted: 1, dismissed: 0 });
  });

  test("同じ名前のモデルでも、プロバイダが違えば別に数える", () => {
    const counts = tallyVerdicts([
      [
        line({ subject: "a", providerId: "ollama", model: "gemma-4" }),
        line({ subject: "b", providerId: "sakura", model: "gemma-4" }),
      ],
    ]);
    expect(counts).toHaveLength(2);
  });

  test("採ってから戻したものは数えない", () => {
    const counts = tallyVerdicts([
      [
        line({ subject: "a", status: "accepted", time: "2026-09-26T10:00:00.000Z" }),
        line({ subject: "a", status: "retracted", time: "2026-09-26T10:01:00.000Z" }),
      ],
    ]);
    expect(counts).toEqual([]);
  });

  test("戻したあと退けたら、退けたとして1件だけ数える", () => {
    const counts = tallyVerdicts([
      [
        line({ subject: "a", status: "accepted", time: "2026-09-26T10:00:00.000Z" }),
        line({ subject: "a", status: "retracted", time: "2026-09-26T10:01:00.000Z" }),
        line({ subject: "a", status: "dismissed", time: "2026-09-26T10:02:00.000Z" }),
      ],
    ]);
    expect(counts).toEqual([
      expect.objectContaining({ accepted: 0, dismissed: 1 }),
    ]);
  });

  test("同じ時刻なら後から書かれた行が勝つ（適用してすぐ戻す）", () => {
    const counts = tallyVerdicts([
      [
        line({ subject: "a", status: "accepted" }),
        line({ subject: "a", status: "retracted" }),
      ],
    ]);
    expect(counts).toEqual([]);
  });

  test("同期でファイルの並びが前後しても、時刻の新しいほうを採る", () => {
    const counts = tallyVerdicts([
      [
        line({ subject: "a", status: "dismissed", time: "2026-09-26T11:00:00.000Z" }),
        line({ subject: "a", status: "accepted", time: "2026-09-26T10:00:00.000Z" }),
      ],
    ]);
    expect(counts).toEqual([
      expect.objectContaining({ accepted: 0, dismissed: 1 }),
    ]);
  });

  test("作品が違えば、同じ番号でも別の指摘として足す", () => {
    // 番号はファイル名から作るので、作品をまたぐと重なることがある
    const counts = tallyVerdicts([
      [line({ subject: "a", status: "accepted" })],
      [line({ subject: "a", status: "accepted" })],
    ]);
    expect(counts).toEqual([
      expect.objectContaining({ accepted: 2, dismissed: 0 }),
    ]);
  });
});

describe("率を出すのは件数がそろってから", () => {
  test(`${MIN_VERDICTS_FOR_RATE}件に満たなければ率を出さない`, () => {
    expect(MIN_VERDICTS_FOR_RATE).toBe(10);
    expect(acceptanceRate({ accepted: 6, dismissed: 3 })).toBeUndefined();
    expect(describeVerdictCount({ accepted: 6, dismissed: 3 })).toBe(
      "作者の判断は まだ9件（10件から率を出します）"
    );
  });

  test(`${MIN_VERDICTS_FOR_RATE}件そろえば率を出す（四捨五入の整数）`, () => {
    expect(acceptanceRate({ accepted: 7, dismissed: 3 })).toBe(70);
    expect(acceptanceRate({ accepted: 2, dismissed: 1 + 10 })).toBe(15);
    expect(describeVerdictCount({ accepted: 20, dismissed: 5 })).toBe(
      "作者が採った率 80%（25件中）"
    );
  });

  test("表でも、少ない行は率の欄を「—」にする", () => {
    const markdown = buildVerdictStatsMarkdown(
      tallyVerdicts([
        [
          ...Array.from({ length: 8 }, (_, i) =>
            line({ subject: `a${i}`, status: "accepted" })
          ),
          ...Array.from({ length: 2 }, (_, i) =>
            line({ subject: `b${i}`, status: "dismissed" })
          ),
          line({ subject: "c", model: "gemma4:e4b", status: "accepted" }),
        ],
      ]),
      (id) => (id === "ollama" ? "Ollama" : id),
      (feature) => (feature === "typo" ? "誤字脱字" : feature)
    );
    expect(markdown).toContain("| Ollama | gemma4:12b | 誤字脱字 | 8 | 2 | 80% |");
    expect(markdown).toContain(
      "| Ollama | gemma4:e4b | 誤字脱字 | 1 | 0 | —（10件未満） |"
    );
  });

  test("記録が無ければ、表の代わりにどうすれば数が出るかを言う", () => {
    const markdown = buildVerdictStatsMarkdown([], (id) => id, (f) => f);
    expect(markdown).toContain("まだ記録がありません");
    expect(markdown).not.toContain("| AI |");
  });

  test("モデル名の「|」で表が崩れない", () => {
    const markdown = buildVerdictStatsMarkdown(
      tallyVerdicts([[line({ model: "odd|name" })]]),
      (id) => id,
      (f) => f
    );
    expect(markdown).toContain("odd\\|name");
  });
});

describe("記録の読み書き", () => {
  test("壊れた行・競合マーカー・知らない値の行は捨て、読める行は残す", () => {
    const good = JSON.stringify(line({ subject: "a" }));
    const text = [
      good,
      "{壊れた",
      "<<<<<<< HEAD",
      JSON.stringify(line({ subject: "b", status: "maybe" as never })),
      JSON.stringify(line({ subject: "c", feature: "extract" as never })),
      JSON.stringify({ ...line({ subject: "d" }), model: "" }),
      ">>>>>>> other",
      "",
    ].join("\n");
    const parsed = parseVerdictLines(text);
    expect(parsed.map((entry) => entry.subject)).toEqual(["a"]);
  });

  test("CRLF の記録も読める", () => {
    const text =
      JSON.stringify(line({ subject: "a" })) +
      "\r\n" +
      JSON.stringify(line({ subject: "b" })) +
      "\r\n";
    expect(parseVerdictLines(text)).toHaveLength(2);
  });
});

describe("数える分類", () => {
  test("AIの指摘の分類だけを数える", () => {
    expect(verdictFeatureOf("誤字脱字")).toBe("typo");
    expect(verdictFeatureOf("推敲")).toBe("proofread");
    expect(verdictFeatureOf("矛盾")).toBe("contradiction");
    // 事実の照合は、判定をしている矛盾検知の割当に数える
    expect(verdictFeatureOf(FACT_CONTRADICTION_CATEGORY)).toBe("contradiction");
    expect(verdictFeatureOf("プロット逸脱")).toBe("deviation");
    expect(verdictFeatureOf("伏線の候補")).toBe("foreshadow");
    expect(verdictFeatureOf("伏線の回収")).toBe("foreshadow");
  });

  test("AIを使わない・出どころが人の分類は数えない", () => {
    expect(verdictFeatureOf("表記ゆれ")).toBeUndefined();
    expect(verdictFeatureOf("編集部からの提案")).toBeUndefined();
    expect(verdictFeatureOf("設定資料の更新")).toBeUndefined();
    expect(verdictFeatureOf("名前の付け替え")).toBeUndefined();
  });

  test("割当の鍵は、指摘を出す5つだけを数える", () => {
    expect(asVerdictFeature("typo")).toBe("typo");
    expect(asVerdictFeature("foreshadow")).toBe("foreshadow");
    expect(asVerdictFeature("extract")).toBeUndefined();
    expect(asVerdictFeature("chat")).toBeUndefined();
    expect(asVerdictFeature("default")).toBeUndefined();
  });

  test("伏線の候補の番号は中身から決まる（並び順に依らない）", () => {
    const a = recordVerdictSubject("伏線の候補", "赤い鍵", ["第1話で張られています"]);
    const b = recordVerdictSubject("伏線の候補", "赤い鍵", ["第1話で張られています"]);
    const c = recordVerdictSubject("伏線の候補", "青い鍵", ["第1話で張られています"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("指摘の置き場に、出したAIを残す（6.96.4 との継ぎ目）", () => {
  test("出したAIを読み戻せる。番号には混ぜない", () => {
    const id = findingId("第1話.txt", "原文", "誤", "正", "typo", "誤字脱字");
    const text = JSON.stringify({
      kind: "finding",
      id,
      time: "2026-09-26T10:00:00.000Z",
      file: "第1話.txt",
      hintLine: 3,
      original: "原文",
      target: "誤",
      suggestion: "正",
      before: "",
      after: "",
      message: "",
      category: "typo",
      label: "誤字脱字",
      producer: { providerId: "ollama", model: "gemma4:12b" },
    });
    const [parsed] = parseFindingLines(text);
    expect(parsed).toMatchObject({
      kind: "finding",
      id,
      producer: { providerId: "ollama", model: "gemma4:12b" },
    });
  });

  test("古い記録（出したAIが無い・片方だけ）は、出したAIなしとして読む", () => {
    const base = {
      kind: "finding",
      id: "f1",
      time: "",
      file: "第1話.txt",
      hintLine: 1,
      original: "原文",
    };
    const [withoutProducer, halfProducer] = parseFindingLines(
      [
        JSON.stringify(base),
        JSON.stringify({ ...base, producer: { providerId: "ollama" } }),
      ].join("\n")
    );
    expect(withoutProducer).toMatchObject({ kind: "finding" });
    expect(
      withoutProducer.kind === "finding" ? withoutProducer.producer : "x"
    ).toBeUndefined();
    expect(
      halfProducer.kind === "finding" ? halfProducer.producer : "x"
    ).toBeUndefined();
  });
});
