import { describe, expect, it } from "vitest";
import {
  describeRetryNote,
  PLOT_DIALOGUE_LIMITS,
  similarity,
  validatePlotDialogueAnswer,
  validatePlotSummary,
  type PlotTurnRequest,
} from "../../../src/core/plotDialogueValidation";
import {
  PLOT_MORE_OPTION,
  PLOT_SKIP_OPTION,
  PLOT_WRITE_OPTION,
  type PlotDecision,
} from "../../../src/core/plotInterview";

/**
 * 対話式プロット作成（P-43・P-44）のAIの答えを、コードで確かめる（実装ルール3）。
 * 問いは1つ／候補は3〜4個（ほかの案は8個まで）／字数／指示の言葉の返り／
 * 繰り返し／確かめ直しは1回まで／まとめから抜けた決まったことを戻す／
 * コードが次の1点を決める型（型に当てはめる・項目を順に埋める）。
 */

const NONE: PlotTurnRequest = { asked: [] };

function answer(fields: Record<string, unknown>): string {
  return JSON.stringify({
    mode: "ask",
    confirm: "業者が最強、という話ですね。",
    topic: "最強の理由",
    question: "配信の回線を敷く業者は、なぜ最強なのですか？",
    why: "理由が決まると、敵と山場が決まります",
    candidates: [
      { text: "回線が魔力も運ぶから", effect: "世界の仕組みの話になる" },
      { text: "ダンジョンの地図を握っているから", effect: "情報戦の話になる" },
      { text: "配信が止まると冒険者が死ぬから", effect: "命綱の話になる" },
    ],
    section: "worldview",
    ...fields,
  });
}

describe("受け取れる答え", () => {
  it("そのまま受け取る（候補ごとの変わることも）", () => {
    const check = validatePlotDialogueAnswer(answer({}), NONE);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.turn.mode).toBe("ask");
    expect(check.turn.topic).toBe("最強の理由");
    expect(check.turn.candidates).toHaveLength(3);
    expect(check.turn.candidates[0]).toEqual({
      text: "回線が魔力も運ぶから",
      effect: "世界の仕組みの話になる",
    });
    expect(check.turn.section).toBe("worldview");
  });

  it("候補が文字列だけでも受け取る（変わることは空）", () => {
    const check = validatePlotDialogueAnswer(
      answer({ candidates: ["回線が魔力も運ぶから", "地図を握っているから", "配信が命綱だから"] }),
      NONE
    );
    expect(check.ok && check.turn.candidates[0]).toEqual({ text: "回線が魔力も運ぶから", effect: "" });
  });

  it("変わることが指示の言葉なら空にする", () => {
    const check = validatePlotDialogueAnswer(
      answer({
        candidates: [
          { text: "回線が魔力も運ぶから", effect: "これを選ぶと話がどう変わるか" },
          { text: "地図を握っているから", effect: "effect" },
          { text: "配信が命綱だから", effect: "命綱の話になる" },
        ],
      }),
      NONE
    );
    expect(check.ok && check.turn.candidates.map((c) => c.effect)).toEqual(["", "", "命綱の話になる"]);
  });

  it("コードフェンスで包まれていても読む", () => {
    const check = validatePlotDialogueAnswer("```json\n" + answer({}) + "\n```", NONE);
    expect(check.ok).toBe(true);
  });

  it("候補が多すぎたら上限で切る", () => {
    const check = validatePlotDialogueAnswer(
      answer({ candidates: ["一つ目の答え", "二つ目の答え", "三つ目の答え", "四つ目の答え", "五つ目の答え"] }),
      NONE
    );
    expect(check.ok && check.turn.candidates.length).toBe(PLOT_DIALOGUE_LIMITS.candidatesMax);
  });

  it("書く先の鍵のあとに説明が続いても、頭の鍵を取る", () => {
    // 手元の gemma4:e4b が、選択肢で縛る前に返した形
    const check = validatePlotDialogueAnswer(
      answer({ section: "worldview（世界の仕組み）とprotagonistMotiveの初期設定部分で決定する。" }),
      NONE
    );
    expect(check.ok && check.turn.section).toBe("worldview");
  });

  it("書く先が一覧に無ければ「あらすじ」へ寄せる（答えは捨てない）", () => {
    const check = validatePlotDialogueAnswer(answer({ section: "title" }), NONE);
    expect(check.ok && check.turn.section).toBe("outline");
  });

  it("名前が指示の言葉なら、問いの頭から作る", () => {
    const check = validatePlotDialogueAnswer(answer({ topic: "topic" }), NONE);
    expect(check.ok && check.turn.topic).toBe("配信の回線を敷く業者は、なぜ最強なのですか");
  });
});

