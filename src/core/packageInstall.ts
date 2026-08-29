import { spawn } from "child_process";
import { childProcessEnv } from "../ai/childProcessEnv";

/**
 * パッケージ管理から必要なものを入れる。
 *
 * ## 方針を変えた（2026-08-15）
 *
 * 以前は「**勝手にインストールしない**。配布ページを開くだけ」としていた
 * （設計書6.16）。作者から「自動導入してほしい」という指定があったので改める。
 *
 * ただし**黙って入れることはしない。** 何を・どれだけ・なぜ入れるのかを
 * 見せてから、作者が押したときに実行する。環境を変える操作であり、
 * 管理者の権限を求められることもあるためである。
 *
 * ## なぜターミナルではなく子プロセスで動かすか
 *
 * ターミナルへ流すと、**終わったかどうかを拡張機能が知れない。**
 * 「入れ終わったらもう一度セットアップを実行してください」と頼むことになり、
 * 案内が途切れる。子プロセスなら終了を待って次の段へ進める。
 * 進み具合は行単位で拾って進捗表示へ流す。
 *
 * VS Code APIに依存しない（進捗の見せ方は呼び出し側が決める）。
 */

/**
 * 使えるパッケージ管理。
 *
 * **`manual` は「入れられない」ではなく「手順を示す」。**
 * Linuxは公式の案内が `curl … | sh` の形だが、**ネットから取ってきた
 * スクリプトを拡張機能が黙って実行するのは筋が悪い。** 何が走るのかを
 * 見せて、作者に判断してもらう。
 */
export type PackageManager = "winget" | "brew" | "manual" | "none";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number; onLine?: (line: string) => void }
) => Promise<CommandResult>;

/** 既定の実行。進み具合を行ごとに拾えるようにしてある */
export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      // 拡張機能ホストの `ELECTRON_RUN_AS_NODE` を継がせない（設計書6.24）。
      // ここが起こすのはパッケージ管理（winget・brew）なのでElectronでは
      // ないが、**同じ穴を1つだけ残さない**。将来ここからElectron製の
      // 導入ツールを呼んだときに、原因の分からない即終了として現れる
      env: childProcessEnv(),
    });

    let stdout = "";
    let stderr = "";
    let buffer = "";
    let settled = false;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, options.timeoutMs ?? 15 * 60 * 1000);

    /**
     * 進み具合を行に切り出す。
     *
     * **標準出力と標準エラーの両方から拾う。** `ollama pull` は進み具合を
     * **標準エラーだけ**へ出す（実機で確認。標準出力は0バイトだった）。
     * 片方しか見ないと、9.6GBの取得中ずっと進捗が止まって見える。
     */
    const feed = (text: string): void => {
      if (!options.onLine) return;
      buffer += text;
      // 進み具合は \r で上書きされる。改行と両方で区切る
      const parts = buffer.split(/[\r\n]+/);
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const cleaned = stripControl(line);
        if (cleaned) options.onLine(cleaned);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      feed(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      feed(text);
    });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });

/**
 * 使えるパッケージ管理を調べる。
 *
 * - Windows：winget（標準で入っている）
 * - macOS：Homebrew（入っていれば）。無ければ手順を示す
 * - Linux：手順を示す
 *
 * **Homebrewが無くても「入れられない」で終わらせない。** 配布ページから
 * 入れる道は残っている。
 */
export async function detectPackageManager(
  run: CommandRunner = runCommand,
  platform: NodeJS.Platform = process.platform
): Promise<PackageManager> {
  if (platform === "win32") {
    const result = await run("winget", ["--version"], { timeoutMs: 15000 });
    return result.code === 0 ? "winget" : "none";
  }
  if (platform === "darwin") {
    const result = await run("brew", ["--version"], { timeoutMs: 15000 });
    return result.code === 0 ? "brew" : "manual";
  }
  if (platform === "linux") return "manual";
  return "none";
}

/**
 * Homebrew で1つ入れる。
 *
 * wingetと違い同意待ちにならないので、余分な指定は付けない。
 */
export async function installWithBrew(
  formula: string,
  options: { onLine?: (line: string) => void; run?: CommandRunner } = {}
): Promise<InstallOutcome> {
  const run = options.run ?? runCommand;
  const result = await run("brew", ["install", formula], {
    timeoutMs: 20 * 60 * 1000,
    onLine: options.onLine,
  });
  return interpretBrewResult(result);
}

/**
 * brewの結果を読む。
 *
 * **終了コードだけで決めない**（wingetと同じ理由）。すでに入っている場合も
 * 0以外を返すことがあるので、文言と合わせて判定する。
 */
export function interpretBrewResult(result: CommandResult): InstallOutcome {
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0) return { kind: "installed" };
  if (/already installed|up-to-date|最新/i.test(text)) {
    return { kind: "already" };
  }
  if (result.code === -1) {
    return {
      kind: "failed",
      detail: "時間内に終わりませんでした。回線の状態を確認してください。",
    };
  }
  return {
    kind: "failed",
    detail:
      text.trim().split("\n").slice(-3).join(" ") || "原因が分かりません。",
  };
}

