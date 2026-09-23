import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { buildVersionReport } from "../../../src/features/showVersion";

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

/**
 * 窓の名前と機械の名前（作者の依頼、2026-09-22 未明「B2」）。
 *
 * MCP の `windows.list` と**同じ中身**を、作者が自分の目でも見られるように
 * する。2台で作業していると、画面の「バージョンを確認」と機械の返事を
 * 突き合わせたくなる——片方にしか無い項目があると突き合わせられない。
 */
describe("バージョンの表示——窓と機械", () => {
  test("窓の名前・開いている作品・機械の名前を出す", () => {
    const report = buildVersionReport(
      info({
        window: {
          name: "書庫",
          works: ["教科書チート", "灯台の子"],
          machineName: "DESKTOP-AB12CD",
          developmentHost: false,
        },
      })
    );
    expect(report).toContain("窓: 書庫（作品: 教科書チート・灯台の子）");
    expect(report).toContain("機械: DESKTOP-AB12CD");
    // 普段の窓では、開発ホストの行を出さない（読む行を増やさない）
    expect(report).not.toContain("開発ホスト");
  });

  test("拡張機能開発ホストなら、そう書く（手元のソースで動いている）", () => {
    const report = buildVersionReport(
      info({
        window: {
          name: "書庫",
          works: [],
          machineName: "note-pc",
          developmentHost: true,
        },
      })
    );
    expect(report).toContain("拡張機能開発ホスト");
    // 作品が無ければ括弧を付けない
    expect(report).toContain("窓: 書庫\n");
  });

  test("フォルダーを開いていない窓・機械の名前が取れない環境でも壊れない", () => {
    const report = buildVersionReport(
      info({
        window: {
          name: null,
          works: [],
          machineName: null,
          developmentHost: false,
        },
      })
    );
    expect(report).toContain("窓: （フォルダーを開いていない窓）");
    // 取れない名前を空で名乗らない
    expect(report).not.toContain("機械:");
  });

  test("窓の情報を渡さなければ、これまでどおりの表示", () => {
    const report = buildVersionReport(info());
    expect(report).not.toContain("窓:");
    expect(report).not.toContain("機械:");
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

  test("設計書の版も一致する", () => {
    // 設計書だけ文書用の通し番号（0.9）を振っていたので、
    // 拡張機能が 0.6.x を名乗っているのにどちらが新しいか分からなかった
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      version: string;
    };
    const design = readFileSync("docs/設計書.md", "utf-8");

    expect(design).toContain(`version ${pkg.version} /`);
  });

  test("引継ぎ書の「いまの状態」の版も一致する", () => {
    // 次のセッションが最初に読む表なので、ここが古いと現状を取り違える。
    // 実際に 0.6.9 のまま 5回分の修正が積み上がっていた
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      version: string;
    };
    const handover = readFileSync("docs/進捗と引継ぎ.md", "utf-8");

    expect(handover).toContain(`| 版 | **${pkg.version}**`);
  });
});
