import { describe, expect, it } from "vitest";
import {
  buildContradictionVerifyPrompt,
  CONTRADICTION_VERIFY_VERSION,
  VERIFY_REJECT_REASONS,
  VERIFY_SPEECH_KEEP_SENTENCES,
  VERIFY_SPEECH_NOTE,
} from "../../../src/prompts/contradictionVerify";

/**
 * P-12b 矛盾の検証の頼み方（1.1、作者の裁定 2026-10-11）。
 *
 * gemma4:26b が第1段で挙げた千夏の「そうか、ではありませんわ。わたくし、
 * 驚きましたのよ」（設定はくだけた話し方、語尾「〜でしょ」「〜ね」「〜よ」）を、
 * 検証の段が「『〜ですわ』は『〜でしょ』『〜ね』『〜よ』の語尾の変わり型に
 * 含まれる」として「そもそも食い違っていない」で却下した。丁寧さの段や話し方の
 * 種類の違いは、変わり型ではなく食い違いとして残すよう頼む。
 */
const prompt = buildContradictionVerifyPrompt({
  chapterLabel: "第5話 初雪の窓口",
  contextWithLineNumbers: "41: 「そうか、ではありませんわ。わたくし、驚きましたのよ」",
  excerpt: "「そうか、ではありませんわ。わたくし、驚きましたのよ」",
  settingSays: "黒瀬千夏の口調：くだけた話し方で、語尾は「〜でしょ」「〜ね」「〜よ」。一人称は「私」",
  textSays: "「わたくし」「〜ましたのよ」という改まった口調",
  category: "人物",
  settingKnownAt: "",
});

describe("P-12b の頼み方（1.1）", () => {
  it("版を 1.1 に上げた（控えの鍵が変わり、1.0 の却下を使い回さない）", () => {
    expect(CONTRADICTION_VERIFY_VERSION).toBe("1.1");
  });

  it("「そもそも食い違っていない」の但し書きに、口調の但し書きを置く", () => {
    const sixth = prompt.indexOf("6. **そもそも食い違っていない**");
    const adopt = prompt.indexOf("【採用すべき場合】");
    expect(sixth).toBeGreaterThan(0);
    expect(prompt.indexOf(VERIFY_SPEECH_NOTE)).toBeGreaterThan(sixth);
    expect(prompt.indexOf(VERIFY_SPEECH_NOTE)).toBeLessThan(adopt);
  });

  it("丁寧さの段（お嬢様言葉・丁寧語・敬語）と変わり型を名指しする", () => {
    for (const word of ["お嬢様言葉", "丁寧語", "敬語", "変わり型", "丁寧さの段"]) {
      expect(VERIFY_SPEECH_NOTE).toContain(word);
    }
  });

  /**
   * 罠1（蓬田「なんだ、そんな顔をするな」）は、語尾が設定の一覧に無いが
   * ぶっきらぼうなまま。「設定に無い語尾は全部残す」と頼むと、罠を残させる。
   */
  it("同じ話し方のまま語尾だけ違うものは、食い違いではないと書いてある", () => {
    expect(VERIFY_SPEECH_NOTE).toContain("語尾だけが違うなら食い違いではありません");
  });

  it("【採用すべき場合】にも、丁寧さの段の違いを挙げる", () => {
    const adopt = prompt.slice(prompt.indexOf("【採用すべき場合】"), prompt.indexOf("【出力形式】"));
    expect(adopt).toContain("丁寧さの段");
  });

  /**
   * **指示の言葉は答えに返ってくる。** 却下の理由は決められた6つだけで、
   * 但し書きの言葉が理由の一覧に紛れ込んでいないこと。
   */
  it("却下の理由の一覧は6つのまま。但し書きの言葉は理由にしない", () => {
    expect(VERIFY_REJECT_REASONS).toHaveLength(6);
    for (const reason of VERIFY_REJECT_REASONS) {
      expect(VERIFY_SPEECH_NOTE).not.toContain(reason);
    }
    const reasonLine = prompt.split("\n").find((line) => line.includes('"reason"')) ?? "";
    expect(reasonLine).not.toContain("変わり型");
  });

  it("「残せ」の文は、但し書きの中にそのまま入っている", () => {
    for (const sentence of VERIFY_SPEECH_KEEP_SENTENCES) {
      expect(VERIFY_SPEECH_NOTE).toContain(sentence);
    }
  });
});
