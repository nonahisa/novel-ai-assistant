import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { resolveExecutable } from "./ollamaLauncher";

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
 */

export { isLocalEndpoint } from "./ollamaLauncher";

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
  /** 起動を待つ上限 */
  timeoutMs?: number;
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
 * `lms server start` は**開始を指示して戻る**コマンドで、Ollamaの `serve`
 * のように動き続けるわけではない。そのため切り離し（`detached`）は要らず、
 * 終了を待ってから疎通を確かめる。
 */
export async function startLmStudioServer(
  options: StartOptions
): Promise<StartOutcome> {
  const cli = await resolveCli(options.cliPath);
  if (!cli) return { ok: false, reason: "not_installed" };

  const probe = options.probe ?? defaultProbe;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runCli = options.runCli ?? defaultRunCli;
  const deadline = Date.now() + timeoutMs;

  // `-p` の長い形。ポートを省くとLM Studio側の既定になり、
  // 設定した接続先と食い違ったまま「応答しない」になる
  const outcome = await runCli(cli, [
    "server",
    "start",
    "--port",
    String(serverPort(options.endpoint)),
  ]);

  if (outcome.kind === "error") {
    // コマンドが見つからないのは「起動に失敗した」ではなく「入っていない」。
    // PATH頼みの候補（"lms"）はここまで存在確認をしていないので、
    // 通っていない機械ではこの経路で分かる。案内も別のものを出したい
    if (/ENOENT/.test(outcome.message)) {
      return { ok: false, reason: "not_installed", detail: outcome.message };
    }
    return { ok: false, reason: "spawn_failed", detail: outcome.message };
  }

  if (outcome.kind === "exited" && outcome.code !== 0) {
    // **すでに動いている場合の終了コードを測っていない。** 0以外でも
    // 実際には動いていることがありうるので、断じる前に1回だけ確かめる。
    // ここで確かめずに待ちへ入ると、失敗が分かるまで作者を1分待たせる
    if (await probe(options.endpoint)) return { ok: true };
    return {
      ok: false,
      reason: "spawn_failed",
      detail: `lms server start が終了コード ${outcome.code} で終わりました。`,
    };
  }

  // 起動を指示しても、待ち受けを始めるまでには間がある。
  // 上限まで、応答するまで待つ（1回は必ず確かめる）
  for (;;) {
    if (await probe(options.endpoint)) return { ok: true };
    if (Date.now() >= deadline) return { ok: false, reason: "timeout" };
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * `lms` を起動し、終わるまで待つ。
 *
 * 出力は捨てる（`stdio: "ignore"`）。成否は終了コードと、
 * このあとの疎通確認で判断できる。
 */
function defaultRunCli(cli: string, args: string[]): Promise<CliOutcome> {
  return new Promise<CliOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: CliOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    try {
      const child = spawn(cli, args, {
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (e: Error) => finish({ kind: "error", message: e.message }));
      child.once("exit", (code) => finish({ kind: "exited", code }));
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
 * モデルを、文脈の長さを指定して読み込ませる。
 *
 * **`lms unload` は呼ばない。** 読み込み済みのモデルを勝手に外すと、
 * 作者がLM Studioの画面で整えた状態を壊す。
 */
export async function loadLmStudioModel(
  options: LoadOptions
): Promise<LoadOutcome> {
  const cli = await resolveCli(options.cliPath);
  if (!cli) return { ok: false, reason: "not_installed" };

  const timeoutMs = options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const runCli =
    options.runCli ?? ((c: string, a: string[]) => defaultLoadCli(c, a, timeoutMs));
  // `-y` は確認を出さないための指定。問い合わせに答える相手がいない
  const args = ["load", options.model, "-y"];
  if (options.contextLength !== undefined) {
    args.push("--context-length", String(options.contextLength));
  }

  const outcome = await runCli(cli, args);

  if (outcome.kind === "error") {
    if (/ENOENT/.test(outcome.message)) {
      return { ok: false, reason: "not_installed", detail: outcome.message };
    }
    return { ok: false, reason: "load_failed", detail: outcome.message };
  }
  if (outcome.kind === "timeout") {
    return { ok: false, reason: "timeout", detail: trimOutput(outcome.output) };
  }
  if (outcome.code === 0) return { ok: true };
  return {
    ok: false,
    reason: "load_failed",
    detail: trimOutput(outcome.output),
  };
}

/** 通知に載る長さへ切る。原因の見当がつく先頭を残す */
function trimOutput(output: string): string {
  return output.trim().slice(0, 300);
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
      child = spawn(cli, args, { windowsHide: true });
      // 進み具合は標準出力、失敗の理由は標準エラーに出る。両方を集める
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
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
      // （生成時の失敗〈`lmstudioProvider.ts`〉と同じ言い方に揃える）
      const head = /insufficient system resources/i.test(detail)
        ? "メモリ不足の見込みで読み込みを止めました（LM Studio の安全装置）。" +
          "より小さいモデルを選ぶか、LM Studioの設定で" +
          "モデル読み込みの安全装置（guardrails）を確認してください。"
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
        "LM Studioの画面で「Developer」からサーバーを開始してください。"
      );
  }
}
