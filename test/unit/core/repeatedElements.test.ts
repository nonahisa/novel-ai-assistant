import * as fs from "node:fs";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPEATED_ELEMENT_LIMIT,
  findRepetition,
  newRepetitionWatch,
  repetitionStopMessage,
  salvageRepetition,
  watchRepetition,
} from "../../../src/core/repeatedElements";

/**
 * 同じ指摘を延々と繰り返す応答を、途中で止めて救えるか
 * （2026-10-10。`docs/measurements/2026-10-10-typo-runaway.md`）。
 */

function issue(line: number, suggestion: string): string {
  return JSON.stringify(
    {
      line,
      original: "本文の抜き出し",
      target: "対象",
      suggestion,
      reason: "誤変換",
      confidence: "medium",
    },
    null,
    2
  );
}

/** 先頭に違う要素を1つ、そのあと同じ要素を `times` 回並べた、閉じていない答え */
function runaway(times: number): string {
  const items = [issue(1, "一件目")];
  for (let i = 0; i < times; i++) items.push(issue(2, "繰り返し"));
  return `{\n  "issues": [\n${items.join(",\n")},\n    {\n      "line": 2,\n      "original": "本文`;
}

describe("同じ要素が続いたら止める", () => {
  it(`同じ要素が ${REPEATED_ELEMENT_LIMIT} 回続いたら止め、繰り返しの1つ目まで残す`, () => {
    const text = runaway(20);
    const stop = findRepetition(text);
    expect(stop).toBeDefined();
    // 1件目（違う要素）＋繰り返しの1つ目 = 2件を残す
    expect(stop?.kept).toBe(2);
    expect(stop?.stoppedAt).toBe(1 + REPEATED_ELEMENT_LIMIT);

    const salvaged = salvageRepetition(text, stop!);
    expect(salvaged).toBeDefined();
    const parsed = JSON.parse(salvaged!) as { issues: Array<{ suggestion: string }> };
    expect(parsed.issues.map((x) => x.suggestion)).toEqual(["一件目", "繰り返し"]);
  });

  it("しきい値の1回手前までは止めない", () => {
    // 同じ要素が LIMIT-1 回で、そのあと違う要素が続く
    const items = [issue(1, "一件目")];
    for (let i = 0; i < REPEATED_ELEMENT_LIMIT - 1; i++) items.push(issue(2, "同じ"));
    items.push(issue(3, "別"));
    const text = `{"issues":[${items.join(",")}]}`;
    expect(findRepetition(text)).toBeUndefined();
  });

  it("違う要素が続くだけなら止めない", () => {
    const items = Array.from({ length: 40 }, (_, i) => issue(i + 1, `直し${i}`));
    const text = `{"issues":[${items.join(",")}]}`;
    expect(findRepetition(text)).toBeUndefined();
  });

  it("字下げや改行の違いだけでは、別の要素と見なさない", () => {
    const one = { line: 5, target: "あ", suggestion: "い" };
    const variants = [
      JSON.stringify(one),
      JSON.stringify(one, null, 2),
      JSON.stringify(one, null, 4),
      JSON.stringify(one),
      JSON.stringify(one, null, 1),
    ];
    const stop = findRepetition(`{"issues":[${variants.join(",")}`);
    expect(stop?.kept).toBe(1);
  });

  it("中身の文字列の空白が違えば、別の要素と見なす", () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ target: "あ", suggestion: `い${" ".repeat(i)}` })
    );
    expect(findRepetition(`{"issues":[${items.join(",")}]}`)).toBeUndefined();
  });

  it("文字列の中の括弧や逆斜線に惑わされない", () => {
    const tricky = JSON.stringify({ target: '{"[\\', suggestion: "}]\"" });
    const items = Array.from({ length: REPEATED_ELEMENT_LIMIT }, () => tricky);
    const text = `{"issues":[${items.join(",")}`;
    const stop = findRepetition(text);
    expect(stop?.kept).toBe(1);
    const parsed = JSON.parse(salvageRepetition(text, stop!)!) as {
      issues: unknown[];
    };
    expect(parsed.issues).toHaveLength(1);
  });

  it("断片が届くたびに続きから読んでも、まとめて読んだときと同じ所で止める", () => {
    const text = runaway(12);
    const watch = newRepetitionWatch();
    let stop;
    // 7字ずつ届く（文字列の途中・エスケープの途中で切れる）
    for (let end = 7; end <= text.length + 7 && !stop; end += 7) {
      stop = watchRepetition(watch, text.slice(0, Math.min(end, text.length)));
    }
    expect(stop).toEqual(findRepetition(text));
  });

  it("入れ子の配列（矛盾検知の根拠の並びなど）でも同じ形で効く", () => {
    const evidence = JSON.stringify({ quote: "同じ根拠" });
    const inner = Array.from({ length: 8 }, () => evidence).join(",");
    const text = `{"findings":[{"kind":"矛盾","evidence":[${inner}`;
    const stop = findRepetition(text);
    expect(stop?.kept).toBe(1);
    const parsed = JSON.parse(salvageRepetition(text, stop!)!) as {
      findings: Array<{ evidence: unknown[] }>;
    };
    expect(parsed.findings[0].evidence).toHaveLength(1);
  });

  it("最も外側が配列の答えでも閉じられる", () => {
    const one = JSON.stringify({ a: 1 });
    const text = `[${JSON.stringify({ a: 0 })},${Array.from({ length: 6 }, () => one).join(",")}`;
    const stop = findRepetition(text);
    const parsed = JSON.parse(salvageRepetition(text, stop!)!) as unknown[];
    expect(parsed).toEqual([{ a: 0 }, { a: 1 }]);
  });

  it("ログの1行に、止めた件と残した件を書く", () => {
    const stop = findRepetition(runaway(20))!;
    expect(repetitionStopMessage(stop)).toContain(
      `同じ指摘を繰り返したため、${1 + REPEATED_ELEMENT_LIMIT}件目で受け取りを止めました`
    );
    expect(repetitionStopMessage(stop)).toContain("残せた指摘 2件");
  });
});

describe("実機の答え（gemma4:26b・温度0、2026-10-10）", () => {
  const rawPath = nodePath.resolve(
    __dirname,
    "../../../docs/measurements/2026-10-10-typo-runaway-raw.json"
  );
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8")) as {
    runs: Array<{ label: string; text: string; done_reason: string }>;
  };

  it("上限で切れた答えを、2件目の繰り返しで止めて読める形に戻せる", () => {
    const run = raw.runs[0];
    expect(run.done_reason).toBe("length");
    // 素のままでは読めない（これが「チャンクごと捨てられた」理由）
    expect(() => JSON.parse(run.text)).toThrow();

    const stop = findRepetition(run.text);
    expect(stop).toBeDefined();
    expect(stop?.kept).toBe(2);
    // 止めた位置は、上限（26,159字）よりずっと手前
    expect(stop!.cutAt).toBeLessThan(run.text.length / 10);

    const parsed = JSON.parse(salvageRepetition(run.text, stop!)!) as {
      issues: Array<{ suggestion: string }>;
    };
    expect(parsed.issues).toHaveLength(2);
  });

  it("止まった答え（温度0.3・31b など）は、どれも止めない", () => {
    for (const run of raw.runs.filter((r) => r.done_reason !== "length")) {
      expect(findRepetition(run.text), run.label).toBeUndefined();
    }
  });
});