export type InstallOutcome =
  | { kind: "installed" }
  /** すでに入っていた。失敗ではない */
  | { kind: "already" }
  /** 作者がユーザーアカウント制御などで取りやめた */
  | { kind: "cancelled" }
  | { kind: "failed"; detail: string };

/**
 * winget で1つ入れる。
 *
 * `--accept-package-agreements` などを付けるのは、**対話待ちで止まらないため**。
 * 子プロセスには入力を送れないので、同意待ちになると永久に終わらない。
 */
export async function installPackage(
  wingetId: string,
  options: { onLine?: (line: string) => void; run?: CommandRunner } = {}
): Promise<InstallOutcome> {
  const run = options.run ?? runCommand;
  const result = await run(
    "winget",
    [
      "install",
      "--id",
      wingetId,
      "--exact",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ],
    { timeoutMs: 20 * 60 * 1000, onLine: options.onLine }
  );

  return interpretWingetResult(result);
}

/**
 * wingetの結果を読む。
 *
 * **終了コードだけで決めない。** wingetは「すでに入っている」も
 * 「作者が取りやめた」も0以外で返し、番号は環境で変わる
 * （実機では 2316632161 が返った）。出力の文言と合わせて判定する。
 */
export function interpretWingetResult(result: CommandResult): InstallOutcome {
  const text = `${result.stdout}\n${result.stderr}`;

  if (result.code === 0) return { kind: "installed" };

  // 既に入っている場合。入れ直す必要は無いので成功として扱う
  if (
    /already installed|インストールされています|No available upgrade|アップグレードは利用できません/i.test(
      text
    )
  ) {
    return { kind: "already" };
  }

  // ユーザーアカウント制御で断った場合。失敗として赤く出すと
  // 作者は「壊れた」と思うが、単に取りやめただけである
  if (
    /cancell?ed|中止|キャンセル|0x800704c7|operation was cancelled/i.test(text)
  ) {
    return { kind: "cancelled" };
  }

  if (result.code === -1) {
    return {
      kind: "failed",
      detail: "時間内に終わりませんでした。回線の状態を確認してください。",
    };
  }

  // 原因は決めつけない。出力の末尾をそのまま見せ、ログにも残す
  const tail = text.trim().split(/\n/).slice(-3).join(" ").slice(0, 300);
  return {
    kind: "failed",
    detail: tail || `winget が ${result.code} を返しました。`,
  };
}

/** Ollamaのモデルを取得する */
export async function pullOllamaModel(
  model: string,
  options: { onLine?: (line: string) => void; run?: CommandRunner } = {}
): Promise<InstallOutcome> {
  const run = options.run ?? runCommand;
  const result = await run("ollama", ["pull", model], {
    // 大きいモデルは回線によって数十分かかる
    timeoutMs: 60 * 60 * 1000,
    onLine: options.onLine,
  });

  if (result.code === 0) return { kind: "installed" };
  if (result.code === -1) {
    return {
      kind: "failed",
      detail: "時間内に終わりませんでした。回線の状態を確認してください。",
    };
  }
  const tail = `${result.stdout}\n${result.stderr}`
    .trim()
    .split(/\n/)
    .slice(-3)
    .join(" ")
    .slice(0, 300);
  return {
    kind: "failed",
    detail: tail || `ollama pull が ${result.code} を返しました。`,
  };
}

/**
 * 端末の制御文字を落とす。
 *
 * `ollama pull` の進み具合には、色やカーソル操作のための文字が混じる
 * （実機で `\u001b[?25l` などを確認）。そのまま進捗表示へ出すと
 * 意味の分からない記号が並ぶ。
 *
 * **正規表現には生の制御文字を書かない。** ファイルがバイナリ扱いになり、
 * 差分も読めなくなる（一度そうしてしまった）。必ずエスケープで書く。
 */
export function stripControl(text: string): string {
  return (
    text
      // ANSIエスケープ（色・カーソル移動・画面制御）。ESC [ … 終端文字
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // ESC ( B のような文字集合の切り替え
      .replace(/\u001b[()][A-Za-z0-9]/g, "")
      // 残ったESCとその他の制御文字（改行・タブは呼び出し前に切ってある）
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f]/g, "")
      // 進み具合の棒に使われる記号（点字・ブロック・幾何学模様）
      .replace(/[─-▟■-◿⠀-⣿]/g, "")
      .trim()
  );
}

/**
 * 取得の進み具合を短くする。
 *
 * `ollama pull` も `winget` も1行が長い。進捗表示は幅が限られるので、
 * 割合だけ拾えれば十分である。
 */
export function shortenProgress(line: string): string {
  const cleaned = stripControl(line);
  const percent = cleaned.match(/(\d{1,3})\s*%/);
  if (percent) return `${percent[1]}%`;
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
}