describe("受け取らない答え", () => {
  it("JSONでない", () => {
    expect(validatePlotDialogueAnswer("業者はなぜ最強？", NONE)).toMatchObject({ ok: false, reason: "json" });
  });

  it("問いが2つある", () => {
    const check = validatePlotDialogueAnswer(
      answer({ question: "業者はなぜ最強ですか？ 主人公は誰ですか？" }),
      NONE
    );
    expect(check).toMatchObject({ ok: false, reason: "questions" });
  });

  it("問いが指示の言葉のまま返った（CLAUDE.md 失敗3）", () => {
    const check = validatePlotDialogueAnswer(
      answer({ question: "いま決めると話が一番広がる1点" }),
      NONE
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
          PLOT_MORE_OPTION,
          "回線が魔力も運ぶから",
          "candidates",
          "outline",
        ],
      }),
      NONE
    );
    expect(check).toMatchObject({ ok: false, reason: "candidates" });
  });

  it("前に尋ねたのと同じ名前の問い", () => {
    const check = validatePlotDialogueAnswer(answer({}), {
      asked: [{ topic: "最強の理由", question: "業者の強さの根拠は？", skipped: false }],
    });
    expect(check).toMatchObject({ ok: false, reason: "repeat", detail: "最強の理由" });
  });

  it("名前を変えても、問いの文がほとんど同じなら繰り返し", () => {
    const check = validatePlotDialogueAnswer(answer({ topic: "強さの根拠" }), {
      asked: [
        {
          topic: "最強の理由",
          question: "配信の回線を敷く業者は、なぜ最強なのでしょうか？",
          skipped: false,
        },
      ],
    });
    expect(check).toMatchObject({ ok: false, reason: "repeat" });
  });

  it("飛ばした問いも、また尋ねない", () => {
    const check = validatePlotDialogueAnswer(answer({}), {
      asked: [{ topic: "最強の理由", question: "業者はなぜ最強？", skipped: true }],
    });
    expect(check).toMatchObject({ ok: false, reason: "repeat" });
  });
});

describe("ほかの案（同じ問いのまま）", () => {
  const more: PlotTurnRequest = {
    asked: [{ topic: "最強の理由", question: "業者はなぜ最強？", skipped: false }],
    more: {
      topic: "最強の理由",
      question: "業者はなぜ最強？",
      section: "worldview",
      shown: ["回線が魔力も運ぶから"],
    },
  };

  it("同じ名前でも繰り返しにしない。問い・名前・書く先はこちらのものを使う", () => {
    const check = validatePlotDialogueAnswer(
      answer({
        question: "言い換えた問い？",
        section: "outline",
        candidates: ["地図を握っているから", "配信が命綱だから", "魔物と契約しているから", "国が後ろ盾だから", "線が結界になるから"],
      }),
      more
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.turn.question).toBe("業者はなぜ最強？");
    expect(check.turn.section).toBe("worldview");
    // 普段の上限（4）より多く出せる
    expect(check.turn.candidates).toHaveLength(5);
  });

  it("もう見せた案は落とす", () => {
    const check = validatePlotDialogueAnswer(
      answer({ candidates: ["回線が魔力も運ぶから", "地図を握っているから", "配信が命綱だから", "国が後ろ盾だから"] }),
      more
    );
    expect(check.ok && check.turn.candidates.map((c) => c.text)).not.toContain("回線が魔力も運ぶから");
  });

  it("上限は8つ", () => {
    const many = Array.from({ length: 10 }, (_, i) => `案の中身その${"一二三四五六七八九十"[i]}`);
    const check = validatePlotDialogueAnswer(answer({ candidates: many }), more);
    expect(check.ok && check.turn.candidates.length).toBe(PLOT_DIALOGUE_LIMITS.moreMax);
  });
});

describe("確かめ直し（答えが途中で切れている・どちらにも読める）", () => {
  it("許した回だけ受け取り、名前と書く先は直前の問いのものを使う", () => {
    const check = validatePlotDialogueAnswer(
      answer({ mode: "clarify", topic: "別の名前", question: "「元アイデアを」の続きは、どちらですか？", section: "outline" }),
      {
        asked: [{ topic: "どんでん返し", question: "どんでん返しは？", skipped: false }],
        clarifyFor: { topic: "どんでん返し", section: "outline" },
      }
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.turn.mode).toBe("clarify");
    expect(check.turn.topic).toBe("どんでん返し");
  });

  it("許していない回（確かめ直しへの答え）では受け取らない", () => {
    const check = validatePlotDialogueAnswer(answer({ mode: "clarify" }), NONE);
    expect(check).toMatchObject({ ok: false, reason: "clarify" });
  });
});

