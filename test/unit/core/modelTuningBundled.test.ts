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

    expect(modelTuning("ollama", "llama3.2:3b")).toBeUndefined();
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
   * **再現**（さくら llm-jp、2026-09-26 の実接続）：1回目の呼び出しが通ると、
   * 字/トークンの実測が**1回ぶん**台帳へ入る。すると同梱の値が隠れ、読む側
   * （`resolveCharsPerToken`）は5回に満たない実測を信じないので、**当て推量の
   * 0.7 へ戻っていた。** 4,096しか読めないモデルでは、2つ目のチャンクから
   * 関所が「指示だけで上限に届く」と断り、残りが全部失敗した。
   *
   * 5回に満たない実測は、製品がまだ使わない値である。その間は同梱の値が
   * 「当て推量の代わり」を続ける——**作者の実測が勝つのは、使える実測に
   * なってから**（守り2の趣旨は変えない）。台帳の生の値は消さないので、
   * 数え続けて5回に達すれば、そちらに替わる。
   */
  test("まだ信じられない回数の実測は、同梱の値を隠さない", async () => {
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { charsPerToken: 1.3, charsPerTokenSamples: 1 },
    });

    const tuning = modelTuning("sakura", "gpt-oss-120b");
    expect(tuning?.charsPerToken).toBe(1.065);
    expect(tuning?.charsPerTokenSamples).toBe(5);
    expect(tuning?.bundledFields).toContain("charsPerToken");
    // 台帳のほうは書き換えない（数え続けるため）
    expect(tuningStoreContents()["sakura/gpt-oss-120b"]).toEqual({
      charsPerToken: 1.3,
      charsPerTokenSamples: 1,
    });
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
      "ollama/llama3.2:3b": { outputTokensPerSecond: 11.4 },
    });

    const table = allModelTuning();
    expect(table.get("ollama/llama3.2:3b")?.outputTokensPerSecond).toBe(11.4);
    expect(table.get("ollama/llama3.2:3b")?.bundled).toBeUndefined();
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
