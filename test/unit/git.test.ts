import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  changedFilesBetween,
  checkoutSide,
  fetchRemote,
  headCommit,
  isGitAvailable,
  parseAheadBehind,
  parseStatusPorcelain,
  isAutoWrittenLine,
  pullFastForward,
  readSyncStatus,
  runGit,
  unmergedPaths,
  type GitCommandResult,
  type GitCommandRunner,
} from "../../src/core/git";
import { parseConflicts } from "../../src/core/conflictFile";
import {
  describeStatus,
  describeSyncBadge,
  describeSyncTooltip,
  isWarning,
} from "../../src/features/gitSync";

/** 応答を並べておくだけの偽git。引数の並びで返す値を決める */
function fakeGit(
  responses: Record<string, Partial<GitCommandResult>>
): GitCommandRunner {
  return async (args) => {
    const key = args.join(" ");
    const matched =
      responses[key] ??
      Object.entries(responses).find(([prefix]) =>
        key.startsWith(prefix)
      )?.[1];
    return {
      code: matched?.code ?? 0,
      stdout: matched?.stdout ?? "",
      stderr: matched?.stderr ?? "",
    };
  };
}

const TRACKED_BASE = {
  "rev-parse --is-inside-work-tree": { stdout: "true\n" },
  "rev-parse --show-toplevel": { stdout: "/work\n" },
  remote: { stdout: "origin\n" },
  "symbolic-ref --quiet --short HEAD": { stdout: "main\n" },
  "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": {
    stdout: "origin/main\n",
  },
  "rev-list --left-right --count": { stdout: "0\t0\n" },
  "status --porcelain": { stdout: "" },
};

describe("コミット数の解析", () => {
  test("左が未取得、右が未送信になる", () => {
    // git rev-list --left-right --count <upstream>...HEAD の並び。
    // 取り違えると「取り込め」と「送れ」が逆に出る
    expect(parseAheadBehind("3\t2\n")).toEqual({ behind: 3, ahead: 2 });
  });

  test("空白区切りでも読める", () => {
    expect(parseAheadBehind("  0   5  ")).toEqual({ behind: 0, ahead: 5 });
  });

  test("想定外の出力は数として扱わない", () => {
    // 適当な数を作ると「未送信0件」と嘘をつくことになる
    expect(parseAheadBehind("fatal: bad revision")).toBeUndefined();
    expect(parseAheadBehind("")).toBeUndefined();
  });
});

describe("作業ツリーの状態の解析", () => {
  test("未追跡ファイルも変更として数える", () => {
    // 新しい話を書いてまだ追加していない状態。
    // 送信し忘れると失われるので、変更として扱う
    const result = parseStatusPorcelain("?? 本文/020.txt\n M 本文/019.txt\n");

    expect(result.dirty).toBe(2);
    expect(result.unmerged).toBe(0);
  });

  test("マージ未解決を数える", () => {
    const result = parseStatusPorcelain(
      "UU 本文/008.txt\nAA 設定/characters/char_001.json\n M 本文/009.txt\n"
    );

    expect(result.unmerged).toBe(2);
    expect(result.dirty).toBe(3);
  });

  test("片側だけがUでも未解決とする", () => {
    expect(parseStatusPorcelain("AU 本文/008.txt\n").unmerged).toBe(1);
    expect(parseStatusPorcelain("UD 本文/008.txt\n").unmerged).toBe(1);
  });

  test("CRLFと空行を数に入れない", () => {
    const result = parseStatusPorcelain(" M 本文/019.txt\r\n\r\n");

    expect(result.dirty).toBe(1);
  });

  test("変更が無ければ0件", () => {
    expect(parseStatusPorcelain("")).toEqual({ dirty: 0, unmerged: 0 });
  });
});

