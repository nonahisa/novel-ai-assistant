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
  // 追記型の記録を混ぜた結果は、索引からではなく**その場で組んで**置く
  const writeFile = async (uri: { fsPath: string }, bytes: Uint8Array) => {
    fs.mkdirSync(nodePath.dirname(uri.fsPath), { recursive: true });
    fs.writeFileSync(uri.fsPath, bytes);
  };
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
      fs: { readFile, writeFile },
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

const {
  resolveDivergence,
  describeAuthoredStop,
  describeDivergenceBreakdown,
  describeDivergenceConfirm,
  describeFoldSuccess,
  foldDivergence,
} = await import("../../../src/features/resolveDivergence");
type ConflictWalker = Parameters<
  typeof foldDivergence
>[2] extends { walk?: infer W } | undefined
  ? NonNullable<W>
  : never;

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

/** 別のPCで書いた分を、GitHub役へ入れる。`removals` は向こうで消したもの */
function pushFromOtherMachine(
  changes: Array<[string, string]>,
  removals: string[] = []
): void {
  const other = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-other-"));
  git(other, "-c", "core.autocrlf=false", "clone", "-q", remote, "clone");
  const clone = nodePath.join(other, "clone");
  git(clone, "config", "core.autocrlf", "false");
  git(clone, "config", "user.name", "作者");
  git(clone, "config", "user.email", "author@example.com");
  for (const [file, body] of changes) write(clone, file, body);
  for (const file of removals) fs.rmSync(nodePath.join(clone, file));
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

/*
  **フックにも猶予が要る**（2026-09-18、CIで落ちた）。

  `setUp()` は本物のgitを子プロセスで何度も起動して、作業用の倉庫を
  2つ作り直す。下の `describe` には 30 秒を与えてあるが、**`describe` の外に
  書いたフックには効かない**——`beforeEach` の既定は 10 秒で、**手元では
  通るのにCIの遅い機械で並列に走ると超える**（実際 `Hook timed out in
  10000ms` で落ちた。手元は全体40秒、CIは99秒かかる）。

  下のテスト本体と同じ理由・同じ値にしてある。**処理が遅いのではなく
  起動が重いので、待ちだけ伸ばす。**
*/
beforeEach(() => {
  answers.length = 0;
  shown.length = 0;
  setUp();
}, 30_000);

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

    answers.push("そろえる");
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

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(git(root, "branch", "--list", "backup/*")).toContain("backup/");
  });

  test("未記録の変更は、合わせる前に記録する", async () => {
    // 汚れたままではマージを始められない。**書きかけを失わせない**
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");
    write(root, "短編/本文/第3話.txt", "書きかけ。\n");

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第3話.txt"), "utf8")).toBe(
      "書きかけ。\n"
    );
  });

  test("同じ原稿が両方で書き換えられていたら、作者に選ばせる（設計書5.5.18）", async () => {
    // **どちらを残すかは、書いた本人にしか分からない**（設計書5.5.4）。
    // 0.45.0 からは、そこで手を引かずに1件ずつ選ばせる。
    // ここでは見比べの画面を用意していないので、取りやめて元へ戻る
    pushFromOtherMachine([["短編/本文/第1話.txt", "むこうの直し。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちらの直し。\n"]], "こちらで直した");

    answers.push("そろえる");
    await resolveDivergence(deps());

    // 分かれたまま。原稿はこちらのまま
    expect(status()).toContain("ahead 1, behind 1");
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第1話.txt"), "utf8")).toBe(
      "こちらの直し。\n"
    );
    // **押す前に、選ぶことになると言ってある**
    expect(shown.join("\n")).toContain("残すほうを選んでください");
  });

  test("自動で書かれるものだけの食い違いなら、この端末の側を残して合わせる", async () => {
    // 執筆量の記録は端末ごとで、読み込むときに合算する（設計書5.5.6）
    pushFromOtherMachine([["短編/.aiwriter/stats/pc.json", '{"at":"むこう"}\n']]);
    commitHere([["短編/.aiwriter/stats/pc.json", '{"at":"こちら"}\n']], "こちらの記録");

    answers.push("そろえる");
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

    answers.push("そろえる");
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

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(status()).not.toContain("behind");
    // 触っていない原稿は1バイトも変わっていない
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第1話.txt"))).toEqual(
      触らない原稿
    );
  });

  test("分かれていなければ、何もしない", async () => {
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(shown.join("\n")).toContain("2台の原稿がそろっています");
    // 取り込みもしない（それは「同期」の仕事である）
    expect(fs.existsSync(nodePath.join(root, "短編/本文/第2話.txt"))).toBe(false);
  });

  test("そろえても、その場では送らない。送るのは自動の送り直しで、そう知らせる", async () => {
    // この関数は push しない（設計書5.5.1）。そろえた記録は「送っていない記録」になり、
    // 自動の送り直しが数分のうちに送る（2026-10-11、窓に「送りません」と書いて
    // あったのに送られていた。**知らせを事実に合わせる**）
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(status()).toContain("ahead");
    // 設定が読めない試験の場では、既定（送り直しが入っている）として扱う
    expect(shown.join("\n")).toContain("数分のうちに自動でGitHubへ送ります");
    expect(shown.join("\n")).not.toContain("送りません");
  });
});

