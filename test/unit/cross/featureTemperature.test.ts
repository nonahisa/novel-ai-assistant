import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  runByRunner,
  runOnce,
  temperatureFor,
} from "../../../src/mcp/tools/run";
import { OLLAMA_GENERATE_INPUT } from "../../../src/mcp/tools/ollama";
import { runSakuraChunks } from "../../../scripts/measureSakura.mjs";

import { TYPO_CHECK_TEMPERATURE } from "../../../src/prompts/typoCheck";
import { PROOFREAD_TEMPERATURE } from "../../../src/prompts/proofread";
import { NOTATION_ADVICE_TEMPERATURE } from "../../../src/prompts/notationAdvice";
import { CONTRADICTION_CHECK_TEMPERATURE } from "../../../src/prompts/contradictionCheck";
import { CONTRADICTION_VERIFY_TEMPERATURE } from "../../../src/prompts/contradictionVerify";
import { STORY_FACT_EXTRACT_TEMPERATURE } from "../../../src/prompts/storyFactExtract";
import { FORESHADOW_DETECT_TEMPERATURE } from "../../../src/prompts/foreshadowDetect";
import { FORESHADOW_RESOLVE_TEMPERATURE } from "../../../src/prompts/foreshadowResolve";
import { DEVIATION_CHECK_TEMPERATURE } from "../../../src/prompts/deviationCheck";
import { EPISODE_PLOT_CHECK_TEMPERATURE } from "../../../src/prompts/episodePlotCheck";
import { EPISODE_PLOT_CONTRAST_TEMPERATURE } from "../../../src/prompts/episodePlotContrast";
import { CHARACTER_EXTRACT_TEMPERATURE } from "../../../src/prompts/characterExtract";
import { SYNOPSIS_TEMPERATURE } from "../../../src/prompts/synopsis";
import { PLOT_REVERSE_TEMPERATURE } from "../../../src/prompts/plotReverse";
import { CHAPTER_PROPOSE_TEMPERATURE } from "../../../src/prompts/chapterPropose";
import {
  BLURB_TEMPERATURE,
  CATCHPHRASE_TEMPERATURE,
} from "../../../src/prompts/blurb";
import { OPENING_CHECK_TEMPERATURE } from "../../../src/prompts/openingCheck";
import { NAME_SUGGEST_TEMPERATURE } from "../../../src/prompts/nameSuggest";
import { PLOT_NAME_SUGGEST_TEMPERATURE } from "../../../src/prompts/plotNameSuggest";
import { WORK_CHAT_TEMPERATURE } from "../../../src/prompts/workChat";
import { SEARCH_TERMS_TEMPERATURE } from "../../../src/prompts/searchTerms";

