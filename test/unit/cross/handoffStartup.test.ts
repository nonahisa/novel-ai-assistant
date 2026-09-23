import { beforeEach, describe, expect, test } from "vitest";
import {
  noticeBeforeClose,
  refreshUnsentMark,
  runStartupHandoff,
} from "../../../src/features/handoffSync";
import type { GitCommandRunner, GitSyncStatus } from "../../../src/core/git";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { GitSyncMonitorLike } from "../../../src/features/gitSyncStub";
import type { WorkEntry } from "../../../src/models/types";
import { UNSENT_MARK_KEY } from "../../../src/core/unsentMark";
import { window, workspace } from "../support/vscodeStub";

/**
 * VS Code を開いた時点の点検（設計書6.15.1の①）を、作り物の git で走らせる。
 *
 * **ここは自動で走る経路なので、いつもより危ない。** 作者の原稿を巻き込まない
 * ことを、手順の並び（何を呼んで、何を呼ばなかったか）で確かめる。
 *
 * **本物の git は呼ばない。** 見たいのは判断であって git の振る舞いではない。
 */

const library = "C:/書庫";

const works: WorkEntry[] = [
  { id: "w1", title: "いじめられっ子", folderPath: "C:/書庫/いじめられっ子" },
  { id: "w2", title: "ハイエルフ未亡人", folderPath: "C:/書庫/ハイエルフ未亡人" },
] as WorkEntry[];

const registry = { list: () => works } as unknown as WorkRegistry;

let calls: string[][] = [];

/** 置き場の状態を決めて、作り物の git を組み立てる */
function fakeRepo(over: {
  behind?: number;
  ahead?: number;
  porcelain?: string;
  /** `<upstream>...HEAD`（こちら側）で変わったファイル */
  localFiles?: string[];
  /** `HEAD...<upstream>`（向こう側）で変わったファイル */
  remoteFiles?: string[];
}): GitCommandRunner {
  const behind = over.behind ?? 0;
  const ahead = over.ahead ?? 0;
  return async (args) => {
    calls.push(args);
    const joined = args.join(" ");
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "--version") return ok("git version 2.55");
    if (joined === "rev-parse --is-inside-work-tree") return ok("true");
    if (joined === "rev-parse --show-toplevel") return ok(library);
    if (joined === "remote") return ok("origin");
    if (args[0] === "symbolic-ref") return ok("main");
    if (joined.startsWith("rev-parse --abbrev-ref")) return ok("origin/main");
    if (args[0] === "rev-list") return ok(`${behind}\t${ahead}`);
    if (args[0] === "status") return ok(over.porcelain ?? "");
    if (joined.includes("origin/main...HEAD")) {
      return ok(nulJoined(over.localFiles ?? []));
    }
    if (joined.includes("HEAD...origin/main")) {
      return ok(nulJoined(over.remoteFiles ?? []));
    }
    return ok();
  };
}

/** git の `-z` 出力の形（**区切りはエスケープで書く**。CLAUDE.md 規則4） */
function nulJoined(names: readonly string[]): string {
  return names.map((name) => `${name}\0`).join("");
}

function monitorWith(status: GitSyncStatus): GitSyncMonitorLike {
  return {
    refreshAll: async () => {},
    statusFor: () => status,
  } as unknown as GitSyncMonitorLike;
}

function memoryStorage(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    get<T>(key: string): T | undefined {
      return store[key] as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) delete store[key];
      else store[key] = value;
    },
    raw: () => store,
  };
}

function tracked(
  over: Partial<Extract<GitSyncStatus, { kind: "tracked" }>> = {}
): GitSyncStatus {
  return {
    kind: "tracked",
    root: library,
    branch: "main",
    upstream: "origin/main",
    behind: 0,
    ahead: 0,
    behindHere: 0,
    aheadHere: 0,
    dirty: 0,
    dirtyHere: 0,
    unmerged: 0,
    ...over,
  };
}

/** 画面に出た知らせ（最後の1件） */
let notice: string | undefined;

beforeEach(() => {
  calls = [];
  notice = undefined;
  workspace.textDocuments = [];
  window.showWarningMessage = (async (message: string) => {
    notice = message;
    return undefined;
  }) as typeof window.showWarningMessage;
});

