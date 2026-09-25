import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  KEEP_LAUNCH_MARK,
  PROCESS_MIN_AGE_MS,
  WORKTREE_MIN_AGE_MS,
  judgeLaunchConfigs,
  judgeProcesses,
  judgeWorktreeFolders,
  lockPidOf,
  markerOf,
  parseWorktreeList,
  removeLinkOnly,
  removeTreeSafely,
  summarize,
} from "../../../scripts/cleanup.mjs";

/*
  起動時の自動片づけ（`scripts/cleanup.mjs`。作者の依頼、2026-09-25）。

  **消しすぎは取り返しがつかない**ので、「残す」側の条件を1つずつ確かめる。
  本物の作業場は消さない——この試験自体が作業場の中で書かれた。消す部分は
  一時フォルダーに作った作り物で確かめる。

  いちばん大事なのは「連結（ジャンクション）をたどらない」こと。
  2026-09-24 に、作業場の node_modules が本体への連結になっていて、
  消したら本体の node_modules/.bin が空になった。
*/

const HOUR = 60 * 60 * 1000;
const ROOT = "C:\\repo";
const WT = `${ROOT}\\.claude\\worktrees`;

function folder(name: string, extra: Partial<{ isDirectory: boolean; isLink: boolean; ageMs: number }> = {}) {
  return {
    name,
    path: `${WT}\\${name}`,
    isDirectory: true,
    isLink: false,
    ageMs: 2 * HOUR,
    ...extra,
  };
}

function judge(
  folders: ReturnType<typeof folder>[],
  options: {
    listed?: ReturnType<typeof parseWorktreeList>;
    branches?: string[];
    alive?: number[];
    protectedPaths?: string[];
  } = {}
) {
  return judgeWorktreeFolders({
    folders,
    listed: options.listed ?? [{ path: "C:/repo", branch: "main", locked: false, lockReason: "" }],
    branches: new Set(options.branches ?? ["main"]),
    isPidAlive: (pid: number) => (options.alive ?? []).includes(pid),
    protectedPaths: options.protectedPaths ?? [ROOT],
    platform: "win32",
  });
}

describe("git worktree list の読み取り", () => {
  it("枝・切り離し・ロックの理由を読む", () => {
    const listed = parseWorktreeList(
      [
        "worktree C:/repo",
        "HEAD 1111",
        "branch refs/heads/main",
        "",
        "worktree C:/repo/.claude/worktrees/agent-a1",
        "HEAD 2222",
        "branch refs/heads/worktree-agent-a1",
        "locked claude agent agent-a1 (pid 7188)",
        "",
        "worktree C:/repo/.claude/worktrees/gifted-colden-7b1fc2",
        "HEAD 3333",
        "detached",
        "",
      ].join("\r\n")
    );
    expect(listed).toHaveLength(3);
    expect(listed[1]).toMatchObject({ branch: "worktree-agent-a1", locked: true });
    expect(lockPidOf(listed[1].lockReason)).toBe(7188);
    expect(listed[2]).toMatchObject({ branch: null, locked: false });
  });
});

