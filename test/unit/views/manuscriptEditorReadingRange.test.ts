import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";
import { buildReadingPlan, readingRangesOf } from "../../../src/core/readAloud";

/**
 * ［▶ 読む］の読み始め（2026-11-08 作者の答え。設計書6.42）。
 *
 * **カーソルが飛ばす欄（頭の欄・前書き・後書き）の中にあるときは、本文の頭
 * （題があれば題）から読む。** 計画からは外れているので、今の探し方のままだと、
 * 後書きの中のカーソルは「最後の文」に当たってしまう。
 *
 * 画面の台本から読み始めを決める関数を取り出し、拡張機能が作った計画と範囲を
 * 渡して確かめる（音は鳴らさない）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const script = html.slice(
  html.indexOf(">", html.indexOf('<script nonce="NONCE123">')) + 1,
  html.lastIndexOf("</script>")
);

/** 中括弧の対応を数えて関数を1つ切り出す（chroniclePanelHtml.test.ts と同じ手） */
function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let index = head; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
      started = true;
    } else if (source[index] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, index + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

const TEXT = [
  "【タイトル】",
  "第一話　はじまり",
  "",
  "【公開状態】",
  "下書き",
  "",
  "【本文】",
  "朝が来た。灯は窓を開けた。",
  "",
  "【後書き】",
  "次回もお楽しみに。",
].join("\n");

type Plan = ReturnType<typeof buildReadingPlan>;
type Ranges = ReturnType<typeof readingRangesOf>;

function indexAt(plan: Plan, ranges: Ranges, offset: number): number {
  const make = new Function(
    "aloudPlan",
    "aloudReadable",
    extractFunction(script, "aloudIndexAt") + "\nreturn aloudIndexAt;"
  ) as (plan: Plan, ranges: Ranges) => (offset: number) => number;
  return make(plan, ranges)(offset);
}

describe("カーソルが飛ばす欄の中なら、題から読む", () => {
  const plan = buildReadingPlan(TEXT, "site");
  const ranges = readingRangesOf(TEXT);

  it("頭の欄（【公開状態】の中）にカーソル → 題から", () => {
    expect(indexAt(plan, ranges, TEXT.indexOf("下書き"))).toBe(0);
    expect(plan[0].speech).toBe("第一話　はじまり");
  });

  it("後書きの中にカーソル → 題から（最後の文ではない）", () => {
    expect(indexAt(plan, ranges, TEXT.indexOf("お楽しみ"))).toBe(0);
  });

  it("【タイトル】の見出しの行にカーソル → 題から", () => {
    expect(indexAt(plan, ranges, 2)).toBe(0);
  });

  it("本文の中にカーソル → その文から（今までどおり）", () => {
    const at = TEXT.indexOf("灯は");
    expect(plan[indexAt(plan, ranges, at)].speech).toBe("灯は窓を開けた。");
  });

  it("範囲の無い原稿は、今までどおり（末尾の先なら最後の文）", () => {
    const plain = "朝が来た。\n灯は窓を開けた。\n";
    const p = buildReadingPlan(plain, "site");
    expect(readingRangesOf(plain)).toBeNull();
    expect(indexAt(p, null, plain.length)).toBe(p.length - 1);
    expect(indexAt(p, null, plain.indexOf("灯"))).toBe(1);
  });

  it("ノートPCの .md の第1話（行数つきの【本文（24行）】）で、【公開状態】の中のカーソル → 題から（0.147.1）", () => {
    // 2026-11-09 ノートPCの実機確認の形。原稿エディターへ届く字は LF（toLf）。人物の声の道と同じく台詞でも切る
    const md = [
      "【タイトル】",
      "第1話　気がついたら幽霊に",
      "",
      "【公開状態】",
      "公開済",
      "",
      "【作成日時】",
      "2023-12-05 23:49:38（+09:00）",
      "",
      "【文字数】",
      "517文字",
      "",
      "【本文（24行）】",
      "「おや、太志じゃないか。死んでしまうとは情けないね」",
    ].join("\n");
    for (const voiced of [false, true]) {
      const p = buildReadingPlan(md, "curly", [], voiced ? { splitDialogue: true } : {});
      const at = indexAt(p, readingRangesOf(md), md.indexOf("公開済"));
      expect(at).toBe(0);
      expect(p[at].speech).toBe("第1話　気がついたら幽霊に");
      expect(p.map((s) => s.speech).join("")).not.toMatch(/公開|2023|517/);
    }
  });

  it("届いた計画の範囲を控える（拡張機能が readable を添えて送る）", () => {
    const take = extractFunction(script, "aloudTakePlan");
    expect(take).toContain("message.readable");
    expect(script).toContain("let aloudReadable = null;");
  });
});
