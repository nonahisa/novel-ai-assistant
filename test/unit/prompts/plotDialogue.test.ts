import { describe, expect, it } from "vitest";
import {
  buildPlotDialoguePrompt,
  buildPlotDialogueSystemPrompt,
  PLOT_DIALOGUE_SCHEMA,
  PLOT_DIALOGUE_SYSTEM_PROMPT,
} from "../../../src/prompts/plotDialogue";
import {
  PLOT_DIALOGUE_LIMITS,
  validatePlotDialogueAnswer,
} from "../../../src/core/plotDialogueValidation";
import { PLOT_DIALOGUE_SECTIONS } from "../../../src/core/plotInterview";
import {
  nextFixedPoint,
  nextGuidedPoint,
  PLOT_DIALOGUE_STYLES,
  plotFrame,
} from "../../../src/core/plotDialogueStyles";
import { emptyPlotSections } from "../../../src/core/plotDoc";

/**
 * P-43 対話式プロット作成のプロンプト（設計書6.4.7）。
 */

describe("システムの指示", () => {
  it("字数と候補の数は、検算の定数から埋め込む（2か所に書かない）", () => {
    const L = PLOT_DIALOGUE_LIMITS;
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain(`${L.candidatesMin}〜${L.candidatesMax}個`);
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain(`${L.question}字以内`);
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain(`${L.effect}字以内`);
  });

  it("書く先の鍵を全部並べる", () => {
    for (const section of PLOT_DIALOGUE_SECTIONS) {
      expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain(`- ${section.key}：`);
    }
  });

  it("どの型でも、共通の決まりは同じ（決めるのは作者・問いは1つ・繰り返さない・汎用の文句を候補にしない・確かめ直しは1回）", () => {
    for (const { key } of PLOT_DIALOGUE_STYLES) {
      const prompt = buildPlotDialogueSystemPrompt(key);
      expect(prompt, key).toContain("決めるのは作者です");
      expect(prompt, key).toContain("問いは1回に1つだけ");
      expect(prompt, key).toContain("二度と尋ねないこと");
      expect(prompt, key).toContain("一般的な文句");
      expect(prompt, key).toContain("確かめ直しは1回まで");
      expect(prompt, key).toContain("effect");
    }
  });

  it("型ごとに次の1点の選び方が違う", () => {
    expect(buildPlotDialogueSystemPrompt("idea")).toContain("尋ねる順は決まっていません");
    expect(buildPlotDialogueSystemPrompt("scene")).toContain("場面の直前・場面に至る理由・場面のその後");
    expect(buildPlotDialogueSystemPrompt("ending")).toContain("結末を変える候補や、結末を疑う問いを出さないこと");
    expect(buildPlotDialogueSystemPrompt("structure")).toContain("「次に埋める枠」に書いてある枠1つだけ");
    expect(buildPlotDialogueSystemPrompt("fields")).toContain("「次に埋める項目」に書いてある項目1つだけ");
    // 着想から掘る型の指示は、0.86.2 からの名前でも取れる
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toBe(buildPlotDialogueSystemPrompt("idea"));
  });

  it("目標の文字数と大きな流れも、問答の中で決める（AIが1点を選ぶ型）", () => {
    for (const key of ["idea", "scene", "ending"] as const) {
      expect(buildPlotDialogueSystemPrompt(key), key).toContain("目標の文字数");
      // コードが割り込んで決めた1点（場面の3点・目標の文字数）は、それだけを尋ねさせる
      expect(buildPlotDialogueSystemPrompt(key), key).toContain("「次に尋ねる1点」があるときは、その1点だけを尋ねること");
    }
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain("どんでん返し");
  });
});

describe("指示の言葉がそのまま返ってきたら受け取らない（CLAUDE.md 失敗3）", () => {
  it("指示の鍵の言い回しを、そのまま問いに入れた答えは捨てる", () => {
    for (const echoed of [
      "いま決めると話が一番広がる1点",
      "話を外へ広げる1点",
      "結末が成り立つのに欠かせない1点",
      "次に埋める枠",
      "次に尋ねる1点",
    ]) {
      const text = JSON.stringify({
        mode: "ask",
        confirm: "",
        topic: "最強の理由",
        question: echoed,
        why: "",
        candidates: ["回線が魔力も運ぶ", "地図を握っている", "配信が命綱"],
        section: "worldview",
      });
      expect(validatePlotDialogueAnswer(text, { asked: [] }).ok, echoed).toBe(false);
    }
  });

  it("指示に書いた言い回しは、検算の止める言葉に入っている", () => {
    // プロンプトの言葉を変えたら、ここで検算の一覧と食い違いに気づく
    expect(buildPlotDialogueSystemPrompt("scene")).toContain("話を外へ広げる1点");
    expect(buildPlotDialogueSystemPrompt("ending")).toContain("結末が成り立つのに欠かせない1点");
    expect(buildPlotDialogueSystemPrompt("structure")).toContain("その枠に入る出来事");
    expect(buildPlotDialogueSystemPrompt("fields")).toContain("その項目に入る中身");
  });
});

