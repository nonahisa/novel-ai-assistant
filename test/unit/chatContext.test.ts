import { describe, expect, test } from "vitest";
import {
  buildExcerpt,
  classifyChatContext,
  describeChatContext,
} from "../../src/core/chatContext";
import { parseWorkChatAnswer } from "../../src/prompts/workChat";

function classify(relativePath: string, isEpisode = false) {
  return classifyChatContext({
    relativePath,
    settingsDirName: "設定",
    isEpisode,
  });
}

describe("開いている画面の判定", () => {
  test("走査で本文と分かったファイルは本文として扱う", () => {
    // 置き場所が作品によって違う（直下 / 本文フォルダ）ので、
    // パスの形ではなく走査結果で決める
    expect(classify("episode_0001.txt", true)).toBe("manuscript");
    expect(classify("本文/001.txt", true)).toBe("manuscript");
  });

  test("プロットと紹介文を見分ける", () => {
    expect(classify("設定/plot.md")).toBe("plot");
    expect(classify("設定/synopsis.md")).toBe("synopsis");
    // 統合前の名前のファイルも、開かれたら同じ扱いにする
    expect(classify("設定/synopses.md")).toBe("synopsis");
  });

  test("設定資料のMarkdownをまとめて扱う", () => {
    expect(classify("設定/characters.md")).toBe("settingsDoc");
    expect(classify("設定/world.md")).toBe("settingsDoc");
  });

  test("設定フォルダの外の .md は設定資料にしない", () => {
    expect(classify("メモ.md")).toBe("otherInWork");
  });

  test("空のパスは作品の外として扱う", () => {
    expect(classify("")).toBe("outside");
  });
});

describe("画面の説明", () => {
  test("話数が分かれば話数で呼ぶ", () => {
    expect(describeChatContext("manuscript", "001.txt", "第7話")).toBe(
      "第7話 の本文"
    );
  });

  test("話数が分からなければファイル名で呼ぶ", () => {
    expect(describeChatContext("manuscript", "序章.txt", null)).toBe(
      "序章.txt（本文）"
    );
  });
});

describe("抜粋の切り出し", () => {
  test("選んだ範囲があれば、それだけを渡す", () => {
    // 範囲を選んで聞くのは「ここについて」という意思表示なので、
    // 全体を渡すと薄まる
    const result = buildExcerpt({
      text: "あ".repeat(1000),
      selection: "ここが気になる",
      maxChars: 100,
    });

    expect(result.text).toBe("ここが気になる");
    expect(result.truncated).toBe(false);
  });

  test("短ければそのまま渡す", () => {
    const result = buildExcerpt({ text: "短い本文", maxChars: 100 });

    expect(result.text).toBe("短い本文");
    expect(result.truncated).toBe(false);
  });

  test("長ければカーソルの前後を採り、切ったことを伝える", () => {
    // 位置が分かるよう、1文字ずつ違う内容にする
    // （同じ並びの繰り返しだと、どこを切り出したのか確かめられない）
    const text = Array.from({ length: 1000 }, (_, index) =>
      String.fromCharCode(0x4e00 + index)
    ).join("");
    const result = buildExcerpt({ text, caret: 500, maxChars: 100 });

    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);

    // カーソル位置が抜粋の中に入っていること
    const start = text.indexOf(result.text);
    expect(start).toBeLessThanOrEqual(500);
    expect(start + 100).toBeGreaterThanOrEqual(500);
  });

  test("末尾にカーソルがあっても上限ぶん取れる", () => {
    const text = "0123456789".repeat(100);
    const result = buildExcerpt({ text, caret: text.length, maxChars: 100 });

    expect(result.text).toHaveLength(100);
  });
});

describe("相談の応答の読み取り", () => {
  test("返事と選択肢を取り出す", () => {
    const answer = parseWorkChatAnswer(
      '{"reply":"こう読めます。","options":["もっと短く","別の案を3つ"]}'
    );

    expect(answer.reply).toBe("こう読めます。");
    expect(answer.options).toEqual(["もっと短く", "別の案を3つ"]);
  });

  test("コードフェンス付きでも読める", () => {
    const answer = parseWorkChatAnswer('```json\n{"reply":"はい。"}\n```');

    expect(answer.reply).toBe("はい。");
    expect(answer.options).toEqual([]);
  });

  test("JSONとして読めなくても、返事として見せる", () => {
    // 相談は会話なので、形式が崩れても本文が読めるなら捨てない
    const answer = parseWorkChatAnswer("すみません、うまく答えられません。");

    expect(answer.reply).toBe("すみません、うまく答えられません。");
    expect(answer.options).toEqual([]);
  });

  test("選択肢は4つまでにする", () => {
    const answer = parseWorkChatAnswer(
      JSON.stringify({
        reply: "案です。",
        options: ["1", "2", "3", "4", "5", "6"],
      })
    );

    expect(answer.options).toHaveLength(4);
  });

  test("空の選択肢は落とす", () => {
    const answer = parseWorkChatAnswer(
      JSON.stringify({ reply: "案です。", options: ["有効", "", "  "] })
    );

    expect(answer.options).toEqual(["有効"]);
  });

  test("全項目がnullで返ってきても壊れない", () => {
    // スキーマで全項目を必須・null許容にしたので、無いものは省略ではなく
    // null で返る。とくに options が落とされると選択肢の仕組みごと消える
    const answer = parseWorkChatAnswer(
      JSON.stringify({
        reply: "こう読めます。",
        options: null,
        needFiles: null,
        edit: null,
        run: null,
        locate: null,
      })
    );

    expect(answer.reply).toBe("こう読めます。");
    expect(answer.options).toEqual([]);
    expect(answer.edit).toBeNull();
    expect(answer.run).toBeNull();
    expect(answer.locate).toBeNull();
  });
});
