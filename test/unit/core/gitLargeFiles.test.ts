import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  GITHUB_FILE_LIMIT_BYTES,
  describeTooLargeToRecord,
  findLargeFilesToRecord,
  ignoreRuleFor,
  listLargeFiles,
  parseLsTreeSizes,
  parseRecordableEntries,
} from "../../../src/core/gitLargeFiles";
import { isGitAvailable, runGit } from "../../../src/core/git";
import { setFileReaderForTests, vscodeFileReaderForTests } from "../../../src/core/fileRead";

/**
 * GitHub に送れない大きさのファイルを、記録の前に見つける（設計書5.5.21）。
 */

describe("記録で入る道の読み方", () => {
  test("消したもの・改名の元は入らず、未追跡には印が付く", () => {
    const stdout = [
      " M 作品/本文/001.txt",
      "?? 素材/big.zip",
      " D 消した.txt",
      "R  新しい名前.txt",
      "古い名前.txt",
      "A  足した.txt",
    ].join("\u0000");
    expect(parseRecordableEntries(`${stdout}\u0000`)).toEqual([
      { path: "作品/本文/001.txt", untracked: false },
      { path: "素材/big.zip", untracked: true },
      { path: "新しい名前.txt", untracked: false },
      { path: "足した.txt", untracked: false },
    ]);
  });

  test("ls-tree の大きさを読む（下位のリポジトリの - は落とす）", () => {
    const stdout = [
      "100644 blob 1111111111111111111111111111111111111111  757071872\t素材/big.zip",
      "160000 commit 2222222222222222222222222222222222222222       -\tsub",
    ].join("\u0000");
    expect(parseLsTreeSizes(stdout)).toEqual([{ path: "素材/big.zip", size: 757071872 }]);
  });
});

describe("知らせの文", () => {
  test("多ければ最初の3件と「ほかN件」", () => {
    const files = [1, 2, 3, 4, 5].map((n) => ({
      path: `素材/${n}.zip`,
      size: 722 * 1024 * 1024,
      untracked: true,
    }));
    const text = listLargeFiles(files);
    expect(text).toContain("・素材/1.zip（722.0MB）");
    expect(text).toContain("・素材/3.zip");
    expect(text).not.toContain("素材/4.zip");
    expect(text).toContain("ほか2件");
    expect(describeTooLargeToRecord(files)).toContain("記録も送信もしませんでした");
  });
});

// ─── 本物の git で、.gitignore の1行がそのファイルだけに当たるか確かめる ───

const gitReady = await isGitAvailable();
const tempRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), "syncB_gitLargeFiles-"));

beforeAll(async () => {
  if (!gitReady) return;
  await runGit(["init", "-b", "main"], tempRoot, 30_000);
}, 60_000);

afterAll(async () => {
  setFileReaderForTests(vscodeFileReaderForTests());
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("本物の git での確認", () => {
  test.skipIf(!gitReady)(
    "記号や空白を含む名前でも、足した行はそのファイルだけを外す",
    async () => {
      // `*`・`?` は Windows の名前に使えないので、角かっこ・空白・先頭の記号で見る
      const names = ["素材/大きい [版].zip", "#先頭.zip", "!感嘆.zip"];
      for (const name of names) {
        await fs.mkdir(nodePath.join(tempRoot, nodePath.dirname(name)), { recursive: true });
        await fs.writeFile(nodePath.join(tempRoot, name), "x");
      }
      // 型として読まれたら巻き込まれるファイル（`[版]` が「版」の1字に当たる）
      await fs.writeFile(nodePath.join(tempRoot, "素材", "大きい 版.zip"), "x");
      await fs.writeFile(
        nodePath.join(tempRoot, ".gitignore"),
        `${names.map(ignoreRuleFor).join("\n")}\n`
      );
      for (const name of names) {
        const checked = await runGit(["check-ignore", "-q", "--", name], tempRoot, 30_000);
        expect(checked.code, name).toBe(0);
      }
      for (const name of ["素材/大きい 版.zip"]) {
        const checked = await runGit(["check-ignore", "-q", "--", name], tempRoot, 30_000);
        expect(checked.code, name).toBe(1);
      }
    },
    60_000
  );

  test.skipIf(!gitReady)(
    "上限を超える未追跡のファイルを見つける（中身は書かずに大きさだけ）",
    async () => {
      const big = nodePath.join(tempRoot, "動画", "big.zip");
      await fs.mkdir(nodePath.dirname(big), { recursive: true });
      const handle = await fs.open(big, "w");
      await handle.truncate(GITHUB_FILE_LIMIT_BYTES + 1);
      await handle.close();
      await fs.writeFile(nodePath.join(tempRoot, "動画", "small.txt"), "x");

      // 大きさは本物のディスクで測る（試験の既定の読み口は VS Code の代役。`support/setup.ts` が
      // 試験ごとに差し込む）
      setFileReaderForTests(undefined);
      const found = await findLargeFilesToRecord(nodePath.join(tempRoot, "動画"), runGit);
      expect(found.files).toEqual([
        { path: "動画/big.zip", size: GITHUB_FILE_LIMIT_BYTES + 1, untracked: true },
      ]);
      await fs.rm(big, { force: true });
    },
    60_000
  );
});