describe("同期状態の判定", () => {
  test("Gitリポジトリでなければ、その旨だけを返す", async () => {
    // Gitを使わずに書いている作品は異常ではない。
    // 警告として出すと、消せない表示が残り続ける
    const run = fakeGit({
      "rev-parse --is-inside-work-tree": { code: 128 },
      "--version": { stdout: "git version 2.55.0\n" },
    });

    const status = await readSyncStatus("/work", run);

    expect(status.kind).toBe("not_a_repo");
    expect(isWarning(status)).toBe(false);
  });

  test("gitコマンドが無い場合と、リポジトリでない場合を分ける", async () => {
    const run = fakeGit({
      "rev-parse --is-inside-work-tree": { code: 128 },
      "--version": { code: -1 },
    });

    expect((await readSyncStatus("/work", run)).kind).toBe("git_missing");
  });

  test("リモート未設定は警告にしない", async () => {
    const run = fakeGit({ ...TRACKED_BASE, remote: { stdout: "" } });

    const status = await readSyncStatus("/work", run);

    expect(status.kind).toBe("no_remote");
    expect(isWarning(status)).toBe(false);
  });

  test("上流の無いブランチを判別する", async () => {
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": { code: 128 },
    });

    const status = await readSyncStatus("/work", run);

    expect(status).toMatchObject({ kind: "no_upstream", branch: "main" });
  });

  test("切り離されたHEADを判別する", async () => {
    const run = fakeGit({
      ...TRACKED_BASE,
      "symbolic-ref --quiet --short HEAD": { code: 1 },
    });

    expect((await readSyncStatus("/work", run)).kind).toBe("detached");
  });

  test("未取得・未送信・競合を数える", async () => {
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-list --left-right --count": { stdout: "3\t2\n" },
      "status --porcelain": { stdout: "UU 本文/008.txt\n?? 本文/020.txt\n" },
    });

    const status = await readSyncStatus("/work", run);

    expect(status).toMatchObject({
      kind: "tracked",
      branch: "main",
      upstream: "origin/main",
      behind: 3,
      ahead: 2,
      dirty: 2,
      unmerged: 1,
    });
    expect(isWarning(status)).toBe(true);
  });

  test("同期が取れていれば警告にしない", async () => {
    const run = fakeGit(TRACKED_BASE);

    const status = await readSyncStatus("/work", run);

    expect(isWarning(status)).toBe(false);
    expect(describeSyncBadge(status)).toBeUndefined();
  });

  /**
   * 印は矢印から言葉へ変えた（2026-08-26）。
   *
   * 作者の指摘：「未同期の作品がわかりません。横に数字をだせませんか？」
   * **印は出ていたのに伝わっていなかった**（矢印だけだった）。加えて、記録して
   * いない変更は数に入っておらず、**書いたままの作品が同期済みに見えていた。**
   */
  test("何がどれだけ残っているかを、言葉と数で出す", async () => {
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-list --left-right --count": { stdout: "3\t2\n" },
    });

    expect(describeSyncBadge(await readSyncStatus("/work", run))).toBe(
      "送信待ち2・受け取り3"
    );
  });

  test("記録していない変更も数に入れる", async () => {
    // ここが入っていなかったため、**書いたままの作品に何も出ていなかった**
    const run = fakeGit({
      ...TRACKED_BASE,
      "status --porcelain": {
        stdout: " M 短編/本文/第1話.txt\n?? 短編/本文/第2話.txt\n",
      },
    });

    expect(describeSyncBadge(await readSyncStatus("/work", run))).toBe("記録待ち2");
  });

  test("書庫では、その作品ぶんだけを数える", async () => {
    // 置き場ぜんぶの数を各行に出すと、**全部の行に同じ数字が並ぶ**。
    // 実データでは11作品すべてに「送信待ち13」と出た（作者の指摘）
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-parse --show-toplevel": { stdout: "/library\n" },
      "rev-list --left-right --count origin/main...HEAD -- .": {
        stdout: "0\t2\n",
      },
      "rev-list --left-right --count": { stdout: "0\t13\n" },
      // 引数そのままの鍵にする。前方一致だと置き場ぜんぶの応答に当たる
      "status --porcelain -- .": { stdout: " M 短編/本文/第1話.txt\n" },
      "status --porcelain": {
        stdout: " M 短編/本文/第1話.txt\n M 長編/本文/第9話.txt\n",
      },
    });

    const status = await readSyncStatus("/library/短編", run);

    expect(status).toMatchObject({
      dirty: 2,
      dirtyHere: 1,
      ahead: 13,
      aheadHere: 2,
    });
    // 行に出るのは、その作品ぶんだけ
    expect(describeSyncBadge(status)).toBe("記録待ち1・送信待ち2");
  });

  test("置き場ぜんぶの数は、ホバーで断る", async () => {
    // 送信は置き場が単位で、1つ送れば同じ置き場の作品はまとめて出ていく
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-parse --show-toplevel": { stdout: "/library\n" },
      "rev-list --left-right --count origin/main...HEAD -- .": {
        stdout: "0\t2\n",
      },
      "rev-list --left-right --count": { stdout: "0\t13\n" },
    });

    const lines = describeSyncTooltip(await readSyncStatus("/library/短編", run));

    expect(lines.join("|")).toContain("送信待ち: 2件");
    expect(lines.join("|")).toContain("同じ置き場ぜんぶでは: 送信待ち 13件");
  });

  test("作品が置き場の根なら、数え直さない", async () => {
    // 一覧を描くたびに作品の数だけプロセスを起こすと、目に見えて遅くなる
    const calls: string[] = [];
    const inner = fakeGit({
      ...TRACKED_BASE,
      "rev-list --left-right --count": { stdout: "0\t3\n" },
    });
    const run: GitCommandRunner = async (args, cwd, timeout) => {
      calls.push(args.join(" "));
      return inner(args, cwd, timeout);
    };

    const status = await readSyncStatus("/work", run);

    expect(status).toMatchObject({ ahead: 3, aheadHere: 3 });
    expect(calls.filter((call) => call.startsWith("rev-list"))).toHaveLength(1);
  });

  test("作品が置き場の根なら、gitを二度呼ばない", async () => {
    // 一覧を描くたびに作品の数だけプロセスを起こすと、目に見えて遅くなる
    const calls: string[] = [];
    const inner = fakeGit({
      ...TRACKED_BASE,
      "status --porcelain": { stdout: " M 本文/第1話.txt\n" },
    });
    const run: GitCommandRunner = async (args, cwd, timeout) => {
      calls.push(args.join(" "));
      return inner(args, cwd, timeout);
    };

    const status = await readSyncStatus("/work", run);

    expect(status).toMatchObject({ dirty: 1, dirtyHere: 1 });
    expect(calls.filter((call) => call.startsWith("status"))).toHaveLength(1);
  });

  test("競合は印に出さない（作品の行に既に出ている）", () => {
    // 同じことを2度言うと、どちらが本当か分からなくなる。
    // 作品の行には、本文を読んで数えた「⚠競合 N件」が出ている
    const badge = describeSyncBadge({
      kind: "tracked",
      root: "/work",
      branch: "main",
      upstream: "origin/main",
      behind: 0,
      ahead: 0,
      dirty: 1,
      dirtyHere: 1,
      unmerged: 1,
    });

    expect(badge).toBe("記録待ち1");
  });

  test("gitから見た未解決は、ホバーで伝える", () => {
    const lines = describeSyncTooltip({
      kind: "tracked",
      root: "/work",
      branch: "main",
      upstream: "origin/main",
      behind: 0,
      ahead: 0,
      dirty: 1,
      dirtyHere: 1,
      unmerged: 2,
    });

    expect(lines.join("|")).toContain("未解決の競合が 2 件");
  });

  test("まだ一度も送っていない作品は、そう書く", async () => {
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": { code: 1 },
      "status --porcelain": { stdout: " M 本文/第1話.txt\n" },
    });

    expect(describeSyncBadge(await readSyncStatus("/work", run))).toBe(
      "記録待ち1・未送信"
    );
  });

  test("ホバーでは、それぞれが何かを説明する", async () => {
    // 言葉だけでは「記録待ち」と「送信待ち」の違いが伝わりきらない
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-list --left-right --count": { stdout: "3\t2\n" },
    });

    const lines = describeSyncTooltip(await readSyncStatus("/work", run));

    expect(lines.join("|")).toContain("送信待ち: 2件");
    expect(lines.join("|")).toContain("受け取り: 3件");
  });

  test("揃っているときは、揃っていると書く", async () => {
    const status = await readSyncStatus("/work", fakeGit(TRACKED_BASE));

    expect(describeSyncTooltip(status).join("|")).toContain("GitHubと揃っています");
  });
});

