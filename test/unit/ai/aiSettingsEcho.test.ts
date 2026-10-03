import { describe, expect, test } from "vitest";
import { AIRegistry } from "../../../src/ai/registry";
import { verifiedState } from "../../../src/core/verifiedMemento";
import { EchoingMemento, tick } from "../support/echoingMemento";

/**
 * AIの設定が、選んだ直後に消える（2026-10-03。0.97.4）。
 *
 * 0.97.3 で登録簿（`novelai.works`）について見つけたのと同じ形
 * （`support/echoingMemento.ts` の説明、設計書5.7.8）。VS Code の globalState は
 * 鍵を1つの塊で持ち、先に書いた別の鍵の**送り返しがあとから届く**と、
 * 手元の塊が古い塊で丸ごと差し替わる。AIの選択（既定のAI・モデル）と
 * 機能ごとの割り当ても同じ塊にあるので、選んだ直後に別の鍵が書かれていると、
 * 作者の選んだAIが黙って初期へ戻る。
 */

const KEY_PROVIDER = "novelai.ai.provider";
const KEY_MODEL = "novelai.ai.model";
const KEY_ASSIGNMENTS = "novelai.ai.featureAssignments";

function contextOf(memento: EchoingMemento) {
  // 遅れて消える形は verifiedState.test.ts で確かめる。ここは見張りを止める
  verifiedState(memento, { lateCheckDelays: [] });
  return {
    globalState: memento,
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: () => ({ dispose: () => undefined }),
    },
  } as never;
}

/** 起動のときの別の鍵の書き込み。送出は済んだが、送り返しはまだ届いていない */
async function earlierWriteInFlight(memento: EchoingMemento): Promise<void> {
  memento.holdEchoes = true;
  void memento.update("novelai.firstRun.aiSetupShown", true);
  await tick();
  memento.holdEchoes = false;
}

describe("先の書き込みの送り返しと重なっても、AIの設定は消えない", () => {
  test("既定のAIとモデルを選ぶ", async () => {
    const memento = new EchoingMemento();
    const registry = new AIRegistry(contextOf(memento));

    await earlierWriteInFlight(memento);
    await registry.select("ollama", "gemma4:e4b");

    expect(registry.selectedProviderId).toBe("ollama");
    expect(registry.selectedModel).toBe("gemma4:e4b");
    // 次に起動したときに読まれる塊にも残っている
    expect(memento.persisted[KEY_PROVIDER]).toBe("ollama");
    expect(memento.persisted[KEY_MODEL]).toBe("gemma4:e4b");
    // 先に書かれた別の鍵も消していない
    expect(memento.persisted["novelai.firstRun.aiSetupShown"]).toBe(true);
  });

  test("機能ごとの割り当て", async () => {
    const memento = new EchoingMemento();
    const registry = new AIRegistry(contextOf(memento));

    await earlierWriteInFlight(memento);
    await registry.assign("typo", "lmstudio", "gemma4:e4b");

    expect(registry.assignments().typo).toEqual({
      provider: "lmstudio",
      model: "gemma4:e4b",
    });
    expect(memento.persisted[KEY_ASSIGNMENTS]).toEqual({
      typo: { provider: "lmstudio", model: "gemma4:e4b" },
    });
  });
});
