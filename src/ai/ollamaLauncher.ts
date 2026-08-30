import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { childProcessEnv } from "./childProcessEnv";
import { logFailure, logStep } from "../core/logger";

/**
 * Ollamaサーバーの起動を支援する。
 *
 * Ollamaはインストールしても自動起動しない環境が多く、
 * 「AIに接続できません」と言われるたびに作者が手動で立ち上げるのは煩わしい。
 * ただし勝手に起動はせず、必ず作者に確認してから呼ぶこと。
 */

/** 起動を試みてよいか。リモートのOllamaはこちらからは起動できない */
export function isLocalEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * 実行ファイルの候補を、探す順に返す。
 *
 * **既定の置き場所を先、PATHを後にする**（`lmstudioLauncher.ts` と同じ順）。
 *
 * 逆にしていたせいで、**PATHの候補が存在確認なしで必ず返り、実在する
 * インストール先が一度も試されなかった**（`resolveExecutable` は
 * 区切りを含まない候補をPATH解決に任せてそのまま返す）。コメントは
 * 「PATHが通っていない環境のために既定のインストール先も見る」と
 * 書いてあったが、そこへ到達する道が無かった。
 *
 * **Windowsでは現実に起こる**：インストーラがPATHを更新しても、
 * すでに動いているVS Codeの環境には反映されない。入れた直後に
 * 起動を試すと「見つからない」で失敗する（作者の報告
 * 「Ollamaが自動で立ち上がりません」2026-08-30）。0.28.14
 */
export function executableCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir()
): string[] {
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA ?? path.join(homedir, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [
      path.join(localAppData, "Programs", "Ollama", "ollama.exe"),
      path.join(programFiles, "Ollama", "ollama.exe"),
      "ollama.exe",
    ];
  }
  if (platform === "darwin") {
    return [
      "/opt/homebrew/bin/ollama",
      "/usr/local/bin/ollama",
      "/Applications/Ollama.app/Contents/Resources/ollama",
      "ollama",
    ];
  }
  return ["/usr/local/bin/ollama", "/usr/bin/ollama", "ollama"];
}

/**
 * 実行ファイルの場所を決める。
 * 見つからなければ undefined（＝インストールされていない可能性）。
 */
export async function resolveExecutable(
  configuredPath?: string,
  candidates: string[] = executableCandidates()
): Promise<string | undefined> {
  const configured = configuredPath?.trim();
  if (configured) {
    // 明示指定は存在確認だけして、そのまま使う（作者の指定を尊重する）
    return (await isExecutableFile(configured)) ? configured : undefined;
  }

  for (const candidate of candidates) {
    // パス区切りを含まないものはPATH解決に任せるため、存在確認をしない
    if (!candidate.includes(path.sep) && !candidate.includes("/")) {
      return candidate;
    }
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export type StartOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_installed"
        | "spawn_failed"
        | "timeout"
        /**
         * 前のOllamaがポートを握ったまま応答しない（設計書6.54）。
         * 起こし直しても bind に失敗し続けるので、**作者が古いほうを
         * 終わらせる**しか手が無い。時間切れとは直し方が違う
         */
        | "port_in_use_stale";
      detail?: string;
    };

/**
 * 起こした子プロセスのうち、起動の判定に使う部分だけ。
 *
 * `ChildProcess` をそのまま渡せる形にしてある（テストからは
 * 台本どおりに振る舞う作り物を渡す。`spawner` を参照）。
 */
export interface LaunchedProcess {
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null) => void): void;
  /** `stdio` で pipe を指定したときだけある */
  stderr?: LaunchedStderr | null;
  /** VS Codeを閉じても子が残るよう、参照を外す */
  unref(): void;
}

/** 標準エラーのうち、起動の判定と後始末に使う部分だけ */
export interface LaunchedStderr {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  removeAllListeners(): void;
  destroy(): void;
}

