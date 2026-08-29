import { describe, expect, test, vi } from "vitest";
import * as path from "node:path";
import {
  cliCandidates,
  decideLoadContextLength,
  describeLoadFailure,
  describeStartFailure,
  isLocalEndpoint,
  loadLmStudioModel,
  resolveCli,
  serverPort,
  startLmStudioServer,
  type CliOutcome,
  type LoadCliOutcome,
} from "../../src/ai/lmstudioLauncher";

/**
 * LM Studioのサーバーを、拡張機能から起動する（作者の依頼、2026-08-29：
 * 「LMスタジオの起動をOllamaと同じ形でお願いします」）。
 *
 * **本物の `lms` は起こさない。** 起動処理は `runCli` を差し替えて確かめる。
 * 実プロセスを起こすと、この機械にLM Studioが入っているかどうかで
 * 結果が変わってしまう。
 */

/**
 * 明示指定として渡す、実在するファイル。
 *
 * `resolveCli` は明示指定を存在確認するので、実在しない名前を渡すと
 * 起動処理まで届かない。**起動はしない**（`runCli` を差し替えている）ので、
 * 中身が何であるかは関係ない
 */
const EXISTING_CLI = process.execPath;

/** `lms` を起こしたことにする。終わり方だけを決める */
function fakeCli(outcome: CliOutcome): {
  run: (cli: string, args: string[]) => Promise<CliOutcome>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    run: async (cli, args) => {
      calls.push([cli, ...args]);
      return outcome;
    },
    calls,
  };
}

describe("起動してよい接続先の判定", () => {
  test("ollamaLauncher と同じ判定を使い回している", () => {
    // 写しを作っていないことの確認。同じ規則が2か所にあると片方だけ直る
    expect(isLocalEndpoint("http://localhost:1234/v1")).toBe(true);
    expect(isLocalEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalEndpoint("http://192.168.1.20:1234/v1")).toBe(false);
  });
});

describe("lms コマンドの探索", () => {
  test("Windowsでは既定の置き場所をPATHより先に見る", () => {
    // LM StudioがPATHへ通すのは初回の「CLIを有効化」のあと。
    // 先にPATHを見ると、入っているのに「見つかりません」になる
    const candidates = cliCandidates("win32", {}, "C:\\Users\\test");

    expect(candidates[0]).toBe(
      path.join("C:\\Users\\test", ".lmstudio", "bin", "lms.exe")
    );
    expect(candidates[1]).toBe("lms");
  });

  test("Mac / Linux では拡張子の無い lms を同じ順で見る", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const candidates = cliCandidates(platform, {}, "/Users/test");

      expect(candidates[0]).toBe(
        path.join("/Users/test", ".lmstudio", "bin", "lms")
      );
      expect(candidates[1]).toBe("lms");
    }
  });

  test("パス区切りを含まない候補は存在確認せずPATH解決に任せる", async () => {
    await expect(resolveCli(undefined, ["lms"])).resolves.toBe("lms");
  });

  test("設定で指定された場所が無ければ未検出として扱う", async () => {
    // **明示指定は候補で埋め合わせない。** 作者が指定した以上、
    // 別のものを黙って使うと、どちらが動いているのか分からなくなる
    await expect(resolveCli("C:\\no\\such\\lms.exe")).resolves.toBeUndefined();
  });

  test("存在しない絶対パス候補は飛ばす", async () => {
    await expect(
      resolveCli(undefined, [path.join("C:\\no\\such", "lms.exe"), "lms"])
    ).resolves.toBe("lms");
  });
});

describe("接続先からポートを読む", () => {
  test("URLに書かれたポートを使う", () => {
    expect(serverPort("http://localhost:1234/v1")).toBe(1234);
    expect(serverPort("http://127.0.0.1:5678/v1")).toBe(5678);
  });

  test("ポートが無ければ既定の1234", () => {
    expect(serverPort("http://localhost/v1")).toBe(1234);
  });

  test("URLとして壊れていても既定へ落とす", () => {
    // ここで例外を出すと、設定を書き損じただけで起動の道が消える
    expect(serverPort("localhost:1234")).toBe(1234);
    expect(serverPort("")).toBe(1234);
  });
});