describe("作業場の判定", () => {
  it("一覧に載っていない担当の作業場は消す", () => {
    const [r] = judge([folder("agent-a1")]);
    expect(r.action).toBe("remove");
    expect(r.reason).toContain("載っていない");
  });

  it("一覧に載っていて枝もあるものは残す（担当がまだ使うかもしれない）", () => {
    const [r] = judge([folder("agent-a1")], {
      listed: [
        { path: "C:/repo", branch: "main", locked: false, lockReason: "" },
        { path: "C:/repo/.claude/worktrees/agent-a1", branch: "worktree-agent-a1", locked: false, lockReason: "" },
      ],
      branches: ["main", "worktree-agent-a1"],
    });
    expect(r.action).toBe("keep");
  });

  it("一覧に載っていても、枝がもう無ければ消す", () => {
    const [r] = judge([folder("agent-a1")], {
      listed: [
        { path: "C:/repo", branch: "main", locked: false, lockReason: "" },
        { path: "C:/repo/.claude/worktrees/agent-a1", branch: null, locked: false, lockReason: "" },
      ],
    });
    expect(r.action).toBe("remove");
    expect(r.reason).toContain("worktree-agent-a1");
  });

  it("枝が無くても、ロックしたプロセスが生きていれば残す", () => {
    const listed = [
      { path: "C:/repo", branch: "main", locked: false, lockReason: "" },
      { path: "C:/repo/.claude/worktrees/agent-a1", branch: null, locked: true, lockReason: "claude agent agent-a1 (pid 7188)" },
    ];
    expect(judge([folder("agent-a1")], { listed, alive: [7188] })[0].action).toBe("keep");
    // ロックした人が終わっていれば消してよい
    expect(judge([folder("agent-a1")], { listed, alive: [] })[0].action).toBe("remove");
  });

  it("ロックした人が分からないものは残す", () => {
    const listed = [
      { path: "C:/repo", branch: "main", locked: false, lockReason: "" },
      { path: "C:/repo/.claude/worktrees/agent-a1", branch: null, locked: true, lockReason: "手で止めた" },
    ];
    expect(judge([folder("agent-a1")], { listed })[0].action).toBe("keep");
  });

  it("agent- で始まらない作業場（ほかのセッションのもの）は、一覧に無くても残す", () => {
    const [r] = judge([folder("gifted-colden-7b1fc2")]);
    expect(r.action).toBe("keep");
    expect(r.reason).toContain("ほかのセッション");
  });

  it("いまこの作業場の中で動いているなら残す", () => {
    const [r] = judge([folder("agent-a1")], {
      protectedPaths: [ROOT, `${WT}\\agent-a1`, `${WT}\\agent-a1\\scripts`],
    });
    expect(r.action).toBe("keep");
  });

  it("本体を守る道に入れても、ほかの作業場まで守られはしない（本体は作業場の外側）", () => {
    const [r] = judge([folder("agent-a1")], { protectedPaths: [ROOT] });
    expect(r.action).toBe("remove");
  });

  it("作られたばかりのものは、一覧に無くても残す（git worktree add の途中かもしれない）", () => {
    const [r] = judge([folder("agent-a1", { ageMs: WORKTREE_MIN_AGE_MS - 1000 })]);
    expect(r.action).toBe("keep");
  });

  it("作業場そのものが連結になっているものは残す", () => {
    const [r] = judge([folder("agent-a1", { isLink: true, isDirectory: false })]);
    expect(r.action).toBe("keep");
  });

  it("道の書き方（/ と \\、大文字小文字）が違っても同じ作業場と分かる", () => {
    const [r] = judge([folder("agent-a1")], {
      listed: [
        { path: "C:/repo", branch: "main", locked: false, lockReason: "" },
        { path: "c:/REPO/.claude/worktrees/agent-a1", branch: "worktree-agent-a1", locked: false, lockReason: "" },
      ],
      branches: ["main", "worktree-agent-a1"],
    });
    expect(r.action).toBe("keep");
  });
});

