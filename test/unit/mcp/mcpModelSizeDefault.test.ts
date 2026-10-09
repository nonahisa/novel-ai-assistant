import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * MCP の頼み方の既定を、製品と同じ判定にする（作者の裁定 2026-10-10
 * 「製品と同じ判定にする」。設計書6.87.12）。
 *
 * これまで MCP は、外の AI が指定しないとき固定の既定で組んでいた
 * （誤字脱字・逸脱は大きいモデル向け、矛盾検知は「観点を絞る＋ゆるめる」）。
 * 矛盾検知の組み合わせは製品のどの大きさとも一致せず、手元の Ollama で回すときは
 * モデル名が分かるのに使っていなかった。
 *
 * ここで見張ること：
 * 1. `runner: ollama` で指定が無ければ、申告の大きさから**製品の関数**で決める
 * 2. 外の AI が指定したら、それに従う（大きさは問い合わせない）
 * 3. 大きさの分からない道（`novel.prompt`・`claude`・`sampling`）は、製品が
 *    大きいモデルへ送る形にする
 */

const asked: Array<{ systemPrompt: string; userPrompt: string }> = [];
const sizeQueries: string[] = [];
let declaredSize: string | null = null;

vi.mock("../../../src/mcp/tools/ollama", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/mcp/tools/ollama")>();
  return {
    ...actual,
    ollamaGenerate: vi.fn(async (params: { systemPrompt: string; userPrompt: string }) => {
      asked.push({ systemPrompt: params.systemPrompt, userPrompt: params.userPrompt });
      // 逸脱のスキーマにも通る空の答え（ほかの機能は余分な欄を見ない）
      return {
        text: JSON.stringify({ deviations: [], issues: [], contradictions: [] }),
        model: "test",
        endpoint: "",
        elapsedMs: 0,
        truncated: false,
      };
    }),
    ollamaParameterSize: vi.fn(async (input: { model: string }) => {
      sizeQueries.push(input.model);
      return declaredSize;
    }),
  };
});

import { typoRun, typoPrompt } from "../../../src/mcp/tools/typo";
import { contradictionPrompt, contradictionRun } from "../../../src/mcp/tools/contradiction";
import { deviationPrompt, deviationRun } from "../../../src/mcp/tools/episode";
import {
  productSizeChoice,
  UNKNOWN_MODEL_SIZE_CHOICE,
} from "../../../src/mcp/tools/modelSize";
import { capabilityProfile, useSmallModelTypoPrompt } from "../../../src/ai/capability";
import { inferTier } from "../../../src/ai/types";
import {
  TYPO_CHECK_SYSTEM_PROMPT,
  TYPO_CHECK_SYSTEM_PROMPT_SMALL,
} from "../../../src/prompts/typoCheck";
import {
  CONTRADICTION_CHECK_SYSTEM_PROMPT,
  CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT,
} from "../../../src/prompts/contradictionCheck";

const MCP_WORK = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const TYPO_FILE = nodePath.join("本文", "004_よあけ.txt");
const CONTRADICTION_WORK = "test/fixtures/seeded/contradiction";
const CONTRADICTION_FILE = "本文/004_ギプスが外れた日.txt";

const temporaries: string[] = [];

/** 誤字脱字の run はキャッシュを書くので、原本ではなく写しで回す */
function copiedWork(): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "mcp-size-"));
  temporaries.push(folder);
  fs.cpSync(MCP_WORK, folder, { recursive: true });
  return folder;
}

beforeEach(() => {
  asked.length = 0;
  sizeQueries.length = 0;
  declaredSize = null;
});

