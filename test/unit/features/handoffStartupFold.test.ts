import { beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

/**
 * 開いたときの点検の「合わせて送る」道（設計書6.15.1）を、**本物のgit**で走らせる。
 *
 * ## 何を確かめるか（引継ぎ書 B15 の①）
 *
 * 点検は、両側で変わったファイルを**名前で**突き合わせて「重ならない」と
 * 判断したら、黙って合わせる。ところが git の差分は名前の変更を
 * 「新しい名前が1つ変わった」と数えるので、
 *
 * - こちら：`第1話.txt` を `第一話.txt` へ名前を変えて、3行目を直した
 * - 向こう：`第1話.txt` の3行目を直した
 *
 * は、名前の上では重ならない（`第一話.txt` と `第1話.txt`）。実際に合わせると
 * git は名前の変更を追いかけ、**同じ行がぶつかる。** このとき、確認なしで
 * 1件ずつ選ぶ画面が開いていた。VS Code を開いただけで選ぶ画面が出るのは、
 * 「重なったら止めて訊く」（6.15.1）に届いていない。
 *
 * 作り物の git では、この「名前の上の判断と実際の合流のずれ」が作れない
 * （ずれそのものが git の振る舞いだから）。
 */

/** 1件ずつ選ぶ画面が呼ばれたか。**開いたときの道では呼ばれてはいけない** */
const walkCalls: string[][] = [];

vi.mock("../../../src/features/resolveConflicts", () => ({
  walkConflicts: async (_scope: unknown, files: readonly string[]) => {
    walkCalls.push([...files]);
    // 作者が何も選ばずに閉じた、という返事にしておく
    return { resolved: [], bulkResolved: [], aborted: true };
  },
}));

/** 画面に出た知らせと、並んだボタン */
const notices: Array<{ message: string; buttons: string[] }> = [];
const commands: string[] = [];

vi.mock("vscode", () => {
  const readFile = async (uri: { fsPath: string }) =>
    new Uint8Array(fs.readFileSync(uri.fsPath));
  const writeFile = async (uri: { fsPath: string }, bytes: Uint8Array) => {
    fs.mkdirSync(nodePath.dirname(uri.fsPath), { recursive: true });
    fs.writeFileSync(uri.fsPath, bytes);
  };
  const show = (message: string, ...rest: unknown[]) => {
    notices.push({
      message,
      buttons: rest.filter((one): one is string => typeof one === "string"),
    });
    return Promise.resolve(undefined);
  };
  return {
    window: {
      showInformationMessage: show,
      showWarningMessage: show,
      showErrorMessage: show,
      createOutputChannel: () => ({
        appendLine() {},
        show() {},
        dispose() {},
      }),
    },
    workspace: {
      fs: { readFile, writeFile },
      // 保存していない原稿は無い（あると点検が手前で止まる）
      textDocuments: [],
      getConfiguration: () => ({ get: () => undefined }),
    },
    commands: {
      executeCommand: async (command: string) => {
        commands.push(command);
      },
    },
    Uri: {
      file: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
      parse: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
    },
  };
});

const { runStartupHandoff } = await import("../../../src/features/handoffSync");

let root: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function write(dir: string, file: string, body: string): void {
  const full = nodePath.join(dir, file);
  fs.mkdirSync(nodePath.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function read(file: string): string {
  return fs.readFileSync(nodePath.join(root, file), "utf8");
}

function configure(dir: string): void {
  // **端末のgitの設定で結果が変わらないようにする**（resolveDivergence.test.ts と同じ理由）
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "user.name", "作者");
  git(dir, "config", "user.email", "author@example.com");
}

const ORIGINAL = "いち\nに\nさん\nし\nご\n";

/** GitHub役の置き場と、この端末の写しを作る */
function setUp(): void {
  const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-handoff-"));
  remote = nodePath.join(base, "remote.git");
  root = nodePath.join(base, "work");

  const seed = nodePath.join(base, "seed");
  fs.mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  configure(seed);
  write(seed, "短編/本文/第1話.txt", ORIGINAL);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "初回");

  git(base, "clone", "-q", "--bare", seed, remote);
  git(base, "-c", "core.autocrlf=false", "clone", "-q", remote, root);
  configure(root);
}

/** 別のPCで書いた分を、GitHub役へ入れる */
function pushFromOtherMachine(file: string, body: string): void {
  const other = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-other-"));
  git(other, "-c", "core.autocrlf=false", "clone", "-q", remote, "clone");
  const clone = nodePath.join(other, "clone");
  configure(clone);
  write(clone, file, body);
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "別のPCで書いた");
  git(clone, "push", "-q", "origin", "main");
}

