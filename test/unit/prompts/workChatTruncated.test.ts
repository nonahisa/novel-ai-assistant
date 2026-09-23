import { describe, expect, test } from "vitest";
import { parseWorkChatAnswer } from "../../../src/prompts/workChat";

/**
 * 切り詰められた相談の返答を救う（作者の実機報告、2026-09-23
 * 「返答におかしな記号が混ざります」）。
 *
 * **起きていたこと**：返答が出力上限で切り詰められ、閉じ波括弧が付かない
 * まま返ってきた。`parseWorkChatAnswer` は3通り試すが、3つ目の
 * `extractBraces` は `lastIndexOf("}")` で終わりを探すので、`}` が1つも
 * 無いこの形では必ずあきらめる。3通りとも失敗すると**素の本文を
 * そのまま `reply` に詰めて返す**ので、作者の画面には
 * `"needFiles": [],` `"run": null` がそのまま並んだ。
 *
 * しかも `reply` が空ではないため、`workChatPanel.ts` の
 * 「返事が空なら切り詰めを伝える」分岐にも入らなかった。
 */

/** 実機で出た形。`{` で始まり `"run": null` で終わり、`}` が無い */
const TRUNCATED = `{
  "reply": "第12話の視点は灯に寄っています。前半で地の文が拾っているのは灯の感覚だけなので、玲の胸中に踏み込む一文が入ると視点がぶれて読めます。",
  "options": [
    "玲の視点に切り替える案を出してほしい",
    "灯の視点のまま通す直し方を見せて"
  ],
  "needFiles": [],
  "edit": null,
  "run": null`;

describe("切り詰められた返答を救う", () => {
  test("閉じ波括弧が無くても中身を読み取る", () => {
    const answer = parseWorkChatAnswer(TRUNCATED);

    expect(answer.source).toBe("salvaged");
    expect(answer.reply).toContain("第12話の視点は灯に寄っています");
    expect(answer.options).toEqual([
      "玲の視点に切り替える案を出してほしい",
      "灯の視点のまま通す直し方を見せて",
    ]);
  });

  test("救った返事に生のJSONを混ぜない", () => {
    const answer = parseWorkChatAnswer(TRUNCATED);

    // 作者が見たのはこれ。**救えた回には一文字も残らない**こと
    expect(answer.reply).not.toContain('"needFiles"');
    expect(answer.reply).not.toContain('"run": null');
  });

  test("文字列の途中で切れていても、そこまでを返事にする", () => {
    const answer = parseWorkChatAnswer(
      '{"reply": "冒頭の2,000字で5W1Hが伝わるかを見ました。いま足りないのは場'
    );

    expect(answer.source).toBe("salvaged");
    expect(answer.reply).toBe(
      "冒頭の2,000字で5W1Hが伝わるかを見ました。いま足りないのは場"
    );
  });

  test("エスケープの途中で切れていても壊れない", () => {
    // `\` を足したまま `"` で閉じると、閉じたことにならない
    const answer = parseWorkChatAnswer('{"reply": "改行を入れます\\');

    expect(answer.source).toBe("salvaged");
    expect(answer.reply).toBe("改行を入れます");
  });

  test("配列の途中で切れていても、そこまでの選択肢を残す", () => {
    const answer = parseWorkChatAnswer(
      '{"reply": "3案あります。", "options": ["短くしてほしい", "別の切り口で'
    );

    expect(answer.source).toBe("salvaged");
    expect(answer.reply).toBe("3案あります。");
    expect(answer.options).toEqual(["短くしてほしい", "別の切り口で"]);
  });

  test("鍵だけ書かれて切れていても、そこまでを読む", () => {
    const answer = parseWorkChatAnswer('{"reply": "はい。", "options":');

    expect(answer.source).toBe("salvaged");
    expect(answer.reply).toBe("はい。");
    expect(answer.options).toEqual([]);
  });

  test("値が途中の真偽値で切れていても、切り戻して読む", () => {
    const answer = parseWorkChatAnswer('{"reply": "はい。", "done": tru');

    expect(answer.source).toBe("salvaged");
    expect(answer.reply).toBe("はい。");
  });

  test("入れ子ごと切れていても閉じる", () => {
    const answer = parseWorkChatAnswer(
      '{"reply": "書いておきます。", "edit": {"target": "plot.theme", "content": "赦し'
    );

    expect(answer.source).toBe("salvaged");
    expect(answer.reply).toBe("書いておきます。");
    expect(answer.edit).toEqual({ target: "plot.theme", content: "赦し" });
  });
});

describe("救えなかったときの見せ方", () => {
  test("JSONらしい生テキストは返事を空にする", () => {
    // 救えない形（`reply` が文字列として成立しない）。画面に記号を並べない
    const broken = '{"reply": 12, "needFiles": [], "run"';
    const answer = parseWorkChatAnswer(broken);

    expect(answer.source).toBe("raw");
    expect(answer.reply).toBe("");
  });

  test("素の文章で答えてきた回は、そのまま見せる", () => {
    // AIが形式を無視して普通に答えること自体は珍しくない。そこは潰さない
    const answer = parseWorkChatAnswer("すみません、うまく答えられません。");

    expect(answer.source).toBe("raw");
    expect(answer.reply).toBe("すみません、うまく答えられません。");
  });

  test("波括弧で始まる普通の文章は、JSONと見なさない", () => {
    const answer = parseWorkChatAnswer("{ここは本文の引用です}");

    expect(answer.source).toBe("raw");
    expect(answer.reply).toBe("{ここは本文の引用です}");
  });

  test("落ちないこと（閉じすぎ・空・記号だけ）", () => {
    expect(() => parseWorkChatAnswer("")).not.toThrow();
    expect(() => parseWorkChatAnswer("}}}")).not.toThrow();
    expect(() => parseWorkChatAnswer('{"a":1}}')).not.toThrow();
    expect(parseWorkChatAnswer("").source).toBe("raw");
  });
});

describe("これまでどおり読める回は、救いの札を立てない", () => {
  test("そのまま読めたら json", () => {
    const answer = parseWorkChatAnswer('{"reply":"はい。","options":[]}');

    expect(answer.source).toBe("json");
  });

  test("コードフェンス付きでも json", () => {
    const answer = parseWorkChatAnswer('```json\n{"reply":"はい。"}\n```');

    expect(answer.source).toBe("json");
    expect(answer.reply).toBe("はい。");
  });

  test("コードフェンスの中で切れていても救う", () => {
    const answer = parseWorkChatAnswer('```json\n{"reply":"はい。","run": null');

    expect(answer.source).toBe("salvaged");
    expect(answer.reply).toBe("はい。");
  });
});
