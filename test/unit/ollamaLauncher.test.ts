import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as path from "node:path";

/**
 * `spawn` を差し替える。
 *
 * 以前は「Node自身を起こす」ことで本物のOllamaを避けていたが、
 * それでは**`spawn` へ渡している中身**（環境変数）を確かめられない。
 * 差し替えれば、起動処理の枝も渡した引数も両方見られる。
 */
const { spawnMock } = vi.hoisted(() => ({
  spawnMock:
    vi.fn<
      (
        exe: string,
        args: string[],
        // `stdio` も見る。標準エラーを受け取れる形で起こしているかは、
        // bind失敗を読めるかどうかそのものである（0.28.15）
        options: { env?: NodeJS.ProcessEnv; stdio?: unknown }
      ) => unknown
    >(),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  checkSelectedExecutable,
  describeStartFailure,
  executableCandidates,
  isLocalEndpoint,
  isPortInUseError,
  openDialogFilters,
  portFromBindError,
  resolveExecutable,
  startOllama,
} from "../../src/ai/ollamaLauncher";

describe("起動してよい接続先の判定", () => {
  test.each([
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
    "https://localhost:11434/",
  ])("%s はローカルなので起動を提案できる", (endpoint) => {
    expect(isLocalEndpoint(endpoint)).toBe(true);
  });

  test.each([
    "http://192.168.1.20:11434",
    "http://ollama.example.com:11434",
    "http://gpu-server:11434",
  ])("%s は別マシンなので起動を提案しない", (endpoint) => {
    expect(isLocalEndpoint(endpoint)).toBe(false);
  });

  test("URLとして壊れている場合は起動を提案しない", () => {
    expect(isLocalEndpoint("localhost:11434")).toBe(false);
    expect(isLocalEndpoint("")).toBe(false);
  });
});

describe("実行ファイルの探索", () => {
  test("Windowsでは既定のインストール先を先に見て、PATHは最後にする", () => {
    const candidates = executableCandidates(
      "win32",
      { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      "C:\\Users\\test"
    );

    // **順序が要件そのもの**（0.28.14）。`resolveExecutable` は区切りを
    // 含まない候補を存在確認せずに返すので、PATHを先頭に置くと
    // **実在するインストール先が一度も試されない**。Windowsでは
    // インストーラがPATHを更新しても、すでに動いているVS Codeには
    // 反映されないため、これは現実に起こる（作者の報告
    // 「Ollamaが自動で立ち上がりません」）
    expect(candidates[0]).toBe(
      path.join("C:\\Users\\test\\AppData\\Local", "Programs", "Ollama", "ollama.exe")
    );
    expect(candidates.at(-1)).toBe("ollama.exe");
  });

  test("macOS・LinuxでもPATHは最後に置く", () => {
    expect(executableCandidates("darwin", {}, "/Users/test").at(-1)).toBe("ollama");
    expect(executableCandidates("linux", {}, "/home/test").at(-1)).toBe("ollama");
  });

  test("既定の場所が実在すれば、PATHへ行かずにそれを使う", async () => {
    // 不具合の再現：PATHを先に置いていたときは、実在する場所があっても
    // 存在確認なしで "ollama.exe" が返っていた
    const real = path.join(__dirname, "support", "vscodeStub.ts");
    await expect(resolveExecutable(undefined, [real, "ollama.exe"])).resolves.toBe(
      real
    );
  });

  test("LOCALAPPDATAが無くてもホームから組み立てる", () => {
    const candidates = executableCandidates("win32", {}, "C:\\Users\\test");

    expect(
      candidates.some((c) => c.includes(path.join("AppData", "Local")))
    ).toBe(true);
  });

  test("macOSではHomebrewとアプリ内の場所を候補に含める", () => {
    const candidates = executableCandidates("darwin", {}, "/Users/test");

    expect(candidates).toContain("/opt/homebrew/bin/ollama");
    expect(candidates).toContain(
      "/Applications/Ollama.app/Contents/Resources/ollama"
    );
  });

  test("パス区切りを含まない候補は存在確認せずPATH解決に任せる", async () => {
    await expect(resolveExecutable(undefined, ["ollama"])).resolves.toBe(
      "ollama"
    );
  });

  test("設定で指定された実行ファイルが無ければ未検出として扱う", async () => {
    await expect(
      resolveExecutable("C:\\no\\such\\ollama.exe")
    ).resolves.toBeUndefined();
  });

  test("存在しない絶対パス候補は飛ばす", async () => {
    await expect(
      resolveExecutable(undefined, [
        path.join("C:\\no\\such", "ollama.exe"),
        "ollama",
      ])
    ).resolves.toBe("ollama");
  });
});

/**
 * 作者の機械で実際に出た1行（`%LOCALAPPDATA%\Ollama\server-1.log`、2026-08-31）。
 * 前のOllamaがポートを握ったまま応答せず、新しい `ollama serve` が
 * bind に失敗して即終了することを9回くり返していた。
 */
const BIND_ERROR =
  "Error: listen tcp 127.0.0.1:11434: bind: Only one usage of each socket " +
  "address (protocol/network address/port) is normally permitted.";

describe("ポートが使われたままかの見分け", () => {
  test("Windowsのbind失敗の定型を見分ける", () => {
    expect(isPortInUseError(BIND_ERROR)).toBe(true);
  });

  test("macOS/Linuxのbind失敗の定型も見分ける", () => {
    expect(
      isPortInUseError(
        "Error: listen tcp 127.0.0.1:11434: bind: address already in use"
      )
    ).toBe(true);
  });

  test("無関係な失敗や空文字はポート衝突と見なさない", () => {
    // ここを緩めると、まったく別の原因を「Ollamaを終了してください」と
    // 案内してしまい、作者が直せない指示を渡されることになる
    expect(isPortInUseError("Error: unknown command \"serve\"")).toBe(false);
    expect(isPortInUseError("panic: runtime error: invalid memory address")).toBe(
      false
    );
    expect(isPortInUseError("")).toBe(false);
  });

  test("握られていたポートを、失敗の文から読み取る", () => {
    expect(portFromBindError(BIND_ERROR)).toBe("11434");
    // IPv6でも同じ形（`[::1]:11500: bind: …`）
    expect(
      portFromBindError("listen tcp [::1]:11500: bind: address already in use")
    ).toBe("11500");
  });

  test("ポートが読み取れない文では undefined を返す（呼ぶ側が既定を補う）", () => {
    expect(portFromBindError("bind: address already in use")).toBeUndefined();
    expect(portFromBindError("")).toBeUndefined();
  });
});

  /** Ollamaを起こしたことにする子。失敗も終了も知らせない */
  function fakeChild() {
    return {
      once: () => undefined,
      // 起動処理は「エラーが来なければ起動したとみなす」ために
      // 300ミリ秒後に購読を外す。外せないと落ちる
      removeListener: () => undefined,
      unref: () => undefined,
    };
  }

  /**
   * 台本どおりに振る舞う子を作る（`spawner` から返す）。
   *
   * bind失敗は**標準エラーへ1行書いてコード1で即終了する**という形なので、
   * 「標準エラーの中身」「終了コード」「spawn自体の失敗」を組み合わせて
   * 渡せるようにしてある。`seen` には、判定が済んだあとの後始末
   * （パイプを閉じたか・切り離したか）が残る。
   */
  function scriptedChild(script: {
    stderr?: string;
    exit?: number | null;
    error?: string;
  }) {
    const dataListeners: ((chunk: Buffer) => void)[] = [];
    const seen = {
      removedListeners: false,
      destroyed: false,
      unrefs: 0,
      stderrUnrefs: 0,
      /** 後始末のあとに付け直された購読の数（読み捨ての口） */
      dataListenersAfterRelease: 0,
    };
    const child = {
      stderr: {
        on(_event: "data", listener: (chunk: Buffer) => void) {
          if (seen.removedListeners) seen.dataListenersAfterRelease += 1;
          dataListeners.push(listener);
        },
        removeAllListeners() {
          seen.removedListeners = true;
          dataListeners.length = 0;
        },
        unref() {
          seen.stderrUnrefs += 1;
        },
      },
      once(event: "error" | "exit", listener: (arg: never) => void) {
        // 受け口は `never` で受けて、知らせるときに実際の型へ戻す。
        // `ChildProcess` と作り物の両方を渡せるようにしてあるため
        const notify = listener as (arg: Error | number | null) => void;
        // 本物と同じく、購読が済んだあとのタイミングで知らせる
        if (event === "error" && script.error !== undefined) {
          setTimeout(() => notify(new Error(script.error)), 0);
        }
        if (event === "exit" && script.exit !== undefined) {
          setTimeout(() => {
            // 終了の前に標準エラーが届く（本物と同じ順序）
            for (const listen of dataListeners) {
              listen(Buffer.from(script.stderr ?? ""));
            }
            notify(script.exit ?? null);
          }, 0);
        }
      },
      unref() {
        seen.unrefs++;
      },
    };
    return { child, seen };
  }

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });

/**
 * 起こす前の確認では応答せず、**起こしたあとは応答する** probe。
 *
 * 0.29.6 から `startOllama` は最初に1回だけ「もう動いていないか」を
 * 確かめる（設計書6.55）。常に `true` を返す probe を渡すと、そこで
 * 「既に動いている」と判定されて**起こす処理そのものを通らない**ので、
 * 起動の枝を試すテストはこれを使う。
 */
function probeAfterSpawn(): () => Promise<boolean> {
  let asked = 0;
  return async () => {
    asked += 1;
    return asked > 1;
  };
}

describe("起こす前に、もう動いていないかを確かめる（設計書6.55）", () => {
  test("応答があれば、起こさずに成功を返す", async () => {
    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      probe: async () => true,
    });

    expect(outcome).toEqual({ ok: true });
    // **ここが要点。** 確かめずに起こすと、bindに失敗して即死する serve が
    // 1つ増え、Windowsでは黒いコンソールが一瞬開く（作者の報告、2026-08-31）
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("実行ファイルが無くても、応答していれば成功にする", async () => {
    // **動いているものに繋ぐのに、実行ファイルは要らない**
    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: "C:\\no\\such\\ollama.exe",
      probe: async () => true,
    });

    expect(outcome).toEqual({ ok: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("待っているあいだに立ち上がったら、起こさない", async () => {
    // 常駐アプリ側のOllamaが少し遅れて上がってくる状況
    let asked = 0;
    const probe = vi.fn(async () => {
      asked += 1;
      return asked >= 3;
    });

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 3000,
      executablePath: process.execPath,
      probe,
    });

    expect(outcome).toEqual({ ok: true });
    // **取り合いが起きない。** こちらが起こしていないので、
    // 向こうが取り返そうと1秒ごとに serve を起こし続けることも無い
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("起動処理（つづき）", () => {
  test("実行ファイルが見つからず、応答も無ければ起動を試みない", async () => {
    const probe = vi.fn(async () => false);

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: "C:\\no\\such\\ollama.exe",
      probe,
    });

    expect(outcome).toEqual({ ok: false, reason: "not_installed" });
    // 確かめには行く（応答があれば実行ファイルは要らないため）
    expect(probe).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("応答するまで待ってから成功を返す", async () => {
    // 起動直後は応答せず、数回後に応答する状況
    let calls = 0;
    const probe = vi.fn(async () => {
      calls++;
      return calls >= 3;
    });

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      // 実在するファイルを渡す（`resolveExecutable` が存在を確かめるため）。
      // 起こす処理そのものは差し替えてある
      executablePath: process.execPath,
      timeoutMs: 10000,
      probe,
    });

    expect(outcome).toEqual({ ok: true });
    // 起こす前の確認を含めて3回（設計書6.55）
    expect(probe).toHaveBeenCalledTimes(3);
  });

  /**
   * **同じ穴を2か所に残さない**（LM Studioで60秒の時間切れになった原因）。
   * Ollamaは Electron ではないので今のところ害は無いが、
   * 拡張機能ホストの環境をそのまま子へ継がせない。
   */
  test("ELECTRON_RUN_AS_NODE を子へ継がせない", async () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      await startOllama({
        endpoint: "http://localhost:11434",
        waitForExistingMs: 0,
        executablePath: process.execPath,
        timeoutMs: 1,
        probe: probeAfterSpawn(),
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const options = spawnMock.mock.calls[0][2];
      expect(options.env).toBeDefined();
      expect(options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });

  test("待っても応答しなければタイムアウトとして返す", async () => {
    const probe = vi.fn(async () => false);

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      timeoutMs: 1200,
      probe,
    });

    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    expect(probe.mock.calls.length).toBeGreaterThan(0);
  });

  /**
   * **標準エラーを受け取れる形で起こす**（0.28.15）。
   *
   * 以前は `stdio: "ignore"` だったため、bind失敗で即終了したことも、
   * その理由も見えず、30秒待った末に「応答しませんでした」としか
   * 言えなかった（作者の報告「CLIが9回、一瞬だけ立ち上がった」）。
   */
  test("Windowsでは標準エラーだけを受け取る形で起こす", async () => {
    await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      timeoutMs: 1,
      spawnWatchMs: 20,
      platform: "win32",
      probe: probeAfterSpawn(),
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2].stdio).toEqual(["ignore", "ignore", "pipe"]);
  });

  /**
   * **Windows以外では標準エラーを受け取らない。**
   *
   * こちらは起動直後の1秒を見たら読み手を閉じるが、Goのランタイムは
   * fd 2 への書き込みが壊れたパイプに当たると SIGPIPE で終了する。
   * POSIXでは、閉じた直後の最初のログ1行で `ollama serve` 本体が
   * 落ちうる——**起動を助けるはずの処理が、起動を壊す。**
   */
  test.each(["darwin", "linux"] as const)(
    "%s では標準エラーを受け取らない（serveを殺さない）",
    async (platform) => {
      await startOllama({
        endpoint: "http://localhost:11434",
        waitForExistingMs: 0,
        executablePath: process.execPath,
        timeoutMs: 1,
        spawnWatchMs: 20,
        platform,
        probe: probeAfterSpawn(),
      });

      const stdio = spawnMock.mock.calls[0][2].stdio;
      // まとめて "ignore" でも、3つ並べた形でも、標準エラーは閉じている
      expect(Array.isArray(stdio) ? stdio[2] : stdio).toBe("ignore");
    }
  );

  test("ポートを掴まれて落ちても、既にOllamaが応答するなら起動済みとして扱う", async () => {
    // LM Studio と同じ扱い：「すでに動いている」と断じる前に1回確かめる
    const { child } = scriptedChild({ exit: 1, stderr: BIND_ERROR });
    const probe = vi.fn(async () => true);

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      timeoutMs: 30000,
      spawnWatchMs: 3000,
      probe,
      spawner: () => child,
    });

    expect(outcome).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("ポートを掴まれたまま応答も無ければ、古いOllamaが残っていると見分ける", async () => {
    const { child } = scriptedChild({ exit: 1, stderr: BIND_ERROR });
    const probe = vi.fn(async () => false);

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      // 時間切れ（30秒待つ経路）へ落ちないことも確かめたい。
      // 落ちていれば、この上限のぶんだけ待たされる
      timeoutMs: 30000,
      spawnWatchMs: 3000,
      probe,
      spawner: () => child,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("port_in_use_stale");
      expect(outcome.detail).toContain("bind");
    }
    // 疎通は1回だけ。応答しないと分かった時点で待たずに案内する
    // 起こす前の確認で1回、落ちたあとの救済で1回（設計書6.55）
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test("bind以外の理由で落ちたときは、標準エラーを添えて起動失敗にする", async () => {
    const { child } = scriptedChild({
      exit: 1,
      stderr: 'Error: unknown command "serve" for "ollama"',
    });
    const probe = vi.fn(async () => false);

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      timeoutMs: 30000,
      spawnWatchMs: 3000,
      probe,
      spawner: () => child,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "spawn_failed",
      detail: 'Error: unknown command "serve" for "ollama"',
    });
    // 起こす前の確認で1回だけ。理由が読めているので、落ちたあとに
    // もう一度確かめる意味は無い（ポート衝突ではないと分かっている）
    expect(probe).toHaveBeenCalledTimes(1);
  });

  /**
   * **切り離しを壊していないこと。**
   *
   * `unref()` が外すのは子プロセスの参照だけで、`stdio` のパイプは
   * 別に残る。持ち続けると拡張機能ホストがそれに掴まれ、
   * 「VS Codeを閉じてもOllamaが残る」というこれまでの動きが崩れる。
   */
  /**
   * **閉じずに、読み捨てへ移る**（0.29.6）。
   *
   * 当初は `destroy()` で閉じていたが、実測で**閉じると子が死ぬ**と
   * 分かった（親がパイプを閉じた直後、子は次の書き込みで終了する）。
   * かといって読むのをやめるだけではパイプが詰まって子が止まるので、
   * 「開けたまま捨てる」しかない。
   */
  test("走り続ける場合は、標準エラーを閉じずに読み捨てへ移る", async () => {
    const { child, seen } = scriptedChild({}); // 終了も失敗も知らせない

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      timeoutMs: 5000,
      spawnWatchMs: 30,
      probe: probeAfterSpawn(),
      spawner: () => child,
    });

    expect(outcome).toEqual({ ok: true });
    expect(seen.removedListeners).toBe(true);
    // **閉じない。** ここが true に戻ると、Ollamaを殺しうる作りへ逆戻りする
    expect(seen.destroyed).toBe(false);
    // 読み捨ての購読は付け直す（付けないとパイプが詰まって子が止まる）
    expect(seen.dataListenersAfterRelease).toBeGreaterThan(0);
    // パイプがイベントループを掴まないようにする
    expect(seen.stderrUnrefs).toBe(1);
    expect(seen.unrefs).toBe(1);
  });

  /**
   * 理由が読めないOS（Windows以外）でも、**即終了したこと自体は分かる**。
   * いちばん多い原因（既に動いている）かどうかは疎通で見分けられる。
   */
  test("理由が読めないまま即終了しても、応答があれば起動済みとして扱う", async () => {
    const { child } = scriptedChild({ exit: 1 }); // 標準エラーは受け取れない
    // 起こす前の確認では応答せず、即終了したあとの救済で応答する
    const probe = vi.fn(probeAfterSpawn());

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      timeoutMs: 30000,
      spawnWatchMs: 3000,
      platform: "linux",
      probe,
      spawner: () => child,
    });

    expect(outcome).toEqual({ ok: true });
    // 起こす前の確認で1回、落ちたあとの救済で1回（設計書6.55）
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test("理由が読めず応答も無ければ、終了コードを添えて起動失敗にする", async () => {
    const { child } = scriptedChild({ exit: 1 });
    const probe = vi.fn(async () => false);

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      // 時間切れ（30秒待つ経路）へ落ちないことも確かめる
      timeoutMs: 30000,
      spawnWatchMs: 3000,
      platform: "linux",
      probe,
      spawner: () => child,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("spawn_failed");
      // 理由は名指しできないが、終了コードだけは残す
      expect(outcome.detail).toContain("1");
    }
    // 起こす前の確認で1回、落ちたあとの救済で1回（設計書6.55）
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test("spawn自体が失敗したときは、これまでどおり起動失敗として返す", async () => {
    const { child } = scriptedChild({ error: "spawn ENOENT" });
    const probe = vi.fn(async () => false);

    const outcome = await startOllama({
      endpoint: "http://localhost:11434",
      waitForExistingMs: 0,
      executablePath: process.execPath,
      timeoutMs: 30000,
      spawnWatchMs: 3000,
      probe,
      spawner: () => child,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "spawn_failed",
      detail: "spawn ENOENT",
    });
  });
});