/** この端末で、名前を変えて（必要なら中身も直して）記録する */
function renameHere(from: string, to: string, body?: string): void {
  git(root, "mv", from, to);
  if (body !== undefined) write(root, to, body);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "こちらで名前を変えた");
}

function remoteHead(): string {
  return git(remote, "rev-parse", "main").trim();
}

function deps() {
  const works = [{ id: "w1", title: "短編", folderPath: nodePath.join(root, "短編") }];
  const store: Record<string, unknown> = {};
  return {
    registry: { list: () => works } as never,
    monitor: {
      refreshAll: async () => {},
      statusFor: () => undefined,
    } as never,
    storage: {
      get: <T>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => {
        store[key] = value;
      },
    },
  };
}

beforeEach(() => {
  walkCalls.length = 0;
  notices.length = 0;
  commands.length = 0;
  setUp();
}, 30_000);

// 本物のgitを子プロセスで何度も起動するので、待ちだけ伸ばす（resolveDivergence.test.ts と同じ）
describe("開いたときの点検：名前の上では重ならないが、合わせるとぶつかる", { timeout: 30_000 }, () => {
  test("1件ずつ選ぶ画面を開かずに、合わせるのをやめて止める", async () => {
    pushFromOtherMachine("短編/本文/第1話.txt", "いち\nに\nむこう\nし\nご\n");
    renameHere(
      "短編/本文/第1話.txt",
      "短編/本文/第一話.txt",
      "いち\nに\nこちら\nし\nご\n"
    );
    const before = git(root, "rev-parse", "HEAD").trim();
    const sentBefore = remoteHead();

    await runStartupHandoff(deps());

    // **選ぶ画面は、作者がボタンを押したときだけ**
    expect(walkCalls).toEqual([]);
    // 合わせかけた状態を残さない（元に戻っている）
    expect(fs.existsSync(nodePath.join(root, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(before);
    expect(git(root, "status", "--porcelain").trim()).toBe("");
    // 手元の記録は失われない
    expect(read("短編/本文/第一話.txt")).toBe("いち\nに\nこちら\nし\nご\n");
    // 送っていない
    expect(remoteHead()).toBe(sentBefore);
    // 「重なる」ときと同じ知らせと、進める口
    const last = notices[notices.length - 1];
    expect(last?.message).toContain("同じファイルが両方で変わっています");
    expect(last?.buttons).toContain("分岐合流");
    // 押されていないので、合流の画面へは進んでいない
    expect(commands).not.toContain("novelai.resolveDivergence");
  });

  test("止めたときに、使わなかった退避の枝を増やさない", async () => {
    // **開くたびに同じ所で止まる**ので、そのたびに枝が1本ずつ増えていく
    pushFromOtherMachine("短編/本文/第1話.txt", "いち\nに\nむこう\nし\nご\n");
    renameHere(
      "短編/本文/第1話.txt",
      "短編/本文/第一話.txt",
      "いち\nに\nこちら\nし\nご\n"
    );

    await runStartupHandoff(deps());

    expect(git(root, "branch", "--list", "backup/*").trim()).toBe("");
  });
});

/**
 * **自動の経路では記録（コミット）しない**（設計書6.15.1、引継ぎ書 B15 の残る疑問、残課題 F6）。
 *
 * 執筆量の記録（`.aiwriter/stats/`）は保存のたびに書き換わるので、点検は
 * 「未記録の変更」に数えない（5.5.13）。それで「未記録なし」と判断して
 * 合わせに進むと、合わせる側（`foldDivergence`）は統計も数えて
 * 「合わせる前の自動保存」を記録し、送っていた。作者が何も押していないのに
 * 作者の名前で記録が1つ増えて GitHub へ出ていく。
 */
describe("開いたときの点検：統計だけが変わった置き場", { timeout: 30_000 }, () => {
  test("合わせる前の自動保存を記録せずに合わせて送り、統計の変更は未記録のまま残す", async () => {
    // 統計のファイルは既に記録されている（端末ごとに1つ）
    write(root, "短編/.aiwriter/stats/pc.json", '{"days":[]}\n');
    git(root, "add", "-A");
    git(root, "commit", "-qm", "統計");
    git(root, "push", "-q", "origin", "main");

    pushFromOtherMachine("短編/本文/第2話.txt", "別のPCで書いた話\n");
    // こちらでも書いて記録した（送ってはいない）
    write(root, "短編/本文/第1話.txt", "いち\nに\nこちら\nし\nご\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "こちらで書いた");
    // 保存のたびに書き換わる統計（未記録）
    write(root, "短編/.aiwriter/stats/pc.json", '{"days":[{"date":"2026-09-25","net":120}]}\n');

    await runStartupHandoff(deps());

    const subjects = git(root, "log", "--format=%s").split("\n");
    expect(subjects.some((subject) => subject.includes("合わせる前の自動保存"))).toBe(false);
    // 合わせて送り終えている
    expect(read("短編/本文/第2話.txt")).toBe("別のPCで書いた話\n");
    expect(read("短編/本文/第1話.txt")).toBe("いち\nに\nこちら\nし\nご\n");
    expect(remoteHead()).toBe(git(root, "rev-parse", "HEAD").trim());
    // 統計は書き換えたまま、記録されずに残っている（次に作者が記録するとき一緒に入る）
    expect(read("短編/.aiwriter/stats/pc.json")).toContain("2026-09-25");
    expect(git(root, "status", "--porcelain").trim()).toContain(".aiwriter/stats/pc.json");
    expect(walkCalls).toEqual([]);
  });

  test("合わせてみてぶつかり、元へ戻したときも、統計の書き換えは消えない", async () => {
    // 記録せずに合わせるようになったので、`merge --abort` が未記録の統計を
    // 巻き込んで消さないことを確かめておく
    write(root, "短編/.aiwriter/stats/pc.json", '{"days":[]}\n');
    git(root, "add", "-A");
    git(root, "commit", "-qm", "統計");
    git(root, "push", "-q", "origin", "main");

    pushFromOtherMachine("短編/本文/第1話.txt", "いち\nに\nむこう\nし\nご\n");
    renameHere(
      "短編/本文/第1話.txt",
      "短編/本文/第一話.txt",
      "いち\nに\nこちら\nし\nご\n"
    );
    write(root, "短編/.aiwriter/stats/pc.json", '{"days":[{"date":"2026-09-25","net":120}]}\n');
    const before = git(root, "rev-parse", "HEAD").trim();

    await runStartupHandoff(deps());

    expect(git(root, "rev-parse", "HEAD").trim()).toBe(before);
    expect(fs.existsSync(nodePath.join(root, ".git", "MERGE_HEAD"))).toBe(false);
    expect(read("短編/.aiwriter/stats/pc.json")).toContain("2026-09-25");
    expect(read("短編/本文/第一話.txt")).toBe("いち\nに\nこちら\nし\nご\n");
    expect(walkCalls).toEqual([]);
  });
});

describe("開いたときの点検：名前を変えても、ぶつからなければ合わせて送る", { timeout: 30_000 }, () => {
  test("向こうの直しを、名前を変えた先へ入れて送る", async () => {
    pushFromOtherMachine("短編/本文/第1話.txt", "いち\nに\nむこう\nし\nご\n");
    // こちらは名前を変えただけ（中身はそのまま）
    renameHere("短編/本文/第1話.txt", "短編/本文/第一話.txt");

    await runStartupHandoff(deps());

    expect(walkCalls).toEqual([]);
    expect(read("短編/本文/第一話.txt")).toBe("いち\nに\nむこう\nし\nご\n");
    // 送り終えている（GitHub役の先頭が、手元の先頭と同じ）
    expect(remoteHead()).toBe(git(root, "rev-parse", "HEAD").trim());
    expect(notices[notices.length - 1]?.message).toContain("合わせて送信 1か所");
  });
});