/**
 * 温度は、製品と測定台で同じものを見る（設計書6.87.16）。
 *
 * ## なぜこの試験が要るのか
 *
 * 2026-09-19 に見つかった。MCP の `ollama.generate` は **temperature の既定を
 * 0.2 で持っており**、`novel.run` は温度を渡していなかった。製品は機能ごとに
 * 渡していて、**誤字脱字は 0.0** である。つまり
 * **誤字脱字を測るときだけ、製品より揺れた条件で測っていた。**
 *
 * これは「実接続の測定は、製品と同じ検証を通す」（CLAUDE.md の繰り返し起きた
 * 失敗5）に触れる。しかも実害があって、**2026-09-18 に何度も測った誤字脱字と
 * 推敲の数字は、製品と違う条件で取られていた**ことになる。
 *
 * ## 何を見張るか
 *
 * 1. **値はプロンプトのそばに1つだけ置く**（`prompts/*.ts` の `*_TEMPERATURE`）。
 *    ここが唯一の定義で、製品も測定台もそこを見る
 * 2. **製品が数字を直書きへ戻していないこと**（戻ると、また片方だけ直る日が来る）
 * 3. **明示が無ければ製品の値、明示があればその値**（揺らして測る道は残す）
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");

/** 数字は1か所にしか無い。**ここは「値そのもの」の錨である** */
const EXPECTED: Array<[string, number]> = [
  ["誤字脱字（P-08）", TYPO_CHECK_TEMPERATURE],
  ["推敲（P-09）", PROOFREAD_TEMPERATURE],
  ["表記ゆれ（P-10）", NOTATION_ADVICE_TEMPERATURE],
  ["矛盾検知（P-12）", CONTRADICTION_CHECK_TEMPERATURE],
  ["矛盾の判定（P-12b）", CONTRADICTION_VERIFY_TEMPERATURE],
  ["事実の抽出（P-37）", STORY_FACT_EXTRACT_TEMPERATURE],
  ["伏線の検知（P-25）", FORESHADOW_DETECT_TEMPERATURE],
  ["伏線の回収（P-26）", FORESHADOW_RESOLVE_TEMPERATURE],
  ["プロット逸脱（P-11）", DEVIATION_CHECK_TEMPERATURE],
  ["単話プロットの緩み", EPISODE_PLOT_CHECK_TEMPERATURE],
  ["単話プロットの照合", EPISODE_PLOT_CONTRAST_TEMPERATURE],
  ["設定資料の抽出（P-04a）", CHARACTER_EXTRACT_TEMPERATURE],
  ["各話あらすじ（P-02）", SYNOPSIS_TEMPERATURE],
  ["プロット逆算（P-04）", PLOT_REVERSE_TEMPERATURE],
  ["章立て", CHAPTER_PROPOSE_TEMPERATURE],
  ["作品紹介文（P-05）", BLURB_TEMPERATURE],
  ["キャッチコピー（P-06）", CATCHPHRASE_TEMPERATURE],
  ["冒頭診断", OPENING_CHECK_TEMPERATURE],
  ["名前の候補（P-29）", NAME_SUGGEST_TEMPERATURE],
  ["プロットの名前の候補（P-45）", PLOT_NAME_SUGGEST_TEMPERATURE],
  ["相談（P-20）", WORK_CHAT_TEMPERATURE],
  ["検索語づくり", SEARCH_TERMS_TEMPERATURE],
];

describe("機能ごとの温度", () => {
  it("どれも 0〜1 の数で、事実を照らす仕事ほど低い", () => {
    for (const [label, value] of EXPECTED) {
      expect(typeof value, label).toBe("number");
      expect(value, label).toBeGreaterThanOrEqual(0);
      expect(value, label).toBeLessThanOrEqual(1);
    }
    // **ここがずれたのが今回の不具合の正体である。** 誤字脱字は揺らさない
    expect(TYPO_CHECK_TEMPERATURE).toBe(0);
    // 言い回しの提案なので、事実の突き合わせより少しだけ揺らす
    expect(PROOFREAD_TEMPERATURE).toBe(0.2);
    // 案を出させるものは、いちばん揺らす
    expect(CATCHPHRASE_TEMPERATURE).toBeGreaterThan(BLURB_TEMPERATURE);
  });
});

/* ── 製品が数字を直書きへ戻していないか ─────────────────── */