describe("消す部分——連結をたどらない", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 本体（node_modules/.bin に2件）と、それへの連結を持つ作業場を作る */
  function makeFixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "novelai-cleanup-"));
    made.push(base);
    const main = path.join(base, "本体");
    fs.mkdirSync(path.join(main, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(main, "node_modules", ".bin", "tsc"), "1");
    fs.writeFileSync(path.join(main, "node_modules", ".bin", "vitest"), "1");
    const wt = path.join(base, "agent-a1");
    fs.mkdirSync(path.join(wt, "src", "深い"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src", "a.ts"), "x");
    fs.symlinkSync(path.join(main, "node_modules"), path.join(wt, "node_modules"), "junction");
    // 深いところの連結も、たどらずに外す
    fs.symlinkSync(main, path.join(wt, "src", "深い", "本体への連結"), "junction");
    return { base, main, wt };
  }

  function binCount(main: string) {
    return fs.readdirSync(path.join(main, "node_modules", ".bin")).length;
  }

  it("連結を外してから消す——本体の node_modules/.bin は減らない", () => {
    const { main, wt } = makeFixture();
    expect(binCount(main)).toBe(2);
    removeTreeSafely(wt);
    expect(fs.existsSync(wt)).toBe(false);
    expect(binCount(main)).toBe(2);
    expect(fs.existsSync(path.join(main, "node_modules", ".bin", "tsc"))).toBe(true);
  });

  it("連結だけを外す関数は、中身に触らない", () => {
    const { main, wt } = makeFixture();
    removeLinkOnly(path.join(wt, "node_modules"));
    expect(fs.existsSync(path.join(wt, "node_modules"))).toBe(false);
    expect(binCount(main)).toBe(2);
  });

  it("連結を外せないときは、その中へ入らずに投げる", () => {
    const { main, wt } = makeFixture();
    expect(() =>
      removeTreeSafely(wt, {
        removeLink: () => {
          throw new Error("外せない");
        },
      })
    ).toThrow("外せない");
    expect(binCount(main)).toBe(2);
  });

  it("読み取り専用のファイル（git のオブジェクト）も消せる", () => {
    const { wt } = makeFixture();
    const locked = path.join(wt, "src", "pack.idx");
    fs.writeFileSync(locked, "x");
    fs.chmodSync(locked, 0o444);
    removeTreeSafely(wt);
    expect(fs.existsSync(wt)).toBe(false);
  });
});

describe("起動設定の判定", () => {
  const exists = (p: string) => p === "C:\\Users\\nonah\\Documents\\ある";

  it("開くフォルダーがもう無い設定は消す", () => {
    const [r] = judgeLaunchConfigs(
      [{ name: "まっさら", runtimeArgs: ["server.js", "--port", "3113", "C:\\Temp\\scratchpad\\まっさら"] }],
      exists,
      "win32"
    );
    expect(r.action).toBe("remove");
  });

  it("開くフォルダーがあれば残す", () => {
    const [r] = judgeLaunchConfigs(
      [{ name: "試し", runtimeArgs: ["server.js", "C:\\Users\\nonah\\Documents\\ある"] }],
      exists,
      "win32"
    );
    expect(r.action).toBe("keep");
  });

  it("「たゆたう鉛_確認用」を含む常用の設定は、フォルダーが無くても残す", () => {
    const [r] = judgeLaunchConfigs(
      [{ name: `ブラウザ版VS Code（${KEEP_LAUNCH_MARK}）`, runtimeArgs: ["server.js", "C:\\どこにも無い"] }],
      () => false,
      "win32"
    );
    expect(r.action).toBe("keep");
  });

  it("最後の引数が道に見えないもの（npm run dev など）は、無いと言い切れないので残す", () => {
    const judged = judgeLaunchConfigs(
      [
        { name: "開発", runtimeArgs: ["run", "dev"] },
        { name: "指定だけ", runtimeArgs: ["server.js", "--extensionDevelopmentPath=."] },
        { name: "引数なし" },
      ],
      () => false,
      "win32"
    );
    expect(judged.map((r: { action: string }) => r.action)).toEqual(["keep", "keep", "keep"]);
  });
});

