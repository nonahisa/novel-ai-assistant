import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import {
  push,
  readOperationInProgress,
  readSyncStatus,
  type GitCommandRunner,
} from "../core/git";
import {
  DEFAULT_RESEND_INTERVAL_MINUTES,
  FOCUS_MIN_GAP_MS,
  RESEND_HEARTBEAT_MS,
  describeResent,
  looksLikeWake,
  normalizeResendIntervalMinutes,
  pickResendTargets,
  resendDecision,
  type ResendTarget,
} from "../core/autoResendPlan";
import { buildSyncTarget } from "../core/syncTarget";
import { normalizeForComparison } from "../core/paths";
import { logFailure, logStep } from "../core/logger";
import { useSyncLog } from "./syncLog";
import type { GitSyncMonitorLike } from "./gitSyncStub";

/**
 * 記録済みで送れていない分を、回線が戻ったら送り直す（設計書5.5・6.15.1）。
 *
 * 作者の裁定（2026-10-01）：**回線が戻ったら自動で送り直す。送るだけで、
 * 取り込み（pull）や合流はしない。** 経緯と判断の中身は `core/autoResendPlan.ts`。
 *
 * ## いつ試すか
 *
 * - **鼓動（1分ごと）**：見張りの控えを読むだけで、git は呼ばない。
 *   送るものがあり、前に試してから設定の間隔（既定5分）が過ぎていれば試す
 * - **スリープ明け**：鼓動の間が大きく飛んだら、間隔に関わらず
 *   その場とその次の鼓動の2回試す（起きた直後は回線がまだ無いことが多い）
 * - **ウィンドウへ戻ったとき**：30秒に1回まで
 *
 * ## 窓は出さない
 *
 * 失敗しても黙って次の機会を待つ（ログには残す）。**毎回窓を出すと、
 * 回線の無い間じゅう窓が積もる。** 送れたときだけ、消える知らせで短く言う。
 *
 * **ブラウザ版では動かない**（gitの子プロセスが要る）。呼び出し側
 * （`extension.ts`）が `canRunProcesses()` を見てから動的importする。
 */

export interface AutoResendSettings {
  /** 切っていれば何もしない */
  enabled: boolean;
  /** 送るものがあるときに試す間隔（分） */
  intervalMinutes: number;
}

export interface AutoResendDeps {
  registry: Pick<WorkRegistry, "list">;
  /** 控えを読む／送ったあと控えを作り直す */
  monitor: GitSyncMonitorLike;
  run?: GitCommandRunner;
  /**
   * 同期そのもの（すべて同期・取り込む・送る・分岐合流・開いたときの点検）が
   * 走っているか。**走っている間は試さない**——同じ置き場へ git を2本走らせない
   */
  isSyncBusy: () => boolean;
  /** 設定。省くと VS Code の設定を読む */
  settings?: () => AutoResendSettings;
  /** 時計（試験で差し替える） */
  now?: () => number;
  /** 送れたあと（「送らずに閉じた」印を付け直す） */
  afterSent?: () => Promise<void>;
}

/** 1回試した結果。試験と記録のため */
export interface ResendAttempt {
  /** 送れた置き場 */
  sent: Array<{ label: string; ahead: number }>;
  /** 送れなかった置き場と理由 */
  failed: Array<{ label: string; detail: string }>;
  /** 試す直前に見直して、送らなかった置き場と理由 */
  skipped: Array<{ label: string; reason: string }>;
}

/** 試したきっかけ。ログに残して、どの契機で届いたかを後から読めるようにする */
export type ResendTrigger = "interval" | "wake" | "wake-retry" | "focus";

/** スリープ明けに、間隔に関わらず試す回数（起きた直後＋次の鼓動） */
const WAKE_ATTEMPTS = 2;

/**
 * 同期の操作が、走っている送り直しを待つ上限（ミリ秒）。
 *
 * `git push` の時間切れ（`core/git.ts` の `FETCH_TIMEOUT_MS`）と同じ30秒。
 * 回線が詰まって送信が長引いても、作者が押した同期をそれより長くは止めない。
 */
export const WAIT_LIMIT_MS = 30_000;

