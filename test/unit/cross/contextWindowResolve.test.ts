import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { workspace } from "vscode";
import { modelTuning, resolveContextWindow } from "../../../src/core/modelTuning";
import {
  bundledTuningByKey,
  bundledTuningKeys,
} from "../../../src/core/bundledTuning";
import { useMemoryTuningStore } from "../support/tuningStore";
import { LMSTUDIO_CONTEXT_WINDOW } from "../../../src/ai/lmstudioProvider";
import { OPENAI_CONTEXT_WINDOW } from "../../../src/ai/openaiProvider";
import { SAKURA_CONTEXT_WINDOW } from "../../../src/ai/sakuraProvider";

/**
 * コンテキスト長の「台帳 → プロバイダ別設定 → 既定」の読み順（設計書6.77）。
 *
 * **API が長さを申告しないプロバイダだけが台帳を見る**（ChatGPT・
 * LM Studio・さくら）。3社が同じ読み順を別々に書いていたので、1つへ寄せた。
 *
 * ここで見るのは**寄せる前と同じ値を返す**ことだけである。期待値は
 * 寄せる前の各プロバイダの実装から手で写した（既定・下限は各社で違う）。
 */

const original = workspace.getConfiguration;

afterEach(() => {
  workspace.getConfiguration = original;
});

// 台帳は 0.66.6 で保管庫のファイルへ移った。**毎回、空から始める**
beforeEach(async () => {
  await useMemoryTuningStore({});
});

function withSettings(values: Record<string, unknown>): void {
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
}

const PROVIDERS = [
  {
    id: "lmstudio",
    source: LMSTUDIO_CONTEXT_WINDOW,
    /** 作者が設定に書いた、まともな値 */
    configured: 16384,
    fallback: 8192,
  },
  {
    id: "openai",
    source: OPENAI_CONTEXT_WINDOW,
    configured: 200000,
    fallback: 128000,
  },
  {
    id: "sakura",
    source: SAKURA_CONTEXT_WINDOW,
    configured: 64000,
    fallback: 32000,
  },
] as const;

describe("台帳 → 設定 → 既定 の順（3社とも同じ）", () => {
  test.each(PROVIDERS)("$id：台帳にあれば台帳", async ({ id, source, configured }) => {
    withSettings({ [source.settingKey]: configured });
    await useMemoryTuningStore({
      [`${id}/測ったモデル`]: { contextWindow: 131072 },
    });

    expect(resolveContextWindow(id, "測ったモデル", source)).toBe(131072);
    // **測っていないモデルには当てない。** 同じプロバイダでも長さは違う
    expect(resolveContextWindow(id, "別のモデル", source)).toBe(configured);
  });

  test.each(PROVIDERS)(
    "$id：台帳が無ければ設定",
    ({ id, source, configured }) => {
      withSettings({ [source.settingKey]: configured });
      expect(resolveContextWindow(id, "どれか", source)).toBe(configured);
    }
  );

  test.each(PROVIDERS)("$id：どちらも無ければ既定", ({ id, source, fallback }) => {
    withSettings({});
    expect(resolveContextWindow(id, "どれか", source)).toBe(fallback);
    expect(source.fallback).toBe(fallback);
  });

  test.each(PROVIDERS)(
    "$id：設定が壊れていれば既定（0・負・NaN）",
    ({ id, source, fallback }) => {
      for (const broken of [0, -1, Number.NaN]) {
        withSettings({ [source.settingKey]: broken });
        expect(
          resolveContextWindow(id, "どれか", source),
          `${id}/${broken}`
        ).toBe(fallback);
      }
    }
  );

  test("小さすぎる設定の扱いは、各社の従来どおり", () => {
    // ChatGPT・さくらは1,024未満を捨てて既定へ落ちる（設定にも `minimum` がある）。
    // LM Studio は「読み込んだ長さ」に合わせる予備なので、小さい値も尊重する
    withSettings({ [OPENAI_CONTEXT_WINDOW.settingKey]: 512 });
    expect(resolveContextWindow("openai", "m", OPENAI_CONTEXT_WINDOW)).toBe(
      128000
    );

    withSettings({ [SAKURA_CONTEXT_WINDOW.settingKey]: 512 });
    expect(resolveContextWindow("sakura", "m", SAKURA_CONTEXT_WINDOW)).toBe(
      32000
    );

    withSettings({ [LMSTUDIO_CONTEXT_WINDOW.settingKey]: 512 });
    expect(resolveContextWindow("lmstudio", "m", LMSTUDIO_CONTEXT_WINDOW)).toBe(
      512
    );
  });

  test("台帳の小さすぎる値は使わない（従来どおり設定へ落ちる）", async () => {
    // 台帳は作者が手で開けるJSONなので、設定のような `minimum` が効かない
    withSettings({ [SAKURA_CONTEXT_WINDOW.settingKey]: 32000 });
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { contextWindow: 5 },
    });
    expect(
      resolveContextWindow("sakura", "gpt-oss-120b", SAKURA_CONTEXT_WINDOW)
    ).toBe(32000);
  });
});

