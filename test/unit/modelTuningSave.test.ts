import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * **台帳への書き込みで、ほかの測定結果を消さない。**
 *
 * ## 1回目（作者の実機、2026-09-13）
 *
 * `ollama/qwen3.8:latest` の測定結果（`measuredChars: 76815`）が、
 * **保存を確認したあとで台帳から消えた。** ほかの7件は残っていた。
 * 書き込みは「全体を読む → その1件を差し替える → 全体を書き戻す」で、
 * 読んだときと同じ中身がまだそこにあるかを確かめていなかった。
 * そこで**同じプロセスの中を順番に通す待ち行列**を入れた。
 *
 * ## 2回目（作者の報告、2026-09-18）
 *
 * 「さくらのAIのqwenをチューニングしたのですが、しばらくすると
 * 一覧から消えます」。待ち行列は**同じプロセスの中しか守らない**ので、
 * 製品版と拡張機能開発ホストを同時に開いていると、片方が読んでから
 * 書くまでの間にもう片方が書いたぶんが消える。
 *
 * 台帳を設定から**拡張機能の保管庫のファイル**へ移し
 * （`core/modelTuningStore.ts`）、**書いたあとに読み直して、消えていたら
 * やり直す**ようにした。ここはその両方を見る。
 */

const logs: string[] = [];

vi.mock("../../src/core/logger", () => ({
  logLine: (message: string) => logs.push(message),
  logFailure: () => undefined,
  logStep: () => undefined,
}));

const { saveModelTuning } = await import("../../src/core/modelTuning");
const { forgetModelTuning } = await import("../../src/core/modelTuningStore");
const {
  fsTiming,
  tuningStoreContents,
  useBrokenTuningStore,
  useMemoryTuningStore,
  writeTuningStoreDirectly,
} = await import("./support/tuningStore");

beforeEach(async () => {
  logs.length = 0;
  await useMemoryTuningStore({});
});

