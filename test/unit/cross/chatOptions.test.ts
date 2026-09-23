import { describe, expect, test } from "vitest";
import { cleanOption, parseWorkChatAnswer } from "../../src/prompts/workChat";
import { renderChatLogEntry } from "../../src/core/chatLog";

/**
 * 実機で見つかった不具合の再現（2026-08-15）。
 *
 * 選択肢に「【この拡張機能でできること】」「【次のアクションを提案する】」
 * という**項目名**が返ってきた。ボタンを押すとその文字列がそのまま
 * 次の質問として送られるので、題名のままだと何を頼んだのか分からない。
 */
describe("選択肢を押せる形に整える", () => {
  test("見出しの括弧を外す", () => {
    expect(cleanOption("【次のアクションを提案する】")).toBe(
      "次のアクションを提案する"
    );
  });

  test("半角・全角の角括弧も外す", () => {
    expect(cleanOption("[案を出す]")).toBe("案を出す");
    expect(cleanOption("［案を出す］")).toBe("案を出す");
  });

  test("箇条書きの記号を落とす", () => {
    expect(cleanOption("- もっと短くしてほしい")).toBe("もっと短くしてほしい");
    expect(cleanOption("1. もっと短くしてほしい")).toBe("もっと短くしてほしい");
  });

  test("普通の依頼文はそのまま", () => {
    // 言い回しはAIの領分。こちらが直すと作者の意図と食い違う
    expect(cleanOption("もっと短くしてほしい")).toBe("もっと短くしてほしい");
  });

  test("文の途中の括弧は外さない", () => {
    // 【】で囲まれているのが全体のときだけ題名とみなす
    expect(cleanOption("【第3話】の続きを見せて")).toBe("【第3話】の続きを見せて");
  });

  test("応答を読むときに整えられる", () => {
    const answer = parseWorkChatAnswer(
      JSON.stringify({
        reply: "はい",
        options: ["【この拡張機能でできること】", "もっと短くしてほしい"],
        needFiles: [],
        edit: null,
        run: null,
        locate: null,
      })
    );

    expect(answer.options).toEqual([
      "この拡張機能でできること",
      "もっと短くしてほしい",
    ]);
  });
});

describe("相談ログにプロンプトの版を残す", () => {
  test("版が分かる", () => {
    // これが無いと、直した指示が効いているのか、
    // 拡張機能開発ホストが古いビルドのままなのかを切り分けられない
    const text = renderChatLogEntry(
      {
        panel: "相談パネル",
        promptVersion: "2.6",
        provider: "Ollama",
        model: "gemma4:e4b",
        paid: false,
        question: "質問",
        reply: "返事",
      },
      new Date(2026, 7, 15, 22, 36, 41)
    );

    expect(text).toContain("プロンプト v2.6");
  });

  test("版が無くても壊れない", () => {
    const text = renderChatLogEntry(
      {
        panel: "設定資料パネル",
        provider: "Ollama",
        model: "gemma4:e4b",
        paid: false,
        question: "質問",
        reply: "返事",
      },
      new Date(2026, 7, 15, 22, 36, 41)
    );

    expect(text).toContain("Ollama（gemma4:e4b）");
    expect(text).not.toContain("プロンプト v");
  });
});