export class AutoResender implements vscode.Disposable {
  private lastBeatAt: number | undefined;
  /** git を実際に呼んだ最後の時刻。**送るものが無かった回は数えない** */
  private lastAttemptAt: number | undefined;
  private wakeAttemptsLeft = 0;
  /** 走っている試行。無ければ undefined */
  private current: Promise<ResendAttempt> | undefined;
  /**
   * 置き場ごとの、続けて失敗した回数と直前の理由。
   *
   * **同じ理由の失敗は、続けて何行も残さない。** 回線の無い3時間を5分おきに
   * 試すと36行になり、ログを開いた作者が他の記録を探せなくなる。理由が
   * 変わったとき・送れたときに、あらためて1行残す。
   */
  private readonly failures = new Map<string, { count: number; detail: string }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: AutoResendDeps) {}

  /** 鼓動とウィンドウの見張りを始める */
  start(): void {
    this.lastBeatAt = this.now();
    this.timer = setInterval(() => void this.heartbeat(), RESEND_HEARTBEAT_MS);
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.onFocus();
      })
    );
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }

  /** 1分ごとの鼓動。スリープ明けか、間隔が過ぎていれば試す */
  async heartbeat(): Promise<ResendAttempt | undefined> {
    const now = this.now();
    const woke = looksLikeWake(this.lastBeatAt, now);
    this.lastBeatAt = now;
    if (woke) this.wakeAttemptsLeft = WAKE_ATTEMPTS;

    if (this.wakeAttemptsLeft > 0) {
      this.wakeAttemptsLeft -= 1;
      return this.attempt(woke ? "wake" : "wake-retry");
    }
    const intervalMs = this.settings().intervalMinutes * 60_000;
    if (this.lastAttemptAt !== undefined && now - this.lastAttemptAt < intervalMs) {
      return undefined;
    }
    return this.attempt("interval");
  }

  /** ウィンドウへ戻ったとき。行き来のたびに git を起こさないよう間を空ける */
  async onFocus(): Promise<ResendAttempt | undefined> {
    if (
      this.lastAttemptAt !== undefined &&
      this.now() - this.lastAttemptAt < FOCUS_MIN_GAP_MS
    ) {
      return undefined;
    }
    return this.attempt("focus");
  }

  /**
   * 送れていない置き場があれば、送ってみる。
   *
   * **例外を外へ出さない。** 鼓動から呼ばれるので、投げると誰も受け止めない。
   */
  async attempt(trigger: ResendTrigger): Promise<ResendAttempt | undefined> {
    if (this.current) return undefined;
    if (!this.settings().enabled) return undefined;
    if (this.busy()) return undefined;

    const works = this.deps.registry.list();
    const targets = pickResendTargets(
      works.map((work) => ({ work, status: this.deps.monitor.statusFor(work.id) }))
    );
    // 送るものが無ければ git は呼ばない。**ここで時刻を進めない**——
    // 次に送るものができたら、次の鼓動ですぐ試せるようにする
    if (targets.length === 0) return undefined;

    this.lastAttemptAt = this.now();
    // **走っている試行を掴んでおく。** 作者が同期を押したら、同期の側が
    // これを待ってから始める（`whenIdle`）
    const running = this.runTargets(targets, works, trigger);
    this.current = running;
    try {
      return await running;
    } finally {
      this.current = undefined;
    }
  }

  /**
   * 試行が走っていれば、終わるまで待つ（上限 `WAIT_LIMIT_MS`）。
   *
   * **同期の系の操作と、見張りの取り込み／送信の入口で呼ぶ。** 送り直しの
   * 最中に作者が同期を押すと、同じ置き場へ git が2本走る。git 自身の
   * ロックで原稿は壊れないが、片方が「別の git が動いている」で落ちうる。
   *
   * **窓は出さない**——作者は押しただけで、手を止めさせる場面ではない。
   * 待つあいだはステータスバーで言う。**上限を超えたら待つのをやめて進む**
   * （送信が回線待ちで長引いても、作者の操作を止め続けない）。ログに1行残す。
   *
   * @returns 待たなかった／待ち終えた／上限で打ち切った
   */
  async whenIdle(
    limitMs: number = WAIT_LIMIT_MS
  ): Promise<"idle" | "waited" | "timeout"> {
    const running = this.current;
    if (!running) return "idle";

    const notice = vscode.window.setStatusBarMessage(
      "$(sync~spin) 送れていなかった分を送っています…"
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        running.then(
          () => "waited" as const,
          () => "waited" as const
        ),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), limitMs);
        }),
      ]);
      if (result === "timeout") {
        logFailure("自動の送り直しを待ちきれず、同期を先に始めた", {
          待った秒数: Math.round(limitMs / 1000),
        });
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      notice.dispose();
    }
  }

  /** 置き場を順に送り、済んだら知らせる。**例外は外へ出さない** */
  private async runTargets(
    targets: ResendTarget<WorkEntry>[],
    works: readonly WorkEntry[],
    trigger: ResendTrigger
  ): Promise<ResendAttempt> {
    const outcome: ResendAttempt = { sent: [], failed: [], skipped: [] };
    try {
      for (const target of targets) {
        // 置き場の間で作者が同期を押したら、そこで手を引く
        if (this.busy()) break;
        await this.resendOne(target, works, trigger, outcome);
      }
    } catch (error) {
      logFailure("自動の送り直しで例外", {
        詳細: error instanceof Error ? error.message : String(error),
      });
    }

    const message = describeResent(outcome.sent);
    if (message) {
      vscode.window.setStatusBarMessage(message, 8000);
      try {
        await this.deps.afterSent?.();
      } catch (error) {
        logFailure("自動の送り直しのあと、印を付け直せなかった", {
          詳細: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcome;
  }

  /** 置き場1つを、見直してから送る */
  private async resendOne(
    target: ResendTarget<WorkEntry>,
    works: readonly WorkEntry[],
    trigger: ResendTrigger,
    outcome: ResendAttempt
  ): Promise<void> {
    const label = buildSyncTarget(target.root, works).label;

    // **控えは古いことがある**（端末で送った・別の道で取り込んだ）。
    // 送る前に手元の git に聞き直す。ネットワークには出ない
    const fresh = await readSyncStatus(target.root, this.deps.run);
    const decision = resendDecision(fresh);
    if (!decision.send) {
      outcome.skipped.push({ label, reason: decision.reason });
      // 控えを正しておく。直さないと、間隔のたびに同じ見直しを繰り返す
      await this.refreshWorks(this.worksOfRoot(target.root, works));
      return;
    }

    const operation = await readOperationInProgress(target.root, this.deps.run);
    if (operation) {
      outcome.skipped.push({ label, reason: `途中の操作（${operation}）` });
      return;
    }

    // **押し付け（force）はしない。** 別の環境が先に送っていれば、
    // GitHub が拒んでそこで止まる
    const result = await push(target.root, this.deps.run);
    // 書庫なら書庫のログへ（設計書5.7.9。先頭の作品のログへ紛れさせない）
    await useSyncLog(target.root, target.works);
    const key = target.root;

    if (!result.ok) {
      const detail = result.detail ?? "（詳細なし）";
      outcome.failed.push({ label, detail });
      const previous = this.failures.get(key);
      const count = (previous?.count ?? 0) + 1;
      this.failures.set(key, { count, detail });
      if (!previous || previous.detail !== detail) {
        logFailure("自動の送り直しに失敗（次の機会にまた試します）", {
          置き場: label,
          きっかけ: trigger,
          詳細: detail,
        });
      }
      return;
    }

    const failedBefore = this.failures.get(key)?.count ?? 0;
    this.failures.delete(key);
    outcome.sent.push({ label, ahead: decision.ahead });
    logStep(
      `自動の送り直し：送った（${label}／${decision.ahead}件／きっかけ ${trigger}` +
        (failedBefore > 0 ? `／それまでに ${failedBefore}回失敗` : "") +
        "）"
    );
    // 一覧とステータスバーを作り直す。見張りの変化の合図で、
    // 「送らずに閉じた」印も付け直される（`extension.ts`）
    await this.refreshWorks(this.worksOfRoot(target.root, works));
  }

  /**
   * 同じ置き場の作品すべて。**送った作品だけでなく全部を作り直す**——
   * ステータスバーは置き場ごとに最初の作品の控えを見る（`uniqueByRoot`）ので、
   * 一部だけ作り直すと古い件数が残る
   */
  private worksOfRoot(root: string, works: readonly WorkEntry[]): WorkEntry[] {
    const key = normalizeForComparison(root);
    return works.filter((work) => {
      const status = this.deps.monitor.statusFor(work.id);
      return (
        status !== undefined &&
        "root" in status &&
        normalizeForComparison(status.root) === key
      );
    });
  }

  private async refreshWorks(works: readonly WorkEntry[]): Promise<void> {
    for (const work of works) {
      await this.deps.monitor.refresh(work, { fetch: false, notify: false });
    }
  }

  private busy(): boolean {
    return this.deps.isSyncBusy() || (this.deps.monitor.isOperating?.() ?? false);
  }

  private settings(): AutoResendSettings {
    return this.deps.settings?.() ?? readAutoResendSettings();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** VS Code の設定から読む。誤った間隔は既定へ丸める */
export function readAutoResendSettings(): AutoResendSettings {
  const config = vscode.workspace.getConfiguration("novelai");
  return {
    enabled: config.get<boolean>("git.autoResend", true),
    intervalMinutes: normalizeResendIntervalMinutes(
      config.get<number>(
        "git.autoResendIntervalMinutes",
        DEFAULT_RESEND_INTERVAL_MINUTES
      )
    ),
  };
}