export interface StartOptions {
  endpoint: string;
  /** 設定で明示された実行ファイルのパス */
  executablePath?: string;
  /** 起動を待つ上限。初回起動は数秒かかる */
  timeoutMs?: number;
  /** 起動直後を見張る窓の長さ。テストから短くするためにある */
  spawnWatchMs?: number;
  /**
   * どのOSとして振る舞うか。**標準エラーを受け取るかどうかが変わる**
   * （`defaultSpawner`）。テストから両方の枝を通すために受ける
   */
  platform?: NodeJS.Platform;
  /** 疎通確認。テストから差し替えられるようにする */
  probe?: (endpoint: string) => Promise<boolean>;
  /**
   * `ollama serve` を起こす処理。テストから差し替えるためにある。
   *
   * 終了コードと標準エラーで扱いを分けるようになったので、
   * 「Node自身を起こして代用する」やり方では狙った枝を通せない
   * （LM Studio の `runCli` と同じ考え方）。
   */
  spawner?: (exe: string, args: string[]) => LaunchedProcess;
}

/**
 * 起動直後を見張る窓の長さ。
 *
 * ここで見たいのは「起こした直後に落ちたか」だけなので短くてよい。
 * bind に失敗した `ollama serve` は**一瞬で**コード1で終わる
 * （作者の機械では、その一瞬の画面が9回続けて見えた。2026-08-31）。
 * 走り続ける場合はこの窓を待ち切ってから疎通の確認へ進むため、
 * 長くすると正常な起動がそのぶん遅くなる。
 */
const SPAWN_WATCH_MS = 1000;

/**
 * 溜めておく標準エラーの上限。
 *
 * 起動直後の失敗は最初の数行に出るので、これで足りる。
 * 上限を置かないと、走り続けるOllamaのログを延々と溜め込む。
 */
const STDERR_LIMIT = 2048;

/**
 * ポートを他所に握られて起動できなかったか。
 *
 * Windowsは「Only one usage of each socket address…」、
 * macOS/Linuxは「address already in use」と、同じことを別の文で言う。
 * **この2つだけを対象にする**——別の原因まで拾うと、直しようのない
 * 「Ollamaを終了してください」を作者に渡すことになる。
 *
 * なお**この文を読めるのはWindowsだけ**である（`defaultSpawner` を参照）。
 * それ以外のOSでは標準エラーを受け取らないので、ここは常に false になり、
 * 「即終了したが疎通はある／無い」という粗い見分けだけが働く。
 */
export function isPortInUseError(text: string): boolean {
  return /bind: Only one usage|address already in use/i.test(text);
}

/**
 * bind失敗の文から、実際に握られていた待ち受け先のポートを取り出す。
 *
 * `listen tcp 127.0.0.1:11434: bind: …`（IPv6なら `[::1]:11434`）という
 * 形で、**アドレスは文の中にしか無い**。案内文へ差し込むために取る——
 * 接続先を既定から変えている作者に「11434を終了してください」と言うと、
 * 見当違いの番号を探させることになる。
 *
 * @returns 読み取れなければ undefined（呼ぶ側が既定を補う）
 */
export function portFromBindError(text: string): string | undefined {
  return /:(\d{1,5}):\s*bind:/i.exec(text)?.[1];
}

/** 起こした直後に何が起きたか */
type ServeSignal =
  | { kind: "error"; message: string }
  | { kind: "exited"; code: number | null; stderr: string }
  // 走り続けている場合も、その間に出た標準エラーは持ち歩く。
  // 時間切れになったとき、何を言いながら立ち上がろうとしていたのかが分かる
  | { kind: "running"; stderr: string };

/**
 * Ollamaサーバーを起動し、応答するまで待つ。
 *
 * VSCodeを閉じてもサーバーが残るよう、切り離した子プロセスとして起動する。
 * これはOllamaを手動で起動した場合と同じ状態であり、
 * 拡張機能の終了に巻き込んで止めると、他のツールの利用を妨げるため。
 */
