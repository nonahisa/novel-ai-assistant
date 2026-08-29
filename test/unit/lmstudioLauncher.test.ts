import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as path from "node:path";

/**
 * `spawn` を差し替える。
 *
 * **本物の `lms` は起こさない**（このファイルの方針）が、
 * `spawn` へ渡している**引数のほうを確かめたい**回がある
 * （`ELECTRON_RUN_AS_NODE` を落としているか）。差し替えないと、
 * この機械にLM Studioが入っているかどうかで結果が変わる。
 */
const { spawnMock } = vi.hoisted(() => ({
  spawnMock:
    vi.fn<
      (
        cli: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv }
      ) => unknown
    >(),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  childProcessEnv,
  cliCandidates,
  contextLengthRetrySteps,
  decideLoadContextLength,
  describeLoadFailure,
  describeStartFailure,
  isInsufficientResources,
  isLocalEndpoint,
  isRecentlyConfirmed,
  keepTail,
  loadLmStudioModel,
  resolveCli,
  serverPort,
  startLmStudioServer,
  LOAD_CONFIRM_TTL_MS,
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

  /**
   * **`lms server start` が戻らないことがある。**
   * LM Studio本体が立ち上がっていないと、本体の起動から始まるためである。
   * 終了を待ち切らずに `running` を返し、疎通のポーリングへ進む
   * （待ち続けると、進捗表示が出たまま作者を待たせ続ける）。
   */
  test("終了を待ち切れなくても、疎通の確認へ進む", async () => {
    const probe = vi.fn(async () => true);

    const outcome = await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: EXISTING_CLI,
      probe,
      runCli: fakeCli({ kind: "running" }).run,
    });

    expect(outcome).toEqual({ ok: true });
    expect(probe).toHaveBeenCalled();
  });

  test("待ち切れないまま応答も無ければ、締切までポーリングして諦める", async () => {
    const probe = vi.fn(async () => false);

    const outcome = await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: EXISTING_CLI,
      timeoutMs: 1200,
      probe,
      runCli: fakeCli({ kind: "running" }).run,
    });

    expect(outcome).toEqual({ ok: false, reason: "timeout" });
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

/**
 * 断られたら、文脈を半分にして試し直す（作者の環境で実際に起きたこと）。
 *
 * 既定（設定 0）はモデルの最大で読み込むので、メモリの足りない機械では
 * 安全装置に断られる。以前はそこで諦めており、`ensureConfigured` が
 * undefined を返して**AI機能が丸ごと動かなくなっていた**——12b を未読込の
 * まま選んだ機械では、誤字脱字も相談も一切動かない。
 */
describe("短くして試し直す長さの列", () => {
  test("半分ずつ下げる（最大4回）", () => {
    expect(contextLengthRetrySteps(131072)).toEqual([131072, 65536, 32768, 16384]);
  });

  test("8192より短くはしない", () => {
    // ここまで下げても載らないなら、文脈の長さでは解決しない
    expect(contextLengthRetrySteps(32768)).toEqual([32768, 16384, 8192]);
    expect(contextLengthRetrySteps(16384)).toEqual([16384, 8192]);
  });

  test("もともと下限以下なら、そのまま1回だけ", () => {
    // モデルの最大が短いことがある。**引き上げない**
    expect(contextLengthRetrySteps(8192)).toEqual([8192]);
    expect(contextLengthRetrySteps(4096)).toEqual([4096]);
  });

  test("半端な長さでも、下限で止まる", () => {
    expect(contextLengthRetrySteps(12000)).toEqual([12000, 8192]);
  });

  test("メモリ不足のときだけ短くする", () => {
    // モデル名の間違いなど、短くしても直らない失敗を4回試すと、
    // 作者を待たせるだけになる
    expect(
      isInsufficientResources(
        "Error: Model loading was stopped due to insufficient system resources."
      )
    ).toBe(true);
    expect(isInsufficientResources("Error: model not found")).toBe(false);
    expect(isInsufficientResources(undefined)).toBe(false);
  });

  test("案内に、文脈を短くする設定の名前を出す", () => {
    // 「小さいモデルを選べ」だけでは、いま使いたいモデルを諦めるほかに
    // 手が無いように見える
    const message = describeLoadFailure({
      ok: false,
      reason: "load_failed",
      detail: "Error: insufficient system resources",
    });

    expect(message).toContain("novelai.lmstudio.loadContextLength");
  });
});

/**
 * 「読み込み済み」と確かめたことを、しばらく覚えておく。
 *
 * AI機能を呼ぶたびにLM Studioへ聞きに行くと、設定資料パネルの相談では
 * **質問のたび**にHTTPの往復と進捗表示が入っていた（実際には何もしない）。
 * 載せ替えはLM Studioの画面で人が行うので、数十秒の古さは害にならない。
 */
