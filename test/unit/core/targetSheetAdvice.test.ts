import { describe, expect, test } from "vitest";
import {
  ADVICE_ITEM_MAX,
  buildTargetSheetAdviceMaterial,
  isSameAdviceInput,
  parseTargetSheetAdvice,
  parseTargetSheetAdviceRecord,
  type TargetSheetAdviceMaterial,
  type TargetSheetAdviceRecord,
} from "../../../src/core/targetSheetAdvice";
import {
  buildTargetSheetDoc,
  readAimTypes,
} from "../../../src/core/targetSheetDoc";
import { targetSheetFor } from "../../../src/core/targetSheet";
import {
  buildTargetSheetAdvicePrompt,
  targetSheetAdviceInstructions,
  TARGET_SHEET_ADVICE_RULES,
} from "../../../src/prompts/targetSheetAdvice";
import type { ReaderProfile } from "../../../src/models/readerProfile";

/**
 * ターゲットシートの助言（設計書6.108.4 の第3段、P-46）。
 *
 * 見張るのは、AI を信用しないための約束（実装ルール3）と、無理に助言を
 * 作らない約束（プロンプト設計書1.9）。
 *
 * - 材料：狙いと点数が揃わなければ組まない／理由の有無で頼み方が変わる
 * - 検算：指示語の返り・長すぎ・空・材料に無い数字と引用・逆の向きを捨てる
 * - 紙：合っている所を先に／寄せ方0件は「直す所は見当たりません」／材料が変われば断る
 */

/** 実像：読み慣れ2・読む姿勢5・求めるもの1（いちばん近いのは没入層） */
const PROFILE: ReaderProfile = {
  schemaVersion: "1",
  actual: {
    scores: { familiarity: 2, posture: 5, craving: 1 },
    evidence: [
      { axis: "posture", quote: "雨は三日やまなかった", from: "冒頭の本文" },
    ],
    basis: "第1〜3話・プロット",
    model: "gemma4:e4b",
    updatedAt: "2026-10-04T00:00:00.000Z",
  },
};

const WITH_REASON = "狙い：考察層\n理由：伏線を拾って読み返してくれる人に届けたい";
const WITHOUT_REASON = "狙い：考察層\n理由：";

function materialOf(block: string, profile: ReaderProfile = PROFILE): TargetSheetAdviceMaterial {
  const built = buildTargetSheetAdviceMaterial({ authorBlock: block, profile });
  if (!("material" in built)) throw new Error(`材料が組めない：${built.missing}`);
  return built.material;
}

