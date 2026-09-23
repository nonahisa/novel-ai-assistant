import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { workspace } from "vscode";
import {
  allModelTuning,
  resolveTimeoutMs,
  resolveTimeoutSeconds,
  saveModelTuning,
  timeoutSettingKey,
  tunedContextWindow,
} from "../../src/core/modelTuning";
import {
  tuningStoreContents,
  useBrokenTuningStore,
  useMemoryTuningStore,
} from "./support/tuningStore";

/**
 * 台帳（AIチューニング、設計書6.49）を、プロバイダが**先に**見ること。
 *
 * 見るべきは2つ。
 *
 * 1. 台帳に値があれば、プロバイダ単位の設定より台帳が勝つ
 * 2. 台帳に無ければ、これまでどおりの設定へ落ちる（**悪くならない**）
 *
 * 台帳そのものは 0.66.6 で設定から**拡張機能の保管庫のファイル**へ移った
 * （`core/modelTuningStore.ts`）。プロバイダ単位の設定（`ollama.timeoutSeconds`
 * など）は設定のままなので、ここは両方を用意して確かめる。
 */

const original = workspace.getConfiguration;

afterEach(() => {
  workspace.getConfiguration = original;
});

/**
 * `novelai.*` の設定を、渡した表のとおりに答えるようにする。
 *
 * **台帳はもうここに無い。** 台帳を仕込むのは `useMemoryTuningStore`。
 */