describe("選択された実行ファイルの検証", () => {
  test("存在しないファイルは missing として弾く", async () => {
    await expect(
      checkSelectedExecutable("C:\\no\\such\\ollama.exe", "win32")
    ).resolves.toEqual({ verdict: "missing" });
  });

  test("Windowsで拡張子がexeでなければ確認を求める", async () => {
    // 実在するがexeではないファイルを使う
    const check = await checkSelectedExecutable(
      path.join(process.cwd(), "package.json"),
      "win32"
    );

    expect(check.verdict).toBe("suspicious");
    expect(check).toHaveProperty("reason");
  });

  test("トレイ常駐アプリを選んだ場合は理由を添えて止める", async () => {
    const dir = path.dirname(process.execPath);
    const appLike = path.join(dir, "ollama app.exe");
    // 実ファイルが無い環境ではmissing判定が先に来るため、名前判定だけを検証する
    const check = await checkSelectedExecutable(appLike, "win32");

    expect(["missing", "suspicious"]).toContain(check.verdict);
    if (check.verdict === "suspicious") {
      expect(check.reason).toContain("ollama.exe");
    }
  });

  test("macOS/Linuxでは拡張子が無くても妥当と扱う", async () => {
    // node実行ファイルを ollama という名前で扱えないため、名前判定のみ確認
    const check = await checkSelectedExecutable(process.execPath, "linux");

    // node なのでファイル名が違う＝suspicious。拡張子理由ではないことを確認する
    expect(check.verdict).toBe("suspicious");
    if (check.verdict === "suspicious") {
      expect(check.reason).not.toContain("実行ファイル（.exe）");
    }
  });
});

