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
 * - **実体だけあって宣言が無い**と、コマンドパレットに出ない
 */
describe("コマンドは、宣言と実体が揃っている", () => {
  /** 実体を持つコマンドID。書き方が3通りあるので、3通りとも読む */
  function registeredCommands(): Set<string> {
    const found = new Set<string>();
    const sources = ["src/extension.ts", "src/views/progress.ts"].map((file) =>
      readFileSync(file, "utf8")
    );
    const all = sources.join("\n");

    // ① そのまま書いてある：registerCommand("novelai.xxx", …)
    for (const match of all.matchAll(/registerCommand\(\s*"([^"]+)"/g)) {
      found.add(match[1]);
    }

    // ② 定数で渡している：registerCommand(PROOFREADING_SUITE_COMMAND, …)
    //    定数の中身は宣言している側（core）から引く
    const constants = new Map<string, string>();
    for (const file of [
      "src/core/proofreadingSuite.ts",
      "src/core/finishNewWork.ts",
    ]) {
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

  test("宣言を持たない実体は無い", () => {
    // 0.45.0 まで、開発ビルド限定の道具だけが宣言を持たなかった。
    // 道具ごと撤去したので、**例外はもう1件も無い**（設計書6.26）
    const declared = new Set(
      manifest.contributes.commands.map((entry) => entry.command)
    );

    const undeclared = [...registered].filter(
      (command) => !declared.has(command)
    );

    expect(undeclared).toEqual([]);
  });

  test("同じコマンドIDを二度宣言しない", () => {
    // 二度書くと、あとの `title` が黙って勝つ
    const declared = manifest.contributes.commands.map((entry) => entry.command);

    expect(declared.length).toBe(new Set(declared).size);
  });
});

/**
 * ファイルを右クリックしたときに出るもの（実機確認リスト F-73 の代わり）。
 *
 * **出す条件はここにしか書けない。** 単話プロットの右クリックに
 * 「単話プロットを検査」を出し、本文のファイルには出さない、という
 * 決まりは `when` の1行が全部を担っている。
 */
describe("ファイルの右クリックに出すもの", () => {
  const menus = manifest.contributes.menus as Record<
    string,
    Array<{ command: string; when?: string; group?: string }>
  >;

  test("「単話プロットを検査」は、単話プロットの置き場の .md にだけ出す", () => {
    const entries = [
      ...(menus["explorer/context"] ?? []),
      ...(menus["editor/context"] ?? []),
      ...(menus["editor/title/context"] ?? []),
    ].filter((entry) => entry.command === "novelai.checkEpisodePlot");

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // 置き場（episode-plots）まで見る。名前だけで決めると、本文の
      // 「第3話.md」にも出てしまう
      expect(entry.when).toContain("episode-plots$");
      expect(entry.when).toContain("resourceExtname == .md");
    }
  });
});

/**
 * 作品が1件も無いときに出る案内文（`viewsWelcome`）。
 *
 * **初めて使う人が、いちばん最初に見る画面である。** ここに無い入口は、
 * 「無い」のと同じになる——作者は作品一覧の `+` からバックアップの
 * 取り込みを探して見つけられなかった（2026-09-19、実機）。
 * `novelai.importWorkFromZip` は 0.68.5 で入れたときから、ここにも
 * 上のボタンにも載せ忘れていた。
 */
describe("作品が0件のときの案内文", () => {
  const welcome = (
    manifest.contributes.viewsWelcome as Array<{
      view: string;
      contents: string;
    }>
  ).filter((entry) => entry.view === "novelai.works");

  /** 案内文に並ぶ入口を、書いてある順に取り出す */
  function entries(): Array<{ label: string; command: string }> {
    return welcome.flatMap((entry) =>
      [...entry.contents.matchAll(/\[([^\]]+)\]\(command:([^)]+)\)/g)].map(
        (match) => ({ label: match[1], command: match[2] })
      )
    );
  }

  test("バックアップからの取り込みが載っている", () => {
    expect(entries().map((item) => item.command)).toContain(
      "novelai.importWorkFromZip"
    );
  });

  /*
    **バックアップを持っている人がいちばん多い。** 投稿サイトで書いてきた
    人が、打鍵ゼロで始められる道である（設計書6.99）。フォルダを自分で
    作ってから登録する道より先に見えていないと、遠回りのほうを選ばせる。
  */
  test("取り込みが、フォルダから追加より先に出る", () => {
    const commands = entries().map((item) => item.command);
    const zip = commands.indexOf("novelai.importWorkFromZip");
    const folder = commands.indexOf("novelai.addWork");
    // **両方あることから確かめる。** 無い（-1）ほうが小さくなるので、
    // 並び順だけを見ると「載っていない」状態でも通ってしまう
    expect(zip, "取り込みが載っていない").toBeGreaterThanOrEqual(0);
    expect(folder, "フォルダから追加が載っていない").toBeGreaterThanOrEqual(0);
    expect(zip).toBeLessThan(folder);
  });

  test("案内文の入口は、すべて宣言済みのコマンドである", () => {
    const declared = new Set(
      manifest.contributes.commands.map((entry) => entry.command)
    );
    const unknown = entries()
      .map((item) => item.command)
      .filter((command) => !declared.has(command));

    expect(unknown, "案内文に書いたコマンドが宣言されていない").toEqual([]);
  });
});

/**
 * 作品一覧の上に並ぶボタン（`view/title`）。
 *
 * **作者はここから取り込みを探して、見つけられなかった**（2026-09-19、実機）。
 * 案内文（`viewsWelcome`）が出るのは作品が0件のときだけなので、1作品でも
 * 登録したあとは、ここか各メニューにしか入口が無い。
 *
 * 数が増えると、VS Code は入りきらないぶんを「…」の中へ送る。**送られても
 * 名前で探せる**ので、アイコンが並ばないことより、どこにも無いことのほうが悪い。
 */
describe("作品一覧の上のボタン", () => {
  const menus = manifest.contributes.menus as Record<
    string,
    Array<{ command: string; when?: string; group?: string }>
  >;

  function worksTitleCommands(): string[] {
    return (menus["view/title"] ?? [])
      .filter((entry) => entry.when === "view == novelai.works")
      .sort((a, b) => (a.group ?? "").localeCompare(b.group ?? ""))
      .map((entry) => entry.command);
  }

  test("バックアップからの取り込みが載っている", () => {
    expect(worksTitleCommands()).toContain("novelai.importWorkFromZip");
  });

  test("並びの番号が重なっていない（重なると順序が決まらない）", () => {
    const groups = (menus["view/title"] ?? [])
      .filter((entry) => entry.when === "view == novelai.works")
      .map((entry) => entry.group);

    expect(groups.length).toBe(new Set(groups).size);
  });
});