describe("取り込みの安全確認", () => {
  test("未コミットの変更があるときは取り込まない", async () => {
    // 書きかけの原稿を巻き込まないため、gitに任せず先に止める
    const executed: string[] = [];
    const base = fakeGit({
      ...TRACKED_BASE,
      "status --porcelain": { stdout: " M 本文/019.txt\n" },
    });
    const run: GitCommandRunner = async (args, cwd, timeout) => {
      executed.push(args.join(" "));
      return base(args, cwd, timeout);
    };

    const result = await pullFastForward("/work", run);

    expect(result).toEqual({ ok: false, failure: { kind: "dirty" } });
    expect(executed).not.toContain("pull --ff-only");
  });

  test("早送りできない場合は、どちらを残すか決めない", async () => {
    // 両方の環境で書いた状態。機械が解決してよい話ではない
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-list --left-right --count": { stdout: "2\t3\n" },
      "pull --ff-only": { code: 128, stderr: "fatal: Not possible to fast-forward" },
    });

    const result = await pullFastForward("/work", run);

    expect(result).toEqual({ ok: false, failure: { kind: "diverged" } });
  });

  test("マージコミットを勝手に作らせない", async () => {
    const executed: string[] = [];
    const base = fakeGit(TRACKED_BASE);
    const run: GitCommandRunner = async (args, cwd, timeout) => {
      executed.push(args.join(" "));
      return base(args, cwd, timeout);
    };

    await pullFastForward("/work", run);

    expect(executed).toContain("pull --ff-only");
    expect(executed.join("\n")).not.toContain("--no-ff");
  });
});

