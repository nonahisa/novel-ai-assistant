import { describe, expect, test } from "vitest";
import {
  confirmAiOf,
  decideRememberedRun,
  describeRemembered,
  normalizeConfirmMemory,
  rememberedAnswer,
  withRemembered,
  withoutRemembered,
  type ConfirmAi,
  type ConfirmMemory,
} from "../../../src/core/confirmMemory";
import { isLocalProviderId } from "../../../src/core/localProviders";

/**
 * 「以降は訊かない」の覚え書きに、どのAIで覚えたかを入れる（セキュリティ点検「中」、2026-11-21）。
 * 判断の中身（`decideRememberedRun`）と、設定に置く形の読み書きを確かめる。
 */

const OLLAMA: ConfirmAi = { providerId: "ollama", model: "gemma4:e4b", paid: false };
const LMSTUDIO: ConfirmAi = { providerId: "lmstudio", model: "gemma-4-12b", paid: false };
const GEMINI: ConfirmAi = { providerId: "gemini", model: "gemini-2.5-flash", paid: true };
const CLAUDE: ConfirmAi = { providerId: "claude", model: "claude-sonnet", paid: true };
/** 無料枠のあるクラウド。お金はかからなくても、本文は外へ出る */
const CLOUD_FREE: ConfirmAi = { providerId: "sakura", model: "gemma-4", paid: false };

function decide(memory: ConfirmMemory, ai: readonly ConfirmAi[], id = "ai.run.checkTypos") {
  return decideRememberedRun({ memory, id, runLabel: "実行", ai, isLocal: isLocalProviderId }).kind;
}

describe("decideRememberedRun", () => {
  test("覚えていなければ、ただ訊く", () => {
    expect(decide({}, [GEMINI])).toBe("ask");
    expect(decide({ "ai.run.checkTypos": "別の言葉" }, [OLLAMA])).toBe("ask");
  });

  test("覚えたAIのどれかと同じなら素通り、違えば訊き直す", () => {
    const memory = { "ai.run.checkTypos": { answer: "実行", ai: [OLLAMA, GEMINI] } };
    expect(decide(memory, [OLLAMA])).toBe("skip");
    expect(decide(memory, [GEMINI])).toBe("skip");
    expect(decide(memory, [CLAUDE])).toBe("aiChanged");
    expect(decide(memory, [{ ...OLLAMA, model: "gemma4:26b" }])).toBe("aiChanged");
    // 複数のAIへ送る確認は、全部が覚えたAIのときだけ
    expect(decide(memory, [OLLAMA, CLAUDE])).toBe("aiChanged");
  });

  test("古い形（文字列）は、手元の無料のAIだけなら素通り、有料・クラウドなら訊き直す", () => {
    const memory = { "ai.run.checkTypos": "実行" };
    expect(decide(memory, [OLLAMA])).toBe("skip");
    expect(decide(memory, [LMSTUDIO])).toBe("skip");
    expect(decide(memory, [GEMINI])).toBe("aiChanged");
    expect(decide(memory, [CLOUD_FREE])).toBe("aiChanged");
    expect(decide(memory, [OLLAMA, GEMINI])).toBe("aiChanged");
  });

  test("AIを送る確認でAIが渡されなければ訊く。AIを使わない確認はこれまでどおり", () => {
    expect(decide({ "ai.run.checkTypos": "実行" }, [])).toBe("aiChanged");
    expect(decide({ "ai.paid.workChat": "実行" }, [], "ai.paid.workChat")).toBe("aiChanged");
    expect(decide({ "conflict.skip.checkTypos": "実行" }, [], "conflict.skip.checkTypos")).toBe(
      "skip"
    );
  });
});

describe("覚え書きの形", () => {
  test("AIを渡して覚えると { answer, ai }、渡さなければ文字列のまま", () => {
    expect(withRemembered({}, "ai.run.checkTypos", "実行", [OLLAMA])).toEqual({
      "ai.run.checkTypos": { answer: "実行", ai: [OLLAMA] },
    });
    expect(withRemembered({}, "conflict.skip.checkTypos", "実行")).toEqual({
      "conflict.skip.checkTypos": "実行",
    });
  });

  test("同じ答えで別のAIを覚えると足す。同じAIは重ねない。答えが変われば引き継がない", () => {
    const once = withRemembered({}, "ai.run.checkTypos", "実行", [OLLAMA]);
    const twice = withRemembered(once, "ai.run.checkTypos", "実行", [GEMINI, OLLAMA]);
    expect(twice["ai.run.checkTypos"]).toEqual({ answer: "実行", ai: [OLLAMA, GEMINI] });
    const relabeled = withRemembered(twice, "ai.run.checkTypos", "走らせる", [CLAUDE]);
    expect(relabeled["ai.run.checkTypos"]).toEqual({ answer: "走らせる", ai: [CLAUDE] });
  });

  test("古い形の上に覚えると、新しい形になる（古い答えのAIは分からないので引き継がない）", () => {
    const next = withRemembered({ "ai.run.checkTypos": "実行" }, "ai.run.checkTypos", "実行", [
      GEMINI,
    ]);
    expect(next["ai.run.checkTypos"]).toEqual({ answer: "実行", ai: [GEMINI] });
  });

  test("答えはどちらの形でも引ける。忘れるとAIの記録も一緒に消える", () => {
    const memory = withRemembered({}, "ai.run.checkTypos", "実行", [OLLAMA]);
    expect(rememberedAnswer(memory, "ai.run.checkTypos")).toBe("実行");
    expect(withoutRemembered(memory, "ai.run.checkTypos")).toEqual({});
  });

  test("見直しの一覧に、AIも添えて並べる", () => {
    const memory = withRemembered({ "scope.typoCheck": "all" }, "ai.run.checkTypos", "実行", [
      OLLAMA,
    ]);
    expect(describeRemembered(memory)).toEqual([
      { id: "scope.typoCheck", label: "誤字脱字の検知：どこまで見るか", answer: "all" },
      { id: "ai.run.checkTypos", label: "誤字脱字の検知：処理量の確認", answer: "実行", ai: [OLLAMA] },
    ]);
  });

  test("設定の生の値は、形の合わないものを捨てる（壊れたAIの項目だけ落とす）", () => {
    expect(
      normalizeConfirmMemory({
        a: "実行",
        b: 3,
        c: { answer: "実行", ai: [OLLAMA, { providerId: "x" }, "gemini"] },
        d: { ai: [OLLAMA] },
        e: { answer: "実行" },
      })
    ).toEqual({
      a: "実行",
      c: { answer: "実行", ai: [OLLAMA] },
      e: { answer: "実行", ai: [] },
    });
    expect(normalizeConfirmMemory([])).toEqual({});
    expect(normalizeConfirmMemory(null)).toEqual({});
  });

  test("壊れてAIが空になった覚え書きは、どのAIでも訊き直す", () => {
    const memory = normalizeConfirmMemory({ "ai.run.checkTypos": { answer: "実行", ai: [] } });
    expect(decide(memory, [OLLAMA])).toBe("aiChanged");
  });

  test("confirmAiOf はプロバイダのIDと有料かを写す", () => {
    expect(confirmAiOf({ id: "gemini", isPaid: true }, "gemini-2.5-flash")).toEqual(GEMINI);
  });
});
