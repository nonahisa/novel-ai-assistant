import { describe, expect, test, vi } from "vitest";
import {
  handleSetupRequest,
  type SetupRequestHandlerDeps,
} from "../../../src/features/setupRequestHandler";
import { buildSetupUri } from "../../../src/core/setupRequest";
import { ReaderStatsHelperLink } from "../../../src/features/readerStatsHelperLink";
import { readerStatsUriAction } from "../../../src/core/readerStatsHelperLink";

/**
 * Claude Code からの依頼を受ける側（設計書6.87.18）。
 *
 * **どの段も、まず「Claude Code からの依頼です」の確認を出す。** URI は
 * ウェブページのリンク1つでも開かせられるので、誰が作ったか分からない依頼を
 * 黙って始めない。作者が断れば何も起きない。
 */

function queryOf(uri: string): string {
  return uri.slice(uri.indexOf("?") + 1);
}

function deps(overrides: Partial<SetupRequestHandlerDeps> = {}): SetupRequestHandlerDeps {
  return {
    confirm: vi.fn(async () => true),
    run: vi.fn(async () => undefined),
    warn: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

describe("確認してから始める", () => {
  test("作者が「始める」を押したら、その段を呼ぶ", async () => {
    const d = deps();
    await handleSetupRequest(queryOf(buildSetupUri({ step: "ollama" })), d);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledWith({ step: "ollama" });
  });

  test("断られたら、何も呼ばない", async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    await handleSetupRequest(queryOf(buildSetupUri({ step: "vector" })), d);
    expect(d.run).not.toHaveBeenCalled();
  });

  test("確認には、Claude Code からの依頼であることと受けた答えを並べる", async () => {
    const confirm = vi.fn<SetupRequestHandlerDeps["confirm"]>(async () => true);
    const d = deps({ confirm });
    await handleSetupRequest(
      queryOf(buildSetupUri({ step: "create", title: "星の町", format: "long" })),
      d
    );
    const [message, detail] = confirm.mock.calls[0] ?? ["", ""];
    expect(message).toContain("Claude Code");
    expect(detail).toContain("星の町");
    expect(detail).toContain("長編");
  });
});

describe("おかしな依頼は、確認も出さずに断る", () => {
  test("知らない段", async () => {
    const d = deps();
    await handleSetupRequest("step=erase", d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  test("受けない鍵", async () => {
    const d = deps();
    await handleSetupRequest("step=ai&provider=x", d);
    expect(d.run).not.toHaveBeenCalled();
  });
});

describe("記録", () => {
  test("受けたことは残すが、値（作品名・パス）は残さない", async () => {
    const log = vi.fn<SetupRequestHandlerDeps["log"]>();
    await handleSetupRequest(
      queryOf(buildSetupUri({ step: "register", path: "C:\\秘密の作品" })),
      deps({ log })
    );
    const text = log.mock.calls.map((call) => call[0]).join("\n");
    expect(text).toContain("register");
    expect(text).not.toContain("秘密");
  });

  test("途中で失敗しても落ちず、作者に知らせて記録する", async () => {
    const d = deps({
      run: vi.fn(async () => {
        throw new Error("壊れた");
      }),
    });
    await handleSetupRequest("step=ollama", d);
    expect(d.warn).toHaveBeenCalled();
    expect((d.log as ReturnType<typeof vi.fn>).mock.calls.join("\n")).toContain("壊れた");
  });
});

describe("受け口のパス", () => {
  test("/setup はセットアップの依頼", () => {
    expect(readerStatsUriAction("/setup")).toBe("setup");
    expect(readerStatsUriAction("/setup/")).toBe("setup");
    expect(readerStatsUriAction("/Setup")).toBeUndefined();
  });

  test("受け口は、クエリをセットアップの依頼へそのまま渡す", async () => {
    const handleSetupRequest = vi.fn(async () => undefined);
    const link = new ReaderStatsHelperLink({
      listWorks: () => [],
      memory: { get: (_key, value) => value, update: async () => undefined },
      afterImport: async () => undefined,
      handleSetupRequest,
    });
    await link.handleUri({ path: "/setup", query: "step=ollama" });
    expect(handleSetupRequest).toHaveBeenCalledWith("step=ollama");
  });
});
