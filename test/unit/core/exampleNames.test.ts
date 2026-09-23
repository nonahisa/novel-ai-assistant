import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  EXAMPLE_OTHER,
  EXAMPLE_PERSON,
  EXAMPLE_REPO,
  EXAMPLE_SUMMARY,
} from "../../../src/core/exampleNames";

/**
 * **例に出す人物は、架空の作品の人物である**（作者の指定、2026-09-13
 * 「メニューのチップ説明等にでる登場人物名は、架空作品の登場人物名にしてください」）。
 *
 * 開発では作者の作品を実データとして使っているので、その人物名が
 * 説明文や入力欄の例、プロンプトの例にそのまま残りやすい。3つ困る。
 *
 * 1. **配る先は作者だけではない。** ほかの人の画面に、見覚えのない
 *    誰かの名前が例として出る
 * 2. **AIが例に引きずられる。** プロンプトに実在の人物名があると、
 *    その名前が答えに混ざって返ってくる（CLAUDE.md の失敗3番）
 * 3. **作品の中身が、製品の一部として配られてしまう**
 *
 * ## コメントは見ない
 *
 * 「実データで `char_006_文佳` の別名に別人が入った」のような**記録**は、
 * なぜその判定があるのかを説明する値打ちのある文章であり、画面にもAIにも
 * 届かない。**過去の記録を消して回らない**（CLAUDE.md の失敗7番）。
 *
 * 見るのは**コメントでない行**——つまり画面に出るか、AIへ届く文字列である。
 */

/** 実データに出てくる、作者の作品の人物名と作品名 */
const REAL_NAMES = [
  "密倉",
  "文佳",
  "フミカ",
  "三門",
  "太志",
  "マイナ先生",
  "アジャーノ",
  "アジャン",
  "ハイエルフ未亡人",
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** コメントの行か（`//`・`*`・`/*` で始まる） */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

interface Hit {
  where: string;
  name: string;
  line: string;
}

function scan(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const rel = file.slice(file.indexOf(`src${sep}`)).split(sep).join("/");
    // 例の置き場そのものは対象外（ここは架空の名前しか持たない）
    if (rel === "src/core/exampleNames.ts") continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (isComment(line)) return;
        for (const name of REAL_NAMES) {
          if (line.includes(name)) {
            hits.push({ where: `${rel}:${index + 1}`, name, line: line.trim() });
          }
        }
      });
  }
  return hits;
}

describe("例に出す人物", () => {
  const SRC = resolve(__dirname, "../../../src");

  test("走査する対象がある（拾い方を間違えて0件を通さない）", () => {
    expect(sources(SRC).length).toBeGreaterThan(100);
  });

  test("**画面とプロンプトに、実在の作品の人物名が無い**", () => {
    const hits = scan(sources(SRC));
    expect(
      hits.map((hit) => `${hit.where}「${hit.name}」 ${hit.line.slice(0, 80)}`),
      "架空の人物（src/core/exampleNames.ts）に差し替えてください"
    ).toEqual([]);
  });

  test("`package.json` と `README.md` にも無い", () => {
    for (const file of ["package.json", "README.md"]) {
      const text = readFileSync(resolve(__dirname, "../../..", file), "utf8");
      for (const name of REAL_NAMES) {
        expect(text.includes(name), `${file} に「${name}」`).toBe(false);
      }
    }
  });
});

/**
 * **例の人物は、呼び名の話の見本として使える形になっていること。**
 *
 * 抽出のプロンプト（P-04a）は「姓名・名だけ・敬称つきを1人にまとめる」
 * ことを例で示す。3通りが揃っていないと、例が例にならない。
 */
/**
 * **作者のアカウントと書庫の名前も、例に出さない**（作者の裁定、2026-09-13）。
 *
 * 人物名と事情は同じである——ほかの人の入力欄に、知らない誰かの
 * アカウント名が例として出る。
 *
 * **`package.json` の publisher と repository は別**である。あれは例ではなく、
 * この拡張機能そのものの出どころで、無いと配れない。
 */
describe("GitHubの入力例", () => {
  test("**画面に、作者のアカウントと書庫の名前が出ない**", () => {
    const hits: string[] = [];
    for (const file of sources(resolve(__dirname, "../../../src"))) {
      const rel = file.slice(file.indexOf(`src${sep}`)).split(sep).join("/");
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (isComment(line)) return;
          if (line.includes("HisasNovels")) hits.push(`${rel}:${index + 1}`);
        });
    }
    expect(hits, "EXAMPLE_REPO を使ってください").toEqual([]);
  });

  test("例は「ここへ自分のものを書く」と読める形になっている", () => {
    // 実在しそうな名前だと、そのまま入れてしまう人が出る
    expect(EXAMPLE_REPO.split("/")).toHaveLength(2);
    expect(EXAMPLE_REPO).toMatch(/your|my|example|sample/);
  });

  test("使うところは、取り込んで使っている", () => {
    for (const file of [
      "src/core/githubRepoRef.ts",
      "src/features/addWorkFromGithubWeb.ts",
    ]) {
      const text = readFileSync(resolve(__dirname, "../../..", file), "utf8");
      expect(text, file).toContain("EXAMPLE_REPO");
    }
  });
});

describe("架空の人物の作り", () => {
  test("姓名・名だけ・敬称つきの3通りがある", () => {
    for (const person of [EXAMPLE_PERSON, EXAMPLE_OTHER]) {
      expect(person.fullName.length).toBeGreaterThan(person.givenName.length);
      expect(person.fullName).toContain(person.givenName);
      expect(person.familiar).not.toBe(person.fullName);
      expect(person.familiar).not.toBe(person.givenName);
    }
  });

  test("2人が別人だと分かる（入れ替わり・憑依の例に要る）", () => {
    expect(EXAMPLE_PERSON.fullName).not.toBe(EXAMPLE_OTHER.fullName);
    expect(EXAMPLE_PERSON.givenName).not.toBe(EXAMPLE_OTHER.givenName);
  });

  test("紹介文の例が、字数の上限に収まっている", () => {
    // 一覧で名前の下に並ぶ短い説明。例が上限を超えていると、
    // 「上限であって目安ではない」という指示と食い違う
    expect(EXAMPLE_SUMMARY.length).toBeLessThanOrEqual(60);
  });
});

/**
 * **例の人物は1か所にしか無い**（写しを作らない）。
 *
 * 画面とプロンプトで例の人物が違うと、読む人には別々の話に見える。
 */
describe("例の置き場", () => {
  test("使うところは、取り込んで使っている（名前を直に書かない）", () => {
    const users = [
      "src/features/chronicleEdit.ts",
      "src/prompts/characterExtract.ts",
      "src/prompts/workChat.ts",
    ];
    for (const file of users) {
      const text = readFileSync(resolve(__dirname, "../../..", file), "utf8");
      expect(text, file).toContain('from "../core/exampleNames"');
      expect(text, file).toContain("EXAMPLE_PERSON");
    }
  });

  test("架空の名前そのものを、ほかのファイルへ写していない", () => {
    const hits: string[] = [];
    for (const file of sources(resolve(__dirname, "../../../src"))) {
      const rel = file.slice(file.indexOf(`src${sep}`)).split(sep).join("/");
      if (rel === "src/core/exampleNames.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const name of [EXAMPLE_PERSON.fullName, EXAMPLE_OTHER.fullName]) {
        if (text.includes(name)) hits.push(`${rel}「${name}」`);
      }
    }
    expect(hits, "取り込んで使ってください").toEqual([]);
  });
});