describe("作者側の材料", () => {
  const base = {
    workTitle: "回線の街",
    idea: "配信のための通信線を敷く業者が最強",
    writtenPlot: "",
    decisions: [],
    asked: [],
  };

  it("最初の回は、着想を書いたところだと伝える", () => {
    const prompt = buildPlotDialoguePrompt(base);
    expect(prompt).toContain("配信のための通信線を敷く業者が最強");
    expect(prompt).toContain("（作者は着想を書いたところです）");
    expect(prompt).toContain("# ここまでに決まったこと（作者の答え）\n（まだありません）");
    expect(prompt).toContain("# 問答の型\n着想から掘る");
  });

  it("型ごとに、最初に書いたものの見出しが変わる", () => {
    const scene = buildPlotDialoguePrompt({ ...base, style: "scene", idea: "中級エリアで配線が切れる" });
    expect(scene).toContain("# 作者が書きたい場面\n中級エリアで配線が切れる");
    expect(scene).toContain("（作者は書きたい場面を書いたところです）");
    const ending = buildPlotDialoguePrompt({ ...base, style: "ending", idea: "班長はただの電気工事士" });
    expect(ending).toContain("# 作者が決めている結末\n班長はただの電気工事士");
  });

  it("決まったこと・尋ねたこと（飛ばしたものも）・直前の答えを渡す", () => {
    const prompt = buildPlotDialoguePrompt({
      ...base,
      decisions: [{ topic: "最強の理由", answer: "回線が魔力も運ぶ", section: "worldview" }],
      asked: [
        { topic: "最強の理由", question: "なぜ最強？", skipped: false },
        { topic: "舞台", question: "どこで動く？", skipped: true },
      ],
      lastAnswer: { topic: "最強の理由", answer: "回線が魔力も運ぶ" },
    });
    expect(prompt).toContain("- 【最強の理由】回線が魔力も運ぶ");
    expect(prompt).toContain("- 最強の理由：なぜ最強？");
    expect(prompt).toContain("- 舞台：どこで動く？（作者は飛ばした）");
    expect(prompt).toContain("# 作者の直前の答え\n【最強の理由】回線が魔力も運ぶ");
  });

  it("プロットから始めたときは、着想の欄でそう伝える", () => {
    const prompt = buildPlotDialoguePrompt({ ...base, idea: "", writtenPlot: "【ログライン】回線業者が最強" });
    expect(prompt).toContain("下のプロットに書いてあることから始めたい");
    expect(prompt).toContain("【ログライン】回線業者が最強");
  });

  it("頼み直しの一言を末尾に添える", () => {
    const prompt = buildPlotDialoguePrompt({ ...base, retryNote: "同じ問いでした。" });
    expect(prompt.endsWith("同じ問いでした。")).toBe(true);
  });

  it("確かめ直しを許さない回は、そう言う", () => {
    expect(buildPlotDialoguePrompt(base)).toContain("この回は確かめ直しをしないこと");
    expect(buildPlotDialoguePrompt({ ...base, mayClarify: true })).not.toContain(
      "この回は確かめ直しをしないこと"
    );
  });

  it("ほかの案のときは、問いを変えずに見せた案と違う案を頼む", () => {
    const prompt = buildPlotDialoguePrompt({
      ...base,
      more: { topic: "最強の理由", question: "なぜ最強？", shown: ["回線が魔力も運ぶ"] },
    });
    expect(prompt).toContain("「【最強の理由】なぜ最強？」について、ほかの案");
    expect(prompt).toContain("- 回線が魔力も運ぶ");
  });

  it("型に当てはめるときは、枠の並びと、次に埋める枠1つを渡す", () => {
    const frame = plotFrame("kishotenketsu");
    const fixedPoint = nextFixedPoint("structure", frame, [], emptyPlotSections(), new Map());
    const prompt = buildPlotDialoguePrompt({ ...base, style: "structure", frame, fixedPoint });
    expect(prompt).toContain("# 型の枠（この順に埋める）\n起承転結：起（");
    expect(prompt).toContain("# 次に埋める枠（ここだけを尋ねる）\n【起】");
    expect(prompt).toContain("【起】について、問いを1つと");
  });

  it("AIが選ぶ型でコードが割り込んだときは、「次に尋ねる1点」として渡す（並びは渡さない）", () => {
    const fixedPoint = nextGuidedPoint("scene", [], [], "");
    const prompt = buildPlotDialoguePrompt({ ...base, style: "scene", fixedPoint });
    expect(prompt).toContain("# 次に尋ねる1点（ここだけを尋ねる）\n【場面の直前】");
    expect(prompt).toContain("【場面の直前】について、問いを1つと");
    expect(prompt).not.toContain("# 型の枠");
    expect(prompt).not.toContain("# 項目の順");
  });

  it("項目を順に埋めるときは、項目の順と次に埋める項目を渡す", () => {
    const fixedPoint = nextFixedPoint("fields", undefined, [], emptyPlotSections(), new Map());
    const prompt = buildPlotDialoguePrompt({ ...base, style: "fields", fixedPoint });
    expect(prompt).toContain("# 項目の順\nログライン → テーマ → 世界観");
    expect(prompt).toContain("# 次に埋める項目（ここだけを尋ねる）\n【ログライン】");
  });
});

describe("答えの形", () => {
  it("書く先は選択肢で縛り、候補には上限（ほかの案の多いほう）を置く", () => {
    expect(PLOT_DIALOGUE_SCHEMA.properties.section.enum).toEqual(
      PLOT_DIALOGUE_SECTIONS.map((section) => section.key)
    );
    expect(PLOT_DIALOGUE_SCHEMA.properties.candidates.maxItems).toBe(
      PLOT_DIALOGUE_LIMITS.moreMax
    );
    expect(PLOT_DIALOGUE_SCHEMA.properties.mode.enum).toEqual(["ask", "clarify"]);
    expect([...PLOT_DIALOGUE_SCHEMA.required].sort()).toEqual(
      ["candidates", "confirm", "mode", "question", "section", "topic", "why"]
    );
    expect([...PLOT_DIALOGUE_SCHEMA.properties.candidates.items.required]).toEqual(["text", "effect"]);
  });
});