describe("読み込み済みの覚え", () => {
  test("30秒のうちは、聞き直さない", () => {
    expect(isRecentlyConfirmed(1_000_000, 1_000_000 + 29_000)).toBe(true);
  });

  test("30秒を過ぎたら聞き直す", () => {
    expect(isRecentlyConfirmed(1_000_000, 1_000_000 + LOAD_CONFIRM_TTL_MS)).toBe(
      false
    );
  });

  test("覚えが無ければ聞きに行く", () => {
    // **覚えるのは成功だけ**（CLAUDE.md 規則5）。未読込・失敗は覚えない
    expect(isRecentlyConfirmed(undefined, 1_000_000)).toBe(false);
  });

  test("時計が巻き戻っていたら、覚えを捨てる", () => {
    // スリープ復帰などで起きる。**未来の時刻を信じない**
    expect(isRecentlyConfirmed(2_000_000, 1_000_000)).toBe(false);
  });
});

/**
 * `lms load` の出力を溜め込まない。
 *
 * 読み込み中は進捗バーが何度も描き直され（同じ行を書き換えるために
 * 制御文字ごと送り直す）、大きいモデルでは数MBになる。
 * 失敗の理由は最後に出るので、末尾だけあれば足りる。
 */
describe("出力は末尾だけ残す", () => {
  test("上限を超えたら、末尾を残す", () => {
    const long = "あ".repeat(5000) + "Error: 失敗";

    const kept = keepTail(long, 100);

    expect(kept).toHaveLength(100);
    expect(kept.endsWith("Error: 失敗")).toBe(true);
  });

  test("短ければそのまま", () => {
    expect(keepTail("短い出力", 4096)).toBe("短い出力");
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

  test("タイムアウトには、手で起動してからやり直す道も添える", () => {
    // 環境変数以外の原因で待たされることもある。本体さえ上がっていれば
    // `lms server start` は0.2秒で通るので、逃げ道として案内する
    const message = describeStartFailure({ ok: false, reason: "timeout" });

    expect(message).toContain("手で起動してから");
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

/**
 * 子へ渡す環境変数（作者の報告、2026-08-30：「自動起動しませんでした」）。
 *
 * VS Codeの拡張機能ホストは `ELECTRON_RUN_AS_NODE=1` を持っている。
 * これを継いだ `lms` が起こす LM Studio 本体（Electron製）は
 * **素のNodeとして起動して即終了する**ため、`lms server start` は
 * 60秒の時間切れになる。外すと本体は7.3秒で上がった（実機で確認）。
 */
describe("子へ渡す環境変数", () => {
  test("ELECTRON_RUN_AS_NODE だけを落として、ほかは残す", () => {
    const cleaned = childProcessEnv({
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "x",
    });

    expect(cleaned.PATH).toBe("x");
    expect(cleaned).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });

  test("元のオブジェクトは変えない", () => {
    // `delete process.env.X` にすると拡張機能ホスト自身の環境を書き換える
    const original: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1", PATH: "x" };

    childProcessEnv(original);

    expect(original.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  test("もともと無ければ、そのままの写しになる", () => {
    expect(childProcessEnv({ PATH: "x", HOME: "/home/test" })).toEqual({
      PATH: "x",
      HOME: "/home/test",
    });
  });
});

/**
 * `spawn` へ実際に渡している中身を固定する。
 *
 * **純粋関数を用意しただけでは、渡し忘れに気づけない。**
 * 起動も読み込みも `lms` を経由して LM Studio 本体を起こすので、
 * どちらの経路でも環境変数を落としていることを確かめる。
 */
describe("lms を起こすときの環境変数", () => {
  /** `lms` を起こしたことにする子。終わりは知らせず、待ち切りに任せる */
  function fakeChild() {
    return {
      once: () => undefined,
      unref: () => undefined,
      kill: () => undefined,
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
    };
  }

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
    process.env.ELECTRON_RUN_AS_NODE = "1";
  });

  afterEach(() => {
    delete process.env.ELECTRON_RUN_AS_NODE;
  });

  test("server start では ELECTRON_RUN_AS_NODE を継がせない", async () => {
    await startLmStudioServer({
      endpoint: "http://localhost:1234/v1",
      cliPath: EXISTING_CLI,
      // 終わりを知らせない子なので、待ち切って疎通の確認へ進ませる
      spawnWaitMs: 5,
      probe: async () => true,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const options = spawnMock.mock.calls[0][2];
    expect(options.env).toBeDefined();
    expect(options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    // 環境ごと空にしていないか（PATHが消えると lms がモデルを探せない）
    expect(Object.keys(options.env ?? {}).length).toBeGreaterThan(0);
  });

  test("load でも ELECTRON_RUN_AS_NODE を継がせない", async () => {
    await loadLmStudioModel({
      cliPath: EXISTING_CLI,
      model: "google/gemma-4-e4b",
      // 終わりを知らせない子なので、すぐ時間切れにして手を戻す
      timeoutMs: 5,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2].env).not.toHaveProperty(
      "ELECTRON_RUN_AS_NODE"
    );
  });
});
