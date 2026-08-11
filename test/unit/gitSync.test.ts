import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CACHE_IGNORE_RULE,
  CACHE_UNIGNORE_RULE,
  IGNORED_PATHS,
  lastCacheDirective,
  missingIgnoreRules,
} from "../../src/core/workRegistry";
import { isGitAvailable, runGit } from "../../src/core/git";
import { canFetch } from "../../src/features/gitSync";

const encode = (text: string) => new TextEncoder().encode(text);

describe("取りに行ける作品かの判定", () => {
  test("Gitを使っていない作品では取りに行かない", () => {
    // 起動のたびに「fatal: not a git repository」が失敗として記録され、
    // 進み具合を見るために開いたログに、直しようのない失敗が混ざっていた
    expect(canFetch({ kind: "not_a_repo" })).toBe(false);
    expect(canFetch({ kind: "git_missing" })).toBe(false);
  });

  test("リモートが無い作品でも取りに行かない", () => {
    // ローカルだけで履歴を取っている作品。fetchは必ず失敗する
    expect(canFetch({ kind: "no_remote", root: "/work" })).toBe(false);
  });

  test("上流が未設定でも、リモートがあるなら取りに行く", () => {
    // push -u がまだなだけで、別の環境の分は取得できる
    expect(
      canFetch({ kind: "no_upstream", root: "/work", branch: "main" })
    ).toBe(true);
  });

  test("追跡できている作品では取りに行く", () => {
    expect(
      canFetch({
        kind: "tracked",
        root: "/work",
        branch: "main",
        upstream: "origin/main",
        behind: 0,
        ahead: 0,
        dirty: 0,
        unmerged: 0,
      })
    ).toBe(true);
  });
});

describe("同期対象から外す規則", () => {
  test("キャッシュを必ず除外する", () => {
    // 設計書5.5.7。以前は登録した作品で漏れており、
    // キャッシュがGitに入ったままだった
    expect(IGNORED_PATHS).toContain(".aiwriter/cache/");
  });

  test("設定資料と承認待ちは除外しない", () => {
    // 別の環境でも読みたい・承認したいので同期する
    expect(IGNORED_PATHS).not.toContain(".aiwriter/pending-characters/");
    expect(IGNORED_PATHS.join("\n")).not.toContain("設定/");
  });

  test("空の.gitignoreには全部足りない", () => {
    expect(missingIgnoreRules(encode(""))).toEqual([...IGNORED_PATHS]);
  });

  test("既にある規則は重ねて足さない", () => {
    const existing = encode(".novelai-recovery/\n.aiwriter/cache/\n");

    expect(missingIgnoreRules(existing)).toEqual([
      ".aiwriter/logs/",
      ".aiwriter/exports/",
      "exports/",
    ]);
  });

  test("全部そろっていれば追記しない", () => {
    const existing = encode(IGNORED_PATHS.join("\n"));

    expect(missingIgnoreRules(existing)).toEqual([]);
  });

  test("CRLFでも前後の空白があっても認識する", () => {
    const existing = encode("  .aiwriter/cache/  \r\n.novelai-recovery/\r\n");

    expect(missingIgnoreRules(existing)).not.toContain(".aiwriter/cache/");
    expect(missingIgnoreRules(existing)).not.toContain(".novelai-recovery/");
  });

  test("作者が書いた行は判定に影響しない", () => {
    const existing = encode("# 作者のメモ\n*.bak\n下書き/\n");

    expect(missingIgnoreRules(existing)).toEqual([...IGNORED_PATHS]);
  });
});