function withSettings(values: Record<string, unknown>): {
  updated: Array<{ key: string; value: unknown; target: unknown }>;
} {
  const updated: Array<{ key: string; value: unknown; target: unknown }> = [];
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
      inspect: (key: string) => ({
        key: `novelai.${key}`,
        workspaceValue: undefined,
      }),
      update: async (key: string, value: unknown, target: unknown) => {
        updated.push({ key, value, target });
        values[key] = value;
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  return { updated };
}

describe("待ち時間の取り方", () => {
  test("台帳にあれば、プロバイダ単位の設定より台帳を使う", async () => {
    withSettings({ "ollama.timeoutSeconds": 180 });
    await useMemoryTuningStore({
      "ollama/gemma4:26b": { timeoutSeconds: 480 },
    });

    expect(resolveTimeoutSeconds("ollama", "gemma4:26b", 180)).toBe(480);
    expect(resolveTimeoutMs("ollama", "gemma4:26b", 180)).toBe(480_000);
  });

  test("同じプロバイダでも、測っていないモデルは従来の設定へ落ちる", async () => {
    // **ここが要点。** 大きいモデルのために480秒と測っても、
    // 小さいモデルまで480秒待つ必要はない
    withSettings({ "ollama.timeoutSeconds": 180 });
    await useMemoryTuningStore({
      "ollama/gemma4:26b": { timeoutSeconds: 480 },
    });

    expect(resolveTimeoutSeconds("ollama", "gemma4:e4b", 180)).toBe(180);
  });

  test("台帳のファイルが壊れていても、従来の設定で動く", async () => {
    // 作者が開いて直せるファイルなので、読めない形は「無かったこと」に
    // して続ける（**書き込みのほうは断る**。上書きで実測を消さないため）
    withSettings({ "ollama.timeoutSeconds": 240 });
    await useBrokenTuningStore();

    expect(resolveTimeoutSeconds("ollama", "gemma4:e4b", 180)).toBe(240);
  });

  test("設定が0や負でも、即座に切れる待ち時間にはしない", async () => {
    await useMemoryTuningStore({});
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
  test("台帳にあればそれを使い、無ければ undefined（呼び出し側が従来へ落ちる）", async () => {
    withSettings({});
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { contextWindow: 131072 },
    });

    expect(tunedContextWindow("sakura", "gpt-oss-120b")).toBe(131072);
    // 同じさくらでも、測っていないモデルには当てない。
    // 当てると、31Bのモデルへ131,072を渡して入力が黙って切り捨てられる
    expect(
      tunedContextWindow("sakura", "preview/gemma-4-31B-it")
    ).toBeUndefined();
  });
});

describe("台帳への書き込み", () => {
  test("ほかのモデルの項目を消さない", async () => {
    withSettings({});
    await useMemoryTuningStore({
      "ollama/gemma4:e4b": { timeoutSeconds: 180 },
      // こちらは読めない形。**それでも消さない**——作者が手で書いた
      // ものかもしれず、こちらが読めないだけで捨ててよいものではない
      "ollama/手書き": "あとで直す",
    });

    await saveModelTuning("sakura", "gpt-oss-120b", {
      contextWindow: 131072,
      timeoutSeconds: 390,
    });

    const written = tuningStoreContents();
    expect(Object.keys(written).sort()).toEqual(
      ["ollama/gemma4:e4b", "ollama/手書き", "sakura/gpt-oss-120b"].sort()
    );
    expect(written["sakura/gpt-oss-120b"]).toEqual({
      contextWindow: 131072,
      timeoutSeconds: 390,
    });
  });

  /**
   * **設定へは、もう1文字も書かない**（0.66.6）。
   *
   * 設定は同期で機械をまたいで運ばれるうえ、2つの窓が同じ塊を読んで
   * 書き戻すので、片方の測定が痕跡なく消えた（作者の報告、2026-09-18）。
   */
  test("保管庫のファイルへ書き、設定 `novelai.modelTuning` は触らない", async () => {
    const { updated } = withSettings({});
    await useMemoryTuningStore({});

    await saveModelTuning("ollama", "gemma4:e4b", { timeoutSeconds: 300 });

    expect(tuningStoreContents()["ollama/gemma4:e4b"]).toEqual({
      timeoutSeconds: 300,
    });
    expect(updated.filter((entry) => entry.key === "modelTuning")).toEqual([]);
  });

  test("作者が手で書いた、読めない欄・知らない欄を落とさない", async () => {
    // **土台にするのは生の中身である。** 読み取り（`parseModelTuning`）を
    // 通したものを書き戻すと、こちらが解釈できなかった欄が黙って消える。
    // 作者にとっては、自分で書いたメモが測定のたびに消えることになる
    withSettings({});
    await useMemoryTuningStore({
      "ollama/gemma4:e4b": {
        contextWindow: "131072",
        timeoutSeconds: 200,
        memo: "26Bはこれ",
      },
    });

    await saveModelTuning("ollama", "gemma4:e4b", { timeoutSeconds: 400 });

    expect(tuningStoreContents()["ollama/gemma4:e4b"]).toEqual({
      contextWindow: "131072",
      timeoutSeconds: 400,
      memo: "26Bはこれ",
    });
  });

  test("欄を消しても、ほかの欄は残る", async () => {
    withSettings({});
    await useMemoryTuningStore({
      "ollama/gemma4:e4b": { timeoutSeconds: 400, memo: "26Bはこれ" },
    });

    await saveModelTuning("ollama", "gemma4:e4b", {
      timeoutSeconds: undefined,
    });

    expect(tuningStoreContents()["ollama/gemma4:e4b"]).toEqual({
      memo: "26Bはこれ",
    });
  });
});

/**
 * 台帳は作者が手で開けるJSONなので、`minimum` のような検査が効かない
 * （プロバイダごとの `timeoutSeconds` には効いている）。**読む側で挟む。**
 *
 * 手で `{"timeoutSeconds": 100000}` と書くと、1回の呼び出しが27時間待つ。
 * 上限は書き込み側（`recommendTimeoutSeconds`）でしか守られていなかった。
 */
describe("台帳の値を、読むときに挟む", () => {
  /*
    **上限は手元とクラウドで違う**（作者の裁定、2026-09-23）。
    手元のAI（Ollama・LM Studio）は1800秒、クラウドは600秒。
  */
  test("待ち時間は上限を超えさせない（手元のAIは1800秒）", async () => {
    withSettings({ "ollama.timeoutSeconds": 180 });
    await useMemoryTuningStore({
      "ollama/gemma4:e4b": { timeoutSeconds: 100_000 },
      "lmstudio/gemma-4-12b": { timeoutSeconds: 100_000 },
    });

    expect(resolveTimeoutSeconds("ollama", "gemma4:e4b", 180)).toBe(1800);
    expect(resolveTimeoutSeconds("lmstudio", "gemma-4-12b", 180)).toBe(1800);
  });

  test("待ち時間は上限を超えさせない（クラウドは600秒のまま）", async () => {
    withSettings({});
    await useMemoryTuningStore({
      "gemini/gemini-2.5-flash": { timeoutSeconds: 100_000 },
      "claude/claude-sonnet": { timeoutSeconds: 1800 },
      "openai/gpt-5": { timeoutSeconds: 1800 },
      "sakura/gpt-oss-120b": { timeoutSeconds: 1800 },
    });

    expect(resolveTimeoutSeconds("gemini", "gemini-2.5-flash", 180)).toBe(600);
    expect(resolveTimeoutSeconds("claude", "claude-sonnet", 300)).toBe(600);
    expect(resolveTimeoutSeconds("openai", "gpt-5", 180)).toBe(600);
    expect(resolveTimeoutSeconds("sakura", "gpt-oss-120b", 180)).toBe(600);
  });

  /**
   * ノートPCの実機（2026-09-23）。台帳に1800秒と書いてあるのに、
   * 読む側が600秒へ抑えていたので、約620秒かかる相談が切れていた。
   */
  test("手元のAIの台帳に1800秒と書けば、1800秒待つ", async () => {
    withSettings({});
    await useMemoryTuningStore({
      "ollama/gemma4:e2b": { timeoutSeconds: 1800 },
    });

    expect(resolveTimeoutSeconds("ollama", "gemma4:e2b", 300)).toBe(1800);
  });

  test("上限の内側なら、そのまま使う", async () => {
    withSettings({});
    await useMemoryTuningStore({
      "ollama/gemma4:e4b": { timeoutSeconds: 480 },
    });

    expect(resolveTimeoutSeconds("ollama", "gemma4:e4b", 180)).toBe(480);
  });

  test("上限が小さすぎる値は無視して、従来の設定へ落ちる", async () => {
    // **`0` に近い上限は、送る前から失敗が決まっている。** 台帳の値を
    // そのまま信じると、手の滑りでその機能が丸ごと使えなくなる
    withSettings({ "sakura.contextWindow": 32000 });
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { contextWindow: 5 },
    });

    expect(tunedContextWindow("sakura", "gpt-oss-120b")).toBeUndefined();
  });

  test("上限が下限ちょうどなら使う", async () => {
    withSettings({});
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { contextWindow: 1024 },
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

/**
 * 一覧（`core/tuningStats.ts`）は台帳の**全部**を読む。
 *
 * 引く側（`modelTuning`）は鍵1つぶんしか返さないので、モデルの数だけ
 * 台帳を読み直すことになる。読み取りの口をここへ1つ足して、
 * **解釈の仕方（`parseModelTuning`）を一覧側へ写さない。**
 */
describe("台帳を丸ごと読む", () => {
  test("ファイルにある項目を、解釈したうえで全部返す", async () => {
    withSettings({});
    await useMemoryTuningStore({
      "ollama/gemma4:e4b": { outputTokensPerSecond: 12.3 },
      "sakura/gpt-oss-120b": { contextWindow: 131072 },
      "ollama/壊れ": { contextWindow: 0 },
    });

    const table = allModelTuning();

    /*
      **同梱の初期値も並ぶ**（0.64.0、`core/bundledTuning.ts`）。台帳に
      行が無いモデルでも、選ぶ画面と実測の一覧に出さないと
      「効いているのに見えない値」になる。だから件数では突き合わせない
      ——ここで見たいのは**台帳の行が読めていること**である。
    */
    expect(table.has("ollama/gemma4:e4b")).toBe(true);
    expect(table.has("sakura/gpt-oss-120b")).toBe(true);
    expect(table.get("ollama/gemma4:e4b")?.outputTokensPerSecond).toBe(12.3);
    expect(table.get("sakura/gpt-oss-120b")?.contextWindow).toBe(131072);
    // 壊れた行は落ちる（同梱にも無いので、一覧に出てこない）
    expect(table.has("ollama/壊れ")).toBe(false);
    // 台帳に無いモデルは、同梱に在るものだけが足される
    expect(table.has("ollama/gemma4:12b")).toBe(true);
    expect(table.get("ollama/gemma4:12b")?.bundled).toBe(true);
  });

  test("台帳が無ければ、同梱の初期値だけが並ぶ", async () => {
    withSettings({});
    await useMemoryTuningStore({});

    const table = allModelTuning();
    // 台帳から読めた行は1つも無い
    expect([...table.values()].every((tuning) => tuning.bundled)).toBe(true);
    // 同梱の行は出る（0.64.0。ここが空だと、初期値が効いていても見えない）
    expect(table.get("sakura/gpt-oss-120b")?.charsPerToken).toBe(1.065);
  });
});
