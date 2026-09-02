import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

/**
 * 分岐を合わせる（設計書5.5.16）を、**本物のgitリポジトリで動かす**。
 *
 * この作品で繰り返した失敗は「単体テストが通っても実データで動かない」である。
 * 作り物の返事だけで確かめると、**gitの実際の振る舞い**（何が衝突と数えられ、
 * `--no-commit` のあと何がステージに載るか）を確かめたことにならない。
 *
 * vscode だけを差し替えて、gitとファイルは本物を使う。
 */

/** 画面に出た問いと、その答え */
const answers: string[] = [];
const shown: string[] = [];

vi.mock("vscode", () => {
  const readFile = async (uri: { fsPath: string }) =>
    new Uint8Array(fs.readFileSync(uri.fsPath));
  return {
    window: {
      showInformationMessage: (message: string, ...rest: unknown[]) => {
        record(message, rest);
        return Promise.resolve(pickAnswer(rest));
      },
      showWarningMessage: (message: string, ...rest: unknown[]) => {
        record(message, rest);
        return Promise.resolve(pickAnswer(rest));
      },
      showErrorMessage: (message: string, ...rest: unknown[]) => {
        record(message, rest);
        return Promise.resolve(pickAnswer(rest));
      },
      withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
        Promise.resolve(
          task({ report: () => {} }, { isCancellationRequested: false })
        ),
      createStatusBarItem: () => ({
        show() {},
        hide() {},
        dispose() {},
      }),
      createOutputChannel: () => ({
        appendLine() {},
        show() {},
        dispose() {},
      }),
    },
    workspace: {
      fs: { readFile },
      getConfiguration: () => ({ get: () => undefined }),
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => {} },
    Uri: {
      file: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
      parse: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
    },
    ProgressLocation: { Window: 10, Notification: 15 },
    // 中止ボタン付きの進捗が使う。中止はしないので、押されていない札を返すだけ
    CancellationTokenSource: class {
      token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
      cancel() {}
      dispose() {}
    },
    StatusBarAlignment: { Right: 2 },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
  };
});

/** 画面に添えられた説明も控える。落ちた理由はそちらに出る */
function record(message: string, rest: unknown[]): void {
  const detail = rest.find(
    (item): item is { detail?: string } =>
      typeof item === "object" && item !== null && "detail" in item
  )?.detail;
  shown.push(detail ? `${message}
${detail}` : message);
}

/** ボタンが並んでいたら、答えとして用意したものを返す */
function pickAnswer(rest: unknown[]): string | undefined {
  const buttons = rest.filter((item) => typeof item === "string") as string[];
  const wanted = answers.find((answer) => buttons.includes(answer));
  return wanted;
}

const { resolveDivergence } = await import("../../src/features/resolveDivergence");

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

/** 作品1つを置いた、GitHub役の置き場とその写しを作る */
function setUp(): void {
  const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-diverge-"));
  remote = nodePath.join(base, "remote.git");
  root = nodePath.join(base, "work");

  const seed = nodePath.join(base, "seed");
  fs.mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  // **端末のgitの設定で結果が変わらないようにする。**
  // 取り出したあとに切ると、取り出し済みのファイルだけ改行が違う形で残り、
  // 「両方の環境が同じ行を書き換えた」ことになってしまう
  git(seed, "config", "core.autocrlf", "false");
  git(seed, "config", "user.name", "作者");
  git(seed, "config", "user.email", "author@example.com");
  write(seed, "短編/本文/第1話.txt", "むかしむかし。\n");
  write(seed, "短編/.aiwriter/stats/pc.json", '{"at":"1"}\n');
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "初回");

  git(base, "clone", "-q", "--bare", seed, remote);
  git(base, "-c", "core.autocrlf=false", "clone", "-q", remote, root);
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "作者");
  git(root, "config", "user.email", "author@example.com");
}

/** 別のPCで書いた分を、GitHub役へ入れる */
function pushFromOtherMachine(changes: Array<[string, string]>): void {
  const other = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-other-"));
  git(other, "-c", "core.autocrlf=false", "clone", "-q", remote, "clone");
  const clone = nodePath.join(other, "clone");
  git(clone, "config", "core.autocrlf", "false");
  git(clone, "config", "user.name", "作者");
  git(clone, "config", "user.email", "author@example.com");
  for (const [file, body] of changes) write(clone, file, body);
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "別のPCで書いた");
  git(clone, "push", "-q", "origin", "main");
}

/** この端末で書いて記録する */
function commitHere(changes: Array<[string, string]>, message: string): void {
  for (const [file, body] of changes) write(root, file, body);
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
}

function deps() {
  return {
    registry: {
      list: () => [{ id: "w1", title: "短編", folderPath: root }],
    } as never,
  };
}

function status(): string {
  return git(root, "status", "-sb").split("\n")[0];
}

