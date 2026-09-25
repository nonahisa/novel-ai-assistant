import { describe, expect, test } from "vitest";
import {
  echoesInstruction,
  validateContradictions,
} from "../../../src/core/contradictionValidation";
import type { Chunk } from "../../../src/core/chunker";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT,
  LIGHT_CATEGORIES,
  SPEECH_CHECK_ITEM,
  SPEECH_JUDGE_NOTE,
  SPEECH_PRINCIPLE_NOTE,
} from "../../../src/prompts/contradictionCheck";

/**
 * 矛盾検知で、台詞を人物の設定の「一人称」「口調」と照らす（P-12 1.8。
 * 3巡目の測定、2026-09-25）。
 *
 * 人物に口調の欄を足したのに、口調の仕込み3件を e4b 0/3・26b 1/3 しか
 * 拾わなかった。プロンプトは「人物：一人称、口調、…」と1語並べていただけで、
 * 原則2「成長による口調の変化は矛盾ではない」だけが強く効いていた。
 */

describe("プロンプトに口調の照らし方が載る", () => {
  const prompt = buildContradictionCheckPrompt({
    chapterLabel: "第6話",
    chunkTextWithLineNumbers: "1: 「わたくし、この胡椒という粉が好きでございますわ」",
    characterDetails: "エルシー\n- 口調: 一人称は「ボク」。語尾に「〜です」",
    locationDetails: "",
    worldviewSummary: "",
    previousSynopses: "",
    categories: LIGHT_CATEGORIES,
  });

  test("検証項目の「人物」と判断の注意に、台詞の照らし方がある", () => {
    expect(prompt).toContain(SPEECH_CHECK_ITEM);
    expect(prompt).toContain(SPEECH_JUDGE_NOTE);
  });

  test("原則2の「口調の変化は矛盾ではない」に、きっかけの無い違いは挙げると添える", () => {
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT).toContain(SPEECH_PRINCIPLE_NOTE);
  });

  test("読み取る段では、設定の一人称と口調のまま言わせる", () => {
    expect(prompt).toContain("設定の一人称と口調のまま");
  });
});

/*
  小さいモデル（抑制版を送るモデル）には、口調の指示を送らない（P-12 1.9。
  作者の判断、2026-09-25）。1.8 で e4b は口調の仕込みを1件多く拾ったが、
  口調まわりの余計な指摘が増え、答え付きの台の当たりが減った。
  **文面は 1.7 と1文字も違わない形に戻す**（測った形を送るため）。
*/
describe("小さいモデルには口調の指示を送らない（1.9）", () => {
  const base = {
    chapterLabel: "第6話",
    chunkTextWithLineNumbers: "1: 「わたくし、この胡椒という粉が好きでございますわ」",
    characterDetails: "エルシー\n- 口調: 一人称は「ボク」。語尾に「〜です」",
    locationDetails: "",
    worldviewSummary: "",
    previousSynopses: "",
    categories: LIGHT_CATEGORIES,
  };
  const withSpeech = buildContradictionCheckPrompt(base);
  const without = buildContradictionCheckPrompt({ ...base, speechCheck: false });

  test("抑制版のシステムプロンプトには、原則2の口調の一行が無い", () => {
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT).not.toContain(SPEECH_PRINCIPLE_NOTE);
    // 行ごと消えている（空行や字下げだけが残っていない）
    expect(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT).toContain(
      "関係の変化に伴う呼び方の変化は矛盾ではない。\n3. **未回収の伏線は矛盾ではない。**"
    );
  });

  test("本文の3か所（検証項目・判断の注意・asThem）が外れる", () => {
    expect(without).not.toContain(SPEECH_CHECK_ITEM);
    expect(without).not.toContain(SPEECH_JUDGE_NOTE);
    expect(without).not.toContain("設定の一人称と口調のまま");
    expect(without).toContain("1. 人物：一人称、口調、性格、外見、能力が設定と食い違わないか\n");
    expect(without).toContain(
      "- asThem：**その人物になりきって、いまの自分の身の上を一人称で言う**（「俺は〜」「私は〜」）。"
    );
  });

  test("違いは口調の3か所だけ（ほかの文面は1文字も変わらない）", () => {
    const reverted = withSpeech
      .replace(`。${SPEECH_CHECK_ITEM}`, "")
      .replace(`\n- ${SPEECH_JUDGE_NOTE}`, "")
      .replace(
        "**その人物になりきって、設定の一人称と口調のまま、いまの自分の身の上を言う**。",
        "**その人物になりきって、いまの自分の身の上を一人称で言う**（「俺は〜」「私は〜」）。"
      );
    expect(without).toBe(reverted);
    expect(without).not.toBe(withSpeech);
  });

  test("指定しなければ口調の指示を入れる（大きいモデルの形）", () => {
    expect(buildContradictionCheckPrompt({ ...base, speechCheck: true })).toBe(withSpeech);
  });
});

