import { describe, expect, test } from "vitest";
import { detectChatTopic } from "../../../src/core/chatTopic";
import {
  buildFeatureGuideForQuestion,
  buildFeatureIndex,
  buildGuideBundles,
  NO_INDEX_NOTICE,
} from "../../../src/features/featureGuide";
import {
  buildWorkChatSystemPrompt,
  WORK_CHAT_SYSTEM_PROMPT,
} from "../../../src/prompts/workChat";

/**
 * 創作の相談か、操作の相談か（設計書6.27.9）。
 *
 * ## 何を守っているか
 *
 * 相談へ渡す「使い方の説明」は、説明の束だけが絞られていて、**目次
 * （全操作の名前）は無条件で毎回乗っていた**。実測（2026-09-13）では、
 * 創作の相談で渡した2,293字が**すべて目次**で、説明は0字だった。
 * あわせて、システムの指示の【この拡張機能の使い方を聞かれたとき】も
 * まるごと「末尾の目次と説明の使い方」の説明なので、目次を渡さない回には
 * 要らない（残すと「目次に無い機能は存在しません」が嘘になる）。
 *
 * **両側を測る。** 減ったことだけを見ると、何も渡さない実装が満点になる。
 * 操作の質問で目次が落ちていないことも、同じだけ大事である。
 */

/** 実測した創作の相談（2026-09-13。どちらも目次2,293字がまるごと無駄だった） */
const CRAFT_QUESTIONS = [
  "主人公の動機が弱い気がします",
  "第12話の終わり方が唐突でしょうか",
];

/** 実測した操作の相談（同日） */
const HOWTO_QUESTIONS = ["誤字脱字の検知はどこから", "EPUBに表紙を入れるには"];

const bundles = buildGuideBundles();

describe("話題の見分け", () => {
  test("創作の相談は craft", () => {
    for (const question of CRAFT_QUESTIONS) {
      expect(detectChatTopic({ question, bundles }), question).toBe("craft");
    }
  });

  test("操作の相談は howto", () => {
    for (const question of HOWTO_QUESTIONS) {
      expect(detectChatTopic({ question, bundles }), question).toBe("howto");
    }
  });

  /*
    **迷ったら craft へ倒さない。** 操作の質問を craft と誤ると、AIは操作の
    名前を1つも持たないまま答えることになる。逆に創作の相談を unknown と
    誤っても、無駄になるのは字数だけである。
  */
  test("どちらとも決められないものは unknown", () => {
    const vague = ["これ、どうすればいい？", "これってどうやるんでしたっけ"];

    for (const question of vague) {
      expect(detectChatTopic({ question, bundles }), question).toBe("unknown");
    }
  });

  /*
    **創作の相談の言い回しを、操作の言い回しと取り違えないこと。**
    「どう思いますか」「どう書き出すか」を操作寄りに採ると、節約が消える。
  */
  test("「どう思う」「どう書き出すか」は craft のまま", () => {
    const questions = [
      "主人公の動機が弱い気がします。どう思いますか",
      "次の話をどう書き出すか迷っています",
      "この場面の描写、もっと良くできますか",
    ];

    for (const question of questions) {
      expect(detectChatTopic({ question, bundles }), question).toBe("craft");
    }
  });

  /*
    追い質問（「それはどこ？」）には機能名が入っていない。**話題は直前の
    発言が持っている**ので、そこまで見ないと判定できない。
  */
  test("追い質問は、直前の発言から話題を引き継ぐ", () => {
    const followUp = "それはどこ？";

    // 直前が操作の話なら、操作の相談として扱う
    expect(
      detectChatTopic({
        question: followUp,
        recentAuthorTurns: ["誤字脱字の検知はどこから"],
        bundles,
      })
    ).toBe("howto");

    // 直前が作品の話でも、言い回しが操作寄りなら言い切らない（unknown）
    expect(
      detectChatTopic({
        question: followUp,
        recentAuthorTurns: ["主人公の動機が弱い気がします"],
        bundles,
      })
    ).toBe("unknown");

    // 作品の話の追い質問は craft のまま
    expect(
      detectChatTopic({
        question: "それってどういうこと",
        recentAuthorTurns: ["主人公の動機が弱い気がします"],
        bundles,
      })
    ).toBe("craft");
  });

  test("束を渡さなくても、言い回しだけで craft と言い切らない", () => {
    // 束が無ければ当たりを調べられないので、操作の言い回しは unknown に留まる
    expect(detectChatTopic({ question: "誤字脱字の検知はどこから" })).toBe(
      "unknown"
    );
  });
});

describe("目次を渡すかどうか", () => {
  test("創作の相談では、目次を渡さない", () => {
    for (const question of CRAFT_QUESTIONS) {
      const built = buildFeatureGuideForQuestion({ question });

      expect(built.topic, question).toBe("craft");
      // 目次の中身（分類の見出し・操作の名前）が1つも入っていないこと
      expect(built.text, question).not.toContain("詳細メニューの操作");
      expect(built.text, question).not.toContain("誤字脱字を検知");
      expect(built.text, question).toBe(NO_INDEX_NOTICE);
    }
  });

  test("操作の相談では、これまでどおり目次を渡す", () => {
    for (const question of HOWTO_QUESTIONS) {
      const built = buildFeatureGuideForQuestion({ question });

      expect(built.topic, question).toBe("howto");
      expect(built.text, question).toContain("詳細メニューの操作");
      expect(built.text, question).toContain("誤字脱字を検知");
    }
  });

  test("迷った回（unknown）では、目次を渡す", () => {
    const built = buildFeatureGuideForQuestion({
      question: "これ、どうすればいい？",
    });

    expect(built.topic).toBe("unknown");
    expect(built.text).toContain("詳細メニューの操作");
  });
});

