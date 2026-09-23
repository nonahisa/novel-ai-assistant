import { afterEach, describe, expect, test, vi } from "vitest";
import { SelfWriteTracker } from "../../../src/core/externalChanges";
import { normalizeForComparison } from "../../../src/core/pathText";
import { isSameLocation } from "../../../src/core/locationCompare";
import * as runtime from "../../../src/core/runtime";
import { platformLabel } from "../../../src/features/showVersion";

/**
 * `process` が無いところ（ブラウザ版）で、押したときに落ちないか（2026-09-23）。
 *
 * **単体テストは Node の上で動くので、ふだんは `process` が在る。** そのため
 * 素の `process.platform` を読む所があっても、ここでは誰も気づかなかった。
 * ブラウザ版で「動作を診断」を押すと、生成文書の書き込み口が
 * `process is not defined` で落ち、無題文書へ逃げていた（本体が実機で確かめた）。
 *
 * ここでは**同期の呼び出しの間だけ** `process` を消して、ブラウザと同じ条件で
 * 呼ぶ。待ち（await）を挟むと、消している間に試験の仕組みの側が動いて壊れる。
 *
 * ソースを読む検査（`browserReach.test.ts` の素の `process`）が網で、
 * こちらは実際に落ちた道を名指しで確かめる。
 */
function withoutProcess<T>(run: () => T): T {
  vi.stubGlobal("process", undefined);
  try {
    return run();
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("process が無いところで落ちない", () => {
  test("前提：消している間は、本当に process が無い", () => {
    expect(withoutProcess(() => typeof process)).toBe("undefined");
    expect(typeof process).toBe("object");
  });

  test("書き込み口の見張り（atomicWriteFile が必ず呼ぶ）が落ちない", () => {
    // 「動作を診断」で落ちた1か所。`atomicWriteFile` は書く前に必ず
    // `SelfWriteTracker.markWriting` を呼ぶので、ここが落ちると
    // ブラウザ版の書き込みがすべて落ちる
    const tracker = new SelfWriteTracker();
    const location =
      "vscode-userdata:/User/globalStorage/nonahisa.novel-ai-assistant/generated/動作の診断.md";
    withoutProcess(() => tracker.markWriting(location));
    expect(withoutProcess(() => tracker.isSelfWrite(location))).toBe(true);
  });

  test("場所の比べ方は、大文字小文字を区別する側へ倒れる", () => {
    expect(
      withoutProcess(() => normalizeForComparison("vscode-vfs://github/o/r/A.txt"))
    ).toBe("vscode-vfs://github/o/r/A.txt");
    expect(withoutProcess(() => isSameLocation("/a/B", "/a/b"))).toBe(false);
  });

  test("読み口は、無いものを「無い」と返す", () => {
    expect(withoutProcess(() => runtime.isWebRuntime())).toBe(true);
    expect(withoutProcess(() => runtime.hostPlatform())).toBeUndefined();
    expect(withoutProcess(() => runtime.isWindowsHost())).toBe(false);
    expect(withoutProcess(() => runtime.environmentVariable("PATH"))).toBeUndefined();
  });

  test("「バージョンを確認」の OS 欄が作れる", () => {
    // ブラウザ版で押すと `process is not defined` の窓が出て落ちた（実機）
    expect(withoutProcess(() => platformLabel(runtime.hostPlatform()))).toBe(
      "ブラウザ版"
    );
  });
});

describe("Node の上では、これまでどおり読める", () => {
  test("OS の名前と環境変数", () => {
    expect(runtime.hostPlatform()).toBe(process.platform);
    expect(runtime.isWindowsHost()).toBe(process.platform === "win32");
    expect(platformLabel(runtime.hostPlatform())).toBe(process.platform);
    vi.stubEnv("NOVELAI_RUNTIME_TEST", "1");
    expect(runtime.environmentVariable("NOVELAI_RUNTIME_TEST")).toBe("1");
    vi.unstubAllEnvs();
    expect(runtime.environmentVariable("NOVELAI_RUNTIME_TEST")).toBeUndefined();
  });
});