/** 温度を渡している製品のファイルと、渡しているはずの定数 */
const PRODUCT_WIRED: Array<[string, string]> = [
  ["src/features/checkTypos.ts", "TYPO_CHECK_TEMPERATURE"],
  ["src/features/checkProofread.ts", "PROOFREAD_TEMPERATURE"],
  ["src/features/notationAdvice.ts", "NOTATION_ADVICE_TEMPERATURE"],
  ["src/features/checkContradictions.ts", "CONTRADICTION_CHECK_TEMPERATURE"],
  ["src/features/checkContradictions.ts", "CONTRADICTION_VERIFY_TEMPERATURE"],
  ["src/features/checkFactContradictions.ts", "STORY_FACT_EXTRACT_TEMPERATURE"],
  ["src/features/checkFactContradictions.ts", "CONTRADICTION_VERIFY_TEMPERATURE"],
  ["src/features/checkForeshadows.ts", "FORESHADOW_DETECT_TEMPERATURE"],
  ["src/features/checkForeshadows.ts", "FORESHADOW_RESOLVE_TEMPERATURE"],
  ["src/features/checkDeviations.ts", "DEVIATION_CHECK_TEMPERATURE"],
  ["src/features/checkEpisodePlot.ts", "EPISODE_PLOT_CHECK_TEMPERATURE"],
  ["src/features/checkEpisodePlot.ts", "EPISODE_PLOT_CONTRAST_TEMPERATURE"],
  ["src/features/generateSynopses.ts", "SYNOPSIS_TEMPERATURE"],
  ["src/features/generatePlot.ts", "PLOT_REVERSE_TEMPERATURE"],
  ["src/features/proposeChapters.ts", "CHAPTER_PROPOSE_TEMPERATURE"],
  ["src/features/generateBlurb.ts", "BLURB_TEMPERATURE"],
  ["src/features/generateBlurb.ts", "CATCHPHRASE_TEMPERATURE"],
  ["src/features/nameCheck.ts", "NAME_SUGGEST_TEMPERATURE"],
  ["src/features/plotNameSuggest.ts", "PLOT_NAME_SUGGEST_TEMPERATURE"],
  ["src/features/workChatPanel.ts", "WORK_CHAT_TEMPERATURE"],
  ["src/features/workChatPanel.ts", "SEARCH_TERMS_TEMPERATURE"],
  ["src/features/settingsPanel.ts", "SEARCH_TERMS_TEMPERATURE"],
];

/**
 * まだ定数へ繋げていない製品のファイルと、直書きされている値。
 *
 * **この2つは 2026-09-19 の時点で別のエージェントが触っており、
 * 同時に直すと衝突する**ので、値が食い違っていないことだけを見張る。
 * 繋ぎ替えたら、この表から `PRODUCT_WIRED` へ移すこと。
 */
const PRODUCT_LITERAL: Array<[string, number]> = [
  ["src/features/checkOpening.ts", OPENING_CHECK_TEMPERATURE],
  ["src/features/extractCharacters.ts", CHARACTER_EXTRACT_TEMPERATURE],
];

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