describe("キャッシュを同期するオプション（設計書5.5.7）", () => {
  test("同期しない設定では、これまでどおり除外する", () => {
    expect(missingIgnoreRules(encode(""), { syncCache: false })).toContain(
      CACHE_IGNORE_RULE
    );
  });

  test("同期する設定では、新しい.gitignoreにキャッシュの除外を書かない", () => {
    const rules = missingIgnoreRules(encode(""), { syncCache: true });

    expect(rules).not.toContain(CACHE_IGNORE_RULE);
    expect(rules).not.toContain(CACHE_UNIGNORE_RULE);
    // 他の規則は今までどおり足す
    expect(rules).toContain(".novelai-recovery/");
  });

  test("既に除外済みなら、打ち消す行を足す", () => {
    // .gitignoreは追記しかできない（作者の記述をバイト単位で保つため）。
    // 後に書いた規則が勝つ性質を使って切り替える
    const existing = encode(`${IGNORED_PATHS.join("\n")}\n`);

    expect(missingIgnoreRules(existing, { syncCache: true })).toEqual([
      CACHE_UNIGNORE_RULE,
    ]);
  });

  test("同期をやめたら、もう一度除外する行を足す", () => {
    const existing = encode(
      `${CACHE_IGNORE_RULE}\n${CACHE_UNIGNORE_RULE}\n${IGNORED_PATHS.slice(1).join("\n")}\n`
    );

    expect(missingIgnoreRules(existing, { syncCache: false })).toEqual([
      CACHE_IGNORE_RULE,
    ]);
  });

  test("切り替え済みなら重ねて足さない", () => {
    const existing = encode(
      `${CACHE_IGNORE_RULE}\n${CACHE_UNIGNORE_RULE}\n${IGNORED_PATHS.slice(1).join("\n")}\n`
    );

    expect(missingIgnoreRules(existing, { syncCache: true })).toEqual([]);
  });

  test("判断に使うのは最後の1行だけ", () => {
    const flipped = encode(
      `${CACHE_IGNORE_RULE}\n${CACHE_UNIGNORE_RULE}\n${CACHE_IGNORE_RULE}\n`
    );

    expect(lastCacheDirective(flipped)).toBe(CACHE_IGNORE_RULE);
    expect(lastCacheDirective(encode("何も書いていない\n"))).toBeUndefined();
  });
});

// ─── 実際のgitで、切り替えが本当に効くか確かめる ───
//
// gitignoreの「後勝ち」と、除外したディレクトリの中を再び含める挙動は
// 思い込みで書くと外しやすい。gitに直接聞いて固定する。

const tempRoot = path.join(os.tmpdir(), "novelai-gitignore-test");
const gitReady = await isGitAvailable();

beforeAll(async () => {
  if (!gitReady) return;
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(tempRoot, ".aiwriter", "cache"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(tempRoot, ".aiwriter", "cache", "chunks.json"),
    "[]",
    "utf8"
  );
  await runGit(["init", "-b", "main"], tempRoot, 30_000);
}, 60_000);

afterAll(async () => {
  if (!gitReady) return;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/** gitがそのパスを除外しているか、git自身に聞く */
async function isIgnoredByGit(relativePath: string): Promise<boolean> {
  const result = await runGit(
    ["check-ignore", "-q", "--", relativePath],
    tempRoot,
    30_000
  );
  // 終了コード0＝除外されている、1＝されていない
  return result.code === 0;
}

describe("実際のgitでの確認（キャッシュの同期切り替え）", () => {
  test.skipIf(!gitReady)(
    "除外・打ち消し・再除外が、書いた順のとおりに効く",
    async () => {
      const gitignore = path.join(tempRoot, ".gitignore");
      const target = ".aiwriter/cache/chunks.json";

      // 1. 既定（同期しない）
      await fs.writeFile(
        gitignore,
        `${missingIgnoreRules(new Uint8Array(), { syncCache: false }).join("\n")}\n`,
        "utf8"
      );
      expect(await isIgnoredByGit(target)).toBe(true);

      // 2. 同期する設定へ切り替え、打ち消す行を追記する
      const afterFirst = await fs.readFile(gitignore);
      const toSync = missingIgnoreRules(afterFirst, { syncCache: true });
      expect(toSync).toEqual([CACHE_UNIGNORE_RULE]);
      await fs.appendFile(gitignore, `${toSync.join("\n")}\n`, "utf8");

      // 除外ディレクトリの中を再び含められるか、というのが要点
      expect(await isIgnoredByGit(target)).toBe(false);

      // 3. 同期をやめる
      const afterSecond = await fs.readFile(gitignore);
      const toStop = missingIgnoreRules(afterSecond, { syncCache: false });
      expect(toStop).toEqual([CACHE_IGNORE_RULE]);
      await fs.appendFile(gitignore, `${toStop.join("\n")}\n`, "utf8");

      expect(await isIgnoredByGit(target)).toBe(true);
    },
    60_000
  );

  test.skipIf(!gitReady)(
    "打ち消しても、他の除外は効いたままにする",
    async () => {
      const gitignore = path.join(tempRoot, ".gitignore");
      await fs.writeFile(
        gitignore,
        `${IGNORED_PATHS.join("\n")}\n${CACHE_UNIGNORE_RULE}\n`,
        "utf8"
      );
      await fs.mkdir(path.join(tempRoot, ".aiwriter", "logs"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(tempRoot, ".aiwriter", "logs", "a.log"),
        "",
        "utf8"
      );

      expect(await isIgnoredByGit(".aiwriter/cache/chunks.json")).toBe(false);
      expect(await isIgnoredByGit(".aiwriter/logs/a.log")).toBe(true);
    },
    60_000
  );
});