describe("選択ダイアログのフィルタ", () => {
  test("Windowsではexeを絞り込みつつ全ファイルも選べる", () => {
    const filters = openDialogFilters("win32");

    expect(filters?.["実行ファイル"]).toEqual(["exe"]);
    expect(filters?.["すべてのファイル"]).toEqual(["*"]);
  });

  test("macOS/Linuxでは拡張子で絞り込まない", () => {
    expect(openDialogFilters("darwin")).toBeUndefined();
    expect(openDialogFilters("linux")).toBeUndefined();
  });
});

describe("失敗理由の説明", () => {
  test("未インストールなら設定での指定方法を案内する", () => {
    const message = describeStartFailure({
      ok: false,
      reason: "not_installed",
    });

    expect(message).toContain("novelai.ollama.executablePath");
  });

  test("タイムアウトなら再試行を促す", () => {
    const message = describeStartFailure({ ok: false, reason: "timeout" });

    expect(message).toContain("再試行");
  });

  test("ポートを掴んだままのOllamaには、終わらせ方まで案内する", () => {
    // 作者はプログラマではない。「ポートが使われています」だけでは
    // 何をすればよいか分からないので、終わらせ方を2通り示す
    const message = describeStartFailure({
      ok: false,
      reason: "port_in_use_stale",
    });

    expect(message).toContain("タスクトレイ");
    expect(message).toContain("ollama.exe");
    // 失敗の文が無ければ、Ollamaの既定のポートを言う
    expect(message).toContain("11434");
  });

  test("接続先を変えている場合は、実際に握られていたポートを案内する", () => {
    // 決め打ちにすると、既定から変えている作者に見当違いの番号を探させる
    const message = describeStartFailure({
      ok: false,
      reason: "port_in_use_stale",
      detail:
        "Error: listen tcp 127.0.0.1:11500: bind: Only one usage of each socket " +
        "address (protocol/network address/port) is normally permitted.",
    });

    expect(message).toContain("11500");
    expect(message).not.toContain("11434");
  });

  test("起動失敗は手動起動を促し、原因も添える", () => {
    const message = describeStartFailure({
      ok: false,
      reason: "spawn_failed",
      detail: "EACCES",
    });

    expect(message).toContain("手動で起動");
    expect(message).toContain("EACCES");
  });
});