/** その git 副コマンドが呼ばれたか */
function called(head: string): boolean {
  return calls.some((args) => args.join(" ").startsWith(head));
}

describe("開いたときの点検（作者の裁定の表）", () => {
  test("リモートだけ進んでいるなら、黙って取る", async () => {
    const run = fakeRepo({ behind: 2 });
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ behind: 2 })),
      storage: memoryStorage(),
      run,
    });

    expect(called("pull")).toBe(true);
    expect(called("push")).toBe(false);
  });

  test("ローカルに溜まっているなら、送る", async () => {
    const run = fakeRepo({ ahead: 3 });
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ ahead: 3 })),
      storage: memoryStorage(),
      run,
    });

    expect(called("push")).toBe(true);
    expect(called("pull")).toBe(false);
  });

  test("両方に動きがあっても、同じファイルが変わっていたら止める", async () => {
    // **行単位で自動で混ぜない。** どちらの文章が消えたか作者が気づけない
    const run = fakeRepo({
      behind: 2,
      ahead: 2,
      localFiles: ["本文/008.txt"],
      remoteFiles: ["本文/008.txt"],
    });
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ behind: 2, ahead: 2 })),
      storage: memoryStorage(),
      run,
    });

    expect(called("pull")).toBe(false);
    expect(called("push")).toBe(false);
    expect(called("merge")).toBe(false);
    expect(notice).toContain("同じファイルが両方で変わっています");
  });

  test("両側の変更を調べられなかったら、混ぜずに止める", async () => {
    // **調べられないことは、重ならない証拠にならない**（安全な側へ倒す）
    const base = fakeRepo({ behind: 2, ahead: 2 });
    const run: GitCommandRunner = async (args, cwd, timeout) => {
      if (args.join(" ").includes("...")  && args[0] === "diff") {
        calls.push(args);
        return { code: 128, stdout: "", stderr: "fatal" };
      }
      return base(args, cwd, timeout);
    };

    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ behind: 2, ahead: 2 })),
      storage: memoryStorage(),
      run,
    });

    expect(called("merge")).toBe(false);
    expect(called("push")).toBe(false);
  });
});

describe("自動では進めない場面", () => {
  test("未保存の原稿があれば、何も送らない", async () => {
    // **保存していない中身は git から見えない。** このまま送ると欠ける
    workspace.textDocuments = [
      {
        uri: { fsPath: "C:/書庫/いじめられっ子/本文/008.txt", scheme: "file" },
        isDirty: true,
        getText: () => "",
      },
    ] as unknown as typeof workspace.textDocuments;

    const run = fakeRepo({ ahead: 3 });
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ ahead: 3 })),
      storage: memoryStorage(),
      run,
    });

    expect(called("push")).toBe(false);
    expect(notice).toContain("保存していない原稿");
  });

  test("競合マーカーが残っていたら、何も動かさない（設計書5.5.1）", async () => {
    const run = fakeRepo({ behind: 1, ahead: 1, porcelain: "UU 本文/008.txt\n" });
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ behind: 1, ahead: 1, unmerged: 1 })),
      storage: memoryStorage(),
      run,
    });

    expect(called("pull")).toBe(false);
    expect(called("push")).toBe(false);
    expect(notice).toContain("未解決の競合");
  });

  test("未記録の変更があるときは、取り込まない", async () => {
    const run = fakeRepo({ behind: 2, porcelain: " M 本文/008.txt\n" });
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ behind: 2, dirty: 1 })),
      storage: memoryStorage(),
      run,
    });

    expect(called("pull")).toBe(false);
    expect(notice).toContain("記録していない変更");
  });
});

describe("書庫（1つの置き場に複数の作品）", () => {
  test("同じ置き場へ、取りに行くのは1回だけ", async () => {
    // 11作品ぶん fetch すると、開いた瞬間に11回ネットワークへ出る
    const run = fakeRepo({ ahead: 1 });
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ ahead: 1 })),
      storage: memoryStorage(),
      run,
    });

    expect(calls.filter((args) => args[0] === "fetch")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "push")).toHaveLength(1);
  });
});

