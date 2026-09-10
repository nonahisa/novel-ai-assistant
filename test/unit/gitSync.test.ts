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
import { isGitAvailable, runGit, type GitSyncStatus } from "../../src/core/git";
import {
  canFetch,
  describeDirtyPull,
  describeStatus,
  describeSyncBadge,
  RECORD_THEN_PULL,
} from "../../src/features/gitSync";
import { ACTION_TREE } from "../../src/views/actionList";

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
      // 生成文書の置き場（設計書6.17.7、0.26.2）。既に登録済みの作品にも
      // 次の起動で追記される
      ".aiwriter/generated/",
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

/**
 * 分かれていることと、その件数の出し方（設計書5.5.18）。
 *
 * 作者の指摘（2026-09-10）：「競合解決があるかないかわからない。件数が出ない」。
 *
 * **分かれているのと、解決が要るのは別のことである。** 分かれていても、
 * 同じ箇所が重なっていなければ同期がそのまま合わせる。だから
 * 「何件ぶつかっているか」まで出ないと、身構えるべきか分からない。
 *
 * 0.45.0 より前は `describeDivergedPull` が「取り込みは中止しました。
 * 『分かれた分を合わせる』でお試しください」と案内するだけだった。
 * **いまは同期の中で合わせにいく**ので、その知らせは無くなっている。
 */
describe("分かれているときの状態の文", () => {
  /** 分かれている置き場の、追跡できている状態 */
  const diverged = (conflicts?: {
    settings: string[];
    manuscripts: string[];
    autoWritten: string[];
  }): GitSyncStatus => ({
    kind: "tracked",
    root: "C:/書庫",
    branch: "main",
    upstream: "origin/main",
    behind: 3,
    ahead: 2,
    behindHere: 3,
    aheadHere: 2,
    dirty: 0,
    dirtyHere: 0,
    unmerged: 0,
    conflicts,
  });

  test("取り込みと送信の件数が、分かれていると分かる形で出る", () => {
    const text = describeStatus(
      diverged({ settings: [], manuscripts: [], autoWritten: [] })
    );

    expect(text).toContain("分かれています");
    expect(text).toContain("取り込み 3件");
    expect(text).toContain("送信 2件");
  });

  test("同じ箇所の衝突が無ければ、自動で合わせられると書く", () => {
    // **ここが出ないと、作者は身構えたまま同期を避ける**
    const text = describeStatus(
      diverged({ settings: [], manuscripts: [], autoWritten: ["a/.aiwriter/stats/pc.json"] })
    );

    expect(text).toContain("同じ箇所の衝突はありません");
    expect(text).toContain("同期で自動で合わせられます");
  });

  test("衝突があれば、設定資料と本文に分けて件数を出す", () => {
    const text = describeStatus(
      diverged({
        settings: ["短編/設定/characters/char_001_太志.json"],
        manuscripts: ["短編/本文/第1話.txt", "短編/本文/第2話.txt"],
        autoWritten: [],
      })
    );

    expect(text).toContain("同じ箇所の衝突 3件");
    expect(text).toContain("設定資料 1");
    expect(text).toContain("本文 2");
  });

  test("数えられなかったことは、数えられなかったと書く", () => {
    // 古いgitでは `merge-tree --write-tree` が無い。**0件と嘘をつかない**
    expect(describeStatus(diverged(undefined))).toContain(
      "同じ箇所の衝突は調べられませんでした"
    );
  });

  test("分かれていなければ、これまでどおりの書き方をする", () => {
    const behindOnly: GitSyncStatus = { ...diverged(), ahead: 0, aheadHere: 0 };

    const text = describeStatus(behindOnly);
    expect(text).toContain("未取得 3件");
    expect(text).not.toContain("分かれています");
  });
});

/** 一覧の行に出す印（設計書5.5.18） */
describe("分かれている作品の印", () => {
  const base = {
    kind: "tracked" as const,
    root: "C:/書庫",
    branch: "main",
    upstream: "origin/main",
    behind: 1,
    ahead: 1,
    behindHere: 1,
    aheadHere: 1,
    dirty: 0,
    dirtyHere: 0,
    unmerged: 0,
  };

  test("衝突が無ければ「分岐」とだけ出す", () => {
    expect(
      describeSyncBadge({
        ...base,
        conflicts: { settings: [], manuscripts: [], autoWritten: [] },
      })
    ).toContain("分岐");
  });

  test("作者が選ぶものがあれば、その件数を出す", () => {
    // **押す前に、選ぶことになると分かるようにする**
    expect(
      describeSyncBadge({
        ...base,
        conflicts: {
          settings: ["短編/設定/characters/char_001_太志.json"],
          manuscripts: ["短編/本文/第1話.txt"],
          autoWritten: [],
        },
      })
    ).toContain("分岐・要選択2");
  });
});

/**
 * 「分かれた分を合わせる」が、どこから押せるか（実機確認リスト A-17）。
 *
 * 入口は3つある——詳細メニューの「作品管理 → GitHubで作品管理」、
 * 「同期」が分岐で止まったときの知らせ、「作品をすべて同期」の報告。
 * **どれか1つでも欠けると、分岐したときの行き止まりが戻ってくる。**
 * 階層をたどって実際に押せることは実機に残る。
 */
describe("「分かれた分を合わせる」の入口", () => {
  test("詳細メニューの「GitHubで作品管理」に並ぶ（実機確認リスト A-17 の代わり）", () => {
    const group = ACTION_TREE.find((one) => one.label === "作品管理");
    const section = group?.entries.find(
      (entry) => entry.kind === "section" && entry.label.includes("GitHub")
    );
    if (!section || section.kind !== "section") {
      throw new Error("「GitHubで作品管理」の小分類がありません");
    }

    const item = section.items.find(
      (one) => one.command === "novelai.resolveDivergence"
    );
    expect(item?.label).toBe("分かれた分を合わせる");
    // 作品を選ばなくても押せる（分岐したかどうかを、こちらで調べる）
    expect(item?.requiresWork).toBe(false);
  });
});

/**
 * 単独の「取り込む」が未記録の変更で止まったとき、その場で記録して
 * 続けられること（設計書5.5.18。作者の指摘「もう少し手軽にできないですか」
 * 2026-09-10）。
 *
 * **「すべて同期」は前から記録 → 取り込み → 送信の順で動いており、
 * 単独の「取り込む」だけが行き止まりだった。** 画面は出せないので、
 * 知らせの文だけを純粋関数として確かめる。
 */
describe("未記録の変更があるときの取り込み", () => {
  test("止めた理由と、押せるボタンの名前が文に入る", () => {
    const text = describeDirtyPull("ある作品");

    expect(text).toContain("「ある作品」");
    // なぜ止めたか。**理由が無いと、作者には故障に見える**
    expect(text).toContain("書きかけの原稿を巻き込まないため");
    // ボタンの名前は文と揃える（違うと、どれを押すのか分からない）
    expect(text).toContain(RECORD_THEN_PULL);
  });

  test("記録は手元に残るだけで、外へは出ないと伝える", () => {
    // **「記録」を「送信」と読み違えると、書きかけが公開されると思って押せない**
    expect(describeDirtyPull("ある作品")).toContain("GitHubへは送りません");
  });

  test("ボタンの名前は「記録してから取り込む」", () => {
    // 文言はこの定数だけが持つ（画面と文で写しを作らない）
    expect(RECORD_THEN_PULL).toBe("記録してから取り込む");
  });
});