describe("サーバーの起動", () => {
  test("lms が見つからなければ起動を試みない", async () => {
    const probe = vi.fn(async () => false);
    const cli = fakeCli({ kind: "exited", code: 0 });

    const outcome = await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: "C:\\no\\such\\lms.exe",
      probe,
      runCli: cli.run,
    });

    expect(outcome).toEqual({ ok: false, reason: "not_installed" });
    expect(cli.calls).toHaveLength(0);
    expect(probe).not.toHaveBeenCalled();
  });

  test("設定した接続先のポートを指定して起動する", async () => {
    // ポートを省くとLM Studio側の既定になり、設定した接続先と食い違ったまま
    // 「応答しない」になる
    const cli = fakeCli({ kind: "exited", code: 0 });

    await startLmStudioServer({
      endpoint: "http://localhost:5678/v1",
      cliPath: EXISTING_CLI,
      probe: async () => true,
      runCli: cli.run,
    });

    expect(cli.calls[0]).toEqual([
      EXISTING_CLI,
      "server",
      "start",
      "--port",
      "5678",
    ]);
  });

  test("応答するまで待ってから成功を返す", async () => {
    // 起動を指示しても、待ち受けを始めるまでには間がある
    let calls = 0;
    const probe = vi.fn(async () => {
      calls++;
      return calls >= 3;
    });

    const outcome = await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: EXISTING_CLI,
      timeoutMs: 10000,
      probe,
      runCli: fakeCli({ kind: "exited", code: 0 }).run,
    });

    expect(outcome).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  test("待っても応答しなければタイムアウトとして返す", async () => {
    const probe = vi.fn(async () => false);

    const outcome = await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: EXISTING_CLI,
      timeoutMs: 1200,
      probe,
      runCli: fakeCli({ kind: "exited", code: 0 }).run,
    });

    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    expect(probe.mock.calls.length).toBeGreaterThan(0);
  });

  test("コマンドが見つからない（ENOENT）は未インストールとして扱う", async () => {
    // PATH頼みの候補は存在確認をしていないので、通っていない機械では
    // ここで分かる。「起動できませんでした」より「入っていません」が正しい
    const outcome = await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: EXISTING_CLI,
      probe: async () => false,
      runCli: fakeCli({ kind: "error", message: "spawn lms ENOENT" }).run,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "not_installed" });
  });

  test("起動そのものに失敗したら理由を添えて返す", async () => {
    const outcome = await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: EXISTING_CLI,
      probe: async () => false,
      runCli: fakeCli({ kind: "error", message: "EACCES" }).run,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "spawn_failed",
      detail: "EACCES",
    });
  });

  test("終了コードが0以外でも、動いていれば成功にする", async () => {
    // すでに動いているときの終了コードを測っていない。断じる前に確かめる
    const outcome = await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: EXISTING_CLI,
      probe: async () => true,
      runCli: fakeCli({ kind: "exited", code: 1 }).run,
    });

    expect(outcome).toEqual({ ok: true });
  });

  test("終了コードが0以外で応答も無ければ、待たずに失敗を返す", async () => {
    // ここで待ちへ入ると、失敗が分かるまで作者を1分待たせることになる
    const probe = vi.fn(async () => false);

    const outcome = await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: EXISTING_CLI,
      timeoutMs: 60000,
      probe,
      runCli: fakeCli({ kind: "exited", code: 1 }).run,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "spawn_failed" });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

/**
 * 読み込む長さを拡張機能が決める（作者の報告、2026-08-29：
 * 「LM Studioで『文脈 8k』と出てしまう」）。
 *
 * JITに任せるとLM Studio側の既定の短い長さで載るので、
 * こちらから `--context-length` を指定して読み込ませる。
 */
describe("読み込む文脈の長さの決め方", () => {
  test("設定が0ならモデルの最大まで使う", () => {
    // 作者が何も決めなくても、いちばん長く読めるようにする
    expect(decideLoadContextLength(131072, 0)).toBe(131072);
  });

  test("設定があれば、モデルの最大との小さいほうを使う", () => {
    // 上限を超えて読み込ませない。メモリを使い切ると機械ごと固まる
    expect(decideLoadContextLength(262144, 32768)).toBe(32768);
    expect(decideLoadContextLength(8192, 32768)).toBe(8192);
  });

  test("モデルの最大が分からなければ設定値をそのまま使う", () => {
    // 分からないものを勝手に大きく見積もらない
    expect(decideLoadContextLength(undefined, 16384)).toBe(16384);
  });

  test("どちらも分からなければ指定しない", () => {
    // LM Studioの既定に任せる。当てずっぽうの数字を渡さない
    expect(decideLoadContextLength(undefined, 0)).toBeUndefined();
  });
});

