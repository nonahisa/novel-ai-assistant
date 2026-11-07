import { describe, expect, test } from "vitest";
import { describeVoiceHost, type HostNameResolver } from "../../../src/core/voiceHostName";

/**
 * 人物の声で本文を外へ送る前の確認の窓に出す、送り先の名前（0.140.1。実機確認リスト 24行、
 * 作者の答え 2026-11-07 A）。本物の DNS は引かず、引く口を差し替えて試す。
 */

function resolver(answers: {
  reverse?: (address: string, port: number) => Promise<string | undefined>;
  forward?: (name: string) => Promise<string | undefined>;
}): HostNameResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reverse: async (address, port) => {
      calls.push(`reverse ${address} ${port}`);
      return answers.reverse ? answers.reverse(address, port) : undefined;
    },
    forward: async (name) => {
      calls.push(`forward ${name}`);
      return answers.forward ? answers.forward(name) : undefined;
    },
  };
}

const never = () => new Promise<string | undefined>(() => undefined);

describe("番地で書いてあるとき", () => {
  test("名前を引けたら、名前を先に、番地とポートを括弧で添える", async () => {
    const lookup = resolver({ reverse: async () => "shosai-pc" });
    const result = await describeVoiceHost("192.168.3.15:10101", { resolver: lookup, isWeb: false });
    expect(result).toEqual({ label: "shosai-pc（192.168.3.15:10101）", outcome: "resolved" });
    expect(lookup.calls).toEqual(["reverse 192.168.3.15 10101"]);
  });

  test("IPv6 は括弧を外して引き、窓には書いたままの形で添える", async () => {
    const lookup = resolver({ reverse: async () => "shosai-pc" });
    const result = await describeVoiceHost("[fe80::1]:10101", { resolver: lookup, isWeb: false });
    expect(result.label).toBe("shosai-pc（[fe80::1]:10101）");
    expect(lookup.calls).toEqual(["reverse fe80::1 10101"]);
  });

  test("ポートを書いていなければ、http の既定の 80 で引く", async () => {
    const lookup = resolver({ reverse: async () => "shosai-pc" });
    const result = await describeVoiceHost("192.168.3.15", { resolver: lookup, isWeb: false });
    expect(result.label).toBe("shosai-pc（192.168.3.15）");
    expect(lookup.calls).toEqual(["reverse 192.168.3.15 80"]);
  });

  test("引けなければ、番地だけ（OS が番地そのものを返したときも、引けなかったと見る）", async () => {
    expect(
      await describeVoiceHost("192.168.3.15:10101", { resolver: resolver({}), isWeb: false })
    ).toEqual({ label: "192.168.3.15:10101", outcome: "notFound" });
    expect(
      await describeVoiceHost("192.168.3.15:10101", {
        resolver: resolver({ reverse: async (address) => address }),
        isWeb: false,
      })
    ).toEqual({ label: "192.168.3.15:10101", outcome: "notFound" });
  });

  test("引く口が投げても止めない。番地だけを出し、中身はログ用に返す", async () => {
    const result = await describeVoiceHost("192.168.3.15:10101", {
      resolver: resolver({
        reverse: async () => {
          throw new Error("getnameinfo ENOTFOUND 192.168.3.15");
        },
      }),
      isWeb: false,
    });
    expect(result.label).toBe("192.168.3.15:10101");
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("ENOTFOUND");
  });

  test("決まった時間で返事が無ければ打ち切り、番地だけを出す", async () => {
    const started = Date.now();
    const result = await describeVoiceHost("192.168.3.15:10101", {
      resolver: resolver({ reverse: never }),
      timeoutMs: 50,
      isWeb: false,
    });
    expect(result).toEqual({ label: "192.168.3.15:10101", outcome: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe("名前で書いてあるとき", () => {
  test("その名前を出し、番地を引けたら添える", async () => {
    const lookup = resolver({ forward: async () => "192.168.3.15" });
    const result = await describeVoiceHost("studio-pc:10101", { resolver: lookup, isWeb: false });
    expect(result).toEqual({ label: "studio-pc（192.168.3.15:10101）", outcome: "resolved" });
    expect(lookup.calls).toEqual(["forward studio-pc"]);
  });

  test("引けない・時間切れなら、書いたまま", async () => {
    expect(
      (await describeVoiceHost("studio-pc:10101", { resolver: resolver({}), isWeb: false })).label
    ).toBe("studio-pc:10101");
    const late = await describeVoiceHost("studio-pc:10101", {
      resolver: resolver({ forward: never }),
      timeoutMs: 50,
      isWeb: false,
    });
    expect(late).toEqual({ label: "studio-pc:10101", outcome: "timeout" });
  });
});

describe("ブラウザ版", () => {
  test("引かずに書いたまま", async () => {
    const lookup = resolver({ reverse: async () => "shosai-pc" });
    const result = await describeVoiceHost("192.168.3.15:10101", { resolver: lookup, isWeb: true });
    expect(result).toEqual({ label: "192.168.3.15:10101", outcome: "skipped" });
    expect(lookup.calls).toEqual([]);
  });
});
