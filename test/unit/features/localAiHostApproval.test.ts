import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import { confirmPaidUsage, confirmProviderReachable } from "../../../src/features/aiConnectivity";
import { rememberLocalAiHostApproval } from "../../../src/features/localAiHostApproval";

/**
 * 手元のAI（Ollama・LM Studio）の宛先がこの PC の外を指すときは、初回だけ確かめて答えを覚える
 * （セキュリティ点検 2026-11-21）。
 *
 * 手元のAIは「本文が PC の外へ出ない」ことが選ばれる理由なので、料金の確認（有料のAIだけ）は出ない。
 * 宛先の設定が別の機械（`http://192.168.1.20:11434`）を指していると、本文は黙ってそこへ送られていた。
 */

const SEND = "送る";

interface Shown {
  message: string;
  modal: boolean;
  buttons: string[];
}

let shown: Shown[] = [];
let answer: string | undefined;
let endpoint = "http://localhost:11434";
let stored: Record<string, unknown> = {};
const originalWarning = window.showWarningMessage;
const originalConfig = workspace.getConfiguration;

beforeEach(() => {
  shown = [];
  answer = undefined;
  stored = {};
  rememberLocalAiHostApproval({
    get: <T>(key: string) => stored[key] as T | undefined,
    update: async (key: string, value: unknown) => {
      stored[key] = value;
    },
    keys: () => Object.keys(stored),
  } as never);
  window.showWarningMessage = (async (
    message: string,
    options: { modal?: boolean } | string,
    ...buttons: string[]
  ) => {
    shown.push({
      message,
      modal: typeof options === "object" && options?.modal === true,
      buttons,
    });
    return answer;
  }) as unknown as typeof window.showWarningMessage;
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, defaultValue: T): T =>
      (key === "ollama.endpoint" || key === "lmstudio.endpoint" ? endpoint : defaultValue) as T,
    inspect: () => undefined,
  })) as unknown as typeof workspace.getConfiguration;
});

afterEach(() => {
  window.showWarningMessage = originalWarning;
  workspace.getConfiguration = originalConfig;
});

const reachable = (id: string) => {
  let tested = 0;
  return {
    provider: {
      id,
      testConnection: async () => {
        tested++;
        return { ok: true, message: "つながりました" };
      },
    },
    tested: () => tested,
  };
};

describe("手元のAIの宛先がこの PC の外を指すとき", () => {
  test("この PC の中なら何も訊かない", async () => {
    const { provider } = reachable("ollama");
    expect(await confirmProviderReachable(provider, "誤字脱字検知")).toBe(true);
    expect(shown).toEqual([]);
  });

  test("外なら、送る前に真ん中の窓で訊く。断れば何も送らない（接続の確認も）", async () => {
    endpoint = "http://192.168.1.20:11434";
    const { provider, tested } = reachable("ollama");
    expect(await confirmProviderReachable(provider, "誤字脱字検知")).toBe(false);
    expect(shown).toHaveLength(1);
    expect(shown[0].modal).toBe(true);
    expect(shown[0].message).toContain("192.168.1.20:11434");
    expect(shown[0].buttons).toEqual([SEND]);
    expect(tested()).toBe(0);
  });

  test("送ると答えたら覚え、同じホストへは次から訊かない", async () => {
    endpoint = "http://192.168.1.20:11434";
    answer = SEND;
    const { provider } = reachable("ollama");
    expect(await confirmProviderReachable(provider, "誤字脱字検知")).toBe(true);
    expect(await confirmProviderReachable(provider, "誤字脱字検知")).toBe(true);
    expect(shown).toHaveLength(1);
  });

  test("断った答えは覚えない（次も訊く）", async () => {
    endpoint = "http://192.168.1.20:11434";
    const { provider } = reachable("lmstudio");
    await confirmProviderReachable(provider, "推敲");
    await confirmProviderReachable(provider, "推敲");
    expect(shown).toHaveLength(2);
    expect(shown[0].message).toContain("LM Studio");
  });

  test("口（ポート）が違えば別のホストとして訊く", async () => {
    endpoint = "http://192.168.1.20:11434";
    answer = SEND;
    const { provider } = reachable("ollama");
    await confirmProviderReachable(provider, "誤字脱字検知");
    endpoint = "http://192.168.1.20:11435";
    await confirmProviderReachable(provider, "誤字脱字検知");
    expect(shown).toHaveLength(2);
  });

  test("料金の確認だけを通る道（有料でない手元のAI）でも訊く", async () => {
    endpoint = "http://192.168.1.20:11434";
    const provider = { id: "ollama", isPaid: false, displayName: "Ollama" } as never;
    expect(
      await confirmPaidUsage(provider, { actionLabel: "提案", model: "gemma", sends: "本文" })
    ).toBe(false);
    expect(shown).toHaveLength(1);
  });

  test("クラウドのAIには訊かない（宛先は https に限ってある）", async () => {
    endpoint = "http://192.168.1.20:11434";
    const { provider } = reachable("gemini");
    expect(await confirmProviderReachable(provider, "誤字脱字検知")).toBe(true);
    expect(shown).toEqual([]);
  });
});
