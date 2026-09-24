import { describe, expect, it } from "vitest";
import {
  describeRetryNote,
  PLOT_DIALOGUE_LIMITS,
  similarity,
  validatePlotDialogueAnswer,
} from "../../../src/core/plotDialogueValidation";
import { PLOT_SKIP_OPTION, PLOT_WRITE_OPTION } from "../../../src/core/plotInterview";

/**
 * 対話式プロット作成（P-43）のAIの答えを、コードで確かめる（実装ルール3）。
 * 問いは1つ／候補は3〜4個／字数／指示の言葉の返り／繰り返し。
 */

function answer(fields: Record<string, unknown>): string {
  return JSON.stringify({
    confirm: "業者が最強、という話ですね。",
    topic: "最強の理由",
    question: "配信の回線を敷く業者は、なぜ最強なのですか？",
    why: "理由が決まると、敵と山場が決まります",
    candidates: ["回線が魔力も運ぶから", "ダンジョンの地図を握っているから", "配信が止まると冒険者が死ぬから"],
    section: "worldview",
    ...fields,
  });
}

describe("受け取れる答え", () => {
  it("そのまま受け取る", () => {
    const check = validatePlotDialogueAnswer(answer({}), []);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.turn.topic).toBe("最強の理由");
    expect(check.turn.candidates).toHaveLength(3);
    expect(check.turn.section).toBe("worldview");
  });

  it("コードフェンスで包まれていても読む", () => {
    const check = validatePlotDialogueAnswer("```json\n" + answer({}) + "\n```", []);
    expect(check.ok).toBe(true);
  });

  it("候補が多すぎたら上限で切る", () => {
    const check = validatePlotDialogueAnswer(
      answer({ candidates: ["一つ目の答え", "二つ目の答え", "三つ目の答え", "四つ目の答え", "五つ目の答え"] }),
      []
    );
    expect(check.ok && check.turn.candidates.length).toBe(PLOT_DIALOGUE_LIMITS.candidatesMax);
  });

  it("書く先の鍵のあとに説明が続いても、頭の鍵を取る", () => {
    // 手元の gemma4:e4b が、選択肢で縛る前に返した形
    const check = validatePlotDialogueAnswer(
      answer({ section: "worldview（世界の仕組み）とprotagonistMotiveの初期設定部分で決定する。" }),
      []
    );
    expect(check.ok && check.turn.section).toBe("worldview");
  });

  it("書く先が一覧に無ければ「あらすじ」へ寄せる（答えは捨てない）", () => {
    const check = validatePlotDialogueAnswer(answer({ section: "title" }), []);
    expect(check.ok && check.turn.section).toBe("outline");
  });

  it("名前が指示の言葉なら、問いの頭から作る", () => {
    const check = validatePlotDialogueAnswer(answer({ topic: "topic" }), []);
    expect(check.ok && check.turn.topic).toBe("配信の回線を敷く業者は、なぜ最強なのですか");
  });
});

describe("受け取らない答え", () => {
  it("JSONでない", () => {
    expect(validatePlotDialogueAnswer("業者はなぜ最強？", [])).toMatchObject({ ok: false, reason: "json" });
  });

  it("問いが2つある", () => {
    const check = validatePlotDialogueAnswer(
      answer({ question: "業者はなぜ最強ですか？ 主人公は誰ですか？" }),
      []
    );
    expect(check).toMatchObject({ ok: false, reason: "questions" });
  });

  it("問いが指示の言葉のまま返った（CLAUDE.md 失敗3）", () => {
    const check = validatePlotDialogueAnswer(
      answer({ question: "いま決めると話が一番広がる1点" }),
      []
    );
    expect(check).toMatchObject({ ok: false, reason: "echo" });
  });

  it("使える候補が3つに足りない（依頼文・伏せ字・札の文言・重複を落とした結果）", () => {
    const check = validatePlotDialogueAnswer(
      answer({
        candidates: [
          "回線が魔力も運ぶから",
          "主人公の立場を教えてほしい",
          "〇〇が××だから",
          PLOT_SKIP_OPTION,
          PLOT_WRITE_OPTION,
          "回線が魔力も運ぶから",
          "candidates",
        ],
      }),
      []
    );
    expect(check).toMatchObject({ ok: false, reason: "candidates" });
  });

  it("前に尋ねたのと同じ名前の問い", () => {
    const check = validatePlotDialogueAnswer(answer({}), [
      { topic: "最強の理由", question: "業者の強さの根拠は？", skipped: false },
    ]);
    expect(check).toMatchObject({ ok: false, reason: "repeat", detail: "最強の理由" });
  });

  it("名前を変えても、問いの文がほとんど同じなら繰り返し", () => {
    const check = validatePlotDialogueAnswer(answer({ topic: "強さの根拠" }), [
      {
        topic: "最強の理由",
        question: "配信の回線を敷く業者は、なぜ最強なのでしょうか？",
        skipped: false,
      },
    ]);
    expect(check).toMatchObject({ ok: false, reason: "repeat" });
  });

  it("飛ばした問いも、また尋ねない", () => {
    const check = validatePlotDialogueAnswer(answer({}), [
      { topic: "最強の理由", question: "業者はなぜ最強？", skipped: true },
    ]);
    expect(check).toMatchObject({ ok: false, reason: "repeat" });
  });
});

describe("頼み直しの一言", () => {
  it("繰り返しなら、何と同じだったかを言う", () => {
    expect(describeRetryNote("repeat", "最強の理由")).toContain("「最強の理由」");
  });

  it("候補が足りないなら、個数の決まりを言い直す", () => {
    expect(describeRetryNote("candidates", "使える候補が1個でした")).toContain(
      `${PLOT_DIALOGUE_LIMITS.candidatesMin}〜${PLOT_DIALOGUE_LIMITS.candidatesMax}個`
    );
  });
});

describe("似かた", () => {
  it("同じ文は1、まったく違う文は0に近い", () => {
    expect(similarity("業者はなぜ最強？", "業者はなぜ最強？")).toBe(1);
    expect(similarity("業者はなぜ最強？", "主人公の年齢は？")).toBeLessThan(0.3);
  });
});
