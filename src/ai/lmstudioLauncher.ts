import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { resolveExecutable } from "./ollamaLauncher";
import { childProcessEnv } from "./childProcessEnv";
import { logFailure, logStep } from "../core/logger";

/**
 * LM Studioのローカルサーバーの起動を支援する（設計書6.24）。
 *
 * 作者の依頼（2026-08-29）：「LMスタジオの起動をOllamaと同じ形でお願いします」。
 *
 * ## 前提が変わった——GUIアプリだが、CLIがある
 *
 * `setupLmStudio.ts` は当初「LM StudioはGUIのアプリなので、こちらからは
 * 起動できない」という前提で書かれていた。**これは古い。** LM Studioは
 * `lms` というCLIを同梱しており、`lms server start` でサーバーを開始できる
 * （この機械で `lms server status` が「The server is running on port 1234.」
 * を返すことを確認、2026-08-29）。Ollamaと同じく、**作者がボタンを押した
 * ときだけ**起動する。勝手には起こさない。
 *
 * ## モデルの読み込み（`lms load`）も、こちらで行う
 *
 * LM Studioは**要求されたモデルをその場で読み込む**（JIT）ので、当初は
 * 「読み込みは LM Studio に任せる」つもりだった。だが JIT で載るときの
 * 文脈の長さは LM Studio 側の既定（短い）になり、拡張機能の分割の想定と
 * 食い違う（作者の報告、2026-08-29「8kと出てしまう」）。そこで
 * `loadLmStudioModel` で **`--context-length` を指定して**こちらから読み込む
 * （どの長さで載ったかを拡張機能が知っている状態にする。`lmstudioModelLoad.ts`）。
 * 読み込み済みのものは触らない。
 *
 * ## 接続先がローカルかの判定は写さない
 *
 * `isLocalEndpoint` はOllamaのものと同じ判断なので、`ollamaLauncher.ts`
 * から持ってきてそのまま出し直す。同じ規則を2か所に書くと、片方だけ直る。
 *
 * ## 起動できなかったときのために、各段をログへ残す
 *
 * 作者の報告（2026-08-30）「自動起動しませんでした」を確かめようとしたとき、
 * このファイルは**ログを1行も書いていなかった**ため、どこで止まったのかが
 * 分からなかった。指示・結果・疎通の各段を `logStep` / `logFailure` で残す。
 */

export { isLocalEndpoint } from "./ollamaLauncher";

/**
 * 子へ渡す環境変数（`childProcessEnv.ts`）。
 *
 * **写しを作らず、そのまま出し直す。** 実体を別ファイルへ置いてあるのは、
 * `ollamaLauncher.ts` からも使うため（こちらに置くと循環参照になる）。
 */
export { childProcessEnv } from "./childProcessEnv";

/**
 * LM Studioのローカルサーバーの既定のポート。
 * 接続先のURLにポートが書かれていないときの拠り所にする。
 */
const DEFAULT_PORT = 1234;

/** 疎通確認の間隔 */
const POLL_INTERVAL_MS = 500;

/**
 * 起動を待つ既定の上限。
 *
 * **未計測。** LM Studio本体が立ち上がっていないときは、`lms server start`
 * が本体の起動から始めるため数十秒かかりうる。Ollama（30秒）より長めに
 * 取ってある。実機で測れたら詰める。
 */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * `lms` の候補を、探す順に返す。
 *
 * **既定の置き場所を先、PATHを後**にしてある。LM Studioがコマンドを
 * PATHへ通すのは初回の「CLIを有効化」を行ったあとで、通っていない機械の
 * ほうが多い。先にPATHを見ると、入っているのに「見つかりません」になる。
 *
 * @param _env Ollama側と引数の並びを揃えるためだけに受ける。LM Studioの
 *   置き場所はホーム直下に決まっており、環境変数からは組み立てない
 */