describe("製品は温度を直書きしない", () => {
  for (const [file, constant] of PRODUCT_WIRED) {
    it(`${file} は ${constant} を渡す`, () => {
      expect(read(file)).toContain(`temperature: ${constant},`);
    });
  }

  it("繋げたファイルに、温度の数字が残っていない", () => {
    const offenders: string[] = [];
    for (const [file] of PRODUCT_WIRED) {
      const source = read(file);
      for (const line of source.split("\n")) {
        if (/^\s*temperature: [\d.]+,\s*$/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(
      [...new Set(offenders)],
      "温度は prompts/*.ts の定数から引いてください（写しを置くと片方だけ直る日が来ます）"
    ).toEqual([]);
  });

  for (const [file, expected] of PRODUCT_LITERAL) {
    it(`${file} の直書きが、プロンプトの定数と食い違っていない`, () => {
      const found = [...read(file).matchAll(/^\s*temperature: ([\d.]+),\s*$/gm)]
        .map((match) => Number(match[1]));
      expect(found.length, `${file} に温度の行が無い`).toBeGreaterThan(0);
      for (const value of found) expect(value).toBe(expected);
    });
  }
});

/* ── 行き先ごとに、同じ考え方で揃うか ─────────────────── */

const PROMPTS = {
  systemPrompt: "s",
  schema: { type: "object" },
  temperature: 0.4,
  chunks: [{ chunkId: "c1", userPrompt: "u" }],
};

/** `ollamaGenerate` の代わり。**何度で呼ばれたかを控える** */
function recordingAsk(seen: number[]) {
  return async (params: { temperature: number }) => {
    seen.push(params.temperature);
    return { text: "{}" };
  };
}

describe("novel.run の温度", () => {
  it("明示が無ければ、製品と同じ温度で投げる（ollama）", async () => {
    const seen: number[] = [];
    const outcome = await runByRunner(
      { runner: "ollama", model: "m", numCtx: 4096 },
      PROMPTS,
      "novel.validate（feature: typo）",
      () => "ok",
      recordingAsk(seen)
    );
    expect(seen).toEqual([0.4]);
    expect(outcome.runner).toBe("ollama");
    // **記録に残す。** `num_ctx` と同じで、無いと後から比べられない
    expect(outcome).toMatchObject({ temperature: 0.4 });
  });

  it("明示されたら、その温度で投げる（ollama）", async () => {
    const seen: number[] = [];
    const outcome = await runByRunner(
      { runner: "ollama", model: "m", numCtx: 4096, temperature: 0.9 },
      PROMPTS,
      "novel.validate（feature: typo）",
      () => "ok",
      recordingAsk(seen)
    );
    expect(seen).toEqual([0.9]);
    expect(outcome).toMatchObject({ temperature: 0.9 });
  });

  it("claude の道（プロンプトだけ返す）でも温度を渡す", async () => {
    const outcome = await runByRunner(
      { runner: "claude", numCtx: 4096 },
      PROMPTS,
      "novel.validate（feature: typo）",
      () => "ok",
      recordingAsk([])
    );
    // **これが無いと、受け取った側が自分の既定で投げる**
    expect(outcome).toMatchObject({ runner: "claude", temperature: 0.4 });
  });

  it("1回で答える機能（runOnce）でも同じ決め方をする", async () => {
    const prompt = {
      systemPrompt: "s",
      schema: {},
      userPrompt: "u",
      temperature: 0.5,
      validateWith: "novel.validate（feature: blurb）",
    };
    const asIs = await runOnce({ runner: "claude" }, prompt, () => "ok");
    expect(asIs).toMatchObject({ temperature: 0.5 });

    const explicit = await runOnce(
      { runner: "claude", temperature: 0.1 },
      prompt,
      () => "ok"
    );
    expect(explicit).toMatchObject({ temperature: 0.1 });
  });

  it("決め方は1か所だけにある（temperatureFor）", () => {
    expect(temperatureFor({}, 0.3)).toBe(0.3);
    expect(temperatureFor({ temperature: 0.7 }, 0.3)).toBe(0.7);
    // **0 を「指定なし」と読まない。** 誤字脱字はまさに 0 である
    expect(temperatureFor({ temperature: 0 }, 0.3)).toBe(0);
  });
});

describe("ollama.generate は温度を省けない", () => {
  it("入力の形で必須にしてある", () => {
    // **既定（0.2）を持っていたのが、今回の不具合の入口だった**
    const parsed = OLLAMA_GENERATE_INPUT.temperature.safeParse(undefined);
    expect(parsed.success).toBe(false);
    expect(OLLAMA_GENERATE_INPUT.temperature.safeParse(0).success).toBe(true);
  });
});

/* ── 測定台（クラウド経路）──────────────────────────── */

describe("さくらで測るときの温度", () => {
  it("novel.prompt が返した製品の温度で投げる", async () => {
    const seen: number[] = [];
    await runSakuraChunks({
      promptResponse: {
        systemPrompt: "s",
        schema: null,
        temperature: 0.2,
        chunks: [{ chunkId: "c1", userPrompt: "u" }],
      },
      baseArgs: { folder: "f", feature: "proofread" },
      // **ここで測りたいのは「温度を渡さなければ製品の値が使われる」こと**なので、
      // `temperature` は書かずに省く（`runSakuraChunks` の JSDoc が任意と書いている）
      ask: async (params: { temperature: number }) => {
        seen.push(params.temperature);
        return { text: "{}" };
      },
      validate: async () => ({ chunkId: "c1" }),
    });
    expect(seen).toEqual([0.2]);
  });

  it("明示されたら、そちらが勝つ", async () => {
    const seen: number[] = [];
    await runSakuraChunks({
      promptResponse: {
        systemPrompt: "s",
        schema: null,
        temperature: 0.2,
        chunks: [{ chunkId: "c1", userPrompt: "u" }],
      },
      temperature: 0.8,
      baseArgs: { folder: "f", feature: "proofread" },
      ask: async (params: { temperature: number }) => {
        seen.push(params.temperature);
        return { text: "{}" };
      },
      validate: async () => ({ chunkId: "c1" }),
    });
    expect(seen).toEqual([0.8]);
  });
});