describe("「送らずに閉じた」印", () => {
  test("前回の印を、開いたときに知らせる", async () => {
    const storage = memoryStorage({
      [UNSENT_MARK_KEY]: {
        at: "2026-09-20T22:00:00.000Z",
        ahead: 4,
        dirty: 0,
        labels: ["書庫"],
      },
    });

    // 同期は取れている（＝点検では何も起きない）状態でも、印は知らせる
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked()),
      storage,
      run: fakeRepo({}),
    });

    expect(notice).toContain("前回、送らずに閉じました");
  });

  test("送り残しがあれば印を付け、無くなれば消す", async () => {
    const storage = memoryStorage();

    await refreshUnsentMark({
      registry,
      monitor: monitorWith(tracked({ ahead: 2 })),
      storage,
    });
    expect(storage.raw()[UNSENT_MARK_KEY]).toMatchObject({ ahead: 2 });

    // **消えるのは送り残しが無くなったとき＝送信が通ったときだけ**
    await refreshUnsentMark({
      registry,
      monitor: monitorWith(tracked()),
      storage,
    });
    expect(UNSENT_MARK_KEY in storage.raw()).toBe(false);
  });

  test("閉じる前は、印を書いてから問う", () => {
    // **`deactivate()` は待たれない。** 問いが出なくても印は残す
    const storage = memoryStorage();
    noticeBeforeClose({
      registry,
      monitor: monitorWith(tracked({ ahead: 5 })),
      storage,
    });

    expect(storage.raw()[UNSENT_MARK_KEY]).toMatchObject({ ahead: 5 });
    expect(notice).toContain("前回、送らずに閉じました");
  });

  test("送り残しが無ければ、閉じる前に問わない", () => {
    noticeBeforeClose({
      registry,
      monitor: monitorWith(tracked()),
      storage: memoryStorage(),
    });

    expect(notice).toBeUndefined();
  });
});

/**
 * 知らせの中身（設計書6.15.1）。
 *
 * **点検は黙って原稿を動かす。** 何をしたかが1行で出なければ、作者は
 * 「別の機械で書いたはずの続きが、いつの間にか入っている」状態に置かれる。
 * **押せる口（分かれた分を合わせる）まで出るか**も、ここで見る——
 * 止めておきながら次の手を出さないと、作者は行き止まりに立つ。
 */
describe("点検のあとの知らせ", () => {
  /** 知らせに並んだボタン */
  let buttons: string[] = [];

  beforeEach(() => {
    buttons = [];
    window.showWarningMessage = (async (
      message: string,
      ...rest: unknown[]
    ) => {
      notice = message;
      buttons = rest.filter((one): one is string => typeof one === "string");
      return undefined;
    }) as typeof window.showWarningMessage;
  });

  test("取り込んだら、そのことを知らせる", async () => {
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ behind: 2 })),
      storage: memoryStorage(),
      run: fakeRepo({ behind: 2 }),
    });

    expect(notice).toContain("取り込み 1か所");
  });

  test("送ったら、そのことを知らせる", async () => {
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ ahead: 3 })),
      storage: memoryStorage(),
      run: fakeRepo({ ahead: 3 }),
    });

    expect(notice).toContain("送信 1か所");
  });

  test("重なって止めたときは、「分かれた分を合わせる」へ進める口を出す", async () => {
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ behind: 2, ahead: 2 })),
      storage: memoryStorage(),
      run: fakeRepo({
        behind: 2,
        ahead: 2,
        localFiles: ["本文/008.txt"],
        remoteFiles: ["本文/008.txt"],
      }),
    });

    expect(buttons).toContain("分かれた分を合わせる");
  });

  test("止まっていないときの口は「同期する」", async () => {
    // **合わせる口は、合わせるものがあるときだけ。** いつも出していると
    // 押してよいものか分からなくなる
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked({ ahead: 3 })),
      storage: memoryStorage(),
      run: fakeRepo({ ahead: 3 }),
    });

    expect(buttons).toContain("同期する");
    expect(buttons).not.toContain("分かれた分を合わせる");
  });

  test("何も起きなければ、何も出さない", async () => {
    // 開くたびに知らせが出ると読まれなくなる
    await runStartupHandoff({
      registry,
      monitor: monitorWith(tracked()),
      storage: memoryStorage(),
      run: fakeRepo({}),
    });

    expect(notice).toBeUndefined();
  });
});
