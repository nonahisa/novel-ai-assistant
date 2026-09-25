import { describe, expect, it } from "vitest";
import {
  PLOT_NAME_SUGGEST_COUNT,
  PLOT_NAME_SUGGEST_HINTS,
  buildPlotNameSuggestPrompt,
  buildPlotNameSuggestSchema,
  parsePlotNameSuggestAnswer,
} from "../../../src/prompts/plotNameSuggest";
import { planNameOrigin } from "../../../src/core/nameOriginFit";

/**
 * P-45 プロットの役名だけの人物に名前の候補をまとめて出す（設計書6.4.8）。
 *
 * **指示の言葉は、そのまま答えとして返ってくる前提で読む**
 * （CLAUDE.md「繰り返し起きた失敗」3番）。
 */
const PEOPLE = [
  { id: "1", role: "主人公", summary: "冒険者試験に落ちた新人" },
  { id: "2", role: "ヒロイン", summary: "伸び悩む新人配信者" },
];

describe("プロンプト", () => {
  const prompt = buildPlotNameSuggestPrompt({
    workTitle: "現代ダンジョンのインフラ担当",
    setting: "現代。各地にダンジョンが出現した",
    existingNames: [],
    people: PEOPLE,
    plan: planNameOrigin({ existingNames: [], setting: "" }),
  });

  it("人物ごとの id・役名・説明と、1人あたりの件数を渡す", () => {
    expect(prompt).toContain("id：1\n役名：主人公\n説明：冒険者試験に落ちた新人");
    expect(prompt).toContain("id：2\n役名：ヒロイン");
    expect(prompt).toContain(`1人につき${PLOT_NAME_SUGGEST_COUNT}件ずつ`);
  });

  it("全員を同じ系統で出すよう頼む", () => {
    expect(prompt).toContain("全員をその1つだけで出してください");
  });

  it("指示文に書いた語は、答えから弾く語の一覧と同じもの", () => {
    for (const hint of PLOT_NAME_SUGGEST_HINTS) {
      expect(prompt).toContain(`「${hint}」`);
    }
  });

  it("現代ものの和風の見立ては、コードが決めた系統と根拠として渡す（指示文で頼まない）", () => {
    // 実例（現代ダンジョン）で e4b も 26b もドイツと見立てた（2026-09-25）。
    // 1.1 から見立てはコード（`planNameOrigin`）が行い、名前点検と同じ決め方にする
    const setting = "現代。各地にダンジョンが出現した";
    const modern = buildPlotNameSuggestPrompt({
      workTitle: "現代ダンジョンのインフラ担当",
      setting,
      existingNames: [],
      people: PEOPLE,
      plan: planNameOrigin({ existingNames: [], setting }),
    });
    expect(modern).toContain("【系統】\n和風（この作品に合わせて決めました。根拠：世界観に「現代」とあり");
    expect(modern).toContain("origin と、各候補の origin には「和風」と書いてください。");
    // 手がかりの無い作品にも、和風へ寄せる一文を添えない（決め方を2つにしない）
    for (const text of [modern, prompt]) {
      expect(text).not.toContain("和風と見立ててください");
    }
  });

  it("材料が無い欄は「（未設定）」と書く", () => {
    const empty = buildPlotNameSuggestPrompt({
      workTitle: "題",
      setting: "",
      existingNames: [],
      people: [{ id: "1", role: "魔物", summary: "" }],
      plan: planNameOrigin({ existingNames: [], setting: "" }),
    });
    expect(empty).toContain("説明：（未設定）");
  });
});

describe("スキーマ", () => {
  it("すべて required で、系統を人物より先に置く", () => {
    const schema = buildPlotNameSuggestSchema(["和風"]);
    expect(schema.required).toEqual(["origin", "people"]);
    expect(Object.keys(schema.properties)).toEqual(["origin", "people"]);
    expect(schema.properties.origin.enum).toEqual(["和風"]);
    const person = schema.properties.people.items;
    expect(person.required).toEqual(["id", "candidates"]);
    expect(person.properties.candidates.items.required).toEqual([
      "name",
      "reading",
      "origin",
      "note",
    ]);
  });
});

describe("答えを読む", () => {
  it("id で人物に当て、指示の言葉は名前として採らない", () => {
    const answer = parsePlotNameSuggestAnswer(
      JSON.stringify({
        origin: "和風",
        people: [
          {
            id: "1",
            candidates: [
              { name: "相馬 誠", reading: "そうま まこと", origin: "和風", note: "" },
              { name: "役名", reading: "やくめい", origin: "和風", note: "" },
              { name: "名前", reading: "なまえ", origin: "和風", note: "" },
            ],
          },
          {
            id: 2,
            candidates: [{ name: "白井 澪", reading: "しらい みお", origin: "和風", note: "" }],
          },
        ],
      }),
      ["1", "2"]
    );

    expect(answer.origin).toBe("和風");
    expect(answer.people.get("1")?.map((entry) => entry.name)).toEqual(["相馬 誠"]);
    expect(answer.people.get("2")?.map((entry) => entry.name)).toEqual(["白井 澪"]);
    expect(answer.unmatched).toBe(0);
  });

  it("渡していない id の答えは捨てて数える。「id：１」のような形も読む", () => {
    const answer = parsePlotNameSuggestAnswer(
      "```json\n" +
        JSON.stringify({
          origin: "和風",
          people: [
            { id: "id：１", candidates: [{ name: "相馬 誠", reading: "", origin: "", note: "" }] },
            { id: "9", candidates: [{ name: "誰か", reading: "", origin: "", note: "" }] },
          ],
        }) +
        "\n```",
      ["1"]
    );
    expect(answer.people.get("1")?.map((entry) => entry.name)).toEqual(["相馬 誠"]);
    expect(answer.unmatched).toBe(1);
  });

  it("id が読めない答えは、並びの位置で当てる（gemma4:26b が「،」を返した）", () => {
    const answer = parsePlotNameSuggestAnswer(
      JSON.stringify({
        origin: "和風",
        people: [
          { id: "،", candidates: [{ name: "結城 糸", reading: "ゆうき いと", origin: "和風", note: "" }] },
          { id: "،", candidates: [{ name: "浅葱 紬", reading: "あさぎ つむぎ", origin: "和風", note: "" }] },
        ],
      }),
      ["1", "2"]
    );
    expect(answer.people.get("1")?.map((entry) => entry.name)).toEqual(["結城 糸"]);
    expect(answer.people.get("2")?.map((entry) => entry.name)).toEqual(["浅葱 紬"]);
    expect(answer.byOrder).toBe(2);
  });

  it("その位置の人物が id で当たっていれば、位置では当てない（別の人の候補を混ぜない）", () => {
    const answer = parsePlotNameSuggestAnswer(
      JSON.stringify({
        origin: "和風",
        people: [
          { id: "?", candidates: [{ name: "誰か", reading: "だれか", origin: "和風", note: "" }] },
          { id: "1", candidates: [{ name: "相馬 誠", reading: "そうま まこと", origin: "和風", note: "" }] },
        ],
      }),
      ["1", "2"]
    );
    expect(answer.people.get("1")?.map((entry) => entry.name)).toEqual(["相馬 誠"]);
    expect(answer.people.has("2")).toBe(false);
    expect(answer.unmatched).toBe(1);
  });

  it("読めない答えは空で返す", () => {
    const answer = parsePlotNameSuggestAnswer("候補は次のとおりです", ["1"]);
    expect(answer.people.size).toBe(0);
  });
});
