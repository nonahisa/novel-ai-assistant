import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "vscode";
import { allModelTuning, saveModelTuning } from "../../src/core/modelTuning";
import {
  tuningStoreContents,
  tuningStoreDirectoryExists,
  tuningStoreFileExists,
  useMemoryTuningStore,
} from "./support/tuningStore";

/**
 * 設定 `novelai.modelTuning` から、保管庫のファイルへの**引っ越し**（0.66.6）。
 *
 * **ここでいちばん大事なのは「1件も失わない」ことである。** 作者の手元には
 * 10件の実測があり、読める長さは遅いモデルで1時間以上かけて測ったものも
 * ある。取りこぼすと、測り直しはもう一度その時間を払うことになる。
 *
 * 引っ越しの規則は3つ。
 *
 * 1. **ファイルがまだ無いときだけ、1回。** あるなら設定は見ない
 *    （見ると、作者が消した記録が設定から蘇る）
 * 2. **設定は消さない**（実装ルール2。作者のデータを勝手に消さない）
 * 3. **生のまま写す。** 解釈を通すと、作者が手で書いた覚え書きの欄が落ちる
 */

/** 記録に残ったこと。件数を言っているかを見る */
const logs: string[] = [];

vi.mock("../../src/core/logger", () => ({
  logLine: (message: string) => logs.push(message),
  logFailure: () => undefined,
  logStep: () => undefined,
}));

/**
 * 作者の手元にあった10件（2026-09-18の実機）。
 *
 * **鍵の顔ぶれをそのまま写してある。** `sakura/preview/gemma-4-31B-it` の
 * ように**モデル名に `/` を含む**もの、`vscode-lm/auto` のように
 * プロバイダが後から増えたもの、`lmstudio/google/gemma-4-e4b` のように
 * 両方に当てはまるものが混ざっている——鍵の割り方を取り違えると、
 * この顔ぶれのどれかが静かに落ちる。
 */
const AUTHORS_LEDGER: Record<string, Record<string, unknown>> = {
  "ollama/gemma4:12b": {
    measuredChars: 194288,
    contextHitCeiling: false,
    charsPerToken: 1.383,
    measuredAt: "2026-09-13T12:00:00.000Z",
  },
  "ollama/gemma4:26b": { measuredChars: 160834, timeoutSeconds: 600 },
  "gemini/gemini-flash-lite-latest": {
    measuredChars: 186434,
    contextLimitedByRate: true,
  },
  "sakura/preview/gemma-4-31B-it": { measuredChars: 339804, charsPerToken: 1.383 },
  "lmstudio/google/gemma-4-e4b": { outputTokensPerSecond: 11.4 },
  "ollama/qwen3:8b": { measuredChars: 29900, charsPerToken: 1.234 },
  "sakura/gpt-oss-120b": { measuredChars: 138425, charsPerToken: 1.065 },
  "vscode-lm/auto": { outputTokensPerSecond: 42.1, speedSource: "call" },
  "ollama/gemma4:e4b": { timeoutSeconds: 180, measuredChars: 76815 },
  "ollama/gemma4:e2b": {
    measuredChars: 20000,
    // 作者が手で書いた覚え書き。**こちらが読めない欄も落とさない**
    memo: "非力なマシン用",
  },
};

const original = workspace.getConfiguration;

/** 設定 `novelai.modelTuning` に、この中身が入っている状態を作る */
function withTuningSetting(value: unknown): { updated: string[] } {
  const updated: string[] = [];
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key === "modelTuning" ? value : defaultValue) as T,
      inspect: () => ({ workspaceValue: undefined }),
      update: async (key: string) => {
        updated.push(key);
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  return { updated };
}

beforeEach(() => {
  logs.length = 0;
});

afterEach(() => {
  workspace.getConfiguration = original;
});