export function cliCandidates(
  platform: NodeJS.Platform = process.platform,
  _env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir()
): string[] {
  if (platform === "win32") {
    return [path.join(homedir, ".lmstudio", "bin", "lms.exe"), "lms"];
  }
  // Mac / Linux は拡張子が無いだけで、置き場所は同じ
  return [path.join(homedir, ".lmstudio", "bin", "lms"), "lms"];
}

/**
 * `lms` の場所を決める。見つからなければ undefined。
 *
 * 探し方（明示指定を尊重する・パス区切りを含まない候補はPATH解決に任せる）は
 * Ollamaとまったく同じなので、`ollamaLauncher.ts` のものを使う。**写さない。**
 */
export function resolveCli(
  configuredPath?: string,
  candidates: string[] = cliCandidates()
): Promise<string | undefined> {
  return resolveExecutable(configuredPath, candidates);
}

export type StartOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "not_installed" | "spawn_failed" | "timeout";
      detail?: string;
    };

export interface StartOptions {
  /** OpenAI互換の口（`http://localhost:1234/v1`）。ポートはここから読む */
  endpoint: string;
  /** 設定 `novelai.lmstudio.cliPath` で明示された場所 */
  cliPath?: string;
  /** 起動を待つ上限（疎通のポーリングの締切） */
  timeoutMs?: number;
  /**
   * `lms server start` の**終了**を待つ上限。
   *
   * 既定は10秒。ここで打ち切っても子は殺さない（下の `defaultRunCli`）。
   */
  spawnWaitMs?: number;
  /** 疎通確認。テストから差し替えられるようにする */
  probe?: (endpoint: string) => Promise<boolean>;
  /**
   * `lms` を起動して、終わるまで待つ処理。テストから差し替えるためにある。
   *
   * **テストで本物のプロセスを起こさないため**の差し替え口である。
   * Ollama側は「Node自身を起動する」ことで代用しているが、こちらは
   * 終了コードで扱いを分けるため、代用では狙った枝を通せない。
   */
  runCli?: (cli: string, args: string[]) => Promise<CliOutcome>;
}

/**
 * `lms server start` の終了を待つ既定の上限。
 *
 * **待ち切らずに先へ進む。** LM Studio本体が立ち上がっていないとき、
 * `lms server start` は本体の起動から始めるので、**戻ってこないことがある**。
 * 上限が無いと進捗表示が永久に出たままになる（作者は何が起きているか
 * 分からない）。打ち切っても、このあとの疎通のポーリングで結果は分かる。
 */
const DEFAULT_SPAWN_WAIT_MS = 10000;

/** `lms` を起動した結果。待っても終わらなければ `running` */
export type CliOutcome =
  | { kind: "exited"; code: number | null }
  | { kind: "error"; message: string }
  | { kind: "running" };

/**
 * サーバーの待ち受けポート。読めなければ既定の1234。
 *
 * 設定に入っているのは `…:1234/v1` のようなURLなので、そこから取る。
 * **作者にポートを別途設定させない。**
 */
export function serverPort(endpoint: string): number {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return DEFAULT_PORT;
  }
  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

/**
 * LM Studioのサーバーを起動し、応答するまで待つ。
 *
 * `lms server start` は**開始を指示して戻る**コマンドのつもりだったが、
 * **LM Studio本体が立ち上がっていないときは戻ってこない**（本体の起動から
 * 始まる）。そこでOllamaと同じく切り離して（`detached`）起こし、終了待ちは
 * `spawnWaitMs` で打ち切って疎通のポーリングへ進む。**打ち切っても子は
 * 殺さない**——起動途中のLM Studioを殺してしまう。
 */