describe("指示の言葉が答えとして返ってきたら落とす（失敗3番）", () => {
  const chunk: Chunk = {
    filePath: "C:/works/006.txt",
    index: 0,
    text: "エルシーは胡椒をなめた。\n「わたくし、この胡椒という粉が好きでございますわ」",
    startLine: 0,
    chapterStart: 6,
    chapterEnd: 6,
    hash: "speech",
    segments: [],
  } as unknown as Chunk;

  function item(overrides: Record<string, unknown>) {
    return {
      line: 2,
      excerpt: "「わたくし、この胡椒という粉が好きでございますわ」",
      category: "人物",
      settingSays: "一人称は「ボク」。語尾に「〜です」",
      textSays: "一人称が「わたくし」、語尾が「〜ですわ」になっている",
      note: "",
      severity: "medium",
      confidence: "medium",
      ...overrides,
    };
  }

  test("本物の口調の指摘は通す", () => {
    const result = validateContradictions({ contradictions: [item({})] }, chunk);
    expect(result.accepted).toHaveLength(1);
  });

  test.each([
    ["検証項目の文そのもの", { textSays: SPEECH_CHECK_ITEM }],
    ["判断の注意の一部を切り出したもの", { textSays: "一人称や語尾がその人物の設定と違い" }],
    ["原則の文を設定の欄に写したもの", { settingSays: SPEECH_PRINCIPLE_NOTE }],
    ["指示の文を丸ごと含むもの", { textSays: `本文では、${SPEECH_CHECK_ITEM}ていない` }],
  ])("%s は instruction_echo で落とす", (_, overrides) => {
    const result = validateContradictions({ contradictions: [item(overrides)] }, chunk);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("instruction_echo");
  });

  test("台詞の途中を「」ごと写した引用も、本文にあれば通す（括弧を外して照らす）", () => {
    // 実測（gemma4:26b、2026-09-25）：本文は「依頼料がかかるだろうが。俺は…」なのに、
    // 引用を「俺はオカネが減るのは大嫌いなんだよ」と括弧で包んで返し、
    // 正しい指摘が excerpt_not_found で2件とも落ちていた
    const text = "ナインは頬をふくらませた。\n「依頼料がかかるだろうが。俺はオカネが減るのは大嫌いなんだよ」";
    const local = { ...chunk, text } as Chunk;
    const result = validateContradictions(
      {
        contradictions: [
          item({
            excerpt: "「俺はオカネが減るのは大嫌いなんだよ」",
            settingSays: "一人称は「あたし」。",
            textSays: "一人称が「俺」になっている。",
          }),
        ],
      },
      local
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].excerpt).toBe("俺はオカネが減るのは大嫌いなんだよ");
  });

  test("括弧を外しても本文に無い引用は、これまでどおり落とす", () => {
    const result = validateContradictions(
      { contradictions: [item({ excerpt: "「わたくしは参りませんわ」" })] },
      chunk
    );
    expect(result.rejected[0].reason).toBe("excerpt_not_found");
  });

  test.each([
    // 実測（gemma4:e4b、1.8 で口調を照らすよう頼んだあと）：設定の欄に
    // 「合っている」「指摘しない」と書きながら、指摘として並べてきた
    ["皇帝の一人称は「余」であり、この発言は設定と合致している。"],
    ["アジャーノの一人称は「俺」であり、この場面では語り手であるため、口調の矛盾は指摘しない。"],
    ["エルシーの性格設定では「冷静沈着」であり、口調や一人称に関する明確な矛盾点はない。"],
  ])("設定の欄で自ら食い違いを否定した「%s」は self_denied で落とす", (settingSays) => {
    const result = validateContradictions(
      { contradictions: [item({ settingSays })] },
      chunk
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("self_denied");
  });

  test("設定の欄が設定を述べているだけなら、否定の網に掛けない", () => {
    const result = validateContradictions(
      {
        contradictions: [
          item({ settingSays: "一人称は「ボク」。語尾は「〜です」と一致した話し方をする" }),
        ],
      },
      chunk
    );
    expect(result.accepted).toHaveLength(1);
  });

  test("短い一致（「一人称」「口調」）だけでは写しと見ない", () => {
    expect(echoesInstruction("一人称")).toBe(false);
    expect(echoesInstruction("設定の口調")).toBe(false);
    expect(echoesInstruction("一人称が「俺」になっている")).toBe(false);
  });
});
