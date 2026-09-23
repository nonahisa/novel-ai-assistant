import { describe, expect, test } from "vitest";
import {
  WHITESPACE_RUNAWAY_ADVICE,
  WHITESPACE_RUNAWAY_CHARS,
  closeTruncatedJson,
  endsInWhitespaceRunaway,
  trailingWhitespaceLength,
  truncationReasonForLog,
} from "../../../src/core/truncatedResponse";

/**
 * 応答が**空白だけの行で埋まって**出力上限まで切り詰められる（残課題8。
 * 実機確認リスト「プロット逸脱検知の応答が、空白だけの行で…」）。
 *
 * 2026-09-22、さくらのAI `preview/gemma-4-31B-it` の第11話。1件目に
 * 「（該当箇所なし）」の要素を入れたあと、空白だけの行が 12,288 トークン
 * ぶん続いて切られた。2026-09-19 の作品紹介文（Qwen3.6-35B-A3B）も
 * `"confidence":` のあと空白で切られていた——**モデルをまたいで同じ型**。
 */

/** 空白だけの行を n 行。実機の応答は改行と字下げの空白が延々と続いていた */
function blankLines(count: number): string {
  return "\n        ".repeat(count);
}

/** 実機の第11話の型：埋め草の要素を閉じたあと、空白が続く */
const FILLER_THEN_BLANK =
  '{"deviations": [{"lineStart": 0, "lineEnd": 0, "excerpt": "（該当箇所なし）", ' +
  '"type": "逸脱", "reason": "（該当箇所なし）", "plotReference": "（該当箇所なし）", ' +
  '"severity": "low", "confidence": "low"}' +
  blankLines(3000);

/** 紹介文の型：値を書く前（`"confidence":` のあと）で空白に入る */
const BLANK_AFTER_KEY =
  '{"deviations": [{"lineStart": 3, "lineEnd": 3, "excerpt": "空から", ' +
  '"type": "逸脱", "reason": "理由", "plotReference": "あらすじ", ' +
  '"severity": "low", "confidence":' +
  blankLines(3000);

describe("末尾の空白を数える", () => {
  test("改行・字下げ・全角空白・タブをまとめて数える", () => {
    expect(trailingWhitespaceLength("abc \n\t　 ")).toBe(5);
  });

  test("空白で終わらなければ0", () => {
    expect(trailingWhitespaceLength('{"a": 1}')).toBe(0);
  });

  test("空文字でも落ちない", () => {
    expect(trailingWhitespaceLength("")).toBe(0);
  });
});

describe("空白で埋まったかを見分ける", () => {
  test("実機の型（埋め草のあと空白が続く）を見分ける", () => {
    expect(endsInWhitespaceRunaway(FILLER_THEN_BLANK)).toBe(true);
    expect(endsInWhitespaceRunaway(BLANK_AFTER_KEY)).toBe(true);
  });

  test("**整形されたふつうのJSONは、空白で埋まったとは言わない**", () => {
    // 字下げ付きで整形した応答は、行ごとに空白を持つが、連続はしない。
    // ここを誤って拾うと、まっとうな応答を失敗扱いにする
    const pretty = JSON.stringify(
      { deviations: Array.from({ length: 50 }, (_, i) => ({ lineStart: i })) },
      null,
      8
    );
    expect(endsInWhitespaceRunaway(pretty)).toBe(false);
    // 末尾に改行が数個付くのもふつうのこと
    expect(endsInWhitespaceRunaway(pretty + "\n\n\n")).toBe(false);
  });

  test("しきい値ちょうどで見分ける（1字手前では見分けない）", () => {
    const head = '{"deviations": [';
    expect(
      endsInWhitespaceRunaway(head + " ".repeat(WHITESPACE_RUNAWAY_CHARS - 1))
    ).toBe(false);
    expect(
      endsInWhitespaceRunaway(head + " ".repeat(WHITESPACE_RUNAWAY_CHARS))
    ).toBe(true);
  });
});

describe("空白の手前で閉じて救う", () => {
  test("要素を閉じたあとで空白に入った応答は、そのまま閉じれば読める", () => {
    const candidates = closeTruncatedJson(FILLER_THEN_BLANK);
    const parsed = candidates
      .map((candidate) => {
        try {
          return JSON.parse(candidate) as { deviations: unknown[] };
        } catch {
          return undefined;
        }
      })
      .find((value) => value !== undefined);
    expect(parsed?.deviations).toHaveLength(1);
  });

  test("値を書く前で空白に入った応答は、1つ前の値まで切り戻して読む", () => {
    const readable = closeTruncatedJson(BLANK_AFTER_KEY).filter((candidate) => {
      try {
        JSON.parse(candidate);
        return true;
      } catch {
        return false;
      }
    });
    expect(readable.length).toBeGreaterThan(0);
    const parsed = JSON.parse(readable[0]) as {
      deviations: Array<Record<string, unknown>>;
    };
    expect(parsed.deviations[0].severity).toBe("low");
    // 書かれていない値をこちらで作らない
    expect(parsed.deviations[0]).not.toHaveProperty("confidence");
  });

  test("閉じているJSONには候補を作らない（救う理由が無い）", () => {
    expect(closeTruncatedJson('{"deviations": []}' + blankLines(10))).toEqual([]);
  });

  test("`{` が無ければ候補を作らない", () => {
    expect(closeTruncatedJson(blankLines(3000))).toEqual([]);
  });
});

describe("作者へ出す次の一手", () => {
  test("上限を大きくする案内をしない（直らないため）", () => {
    expect(WHITESPACE_RUNAWAY_ADVICE).toContain("直りません");
    expect(WHITESPACE_RUNAWAY_ADVICE).not.toContain("大きくしてお試し");
    expect(WHITESPACE_RUNAWAY_ADVICE).toContain("別のモデル");
  });
});

describe("記録に残す理由", () => {
  test("空白で埋まった回は、上限の不足と分けて書く", () => {
    const reason = truncationReasonForLog({
      text: FILLER_THEN_BLANK,
      truncated: true,
    });
    expect(reason).toContain("空白");
    // 「上限を大きくすれば直る」と読ませない
    expect(reason).not.toBe("応答が出力上限で切り詰められました");
  });

  test("空白で埋まっていない切り詰めは、これまでどおりの文言", () => {
    expect(
      truncationReasonForLog({ text: '{"deviations": [{"a":', truncated: true })
    ).toBe("応答が出力上限で切り詰められました");
  });

  test("切り詰めでも空白でもなければ undefined（呼ぶ側の文言に任せる）", () => {
    expect(
      truncationReasonForLog({ text: "こんにちは", truncated: false })
    ).toBeUndefined();
  });

  test("上限に届く前に止まっていても、空白で埋まっていれば空白と書く", () => {
    // 流して受け取る道（Ollama）は、空白が続いた時点でこちらから打ち切る。
    // そのときは上限に届いていない
    expect(
      truncationReasonForLog({ text: FILLER_THEN_BLANK, truncated: false })
    ).toContain("空白");
  });
});