export async function startLmStudioServer(
  options: StartOptions
): Promise<StartOutcome> {
  const cli = await resolveCli(options.cliPath);
  if (!cli) {
    logFailure("LM Studioの起動", {
      段階: "lms の場所",
      本文: "lms コマンドが見つかりませんでした。",
    });
    return { ok: false, reason: "not_installed" };
  }

  const probe = options.probe ?? defaultProbe;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnWaitMs = options.spawnWaitMs ?? DEFAULT_SPAWN_WAIT_MS;
  const runCli =
    options.runCli ?? ((c: string, a: string[]) => defaultRunCli(c, a, spawnWaitMs));
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const port = serverPort(options.endpoint);

  logStep(`LM Studio：起動を試みます（${cli} server start --port ${port}）`);

  // `-p` の長い形。ポートを省くとLM Studio側の既定になり、
  // 設定した接続先と食い違ったまま「応答しない」になる
  const outcome = await runCli(cli, ["server", "start", "--port", String(port)]);

  if (outcome.kind === "error") {
    // コマンドが見つからないのは「起動に失敗した」ではなく「入っていない」。
    // PATH頼みの候補（"lms"）はここまで存在確認をしていないので、
    // 通っていない機械ではこの経路で分かる。案内も別のものを出したい
    const notInstalled = /ENOENT/.test(outcome.message);
    logFailure("LM Studioの起動", {
      段階: "lms server start",
      結果: notInstalled ? "コマンドが見つからない" : "起動できない",
      本文: outcome.message,
    });
    if (notInstalled) {
      return { ok: false, reason: "not_installed", detail: outcome.message };
    }
    return { ok: false, reason: "spawn_failed", detail: outcome.message };
  }

  logStep(
    outcome.kind === "running"
      ? "LM Studio：lms server start が待ち時間内に終わらなかったため、疎通の確認へ進みます。"
      : `LM Studio：lms server start が終了コード ${outcome.code} で終わりました。`
  );

  if (outcome.kind === "exited" && outcome.code !== 0) {
    // **すでに動いている場合の終了コードを測っていない。** 0以外でも
    // 実際には動いていることがありうるので、断じる前に1回だけ確かめる。
    // ここで確かめずに待ちへ入ると、失敗が分かるまで作者を1分待たせる
    if (await probe(options.endpoint)) {
      logStep(
        "LM Studio：終了コードは0以外でしたが、サーバーは応答しています（すでに起動済み）。"
      );
      return { ok: true };
    }
    logFailure("LM Studioの起動", {
      段階: "lms server start",
      結果: `終了コード ${outcome.code}／応答なし`,
    });
    return {
      ok: false,
      reason: "spawn_failed",
      detail: `lms server start が終了コード ${outcome.code} で終わりました。`,
    };
  }

  // 起動を指示しても、待ち受けを始めるまでには間がある。
  // 上限まで、応答するまで待つ（1回は必ず確かめる）
  for (;;) {
    if (await probe(options.endpoint)) {
      logStep(
        `LM Studio：サーバーの応答を確認しました（${Date.now() - startedAt}ミリ秒）。`
      );
      return { ok: true };
    }
    if (Date.now() >= deadline) {
      // **時間切れは、原因が分からないまま終わるいちばん困る形である。**
      // どれだけ待ったのかを残しておかないと、設定を延ばすべきなのか
      // 別の原因（環境変数の継承など）なのかを後から切り分けられない
      logFailure("LM Studioの起動", {
        段階: "疎通の確認",
        結果: `${Date.now() - startedAt}ミリ秒待っても応答がありません`,
        接続先: options.endpoint,
      });
      return { ok: false, reason: "timeout" };
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * `lms` を起動し、終わるのを上限まで待つ。
 *
 * 出力は捨てる（`stdio: "ignore"`）。成否は終了コードと、
 * このあとの疎通確認で判断できる。
 *
 * **切り離して起こし、待ち切れなければ `running` を返す。** LM Studio本体が
 * 立ち上がっていないと `lms server start` は本体の起動から始めるため、
 * 分単位で戻らないことがある。待ち続けると進捗表示が出たままになるので、
 * `waitMs` で打ち切って疎通のポーリングへ譲る。**子は kill しない**——
 * ここで殺すと、起動しかけたLM Studioを自分で止めることになる
 * （Ollamaの `serve` を切り離すのと同じ考え方）。
 */
function defaultRunCli(
  cli: string,
  args: string[],
  waitMs = DEFAULT_SPAWN_WAIT_MS
): Promise<CliOutcome> {
  return new Promise<CliOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: CliOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "running" }), waitMs);

    try {
      const child = spawn(cli, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        // **拡張機能ホストの環境をそのまま継がせない**（`childProcessEnv.ts`）。
        // `ELECTRON_RUN_AS_NODE=1` を継いだ LM Studio 本体は素のNodeとして
        // 起動して即終了し、ここは必ず60秒の時間切れになる
        env: childProcessEnv(),
      });
      child.once("error", (e: Error) => finish({ kind: "error", message: e.message }));
      child.once("exit", (code) => finish({ kind: "exited", code }));
      // VS Codeを閉じてもサーバーが残るようにする（手で起動したのと同じ状態）
      child.unref();
    } catch (e) {
      finish({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

/**
 * サーバーが応答するか。
 *
 * OpenAI互換の口のモデル一覧を叩く。**LM Studioはモデルが未読込でも
 * ダウンロード済みの一覧を返す**ので、「サーバーが立っているか」の
 * 確認としてはこれで足りる。
 */
async function defaultProbe(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/models`, {
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
 * 読み込みを待つ既定の上限。
 *
 * **未計測。** 大きいモデルはディスクから読むだけで分単位かかりうる。
 * 起動（60秒）より長めに取ってある。実機で測れたら詰める。
 */
const DEFAULT_LOAD_TIMEOUT_MS = 180000;

export type LoadOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "not_installed" | "load_failed" | "timeout";
      detail?: string;
    };

export interface LoadOptions {
  /** 設定 `novelai.lmstudio.cliPath` で明示された場所 */
  cliPath?: string;
  /** 読み込むモデルのキー（`google/gemma-4-e4b` など） */
  model: string;
  /**
   * 読み込む文脈の長さ。省くとLM Studio側の既定になる。
   *
   * **ここを指定することが、この関数の存在理由である。** JIT（要求時の
   * 自動読み込み）に任せるとLM Studio側の既定の短い長さで載り、
   * 拡張機能が本文を分割するときの想定と食い違う。
   */
  contextLength?: number;
  timeoutMs?: number;
  /** `lms` を起動して待つ処理。テストから差し替える */
  runCli?: (cli: string, args: string[]) => Promise<LoadCliOutcome>;
}

/** `lms load` の結果。出力は失敗の説明に使うので捨てない */
export type LoadCliOutcome =
  | { kind: "exited"; code: number | null; output: string }
  | { kind: "error"; message: string }
  | { kind: "timeout"; output: string };

/**
 * 読み込むときに指定する文脈の長さを決める。
 *
 * `上限` は設定 `novelai.lmstudio.loadContextLength`。**0 はモデルの最大**
 * という意味にしてある（作者が何も決めなくても、いちばん長く読める）。
 * モデルの最大が分からないときは、設定値をそのまま使う——分からないものを
 * 勝手に大きく見積もらない。
 *
 * @returns 指定しないほうがよければ undefined（LM Studioの既定に任せる）
 */
export function decideLoadContextLength(
  maxContextLength: number | undefined,
  configuredLimit: number
): number | undefined {
  const max =
    typeof maxContextLength === "number" &&
    Number.isFinite(maxContextLength) &&
    maxContextLength > 0
      ? Math.floor(maxContextLength)
      : undefined;
  const limit =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.floor(configuredLimit)
      : undefined;

  if (max === undefined) return limit;
  if (limit === undefined) return max;
  // 上限を超えて読み込ませない。メモリを使い切ると機械ごと固まる
  return Math.min(max, limit);
}

/**
 * これ以上は短くしない長さ。
 *
 * 8192 は LM Studio 側の既定と同じくらいで、ここまで下げても載らないなら
 * **文脈の長さが原因ではない**（モデルそのものが機械に対して大きい）。
 * さらに下げても、通ったところで本文がまともに入らない。
 */
const MIN_LOAD_CONTEXT_LENGTH = 8192;

/** 読み込みを試す回数の上限。断られるたびに数十秒かかるので、粘りすぎない */
const MAX_LOAD_ATTEMPTS = 4;

/**
 * 読み込みを試す文脈の長さを、長いほうから順に並べる。
 *
 * **既定（設定 0）はモデルの最大で読み込む**ので、メモリの足りない機械では
 * LM Studio の安全装置に断られる。そこで断られたら半分にして試し直す——
 * 以前はここで諦めており、`ensureConfigured` が undefined を返して
 * **AI機能が丸ごと動かなくなっていた**（12b を未読込のまま選んだ機械で、
 * 誤字脱字も相談も一切動かない）。
 *
 * 下限（8192）より短くはしない。そこまで下げても断られるなら、
 * 文脈の長さでは解決しない。
 */
export function contextLengthRetrySteps(
  start: number,
  options: { maxAttempts?: number; floor?: number } = {}
): number[] {
  const maxAttempts = options.maxAttempts ?? MAX_LOAD_ATTEMPTS;
  const floor = options.floor ?? MIN_LOAD_CONTEXT_LENGTH;
  const first = Math.floor(start);
  // モデルの最大がもともと下限より短いことがある。**引き上げない**
  if (!Number.isFinite(first) || first <= floor) return [first];

  const steps = [first];
  while (steps.length < maxAttempts) {
    const next = Math.floor(steps[steps.length - 1] / 2);
    if (next <= floor) {
      steps.push(floor);
      break;
    }
    steps.push(next);
  }
  return steps;
}

/**
 * メモリ不足で断られたか。
 *
 * LM Studio の安全装置（guardrails）が出す言い回しで見分ける。
 * **これだけを再試行の対象にする**——モデル名の間違いなど、
 * 短くしても直らない失敗を何度も試すと作者を待たせるだけである。
 */
export function isInsufficientResources(detail: string | undefined): boolean {
  return /insufficient system resources/i.test(detail ?? "");
}

/** 「読み込み済み」と確かめたことを覚えておく長さ */
export const LOAD_CONFIRM_TTL_MS = 30000;

/**
 * 「読み込み済み」と確かめた記憶が、まだ使えるか。
 *
 * AI機能を呼ぶたびに `readModelLoadState` でLM Studioへ聞きに行くと、
 * 設定資料パネルの相談では**質問のたびに**HTTPの往復が入る。
 * 載せ替えはLM Studioの画面で人が行うので、数十秒の古さは害にならない。
 *
 * **覚えるのは「読み込み済み」だけである**（CLAUDE.md 規則5「失敗から
 * 学習しない」）。未読込・読み込み失敗を覚えると、作者がLM Studioの画面で
 * 載せ直しても、こちらは古い判断のまま動き続ける。
 */
export function isRecentlyConfirmed(
  confirmedAt: number | undefined,
  now: number,
  ttlMs: number = LOAD_CONFIRM_TTL_MS
): boolean {
  if (confirmedAt === undefined) return false;
  // 時計が巻き戻った（スリープ復帰など）ときは、覚えを捨てて聞き直す
  if (now < confirmedAt) return false;
  return now - confirmedAt < ttlMs;
}

/**
 * モデルを、文脈の長さを指定して読み込ませる。
 *
 * **`lms unload` は呼ばない。** 読み込み済みのモデルを勝手に外すと、
 * 作者がLM Studioの画面で整えた状態を壊す。
 */
export async function loadLmStudioModel(
  options: LoadOptions
): Promise<LoadOutcome> {
  const cli = await resolveCli(options.cliPath);
  if (!cli) {
    logFailure("LM Studioのモデル読み込み", {
      段階: "lms の場所",
      本文: "lms コマンドが見つかりませんでした。",
    });
    return { ok: false, reason: "not_installed" };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const runCli =
    options.runCli ?? ((c: string, a: string[]) => defaultLoadCli(c, a, timeoutMs));
  // `-y` は確認を出さないための指定。問い合わせに答える相手がいない
  const args = ["load", options.model, "-y"];
  if (options.contextLength !== undefined) {
    args.push("--context-length", String(options.contextLength));
  }

  const startedAt = Date.now();
  logStep(
    `LM Studio：モデル「${options.model}」の読み込みを指示します` +
      `（文脈 ${options.contextLength ?? "LM Studioの既定"}）。`
  );

  const outcome = await runCli(cli, args);

  if (outcome.kind === "error") {
    const notInstalled = /ENOENT/.test(outcome.message);
    logFailure("LM Studioのモデル読み込み", {
      段階: "lms load",
      結果: notInstalled ? "コマンドが見つからない" : "起動できない",
      本文: outcome.message,
    });
    if (notInstalled) {
      return { ok: false, reason: "not_installed", detail: outcome.message };
    }
    return { ok: false, reason: "load_failed", detail: outcome.message };
  }
  if (outcome.kind === "timeout") {
    logFailure("LM Studioのモデル読み込み", {
      段階: "lms load",
      結果: `${timeoutMs}ミリ秒待っても終わりませんでした`,
      本文: trimOutput(outcome.output),
    });
    return { ok: false, reason: "timeout", detail: trimOutput(outcome.output) };
  }
  if (outcome.code === 0) {
    logStep(
      `LM Studio：モデル「${options.model}」を読み込みました` +
        `（${Date.now() - startedAt}ミリ秒）。`
    );
    return { ok: true };
  }
  logFailure("LM Studioのモデル読み込み", {
    段階: "lms load",
    結果: `終了コード ${outcome.code}`,
    本文: trimOutput(outcome.output),
  });
  return {
    ok: false,
    reason: "load_failed",
    detail: trimOutput(outcome.output),
  };
}

/**
 * 通知に載る長さへ切る。**末尾を残す。**
 *
 * `lms load` の失敗の理由（「insufficient system resources … requires
 * approximately 44.87 GB」等、約330字）は出力の**最後**に出る。先頭を残すと、
 * 進捗バーの再描画で埋まった出力では理由が落ち、`isInsufficientResources`
 * が見逃して**文脈を下げる再試行が走らない**。理由の1文が丸ごと入る長さにする
 */
function trimOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= 600 ? trimmed : trimmed.slice(trimmed.length - 600);
}

/** `lms load` の出力を溜めておく上限（末尾だけ残す） */
const LOAD_OUTPUT_TAIL_CHARS = 4096;

/**
 * 末尾だけを残す。
 *
 * **溜め込まない。** `lms load` は読み込み中、進捗バーを何度も描き直す
 * （同じ行を書き換えるために制御文字ごと送り直す）ので、大きいモデルでは
 * 数MBになる。失敗の理由は**最後に出る**ので、末尾だけあれば足りる。
 */
export function keepTail(
  text: string,
  maxChars: number = LOAD_OUTPUT_TAIL_CHARS
): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/**
 * `lms load` を走らせ、出力を集めて終わるまで待つ。
 *
 * **出力を捨てない。** 読み込めなかった理由（メモリが何GB足りないか）は
 * ここにしか出ない。捨てると「読み込めませんでした」としか言えなくなる。
 */
function defaultLoadCli(
  cli: string,
  args: string[],
  timeoutMs = DEFAULT_LOAD_TIMEOUT_MS
): Promise<LoadCliOutcome> {
  return new Promise<LoadCliOutcome>((resolve) => {
    let settled = false;
    let output = "";
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (outcome: LoadCliOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // 待っても終わらないときは、読み込みを止めて手を戻す。
    // 放っておくと進捗表示が出たまま作者を待たせ続ける
    const timer = setTimeout(() => {
      child?.kill();
      finish({ kind: "timeout", output });
    }, timeoutMs);

    try {
      // 環境変数を落とす理由は `defaultRunCli` と同じ（`childProcessEnv.ts`）。
      // 読み込みも LM Studio 本体を起こすことがあるので、ここも同じにする
      child = spawn(cli, args, { windowsHide: true, env: childProcessEnv() });
      // 進み具合は標準出力、失敗の理由は標準エラーに出る。両方を集めるが、
      // **末尾だけ残す**（進捗バーの描き直しで数MBになる。`keepTail`）
      child.stdout?.on("data", (chunk: Buffer) => {
        output = keepTail(output + chunk.toString());
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output = keepTail(output + chunk.toString());
      });
      child.once("error", (e: Error) =>
        finish({ kind: "error", message: e.message })
      );
      child.once("close", (code) => finish({ kind: "exited", code, output }));
    } catch (e) {
      finish({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

/**
 * 読み込む文脈の長さを、作者が自分で決められることを伝える一言。
 *
 * **設定の名前をそのまま書く。** 「設定で小さくできます」だけでは、
 * どこを触ればよいのか分からない（プログラマではない作者の環境）。
 * 生成時の失敗（`ai/types.ts` の `recoveryForAIError`）とも同じ文言にする。
 */
export const LOAD_CONTEXT_SETTING_HINT =
  "読み込む文脈の長さは設定 novelai.lmstudio.loadContextLength で小さくできます。";

/** 読み込みに失敗した理由を、作者が次に取れる操作つきで説明する */
export function describeLoadFailure(outcome: LoadOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "not_installed":
      return (
        "LM Studioのコマンド（lms）が見つからないため、モデルを読み込めませんでした。" +
        "LM Studioの画面でモデルを読み込んでください。"
      );
    case "timeout":
      return (
        "LM Studioのモデルの読み込みが、待っても終わりませんでした。" +
        "LM Studioの画面で読み込みの様子を確認してください。"
      );
    case "load_failed": {
      const detail = outcome.detail ?? "";
      // **メモリ不足はいちばん多く、直し方も違う。** 先に言う
      // （生成時の失敗〈`lmstudioProvider.ts`〉と同じ言い方に揃える）。
      // **設定の名前まで出す。** 「小さいモデルを選べ」しか言われないと、
      // いま使いたいモデルを諦めるほかに手が無いように見える。実際には
      // 文脈を短くすれば載ることが多い（こちらでも半分ずつ試している）
      const head = isInsufficientResources(detail)
        ? "メモリ不足の見込みで読み込みを止めました（LM Studio の安全装置）。" +
          "より小さいモデルを選ぶか、LM Studioの設定で" +
          "モデル読み込みの安全装置（guardrails）を確認してください。" +
          LOAD_CONTEXT_SETTING_HINT
        : "LM Studioがモデルを読み込めませんでした。";
      return detail ? `${head}LM Studio の説明：${detail}` : head;
    }
  }
}

/** 起動に失敗した理由を、作者が次に取れる操作つきで説明する */
export function describeStartFailure(outcome: StartOutcome): string {
  if (outcome.ok) return "";
  switch (outcome.reason) {
    case "not_installed":
      return (
        "LM Studioのコマンド（lms）が見つかりません。" +
        "LM Studioを入れると ~/.lmstudio/bin に置かれます。" +
        "場所が違う場合は、設定 novelai.lmstudio.cliPath で指定してください。"
      );
    case "spawn_failed":
      return (
        "LM Studioのサーバーを起動できませんでした。" +
        "LM Studioの画面で「Developer」からサーバーを開始してください。" +
        (outcome.detail ? `（${outcome.detail}）` : "")
      );
    case "timeout":
      return (
        "LM Studioのサーバーの起動を待ちましたが、応答がありません。" +
        "LM Studioの画面で「Developer」からサーバーを開始してください。" +
        // **逃げ道を1つ足す。** 時間切れの原因はこちらからは分からないので、
        // 「手で起こしてからもう一度」を示す（本体さえ上がっていれば、
        // `lms server start` は0.2秒で通ることを実機で確認した）
        "LM Studio を手で起動してから、もう一度お試しください。"
      );
  }
}