export async function startOllama(
  options: StartOptions
): Promise<StartOutcome> {
  // **各段を残す。** LM Studioで「起動しない」と報告されたとき、
  // 起動処理が一切ログを書いておらず**何が起きたか確かめられなかった**
  // （設計書6.24）。Ollamaでも同じ報告を受けて同じ状況になったので、
  // 同じ扱いに揃える（0.28.14）
  const exe = await resolveExecutable(options.executablePath);
  if (!exe) {
    logFailure("Ollamaの起動", {
      理由: "実行ファイルが見つからない",
      探した場所: executableCandidates().join(" / "),
      設定: options.executablePath ?? "（未指定）",
    });
    return { ok: false, reason: "not_installed" };
  }
  logStep(`Ollama：起動を試みます（${exe} serve）`);

  const probe = options.probe ?? defaultProbe;
  const timeoutMs = options.timeoutMs ?? 30000;
  const startedAt = Date.now();

  const platform = options.platform ?? process.platform;

  let signal: ServeSignal;
  try {
    const spawner =
      options.spawner ?? ((e: string, a: string[]) => defaultSpawner(e, a, platform));
    const child = spawner(exe, ["serve"]);
    signal = await watchStartup(child, options.spawnWatchMs ?? SPAWN_WATCH_MS);
    // 判定が済んだら、走り続ける子から手を離す（`releaseStderr` の理由を参照）
    releaseStderr(child);
    child.unref();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logFailure("Ollamaの起動", { 場所: exe, 内容: detail });
    return { ok: false, reason: "spawn_failed", detail };
  }

  if (signal.kind === "error") {
    logFailure("Ollamaの起動", { 場所: exe, 内容: signal.message });
    return { ok: false, reason: "spawn_failed", detail: signal.message };
  }

  if (signal.kind === "exited" && signal.code !== 0) {
    const detail = signal.stderr.trim();
    if (isPortInUseError(signal.stderr)) {
      // **既に動いているOllamaが居るだけ**かもしれない。断じる前に1回確かめる
      // （LM Studioの「終了コードが0以外でも応答を見る」と同じ扱い）
      logStep(
        `Ollama：ポートが既に使われているため serve は終了しました（コード ${signal.code}）。応答があるか確かめます。`
      );
      if (await probe(options.endpoint)) {
        logStep("Ollama：既に動いているOllamaが応答しました（起動済みとして扱います）。");
        return { ok: true };
      }
      // ポートは握られているのに応答が無い。**起こし直しても直らない**——
      // 古いOllamaを終わらせるまで、bind失敗を延々とくり返す
      logFailure("Ollamaの起動", {
        場所: exe,
        理由: "ポートが使われたまま応答がありません（古いOllamaが残っている見込み）",
        終了コード: signal.code,
        接続先: options.endpoint,
        標準エラー: stderrDigest(signal.stderr),
      });
      return { ok: false, reason: "port_in_use_stale", detail };
    }

    if (!detail) {
      // **理由が読めないまま即終了した。** Windows以外は標準エラーを
      // 受け取らないので（`defaultSpawner`）、常にここへ来る。
      // 落ちた理由は名指しできないが、**いちばん多い原因（既に動いている）
      // かどうかは疎通で分かる**ので、1回だけ確かめてから決める
      logStep(
        `Ollama：serve が終了コード ${signal.code} で終わりました。応答があるか確かめます。`
      );
      if (await probe(options.endpoint)) {
        logStep("Ollama：既に動いているOllamaが応答しました（起動済みとして扱います）。");
        return { ok: true };
      }
      logFailure("Ollamaの起動", {
        場所: exe,
        理由: `serve が終了コード ${signal.code} で終わり、応答もありません`,
        接続先: options.endpoint,
      });
      return {
        ok: false,
        reason: "spawn_failed",
        // 理由が無くても、せめて終了コードは残す（前は何も添えられなかった）
        detail: `serve が終了コード ${signal.code} で終わりました。`,
      };
    }

    logFailure("Ollamaの起動", {
      場所: exe,
      理由: `serve が終了コード ${signal.code} で終わりました`,
      標準エラー: stderrDigest(signal.stderr),
    });
    // 理由が読めているときは疎通を確かめない——なぜ落ちたかは分かっている
    return { ok: false, reason: "spawn_failed", detail };
  }

  // ここまで来たのは「走り続けている」か「コード0で終わった」場合。
  // **どちらだったかを残す**——時間切れになったとき、serveが走り続けていたのか
  // 静かに終わっていたのかで、次に疑う場所がまるで違う
  logStep(
    signal.kind === "running"
      ? "Ollama：serve は走り続けています。応答を待ちます。"
      : "Ollama：serve は終了コード0で終わりました。応答を待ちます。"
  );

  // 起動しても即座には応答しないため、応答するまで待つ
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(options.endpoint)) {
      logStep(`Ollama：応答を確認しました（${Date.now() - startedAt}ミリ秒）`);
      return { ok: true };
    }
    await delay(500);
  }
  logFailure("Ollamaの起動", {
    場所: exe,
    理由: `${Math.round(timeoutMs / 1000)}秒待っても応答しませんでした`,
    接続先: options.endpoint,
    // 起動直後に何か言っていたなら、それが手がかりになる（空なら出ない）
    標準エラー: stderrDigest(signal.stderr),
  });
  return { ok: false, reason: "timeout" };
}

