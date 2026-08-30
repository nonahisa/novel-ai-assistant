import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigurationTarget, workspace } from "vscode";
import {
  resolveTimeoutMs,
  resolveTimeoutSeconds,
  saveModelTuning,
  timeoutSettingKey,
  tunedContextWindow,
} from "../../src/core/modelTuning";

/**
 * 台帳（AIチューニング、設計書6.49）を、プロバイダが**先に**見ること。
 *
 * 見るべきは2つ。
 *
 * 1. 台帳に値があれば、プロバイダ単位の設定より台帳が勝つ
 * 2. 台帳に無ければ、これまでどおりの設定へ落ちる（**悪くならない**）
 */

const original = workspace.getConfiguration;

afterEach(() => {
  workspace.getConfiguration = original;
});

/**
 * `novelai.*` の設定を、渡した表のとおりに答えるようにする。
 *
 * `workspaceValue` を渡すと、その設定に**作品フォルダ側の値がある**状態を
 * 作る（`inspect` が答える）。書き込み先の判断を確かめるために要る。
 */
function withSettings(
  values: Record<string, unknown>,
  workspaceValues: Record<string, unknown> = {}
): { updated: Array<{ key: string; value: unknown; target: unknown }> } {
  const updated: Array<{ key: string; value: unknown; target: unknown }> = [];
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
      inspect: (key: string) => ({
        key: `novelai.${key}`,
        workspaceValue: workspaceValues[key],
      }),
      update: async (key: string, value: unknown, target: unknown) => {
        updated.push({ key, value, target });
        values[key] = value;
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  return { updated };
}

describe("待ち時間の取り方", () => {
  test("台帳にあれば、プロバイダ単位の設定より台帳を使う", () => {
    withSettings({
      "ollama.timeoutSeconds": 180,
      modelTuning: { "ollama/gemma4:26b": { timeoutSeconds: 480 } },
    });

    expect(resolveTimeoutSeconds("ollama", "gemma4:26b", 180)).toBe(480);
    expect(resolveTimeoutMs("ollama", "gemma4:26b", 180)).toBe(480_000);
  });

  test("同じプロバイダでも、測っていないモデルは従来の設定へ落ちる", () => {
    // **ここが要点。** 大きいモデルのために480秒と測っても、
    // 小さいモデルまで480秒待つ必要はない
    withSettings({
      "ollama.timeoutSeconds": 180,
      modelTuning: { "ollama/gemma4:26b": { timeoutSeconds: 480 } },
    });

    expect(resolveTimeoutSeconds("ollama", "gemma4:e4b", 180)).toBe(180);
  });

  test("台帳が壊れていても、従来の設定で動く", () => {
    // 手で編集できる設定なので、読めない形は「無かったこと」にして続ける
    withSettings({ "ollama.timeoutSeconds": 240, modelTuning: "壊れている" });

    expect(resolveTimeoutSeconds("ollama", "gemma4:e4b", 180)).toBe(240);
  });

  test("設定が0や負でも、即座に切れる待ち時間にはしない", () => {
    // 手で `0` を入れた settings.json で全呼び出しが失敗する状態を作らせない
    for (const broken of [0, -5, Number.NaN]) {
      withSettings({ "claude.timeoutSeconds": broken });
      expect(resolveTimeoutSeconds("claude", "any", 300), String(broken)).toBe(
        300
      );
    }
  });
});

describe("上限の取り方", () => {
  test("台帳にあればそれを使い、無ければ undefined（呼び出し側が従来へ落ちる）", () => {
    withSettings({
      modelTuning: { "sakura/gpt-oss-120b": { contextWindow: 131072 } },
    });

    expect(tunedContextWindow("sakura", "gpt-oss-120b")).toBe(131072);
    // 同じさくらでも、測っていないモデルには当てない。
    // 当てると、31Bのモデルへ131,072を渡して入力が黙って切り捨てられる
    expect(tunedContextWindow("sakura", "preview/gemma-4-31B-it")).toBeUndefined();
  });
});

describe("台帳への書き込み", () => {
  test("ほかのモデルの項目を消さない", async () => {
    const { updated } = withSettings({
      modelTuning: {
        "ollama/gemma4:e4b": { timeoutSeconds: 180 },
        // こちらは読めない形。**それでも消さない**——作者が手で書いた
        // ものかもしれず、こちらが読めないだけで捨ててよいものではない
        "ollama/手書き": "あとで直す",
      },
    });

    await saveModelTuning("sakura", "gpt-oss-120b", {
      contextWindow: 131072,
      timeoutSeconds: 390,
    });

    const written = (updated.at(-1) as { key: string; value: unknown }).value as
      Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(
      ["ollama/gemma4:e4b", "ollama/手書き", "sakura/gpt-oss-120b"].sort()
    );
    expect(written["sakura/gpt-oss-120b"]).toEqual({
      contextWindow: 131072,
      timeoutSeconds: 390,
    });
  });

  test("既定では機械全体の設定として書く（作品ごとにしない）", async () => {
    // 読み込み方も契約も、作品ではなく環境の側の事情で決まる
    const { updated } = withSettings({});

    await saveModelTuning("ollama", "gemma4:e4b", { timeoutSeconds: 300 });

    expect(updated.at(-1)).toMatchObject({
      key: "modelTuning",
      target: ConfigurationTarget.Global,
    });
  });

  test("作品フォルダ側に設定があれば、そちらへ書く", async () => {
    // **`get` は作品フォルダの値を優先するのに、`update` を必ず機械全体へ
    // 向けると、書いても読まれない。** 作者からは「反映を押したのに
    // 何も変わらない」としか見えず、原因にたどり着けない
    const { updated } = withSettings(
      { modelTuning: { "ollama/gemma4:e4b": { timeoutSeconds: 200 } } },
      { modelTuning: { "ollama/gemma4:e4b": { timeoutSeconds: 200 } } }
    );

    await saveModelTuning("ollama", "gemma4:e4b", { timeoutSeconds: 300 });

    expect(updated.at(-1)?.target).toBe(ConfigurationTarget.Workspace);
  });

  test("作者が手で書いた、読めない欄・知らない欄を落とさない", async () => {
    // **土台にするのは生の設定値である。** 読み取り（`parseModelTuning`）を
    // 通したものを書き戻すと、こちらが解釈できなかった欄が黙って消える。
    // 作者にとっては、自分で書いたメモが測定のたびに消えることになる
    const { updated } = withSettings({
      modelTuning: {
        "ollama/gemma4:e4b": {
          contextWindow: "131072",
          timeoutSeconds: 200,
          memo: "26Bはこれ",
        },
      },
    });

    await saveModelTuning("ollama", "gemma4:e4b", { timeoutSeconds: 400 });

    const written = updated.at(-1)?.value as Record<string, unknown>;
    expect(written["ollama/gemma4:e4b"]).toEqual({
      contextWindow: "131072",
      timeoutSeconds: 400,
      memo: "26Bはこれ",
    });
  });

  test("欄を消しても、ほかの欄は残る", async () => {
    const { updated } = withSettings({
      modelTuning: {
        "ollama/gemma4:e4b": { timeoutSeconds: 400, memo: "26Bはこれ" },
      },
    });

    await saveModelTuning("ollama", "gemma4:e4b", { timeoutSeconds: undefined });

    const written = updated.at(-1)?.value as Record<string, unknown>;
    expect(written["ollama/gemma4:e4b"]).toEqual({ memo: "26Bはこれ" });
  });
});

/**
 * 台帳は `object` 型の設定なので、`minimum` のような検査が効かない
 * （プロバイダごとの `timeoutSeconds` には効いている）。**読む側で挟む。**
 *
 * 手で `{"timeoutSeconds": 100000}` と書くと、1回の呼び出しが27時間待つ。
 * 上限は書き込み側（`recommendTimeoutSeconds`）でしか守られていなかった。
 */
describe("台帳の値を、読むときに挟む", () => {
  test("待ち時間は上限を超えさせない", () => {
    withSettings({
      "ollama.timeoutSeconds": 180,
      modelTuning: { "ollama/gemma4:e4b": { timeoutSeconds: 100_000 } },
    });

    expect(resolveTimeoutSeconds("ollama", "gemma4:e4b", 180)).toBe(600);
  });

  test("上限の内側なら、そのまま使う", () => {
    withSettings({
      modelTuning: { "ollama/gemma4:e4b": { timeoutSeconds: 480 } },
    });

    expect(resolveTimeoutSeconds("ollama", "gemma4:e4b", 180)).toBe(480);
  });

  test("上限が小さすぎる値は無視して、従来の設定へ落ちる", () => {
    // **`0` に近い上限は、送る前から失敗が決まっている。** 台帳の値を
    // そのまま信じると、手の滑りでその機能が丸ごと使えなくなる
    withSettings({
      "sakura.contextWindow": 32000,
      modelTuning: { "sakura/gpt-oss-120b": { contextWindow: 5 } },
    });

    expect(tunedContextWindow("sakura", "gpt-oss-120b")).toBeUndefined();
  });

  test("上限が下限ちょうどなら使う", () => {
    withSettings({
      modelTuning: { "sakura/gpt-oss-120b": { contextWindow: 1024 } },
    });

    expect(tunedContextWindow("sakura", "gpt-oss-120b")).toBe(1024);
  });
});

describe("6つのプロバイダが台帳を通る", () => {
  const root = path.join(__dirname, "..", "..");
  const providers = [
    "ollama",
    "lmstudio",
    "gemini",
    "claude",
    "openai",
    "sakura",
  ] as const;

  test("どのプロバイダも待ち時間を台帳経由で決める", () => {
    // **写しを作らせない。** 1つだけ `getConfiguration` を直接読むように
    // 戻ると、そのAIでだけチューニングが効かない状態が静かに生まれる
    for (const id of providers) {
      const file = path.join(root, "src", "ai", `${id}Provider.ts`);
      const code = fs.readFileSync(file, "utf8");
      expect(code, id).toContain("resolveTimeoutMs");
      expect(code, id).not.toMatch(/get<number>\("[a-z]+\.timeoutSeconds"/);
    }
  });

  test("設定名の作り方（プロバイダID + .timeoutSeconds）が実在する", () => {
    // `resolveTimeoutSeconds` は設定名を組み立てて引く。名前の付け方が
    // 崩れると、台帳が無いときの落とし先が静かに消える
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8")
    ) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const properties = manifest.contributes.configuration.properties;

    for (const id of providers) {
      expect(properties[`novelai.${timeoutSettingKey(id)}`], id).toBeDefined();
    }
  });
});
