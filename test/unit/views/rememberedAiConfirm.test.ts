import { describe, expect, test, vi } from "vitest";
import { confirmRun } from "../../../src/views/notify";
import { workspace } from "../support/vscodeStub";
import { answerConfirms } from "../support/confirmPicker";
import * as logger from "../../../src/core/logger";

/**
 * 「以降は訊かない」は、**覚えたときのAIでだけ**効かせる（セキュリティ点検「中」、2026-11-21）。
 *
 * ## 何が起きうるか
 *
 * Ollama（無料・手元）で［実行（以降は訊かない）］を覚えたあと、既定のAIを
 * Gemini・Claude など有料のクラウドへ替えると、次の実行が確認なしで全チャンクを
 * クラウドへ送っていた。覚え書きに「どのAIで覚えたか」が入っていなかったため。
 * ブラウザ版で割当の Ollama が使えず既定のAIへ落ちるときも同じ道を通る。
 */

/** 覚え書きを差し替える（`notify.test.ts` と同じ形）。書かれた中身も覗く */
function stubConfirmMemory(initial: Record<string, unknown>): {
  updates: Array<Record<string, unknown>>;
  restore: () => void;
} {
  const updates: Array<Record<string, unknown>> = [];
  let current = initial;
  const original = workspace.getConfiguration;
  workspace.getConfiguration = ((section?: string) => {
    if (section !== "novelai") return original();
    return {
      get: (_key: string) => current,
      update: async (_key: string, value: Record<string, unknown>) => {
        updates.push(value);
        current = value;
      },
    };
  }) as typeof workspace.getConfiguration;
  return {
    updates,
    restore: () => {
      workspace.getConfiguration = original;
    },
  };
}

const OLLAMA = { providerId: "ollama", model: "gemma4:e4b", paid: false };
const OLLAMA_OTHER = { providerId: "ollama", model: "gemma4:26b", paid: false };
const GEMINI = { providerId: "gemini", model: "gemini-2.5-flash", paid: true };

async function run(ai: unknown): Promise<boolean> {
  return confirmRun("19話をAIで確認します。", "実行", {
    remember: { id: "ai.run.checkTypos", ai } as never,
  });
}

describe("confirmRun：覚えたときのAIと違えば訊き直す", () => {
  test("Ollama で覚えたあと Gemini で走らせると、確認を出す（再現）", async () => {
    const memory = stubConfirmMemory({
      "ai.run.checkTypos": { answer: "実行", ai: [OLLAMA] },
    });
    const picker = answerConfirms("実行");
    const logStep = vi.spyOn(logger, "logStep").mockImplementation(() => {});
    try {
      expect(await run(GEMINI)).toBe(true);
      expect(picker.shown).toHaveLength(1);
      // 新しいAIでも覚え直せるように［以降は訊かない］を並べる
      expect(picker.shown[0].buttons).toEqual(["実行", "実行（以降は訊かない）"]);
      expect(logStep).toHaveBeenCalledWith(
        "AIが変わったので確認を出す: ai.run.checkTypos / 前 ollama/gemma4:e4b → 今 gemini/gemini-2.5-flash"
      );
    } finally {
      logStep.mockRestore();
      picker.restore();
      memory.restore();
    }
  });

  test("古い形（AIの入っていない覚え書き）で有料・クラウドのAIなら、確認を出す（再現）", async () => {
    const memory = stubConfirmMemory({ "ai.run.checkTypos": "実行" });
    const picker = answerConfirms("実行");
    try {
      expect(await run(GEMINI)).toBe(true);
      expect(picker.shown).toHaveLength(1);
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("古い形でも手元のAIなら、これまでどおり素通りさせる", async () => {
    const memory = stubConfirmMemory({ "ai.run.checkTypos": "実行" });
    const picker = answerConfirms("実行");
    try {
      expect(await run(OLLAMA)).toBe(true);
      expect(picker.shown).toEqual([]);
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("同じAI・同じモデルなら素通りさせる", async () => {
    const memory = stubConfirmMemory({
      "ai.run.checkTypos": { answer: "実行", ai: [GEMINI] },
    });
    const picker = answerConfirms("実行");
    try {
      expect(await run(GEMINI)).toBe(true);
      expect(picker.shown).toEqual([]);
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("同じ Ollama でもモデルが違えば訊き直す", async () => {
    const memory = stubConfirmMemory({
      "ai.run.checkTypos": { answer: "実行", ai: [OLLAMA] },
    });
    const picker = answerConfirms("実行");
    try {
      expect(await run(OLLAMA_OTHER)).toBe(true);
      expect(picker.shown).toHaveLength(1);
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("AIの機能なのにAIが渡されなければ、覚えていても訊く（渡し忘れを安全側へ倒す）", async () => {
    const memory = stubConfirmMemory({ "ai.run.checkTypos": "実行" });
    const picker = answerConfirms("実行");
    try {
      expect(await run(undefined)).toBe(true);
      expect(picker.shown).toHaveLength(1);
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("覚えるときはAIも一緒に入れ、別のAIで覚え直すと両方を覚える", async () => {
    const memory = stubConfirmMemory({
      "ai.run.checkTypos": { answer: "実行", ai: [OLLAMA] },
    });
    const picker = answerConfirms("実行（以降は訊かない）");
    try {
      expect(await run(GEMINI)).toBe(true);
      expect(memory.updates.at(-1)).toEqual({
        "ai.run.checkTypos": { answer: "実行", ai: [OLLAMA, GEMINI] },
      });
      // 覚え直したあとは、どちらのAIでも素通りする
      expect(await run(GEMINI)).toBe(true);
      expect(await run(OLLAMA)).toBe(true);
      expect(picker.shown).toHaveLength(1);
    } finally {
      picker.restore();
      memory.restore();
    }
  });

  test("AIを使わない確認は、今までどおり文字列で覚えて素通りさせる", async () => {
    const memory = stubConfirmMemory({});
    const picker = answerConfirms("実行（以降は訊かない）");
    try {
      expect(
        await confirmRun("競合したファイルを外して続けます。", "実行", {
          remember: { id: "conflict.skip.checkTypos" },
        })
      ).toBe(true);
      expect(memory.updates.at(-1)).toEqual({ "conflict.skip.checkTypos": "実行" });
      expect(
        await confirmRun("競合したファイルを外して続けます。", "実行", {
          remember: { id: "conflict.skip.checkTypos" },
        })
      ).toBe(true);
      expect(picker.shown).toHaveLength(1);
    } finally {
      picker.restore();
      memory.restore();
    }
  });
});
