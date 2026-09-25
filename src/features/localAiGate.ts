// ログの書き先：作品が定まらない——札は機械に1枚で、どの作品の話でもないので
// いま向いているログ（無ければ保管庫）へ書く（窓の札と同じ扱い）
import * as vscode from "vscode";
import * as path from "../core/paths";
import {
  AiQueueAbortError,
  currentRunLabel,
  currentRunScope,
  runScopeAvailable,
  setRunScopeCarrier,
} from "../core/aiSequence";
import { setLocalAiGate, type LocalAiGate, type LocalAiGateRequest } from "../core/localAiGate";
import {
  LOCAL_AI_INTERRUPT_FILE,
  LOCAL_AI_LAST_SEND_FILE,
  LOCAL_AI_LEASE_DIRECTORY,
  LOCAL_AI_LEASE_FILE,
  LOCAL_AI_RUN_LEASE_FILE,
  holderPhrase,
  leaseWaitingMessage,
  type LeaseRecord,
} from "../core/localAiLease";
import { CrossProcessTurn } from "../core/localAiCrossTurn";
import {
  LOAD_WAIT_RECHECK_MS,
  LoadCheckSchedule,
  externalLoadMessage,
  probeExternalLoad,
  readOllamaPsWith,
  type ExternalLoadJudgement,
} from "../core/gpuLoad";
import { canRunProcesses, randomUuid } from "../core/runtime";
import { logLine } from "../core/logger";
import { localFetch } from "../ai/fetchTimeouts";
import { globalStorageRoot } from "./globalStoragePath";
import {
  isLocalLmStudioEndpoint,
  isLocalOllamaEndpoint,
  ollamaEndpoint,
} from "./aiConnectivity";
import { withCancellableProgress } from "../views/progress";
import { currentRunControl, type RunControl } from "./localAiRunControl";

/**
 * 手元のAI（Ollama・LM Studio）の重複起動を見張る（設計書6.76.1・6.76.2）。
 * 作者の依頼（2026-09-25）「重複起動が疑われるときは、負荷の原因が管理下に
 * あるときはキューを管理し、管理下にない場合は警告を出す」。
 *
 * 1. **管理下（別の窓・開発ホスト・MCP サーバー）**：保管庫の札
 *    （`core/localAiCrossTurn.ts`。一括処理のまとまりと1回の送信の2段）で
 *    順番を取る。**一括処理どうしは窓をまたいで待ち、相談などの単発は別の窓の
 *    一括処理のチャンクの合間に入る**（同じ窓の中と同じ扱い。6.76 の決めごと13）。
 *    待っているあいだは「別の窓の「〜」の完了を待っています…」と出し、中止できる
 * 2. **管理外（ほかのアプリ）**：札を新しく取ったとき（と、持ち続けているあいだは
 *    5分ごと）に GPU の負荷を見て、高ければ［待つ］［このまま送る］［やめる］を問う
 *
 * **ブラウザ版では動かさない**（手元のAIを使わない。`canRunProcesses()`）。
 * Node の部品（`core/localAiLeaseNode.ts`）は**動的 import**で持ってくる
 * （CLAUDE.md 規則7）。
 *
 * **失敗しても本来の処理を止めない。** 札が扱えない・nvidia-smi が無い・遅い
 * ときは、今までどおり送る（ログには残す）。
 */

/** 進捗の報告先。`views/progress` が渡してくる形と同じ */
type ProgressReporter = vscode.Progress<{ message?: string; increment?: number }>;

/** 札を持たずに来た単発の呼び出しの名乗り（相談・紹介文など） */
const SINGLE_CALL_LABEL = "AIへの単発の問い合わせ";

/**
 * 待っているあいだの表示。一括処理の中なら**その進捗**へ、そうでなければ
 * 中止ボタン付きの進捗を自前で出す。
 */
interface WaitDisplay {
  readonly report: (message: string) => void;
  readonly close: () => void;
}

