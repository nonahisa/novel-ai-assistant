import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBodyFiles as measureListBodyFiles } from "../../../scripts/measureBodyFiles.mjs";
import { listEpisodes as deskListEpisodes } from "../../../desk/server.mjs";
import { resolveManuscriptDirSync } from "../../../src/core/manuscriptFolderRule";
import { listBodyFiles as mcpListBodyFiles } from "../../../src/mcp/tools/shared";

/*
  TS の外（.mjs）で本文の場所を決めている2か所が、拡張機能と同じ決め方
  （`core/manuscriptFolderRule.ts`。設計書5.1 の末尾）を通っているか。

  - `scripts/measure.mjs` の本文の並べ方（測定台）
  - `desk/server.mjs` の話の一覧（VS Code の外で動く原稿エディター）

  0.94.1 で決め方を1か所へ寄せたとき、この2つは「本文フォルダーがあれば
  そこ」の古い判定のまま残った。**空の `本文/` があり、原稿が直下にある**
  作品（git は空のフォルダーを運ばないので、登録した機械にだけ空の
  `本文/` が残る）で、どちらも0件を返していた。
*/

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 作り物の作品。`files` は作品の根からの場所と中身 */
function makeWork(files: Record<string, string>, dirs: string[] = []): string {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-msdir-"));
  made.push(root);
  for (const dir of dirs) fs.mkdirSync(nodePath.join(root, dir), { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const full = nodePath.join(root, relative);
    fs.mkdirSync(nodePath.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, "utf8");
  }
  return root;
}

/** 区切りを `/` に揃える（Windows の `\` と比べないため） */
function slashed(list: readonly string[]): string[] {
  return list.map((item) => item.replace(/\\/g, "/"));
}

describe("本文フォルダーが空で、原稿が直下にある作品", () => {
  it("測定台は直下の原稿を並べ、MCP と同じ答えを返す", () => {
    const work = makeWork({ "第1話.txt": "本文です。\n" }, ["本文", "設定"]);
    const listed = slashed(measureListBodyFiles(work, resolveManuscriptDirSync));
    expect(listed).toEqual(["第1話.txt"]);
    expect(listed).toEqual(slashed(mcpListBodyFiles(work)));
  });

  it("原稿エディターの話の一覧も直下の原稿を出す", async () => {
    const work = makeWork({ "第1話.txt": "本文です。\n" }, ["本文", "設定"]);
    expect(await deskListEpisodes(work)).toEqual(["第1話.txt"]);
  });
});

describe("これまでどおりの形（振る舞いを変えていないこと）", () => {
  it("本文フォルダーに原稿があれば、直下の原稿は見ない", async () => {
    const work = makeWork({
      "本文/第1話.txt": "本文です。\n",
      "メモ.txt": "直下のメモ\n",
    });
    const listed = slashed(measureListBodyFiles(work, resolveManuscriptDirSync));
    expect(listed).toEqual(["本文/第1話.txt"]);
    expect(listed).toEqual(slashed(mcpListBodyFiles(work)));
    expect(await deskListEpisodes(work)).toEqual(["本文/第1話.txt"]);
  });

  it("本文フォルダーが無ければ直下を見る", async () => {
    const work = makeWork({ "第1話.txt": "本文です。\n", "第2話.md": "続き\n" });
    const listed = slashed(measureListBodyFiles(work, resolveManuscriptDirSync));
    expect(listed).toEqual(["第1話.txt", "第2話.md"]);
    expect(listed).toEqual(slashed(mcpListBodyFiles(work)));
    expect(await deskListEpisodes(work)).toEqual(["第1話.txt", "第2話.md"]);
  });

  it("直下に README しか無ければ、空の本文フォルダーを選ぶ（数えない）", async () => {
    const work = makeWork({ "README.md": "説明\n" }, ["本文"]);
    const listed = slashed(measureListBodyFiles(work, resolveManuscriptDirSync));
    expect(listed).toEqual([]);
    expect(listed).toEqual(slashed(mcpListBodyFiles(work)));
    expect(await deskListEpisodes(work)).toEqual([]);
  });
});
