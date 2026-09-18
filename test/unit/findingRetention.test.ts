import { readFileSync, readdirSync } from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { workspace } from "./support/vscodeStub";
import { findingsRetentionDays } from "../../src/features/findingStore";

/**
 * 指摘を残す日数の設定（設計書6.96.4）。
 *
 * 作者の指示（2026-09-19）：「保存日数は設定管理で管理。デフォルトは3日」。
 * 先例は `novelai.logs.retentionDays`（7日）。
 *
 * **読む場所は1か所だけ**（6.58.3）。決め方を1か所へ集めても、呼び出し側の
 * 数行が残っていれば効かないままで、しかも**動いてはいる**ので誰も
 * 気づかない。だから見張りを置く。
 */

const root = nodePath.join(__dirname, "..", "..");

describe("設定の登録", () => {
  const manifest = JSON.parse(
    readFileSync(nodePath.join(root, "package.json"), "utf8")
  ) as {
    contributes: {
      configuration: {
        properties: Record<
          string,
          { type?: string; default?: unknown; minimum?: number }
        >;
      };
    };
  };

  test("既定は3日で、0まで下げられる（0は無期限）", () => {
    const entry =
      manifest.contributes.configuration.properties[
        "novelai.findings.retentionDays"
      ];

    expect(entry).toBeDefined();
    expect(entry?.type).toBe("number");
    expect(entry?.default).toBe(3);
    expect(entry?.minimum).toBe(0);
  });
});

describe("設定を読むところ", () => {
  afterEach(() => {
    // 他のテストと共有の作り物なので、既定へ戻す
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  test("設定が無ければ3日", () => {
    expect(findingsRetentionDays()).toBe(3);
  });

  test("設定があれば、その日数", () => {
    workspace.getConfiguration = () =>
      ({
        get: <T>(key: string, defaultValue?: T): T =>
          (key === "findings.retentionDays" ? 10 : defaultValue) as T,
      }) as unknown as ReturnType<typeof workspace.getConfiguration>;

    expect(findingsRetentionDays()).toBe(10);
  });

  /**
   * **写しが戻らないようにする番人**（6.58.3）。`mergeChunkChars` や
   * `ollama.numCtx` に置いてあるものと同じ形で、コメントの中の言及は
   * 数えない（経緯を書き残せるようにするため）。
   */
  test("findings.retentionDays を読むのは findingStore.ts だけ", () => {
    const owner = "src/features/findingStore.ts";
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const relative = nodePath
          .relative(root, full)
          .split(nodePath.sep)
          .join("/");
        if (relative === owner) continue;
        const code = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        if (code.includes('"findings.retentionDays"')) offenders.push(relative);
      }
    };
    walk(nodePath.join(root, "src"));

    expect(offenders).toEqual([]);
  });
});
