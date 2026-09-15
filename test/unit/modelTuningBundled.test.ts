import { afterEach, describe, expect, test } from "vitest";
import { workspace } from "vscode";
import {
  allModelTuning,
  modelTuning,
  saveModelTuning,
} from "../../src/core/modelTuning";

/**
 * 同梱の初期値を、台帳へどう混ぜるか（作者の裁定、2026-09-13）。
 *
 * 一覧そのものの中身は `bundledTuning.test.ts` が見る。ここで見るのは
 * **混ぜ方**——作者の実測が勝つこと、欄ごとに埋めること、そして
 * **台帳へ焼き付かないこと**。
 */

const original = workspace.getConfiguration;

afterEach(() => {
  workspace.getConfiguration = original;
});

function withSettings(values: Record<string, unknown>): {
  updated: Array<{ key: string; value: unknown }>;
} {
  const updated: Array<{ key: string; value: unknown }> = [];
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
      inspect: (key: string) => ({ key: `novelai.${key}`, workspaceValue: undefined }),
      update: async (key: string, value: unknown) => {
        updated.push({ key, value });
        values[key] = value;
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  return { updated };
}

describe("台帳が空のとき", () => {
  test("同梱の初期値が読める（クラウドは字/トークンと読める長さの両方）", () => {
    withSettings({ modelTuning: {} });

    const tuning = modelTuning("sakura", "gpt-oss-120b");
    expect(tuning?.charsPerToken).toBe(1.065);
    expect(tuning?.measuredChars).toBe(138_425);
    expect(tuning?.bundled).toBe(true);
    expect(tuning?.bundledAt).toBe("2026-09-13");
  });

  test("ローカルは字/トークンだけ（読める長さは VRAM 次第なので入らない）", () => {
    withSettings({ modelTuning: {} });

    const tuning = modelTuning("ollama", "qwen3:8b");
    expect(tuning?.charsPerToken).toBe(1.234);
    expect(tuning?.measuredChars).toBeUndefined();
  });

  /**
   * **回数を添えないと、入れた意味が無い。** 読む側（`resolveCharsPerToken`）は
   * 5件貯まるまで実測を使わないので、回数が無ければ当て推量（0.7）のまま
   * チャンクが決まる。
   */
  test("字/トークンには、信じてもらえるだけの回数が添う", () => {
    withSettings({ modelTuning: {} });

    expect(modelTuning("ollama", "gemma4:12b")?.charsPerTokenSamples).toBe(5);
  });

  test("測っていないモデルには、これまでどおり何も返さない", () => {
    withSettings({ modelTuning: {} });

    expect(modelTuning("ollama", "gemma4:e4b")).toBeUndefined();
  });
});

describe("作者の実測が、常に勝つ", () => {
  test("同じ欄が台帳にあれば、台帳の値を使う", () => {
    withSettings({
      modelTuning: {
        "sakura/gpt-oss-120b": { charsPerToken: 1.2, charsPerTokenSamples: 9 },
      },
    });

    const tuning = modelTuning("sakura", "gpt-oss-120b");
    expect(tuning?.charsPerToken).toBe(1.2);
    expect(tuning?.charsPerTokenSamples).toBe(9);
  });

  /**
   * **欄ごとに埋める。** 台帳の欄は別々に育つ——速さは普段の呼び出しから、
   * 読める長さは測定から入る。行ごと差し替えると「速さだけ測ってある」
   * モデルが同梱の字/トークンを受け取れない。
   */
  test("台帳に無い欄だけを埋める（速さは作者、字/トークンは同梱）", () => {
    withSettings({
      modelTuning: {
        "sakura/gpt-oss-120b": { outputTokensPerSecond: 42, speedSource: "call" },
      },
    });

    const tuning = modelTuning("sakura", "gpt-oss-120b");
    expect(tuning?.outputTokensPerSecond).toBe(42);
    expect(tuning?.charsPerToken).toBe(1.065);
    // どの欄が同梱から来たかまで分かる（一覧が欄ごとに断るのに要る）
    expect(tuning?.bundledFields).toContain("charsPerToken");
    expect(tuning?.bundledFields).not.toContain("outputTokensPerSecond");
  });

  test("読める長さを作者が測っていれば、同梱では上書きしない", () => {
    withSettings({
      modelTuning: { "sakura/gpt-oss-120b": { measuredChars: 200_000 } },
    });

    expect(modelTuning("sakura", "gpt-oss-120b")?.measuredChars).toBe(200_000);
  });
});

describe("一覧にも並ぶ", () => {
  test("台帳に行が無くても、同梱のモデルは一覧に出る", () => {
    withSettings({ modelTuning: {} });

    const table = allModelTuning();
    expect(table.get("sakura/preview/gemma-4-31B-it")?.measuredChars).toBe(
      339_804
    );
    expect(table.get("sakura/preview/gemma-4-31B-it")?.bundled).toBe(true);
  });

  test("作者が測った行は、そのまま並ぶ", () => {
    withSettings({
      modelTuning: { "ollama/gemma4:e4b": { outputTokensPerSecond: 11.4 } },
    });

    const table = allModelTuning();
    expect(table.get("ollama/gemma4:e4b")?.outputTokensPerSecond).toBe(11.4);
    expect(table.get("ollama/gemma4:e4b")?.bundled).toBeUndefined();
  });
});

/**
 * **台帳へ書き写さない**（作者の守り1）。
 *
 * 焼き付くと、次の版で同梱表を直しても古い値が生き残る。読んだ行を
 * そのまま保存へ回しても入らないことを、ここで固定する。
 */
describe("同梱の値は、台帳へ焼き付かない", () => {
  test("読んだ行をそのまま保存しても、同梱の印は設定へ入らない", async () => {
    const { updated } = withSettings({ modelTuning: {} });

    const read = modelTuning("sakura", "gpt-oss-120b");
    expect(read?.bundled).toBe(true);

    // 読んだ行を、そのまま保存へ回してみる
    await saveModelTuning("sakura", "gpt-oss-120b", {
      ...read,
      timeoutSeconds: 300,
    });

    const written = updated.at(-1)?.value as Record<string, Record<string, unknown>>;
    const entry = written["sakura/gpt-oss-120b"];
    expect(entry.timeoutSeconds).toBe(300);
    expect(entry.bundled).toBeUndefined();
    expect(entry.bundledAt).toBeUndefined();
    expect(entry.bundledFields).toBeUndefined();
  });
});
