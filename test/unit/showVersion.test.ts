import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { buildVersionReport } from "../../src/features/showVersion";

function info(overrides: Partial<Parameters<typeof buildVersionReport>[0]> = {}) {
  return {
    displayName: "統合小説執筆環境",
    version: "0.6.0",
    vscodeVersion: "1.104.0",
    platform: "win32",
    ai: { provider: "Ollama（ローカル）", model: "gemma4:e4b", paid: false },
    vectorSearch: false,
    ...overrides,
  };
}

describe("バージョンの表示", () => {
  test("版を先頭に出す", () => {
    expect(buildVersionReport(info()).split("\n")[0]).toBe(
      "統合小説執筆環境 0.6.0"
    );
  });

  test("環境も添える", () => {
    // 不具合を伝えるときに要るのは、版だけでなくその周りの情報
    const report = buildVersionReport(info());

    expect(report).toContain("VS Code: 1.104.0");
    expect(report).toContain("OS: win32");
    expect(report).toContain("Ollama（ローカル） / gemma4:e4b");
    expect(report).toContain("意味検索: 切");
  });

  test("有料かどうかを書く", () => {
    const report = buildVersionReport(
      info({ ai: { provider: "Claude", model: "claude-opus-5", paid: true } })
    );

    expect(report).toContain("（有料）");
  });

  test("AIが未設定でも壊れない", () => {
    expect(buildVersionReport(info({ ai: undefined }))).toContain("AI: 未設定");
  });

  test("意味検索が入なら入と書く", () => {
    expect(buildVersionReport(info({ vectorSearch: true }))).toContain(
      "意味検索: 入"
    );
  });

  test("版が取れなくても壊れない", () => {
    expect(buildVersionReport(info({ version: "（不明）" }))).toContain("（不明）");
  });
});

describe("版の出どころ", () => {
  test("package.json の版とCHANGELOGの見出しが一致する", () => {
    // ここがずれると、直したはずの不具合が直っていないと誤解される。
    // 版を上げたときにCHANGELOGを書き忘れると、このテストで止まる
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      version: string;
    };
    const changelog = readFileSync("CHANGELOG.md", "utf-8");

    expect(changelog).toContain(`## ${pkg.version} -`);
  });

  test("READMEの配布版の表記も一致する", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      version: string;
    };
    const readme = readFileSync("README.md", "utf-8");

    expect(readme).toContain(`**${pkg.version}**`);
  });
});