/**
 * `ollama serve` を起こす。**標準エラーを受け取るのはWindowsだけ。**
 *
 * 受け取りたい理由：前は `stdio: "ignore"` だったため、bind に失敗して
 * 即終了したことも、その理由（`Error: listen tcp 127.0.0.1:11434: bind: …`）
 * も見えず、30秒待った末に「応答しませんでした」としか言えなかった。
 *
 * **Windows以外で受け取らない理由：serve を殺しかねないから。** こちらは
 * 起動直後の1秒を見たら読み手を閉じる（`releaseStderr`）が、Goのランタイムは
 * **fd 2 への書き込みが壊れたパイプに当たると SIGPIPE で終了する**
 * （他のfdならEPIPEが返るだけ、という区別が `os/signal` の説明にある）。
 * つまりPOSIXでは、閉じた直後の最初のログ1行で `ollama serve` 本体が
 * 落ちうる——起動を助けるはずの処理が、起動を壊す。Windowsには SIGPIPE が
 * 無く、書き込みがエラーを返すだけ（Ollamaはそれを捨てる）なので安全である。
 *
 * 受け取れなくても、**即終了したこと自体は `exit` で分かる**。理由を
 * 名指しできないだけで、「落ちたが疎通はあるか」までは同じように見分ける。
 */
function defaultSpawner(
  exe: string,
  args: string[],
  platform: NodeJS.Platform
): LaunchedProcess {
  return spawn(exe, args, {
    detached: true,
    // 標準入力・標準出力はどちらのOSでも使わないので閉じたままにする
    stdio: platform === "win32" ? ["ignore", "ignore", "pipe"] : "ignore",
    windowsHide: true,
    // 拡張機能ホストの環境をそのまま継がせない（`childProcessEnv.ts`）。
    // Ollamaは Electron ではないので今のところ害は無いが、
    // **同じ穴を2か所に残さない**——LM Studioでは60秒の時間切れになった
    env: childProcessEnv(),
  });
}

/**
 * 起こした直後の短い窓だけ見張る。
 *
 * 見張るのは3つ。**`exit` を見るのが要点である**——spawn自体は成功し、
 * そのあとコード1で即終了する（ポートを握られている）という形が、
 * 以前の「`error` だけを見る」書き方では素通りしていた。
 */
function watchStartup(
  child: LaunchedProcess,
  watchMs: number
): Promise<ServeSignal> {
  return new Promise<ServeSignal>((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = (signal: ServeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(signal);
    };
    // 窓を過ぎても終わっていなければ、走り続けているとみなして疎通の確認へ
    const timer = setTimeout(() => finish({ kind: "running", stderr }), watchMs);

    // 起動直後の失敗は標準エラーにしか出ない。上限で打ち切る（`STDERR_LIMIT`）
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= STDERR_LIMIT) return;
      stderr = (stderr + chunk.toString()).slice(0, STDERR_LIMIT);
    });
    child.once("error", (error: Error) =>
      finish({ kind: "error", message: error.message })
    );
    child.once("exit", (code: number | null) =>
      finish({ kind: "exited", code, stderr })
    );
  });
}

/**
 * 判定が済んだら、標準エラーの受け口を閉じる。
 *
 * **切り離し（`detached` + `unref`）を壊さないための後始末である。**
 * `unref()` が参照を外すのは子プロセスの handle だけで、`stdio` の
 * パイプはそれとは別の handle として残る。開いたまま持ち続けると、
 * 拡張機能ホストのイベントループがそのパイプに掴まれ、
 * 「VS Codeを閉じてもOllamaは残る（手で起動したのと同じ状態）」という
 * これまでの動きが崩れる。
 *
 * 閉じても失うものは無い。Ollamaは自分のログを自分で書いており
 * （`%LOCALAPPDATA%\Ollama\server-*.log`）、こちらが読みたいのは
 * 起動直後の1秒だけだからである。
 */
