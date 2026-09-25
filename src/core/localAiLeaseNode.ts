import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import type { LeaseEnvironment, LeaseFileOps } from "./localAiLease";
import type { RunScopeCarrier } from "./aiSequence";
import { NVIDIA_SMI_ARGS } from "./gpuLoad";

/**
 * 手元のAIの札（`localAiLease.ts`）を、Node で動かす部品。
 *
 * **Node 専用である。** 拡張機能からは `canRunProcesses()` で確かめてから
 * **動的 import** する（CLAUDE.md 規則7——静的に書くと、ブラウザ版は読み込んだ
 * 瞬間に落ちる。`test/unit/cross/browserReach.test.ts` が見張る）。MCP サーバーの
 * 束は Node 専用なので、そちらからは静的に読んでよい。
 *
 * **札は作者のデータではない**（窓の札と同じ扱い）。ただし取るところだけは
 * 「無ければ作る・あれば失敗」を OS に任せる必要があり、VS Code の
 * `workspace.fs` は MCP から使えないので、Node の `fs` を直に使う。
 */

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * 札のファイルの操作。
 *
 * **作るときは「中身を書き終えた一時ファイルを、札の名前へ固いリンクで結ぶ」。**
 * `link` は同じ名前が既にあれば失敗する（OS が1回の操作で決める）ので、
 * 2つのプロセスが同時に作っても片方しか通らない。しかも**中身ごと現れる**ので、
 * 読む側が書きかけを見ない。リンクを張れない場所（FAT など）では
 * `wx`（あれば失敗）で作る——こちらは中身が一瞬空に見えうるが、読む側は
 * 読めない札を少しだけ待つ作りにしてある（`LEASE_UNREADABLE_GRACE_MS`）。
 */
export function nodeLeaseFileOps(filePath: string): LeaseFileOps {
  const directory = nodePath.dirname(filePath);
  return {
    async tryCreate(text) {
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${filePath}.${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.tmp`;
      await fs.writeFile(temporary, text, "utf8");
      try {
        await fs.link(temporary, filePath);
        return true;
      } catch (error) {
        const code = codeOf(error);
        if (code === "EEXIST") return false;
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") {
          throw error;
        }
      } finally {
        await fs.unlink(temporary).catch(() => undefined);
      }
      try {
        await fs.writeFile(filePath, text, { encoding: "utf8", flag: "wx" });
        return true;
      } catch (error) {
        if (codeOf(error) === "EEXIST") return false;
        throw error;
      }
    },
    async read() {
      try {
        const [text, stat] = await Promise.all([
          fs.readFile(filePath, "utf8"),
          fs.stat(filePath),
        ]);
        return { text, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if (codeOf(error) === "ENOENT") return undefined;
        throw error;
      }
    },
    async removeIfSame(text) {
      let current: string;
      try {
        current = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if (codeOf(error) === "ENOENT") return true;
        throw error;
      }
      if (current !== text) return false;
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw error;
      }
      return true;
    },
    async touch() {
      const now = new Date();
      await fs.utimes(filePath, now, now);
    },
  };
}

/**
 * そのプロセスが生きているか。**分からなければ undefined**。
 *
 * `process.kill(pid, 0)` は信号を送らずに「居るか」だけを確かめる
 * （Windows でも使える）。居ないなら ESRCH、居るが触れないなら EPERM。
 */
export function isProcessAlive(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

/** このプロセスの番号 */
export function currentPid(): number {
  return process.pid;
}

/**
 * 札の環境を Node で組む。時計は `unref` する——**札の生存の印のせいで
 * プロセスが終われない**、を作らない（MCP サーバーは標準入力が閉じたら終わる）。
 */
export function nodeLeaseEnvironment(
  filePath: string,
  log?: (message: string) => void
): LeaseEnvironment {
  return {
    ops: nodeLeaseFileOps(filePath),
    now: () => Date.now(),
    isAlive: isProcessAlive,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    startTimer: (tick, ms) => {
      const timer = setInterval(tick, ms);
      timer.unref?.();
      return { stop: () => clearInterval(timer) };
    },
    ...(log ? { log } : {}),
  };
}

/** `nvidia-smi` の結果 */
export type NvidiaSmiResult =
  | { readonly kind: "ok"; readonly stdout: string }
  /** 入っていない（NVIDIA の GPU ではない機械）。**以後は呼ばない** */
  | { readonly kind: "missing" }
  /** 入っているが失敗した・遅すぎた。**次の機会にはまた呼ぶ** */
  | { readonly kind: "failed"; readonly reason: string };

/**
 * `nvidia-smi` を走らせる。**3秒で諦める**（ふつうは0.05秒。遅いときに
 * 作者の送信を待たせない）。
 */
export function runNvidiaSmi(timeoutMs = 3000): Promise<NvidiaSmiResult> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [...NVIDIA_SMI_ARGS],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (!error) {
          resolve({ kind: "ok", stdout });
          return;
        }
        if (codeOf(error) === "ENOENT") {
          resolve({ kind: "missing" });
          return;
        }
        resolve({
          kind: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    );
  });
}

/**
 * 「いま一括処理の中か」を運ぶ仕組み（`aiSequence.ts` の `RunScopeCarrier`）。
 *
 * `AsyncLocalStorage` は `await` やタイマーをまたいで値を運ぶので、一括処理の
 * 本体から呼ばれた送信だけが印を持ち、画面から押された相談は持たない。
 */
export function createRunScopeCarrier(): RunScopeCarrier {
  const storage = new AsyncLocalStorage<string>();
  return {
    run: (label, fn) => storage.run(label, fn),
    current: () => storage.getStore(),
  };
}