describe("目次を省いた回の聞き返し", () => {
  /*
    **知らないものを、知っている風に書かせない。** 目次が無い回のAIは操作名を
    1つも持たない。それでも聞かれればそれらしい画面名を作って答えるので、
    作り話を禁じ、聞き返させる（作者の指定、2026-09-13）。
  */
  test("省いた回にだけ、聞き返しの指示が入る", () => {
    const craft = buildFeatureGuideForQuestion({ question: CRAFT_QUESTIONS[0] });
    expect(craft.text).toContain("もう一度そう言ってお尋ねください");
    expect(craft.text).toContain("推測で書かないこと");

    for (const question of [...HOWTO_QUESTIONS, "これ、どうすればいい？"]) {
      expect(
        buildFeatureGuideForQuestion({ question }).text,
        question
      ).not.toContain("もう一度そう言ってお尋ねください");
    }
  });

  test("聞き返しの断りに、Markdownの記号を混ぜない", () => {
    // 画面には出ないが、AIへの指示に記号が混ざると読みにくい。
    // 記号の混入を見張る試験（plainTextUi）と同じ規則で揃えておく
    expect(NO_INDEX_NOTICE).not.toContain("*".repeat(2));
  });
});

describe("使い方の節も、目次と一緒に外す", () => {
  /*
    あの節はまるごと「末尾に渡した目次と説明の使い方」の説明である。
    **目次を渡さないのに残すと嘘になる**——「目次に無い機能は存在しません」と
    書いてあるのに目次が無い状態は、「何も存在しない」と読まれかねない。
  */
  test("目次を渡さない回には、使い方の節が入っていない", () => {
    const trimmed = buildWorkChatSystemPrompt({ featureIndex: false });

    expect(trimmed).not.toContain("【この拡張機能の使い方を聞かれたとき】");
    expect(trimmed).not.toContain("目次に無い機能は存在しません");
  });

  test("目次を渡す回には、これまでどおり入っている", () => {
    const full = buildWorkChatSystemPrompt({ featureIndex: true });

    expect(full).toContain("【この拡張機能の使い方を聞かれたとき】");
    expect(full).toContain("目次に無い機能は存在しません");
    // 既定は「渡す」。呼び出し側が指定を忘れても、これまでの形になる
    expect(buildWorkChatSystemPrompt()).toBe(full);
  });

  /*
    **節へ割り直したことで、1文字もずれていないこと。** 6,580字は、割る前の
    `WORK_CHAT_SYSTEM_PROMPT` を実測した値だった（2026-09-13）。ここが動いたら、
    割り方（空行の数など）を間違えたか、プロンプト本文を変えたかのどちらか。

    **6,629字へ更新した（2026-09-21・v3.11）。** 書き込みを確認なしで行う
    裁定に伴い、【書き込みを頼まれたとき】の説明を実態へ合わせたぶん
    （49字）増えている。プロンプトを変えた側の更新である。

    **6,994字へ更新した（2026-09-21・v3.13）。** 【作業を頼まれたとき】の
    冒頭へ「あなたは操作を実行できない。押すのは作者」を足したぶん
    （365字）増えている。足した理由は `workChat.ts` の版の履歴にある。

    **6,995字へ更新した（2026-09-22・v3.14）。** 起動できる機能の札
    （`runnableFeatureList`）の1件を詳細メニューの名前へ合わせたぶん
    （「起こす」→「逆算する」で1字）増えている。**プロンプト本文ではなく、
    そこへ埋め込む一覧が動いた側**の更新である。
  */
  test("目次を渡す回のシステム指示は、割る前と同じ長さ", () => {
    expect(WORK_CHAT_SYSTEM_PROMPT.length).toBe(6995);
  });

  test("外れるのは、使い方の節だけ", () => {
    const trimmed = buildWorkChatSystemPrompt({ featureIndex: false });

    // 出力の欄（edit・run・reloadRecord）の歯止めは残す。
    // ここが落ちると、本文の書き換えや実在しない機能の起動を止めるものが消える
    for (const heading of [
      "【絶対に守る原則】",
      "【答え方】",
      "【材料が足りないとき】",
      "【書き込みを頼まれたとき】",
      "【作業を頼まれたとき】",
      "【本文の場所を指すとき】",
      "【設定資料の誤り・混入を訴えられたとき】",
      "【出力形式】",
    ]) {
      expect(trimmed, heading).toContain(heading);
    }
  });
});

describe("実際に減った量", () => {
  /*
    回帰の土台。**実数で固定する**——「短くなった」だけでは、次に何かを足した
    ときに元へ戻ったことに気づけない。
  */
  test("創作の相談で、2,700字以上減る", () => {
    const craft = buildFeatureGuideForQuestion({ question: CRAFT_QUESTIONS[0] });

    // ①末尾の資料：目次のぶん
    const savedIndex = buildFeatureIndex().length - craft.text.length;
    // ②システムの指示：使い方の節のぶん（区切りの空行を含む）
    const savedSection =
      WORK_CHAT_SYSTEM_PROMPT.length -
      buildWorkChatSystemPrompt({ featureIndex: false }).length;

    expect(savedIndex + savedSection).toBeGreaterThanOrEqual(2700);
    // 内訳も見ておく。片方だけが効いている状態に気づけるようにする
    expect(savedIndex).toBeGreaterThanOrEqual(2000);
    expect(savedSection).toBeGreaterThanOrEqual(500);
  });

  test("操作の相談では、減らない", () => {
    const howto = buildFeatureGuideForQuestion({ question: HOWTO_QUESTIONS[0] });

    // 目次はまるごと入ったうえで、関係しそうな説明が足されている
    expect(howto.text.length).toBeGreaterThan(buildFeatureIndex().length);
  });
});