function releaseStderr(child: LaunchedProcess): void {
  const stderr = child.stderr;
  if (!stderr) return;
  try {
    stderr.removeAllListeners();
    stderr.destroy();
  } catch {
    // 閉じられなくても起動の判定には影響しない。ここで止めるほうが害が大きい
  }
}

/**
 * ログへ載せるために、標準エラーの要点だけを残す。
 *
 * **先頭を残す。** 起動できなかった理由は最初の行に出る
 * （`lms load` の出力とは逆で、進捗の描き直しで埋まることが無い）。
 */
function stderrDigest(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}…`;
}

async function defaultProbe(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/tags`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 選択された実行ファイルが妥当か検証する。
 *
 * 選択ダイアログは何でも選べてしまうため、明らかに違うものを
 * 設定に書き込む前に気づけるようにする。
 * ただしOllamaはリネームやラッパー経由でも使われうるので、
 * 名前が違うだけでは拒否せず「確認が必要」に留める。
 */
export type ExecutableCheck =
  | { verdict: "ok" }
  | { verdict: "missing" }
  | { verdict: "suspicious"; reason: string };

export async function checkSelectedExecutable(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): Promise<ExecutableCheck> {
  if (!(await isExecutableFile(filePath))) return { verdict: "missing" };

  const base = path.basename(filePath).toLowerCase();

  if (platform === "win32" && !base.endsWith(".exe")) {
    return {
      verdict: "suspicious",
      reason: "実行ファイル（.exe）ではないようです。",
    };
  }

  // "ollama app.exe" はトレイ常駐アプリで、serve を受け付けない
  if (base === "ollama app.exe" || base === "ollama app") {
    return {
      verdict: "suspicious",
      reason:
        "これはトレイ常駐アプリです。サーバーを起動するには ollama.exe を選んでください。",
    };
  }

  const stem = base.replace(/\.exe$/, "");
  if (stem !== "ollama") {
    return {
      verdict: "suspicious",
      reason: `ファイル名が「${path.basename(filePath)}」です。`,
    };
  }

  return { verdict: "ok" };
}

/** 選択ダイアログに渡すフィルタ。プラットフォームで拡張子が異なる */
export function openDialogFilters(
  platform: NodeJS.Platform = process.platform
): Record<string, string[]> | undefined {
  if (platform === "win32") {
    return { "実行ファイル": ["exe"], "すべてのファイル": ["*"] };
  }
  // macOS/Linuxの実行ファイルに拡張子は無い
  return undefined;
}

/** 起動に失敗した理由を、作者が次に取れる操作つきで説明する */
export function describeStartFailure(outcome: StartOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "not_installed":
      return (
        "Ollamaの実行ファイルが見つかりませんでした。" +
        "インストール済みの場合は、設定 novelai.ollama.executablePath に " +
        "ollama の場所を指定してください。"
      );
    case "spawn_failed":
      return (
        "Ollamaを起動できませんでした。" +
        "手動で起動してから、もう一度お試しください。" +
        (outcome.detail ? `（${outcome.detail}）` : "")
      );
    case "port_in_use_stale": {
      // **作者はプログラマではない。** 「ポートが使われています」だけでは
      // 何をすればよいか分からないので、終わらせ方を2通り示す。
      // 再試行を促さない——古いほうが残っている限り、何度押しても同じ
      //
      // ポート番号は**失敗の文から取る**（`detail` は bind の文そのもの）。
      // 決め打ちにすると、接続先を既定から変えている作者に
      // 見当違いの番号を探させることになる。読めなければ既定を言う
      const port = portFromBindError(outcome.detail ?? "") ?? "11434";
      return (
        `別のOllamaがポート${port}を使ったまま、応答していません。` +
        "タスクトレイのOllamaアイコンから終了" +
        "（無ければタスクマネージャーで ollama.exe を終了）してから、" +
        "もう一度お試しください。"
      );
    }
    case "timeout":
      return (
        "Ollamaを起動しましたが、応答するまでに時間がかかっています。" +
        "しばらく待ってから「再試行」を押してください。"
      );
  }
}
