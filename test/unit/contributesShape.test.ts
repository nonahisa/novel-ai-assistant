import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `package.json` の `contributes` の形（実機確認リスト B-1・F-33 の代わり）。
 *
 * **VS Code は、宣言の形が違っても何も言わない。** 読まれなければ、その機能は
 * 一度も動かないまま静かに消える。`markdown.markdownItPlugins` を入れ子で
 * 書いていたためにプレビューのルビが**一度も動いていなかった**
 * （2026-09-07に実機で判明。単体テストは関数を直に呼ぶので通ってしまう）。
 *
 * 同じ落とし穴が3つあるので、まとめて見張る。
 * 入れ子と平らの見分けそのものは `markdownItPluginsKey.test.ts` にある。
 */

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  contributes: Record<string, unknown> & {
    commands: Array<{ command: string; title: string }>;
  };
};

describe("平らな鍵でしか読まれないもの", () => {
  /**
   * VS Code 本体の `markdown-language-features` が見る3つ。
   * どれも `contributes["markdown.xxx"]` という**点を含んだ1つの鍵**で、
   * `"markdown": { "xxx": … }` と書くと `undefined` になる。
   */
  const FLAT_KEYS = [
    "markdown.previewStyles",
    "markdown.previewScripts",
    "markdown.markdownItPlugins",
  ];

  for (const key of FLAT_KEYS) {
    test(`${key} は、使うなら平らな鍵で書く`, () => {
      // 使っていなければ何も無くてよい。**入れ子で在ることだけを禁じる**
      const [group, child] = key.split(".");
      const nested = manifest.contributes[group] as
        | Record<string, unknown>
        | undefined;

      expect(
        nested?.[child],
        `${key} が入れ子で書かれている（VS Code は読まない）`
      ).toBeUndefined();
    });
  }
});

/**
 * 宣言（`contributes.commands`）と実体（`registerCommand`）の対応。
 *
 * - **宣言だけあって実体が無い**と、コマンドパレットから押せるのに
 *   「command not found」で落ちる
 * - **実体だけあって宣言が無い**と、コマンドパレットに出ない（開発用の
 *   道具は、それでよい。メニューの「テスト中」から押す）
 */
describe("コマンドは、宣言と実体が揃っている", () => {
  /** 実体を持つコマンドID。書き方が3通りあるので、3通りとも読む */
  function registeredCommands(): Set<string> {
    const found = new Set<string>();
    const sources = [
      "src/extension.ts",
      "src/views/progress.ts",
      "src/dev/checkRunner.ts",
      "src/dev/reflectOperationLog.ts",
      "src/dev/streamToggle.ts",
    ].map((file) => readFileSync(file, "utf8"));
    const all = sources.join("\n");

    // ① そのまま書いてある：registerCommand("novelai.xxx", …)
    for (const match of all.matchAll(/registerCommand\(\s*"([^"]+)"/g)) {
      found.add(match[1]);
    }

    // ② 定数で渡している：registerCommand(PROOFREADING_SUITE_COMMAND, …)
    //    定数の中身は宣言している側（core）から引く
    const constants = new Map<string, string>();
    for (const file of ["src/core/proofreadingSuite.ts"]) {
      const body = readFileSync(file, "utf8");
      for (const match of body.matchAll(
        /export const ([A-Z0-9_]+) = "(novelai\.[^"]+)"/g
      )) {
        constants.set(match[1], match[2]);
      }
    }
    for (const match of all.matchAll(/registerCommand\(\s*([A-Z0-9_]+)/g)) {
      const id = constants.get(match[1]);
      if (id) found.add(id);
    }

    // ③ 表を回して登録している：for (const [command, kind] of [["novelai.xxx", …]])
    //    表に載っているIDを実体ありとして数える
    if (/registerCommand\(\s*command\b/.test(all)) {
      for (const match of all.matchAll(/\[\s*"(novelai\.[A-Za-z0-9_.]+)"\s*,/g)) {
        found.add(match[1]);
      }
    }

    return found;
  }

  const registered = registeredCommands();

  test("宣言したコマンドには、すべて実体がある", () => {
    const declared = manifest.contributes.commands.map((entry) => entry.command);
    const orphans = declared.filter((command) => !registered.has(command));

    expect(orphans).toEqual([]);
  });

  test("コマンドパレットに出したくないものだけが、宣言を持たない", () => {
    const declared = new Set(
      manifest.contributes.commands.map((entry) => entry.command)
    );
    // 開発ビルド限定の道具（本番では枝ごと落ちる）。**作者の画面には出さない**
    const devOnly = new Set(["novelai.runChecks", "novelai.reflectOperationLog"]);

    const undeclared = [...registered].filter(
      (command) => !declared.has(command) && !devOnly.has(command)
    );

    expect(undeclared).toEqual([]);
  });

  test("同じコマンドIDを二度宣言しない", () => {
    // 二度書くと、あとの `title` が黙って勝つ
    const declared = manifest.contributes.commands.map((entry) => entry.command);

    expect(declared.length).toBe(new Set(declared).size);
  });
});
