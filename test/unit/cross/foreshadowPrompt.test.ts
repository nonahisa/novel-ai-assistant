import { describe, expect, test } from "vitest";
import {
  buildForeshadowDetectPrompt,
  FORESHADOW_DETECT_HINTS,
  FORESHADOW_DETECT_SCHEMA,
  FORESHADOW_DETECT_SYSTEM_PROMPT,
  FORESHADOW_LABEL_MAX_CHARS,
} from "../../src/prompts/foreshadowDetect";
import {
  buildForeshadowResolvePrompt,
  FORESHADOW_RESOLVE_HINTS,
  FORESHADOW_RESOLVE_SCHEMA,
  FORESHADOW_RESOLVE_SYSTEM_PROMPT,
} from "../../src/prompts/foreshadowResolve";
import { validateForeshadowCandidates } from "../../src/core/foreshadowValidation";
import type { Chunk } from "../../src/core/chunker";

/**
 * 伏線の検知のプロンプト（P-25 / P-26、設計書6.35.2・6.35.3）。
 *
 * **取り出させるだけにする**のがこの機能の要である。判定させると、
 * モデルは物語の続きを想像して書き始める。
 *
 * あわせて、**指示の言葉がそのまま答えとして返ってくる**前提の検査を置く
 * （`CLAUDE.md` の繰り返し起きた失敗3）。プロンプトの出力例に書いた
 * 言い換えは、検証側が弾けなければならない。
 */

describe("P-25 配置の検知", () => {
  const input = {
    chapterLabel: "第3話",
    chunkText: "銀の懐中時計を、彼はしまい込んだ。",
    knownLabels: ["失われた家系図"],
  };

  test("取り出すだけを頼み、続きを想像させない", () => {
    expect(FORESHADOW_DETECT_SYSTEM_PROMPT).toContain(
      "物語の続きを想像して書かないこと"
    );
    expect(FORESHADOW_DETECT_SYSTEM_PROMPT).toContain(
      "引用は本文からそのまま写すこと"
    );
  });

  test("無ければ空で返させる（数を揃えさせない）", () => {
    // 配列があると、モデルは何かを埋めようとする（矛盾検知で実際に起きた）
    expect(FORESHADOW_DETECT_SYSTEM_PROMPT).toContain(
      "数を揃えるために当てはまらないものを入れないこと"
    );
  });

  test("何を取り出し、何を取り出さないかを並べる", () => {
    const prompt = buildForeshadowDetectPrompt(input);

    expect(prompt).toContain("謎めいた言及");
    expect(prompt).toContain("意味ありげな小道具");
    expect(prompt).toContain("説明されない違和感");
    expect(prompt).toContain("その場で説明が済んでいる記述");
  });

  test("既に登録されている伏線を渡し、同じものを出させない", () => {
    const prompt = buildForeshadowDetectPrompt(input);

    expect(prompt).toContain("失われた家系図");
    expect(prompt).toContain("これらと同じものは挙げないこと");
  });

  test("まだ1件も無ければ、その旨を書く", () => {
    // 空欄を渡すと、そこに何かがあったのだと読まれる
    const prompt = buildForeshadowDetectPrompt({ ...input, knownLabels: [] });

    expect(prompt).toContain("（まだ登録されていません）");
  });

  test("名前の長さの上限を、コードと同じ数で伝える", () => {
    expect(buildForeshadowDetectPrompt(input)).toContain(
      `${FORESHADOW_LABEL_MAX_CHARS}字以内`
    );
  });

  test("スキーマの項目はすべて required", () => {
    // 任意項目にすると、小さいモデルは埋めずに落とす
    const items = FORESHADOW_DETECT_SCHEMA.properties.foreshadows.items;

    expect([...items.required]).toEqual(Object.keys(items.properties));
    expect([...FORESHADOW_DETECT_SCHEMA.required]).toEqual([
      "foreshadows",
    ]);
  });

  describe("指示の言葉が、そのまま答えとして返ってきたら", () => {
    const chunk: Chunk = {
      filePath: "C:/works/003.txt",
      index: 0,
      text: "銀の懐中時計を、彼はしまい込んだ。",
      startLine: 0,
      chapterStart: 3,
      chapterEnd: 3,
      hash: "h",
    };

    test("出力例の言い換えは、プロンプトにも検証にも同じものが載っている", () => {
      // ここがずれると、例文を直したときに検査だけが古い言葉を見張る
      const prompt = buildForeshadowDetectPrompt(input);
      for (const hint of FORESHADOW_DETECT_HINTS) {
        expect(prompt, hint).toContain(hint);
      }
    });

    test("その言い換えを名前に書いてきたら弾く", () => {
      for (const hint of FORESHADOW_DETECT_HINTS) {
        const result = validateForeshadowCandidates(
          {
            foreshadows: [
              {
                label: hint,
                note: "",
                quote: "銀の懐中時計を、彼はしまい込んだ",
              },
            ],
          },
          chunk
        );
        expect(result.accepted, hint).toHaveLength(0);
        expect(result.rejected[0].reason).toBe("placeholder");
      }
    });

    test("「該当なし」も同じく弾く", () => {
      const result = validateForeshadowCandidates(
        {
          foreshadows: [
            {
              label: "該当なし",
              note: "",
              quote: "銀の懐中時計を、彼はしまい込んだ",
            },
          ],
        },
        chunk
      );

      expect(result.accepted).toHaveLength(0);
    });
  });
});