describe("ほかの測定結果を消さない", () => {
  /**
   * **これが実機で起きたことである。**
   *
   * 守りを入れる前のコードでは、あとから書いたほうが先の結果を
   * まるごと消していた（このテストは、直す前に落ちることを確かめてある）。
   */
  test("**並行して2つ書いても、どちらも残る**", async () => {
    fsTiming.delayMs = 20;

    await Promise.all([
      saveModelTuning("ollama", "qwen3.8:latest", { measuredChars: 76815 }),
      saveModelTuning("ollama", "qwen3:8b", { measuredChars: 29900 }),
    ]);

    const table = tuningStoreContents();
    expect(table["ollama/qwen3.8:latest"]).toEqual({ measuredChars: 76815 });
    expect(table["ollama/qwen3:8b"]).toEqual({ measuredChars: 29900 });
  });

  test("同じモデルへ続けて書いても、先の欄が残る", async () => {
    fsTiming.delayMs = 20;

    await Promise.all([
      saveModelTuning("ollama", "qwen3:8b", { measuredChars: 29900 }),
      saveModelTuning("ollama", "qwen3:8b", { outputTokensPerSecond: 24.5 }),
    ]);

    expect(tuningStoreContents()["ollama/qwen3:8b"]).toEqual({
      measuredChars: 29900,
      outputTokensPerSecond: 24.5,
    });
  });

  test("3つ以上でも落とさない", async () => {
    fsTiming.delayMs = 10;

    await Promise.all([
      saveModelTuning("ollama", "a", { measuredChars: 1 }),
      saveModelTuning("ollama", "b", { measuredChars: 2 }),
      saveModelTuning("sakura", "c", { measuredChars: 3 }),
      saveModelTuning("lmstudio", "d", { measuredChars: 4 }),
    ]);

    expect(Object.keys(tuningStoreContents()).sort()).toEqual([
      "lmstudio/d",
      "ollama/a",
      "ollama/b",
      "sakura/c",
    ]);
  });

  /**
   * **待っているあいだに外から変わることがある**（作者が手で直す・別の窓）。
   * 並ぶ前に読んだ表で書き戻すと、その変更を巻き戻す。
   */
  test("前の書き込みのあとに増えた鍵を、巻き戻さない", async () => {
    await saveModelTuning("ollama", "a", { measuredChars: 1 });

    // ここで外から別の鍵が入る（別の窓が書いた・作者が手で書いた）
    writeTuningStoreDirectly({
      ...tuningStoreContents(),
      "手で足した/モデル": { memo: "残ること" },
    });

    await saveModelTuning("ollama", "b", { measuredChars: 2 });

    const table = tuningStoreContents();
    expect(table["手で足した/モデル"]).toEqual({ memo: "残ること" });
    expect(table["ollama/a"]).toEqual({ measuredChars: 1 });
    expect(table["ollama/b"]).toEqual({ measuredChars: 2 });
  });

  /**
   * **1回目の書き込みが別の窓に消されても、自分で入れ直す**（0.66.6）。
   *
   * 書いたあとに読み直しているので、**自分の欄が消えていることに気づいて
   * やり直す。** やり直しでは相手の書いたものを土台にするから、両方残る。
   *
   * ここでは「1回目の置き換えが無かったことになる」形で、別の窓に
   * 上書きされた状態を作る。
   */
  test("1回目が別の窓に消されても、やり直して両方残す", async () => {
    await useMemoryTuningStore({ "別の窓/モデル": { memo: "先客" } });

    const { workspace } = await import("vscode");
    const fs = workspace.fs as { rename: (...args: never[]) => Promise<void> };
    const original = fs.rename;
    let swallowed = false;
    fs.rename = async (...args: never[]): Promise<void> => {
      // 1回目だけ、置き換えが起きなかったことにする（＝別の窓の中身が残る）
      if (!swallowed) {
        swallowed = true;
        return;
      }
      await original(...args);
    };

    await saveModelTuning("ollama", "a", { measuredChars: 1 });
    fs.rename = original;

    const table = tuningStoreContents();
    expect(table["ollama/a"]).toEqual({ measuredChars: 1 });
    expect(table["別の窓/モデル"]).toEqual({ memo: "先客" });
    // やり直しで収まったので、記録は残らない
    expect(logs).toEqual([]);
  });

  /**
   * **防げないところは、防げると書かない。**
   *
   * こちらが書いている最中に、**確かめない書き手**（作者が手で直す、
   * 外の道具）が丸ごと書き換えると、その内容は消える。別の窓が製品の道を
   * 通っているなら、向こうも書いたあとに読み直すので自分で入れ直せる。
   */
  test("書き込みの最中に、確かめない書き手が入ると守れない", async () => {
    fsTiming.delayMs = 30;

    const slow = saveModelTuning("ollama", "a", { measuredChars: 1 });
    await new Promise((done) => setTimeout(done, 5));
    writeTuningStoreDirectly({ "割り込み/モデル": { memo: "消える" } });
    await slow;

    const table = tuningStoreContents();
    // こちらが入れたかった値は入っている
    expect(table["ollama/a"]).toEqual({ measuredChars: 1 });
    // 割り込みは消える。**そこを承知したうえでの作りである**
    expect(table["割り込み/モデル"]).toBeUndefined();
  });
});

/**
 * これまでの約束。**置き場を変えても変えない。**
 */