/**
 * 押す前に見せる中身（実機確認リスト A-17。作者の裁定で書き直し、2026-10-11）。
 *
 * **確認の画面が出ること自体は実機に残る。** ここで見るのは、出たときに
 * 「何が起き、作者が何を選ぶことになり、GitHubへ送るのか」が書いてあるかである。
 * 自動で書かれるもの・履歴・設定資料の内訳は、窓から外して作品のログへ回した
 * （窓に並べると、どこを読めばよいか分からない）。
 */
describe("そろえる前の確認に出す中身", () => {
  const 基本 = {
    label: "確認用コピー",
    behind: 3,
    ahead: 2,
    autoWritten: 0,
  };

  test("自動の送り直しが入っていれば、そろえて送ると言う", () => {
    const text = describeDivergenceConfirm({ ...基本, manuscripts: 1, autoResend: true });

    expect(text.message).toBe("「確認用コピー」：2台の原稿をそろえて、GitHubへ送ります。");
    expect(text.detail).toBe(
      [
        "もう1台で書いた分を入れ、このパソコンで書いた分も残します。",
        "同じところを両方で書き換えた原稿が 1件あります。このあと両方の文を並べるので、残すほうを選んでください。",
        "そろえ終わったら、数分のうちに自動でGitHubへ送ります。",
        "",
        "途中でやめれば、原稿は元のままです。そろえたあとでも「そろえる前」へ戻せます。",
      ].join("\n")
    );
  });

  test("自動の送り直しが切ってあれば、送らないと言い、送り方を示す", () => {
    const text = describeDivergenceConfirm({ ...基本, autoResend: false });

    expect(text.message).toBe("「確認用コピー」：2台の原稿をそろえます。");
    expect(text.detail).toContain(
      "GitHubへは送りません。送るときは「保存・同期」を押してください。"
    );
    expect(text.detail).not.toContain("自動でGitHubへ送ります");
  });

  test("選ぶ原稿が無ければ、選ぶ行を出さない", () => {
    const text = describeDivergenceConfirm({ ...基本, autoResend: true });

    expect(text.detail).not.toContain("残すほうを選んでください");
  });

  test("内訳（自動で書かれるもの・追記型・設定資料）は窓に出さない", () => {
    const text = describeDivergenceConfirm({
      ...基本,
      autoWritten: 4,
      appendOnly: 3,
      settings: 2,
      autoResend: true,
    });

    expect(text.detail).not.toContain("自動で書かれるもの");
    expect(text.detail).not.toContain("追記型");
    expect(text.detail).not.toContain("設定資料");
  });

  test("窓から外した内訳は、ログへ1行で残す", () => {
    const line = describeDivergenceBreakdown({
      ...基本,
      autoWritten: 4,
      appendOnly: 3,
      settings: 2,
      settingsToChoose: 1,
      manuscripts: 5,
    });

    expect(line).toContain("自動で書かれるもの 4件");
    expect(line).toContain("追記型 3件");
    expect(line).toContain("設定資料 2件（作者が選ぶ 1件）");
    expect(line).toContain("作者が選ぶ原稿 5件");
    expect(line).not.toContain("\n");
  });

  test("作者の目に触れる文に、開発の言葉（分岐・環境・枝）を出さない", () => {
    const text = describeDivergenceConfirm({
      ...基本,
      settingsToChoose: 2,
      manuscripts: 1,
      autoResend: true,
    });
    const all = [text.message, text.detail, ...text.buttons].join("\n");

    for (const word of ["分岐", "環境", "枝", "合わせる"]) {
      expect(all).not.toContain(word);
    }
  });

  /*
    確認［そろえる］と見比べの入口の窓を1つにまとめる（作者の裁定、2026-10-01 案2）。
    「分岐合流」から入ったときも、窓は1つで済むようにする
  */
  test("選ぶ設定資料があれば、確認の窓に選び方のボタンを並べ、その意味を1行だけ残す", () => {
    const text = describeDivergenceConfirm({
      ...基本,
      settingsToChoose: 2,
      manuscripts: 1,
      autoResend: true,
    });

    expect(text.buttons).toEqual([
      "そろえる（設定資料は新しいほうへ）",
      "そろえる（1件ずつ選ぶ）",
    ]);
    expect(text.detail).toContain(
      "作者が書いたところが両方で違う設定資料が 2件あります。下のボタンで決め方を選んでください。"
    );
    expect(text.detail).toContain("途中でやめれば");
  });

  test("選ぶ設定資料が無ければ、ボタンは「そろえる」1つ", () => {
    const text = describeDivergenceConfirm({
      ...基本,
      settings: 3,
      manuscripts: 1,
      autoResend: true,
    });

    expect(text.buttons).toEqual(["そろえる"]);
  });
});

