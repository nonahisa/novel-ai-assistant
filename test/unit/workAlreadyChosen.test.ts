import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 作品が決まっているのに、選び直させない（作者の報告、2026-08-30）。
 *
 * 作者の報告：「GitHubと同期した後、変動があった作品に対して資料更新を
 * 促すポップアップがあります。そこから資料を更新しようとしたら、更新する
 * 作品を聞かれます。変動した作品に対するポップアップなので、重複している
 * と思います」。
 *
 * そのとおりだった。知らせの文面は
 *
 *     「〈作品名〉で 12 件のファイルが更新されました。」
 *
 * と名指ししているのに、押した先は `executeCommand("novelai.extractSettings")`
 * ——**引数が無い**。作品を引数で受け取るコマンドは、無ければ
 * `resolveWork` で選択画面を出すので、**いま名指しした作品をもう一度
 * 選ばせる**ことになる。
 *
 * ## なぜ検査で守るか
 *
 * この形は目で見つけにくい。呼ぶ側と受ける側が別のファイルにあり、
 * **どちらも単体では正しく見える**（呼ぶ側は1行、受ける側は「引数が
 * 無ければ訊く」という妥当な作り）。同じ書き落としが同時に5か所あった。
 *
 * ## 何を見ているか
 *
 * 1. `extension.ts` から「作品を引数に取るコマンド」を集める
 * 2. `src/` 全体から、そのコマンドを**引数無しで**呼んでいる場所を探す
 *
 * 引数無しの呼び出しが**常に**誤りなのではない（作品が分からない場所からも
 * 呼べる）。だが、そういう場所は下の `WITHOUT_WORK` に理由付きで挙げる。
 * **挙げずに増やせない**ようにして、次に足す人へ判断を促す。
 */

const ROOT = path.resolve(__dirname, "../..");

function readSource(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, directory), {
    withFileTypes: true,
  })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...sourceFiles(relative));
    } else if (entry.name.endsWith(".ts")) {
      found.push(relative);
    }
  }
  return found;
}

/**
 * 作品を引数に取るコマンド。
 *
 * `registerCommand("novelai.x", async (node?: WorkNode) => {` の形を拾う。
 * 名前を手で並べると、コマンドが増えたときに**この一覧だけが古くなる**
 */
function commandsTakingWork(): Set<string> {
  const source = readSource("src/extension.ts");
  const found = new Set<string>();
  const pattern =
    /"(novelai\.[A-Za-z]+)",\s*\n?\s*async \(node\?: [A-Za-z |]*WorkNode[A-Za-z |]*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    found.add(match[1]);
  }
  return found;
}

/**
 * 作品が分からない場所からの呼び出し。**理由を書いて挙げる。**
 *
 * ここに挙がっているものは、呼ぶ側に作品が無いので選択画面が正しい。
 */
const WITHOUT_WORK: Array<{ file: string; command: string; why: string }> = [
  {
    file: "src/features/setupVectorSearch.ts",
    command: "novelai.buildVectorIndex",
    why:
      "意味検索の準備は作品によらない設定なので、`setupVectorSearch()` は" +
      "作品を持たない。索引を作る作品は、ここで初めて選ぶ",
  },
];

describe("作品が決まっているなら、選び直させない", () => {
  test("作品を引数に取るコマンドを、extension.ts から拾えている", () => {
    // 拾えていなければ、以下の検査は何も見ていないことになる
    const commands = commandsTakingWork();

    expect(commands.size).toBeGreaterThan(30);
    expect(commands).toContain("novelai.extractSettings");
    expect(commands).toContain("novelai.gitPush");
  });

  test("引数無しの呼び出しは、理由を書いたものだけ", () => {
    const commands = commandsTakingWork();
    const allowed = new Set(
      WITHOUT_WORK.map((entry) => `${entry.file}:${entry.command}`)
    );
    const offenders: string[] = [];

    for (const file of sourceFiles("src")) {
      if (file === "src/extension.ts") continue;
      const source = readSource(file);
      // 第2引数が無い呼び出しだけを拾う（`", {` が続けば渡している）
      const pattern = /executeCommand\("(novelai\.[A-Za-z]+)"\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        const command = match[1];
        if (!commands.has(command)) continue;
        if (allowed.has(`${file}:${command}`)) continue;
        offenders.push(`${file}: ${command}`);
      }
    }

    expect(
      offenders,
      "作品を引数に取るコマンドを引数無しで呼んでいます。" +
        "呼ぶ側に作品があるなら { type: 'work', work } を渡してください" +
        "（作品が無い場所からの呼び出しなら WITHOUT_WORK へ理由を書いて足す）"
    ).toEqual([]);
  });

  test("理由を書いた一覧が、実在の呼び出しを指している", () => {
    // 直したあとも一覧に残っていると、次の書き落としを見逃す
    for (const entry of WITHOUT_WORK) {
      const source = readSource(entry.file);

      expect(
        source.includes(`executeCommand("${entry.command}")`),
        `${entry.file} に ${entry.command} の引数無しの呼び出しが無い`
      ).toBe(true);
    }
  });
});
