import { describe, expect, test } from "vitest";
import {
  MementoWriteLostError,
  VerifiedState,
  setVerifiedStateReporter,
  verifiedState,
} from "../../../src/core/verifiedMemento";
import { EchoingMemento, tick } from "../support/echoingMemento";

/**
 * 守った保管庫（`VerifiedState`。0.97.4、設計書5.7.8）。
 *
 * 登録簿（0.97.3）だけを守っていた「書いたら読み返す・しばらく見張る」を、
 * globalState のほかの鍵にも使えるよう包みにした。ここで確かめるのは、
 * 包みに固有の約束——**選び直しを前の見張りが戻さない**、**別の窓の変更を
 * 踏みつぶさない**、**足す・外すは期間にある分を全部当て直す**。
 */

/** 外から開け閉めできる待ち */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { wait: () => opened, open };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await tick();
}

/** 先の別の鍵の書き込み。送出は済んだが、送り返しはまだ届いていない */
async function earlierWriteInFlight(memento: EchoingMemento): Promise<void> {
  memento.holdEchoes = true;
  void memento.update("novelai.other", 1);
  await tick();
}

describe("値を置く（update）", () => {
  test("送り返しと重なっても残る", async () => {
    const memento = new EchoingMemento();
    const state = new VerifiedState(memento, { lateCheckDelays: [] });
    await earlierWriteInFlight(memento);
    memento.holdEchoes = false;

    await state.update("novelai.voice", "Haruka");

    expect(state.get("novelai.voice")).toBe("Haruka");
    expect(memento.persisted["novelai.voice"]).toBe("Haruka");
  });

  test("読み返したあとで遅れて消えても、見張りが置き直す", async () => {
    const memento = new EchoingMemento();
    const late = gate();
    const state = new VerifiedState(memento, { lateCheckDelays: [100], wait: late.wait });
    let repaired = 0;
    setVerifiedStateReporter({ onRepaired: () => repaired++ });
    try {
      await earlierWriteInFlight(memento);
      await state.update("novelai.voice", "Haruka");
      memento.holdEchoes = false;
      memento.deliverHeldEchoes("newest-first");
      expect(state.get("novelai.voice")).toBeUndefined();

      late.open();
      await settle();

      expect(state.get("novelai.voice")).toBe("Haruka");
      expect(memento.persisted["novelai.voice"]).toBe("Haruka");
      expect(repaired).toBe(1);
    } finally {
      setVerifiedStateReporter({});
    }
  });

  test("2秒以内に選び直した値を、前の書き込みの見張りが戻さない", async () => {
    const memento = new EchoingMemento();
    const late = gate();
    const state = new VerifiedState(memento, { lateCheckDelays: [100], wait: late.wait });

    await state.update("novelai.ai.provider", "ollama");
    await state.update("novelai.ai.provider", "gemini");
    late.open();
    await settle();

    expect(state.get("novelai.ai.provider")).toBe("gemini");
    expect(memento.persisted["novelai.ai.provider"]).toBe("gemini");
  });

  test("別の窓が違う値を置いたら、こちらの値で踏みつぶさない", async () => {
    const memento = new EchoingMemento();
    const late = gate();
    const state = new VerifiedState(memento, { lateCheckDelays: [100], wait: late.wait });
    let skipped = 0;
    setVerifiedStateReporter({ onSkipped: () => skipped++ });
    try {
      await state.update("novelai.ai.provider", "ollama");
      // 別の窓での選択が届いた（こちらの包みを通らない書き込み）
      await memento.update("novelai.ai.provider", "claude");

      late.open();
      await settle();

      expect(state.get("novelai.ai.provider")).toBe("claude");
      expect(skipped).toBe(1);
    } finally {
      setVerifiedStateReporter({});
    }
  });

  test("消す（undefined）も確かめる", async () => {
    const memento = new EchoingMemento();
    const state = new VerifiedState(memento, { lateCheckDelays: [] });
    await state.update("novelai.voice", "Haruka");
    await earlierWriteInFlight(memento);
    memento.holdEchoes = false;

    await state.update("novelai.voice", undefined);

    expect(state.get("novelai.voice")).toBeUndefined();
    expect(memento.persisted["novelai.voice"]).toBeUndefined();
  });

  test("何度書いても残らなければ、黙らずに投げる", async () => {
    const memento = new EchoingMemento();
    const state = new VerifiedState(memento, { lateCheckDelays: [] });
    memento.sabotage = { "novelai.other": 1 };

    await expect(state.update("novelai.voice", "Haruka")).rejects.toBeInstanceOf(
      MementoWriteLostError
    );
  });
});

describe("足す・外す（patch）", () => {
  test("期間にある足し算を全部当て直す（あとの1つだけを戻すのではない）", async () => {
    const memento = new EchoingMemento();
    const late = gate();
    const state = new VerifiedState(memento, { lateCheckDelays: [100], wait: late.wait });
    const add = (feature: string) => (current: Record<string, string>) => ({
      ...current,
      [feature]: "lmstudio",
    });

    await earlierWriteInFlight(memento);
    await state.patch("novelai.ai.featureAssignments", {}, add("typo"));
    await state.patch("novelai.ai.featureAssignments", {}, add("extract"));
    memento.holdEchoes = false;
    memento.deliverHeldEchoes("newest-first");

    late.open();
    await settle();

    expect(state.get("novelai.ai.featureAssignments")).toEqual({
      typo: "lmstudio",
      extract: "lmstudio",
    });
  });

  test("別の窓が足した分を残したまま当て直す", async () => {
    const memento = new EchoingMemento();
    const state = new VerifiedState(memento, { lateCheckDelays: [] });
    await memento.update("novelai.ai.featureAssignments", { chat: "claude" });

    await state.patch<Record<string, string>>(
      "novelai.ai.featureAssignments",
      {},
      (current) => ({ ...current, typo: "lmstudio" })
    );

    expect(memento.persisted["novelai.ai.featureAssignments"]).toEqual({
      chat: "claude",
      typo: "lmstudio",
    });
  });
});

describe("包みは保管庫ごとに1つ", () => {
  test("同じ保管庫には同じ包みを返す（同じ鍵の見張りが1か所に集まる）", () => {
    const memento = new EchoingMemento();
    const first = verifiedState(memento, { lateCheckDelays: [] });
    expect(verifiedState(memento)).toBe(first);
    expect(verifiedState(first)).toBe(first);
  });

  test("get は既定値を見ない作り物でも既定値を返す", () => {
    const state = new VerifiedState({
      get: () => undefined,
      update: async () => undefined,
    });
    expect(state.get("x", 3)).toBe(3);
    expect(state.keys()).toEqual([]);
  });
});
