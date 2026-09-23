import { describe, expect, test } from "vitest";
import {
  allModelTuning,
  modelTuning,
  saveModelTuning,
} from "../../../src/core/modelTuning";
import {
  tuningStoreContents,
  useMemoryTuningStore,
} from "../support/tuningStore";

/**
 * 同梱の初期値を、台帳へどう混ぜるか（作者の裁定、2026-09-13）。
 *
 * 一覧そのものの中身は `bundledTuning.test.ts` が見る。ここで見るのは
 * **混ぜ方**——作者の実測が勝つこと、欄ごとに埋めること、そして
 * **台帳へ焼き付かないこと**。
 *
 * 台帳の置き場は 0.66.6 で設定から拡張機能の保管庫のファイルへ移った
 * （`core/modelTuningStore.ts`）。**混ぜ方そのものは何も変えていない。**
 */

describe("台帳が空のとき", () => {
  test("同梱の初期値が読める（クラウドは字/トークンと読める長さの両方）", async () => {
    await useMemoryTuningStore({});

    const tuning = modelTuning("sakura", "gpt-oss-120b");
    expect(tuning?.charsPerToken).toBe(1.065);
    expect(tuning?.measuredChars).toBe(138_425);
    expect(tuning?.bundled).toBe(true);
    expect(tuning?.bundledAt).toBe("2026-09-13");
  });

  test("ローカルは字/トークンだけ（読める長さは VRAM 次第なので入らない）", async () => {
    await useMemoryTuningStore({});

    const tuning = modelTuning("ollama", "qwen3:8b");
    expect(tuning?.charsPerToken).toBe(1.234);
    expect(tuning?.measuredChars).toBeUndefined();
  });

  /**
   * **回数を添えないと、入れた意味が無い。** 読む側（`resolveCharsPerToken`）は
   * 5件貯まるまで実測を使わないので、回数が無ければ当て推量（0.7）のまま
   * チャンクが決まる。
   */
  test("字/トークンには、信じてもらえるだけの回数が添う", async () => {
    await useMemoryTuningStore({});

    expect(modelTuning("ollama", "gemma4:12b")?.charsPerTokenSamples).toBe(5);
  });

  test("測っていないモデルには、これまでどおり何も返さない", async () => {
    await useMemoryTuningStore({});

    expect(modelTuning("ollama", "gemma4:e4b")).toBeUndefined();
  });
});

describe("作者の実測が、常に勝つ", () => {
  test("同じ欄が台帳にあれば、台帳の値を使う", async () => {
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { charsPerToken: 1.2, charsPerTokenSamples: 9 },
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
  test("台帳に無い欄だけを埋める（速さは作者、字/トークンは同梱）", async () => {
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { outputTokensPerSecond: 42, speedSource: "call" },
    });

    const tuning = modelTuning("sakura", "gpt-oss-120b");
    expect(tuning?.outputTokensPerSecond).toBe(42);
    expect(tuning?.charsPerToken).toBe(1.065);
    // どの欄が同梱から来たかまで分かる（一覧が欄ごとに断るのに要る）
    expect(tuning?.bundledFields).toContain("charsPerToken");
    expect(tuning?.bundledFields).not.toContain("outputTokensPerSecond");
  });

  test("読める長さを作者が測っていれば、同梱では上書きしない", async () => {
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { measuredChars: 200_000 },
    });

    expect(modelTuning("sakura", "gpt-oss-120b")?.measuredChars).toBe(200_000);
  });
});

describe("一覧にも並ぶ", () => {
  test("台帳に行が無くても、同梱のモデルは一覧に出る", async () => {
    await useMemoryTuningStore({});

    const table = allModelTuning();
    expect(table.get("sakura/preview/gemma-4-31B-it")?.measuredChars).toBe(
      339_804
    );
    expect(table.get("sakura/preview/gemma-4-31B-it")?.bundled).toBe(true);
  });

  test("作者が測った行は、そのまま並ぶ", async () => {
    await useMemoryTuningStore({
      "ollama/gemma4:e4b": { outputTokensPerSecond: 11.4 },
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
  test("読んだ行をそのまま保存しても、同梱の印はファイルへ入らない", async () => {
    await useMemoryTuningStore({});

    const read = modelTuning("sakura", "gpt-oss-120b");
    expect(read?.bundled).toBe(true);

    // 読んだ行を、そのまま保存へ回してみる
    await saveModelTuning("sakura", "gpt-oss-120b", {
      ...read,
      timeoutSeconds: 300,
    });

    const entry = tuningStoreContents()["sakura/gpt-oss-120b"] as Record<
      string,
      unknown
    >;
    expect(entry.timeoutSeconds).toBe(300);
    expect(entry.bundled).toBeUndefined();
    expect(entry.bundledAt).toBeUndefined();
    expect(entry.bundledFields).toBeUndefined();
  });
});