afterEach(() => {
  for (const folder of temporaries.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("製品の判定の言い換え", () => {
  test("製品の関数そのものの答えを、MCP の名前へ言い換える（写しを持たない）", () => {
    for (const size of ["8.0B", "12.2B", "25.2B", "31B", "3.2B", null]) {
      const tier = inferTier(size, "ollama");
      const input = { tier, providerId: "ollama" as const, parameterSize: size };
      const profile = capabilityProfile(input);
      expect(productSizeChoice(size)).toEqual({
        typoModelSize: useSmallModelTypoPrompt(input) ? "small" : "large",
        deviationModelSize: profile.narrowDeviationTypes ? "small" : "large",
        categories: profile.narrowContradictionCategories ? "light" : "all",
        suppression: profile.suppressUncertainContradictions ? "strict" : "loose",
      });
    }
  });

  test("大きさの分からない道の既定は、製品が大きいクラウドのモデルへ送る形と同じ", () => {
    // 大きさを答えないクラウドのモデル（tier は high、大きさ不明）を製品がどう扱うか
    const input = { tier: "high" as const, providerId: "claude" as const, parameterSize: null };
    const profile = capabilityProfile(input);
    expect(UNKNOWN_MODEL_SIZE_CHOICE).toEqual({
      typoModelSize: useSmallModelTypoPrompt(input) ? "small" : "large",
      deviationModelSize: profile.narrowDeviationTypes ? "small" : "large",
      categories: profile.narrowContradictionCategories ? "light" : "all",
      suppression: profile.suppressUncertainContradictions ? "strict" : "loose",
    });
  });
});

describe("誤字脱字（runner: ollama）", () => {
  test("8.0B のモデルには、製品と同じく小さいモデル向けの文（1.1）を送る", async () => {
    declaredSize = "8.0B";
    const outcome = await typoRun({
      folder: copiedWork(),
      filePath: TYPO_FILE,
      numCtx: 32768,
      runner: "ollama",
      model: "small-model",
    });
    expect(sizeQueries).toEqual(["small-model"]);
    expect(asked[0].systemPrompt).toBe(TYPO_CHECK_SYSTEM_PROMPT_SMALL);
    expect(outcome.modelSizeDecision).toMatchObject({
      source: "product",
      parameterSize: "8.0B",
      given: [],
    });
  });

  test("25.2B のモデルには、大きいモデル向けの文（1.2）を送る", async () => {
    declaredSize = "25.2B";
    await typoRun({
      folder: copiedWork(),
      filePath: TYPO_FILE,
      numCtx: 32768,
      runner: "ollama",
      model: "large-model",
    });
    expect(asked[0].systemPrompt).toBe(TYPO_CHECK_SYSTEM_PROMPT);
  });

  test("大きさが取れなければ、製品と同じく「大きさ不明の手元のAI」として小さい側へ倒す", async () => {
    declaredSize = null;
    const outcome = await typoRun({
      folder: copiedWork(),
      filePath: TYPO_FILE,
      numCtx: 32768,
      runner: "ollama",
      model: "unknown-model",
    });
    expect(asked[0].systemPrompt).toBe(TYPO_CHECK_SYSTEM_PROMPT_SMALL);
    expect(outcome.modelSizeDecision.note).toContain("取れなかった");
  });

  test("外の AI が指定したら、それに従い大きさを問い合わせない", async () => {
    declaredSize = "8.0B";
    const outcome = await typoRun({
      folder: copiedWork(),
      filePath: TYPO_FILE,
      numCtx: 32768,
      runner: "ollama",
      model: "small-model",
      modelSize: "large",
    });
    expect(sizeQueries).toEqual([]);
    expect(asked[0].systemPrompt).toBe(TYPO_CHECK_SYSTEM_PROMPT);
    expect(outcome.modelSizeDecision.given).toEqual(["modelSize"]);
  });

  test("claude の道（プロンプトだけ返す）は大きさが分からないので、大きいモデル向け", async () => {
    const outcome = await typoRun({
      folder: copiedWork(),
      filePath: TYPO_FILE,
      numCtx: 32768,
      runner: "claude",
    });
    expect(sizeQueries).toEqual([]);
    expect(outcome.modelSizeDecision.source).toBe("unknownModel");
    if (outcome.runner !== "claude") throw new Error("claude の結果ではない");
    expect(outcome.systemPrompt).toBe(TYPO_CHECK_SYSTEM_PROMPT);
  });

  test("novel.prompt（指定なし）は大きいモデル向け", () => {
    const built = typoPrompt({ folder: MCP_WORK, filePath: TYPO_FILE, numCtx: 32768 });
    expect(built.systemPrompt).toBe(TYPO_CHECK_SYSTEM_PROMPT);
  });
});

describe("矛盾検知（runner: ollama）", () => {
  function promptFor(categories: string, suppression: string) {
    return contradictionPrompt({
      folder: CONTRADICTION_WORK,
      filePath: CONTRADICTION_FILE,
      numCtx: 16384,
      categories,
      suppression,
    });
  }

  test("8.0B のモデルには、製品と同じく観点を絞って抑制を残す（light＋strict）", async () => {
    declaredSize = "8.0B";
    const outcome = await contradictionRun({
      folder: CONTRADICTION_WORK,
      filePath: CONTRADICTION_FILE,
      numCtx: 16384,
      runner: "ollama",
      model: "small-model",
    });
    const expected = promptFor("light", "strict");
    expect(asked[0].systemPrompt).toBe(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT);
    expect(asked[0].userPrompt).toBe(expected.chunks[0].userPrompt);
    expect(outcome.speechCheck).toBe(false);
    expect(outcome.modelSizeDecision.product).toMatchObject({
      categories: "light",
      suppression: "strict",
    });
  });

  test("25.2B のモデルには、7つの観点でゆるめた版（all＋loose）", async () => {
    declaredSize = "25.2B";
    await contradictionRun({
      folder: CONTRADICTION_WORK,
      filePath: CONTRADICTION_FILE,
      numCtx: 16384,
      runner: "ollama",
      model: "large-model",
    });
    const expected = promptFor("all", "loose");
    expect(asked[0].systemPrompt).toBe(CONTRADICTION_CHECK_SYSTEM_PROMPT);
    expect(asked[0].userPrompt).toBe(expected.chunks[0].userPrompt);
  });

  test("指定は項目ごとに効く（観点だけ指定すれば、抑制は判定で決まる）", async () => {
    declaredSize = "8.0B";
    const outcome = await contradictionRun({
      folder: CONTRADICTION_WORK,
      filePath: CONTRADICTION_FILE,
      numCtx: 16384,
      runner: "ollama",
      model: "small-model",
      categories: "all",
    });
    const expected = promptFor("all", "strict");
    expect(asked[0].systemPrompt).toBe(CONTRADICTION_CHECK_SYSTEM_PROMPT_STRICT);
    expect(asked[0].userPrompt).toBe(expected.chunks[0].userPrompt);
    expect(outcome.modelSizeDecision.given).toEqual(["categories"]);
  });

  test("novel.prompt（指定なし）は、製品が大きいモデルへ送る形（all＋loose）", () => {
    const built = contradictionPrompt({
      folder: CONTRADICTION_WORK,
      filePath: CONTRADICTION_FILE,
      numCtx: 16384,
    });
    expect(built.categories).toHaveLength(7);
    expect(built.systemPrompt).toBe(CONTRADICTION_CHECK_SYSTEM_PROMPT);
    // **製品のどの大きさとも一致しない light＋loose を、既定で組まない**
    expect(built.chunks[0].userPrompt).toBe(promptFor("all", "loose").chunks[0].userPrompt);
  });
});

describe("逸脱（runner: ollama）", () => {
  test("8.0B のモデルには、製品と同じく「逸脱」だけを尋ねる", async () => {
    declaredSize = "8.0B";
    const outcome = await deviationRun({
      folder: MCP_WORK,
      filePath: "本文/004_よあけ.txt",
      runner: "ollama",
      model: "small-model",
    });
    expect(asked[0].userPrompt).not.toContain("間延び：");
    expect(outcome.modelSizeDecision.product.deviationModelSize).toBe("small");
  });

  test("25.2B のモデルには「逸脱」と「間延び」を尋ねる", async () => {
    declaredSize = "25.2B";
    await deviationRun({
      folder: MCP_WORK,
      filePath: "本文/004_よあけ.txt",
      runner: "ollama",
      model: "large-model",
    });
    expect(asked[0].userPrompt).toContain("間延び：");
  });

  test("novel.prompt（指定なし）は大きいモデル向け", () => {
    const built = deviationPrompt({ folder: MCP_WORK, filePath: "本文/004_よあけ.txt" });
    expect(built.userPrompt).toContain("間延び：");
  });
});