describe("P-26 回収の検知", () => {
  const foreshadows = [
    {
      id: "foreshadow_001",
      label: "銀の懐中時計",
      note: "話せない事情がある",
      plantedQuote: "銀の懐中時計を、彼はしまい込んだ",
      plantedChapter: 3,
    },
    {
      id: "foreshadow_002",
      label: "外れた錠前",
      note: "",
      plantedQuote: "",
      plantedChapter: null,
    },
  ];
  const input = {
    chapterLabel: "第7話",
    chunkText: "彼は時計の蓋を開け、母の名を口にした。",
    foreshadows,
  };

  test("一覧に無い番号を書かせない", () => {
    expect(FORESHADOW_RESOLVE_SYSTEM_PROMPT).toContain(
      "一覧に無い番号を書かないこと"
    );
    expect(buildForeshadowResolvePrompt(input)).toContain(
      "上の一覧に書かれた番号をそのまま写してください"
    );
  });

  test("未回収の伏線を、番号つきで並べる", () => {
    const prompt = buildForeshadowResolvePrompt(input);

    expect(prompt).toContain("foreshadow_001｜銀の懐中時計");
    expect(prompt).toContain("張った箇所：「銀の懐中時計を、彼はしまい込んだ」");
    expect(prompt).toContain("張った話：第3話");
  });

  test("張った箇所そのものを回収と見なさせない", () => {
    // **実データで最多の誤りだった。** 却下8件のうち5件が `planted_echo`
    // ——渡した「張った箇所」の文をそのまま回収として挙げていた
    // （作者のログ、2026-08-30 22:54）。一覧には「張った箇所：「…」」と
    // 書いておきながら、それを挙げるなとは書いていなかった
    const prompt = buildForeshadowResolvePrompt(input);

    expect(prompt).toContain("回収と見なさないもの");
    expect(prompt).toMatch(/「張った箇所」に書かれている文そのもの/);
    // 同じ話の中に張った箇所が入りうることも伝える（それが起きた回だった）
    expect(prompt).toMatch(/同じ話の中に張った箇所が含まれることがあります/);
  });

  test("話数が分からないものには、話数の行を書かない", () => {
    // 「不明」と書くと、それを手掛かりに判断されかねない
    const prompt = buildForeshadowResolvePrompt({
      ...input,
      foreshadows: [foreshadows[1]],
    });

    expect(prompt).toContain("foreshadow_002｜外れた錠前");
    expect(prompt).not.toContain("張った話：");
  });

  test("出力例の番号は、一覧の先頭のものにする", () => {
    // 架空の番号を例に出すと、それをそのまま返してくる
    expect(buildForeshadowResolvePrompt(input)).toContain(
      '"id": "foreshadow_001"'
    );
  });

  test("回収と見なすもの・見なさないものを並べる", () => {
    const prompt = buildForeshadowResolvePrompt(input);

    expect(prompt).toContain("正体・事情が、本文で明かされた");
    expect(prompt).toContain("同じ言葉や人物が出てくるだけ");
  });

  test("回収されたと言い切れるものだけを挙げさせる", () => {
    expect(FORESHADOW_RESOLVE_SYSTEM_PROMPT).toContain(
      "回収されたと言い切れるものだけを挙げること"
    );
    expect(FORESHADOW_RESOLVE_SYSTEM_PROMPT).toContain(
      "数を揃えるために当てはまらないものを入れないこと"
    );
  });

  test("出力例の言い換えは、プロンプトにも検証にも同じものが載っている", () => {
    const prompt = buildForeshadowResolvePrompt(input);
    for (const hint of FORESHADOW_RESOLVE_HINTS) {
      expect(prompt, hint).toContain(hint);
    }
  });

  test("スキーマの項目はすべて required", () => {
    const items = FORESHADOW_RESOLVE_SCHEMA.properties.resolutions.items;

    expect([...items.required]).toEqual(Object.keys(items.properties));
    expect([...FORESHADOW_RESOLVE_SCHEMA.required]).toEqual(["resolutions"]);
  });
});
