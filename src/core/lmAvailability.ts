/**
 * VS Code の言語モデルの口（`vscode.lm`）が、いま動いているエディターで使えるか
 * （設計書5.9）。
 *
 * **エディターの名前では分けない。** Cursor・VSCodium・Windsurf など、Open VSX
 * から入れる別のエディターでは口が無いか働かないことがあるが、名前で決め打ちすると
 * 新しいエディター・版の変化に追いつけない（CLAUDE.md 規則5の「サービス名を
 * 決め打ちしない」と同じ考え）。口そのものを確かめる。
 *
 * **起動の道で待たない**（作者の前提、2026-10-31。0.115.2 で起動時の点検を
 * 4.2秒→2.0秒にしたばかり）。起動では globalState を同期で読むだけにし、
 * 確かめは作品一覧の初回描画のあとに裏で行う。
 *
 * **一度隠したら戻さない**（作者の指示、2026-10-31「一回消したものは、戻さない
 * ようにお願いします」）。同じ版のあいだは確かめ直さない。
 * **版が上がったときだけ確かめ直す**（作者の指示、2026-10-31「拡張機能の版が
 * 上がったときにだけ確かめ直しましょう」）。確かめ直すまでは前の結果のまま出し、
 * 「使える」と出たらそこで初めて戻す。
 *
 * VS Code API に依存しない（口に触る確かめと `setContext` は呼び出し側が渡す）。
 */

/** globalState の鍵 */
export const LM_AVAILABILITY_KEY = "novelai.lmAvailability";

/** `when` 句で使う印（`setContext`）。真なら出す */
export const LM_AVAILABLE_CONTEXT = "novelai.lmAvailable";

/**
 * 確かめの時間の上限。**過ぎたら判断しない**（今の表示のまま・書き残さない）。
 * 誤って隠すより、出しておくほうを選ぶ（指示 2026-10-31）。
 */
export const LM_PROBE_TIMEOUT_MS = 3000;

/**
 * `vscode.lm` が無いと動かない命令（package.json の `when` に
 * `novelai.lmAvailable` を足す相手）。
 *
 * **いまは0件。** 口を使うのは AI の接続先「VS Code に繋いであるAI」
 * （`ai/vscodeLmProvider.ts`）だけで、隠すのは AI の選択肢の1行である
 * （`AIRegistry.setProviderHidden`）。口を使う命令を足したらここへ載せる
 * ——`browserHiddenMenus.test.ts` が `vscode.lm` に触るファイルの顔ぶれを
 * 見張っていて、増えたら気づける。
 */
export const LM_REQUIRED_COMMANDS: readonly string[] = [];

/** 残す判断。版は判断したときの拡張機能の版（package.json の version） */
export interface LmAvailabilityRecord {
  available: boolean;
  version: string;
}

/** 確かめの答え。決められなかったときは `undefined` を返す */
export type LmProbeResult = "available" | "unavailable";

/** globalState の値を読む。形が違えば「残っていない」扱い（作者が書く値ではない） */
export function parseLmAvailabilityRecord(
  raw: unknown
): LmAvailabilityRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.available !== "boolean") return undefined;
  if (typeof value.version !== "string") return undefined;
  return { available: value.available, version: value.version };
}

/**
 * 起動のときの表示と、確かめ直すかどうか。
 *
 * - 残っていない → 出しておき、確かめる
 * - 同じ版 → 残っている結果のまま。確かめない
 * - 違う版 → 残っている結果のまま出し（隠していたなら隠したまま）、確かめ直す
 */
export function planLmAvailability(
  record: LmAvailabilityRecord | undefined,
  currentVersion: string
): { show: boolean; recheck: boolean } {
  if (!record) return { show: true, recheck: true };
  return {
    show: record.available,
    recheck: record.version !== currentVersion,
  };
}

export interface LmAvailabilityDeps {
  /** 拡張機能の今の版 */
  version: string;
  /** globalState から同期で読む */
  read(): unknown;
  /** globalState へ書く（待たない） */
  write(record: LmAvailabilityRecord): void;
  /** 表示の印を立てる・落とす（`setContext`。待たない） */
  publish(show: boolean): void;
  /** 口を確かめる。決められなければ undefined */
  probe(): Promise<LmProbeResult | undefined>;
  /** 時間の上限（試験で縮める） */
  timeoutMs?: number;
}

/**
 * 表示の印を持つ門番。1つのセッションに1つ。
 *
 * `start()` は同期で終わる（起動の道に置いてよい）。`recheckInBackground()` は
 * 起動が終わってから `void` で起こす。
 */
export class LmAvailabilityGate {
  private shown = true;
  /** このセッションで「使えない」と判断して隠したか。立ったら戻さない */
  private hiddenThisSession = false;
  /** 確かめは1セッションに1回まで */
  private checked = false;
  private needsRecheck = false;
  private readonly listeners = new Set<(show: boolean) => void>();

  constructor(private readonly deps: LmAvailabilityDeps) {}

  /** 起動の最初に呼ぶ。globalState を読んで印を立てるだけ（待たない） */
  start(): void {
    const plan = planLmAvailability(
      parseLmAvailabilityRecord(this.deps.read()),
      this.deps.version
    );
    this.needsRecheck = plan.recheck;
    this.setShown(plan.show, true);
  }

  /** 選択肢に出してよいか */
  get visible(): boolean {
    return this.shown;
  }

  /** 表示が変わったら知らせる（選択肢の一覧を持つ側が使う） */
  onDidChange(listener: (show: boolean) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * 起動が終わってから裏で確かめる。同じ版なら何もしない。
   *
   * 戻り値は試験のため（呼び出し側は待たない）。
   */
  async recheckInBackground(): Promise<void> {
    if (!this.needsRecheck || this.checked) return;
    this.checked = true;
    const result = await this.probeWithin();
    if (result === undefined) return; // 決められない・時間切れ：今のまま、書き残さない
    if (result === "unavailable") {
      this.hiddenThisSession = true;
      this.deps.write({ available: false, version: this.deps.version });
      this.setShown(false);
      return;
    }
    // 「使える」でも、このセッションで隠したものは戻さない（作者の指示 2026-10-31）
    if (this.hiddenThisSession) return;
    this.deps.write({ available: true, version: this.deps.version });
    this.setShown(true);
  }

  private async probeWithin(): Promise<LmProbeResult | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(
        () => resolve(undefined),
        this.deps.timeoutMs ?? LM_PROBE_TIMEOUT_MS
      );
    });
    try {
      // 確かめ自体が投げたら「決められない」。ここで隠すと、口と関係の無い
      // 失敗で選択肢を失う
      const probed = this.deps.probe().catch(() => undefined);
      return await Promise.race([probed, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private setShown(show: boolean, force = false): void {
    if (this.hiddenThisSession && show) return;
    if (!force && this.shown === show) return;
    this.shown = show;
    this.deps.publish(show);
    for (const listener of this.listeners) listener(show);
  }
}