describe("状態の説明文", () => {
  test("リポジトリでない場合は操作を勧めない", () => {
    expect(describeStatus({ kind: "not_a_repo" })).not.toContain("取り込");
  });

  test("未取得と未送信を両方伝える", () => {
    const text = describeStatus({
      kind: "tracked",
      root: "/work",
      branch: "main",
      upstream: "origin/main",
      behind: 3,
      ahead: 2,
      dirty: 0,
      unmerged: 0,
    });

    expect(text).toContain("未取得 3件");
    expect(text).toContain("未送信 2件");
  });
});

// ─── ここから実際のgitを動かす ───
//
// 単体テストが通っても実データで動かない、というのを繰り返しているため、
// コミット数の数え方と「未コミットなら取り込まない」の2点は
// 本物のリポジトリで確かめる。

const tempRoot = path.join(os.tmpdir(), "novelai-git-test");
/**
 * `test.skipIf` はテストを集める時点で評価される。
 * `beforeAll` で判定すると間に合わず、全部スキップされたまま
 * 「通った」ように見える（実際にそうなった）。ここで先に決める。
 */
const gitReady = await isGitAvailable();
let workDir = "";
let otherDir = "";

async function git(args: string[], cwd: string): Promise<void> {
  const result = await runGit(args, cwd, 30_000);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} が失敗しました: ${result.stderr || result.stdout}`
    );
  }
}

/** コミットの作者情報。実行環境の設定に依存させない */
const IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
];

beforeAll(async () => {
  if (!gitReady) return;

  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });

  const remote = path.join(tempRoot, "remote.git");
  await git(["init", "--bare", "-b", "main", remote], tempRoot);

  workDir = path.join(tempRoot, "work");
  otherDir = path.join(tempRoot, "other");
  await git(["clone", remote, "work"], tempRoot);
  await fs.writeFile(path.join(workDir, "001.txt"), "一行目\n", "utf8");
  await git(["add", "."], workDir);
  await git([...IDENTITY, "commit", "-m", "初回"], workDir);
  await git(["push", "-u", "origin", "main"], workDir);

  await git(["clone", remote, "other"], tempRoot);
}, 60_000);

afterAll(async () => {
  if (!gitReady) return;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("実際のgitでの確認", () => {
  test.skipIf(!gitReady)("同期が取れている状態を正しく読む", async () => {
    const status = await readSyncStatus(workDir);

    expect(status).toMatchObject({
      kind: "tracked",
      branch: "main",
      behind: 0,
      ahead: 0,
      dirty: 0,
    });
  });

  test.skipIf(!gitReady)(
    "別の環境が進んだぶんを、fetch後に未取得として数える",
    async () => {
      await fs.writeFile(path.join(otherDir, "002.txt"), "二話\n", "utf8");
      await git(["add", "."], otherDir);
      await git([...IDENTITY, "commit", "-m", "別環境で第2話"], otherDir);
      await git(["push"], otherDir);

      // fetchする前は気づけない（＝これが「pullせずに書き始める」状態）
      const before = await readSyncStatus(workDir);
      expect(before).toMatchObject({ behind: 0 });

      const fetched = await fetchRemote(workDir);
      expect(fetched.ok).toBe(true);

      const after = await readSyncStatus(workDir);
      expect(after).toMatchObject({ behind: 1, ahead: 0 });
    },
    60_000
  );

  test.skipIf(!gitReady)(
    "未コミットの変更があるうちは取り込まない",
    async () => {
      const manuscript = path.join(workDir, "001.txt");
      await fs.writeFile(manuscript, "一行目\n書きかけ\n", "utf8");

      const result = await pullFastForward(workDir);

      expect(result).toEqual({ ok: false, failure: { kind: "dirty" } });
      // 書きかけがそのまま残っていること。ここが壊れると原稿が消える
      expect(await fs.readFile(manuscript, "utf8")).toBe("一行目\n書きかけ\n");
    },
    60_000
  );

  test.skipIf(!gitReady)(
    "片付ければ取り込め、未取得が解消する",
    async () => {
      await git(["checkout", "--", "001.txt"], workDir);

      const result = await pullFastForward(workDir);
      expect(result.ok).toBe(true);

      const status = await readSyncStatus(workDir);
      expect(status).toMatchObject({ behind: 0, ahead: 0 });
      // 取り込んだ内容が実際に届いている。
      // 改行は比較から外す：Windowsの `core.autocrlf` が既定で有効だと、
      // gitがチェックアウト時にLFをCRLFへ書き換えるため、
      // ここで固定すると環境によって落ちるテストになる
      const delivered = await fs.readFile(
        path.join(workDir, "002.txt"),
        "utf8"
      );
      expect(delivered.replace(/\r\n/g, "\n")).toBe("二話\n");
    },
    60_000
  );

  test.skipIf(!gitReady)(
    "この環境のコミットを未送信として数える",
    async () => {
      await fs.writeFile(path.join(workDir, "003.txt"), "三話\n", "utf8");
      await git(["add", "."], workDir);
      await git([...IDENTITY, "commit", "-m", "第3話"], workDir);

      expect(await readSyncStatus(workDir)).toMatchObject({
        ahead: 1,
        behind: 0,
      });
    },
    60_000
  );

  test.skipIf(!gitReady)(
    "変わったファイルをgitに聞く（日本語のパスでも）",
    async () => {
      const before = await headCommit(workDir);
      await fs.mkdir(path.join(workDir, "本文"), { recursive: true });
      await fs.writeFile(
        path.join(workDir, "本文", "004 再会.txt"),
        "四話\n",
        "utf8"
      );
      await git(["add", "."], workDir);
      await git([...IDENTITY, "commit", "-m", "第4話"], workDir);
      const after = await headCommit(workDir);

      const changed = await changedFilesBetween(workDir, before!, after!);

      // NUL区切りで受け取るので、日本語や空白を含むパスが
      // 引用符付きで返ってくることがない
      expect(changed).toEqual(["本文/004 再会.txt"]);
    },
    60_000
  );
});

// ─── 本物のマージ競合を作って、解決まで通す ───

describe("実際の競合の解決", () => {
  const conflictRoot = path.join(tempRoot, "conflict");

  test.skipIf(!gitReady)(
    "競合したファイルを検出し、選んだ版で確定できる",
    async () => {
      const remote = path.join(conflictRoot, "remote.git");
      const a = path.join(conflictRoot, "a");
      const b = path.join(conflictRoot, "b");
      await fs.mkdir(conflictRoot, { recursive: true });
      await git(["init", "--bare", "-b", "main", remote], conflictRoot);
      await git(["clone", remote, "a"], conflictRoot);

      await fs.writeFile(path.join(a, "008.txt"), "　もとの文。\n", "utf8");
      await git(["add", "."], a);
      await git([...IDENTITY, "commit", "-m", "初回"], a);
      await git(["push", "-u", "origin", "main"], a);
      await git(["clone", remote, "b"], conflictRoot);

      // 同じ話を2つの環境で別々に書いてしまった状態を作る
      await fs.writeFile(
        path.join(b, "008.txt"),
        "　灯はゆっくりと歩き出した。\n",
        "utf8"
      );
      await git(["add", "."], b);
      await git([...IDENTITY, "commit", "-m", "別環境で加筆"], b);
      await git(["push"], b);

      await fs.writeFile(
        path.join(a, "008.txt"),
        "　灯は歩き出した。\n",
        "utf8"
      );
      await git(["add", "."], a);
      await git([...IDENTITY, "commit", "-m", "この環境で加筆"], a);

      // 早送りできないので、こちらのpullは断る
      await fetchRemote(a);
      const refused = await pullFastForward(a);
      expect(refused).toEqual({ ok: false, failure: { kind: "diverged" } });

      // 作者が別のGitクライアントでmergeした結果を再現する
      const merge = await runGit([...IDENTITY, "merge", "origin/main"], a, 30_000);
      expect(merge.code).not.toBe(0);

      // gitが未解決として挙げてくる
      expect(await unmergedPaths(a)).toEqual(["008.txt"]);

      // 作業ツリーには競合マーカーが入っている
      const conflicted = await fs.readFile(path.join(a, "008.txt"), "utf8");
      const parsed = parseConflicts(conflicted.replace(/\r\n/g, "\n"));
      expect(parsed.hunks).toHaveLength(1);
      expect(parsed.hunks[0].ours).toEqual(["　灯は歩き出した。"]);
      expect(parsed.hunks[0].theirs).toEqual(["　灯はゆっくりと歩き出した。"]);

      // 「別環境のものを採用」をgitに書き戻させる
      const applied = await checkoutSide(a, "008.txt", "theirs");
      expect(applied.ok).toBe(true);

      const resolved = await fs.readFile(path.join(a, "008.txt"), "utf8");
      expect(resolved.replace(/\r\n/g, "\n")).toBe(
        "　灯はゆっくりと歩き出した。\n"
      );
      expect(await unmergedPaths(a)).toEqual([]);
    },
    120_000
  );
});

/**
 * 同期しても常に1件残っていた（作者の指摘、2026-08-24。設計書5.5.13）。
 *
 * 「GitHubと同期しても常に1件同期が残る」——正体は**執筆量の記録**
 * （`.aiwriter/stats/<端末>.json`）。保存のたびに拡張機能が書き換えるので、
 * 記録して送信した直後からまた「1件の変更」に戻っていた。
 */
describe("自動で書き換わるものは数えない", () => {
  test("執筆量の記録だけなら、変更は0件", () => {
    const status = parseStatusPorcelain(
      ' M "いじめられっ子/.aiwriter/stats/gamingpc-16cd.json"'
    );
    expect(status.dirty).toBe(0);
  });

  test("原稿の変更は、これまでどおり数える", () => {
    const status = parseStatusPorcelain(
      [
        ' M "作品/本文/001.txt"',
        ' M "作品/.aiwriter/stats/pc-1.json"',
        "?? 作品/本文/002.txt",
      ].join("\n")
    );
    expect(status.dirty).toBe(2);
  });

  /** 競合は見逃せない。自動で書かれるものでも数える */
  test("執筆量の記録が競合していたら数える", () => {
    const status = parseStatusPorcelain(
      "UU 作品/.aiwriter/stats/pc-1.json"
    );
    expect(status.dirty).toBe(1);
    expect(status.unmerged).toBe(1);
  });

  /** Windowsのgitが円記号で返した場合 */
  test("区切りが逆向きでも見分ける", () => {
    expect(
      isAutoWrittenLine(String.raw` M 作品\.aiwriter\stats\pc-1.json`)
    ).toBe(true);
  });

  test("似た名前のフォルダーは巻き込まない", () => {
    expect(isAutoWrittenLine(" M 作品/.aiwriter/statsmemo.txt")).toBe(false);
    expect(isAutoWrittenLine(" M 作品/本文/stats.txt")).toBe(false);
  });
});