function openWaitDisplay(
  title: string,
  abort: () => void,
  control: RunControl | undefined,
  hasSignal: boolean
): WaitDisplay {
  // **一括処理の中止ボタンが待ちへ届くときだけ**、その進捗へ出す。届かない
  // （合図を渡してこない呼び出し）なら自前で出す——止められない待ちを作らない
  if (control && hasSignal) {
    return { report: control.report, close: () => undefined };
  }
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let reporter: ProgressReporter | undefined;
  let pending: string | undefined;
  void withCancellableProgress(title, async (progress, token) => {
    reporter = progress;
    if (pending) progress.report({ message: pending });
    token.onCancellationRequested(abort);
    await done;
  });
  return {
    report: (message) => {
      if (reporter) reporter.report({ message });
      else pending = message;
    },
    close: () => finish(),
  };
}

/** 中止の合図を2つ束ねる（呼び出し元の合図と、こちらの表示の中止ボタン） */
function combinedAbort(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AiQueueAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AiQueueAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type NodeParts = typeof import("../core/localAiLeaseNode.js");

/**
 * この送信は一括処理の1チャンクか、単発か。
 *
 * 一括処理の本体は `features/aiTurn.ts` が印（`withinRunScope`）を持たせて
 * 走らせるので、印があれば一括処理である。**印の仕組みが入っていない**
 * （Node の部品を読み込む前の一瞬）ときは、0.86.13 までと同じく
 * 「このプロセスで一括処理が札を持っているか」で見分ける（相談も一括処理に
 * 見えて、別の窓の一括処理を待つ——今までと同じで、悪くはならない）。
 */
function runOfThisCall(): string | undefined {
  if (runScopeAvailable()) return currentRunScope();
  return currentRunLabel();
}

class ExtensionLocalAiGate implements LocalAiGate {
  private leaseLoading: Promise<CrossProcessTurn | undefined> | undefined;
  private node: NodeParts | undefined;
  private readonly schedule = new LoadCheckSchedule();
  /** nvidia-smi が入っていない機械。**以後は呼ばない** */
  private nvidiaSmiMissing = false;
  /** 同じ理由のログを繰り返さない（札が壊れているとチャンクごとに出てしまう） */
  private readonly loggedReasons = new Set<string>();

  constructor(
    private readonly storageRoot: string,
    private readonly windowName: string | undefined
  ) {}

  private logOnce(message: string): void {
    if (this.loggedReasons.has(message)) return;
    this.loggedReasons.add(message);
    logLine(message);
  }

  lease(): Promise<CrossProcessTurn | undefined> {
    this.leaseLoading ??= (async () => {
      try {
        const node = await import("../core/localAiLeaseNode.js");
        this.node = node;
        // 一括処理の本体に印を持たせる仕組み（`aiTurn.ts` が使う）
        setRunScopeCarrier(node.createRunScopeCarrier());
        const directory = path.join(this.storageRoot, LOCAL_AI_LEASE_DIRECTORY);
        const log = (message: string): void => logLine(message);
        return new CrossProcessTurn(
          {
            send: node.nodeLeaseEnvironment(path.join(directory, LOCAL_AI_LEASE_FILE), log),
            run: node.nodeLeaseEnvironment(path.join(directory, LOCAL_AI_RUN_LEASE_FILE), log),
            interrupt: node.nodeLeaseEnvironment(
              path.join(directory, LOCAL_AI_INTERRUPT_FILE),
              log
            ),
            lastSend: node.nodeLeaseFileOps(path.join(directory, LOCAL_AI_LAST_SEND_FILE)),
          },
          {
            pid: node.currentPid(),
            host: "extension",
            token: randomUuid(),
            ...(this.windowName ? { windowName: this.windowName } : {}),
          },
          {
            // **一括処理の札（6.76）を持っている間は、まとまりの札を離さない**
            // （別の窓の一括処理と交互に流さない）。送信の札は合間ごとに離す
            keepRunWhile: () => currentRunLabel() !== undefined,
            onIdle: () => this.schedule.leaseDropped(),
          }
        );
      } catch (error) {
        logLine(
          "手元のAIの順番待ち（ほかの窓との札）を用意できませんでした。今までどおり送ります：" +
            (error instanceof Error ? error.message : String(error))
        );
        return undefined;
      }
    })();
    return this.leaseLoading;
  }

  async enter(request: LocalAiGateRequest): Promise<() => void> {
    const lease = await this.lease();
    if (!lease) return () => undefined;

    const run = runOfThisCall();
    const kind = run !== undefined ? "run" : "single";
    const label = run ?? SINGLE_CALL_LABEL;
    // **単発は一括処理の進捗へ出さない。** 一括処理の最中に押した相談の待ちを
    // 一括処理の進捗へ出すと、GPU の警告の［やめる］で一括処理まで止めてしまう
    const control = kind === "run" ? currentRunControl() : undefined;
    const abort = combinedAbort(request.signal);
    let display: WaitDisplay | undefined;
    const onWait = (holder: LeaseRecord): void => {
      const message = leaseWaitingMessage(holder);
      display ??= openWaitDisplay(
        message.replace(/…$/, ""),
        () => abort.abort(),
        control,
        request.signal !== undefined
      );
      display.report(message);
      logLine(
        `${message}（こちらは「${label}」、${request.providerId} の ${request.model}。` +
          `相手はプロセス ${holder.pid}、${holder.startedAt} から）`
      );
    };

    let entry;
    try {
      entry = await lease.enter(label, { kind, signal: abort.signal, onWait });
    } finally {
      display?.close();
    }

    if (entry.kind === "unavailable") {
      this.logOnce(
        `手元のAIの順番待ち（ほかの窓との札）を使えないので、そのまま送ります：${entry.reason}`
      );
      return entry.release;
    }
    if (entry.waitedFor) {
      logLine(
        `${holderPhrase(entry.waitedFor)}の完了を${Math.round(entry.waitedMs / 1000)}秒待って、` +
          `「${label}」を送ります。`
      );
      // 一括処理の進捗には待ち文言が残っているので、進み始めたことを出す
      if (control && request.signal) control.report("順番が来ました。続けます…");
    }

    try {
      await this.checkExternalLoad(request, entry.fresh, abort, control);
    } catch (error) {
      entry.release();
      throw error;
    }
    return entry.release;
  }

  runEnded(): void {
    void this.leaseLoading?.then((lease) => lease?.runEnded());
  }

  async dispose(): Promise<void> {
    const lease = await this.leaseLoading;
    await lease?.dispose();
  }

  private async sendsToThisMachine(providerId: string): Promise<boolean> {
    try {
      if (providerId === "ollama") return await isLocalOllamaEndpoint();
      if (providerId === "lmstudio") return await isLocalLmStudioEndpoint();
    } catch {
      // 分からなければ見ない（空振りの警告を出さない側へ倒す）
    }
    return false;
  }

  /** 負荷を測る。**失敗したら undefined**（今までどおり送る） */
  private async probe(
    providerId: string
  ): Promise<ExternalLoadJudgement | undefined> {
    const node = this.node;
    if (!node) return undefined;
    const lease = await this.leaseLoading;
    try {
      const result = await probeExternalLoad(providerId, {
        // **直前に管理下の誰かが送り終えたばかりなら、使用率の名残で騒がない**
        // （別の窓・MCP・この窓。台帳が読めなければ今までどおり）
        ...(lease ? { lastManagedSendEndedMs: () => lease.lastSendEndedMs() } : {}),
        runNvidiaSmi: async () => {
          if (this.nvidiaSmiMissing) return undefined;
          const smi = await node.runNvidiaSmi();
          if (smi.kind === "ok") return smi.stdout;
          if (smi.kind === "missing") this.nvidiaSmiMissing = true;
          else this.logOnce(`nvidia-smi を読めませんでした：${smi.reason}`);
          return undefined;
        },
        // Ollama の読み込みは、Ollama へ送るときも LM Studio へ送るときも見る
        // （どちらのときも「ほかのアプリ」の側に数えるか決めるのに要る）
        readOllamaPs: () =>
          readOllamaPsWith((signal) =>
            localFetch(`${ollamaEndpoint().replace(/\/+$/, "")}/api/ps`, { signal }, 2000)
          ),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      return result;
    } catch (error) {
      this.logOnce(
        `GPU の負荷を確かめられませんでした：${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  /**
   * 管理外の負荷を見て、高ければ作者に問う（設計書6.76.2）。
   *
   * **札を持ってから見る。** 札が取れた＝管理下の誰も送っていない、なので、
   * そのとき GPU が忙しいなら原因は管理の外にある。ただし**管理下の誰かが
   * 送り終えた直後は、使用率に生成の名残が出る**ので、その数秒は使用率の線を
   * 見ない（台帳 `last-send.json` の時刻で見分ける。`MANAGED_SEND_SETTLE_MS`）。
   */
  private async checkExternalLoad(
    request: LocalAiGateRequest,
    fresh: boolean,
    abort: AbortController,
    control: RunControl | undefined
  ): Promise<void> {
    const now = Date.now();
    if (!this.schedule.due(now, fresh)) return;
    this.schedule.checked(now);

    // **宛先がこの機械でなければ、この機械の GPU を見ても意味が無い**
    // （別の機械の Ollama を使っている作者もいる）
    if (!(await this.sendsToThisMachine(request.providerId))) return;

    const judgement = await this.probe(request.providerId);
    if (!judgement) return;
    logLine(`手元のAIへ送る前の負荷：${judgement.summary}`);
    if (!judgement.external) return;

    const choice = await vscode.window.showWarningMessage(
      "手元のAIへ送る前に確かめてください。",
      {
        modal: true,
        detail:
          `${externalLoadMessage(judgement)}\n\n` +
          "このまま送ると、遅くなったり、メモリが足りずにモデルが載らなかったりします。",
      },
      "待つ",
      "このまま送る",
      "やめる"
    );
    logLine(`GPU の負荷の警告：「${choice ?? "閉じた"}」が選ばれました。`);

    if (choice === "このまま送る") {
      this.schedule.snooze(Date.now());
      return;
    }
    if (choice === "待つ") {
      await this.waitForLoadToDrop(request, abort, control);
      return;
    }
    // ［やめる］と、閉じた（Esc）とき。**一括処理なら、その処理の中止ボタンと
    // 同じ道で止める**——機能側は token の中止だけを「作者が止めた」と読む
    control?.cancel();
    throw new AiQueueAbortError("GPU の負荷が高いため、送るのをやめました。");
  }

  private async waitForLoadToDrop(
    request: LocalAiGateRequest,
    abort: AbortController,
    control: RunControl | undefined
  ): Promise<void> {
    const display = openWaitDisplay(
      "GPU の負荷が下がるのを待っています",
      () => abort.abort(),
      control,
      request.signal !== undefined
    );
    const started = Date.now();
    try {
      for (;;) {
        display.report("ほかのアプリの GPU の負荷が下がるのを待っています…");
        await sleepAbortable(LOAD_WAIT_RECHECK_MS, abort.signal);
        const judgement = await this.probe(request.providerId);
        // 測れなくなったら待つ理由も無い（今までどおり送る）
        if (!judgement || !judgement.external) {
          logLine(
            `GPU の負荷が下がったので送ります（${Math.round((Date.now() - started) / 1000)}秒待ちました）` +
              (judgement ? `：${judgement.summary}` : "")
          );
          return;
        }
      }
    } finally {
      display.close();
    }
  }
}

/**
 * 起動時に一度だけ呼ぶ。戻り値を `context.subscriptions` へ入れる
 * （閉じるときに札を消す。消せなくても、プロセスが居なくなれば相手が奪える）。
 */
export function startLocalAiGate(
  context: vscode.ExtensionContext
): vscode.Disposable | undefined {
  if (!canRunProcesses()) return undefined;
  const gate = new ExtensionLocalAiGate(
    globalStorageRoot(context),
    vscode.workspace.name ?? undefined
  );
  setLocalAiGate(gate);
  // **先に読み込んでおく。** 一括処理か単発かを見分ける印の仕組みは Node の部品に
  // あり、最初の送信まで待つと、起動直後に始めた一括処理が印を持たずに走る
  void gate.lease();
  return {
    dispose: () => {
      setLocalAiGate(undefined);
      setRunScopeCarrier(undefined);
      void gate.dispose().catch(() => undefined);
    },
  };
}