beforeEach(() => {
  answers.length = 0;
  shown.length = 0;
  setUp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 本物のgitを子プロセスで何度も起動するため、全体実行の並列負荷では1本が
// 6秒台まで伸びることがある（既定5秒を際どく超え、落ちるテストが毎回入れ替わる）。
// 単独実行では1.6秒程度。処理の遅さではなく起動の重さなので、待ちだけ伸ばす
describe("分かれた分を合わせる", { timeout: 30_000 }, () => {
  test("衝突しなければ、そのまま合わせる", async () => {
    // 別のPCで新しい話を書き、こちらでは別の話を直した
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "むかしむかし、あるところに。\n"]], "こちらで加筆");
    git(root, "fetch", "-q");
    expect(status()).toContain("ahead 1, behind 1");

    answers.push("合わせる");
    await resolveDivergence(deps());

    // こちらの1件＋合わせた1件で、送るものは2件になる
    expect(status()).toContain("ahead 2");
    expect(status()).not.toContain("behind");
    // 両方の原稿が残っている
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第2話.txt"), "utf8")).toBe(
      "つづき。\n"
    );
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第1話.txt"), "utf8")).toBe(
      "むかしむかし、あるところに。\n"
    );
  });

  test("押さなければ、何も起きない", async () => {
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");

    // 「合わせる」を押さない
    await resolveDivergence(deps());

    expect(status()).toContain("ahead 1, behind 1");
  });

  test("戻せるように、退避の枝を残す", async () => {
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");

    answers.push("合わせる");
    await resolveDivergence(deps());

    expect(git(root, "branch", "--list", "backup/*")).toContain("backup/");
  });

  test("未記録の変更は、合わせる前に記録する", async () => {
    // 汚れたままではマージを始められない。**書きかけを失わせない**
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");
    write(root, "短編/本文/第3話.txt", "書きかけ。\n");

    answers.push("合わせる");
    await resolveDivergence(deps());

    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第3話.txt"), "utf8")).toBe(
      "書きかけ。\n"
    );
  });

  test("同じ原稿が両方で書き換えられていたら、合わせない", async () => {
    // **どちらを残すかは、書いた本人にしか分からない**（設計書5.5.4）
    pushFromOtherMachine([["短編/本文/第1話.txt", "むこうの直し。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちらの直し。\n"]], "こちらで直した");

    answers.push("合わせる");
    await resolveDivergence(deps());

    // 分かれたまま。原稿はこちらのまま
    expect(status()).toContain("ahead 1, behind 1");
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第1話.txt"), "utf8")).toBe(
      "こちらの直し。\n"
    );
    expect(shown.join("\n")).toContain("両方で書き換えられています");
  });

  test("自動で書かれるものだけの食い違いなら、この端末の側を残して合わせる", async () => {
    // 執筆量の記録は端末ごとで、読み込むときに合算する（設計書5.5.6）
    pushFromOtherMachine([["短編/.aiwriter/stats/pc.json", '{"at":"むこう"}\n']]);
    commitHere([["短編/.aiwriter/stats/pc.json", '{"at":"こちら"}\n']], "こちらの記録");

    answers.push("合わせる");
    await resolveDivergence(deps());

    expect(status()).not.toContain("behind");
    expect(
      fs.readFileSync(nodePath.join(root, "短編/.aiwriter/stats/pc.json"), "utf8")
    ).toBe('{"at":"こちら"}\n');
  });

  test("同じ中身を両方で入れていたら、衝突にしない", async () => {
    // 作者の置き場で実際に起きた形。**名前で判定していたら行き止まりだった**
    const 同じ原稿 = "投稿サイトから取り込んだ本文。\n";
    pushFromOtherMachine([["短編/本文/第9話.txt", 同じ原稿]]);
    commitHere([["短編/本文/第9話.txt", 同じ原稿]], "こちらでも取り込んだ");

    answers.push("合わせる");
    await resolveDivergence(deps());

    expect(status()).not.toContain("behind");
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第9話.txt"), "utf8")).toBe(
      同じ原稿
    );
  });

  test("改行の自動変換が入る環境でも、合わせられる", async () => {
    // gitは書き戻すときに改行を変える（`core.autocrlf`）。
    // **取り込んだファイルはそれで構わないが、触っていない原稿が変わったら止める**
    // ——それを見分けられずに止まっていた不具合を、ここで抑える
    git(root, "config", "core.autocrlf", "true");
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");
    const 触らない原稿 = fs.readFileSync(
      nodePath.join(root, "短編/本文/第1話.txt")
    );

    answers.push("合わせる");
    await resolveDivergence(deps());

    expect(status()).not.toContain("behind");
    // 触っていない原稿は1バイトも変わっていない
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第1話.txt"))).toEqual(
      触らない原稿
    );
  });

  test("分かれていなければ、何もしない", async () => {
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);

    answers.push("合わせる");
    await resolveDivergence(deps());

    expect(shown.join("\n")).toContain("分かれていません");
    // 取り込みもしない（それは「同期」の仕事である）
    expect(fs.existsSync(nodePath.join(root, "短編/本文/第2話.txt"))).toBe(false);
  });

  test("合わせても、GitHubへは送信しない", async () => {
    // 外へ出る操作は作者の操作のままにする（設計書5.5.1）
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");

    answers.push("合わせる");
    await resolveDivergence(deps());

    expect(status()).toContain("ahead");
    expect(shown.join("\n")).toContain("送信");
  });
});