describe("モデルの読み込み", () => {
  /** `lms load` を走らせたことにする */
  function fakeLoadCli(outcome: LoadCliOutcome): {
    run: (cli: string, args: string[]) => Promise<LoadCliOutcome>;
    calls: string[][];
  } {
    const calls: string[][] = [];
    return {
      run: async (cli, args) => {
        calls.push([cli, ...args]);
        return outcome;
      },
      calls,
    };
  }

  test("確認を出さず、指定した文脈の長さで読み込ませる", async () => {
    const cli = fakeLoadCli({ kind: "exited", code: 0, output: "" });

    const outcome = await loadLmStudioModel({
      cliPath: EXISTING_CLI,
      model: "google/gemma-4-e4b",
      contextLength: 131072,
      runCli: cli.run,
    });

    expect(outcome).toEqual({ ok: true });
    expect(cli.calls[0]).toEqual([
      EXISTING_CLI,
      "load",
      "google/gemma-4-e4b",
      // 問い合わせに答える相手がいないので、確認を出さない
      "-y",
      "--context-length",
      "131072",
    ]);
  });

  test("長さが決まらなければ指定しない（LM Studioの既定に任せる）", async () => {
    const cli = fakeLoadCli({ kind: "exited", code: 0, output: "" });

    await loadLmStudioModel({
      cliPath: EXISTING_CLI,
      model: "google/gemma-4-e4b",
      runCli: cli.run,
    });

    expect(cli.calls[0]).toEqual([
      EXISTING_CLI,
      "load",
      "google/gemma-4-e4b",
      "-y",
    ]);
  });

  test("lms が無ければ読み込みを試みない", async () => {
    const cli = fakeLoadCli({ kind: "exited", code: 0, output: "" });

    const outcome = await loadLmStudioModel({
      cliPath: "C:\\no\\such\\lms.exe",
      model: "google/gemma-4-e4b",
      runCli: cli.run,
    });

    expect(outcome).toEqual({ ok: false, reason: "not_installed" });
    expect(cli.calls).toHaveLength(0);
  });

  test("失敗したら、LM Studioの出力を理由として持ち帰る", async () => {
    // **出力を捨てない。** 読み込めなかった理由はここにしか出ない
    const outcome = await loadLmStudioModel({
      cliPath: EXISTING_CLI,
      model: "google/gemma-4-12b-qat",
      runCli: fakeLoadCli({
        kind: "exited",
        code: 1,
        output:
          "Error: Model loading was stopped due to insufficient system resources.",
      }).run,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "load_failed" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("insufficient system resources");
    }
  });

  test("待っても終わらなければタイムアウトとして返す", async () => {
    const outcome = await loadLmStudioModel({
      cliPath: EXISTING_CLI,
      model: "google/gemma-4-12b-qat",
      runCli: fakeLoadCli({ kind: "timeout", output: "" }).run,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("読み込み失敗の説明", () => {
  test("メモリ不足は、生成時と同じ言い方で先に伝える", () => {
    // 通知の文言が経路によって違うと、同じ原因だと気づけない
    const message = describeLoadFailure({
      ok: false,
      reason: "load_failed",
      detail:
        "Error: Model loading was stopped due to insufficient system resources. This model requires approximately 44.87 GB of memory.",
    });

    expect(message).toContain("メモリ不足");
    expect(message).toContain("guardrails");
    // LM Studioが言っている数字を捨てない
    expect(message).toContain("44.87 GB");
  });

  test("メモリ不足以外は、理由をそのまま添える", () => {
    const message = describeLoadFailure({
      ok: false,
      reason: "load_failed",
      detail: "Error: model not found",
    });

    expect(message).not.toContain("メモリ不足");
    expect(message).toContain("model not found");
  });

  test("lms が無いときは、画面から読み込むよう案内する", () => {
    const message = describeLoadFailure({
      ok: false,
      reason: "not_installed",
    });

    expect(message).toContain("LM Studioの画面");
  });
});

describe("失敗理由の説明", () => {
  test("未インストールなら置き場所と設定での指定方法を案内する", () => {
    const message = describeStartFailure({
      ok: false,
      reason: "not_installed",
    });

    expect(message).toContain("lms");
    expect(message).toContain("novelai.lmstudio.cliPath");
  });

  test("タイムアウトなら画面からの開始を案内する", () => {
    const message = describeStartFailure({ ok: false, reason: "timeout" });

    expect(message).toContain("Developer");
  });

  test("起動失敗は原因も添える", () => {
    const message = describeStartFailure({
      ok: false,
      reason: "spawn_failed",
      detail: "EACCES",
    });

    expect(message).toContain("EACCES");
  });

  test("成功したときは何も言わない", () => {
    expect(describeStartFailure({ ok: true })).toBe("");
  });
});