describe("コードが次の1点を決める型（型に当てはめる・項目を順に埋める）", () => {
  const fixed = { topic: "承", section: "outline" as const, note: "始まった出来事が展開し、深まる" };

  it("名前と書く先はこちらのものを使う（AIが別の名前・書く先を返しても）", () => {
    const check = validatePlotDialogueAnswer(
      answer({ topic: "展開", question: "承では、新人は何に巻き込まれますか？", section: "worldview" }),
      { asked: [{ topic: "起", question: "起では、何が始まりますか？", skipped: false }], fixed }
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.turn.topic).toBe("承");
    expect(check.turn.section).toBe("outline");
  });

  it("枠の名前だけ違う問いを、繰り返しと取り違えない", () => {
    // 文の似かたで見ると 0.6 を超える。枠はコードが「まだ尋ねていないもの」から選んでいる
    const before = "起では、主人公にどんな出来事が起きますか？";
    const now = "承では、主人公にどんな出来事が起きますか？";
    expect(similarity(before, now)).toBeGreaterThanOrEqual(0.6);
    const check = validatePlotDialogueAnswer(answer({ question: now }), {
      asked: [{ topic: "起", question: before, skipped: false }],
      fixed,
    });
    expect(check.ok).toBe(true);
  });

  it("前と同じ文そのものなら繰り返しとして止める（枠を無視した）", () => {
    const same = "起では、主人公にどんな出来事が起きますか？";
    const check = validatePlotDialogueAnswer(answer({ question: same }), {
      asked: [{ topic: "起", question: same, skipped: false }],
      fixed,
    });
    expect(check).toMatchObject({ ok: false, reason: "repeat", detail: "起" });
  });

  it("枠の説明がそのまま問い・候補に返ったら中身が無い（CLAUDE.md 失敗3）", () => {
    expect(
      validatePlotDialogueAnswer(answer({ question: fixed.note }), { asked: [], fixed })
    ).toMatchObject({ ok: false, reason: "echo" });

    const check = validatePlotDialogueAnswer(
      answer({ candidates: [fixed.note, "新人が初めて深層へ潜る", "配信事故が起きる", "班長の過去が漏れる"] }),
      { asked: [], fixed }
    );
    expect(check.ok && check.turn.candidates.map((c) => c.text)).not.toContain(fixed.note);
  });

  it("型ごとの指示の言葉も、そのまま返ったら受け取らない", () => {
    for (const phrase of ["次に埋める枠", "次に埋める項目", "話を外へ広げる1点", "結末が成り立つのに欠かせない1点"]) {
      expect(validatePlotDialogueAnswer(answer({ question: phrase }), NONE)).toMatchObject({
        ok: false,
        reason: "echo",
      });
    }
  });

  it("型と枠の札の文言は候補にしない（押すと札と取り違える）", () => {
    const check = validatePlotDialogueAnswer(
      answer({ candidates: ["起承転結", "場面から広げる", "新人が初めて深層へ潜る", "配信事故が起きる", "班長の過去が漏れる"] }),
      NONE
    );
    expect(check.ok && check.turn.candidates.map((c) => c.text)).toEqual([
      "新人が初めて深層へ潜る",
      "配信事故が起きる",
      "班長の過去が漏れる",
    ]);
  });

  it("確かめ直しの回は、決まった枠でなく直前の問いの名前を使う", () => {
    const check = validatePlotDialogueAnswer(
      answer({ mode: "clarify", question: "「配線を」の続きは、どちらですか？" }),
      {
        asked: [{ topic: "起", question: "起では？", skipped: false }],
        clarifyFor: { topic: "起", section: "outline" },
        fixed,
      }
    );
    expect(check.ok && check.turn.topic).toBe("起");
  });
});

describe("頼み直しの一言", () => {
  it("繰り返しなら、何と同じだったかを言う", () => {
    expect(describeRetryNote("repeat", "最強の理由")).toContain("「最強の理由」");
  });

  it("決まった枠の繰り返しなら、別の1点を選ばせず、その枠について書き直させる", () => {
    const note = describeRetryNote("repeat", "起", "承");
    expect(note).toContain("【承】");
    expect(note).not.toContain("別の1点");
  });

  it("候補が足りないなら、依頼文や見せた案を使わないよう言い直す", () => {
    expect(describeRetryNote("candidates", "使える候補が1個でした")).toContain("前に見せた案");
  });

  it("確かめ直しの繰り返しなら、次の1点へ進むよう言う", () => {
    expect(describeRetryNote("clarify")).toContain("mode は ask");
  });
});