/**
 * 同期の中で自動で合流する（設計書5.5.18）。
 *
 * 作者の指示（2026-09-10）：「設定資料ファイルは作者が書き換えた部分が
 * 変わっていなければ、時系列的に新しいほうに自動で合わせてください。
 * 本文も同じ個所の衝突がなければ、自動で合流させる」。
 *
 * **確認の画面を挟まない `foldDivergence` を直に動かす。** 作者に選ばせる
 * ところだけ差し替えて、規則の分岐が本物のgitでどう決まるかを見る。
 */
describe("設定資料と本文の自動合流", { timeout: 30_000 }, () => {
  const 人物ファイル = "短編/設定/characters/char_001_太志.json";

  /** 1人ぶんのJSON。作者が書く部分と、AIが書く部分を分けて渡す */
  function 人物(input: {
    summary: string;
    authorNotes?: string;
    updatedAt: string;
    autoGenerated?: boolean;
  }): string {
    return `${JSON.stringify(
      {
        schemaVersion: "0.1",
        id: "char_001",
        name: "太志",
        summary: input.summary,
        appearedChapters: [1],
        authorNotes: input.authorNotes ?? "",
        exportNote: "",
        autoGenerated: input.autoGenerated ?? true,
        updatedAt: input.updatedAt,
      },
      null,
      2
    )}\n`;
  }

  /** 種を置いてから分岐を作る */
  function 分岐を作る(seedFiles: Array<[string, string]>, other: Array<[string, string]>, here: Array<[string, string]>): void {
    commitHere(seedFiles, "土台");
    git(root, "push", "-q", "origin", "main");
    pushFromOtherMachine(other);
    commitHere(here, "こちらで直した");
    git(root, "fetch", "-q");
  }

  function 合わせる(walk?: ConflictWalker) {
    return foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      walk ? { walk } : {}
    );
  }

  /** 作者の代わりに「こちら」を選ぶ。**gitへの書き戻しまで本物と同じにする** */
  const こちらを選ぶ: ConflictWalker = async ({ root: cwd, files }) => {
    for (const file of files) {
      git(cwd, "checkout", "--ours", "--", file);
      git(cwd, "add", "--", file);
    }
    return { resolved: [...files], bulkResolved: [], aborted: false };
  };

  /** 作者が途中でやめる */
  const やめる: ConflictWalker = async () => ({
    resolved: [],
    bulkResolved: [],
    aborted: true,
  });

  test("作者が書いた部分が同じなら、更新時刻の新しいほうへ揃える", async () => {
    分岐を作る(
      [[人物ファイル, 人物({ summary: "もとの紹介", updatedAt: "2026-09-01T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "むこうの紹介", updatedAt: "2026-09-05T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "こちらの紹介", updatedAt: "2026-09-03T00:00:00.000Z" })]]
    );

    const result = await 合わせる();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settingsAutoResolved).toHaveLength(1);
    expect(result.settingsAutoResolved[0].side).toBe("theirs");
    // 新しいほう（別環境）の紹介文が残り、記録まで済んでいる
    expect(fs.readFileSync(nodePath.join(root, 人物ファイル), "utf8")).toContain(
      "むこうの紹介"
    );
    expect(status()).not.toContain("behind");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("両方で作者メモを変えたら、作者に選ばせる", async () => {
    // **ここを緩めると、作者が手で書いた値をAIの読みが押し流す**
    分岐を作る(
      [[人物ファイル, 人物({ summary: "もと", updatedAt: "2026-09-01T00:00:00.000Z" })]],
      [
        [
          人物ファイル,
          人物({
            summary: "もと",
            authorNotes: "むこうのメモ",
            updatedAt: "2026-09-05T00:00:00.000Z",
          }),
        ],
      ],
      [
        [
          人物ファイル,
          人物({
            summary: "もと",
            authorNotes: "こちらのメモ",
            updatedAt: "2026-09-03T00:00:00.000Z",
          }),
        ],
      ]
    );

    const result = await 合わせる(こちらを選ぶ);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 規則では決めていない。**作者が選んだものとして数える**
    expect(result.settingsAutoResolved).toHaveLength(0);
    expect(result.manuscriptConflicts).toEqual([人物ファイル]);
    expect(fs.readFileSync(nodePath.join(root, 人物ファイル), "utf8")).toContain(
      "こちらのメモ"
    );
    expect(status()).not.toContain("behind");
  });

  test("同じ資料の別々の項目が変わっただけなら、両方を合わせて訊かない（案3）", async () => {
    分岐を作る(
      [[人物ファイル, 人物({ summary: "もと", updatedAt: "2026-09-01T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "むこうの紹介", updatedAt: "2026-09-05T00:00:00.000Z" })]],
      [
        [
          人物ファイル,
          人物({ summary: "もと", authorNotes: "こちらのメモ", updatedAt: "2026-09-03T00:00:00.000Z" }),
        ],
      ]
    );
    const walked: string[][] = [];

    const result = await 合わせる(async (input) => {
      walked.push(input.files);
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(walked).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settingsAutoResolved.map((one) => one.side)).toEqual(["merged"]);
    const merged = JSON.parse(
      fs.readFileSync(nodePath.join(root, 人物ファイル), "utf8")
    ) as Record<string, unknown>;
    expect(merged.summary).toBe("むこうの紹介");
    expect(merged.authorNotes).toBe("こちらのメモ");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("確認の窓で選んだ選び方を、見比べへそのまま渡す（案2）", async () => {
    分岐を作る(
      [[人物ファイル, 人物({ summary: "もと", updatedAt: "2026-09-01T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "もと", authorNotes: "むこうのメモ", updatedAt: "2026-09-05T00:00:00.000Z" })]],
      [[人物ファイル, 人物({ summary: "もと", authorNotes: "こちらのメモ", updatedAt: "2026-09-03T00:00:00.000Z" })]]
    );
    const starts: unknown[] = [];

    await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      {
        start: "newest",
        walk: async (input) => {
          starts.push(input.start);
          return こちらを選ぶ(input);
        },
      }
    );

    expect(starts).toEqual(["newest"]);
  });

  test("作者が途中でやめたら、全部戻す", async () => {
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );

    const result = await 合わせる(やめる);

    expect(result.ok).toBe(false);
    // 作業ツリーは元どおり。**半分だけ入れ替わった状態を作らない**
    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect(
      fs.readFileSync(nodePath.join(root, "短編/本文/第5話.txt"), "utf8")
    ).toBe("こちらの直し。\n");
    expect(status()).toContain("ahead");
    expect(status()).toContain("behind");
  });

  /*
    「両方とも残す」の別ファイル（作者の裁定、2026-10-11「一緒に送る」）。

    それまでは別ファイルを作るだけで記録に入れず、そろえた記録にも
    GitHubにも乗らなかった（もう1台では写しが見えない）。
    **足すのは記録の直前**——選んだ直後に足すと、途中でやめたときの
    `merge --abort` が索引ごと戻し、別ファイルが消えうる。
  */
  const 写し = "短編/本文/第5話.conflict-2026-10-11-0045.txt";
  /** 作者の代わりに「両方とも残す」を選ぶ。別ファイルを作り、索引には足さない */
  function 両方とも残す(aborted: boolean): ConflictWalker {
    return async ({ root: cwd, files }) => {
      write(cwd, 写し, "むこうの直し。\n");
      if (!aborted) {
        for (const file of files) {
          git(cwd, "checkout", "--ours", "--", file);
          git(cwd, "add", "--", file);
        }
      }
      return {
        resolved: aborted ? [] : [...files],
        bulkResolved: [],
        sideFiles: [写し],
        aborted,
      };
    };
  }

  test("両方とも残した別ファイルは、そろえた記録に入る（GitHubへ一緒に送る）", async () => {
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );

    const result = await 合わせる(両方とも残す(false));

    expect(result.ok).toBe(true);
    // 合流の記録は `show --name-only` では何も出さないので、こちら側の親と比べる
    expect(
      git(root, "-c", "core.quotepath=false", "diff", "--name-only", "HEAD^1", "HEAD")
    ).toContain(
      "第5話.conflict-2026-10-11-0045.txt"
    );
    // 記録しそびれた物が無い
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("途中でやめても、作った別ファイルは作業フォルダーに残る", async () => {
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );

    const result = await 合わせる(両方とも残す(true));

    expect(result.ok).toBe(false);
    // 原稿は元どおり、写しは消えずに残る（記録には入っていない）
    expect(
      fs.readFileSync(nodePath.join(root, "短編/本文/第5話.txt"), "utf8")
    ).toBe("こちらの直し。\n");
    expect(fs.readFileSync(nodePath.join(root, 写し), "utf8")).toBe(
      "むこうの直し。\n"
    );
    expect(git(root, "status", "--porcelain").trim()).toMatch(/^\?\?/);
  });

  test("（裏づけ）合流の途中で索引へ足した新しいファイルは、やめると消える", async () => {
    // 足す位置を記録の直前まで遅らせた理由。`merge --abort` は索引に載った
    // ものを作業ツリーごと戻すので、選んだ直後に足すと写しが消える
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );
    try {
      git(root, "merge", "--no-commit", "--no-ff", "origin/main");
    } catch {
      // 衝突で止まるのが正しい
    }
    write(root, 写し, "むこうの直し。\n");
    git(root, "add", "--", 写し);
    git(root, "merge", "--abort");

    expect(fs.existsSync(nodePath.join(root, 写し))).toBe(false);
  });

  test("選ぶ画面へ進まない指定なら、画面を開かずに戻し、使わなかった枝を消す", async () => {
    // 開いたときの点検が使う（設計書6.15.1。作者が何も押していない）
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );
    let walked = false;
    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      {
        authorChoice: "stop",
        walk: async () => {
          walked = true;
          return { resolved: [], bulkResolved: [], aborted: true };
        },
      }
    );

    expect(walked).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.authored).toEqual(["短編/本文/第5話.txt"]);
    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect(
      fs.readFileSync(nodePath.join(root, "短編/本文/第5話.txt"), "utf8")
    ).toBe("こちらの直し。\n");
    // 先頭が動いていないので、退避の枝は要らない（開くたびに増やさない）
    expect(git(root, "branch", "--list", "backup/*").trim()).toBe("");
  });

  test("選ぶ画面へ進まない指定でも、自動保存で記録が進んだら枝は残す", async () => {
    分岐を作る(
      [["短編/本文/第5話.txt", "もとの本文。\n"]],
      [["短編/本文/第5話.txt", "むこうの直し。\n"]],
      [["短編/本文/第5話.txt", "こちらの直し。\n"]]
    );
    write(root, "短編/本文/第9話.txt", "書きかけ。\n");

    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      { authorChoice: "stop" }
    );

    expect(result.ok).toBe(false);
    // 書きかけは記録されて残り、記録する前へ戻れる枝もある
    expect(
      fs.readFileSync(nodePath.join(root, "短編/本文/第9話.txt"), "utf8")
    ).toBe("書きかけ。\n");
    expect(git(root, "branch", "--list", "backup/*")).toContain("backup/");
  });

  test("本文の同じ行を両方で書き換えたら、作者に選ばせる", async () => {
    分岐を作る(
      [["短編/本文/第6話.txt", "もとの一行。\n"]],
      [["短編/本文/第6話.txt", "むこうの一行。\n"]],
      [["短編/本文/第6話.txt", "こちらの一行。\n"]]
    );

    const result = await 合わせる(こちらを選ぶ);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manuscriptConflicts).toEqual(["短編/本文/第6話.txt"]);
  });

  test("本文の別の場所なら、そのまま合流する", async () => {
    // **git が合流できるものは、作者に訊かない**（作者の指示、2026-09-10）
    分岐を作る(
      [["短編/本文/第7話.txt", ["一行目", "二行目", "三行目", "四行目", "五行目"].join("\n") + "\n"]],
      [["短編/本文/第7話.txt", ["一行目（むこう）", "二行目", "三行目", "四行目", "五行目"].join("\n") + "\n"]],
      [["短編/本文/第7話.txt", ["一行目", "二行目", "三行目", "四行目", "五行目（こちら）"].join("\n") + "\n"]]
    );

    // **選ばせる関数は呼ばれてはならない**
    let 呼ばれた = false;
    const result = await 合わせる(async () => {
      呼ばれた = true;
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(呼ばれた).toBe(false);
    expect(result.ok).toBe(true);
    const 本文 = fs.readFileSync(
      nodePath.join(root, "短編/本文/第7話.txt"),
      "utf8"
    );
    expect(本文).toContain("一行目（むこう）");
    expect(本文).toContain("五行目（こちら）");
  });

  /**
   * 追記型（履歴・提案・ロック）は、作者に訊かずに両方の行を残す（2026-09-11）。
   *
   * 作者の手元で13作品ぶんの分岐が起き、これらが1件ずつの見比べに混ざって
   * 抜けられなくなった。**どちらを残すかを訊かれても、答えは「両方」しか無い**
   * （`core/editHistory.ts`）。
   */
  test("追記型の記録がぶつかったら、両方の行を残して確定する", async () => {
    const 履歴 = "短編/.aiwriter/history/edits.jsonl";
    const もと = '{"time":"2026-09-01T00:00:00.000Z","action":"土台"}\n';
    分岐を作る(
      [[履歴, もと]],
      [[履歴, もと + '{"time":"2026-09-05T00:00:00.000Z","action":"むこうで直した"}\n']],
      [[履歴, もと + '{"time":"2026-09-03T00:00:00.000Z","action":"こちらで直した"}\n']]
    );

    // **選ばせる関数は呼ばれてはならない**
    let 呼ばれた = false;
    const result = await 合わせる(async () => {
      呼ばれた = true;
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(呼ばれた).toBe(false);
    expect(result.ok).toBe(true);
    const 中身 = fs.readFileSync(nodePath.join(root, 履歴), "utf8");
    expect(中身).toContain("むこうで直した");
    expect(中身).toContain("こちらで直した");
    // 土台の1行は両側にあるが、**同じ行は1つに畳む**
    expect(中身.trim().split("\n")).toHaveLength(3);
    // 競合マーカーは持ち込まない
    expect(中身).not.toContain("<<<<<<<");
    expect(status()).not.toContain("behind");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("追記型の片方の版が無ければ、ある側の行を残す", async () => {
    // 追加と削除がぶつかった形。**消さずに、残っている側を採る**
    const ロック = "短編/.aiwriter/locks/locks.jsonl";
    const もと = '{"file":"第1話.txt","by":"編集部"}\n';
    commitHere([[ロック, もと]], "土台");
    git(root, "push", "-q", "origin", "main");
    pushFromOtherMachine([], [ロック]);
    commitHere(
      [[ロック, もと + '{"file":"第2話.txt","by":"編集部"}\n']],
      "こちらで足した"
    );
    git(root, "fetch", "-q");

    let 呼ばれた = false;
    const result = await 合わせる(async () => {
      呼ばれた = true;
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(呼ばれた).toBe(false);
    expect(result.ok).toBe(true);
    const 中身 = fs.readFileSync(nodePath.join(root, ロック), "utf8");
    expect(中身).toContain("第1話.txt");
    expect(中身).toContain("第2話.txt");
    expect(status()).not.toContain("behind");
  });

  /**
   * `history/` の下の記録は、編集履歴に限らずすべて書き足すだけである
   * （MCPの利用とノックの `external.jsonl`、AIの指摘への判断 `ai-verdicts.jsonl`）。
   *
   * 作者の手元で、2台がそれぞれ `external.jsonl` へ1行ずつ足して分かれ、
   * 開くたびに「競合マーカーが残っていました」で戻され続けた（2026-09-28）。
   * **開いたときの点検と同じ指定**（選ぶ画面へ進まない・自動）で確かめる。
   */
  test.each([
    "短編/.aiwriter/history/external.jsonl",
    "短編/.aiwriter/history/ai-verdicts.jsonl",
  ])("history の記録（%s）が両方で書き足されても、両方の行を残して合わせる", async (記録) => {
    const もと = '{"at":"2026-09-01T00:00:00.000Z","tool":"土台"}\n';
    分岐を作る(
      [[記録, もと]],
      [[記録, もと + '{"at":"2026-09-05T00:00:00.000Z","tool":"むこうの機械"}\n']],
      [[記録, もと + '{"at":"2026-09-03T00:00:00.000Z","tool":"こちらの機械"}\n']]
    );

    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      { authorChoice: "stop", automatic: true }
    );

    expect(result).toMatchObject({ ok: true });
    const 中身 = fs.readFileSync(nodePath.join(root, 記録), "utf8");
    expect(中身).toContain("むこうの機械");
    expect(中身).toContain("こちらの機械");
    expect(中身.trim().split("\n")).toHaveLength(3);
    expect(中身).not.toContain("<<<<<<<");
    expect(status()).not.toContain("behind");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("競合の印ごと記録された history の記録が届いたら、印の行だけ落として両方の行を残す", async () => {
    // 以前に別の道具で合わせたとき、印が残ったまま記録されて届く形。
    // 衝突にはならないので、上の片づけを通らず検査で止まっていた
    const 記録 = "短編/.aiwriter/history/external.jsonl";
    const もと = '{"tool":"土台"}\n';
    const 印つき = [
      '{"tool":"土台"}',
      "<<<<<<< HEAD",
      '{"tool":"むこうの機械"}',
      "=======",
      '{"tool":"こちらの機械"}',
      ">>>>>>> origin/main",
      "",
    ].join("\n");
    分岐を作る([[記録, もと]], [[記録, 印つき]], [["短編/本文/第2話.txt", "こちら。\n"]]);

    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      { authorChoice: "stop", automatic: true }
    );

    expect(result).toMatchObject({ ok: true });
    const 中身 = fs.readFileSync(nodePath.join(root, 記録), "utf8");
    expect(中身).toBe(
      '{"tool":"土台"}\n{"tool":"むこうの機械"}\n{"tool":"こちらの機械"}\n'
    );
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("競合の印つきで届いた本文は、これまでどおり止めて戻す（検査を緩めない）", async () => {
    const 本文 = "短編/本文/第3話.txt";
    const 印つき = ["<<<<<<< HEAD", "むこう。", "=======", "こちら。", ">>>>>>> x", ""].join("\n");
    分岐を作る([[本文, "もと。\n"]], [[本文, 印つき]], [["短編/本文/第2話.txt", "こちら。\n"]]);

    const result = await foldDivergence(
      deps(),
      { root, label: "短編", upstream: "origin/main" },
      { authorChoice: "stop", automatic: true }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("競合マーカー");
    expect(fs.readFileSync(nodePath.join(root, 本文), "utf8")).toBe("もと。\n");
    expect(status()).toContain("behind");
  });

  test("承認待ちの提案がぶつかったら、この端末の側を残す", async () => {
    // AIの提案で、まだ資料になっていない。**作り直せるので訊かない**（5.5.18）
    const 提案 = "短編/.aiwriter/pending-characters/char_001.json";
    分岐を作る(
      [[提案, '{"name":"もと"}\n']],
      [[提案, '{"name":"むこう"}\n']],
      [[提案, '{"name":"こちら"}\n']]
    );

    let 呼ばれた = false;
    const result = await 合わせる(async () => {
      呼ばれた = true;
      return { resolved: [], bulkResolved: [], aborted: true };
    });

    expect(呼ばれた).toBe(false);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(nodePath.join(root, 提案), "utf8")).toBe(
      '{"name":"こちら"}\n'
    );
  });
});

// 本物のgitを起動するので、上の describe と同じだけ待つ
describe("本物のリポジトリでも、確認の窓が出る", { timeout: 30_000 }, () => {
  test("実際に2台で書き進めた状態で、そろえる確認が出る（実機確認リスト A-17 の代わり）", async () => {
    // 作り物の入力ではなく、**gitが数えた ahead / behind** から窓まで届くかを見る。
    // 件数は窓から外して作品のログへ回した（作者の裁定、2026-10-11）
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");

    await resolveDivergence(deps());

    expect(shown.join("\n")).toContain("「短編」：2台の原稿をそろえて、GitHubへ送ります。");
    expect(shown.join("\n")).toContain(
      "もう1台で書いた分を入れ、このパソコンで書いた分も残します。"
    );
  });
});

/**
 * 済んだあとの知らせ（2026-09-11。文は作者の裁定で書き直し、2026-10-11）。
 *
 * 作者が13件を「全部、新しいほうを採る」で片づけたのに、
 * 「本文など13件はお選びいただきました」と出ていた。
 * **やっていないことを、やったと言わない。** 画面を出さずに文面だけ確かめる。
 */
describe("そろえた結果の知らせ", () => {
  function 結果(input: {
    bulk?: number;
    picked?: string[];
    auto?: Array<"ours" | "theirs" | "merged">;
  }) {
    return {
      ok: true as const,
      backup: "backup/2026-09-11-101112-合わせる前",
      incoming: 4,
      settingsAutoResolved: (input.auto ?? []).map((side, index) => ({
        file: `短編/設定/characters/char_00${index + 1}.json`,
        side,
        reason: "作者の書いた部分が同じ",
      })),
      settingsBulkResolved: input.bulk ?? 0,
      manuscriptConflicts: input.picked ?? [],
    };
  }

  test("作者の裁定どおりの文になる（自動の送り直しが入っているとき）", () => {
    const text = describeFoldSuccess(
      "確認用コピー",
      結果({ picked: ["確認用コピー/本文/episode_9999_同期の確認.md"] }),
      { sending: false, autoResend: true }
    );

    expect(text).toBe(
      "「確認用コピー」の2台の原稿をそろえました" +
        "（もう1台から入れたファイル 4件／選んでいただいた原稿 1件）。" +
        "数分のうちに自動でGitHubへ送ります。" +
        "そろえる前へ戻したいときは、控え「backup/2026-09-11-101112-合わせる前」から戻せます。"
    );
  });

  test("自動の送り直しが切ってあれば、送り方を示す", () => {
    const text = describeFoldSuccess("短編", 結果({}), {
      sending: false,
      autoResend: false,
    });

    expect(text).toContain("GitHubへは「保存・同期」で送ります。");
    expect(text).not.toContain("自動でGitHubへ送ります");
  });

  test("同期の流れの中なら、続けて送ると言う", () => {
    expect(describeFoldSuccess("短編", 結果({}), { sending: true })).toContain(
      "続けてGitHubへ送ります。"
    );
  });

  test("一括だけなら、選んだとは言わない", () => {
    const text = describeFoldSuccess("短編", 結果({ bulk: 13 }));

    expect(text).toContain("設定資料 13件は、まとめて新しいほうを採りました");
    expect(text).not.toContain("選んでいただいた");
  });

  test("手選びだけなら、選んだ件数だけ", () => {
    const text = describeFoldSuccess(
      "短編",
      結果({ picked: ["短編/本文/第1話.txt", "短編/本文/第2話.txt"] })
    );

    expect(text).toContain("選んでいただいた原稿 2件");
    expect(text).not.toContain("新しいほうを採りました");
  });

  test("両方あれば、両方を別々に数える", () => {
    const text = describeFoldSuccess(
      "短編",
      結果({ bulk: 13, picked: ["短編/本文/第1話.txt"] })
    );

    expect(text).toContain("設定資料 13件は、まとめて新しいほうを採りました");
    expect(text).toContain("選んでいただいた原稿 1件");
  });

  test("どちらも無ければ、入れた件数だけ", () => {
    const text = describeFoldSuccess("短編", 結果({}));

    expect(text).toContain("もう1台から入れたファイル 4件");
    expect(text).not.toContain("新しいほうを採りました");
    expect(text).not.toContain("選んでいただいた");
  });

  test("規則で揃えた分とは、別の言い方で並べる", () => {
    // 規則（`settingsConflictRule`）で決めた分と、入口で一括に寄せた分は
    // **別の経路**である。同じ数え方に畳むと、どちらが起きたのか分からない
    const text = describeFoldSuccess(
      "短編",
      結果({ auto: ["theirs", "ours", "merged"], bulk: 13 })
    );

    expect(text).toContain(
      "設定資料 3件は新しいほうにそろえました（うち両方の変更を合わせた 1件）"
    );
    expect(text).toContain("設定資料 13件は、まとめて新しいほうを採りました");
  });

  test("作者の目に触れる文に、開発の言葉（分岐・環境）を出さない", () => {
    const text = describeFoldSuccess(
      "短編",
      結果({ auto: ["theirs"], bulk: 1, picked: ["短編/本文/第1話.txt"] }),
      { sending: false, autoResend: true }
    );
    expect(text).not.toContain("分岐");
    expect(text).not.toContain("環境");
  });
});

/**
 * 選ばずにやめたときの文（2026-10-11）。
 *
 * それまでは「もう一度同期すると、続きから選べます」と書いていた。実際には
 * やめると `merge --abort` で全部戻るので、**次は最初から選び直し**になる。
 */
describe("選ばずにやめたときの知らせ", () => {
  test("「続きから」とは言わず、最初から選び直すと言う", () => {
    const text = describeAuthoredStop(["短編/本文/第1話.txt", "短編/設定/x.json"]);

    expect(text).not.toContain("続きから");
    expect(text).toContain("そろえるのをやめて、元のままにしました。");
    expect(text).toContain("最初から選び直せます");
    expect(text).toContain("（第1話.txt、x.json）");
  });
});
