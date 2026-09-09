import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { workspace } from "vscode";
import { resolveContextWindow } from "../../src/core/modelTuning";
import { LMSTUDIO_CONTEXT_WINDOW } from "../../src/ai/lmstudioProvider";
import { OPENAI_CONTEXT_WINDOW } from "../../src/ai/openaiProvider";
import { SAKURA_CONTEXT_WINDOW } from "../../src/ai/sakuraProvider";

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
  test.each(PROVIDERS)("$id：台帳にあれば台帳", ({ id, source, configured }) => {
    withSettings({
      [source.settingKey]: configured,
      modelTuning: { [`${id}/測ったモデル`]: { contextWindow: 131072 } },
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

  test("台帳の小さすぎる値は使わない（従来どおり設定へ落ちる）", () => {
    // `modelTuning` は `object` の設定なので、VS Code側の `minimum` が効かない
    withSettings({
      [SAKURA_CONTEXT_WINDOW.settingKey]: 32000,
      modelTuning: { "sakura/gpt-oss-120b": { contextWindow: 5 } },
    });
    expect(
      resolveContextWindow("sakura", "gpt-oss-120b", SAKURA_CONTEXT_WINDOW)
    ).toBe(32000);
  });
});

describe("台帳を見るのは、申告しないプロバイダだけ", () => {
  const root = path.join(__dirname, "..", "..");

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
