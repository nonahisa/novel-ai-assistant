import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * **台帳への書き込みで、ほかの測定結果を消さない**
 * （作者の実機、2026-09-13）。
 *
 * `ollama/qwen3.8:latest` の測定結果（`measuredChars: 76815`）が、
 * **保存を確認したあとで台帳から消えた。** ほかの7件は残っていた。
 *
 * 書き込みは「全体を読む → その1件を差し替える → 全体を書き戻す」で、
 * 読んだときと同じ中身がまだそこにあるかを確かめていなかった。書き手は
 * 複数ある——測定の終わり・普段の呼び出しごとの速度・字/トークン。
 * 読む瞬間と書く瞬間のあいだに別の書き込みが挟まれば、**挟まれたほうが
 * まるごと消える。**
 *
 * ほかの台帳（人物・設定資料・章立て・本の設計図）は、みな読み込み時の
 * 照合を持っている（CLAUDE.mdの実装ルール2）。ここだけが素通しだった。
 */

/** VS Code の設定を作り物にする。**書き込みは遅らせられる** */
const store = {
  value: {} as Record<string, unknown>,
  /** `update` が実際に書き終わるまでの待ち。競合を作るのに使う */
  delayMs: 0,
  logs: [] as string[],
};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === "modelTuning" ? store.value : undefined),
      inspect: () => ({ workspaceValue: undefined }),
      update: async (key: string, next: unknown) => {
        // **書き込みには時間がかかる。** ここを遅らせると、
        // 「読んでから書くまでの隙間」が再現できる
        if (store.delayMs > 0) {
          await new Promise((done) => setTimeout(done, store.delayMs));
        }
        if (key === "modelTuning") store.value = next as Record<string, unknown>;
      },
    }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
}));

vi.mock("../../src/core/logger", () => ({
  logLine: (message: string) => store.logs.push(message),
  logFailure: () => undefined,
  logStep: () => undefined,
}));

const { saveModelTuning } = await import("../../src/core/modelTuning");

beforeEach(() => {
  store.value = {};
  store.delayMs = 0;
  store.logs = [];
});

describe("ほかの測定結果を消さない", () => {
  /**
   * **これが実機で起きたことである。**
   *
   * 守りを入れる前のコードでは、あとから書いたほうが先の結果を
   * まるごと消していた（このテストは、直す前に落ちることを確かめてある）。
   */
  test("**並行して2つ書いても、どちらも残る**", async () => {
    store.delayMs = 20;

    await Promise.all([
      saveModelTuning("ollama", "qwen3.8:latest", { measuredChars: 76815 }),
      saveModelTuning("ollama", "qwen3:8b", { measuredChars: 29900 }),
    ]);

    expect(store.value["ollama/qwen3.8:latest"]).toEqual({
      measuredChars: 76815,
    });
    expect(store.value["ollama/qwen3:8b"]).toEqual({ measuredChars: 29900 });
  });

  test("同じモデルへ続けて書いても、先の欄が残る", async () => {
    store.delayMs = 20;

    await Promise.all([
      saveModelTuning("ollama", "qwen3:8b", { measuredChars: 29900 }),
      saveModelTuning("ollama", "qwen3:8b", { outputTokensPerSecond: 24.5 }),
    ]);

    expect(store.value["ollama/qwen3:8b"]).toEqual({
      measuredChars: 29900,
      outputTokensPerSecond: 24.5,
    });
  });

  test("3つ以上でも落とさない", async () => {
    store.delayMs = 10;

    await Promise.all([
      saveModelTuning("ollama", "a", { measuredChars: 1 }),
      saveModelTuning("ollama", "b", { measuredChars: 2 }),
      saveModelTuning("sakura", "c", { measuredChars: 3 }),
      saveModelTuning("lmstudio", "d", { measuredChars: 4 }),
    ]);

    expect(Object.keys(store.value).sort()).toEqual([
      "lmstudio/d",
      "ollama/a",
      "ollama/b",
      "sakura/c",
    ]);
  });

  /**
   * **待っているあいだに外から変わることがある**（作者が手で直す・
   * 別の窓・同期）。並ぶ前に読んだ表で書き戻すと、その変更を巻き戻す。
   */
  /**
   * **書く直前に読み直しているか。**
   *
   * 列に並んでいるあいだに、外から設定が変わることがある（作者が手で
   * 直す・別の窓・同期）。並ぶ前に読んだ表で書き戻すと、その変更を
   * 巻き戻す。
   */
  test("前の書き込みのあとに増えた鍵を、巻き戻さない", async () => {
    await saveModelTuning("ollama", "a", { measuredChars: 1 });

    // ここで外から別の鍵が入る（作者が手で書いた・同期で降ってきた）
    store.value = { ...store.value, "手で足した/モデル": { memo: "残ること" } };

    await saveModelTuning("ollama", "b", { measuredChars: 2 });

    expect(store.value["手で足した/モデル"]).toEqual({ memo: "残ること" });
    expect(store.value["ollama/a"]).toEqual({ measuredChars: 1 });
    expect(store.value["ollama/b"]).toEqual({ measuredChars: 2 });
  });

  /**
   * **書いている最中に外から書かれたら、防げない。**
   *
   * 設定ファイルへの書き込みは丸ごと置き換えなので、その最中に入った
   * 変更は消える。こちらの列では止められない——**だから、消えたことを
   * 記録に残す**（下の「書けなかったら、記録に残す」）。
   *
   * 防げないことを「防げる」と書かないために、ここへ残しておく。
   */
  test("書き込みの最中に外から書かれた分は、守れない（記録には残る）", async () => {
    store.delayMs = 30;

    const slow = saveModelTuning("ollama", "a", { measuredChars: 1 });
    await new Promise((done) => setTimeout(done, 5));
    store.value = { ...store.value, "割り込み/モデル": { memo: "消える" } };
    await slow;

    // 消えるのは避けられない。**そこを承知したうえでの作りである**
    expect(store.value["割り込み/モデル"]).toBeUndefined();
    // ただし、こちらが入れたかった値は入っている
    expect(store.value["ollama/a"]).toEqual({ measuredChars: 1 });
  });
});