describe("作者の10件が、1件も欠けずに移る", () => {
  test("**10件すべてが、そのまま読める**", async () => {
    withTuningSetting(AUTHORS_LEDGER);

    // ファイルがまだ無い状態（`initial` を渡さない）で起動する
    await useMemoryTuningStore();

    const moved = tuningStoreContents();
    expect(Object.keys(moved).sort()).toEqual(
      Object.keys(AUTHORS_LEDGER).sort()
    );
    // 中身も1欄も変えずに写す（作者が手で書いた `memo` も含めて）
    expect(moved).toEqual(AUTHORS_LEDGER);
  });

  test("引っ越したあと、台帳として引ける（同梱の行も並ぶ）", async () => {
    withTuningSetting(AUTHORS_LEDGER);
    await useMemoryTuningStore();

    const table = allModelTuning();
    for (const key of Object.keys(AUTHORS_LEDGER)) {
      expect(table.has(key), key).toBe(true);
    }
    // 作者の実測が、同梱の初期値に上書きされていない
    expect(table.get("ollama/gemma4:12b")?.measuredChars).toBe(194288);
    expect(table.get("sakura/gpt-oss-120b")?.measuredChars).toBe(138425);
  });

  /**
   * **保管庫は、まだ無いことがある**（その機械で初めて動かしたとき）。
   *
   * `atomicWriteFile` は一時ファイルを同じ場所へ置くので、置き場を
   * 先に作らないと**引っ越しの1件目から書けない**。しかも失敗するのは
   * 引っ越しの最中なので、作者の実測が新しい置き場へ渡らないまま終わる。
   */
  test("保管庫がまだ無くても、作ってから書く", async () => {
    withTuningSetting(AUTHORS_LEDGER);
    await useMemoryTuningStore();

    expect(tuningStoreDirectoryExists()).toBe(true);
    expect(Object.keys(tuningStoreContents())).toHaveLength(10);
  });

  test("何件写したかを、記録に残す", async () => {
    withTuningSetting(AUTHORS_LEDGER);
    await useMemoryTuningStore();

    expect(logs.join("\n")).toContain("10件");
  });

  /** **作者のデータを勝手に消さない**（実装ルール2） */
  test("設定のほうは消さない（触らない）", async () => {
    const { updated } = withTuningSetting(AUTHORS_LEDGER);
    await useMemoryTuningStore();

    expect(updated).toEqual([]);
  });
});

describe("引っ越すのは1回だけ", () => {
  test("ファイルが既にあれば、設定は読まない", async () => {
    withTuningSetting(AUTHORS_LEDGER);

    // 既に引っ越し済み（空のファイルがある）
    await useMemoryTuningStore({});

    expect(tuningStoreContents()).toEqual({});
  });

  /**
   * **消した記録が、設定から蘇らない。**
   *
   * 「ファイルの中身が空かどうか」で判断すると、作者が記録を全部消した
   * 次の起動で、設定に残っている古い値がそっくり戻ってくる。
   */
  test("全部消したあとに起動し直しても、蘇らない", async () => {
    withTuningSetting(AUTHORS_LEDGER);
    await useMemoryTuningStore();
    expect(Object.keys(tuningStoreContents())).toHaveLength(10);

    // 作者が全部消した（ファイルは空の表として残る）
    await useMemoryTuningStore({});

    expect(tuningStoreContents()).toEqual({});
  });

  test("設定が空なら、ファイルも作らない", async () => {
    withTuningSetting({});
    await useMemoryTuningStore();

    expect(tuningStoreFileExists()).toBe(false);
    expect(logs).toEqual([]);
  });

  test("設定が壊れていても止まらない（空として扱う）", async () => {
    withTuningSetting("壊れている");
    await useMemoryTuningStore();

    expect(tuningStoreFileExists()).toBe(false);
  });
});

/**
 * **写したあとは設定を読まない**（0.66.6）。
 *
 * ここが残っていると、設定同期で降ってきた**別の機械の**読める長さが
 * この機械の台帳に混ざる。読める長さは VRAM 次第なので、機械をまたいで
 * 共有してはいけない値である。
 */
describe("引っ越したあと、設定は見ない", () => {
  test("設定が後から変わっても、台帳は動かない", async () => {
    withTuningSetting(AUTHORS_LEDGER);
    await useMemoryTuningStore({ "ollama/gemma4:12b": { measuredChars: 1 } });

    expect(allModelTuning().get("ollama/gemma4:12b")?.measuredChars).toBe(1);
  });

  test("書き込み先も設定ではない", async () => {
    const { updated } = withTuningSetting({});
    await useMemoryTuningStore({});

    await saveModelTuning("ollama", "gemma4:12b", { measuredChars: 2 });

    expect(tuningStoreContents()["ollama/gemma4:12b"]).toEqual({
      measuredChars: 2,
    });
    expect(updated).toEqual([]);
  });
});