describe("台帳を見るのは、申告しないプロバイダだけ", () => {
  const root = path.join(__dirname, "..", "..", "..");

  test("3社は共通の読み順を通り、自前で設定を引かない", () => {
    // **写しを作らせない。** 1社だけ元へ戻ると、そのAIでだけ
    // チューニングが効かない状態が静かに生まれる
    for (const id of ["lmstudio", "openai", "sakura"] as const) {
      const code = fs.readFileSync(
        path.join(root, "src", "ai", `${id}Provider.ts`),
        "utf8"
      );
      expect(code, id).toContain("resolveContextWindow");
      expect(code, id).not.toMatch(/get<number>\("[a-z]+\.contextWindow"/);
    }
  });

  test("申告のある3社は、台帳のコンテキスト長を見ない", () => {
    // **申告が正。** 古い台帳が正しい申告を上書きする事故を作らない
    for (const id of ["ollama", "gemini", "claude"] as const) {
      const code = fs.readFileSync(
        path.join(root, "src", "ai", `${id}Provider.ts`),
        "utf8"
      );
      expect(code, id).not.toContain("tunedContextWindow");
      expect(code, id).not.toContain("resolveContextWindow");
    }
  });
});

/**
 * 同梱の実測（`core/bundledTuning.ts`）を、既定より先に使う（作者の裁定、
 * 2026-09-19「測った値を同梱する」）。
 *
 * **さくらのAIは、モデル一覧APIがコンテキスト長を返さない。** だから
 * 既定の 32,000 は「申告」ではなく製品が置いた当て推量で、チューニングを
 * するまで全モデルがその値で動いていた（31Bは実測 273,001トークン）。
 */
describe("申告しないプロバイダは、同梱の実測を既定より先に使う", () => {
  const root = path.join(__dirname, "..", "..", "..");

  /**
   * **本物に近い設定のスタブ。** `package.json` に既定のある設定は、
   * 作者が何も書いていなくても `get` がその既定を返す。だから
   * 「作者が書いたか」は `inspect` でしか分からない。
   */
  function withWrittenSettings(values: Record<string, unknown>): void {
    workspace.getConfiguration = () =>
      ({
        get: <T>(key: string, defaultValue?: T): T =>
          (key in values ? values[key] : defaultValue) as T,
        inspect: <T>(key: string) => ({
          key,
          globalValue: (key in values ? values[key] : undefined) as
            | T
            | undefined,
        }),
      }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  }

  const 三十一B = "preview/gemma-4-31B-it";

  test("未チューニングのさくらの31Bは、32,000ではなく測った値", () => {
    withWrittenSettings({});
    expect(resolveContextWindow("sakura", 三十一B, SAKURA_CONTEXT_WINDOW)).toBe(
      273001
    );
  });

  test("gpt-oss-120b も同じ", () => {
    withWrittenSettings({});
    expect(
      resolveContextWindow("sakura", "gpt-oss-120b", SAKURA_CONTEXT_WINDOW)
    ).toBe(138597);
  });

  test("作者の台帳があれば、そちらが勝つ", async () => {
    withWrittenSettings({});
    await useMemoryTuningStore({
      [`sakura/${三十一B}`]: { contextWindow: 100000 },
    });
    expect(resolveContextWindow("sakura", 三十一B, SAKURA_CONTEXT_WINDOW)).toBe(
      100000
    );
  });

  test("作者が設定に書いていれば、そちらが勝つ", () => {
    withWrittenSettings({ [SAKURA_CONTEXT_WINDOW.settingKey]: 64000 });
    expect(resolveContextWindow("sakura", 三十一B, SAKURA_CONTEXT_WINDOW)).toBe(
      64000
    );
  });

  test("測っていないモデルは、これまでどおり既定", () => {
    // 同じさくらでも、表に無いモデルは読める長さを測っていない。
    // **「同じ系統だから同じはず」で当てない**（同梱表の約束）
    withWrittenSettings({});
    expect(
      resolveContextWindow(
        "sakura",
        "preview/まだ測っていないモデル",
        SAKURA_CONTEXT_WINDOW
      )
    ).toBe(32000);
  });

  test("サーバーが述べた長さを同梱したモデルは、既定より先にそれを使う（2026-09-26）", () => {
    // Qwen3.6 は以前ここで「測っていないモデル」の例だった。AIチューニングの
    // 申告の段で、サーバー自身が 262,144 と述べた
    withWrittenSettings({});
    expect(
      resolveContextWindow(
        "sakura",
        "preview/Qwen3.6-35B-A3B",
        SAKURA_CONTEXT_WINDOW
      )
    ).toBe(262_144);
    // 作者が設定に書けば、これまでどおりそちらが勝つ
    withWrittenSettings({ [SAKURA_CONTEXT_WINDOW.settingKey]: 64000 });
    expect(
      resolveContextWindow(
        "sakura",
        "preview/Qwen3.6-35B-A3B",
        SAKURA_CONTEXT_WINDOW
      )
    ).toBe(64000);
  });

  test("同梱の文脈長を持つのは、申告しないプロバイダの行だけ", () => {
    // **Gemini・Claude・Ollama はAPIが申告する。** そこへ同梱を混ぜると、
    // 古い実測が正しい申告を静かに上書きする（上の describe と同じ理由）
    for (const key of bundledTuningKeys()) {
      if (bundledTuningByKey(key)?.contextWindow === undefined) continue;
      const providerId = key.split("/")[0];
      const code = fs.readFileSync(
        path.join(root, "src", "ai", `${providerId}Provider.ts`),
        "utf8"
      );
      expect(code, key).toContain("resolveContextWindow");
    }
  });

  test("同梱の文脈長は、台帳の行としては混ざらない", () => {
    // 混ぜると `tunedContextWindow` が拾い、**設定より先に**効いてしまう。
    // 作者が設定に書いた値が、同梱に負けることがあってはならない
    const merged = modelTuning("sakura", 三十一B);
    expect(merged?.contextWindow).toBeUndefined();
    expect(merged?.bundledFields ?? []).not.toContain("contextWindow");
  });
});
