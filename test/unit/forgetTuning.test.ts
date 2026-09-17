import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import { forgetTuning } from "../../src/features/forgetTuning";
import {
  tuningStoreContents,
  useBrokenTuningStore,
  useMemoryTuningStore,
} from "./support/tuningStore";

/**
 * 「AIチューニングの記録を消す」（作者の裁定、2026-09-18。設計書6.49）。
 *
 * 台帳を設定から**拡張機能の保管庫のファイル**へ移したので、設定画面から
 * 手で削る道が無くなった。**代わりの道をここで固定する。**
 *
 * いちばん気をつけるのは2つ。
 *
 * - **同梱の行を並べない。** 製品に焼き込んである値は押しても消えないので、
 *   出すと「押したのに消えない行」ができる
 * - **見に来ただけの作者の記録を消さない。** 何も選ばずに閉じたときは、
 *   1件も触らない
 */

const registry = {
  listProviders: () => [
    { id: "ollama", displayName: "Ollama" },
    { id: "sakura", displayName: "さくらのAI" },
  ],
} as unknown as AIRegistry;

/** 画面の作り物。選ぶもの・押すものをテスト側から決める */
function installDialogs(options: {
  /** `showQuickPick` に並んだ項目のうち、選ぶものを決める手 */
  pick?: (items: { label: string; detail?: string }[]) => unknown;
  /** 確認で押すボタン。既定は「消す」 */
  confirm?: string;
}): {
  offered: { label: string; description?: string; detail?: string }[];
  informed: string[];
} {
  const offered: { label: string; description?: string; detail?: string }[] = [];
  const informed: string[] = [];
  Object.assign(window, {
    showQuickPick: vi.fn(
      async (items: { label: string; detail?: string }[]) => {
        offered.push(...items);
        return options.pick ? options.pick(items) : undefined;
      }
    ),
    // 確認は `kind: "warning"` なので警告のほうへ出る
    showWarningMessage: vi.fn(async () => options.confirm ?? "消す"),
    showInformationMessage: vi.fn(async (message: string) => {
      informed.push(message);
      return undefined;
    }),
    showErrorMessage: vi.fn(async (message: string) => {
      informed.push(message);
      return undefined;
    }),
  });
  return { offered, informed };
}

beforeEach(async () => {
  await useMemoryTuningStore({});
});

describe("並べるもの", () => {
  test("作者が測った行だけを並べる（同梱の行は出さない）", async () => {
    await useMemoryTuningStore({
      "ollama/gemma4:e4b": { measuredChars: 100 },
    });
    const { offered } = installDialogs({});

    await forgetTuning(registry);

    expect(offered.map((item) => item.detail)).toEqual(["ollama/gemma4:e4b"]);
    // 同梱にしか無いモデル（`core/bundledTuning.ts`）は並ばない
    expect(offered.map((item) => item.detail)).not.toContain(
      "sakura/gpt-oss-120b"
    );
  });

  test("AIの表示名とモデル名で並べる", async () => {
    await useMemoryTuningStore({
      "sakura/preview/gemma-4-31B-it": { measuredAt: "2026-09-13T03:00:00Z" },
    });
    const { offered } = installDialogs({});

    await forgetTuning(registry);

    // **モデル名に `/` が入っていても切らない**（最初の1つだけで割る）
    expect(offered[0].label).toBe("さくらのAI / preview/gemma-4-31B-it");
    expect(offered[0].description).toContain("2026-09-13");
  });

  /**
   * **こちらが読めない行も並べる。** 解釈を通した表を元にすると、作者が
   * 手で書いた覚え書きだけの行が「消したいのに出てこない」状態になる。
   */
  test("読めない行も並べる", async () => {
    await useMemoryTuningStore({ "ollama/手書き": { memo: "あとで直す" } });
    const { offered } = installDialogs({});

    await forgetTuning(registry);

    expect(offered.map((item) => item.detail)).toEqual(["ollama/手書き"]);
  });

  test("1件も無ければ、選ばせずに知らせる", async () => {
    const { offered, informed } = installDialogs({});

    await forgetTuning(registry);

    expect(offered).toEqual([]);
    expect(informed.join("\n")).toContain("消せるAIチューニングの記録はありません");
  });
});

describe("消すとき", () => {
  test("選んだ行だけが消える", async () => {
    await useMemoryTuningStore({
      "ollama/a": { measuredChars: 1 },
      "ollama/b": { measuredChars: 2 },
    });
    const { informed } = installDialogs({
      pick: (items) => items.filter((item) => item.detail === "ollama/a"),
    });

    await forgetTuning(registry);

    expect(Object.keys(tuningStoreContents())).toEqual(["ollama/b"]);
    expect(informed.join("\n")).toContain("1件の記録を消しました");
  });

  test("何も選ばずに閉じたら、1件も触らない", async () => {
    await useMemoryTuningStore({ "ollama/a": { measuredChars: 1 } });
    installDialogs({ pick: () => undefined });

    await forgetTuning(registry);

    expect(tuningStoreContents()).toEqual({ "ollama/a": { measuredChars: 1 } });
  });

  test("空の選択を「全部」と読まない", async () => {
    await useMemoryTuningStore({ "ollama/a": { measuredChars: 1 } });
    installDialogs({ pick: () => [] });

    await forgetTuning(registry);

    expect(tuningStoreContents()).toEqual({ "ollama/a": { measuredChars: 1 } });
  });

  test("確認で断れば、消さない", async () => {
    await useMemoryTuningStore({ "ollama/a": { measuredChars: 1 } });
    installDialogs({
      pick: (items) => items,
      confirm: "キャンセル",
    });

    await forgetTuning(registry);

    expect(tuningStoreContents()).toEqual({ "ollama/a": { measuredChars: 1 } });
  });
});

/** 壊れたファイルは直さない（実装ルール2）。消す操作も断る */
describe("ファイルが壊れているとき", () => {
  test("選ばせずに、理由を言って終わる", async () => {
    await useBrokenTuningStore();
    const { offered, informed } = installDialogs({});

    await forgetTuning(registry);

    expect(offered).toEqual([]);
    expect(informed.join("\n")).toContain("読めない");
  });
});