describe("まとめ（P-44）", () => {
  const decisions: PlotDecision[] = [
    { topic: "最強の理由", answer: "回線が魔力も運ぶ", section: "worldview" },
    { topic: "主人公の着地", answer: "電気工事士の資格を取る", section: "outline" },
    { topic: "最強は誰か", answer: "くたびれた班長", section: "mainCharacters" },
  ];

  it("決まったことが入っていればそのまま受け取る", () => {
    const check = validatePlotSummary(
      JSON.stringify({
        logline: "〔補い〕回線業者の新人が、魔力を運ぶ回線を守る話",
        worldview: "回線が魔力も運ぶ世界",
        mainCharacters: "- くたびれた班長（最強）",
        outline: "- 〜5万字：新人が現場に入る\n- 〜10万字：電気工事士の資格を取る",
        theme: "",
      }),
      decisions
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.restored).toEqual([]);
    expect(check.contents.get("logline")).toContain("〔補い〕");
    expect(check.contents.has("theme")).toBe(false);
  });

  it("まとめから抜けた決まったことは、作者の言葉のまま書く先へ戻す（マージはコード）", () => {
    const check = validatePlotSummary(
      JSON.stringify({ worldview: "回線が魔力も運ぶ世界", outline: "- 班長と新人が現場に入る" }),
      decisions
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.restored.map((item) => item.topic)).toEqual(["主人公の着地", "最強は誰か"]);
    expect(check.contents.get("outline")).toBe(
      "- 〔補い〕班長と新人が現場に入る\n- 主人公の着地：電気工事士の資格を取る"
    );
    expect(check.contents.get("mainCharacters")).toBe("- 最強は誰か：くたびれた班長");
  });

  it("決まったことが別の項目へ移っただけでも、書く先の項目に無ければ戻す（起承転結の並びを欠かさない）", () => {
    // 手元の gemma4:e4b は「起」の答えを人物の欄へ書き、あらすじの並びから落とした（2026-09-25）
    const check = validatePlotSummary(
      JSON.stringify({
        mainCharacters: "- 主人公：通信業者の新人技術者",
        outline: "- 承：配線が魔力を運ぶと分かる",
      }),
      [
        { topic: "起", answer: "通信業者の新人技術者が初現場に入る", section: "outline" },
        { topic: "承", answer: "配線が魔力を運ぶと分かる", section: "outline" },
      ]
    );
    expect(check.ok && check.restored.map((item) => item.topic)).toEqual(["起"]);
    expect(check.ok && check.contents.get("outline")).toContain("- 起：通信業者の新人技術者が初現場に入る");
  });

  it("決まったこと・着想のどれにも根ざさない行は、印が無ければコードが〔補い〕を付ける", () => {
    // 手元の gemma4:e4b は、作者が一度も決めていない人称やテーマを印なしで埋めた
    const check = validatePlotSummary(
      JSON.stringify({
        logline: "回線業者の新人が、魔力を運ぶ回線を守る話",
        narrativePerson: "三人称視点",
        theme: "専門知識が極限で武器になることの証明",
        worldview: "回線が魔力も運ぶ世界",
      }),
      decisions,
      ["現代にダンジョン。回線業者の新人が最強の班長と組む"]
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.contents.get("narrativePerson")).toBe("〔補い〕三人称視点");
    expect(check.contents.get("theme")).toBe("〔補い〕専門知識が極限で武器になることの証明");
    // 着想・決まったことに根ざす行はそのまま
    expect(check.contents.get("logline")).toBe("回線業者の新人が、魔力を運ぶ回線を守る話");
    expect(check.contents.get("worldview")).toBe("回線が魔力も運ぶ世界");
    expect(check.marked).toBe(2);
  });

  it("印だけ・鍵の名前・伏せ字は中身にしない。全部空なら受け取らない", () => {
    expect(
      validatePlotSummary(
        JSON.stringify({ logline: "〔補い〕", outline: "outline", worldview: "〇〇が××する世界" }),
        []
      )
    ).toMatchObject({ ok: false, reason: "empty" });
  });

  it("項目の見出しや説明がそのまま返っても中身にしない", () => {
    expect(
      validatePlotSummary(
        JSON.stringify({ theme: "テーマ", logline: "ログライン（話を一言で）" }),
        []
      )
    ).toMatchObject({ ok: false, reason: "empty" });
  });

  it("JSONでなければ受け取らない", () => {
    expect(validatePlotSummary("まとめました", decisions)).toMatchObject({ ok: false, reason: "json" });
  });
});

describe("似かた", () => {
  it("同じ文は1、まったく違う文は0に近い", () => {
    expect(similarity("業者はなぜ最強？", "業者はなぜ最強？")).toBe(1);
    expect(similarity("業者はなぜ最強？", "主人公の年齢は？")).toBeLessThan(0.3);
  });
});