describe("これまでの約束は変わらない", () => {
  test("読めない欄・知らない欄は、そのまま残る", async () => {
    // 作者が手で書いた覚書を、測って戻すだけで消さない
    await useMemoryTuningStore({
      "ollama/gemma4:26b": { contextWindow: "131072", memo: "26Bはこれ" },
    });

    await saveModelTuning("ollama", "gemma4:26b", { measuredChars: 160834 });

    expect(tuningStoreContents()["ollama/gemma4:26b"]).toEqual({
      contextWindow: "131072",
      memo: "26Bはこれ",
      measuredChars: 160834,
    });
  });

  test("`undefined` を渡すと、その欄だけ消える", async () => {
    await useMemoryTuningStore({
      "ollama/a": { timeoutSeconds: 600, measuredChars: 100 },
    });

    await saveModelTuning("ollama", "a", { timeoutSeconds: undefined });

    expect(tuningStoreContents()["ollama/a"]).toEqual({ measuredChars: 100 });
  });

  test("残る欄が1つも無くなったら、鍵ごと落ちる", async () => {
    // 中身の無い鍵が並ぶと「測ったのに何も入っていない」と読める
    await useMemoryTuningStore({ "ollama/a": { timeoutSeconds: 600 } });

    await saveModelTuning("ollama", "a", { timeoutSeconds: undefined });

    expect("ollama/a" in tuningStoreContents()).toBe(false);
  });

  test("ほかのモデルの項目は触らない", async () => {
    await useMemoryTuningStore({ "ollama/other": { measuredChars: 999 } });

    await saveModelTuning("ollama", "a", { measuredChars: 1 });

    expect(tuningStoreContents()["ollama/other"]).toEqual({
      measuredChars: 999,
    });
  });
});

/**
 * **壊れたJSONは直さない**（CLAUDE.md 実装ルール2）。
 *
 * 空の表として扱って書き戻すと、作者が何時間もかけて測った値が
 * その場で消える。
 */
describe("壊れたファイルの上からは書かない", () => {
  test("書こうとしても中身は変わらず、記録が残る", async () => {
    await useBrokenTuningStore();
    logs.length = 0;

    await saveModelTuning("ollama", "a", { measuredChars: 123 });

    // 壊れたままで、上書きされていない
    expect(() => tuningStoreContents()).toThrow();
    // **断ったことは毎回書く**（黙って効かないのがいちばん困る）
    expect(logs.join("\n")).toContain("書きませんでした");
  });

  test("消す操作も断る", async () => {
    await useBrokenTuningStore();

    expect(await forgetModelTuning(["ollama/a"])).toBe(0);
  });
});

/**
 * **黙って諦めない**（CLAUDE.md「エラーは握りつぶさない」）。
 *
 * ただし**例外は投げない**——測定の結果を作者へ見せる流れを、台帳の
 * 都合で止めない。見せるものは既に手元にあり、台帳はその控えである。
 */
describe("書けなかったら、記録に残す", () => {
  test("何度やり直しても入らなければ、記録が残る", async () => {
    // 書き込みを黙って捨てる装置にする（外から同時に書かれ続ける状況）
    const { workspace } = await import("vscode");
    const fs = workspace.fs as { rename: unknown };
    const original = fs.rename;
    fs.rename = async (): Promise<void> => undefined;

    await saveModelTuning("ollama", "a", { measuredChars: 123 });

    fs.rename = original;
    expect(logs.join("\n")).toContain("measuredChars");
  });

  test("書けても、記録は残さない", async () => {
    await saveModelTuning("ollama", "a", { measuredChars: 123 });
    expect(logs).toEqual([]);
  });
});

/**
 * 記録を消す口（詳細メニュー「AIチューニングの記録を消す」。0.66.6）。
 *
 * 台帳を設定から出したので、**設定画面から手で削る道が無くなった。**
 * 代わりの道をここで固定する。
 */
describe("記録を消す", () => {
  test("選んだ鍵だけが消える", async () => {
    await useMemoryTuningStore({
      "ollama/a": { measuredChars: 1 },
      "ollama/b": { measuredChars: 2 },
      "sakura/c": { measuredChars: 3 },
    });

    expect(await forgetModelTuning(["ollama/a", "sakura/c"])).toBe(2);

    expect(Object.keys(tuningStoreContents())).toEqual(["ollama/b"]);
  });

  test("無い鍵を渡しても、何も壊さない", async () => {
    await useMemoryTuningStore({ "ollama/a": { measuredChars: 1 } });

    expect(await forgetModelTuning(["ollama/無い"])).toBe(0);
    expect(Object.keys(tuningStoreContents())).toEqual(["ollama/a"]);
  });
});