/**
 * これまでの約束。**守りを足しても変えない。**
 */
describe("これまでの約束は変わらない", () => {
  test("読めない欄・知らない欄は、そのまま残る", async () => {
    // 作者が手で書いた覚書を、測って戻すだけで消さない
    store.value = {
      "ollama/gemma4:26b": { contextWindow: "131072", memo: "26Bはこれ" },
    };

    await saveModelTuning("ollama", "gemma4:26b", { measuredChars: 160834 });

    expect(store.value["ollama/gemma4:26b"]).toEqual({
      contextWindow: "131072",
      memo: "26Bはこれ",
      measuredChars: 160834,
    });
  });

  test("`undefined` を渡すと、その欄だけ消える", async () => {
    store.value = {
      "ollama/a": { timeoutSeconds: 600, measuredChars: 100 },
    };

    await saveModelTuning("ollama", "a", { timeoutSeconds: undefined });

    expect(store.value["ollama/a"]).toEqual({ measuredChars: 100 });
  });

  test("残る欄が1つも無くなったら、鍵ごと落ちる", async () => {
    // 中身の無い鍵が並ぶと「測ったのに何も入っていない」と読める
    store.value = { "ollama/a": { timeoutSeconds: 600 } };

    await saveModelTuning("ollama", "a", { timeoutSeconds: undefined });

    expect("ollama/a" in store.value).toBe(false);
  });

  test("ほかのモデルの項目は触らない", async () => {
    store.value = { "ollama/other": { measuredChars: 999 } };

    await saveModelTuning("ollama", "a", { measuredChars: 1 });

    expect(store.value["ollama/other"]).toEqual({ measuredChars: 999 });
  });
});

/**
 * **黙って諦めない**（CLAUDE.md「エラーは握りつぶさない」）。
 *
 * ただし**例外は投げない**——測定の結果を作者へ見せる流れを、台帳の
 * 都合で止めない。見せるものは既に手元にあり、台帳はその控えである。
 */
describe("書けなかったら、記録に残す", () => {
  test("書いたのに入っていなければ、記録が残る", async () => {
    // 書き込みを黙って捨てる設定にする（外から同時に書かれた状況）
    store.value = {};
    const { workspace } = await import("vscode");
    const original = workspace.getConfiguration;
    (workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: () => ({}),
      inspect: () => ({ workspaceValue: undefined }),
      update: async () => undefined,
    });

    await saveModelTuning("ollama", "a", { measuredChars: 123 });

    (workspace as { getConfiguration: unknown }).getConfiguration = original;
    expect(store.logs.join("\n")).toContain("measuredChars");
  });

  test("書けても、記録は残さない", async () => {
    await saveModelTuning("ollama", "a", { measuredChars: 123 });
    expect(store.logs).toEqual([]);
  });
});