describe("試験用プロセスの判定", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("起動から12時間未満のものは残す", () => {
    const [r] = judgeProcesses(
      [{ pid: 10, parentPid: 1, start: iso(PROCESS_MIN_AGE_MS - HOUR), commandLine: "node node_modules/@vscode/test-web/out/server/index.js" }],
      { now }
    );
    expect(r.action).toBe("keep");
  });

  it("12時間以上たったブラウザ版の試験サーバーは止める（\\ の書き方でも見つける）", () => {
    const judged = judgeProcesses(
      [
        { pid: 10, parentPid: 1, start: iso(13 * HOUR), commandLine: "node node_modules\\@vscode\\test-web\\out\\server\\index.js" },
        { pid: 11, parentPid: 1, start: iso(20 * HOUR), commandLine: "C:\\repo\\.vscode-test\\vscode-win32-x64-archive-1.90.0\\Code.exe --type=renderer" },
      ],
      { now }
    );
    expect(judged.map((r: { action: string }) => r.action)).toEqual(["remove", "remove"]);
  });

  it("印の無いプロセス（作者の VS Code・Chrome・Ollama・LM Studio）は、古くても結果に出さない", () => {
    const judged = judgeProcesses(
      [
        { pid: 20, parentPid: 1, start: iso(100 * HOUR), commandLine: "\"C:\\Program Files\\Microsoft VS Code\\Code.exe\"" },
        { pid: 21, parentPid: 1, start: iso(100 * HOUR), commandLine: "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"" },
        { pid: 22, parentPid: 1, start: iso(100 * HOUR), commandLine: "ollama.exe serve" },
        { pid: 23, parentPid: 1, start: iso(100 * HOUR), commandLine: "\"LM Studio.exe\"" },
        { pid: 24, parentPid: 1, start: iso(100 * HOUR), commandLine: null },
      ],
      { now }
    );
    expect(judged).toEqual([]);
  });

  it("親が生きている MCP サーバーは、古くても止めない（このセッションが起こしたもの）", () => {
    const [r] = judgeProcesses(
      [
        { pid: 7188, parentPid: 1, start: iso(48 * HOUR), commandLine: "claude.exe" },
        { pid: 30, parentPid: 7188, start: iso(20 * HOUR), commandLine: "node dist/mcp-server.mjs" },
      ],
      { now }
    );
    expect(r).toMatchObject({ pid: 30, action: "keep" });
  });

  it("親が終わった MCP サーバーは止める", () => {
    const [r] = judgeProcesses(
      [{ pid: 30, parentPid: 7188, start: iso(20 * HOUR), commandLine: "node dist\\mcp-server.mjs" }],
      { now }
    );
    expect(r).toMatchObject({ pid: 30, action: "remove" });
  });

  it("親の pid が別のプロセスに使い回されていたら（子より後に起動）、親は終わったとみなす", () => {
    // notepad には印が無いので結果に出ない。出るのは MCP サーバーの1件だけ
    const [r] = judgeProcesses(
      [
        { pid: 7188, parentPid: 1, start: iso(1 * HOUR), commandLine: "notepad.exe" },
        { pid: 30, parentPid: 7188, start: iso(20 * HOUR), commandLine: "node dist/mcp-server.mjs" },
      ],
      { now }
    );
    expect(r).toMatchObject({ pid: 30, action: "remove" });
  });

  it("自分と自分の親は止めない。起動時刻が読めないものも止めない", () => {
    const judged = judgeProcesses(
      [
        { pid: 40, parentPid: 1, start: iso(20 * HOUR), commandLine: "node vscode-test-web" },
        { pid: 41, parentPid: 1, start: null, commandLine: "node vscode-test-web" },
      ],
      { now, selfPids: new Set([40]) }
    );
    expect(judged.map((r: { action: string }) => r.action)).toEqual(["keep", "keep"]);
  });

  it("印の見分け", () => {
    expect(markerOf("node dist/mcp-server.mjs")).toBe("dist/mcp-server.mjs");
    expect(markerOf("node C:\\x\\node_modules\\@VSCODE\\TEST-WEB\\a.js")).toBe("@vscode/test-web");
    expect(markerOf("node dist/extension.js")).toBeNull();
  });
});

describe("出力の1行", () => {
  it("何も消さなければ何も出さない", () => {
    expect(summarize({ worktrees: 0, launch: 0, processes: 0 })).toBe("");
  });

  it("消したものだけを並べる", () => {
    expect(summarize({ worktrees: 2, launch: 1, processes: 0 })).toBe("片づけ：作業場2つ・起動設定1つ");
  });
});
