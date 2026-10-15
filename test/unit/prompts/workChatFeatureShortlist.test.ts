import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  FEATURE_SHORTLIST_NAMES,
  WORK_CHAT_SYSTEM_PROMPT,
  buildWorkChatSystemPrompt,
  parseWorkChatAnswer,
} from "../../../src/prompts/workChat";
import { parseChatRun } from "../../../src/core/chatEdit";

/**
 * 目次を渡さない相談に置く、主な機能の短い一覧（作者の裁定 2026-10-15 の8。v3.31）。
 *
 * 発端：目次の無い相談で gemma4:26b が「この拡張機能自体にPDF出力機能は
 * 備わっていないようです」と答えた（3回に1回）。
 */

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf8")
) as { contributes: { commands: Array<{ title: string }> } };
const commandTitles = new Set(packageJson.contributes.commands.map((command) => command.title));

describe("一覧の名前", () => {
  test.each(FEATURE_SHORTLIST_NAMES.map((name) => [name]))(
    "「%s」は詳細メニューの題として実在する（名前を変えたら一覧も直す）",
    (name) => {
      expect(commandTitles.has(name)).toBe(true);
    }
  );

  test("PDF出力が入っている（作り話の発端）", () => {
    expect(FEATURE_SHORTLIST_NAMES.some((name) => name.startsWith("PDF出力"))).toBe(true);
  });
});

describe("どの回に入るか", () => {
  test("目次を渡さない回にだけ入る", () => {
    const trimmed = buildWorkChatSystemPrompt({ featureIndex: false });
    expect(trimmed).toContain("【この拡張機能の主な機能（一部だけ）】");
    for (const name of FEATURE_SHORTLIST_NAMES) expect(trimmed).toContain(name);
  });

  test("目次を渡す回には入らない（目次そのものが全部の一覧なので、送る本文を変えない）", () => {
    expect(WORK_CHAT_SYSTEM_PROMPT).not.toContain("【この拡張機能の主な機能（一部だけ）】");
  });

  test("短く保つ（処理量。節の見出しから末尾まで300字以内）", () => {
    const trimmed = buildWorkChatSystemPrompt({ featureIndex: false });
    const start = trimmed.indexOf("【この拡張機能の主な機能（一部だけ）】");
    const end = trimmed.indexOf("【本文の場所を指すとき】");
    expect(start).toBeGreaterThan(0);
    expect(end - start).toBeLessThanOrEqual(300);
  });
});

describe("一覧の言葉がそのまま返ってきても、何も動かない（CLAUDE.md の失敗3）", () => {
  test("一覧の名前を run に書かれても、起動のボタンにならない", () => {
    for (const name of FEATURE_SHORTLIST_NAMES) {
      const answer = parseWorkChatAnswer(
        JSON.stringify({ reply: "あります。", options: [], run: name })
      );
      // 応答の読み取りは run を生のまま持ち、ボタンにするのは parseChatRun（製品と同じ道）
      expect(parseChatRun(answer.run), name).toBeUndefined();
    }
  });

  test("見出しや一覧の行が返事に写っても、返事としてそのまま読む（書き込みや起動にはならない）", () => {
    const echoed = `【この拡張機能の主な機能（一部だけ）】\n${FEATURE_SHORTLIST_NAMES.join("・")}`;
    const answer = parseWorkChatAnswer(JSON.stringify({ reply: echoed, options: [] }));
    expect(answer.reply).toBe(echoed);
    expect(answer.edit).toBeUndefined();
    expect(parseChatRun(answer.run)).toBeUndefined();
    expect(answer.locate).toBeUndefined();
  });
});
