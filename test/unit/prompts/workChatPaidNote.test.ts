import { describe, expect, test } from "vitest";
import {
  WORK_CHAT_SYSTEM_PROMPT,
  buildWorkChatSystemPrompt,
} from "../../../src/prompts/workChat";

/**
 * 相談（P-21）の「料金がかかる」の一文は、有料のAIのときだけ送る（2026-10-24）。
 *
 * 発端：使い方の節に「AIを使う操作は、料金がかかることを添えること」が
 * 有料・無料の区別なく書いてあり、手元の Ollama（gemma4:26b）でも
 * 「料金がかかります」と答えた（設計書6.27.9、2026-09-25 の測定）。
 *
 * **指示の言葉は、そのまま答えに返ってくる**（CLAUDE.md の失敗3）。
 * 無料の回の指示に「料金がかか」の字が1つでも残っていれば、同じ答えが
 * 返りうるので、字そのものが無いことを確かめる。
 */

const PAID_LINE = "AIを使う操作は、料金がかかることを添えること";

describe("使い方の節の料金の一文", () => {
  test("有料のAIでは、これまでと1字も変えずに送る", () => {
    const paid = buildWorkChatSystemPrompt({ featureIndex: true, paid: true });
    expect(paid).toContain(PAID_LINE);
    // 既定（指定なし）は有料の扱い。分からないときに「無料」へ倒さない（6.49.4 と同じ守り）
    expect(buildWorkChatSystemPrompt({ featureIndex: true })).toBe(paid);
    expect(WORK_CHAT_SYSTEM_PROMPT).toBe(paid);
  });

  test("無料のAIでは、料金がかかるとは書かない", () => {
    const free = buildWorkChatSystemPrompt({ featureIndex: true, paid: false });
    expect(free).not.toMatch(/料金がかか/);
    expect(free).not.toMatch(/有料/);
    // 「無料です」と言い切らせない——相談のAIが無料でも、操作は別の割当で
    // 有料のAIが動くことがある（機能別AI割当）
    expect(free).not.toMatch(/無料/);
    // 使い方の節そのものは残る（料金の一文だけが替わる）
    expect(free).toContain("【この拡張機能の使い方を聞かれたとき】");
  });

  test("目次を渡さない回は、有料・無料で変わらない（料金の一文はもともと無い）", () => {
    expect(buildWorkChatSystemPrompt({ featureIndex: false, paid: false })).toBe(
      buildWorkChatSystemPrompt({ featureIndex: false, paid: true })
    );
  });
});