describe("材料の組み立て", () => {
  test("狙いが無ければ組まない（AIを呼ばずに、狙いを選ぶよう案内する）", () => {
    expect(
      buildTargetSheetAdviceMaterial({ authorBlock: "狙い：\n理由：", profile: PROFILE })
    ).toEqual({ missing: "aim" });
    expect(
      buildTargetSheetAdviceMaterial({ authorBlock: undefined, profile: PROFILE })
    ).toEqual({ missing: "aim" });
  });

  test("点数が無ければ組まない（2段目か3段目を済ませるよう案内する）", () => {
    expect(
      buildTargetSheetAdviceMaterial({
        authorBlock: WITH_REASON,
        profile: { schemaVersion: "1" },
      })
    ).toEqual({ missing: "scores" });
  });

  test("理由があれば、理由そのものと「理由に沿って」の指示を渡す", () => {
    const material = materialOf(WITH_REASON);
    const prompt = buildTargetSheetAdvicePrompt(material);

    expect(material.reason).toBe("伏線を拾って読み返してくれる人に届けたい");
    expect(prompt).toContain("【作者が挙げた理由】\n伏線を拾って読み返してくれる人に届けたい");
    expect(prompt).toContain("作者の理由に沿って書いてください");
    expect(prompt).not.toContain("理由を推測して");
  });

  test("理由が無ければ、無いと書いて控えめに言わせる（理由を作らせない）", () => {
    const material = materialOf(WITHOUT_REASON);
    const prompt = buildTargetSheetAdvicePrompt(material);

    expect(material.reason).toBe("");
    expect(prompt).toContain("【作者が挙げた理由】\n（書かれていません）");
    expect(prompt).toContain("理由を推測して作者の考えとして書かないでください");
    expect(prompt).not.toContain("作者の理由に沿って書いてください");
  });

  test("渡す層の説明は狙いの層だけ（11層を並べない）", () => {
    const prompt = buildTargetSheetAdvicePrompt(materialOf(WITH_REASON));
    expect(prompt).toContain("考察層（一致度");
    expect(prompt).not.toContain("すきま層");
  });

  test("寄せてよい向きは、狙いの中心へ向かう向き（機械が決める）", () => {
    // 考察層の中心は 読み慣れ6・読む姿勢3・求めるもの0。いまは 2・5・1
    const material = materialOf(WITH_REASON);
    expect(material.allowed.familiarity).toContain("up");
    expect(material.allowed.posture).toContain("down");
    // 求めるもの（1 と 0）は2点未満なので、狙いへのずれとしては動かさない
    expect(material.allowed.familiarity).not.toContain("down");
  });

  test("本文から読み取れなかった軸（根拠が無く3に置かれた軸）へは寄せさせない", () => {
    // 実像：読み慣れ3（根拠なし）・読む姿勢5（根拠あり）・求めるもの1
    const material = materialOf(WITH_REASON, {
      ...PROFILE,
      actual: { ...PROFILE.actual!, scores: { familiarity: 3, posture: 5, craving: 1 } },
    });
    const prompt = buildTargetSheetAdvicePrompt(material);

    expect(material.unmeasured).toEqual(["familiarity"]);
    expect(material.allowed.familiarity).toBeUndefined();
    expect(prompt).toContain("本文から読み取れなかった軸です");
    expect(prompt).not.toContain("axis: familiarity");
  });

  test("書き方の判断（宣言）の点には、読み取れなかった軸は無い", () => {
    const material = materialOf(WITH_REASON, {
      schemaVersion: "1",
      declared: {
        scores: { familiarity: 3, posture: 3, craving: 3 },
        answers: [1, 1, 1, 1, 1, 1, 1, 1, 1],
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    });
    expect(material.unmeasured).toEqual([]);
  });

  test("材料の文に向きの英語の値を書かない（欄の組み合わせだけに置く）", () => {
    const prompt = buildTargetSheetAdvicePrompt(materialOf(WITH_REASON));
    const before = prompt.slice(0, prompt.indexOf("【寄せてよい軸と向き】"));
    expect(before).not.toMatch(/\b(?:up|down)\b/);
    expect(prompt).toContain("axis: familiarity ／ direction: up");
  });

  test("指紋は、理由を変えると変わり、同じ材料なら変わらない", () => {
    const first = materialOf(WITH_REASON).mark;
    expect(materialOf(WITH_REASON).mark).toBe(first);
    expect(materialOf(WITHOUT_REASON).mark).not.toBe(first);
    expect(
      materialOf(WITH_REASON, {
        ...PROFILE,
        actual: { ...PROFILE.actual!, scores: { familiarity: 6, posture: 5, craving: 1 } },
      }).mark
    ).not.toBe(first);
  });
});

describe("出力の検査", () => {
  const material = materialOf(WITH_REASON);
  const sent = buildTargetSheetAdvicePrompt(material);
  const rules = targetSheetAdviceInstructions();
  const parse = (value: unknown) => parseTargetSheetAdvice(value, material, sent, rules);

  test("形の合う答えは、そのまま採る", () => {
    const parsed = parse({
      overall: "読み慣れの軸だけが狙いから離れています。",
      keep: ["読む姿勢の高さは、考察層の読み返しに合っています。"],
      advice: [
        {
          axis: "familiarity",
          direction: "up",
          text: "伏線を拾う人に届けたいなら、お約束の説明を減らして読み尽くした人向けに寄せられます。",
        },
      ],
    });
    expect(parsed.usable).toBe(true);
    expect(parsed.keep).toHaveLength(1);
    expect(parsed.advice).toEqual([
      expect.objectContaining({ axis: "familiarity", direction: "up" }),
    ]);
    expect(parsed.dropped).toBe(0);
  });

  test("指示の言葉がそのまま返ってきたら捨てる", () => {
    const parsed = parse({
      overall: "総評",
      keep: ["特になし", "合っている所", `（${ADVICE_ITEM_MAX}字以内）`, "空文字"],
      advice: [{ axis: "familiarity", direction: "up", text: TARGET_SHEET_ADVICE_RULES[3] }],
    });
    expect(parsed.overall).toBe("");
    expect(parsed.keep).toEqual([]);
    expect(parsed.advice).toEqual([]);
    expect(parsed.usable).toBe(false);
    expect(parsed.dropped).toBe(6);
  });

  test("長すぎる文は上限で切り、印を付ける", () => {
    const long = "読む姿勢の高さが狙いの層に合っています。".repeat(10);
    const parsed = parse({ overall: "", keep: [long], advice: [] });
    expect([...parsed.keep[0]].length).toBe(ADVICE_ITEM_MAX + 1);
    expect(parsed.keep[0].endsWith("…")).toBe(true);
  });

  test("空の答えは使えない（載せる中身が1つも無い）", () => {
    expect(parse({ overall: "", keep: [], advice: [] }).usable).toBe(false);
    expect(parse("ただの文").usable).toBe(false);
    expect(parse(null).usable).toBe(false);
  });

  test("寄せ方が0件でも、合っている所があれば正常（無理に助言を作らせない）", () => {
    const parsed = parse({
      overall: "狙いと実像はおおむね揃っています。",
      keep: ["読む姿勢の高さが、腰を据えて読む考察層に合っています。"],
      advice: [],
    });
    expect(parsed.usable).toBe(true);
    expect(parsed.advice).toEqual([]);
  });

  test("材料に無い数字は、その項目ごと捨てる（数字を作らせない）", () => {
    const parsed = parse({
      overall: "一致度は75%です。",
      keep: ["読む姿勢は5で、狙いに近いです。"],
      advice: [],
    });
    expect(parsed.overall).toBe("");
    expect(parsed.keep).toEqual(["読む姿勢は5で、狙いに近いです。"]);
    expect(parsed.notes.join("\n")).toContain("材料に無い数字");
  });

  test("材料に無い引用（書き換えの文例）は捨てる", () => {
    const parsed = parse({
      overall: "",
      keep: ["冒頭の「雨は三日やまなかった」が、腰を据えて読む人に合っています。"],
      advice: [
        {
          axis: "familiarity",
          direction: "up",
          text: "冒頭を「魔導の理はすでに知られている」と書き直すと寄ります。",
        },
      ],
    });
    expect(parsed.keep).toHaveLength(1);
    expect(parsed.advice).toEqual([]);
    expect(parsed.notes.join("\n")).toContain("材料に無い引用");
  });

  test("逆の向き・材料に無い軸は捨てる（向きは機械が決める）", () => {
    const parsed = parse({
      overall: "",
      keep: [],
      advice: [
        { axis: "familiarity", direction: "down", text: "説明を増やしましょう。" },
        { axis: "craving", direction: "up", text: "揺さぶりを強めましょう。" },
        { axis: "posture", direction: "down", text: "1話を短くして隙間に読める形へ寄せられます。" },
      ],
    });
    expect(parsed.advice.map((item) => item.axis)).toEqual(["posture"]);
    expect(parsed.dropped).toBe(2);
  });

  test("向きや軸の英語の値が文に入っていたら捨てる（2026-10-04 の e4b）", () => {
    const parsed = parse({
      overall: "",
      keep: [],
      advice: [
        { axis: "familiarity", direction: "up", text: "「読み慣れ」を「up」に寄せることで考察層に近づきます。" },
      ],
    });
    expect(parsed.advice).toEqual([]);
    expect(parsed.notes.join("\n")).toContain("欄の値がそのまま文に入っていました（up）");
  });

  test("短いカギ括弧は強調として通す（引用の照合は長いものだけ）", () => {
    const parsed = parse({
      overall: "「気軽さ」を足すより、いまの腰の据わりを活かす方向です。",
      keep: [],
      advice: [],
    });
    expect(parsed.overall).toContain("「気軽さ」");
  });

  test("材料の言葉の末尾だけ活用が違う写しは通す（2026-10-04 の e4b）", () => {
    // 層の説明は「伏線を拾い、読み返し、辻褄を見ています」
    const parsed = parse({
      overall: "",
      keep: [],
      advice: [
        {
          axis: "familiarity",
          direction: "up",
          text: "読み慣れを上げると、「伏線を拾い、読み返し、辻褄を見る」読者に届きます。",
        },
      ],
    });
    expect(parsed.advice).toHaveLength(1);
  });

  test("同じ軸への2件目は捨てる（軸1本ずつ）", () => {
    const parsed = parse({
      overall: "",
      keep: [],
      advice: [
        { axis: "familiarity", direction: "up", text: "お約束の説明を減らせます。" },
        { axis: "familiarity", direction: "up", text: "用語の説明も省けます。" },
      ],
    });
    expect(parsed.advice).toHaveLength(1);
    expect(parsed.dropped).toBe(1);
  });
});

describe("記録と作り直しの判断", () => {
  const record: TargetSheetAdviceRecord = {
    schemaVersion: "1",
    generatedAt: "2026-10-04T12:00:00.000Z",
    providerId: "ollama",
    model: "gemma4:e4b",
    promptVersion: "1.0",
    materialMark: "abc123",
    aims: ["lore_deep"],
    reasonGiven: true,
    source: "actual",
    overall: "読み慣れの軸だけが離れています。",
    keep: ["読む姿勢が合っています。"],
    advice: [{ axis: "familiarity", direction: "up", text: "説明を減らせます。" }],
    dropped: 1,
  };

  test("書いた記録は、そのまま読み戻せる", () => {
    expect(parseTargetSheetAdviceRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  test("形の合わない記録は読まない（直さない）", () => {
    expect(parseTargetSheetAdviceRecord({ ...record, source: "unknown" })).toBeUndefined();
    expect(parseTargetSheetAdviceRecord({ ...record, aims: ["誰か"] })).toBeUndefined();
    expect(parseTargetSheetAdviceRecord({ ...record, materialMark: undefined })).toBeUndefined();
  });

  test("材料・AI・モデル・版が同じときだけ、作り直さない", () => {
    const same = {
      materialMark: "abc123",
      providerId: "ollama",
      model: "gemma4:e4b",
      promptVersion: "1.0",
    };
    expect(isSameAdviceInput(record, same)).toBe(true);
    expect(isSameAdviceInput(record, { ...same, materialMark: "zzz" })).toBe(false);
    expect(isSameAdviceInput(record, { ...same, model: "gemma4:26b" })).toBe(false);
    expect(isSameAdviceInput(record, { ...same, providerId: "lmstudio" })).toBe(false);
    expect(isSameAdviceInput(record, { ...same, promptVersion: "1.1" })).toBe(false);
    expect(isSameAdviceInput(undefined, same)).toBe(false);
  });
});

describe("紙に出る形", () => {
  const scores = PROFILE.actual!.scores;
  const build = (advice: Parameters<typeof buildTargetSheetDoc>[0]["advice"]) =>
    buildTargetSheetDoc({
      workTitle: "テスト作品",
      sheet: targetSheetFor({ aim: readAimTypes(WITH_REASON), scores }),
      authorBlock: WITH_REASON,
      source: "actual",
      advice,
      generatedAt: new Date("2026-10-04T12:30:00"),
    });
  const base: TargetSheetAdviceRecord = {
    schemaVersion: "1",
    generatedAt: "2026-10-04T12:00:00.000Z",
    providerId: "ollama",
    model: "gemma4:e4b",
    promptVersion: "1.0",
    materialMark: "m1",
    aims: ["lore_deep"],
    reasonGiven: true,
    source: "actual",
    overall: "読み慣れの軸だけが離れています。",
    keep: ["読む姿勢が合っています。"],
    advice: [{ axis: "familiarity", direction: "up", text: "説明を減らせます。" }],
    dropped: 0,
  };

  function adviceOf(doc: string): string {
    const start = doc.indexOf("## 助言");
    const end = doc.indexOf("\n## ", start + 1);
    return doc.slice(start, end < 0 ? undefined : end);
  }

  test("合っている所が寄せ方より先に出て、寄せ方には軸と向きが付く", () => {
    const section = adviceOf(build({ record: base, currentMark: "m1" }));
    expect(section.indexOf("### 狙いに合っている所")).toBeLessThan(
      section.indexOf("### 寄せ方")
    );
    expect(section).toContain("- 読む姿勢が合っています。");
    expect(section).toContain("**読み慣れを上げる**（「読み尽くしている」の側へ）　説明を減らせます。");
    expect(section).toContain("（gemma4:e4b）");
    expect(section).not.toContain("変わっています");
  });

  test("寄せ方が0件なら「直す所は見当たりません」と明記する", () => {
    const section = adviceOf(build({ record: { ...base, advice: [] }, currentMark: "m1" }));
    expect(section).toContain("**直す所は見当たりません。**");
  });

  test("寄せ方を検算で全部落としたときは「見当たりません」と言い切らない", () => {
    const section = adviceOf(
      build({ record: { ...base, advice: [], dropped: 2 }, currentMark: "m1" })
    );
    expect(section).not.toContain("直す所は見当たりません");
    expect(section).toContain("載せられる寄せ方がありませんでした");
  });

  test("作ったあとに材料が変われば、そう断る", () => {
    const section = adviceOf(build({ record: base, currentMark: "m2" }));
    expect(section).toContain("狙い・理由・点数のどれかが変わっています");
  });

  test("捨てた項目があれば、件数を断る", () => {
    const section = adviceOf(build({ record: { ...base, dropped: 2 }, currentMark: "m1" }));
    expect(section).toContain("2件は、材料に無い数字や引用");
  });

  test("理由が無いまま作った助言は、そう添える", () => {
    const section = adviceOf(build({ record: { ...base, reasonGiven: false }, currentMark: "m1" }));
    expect(section).toContain("理由（書かれていません）");
  });
});
