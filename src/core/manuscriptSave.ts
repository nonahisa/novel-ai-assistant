/**
 * 原稿エディターの［保存］（作者の裁定、2026-10-01。設計書6.25.9）。
 *
 * 拡張機能ホストが起動し直すと、画面（WebView）は生きたまま受け手を失い、
 * 打った字が文書へ届かないまま残る（2026-10-01 ノートPCで約100字）。
 * 画面には自分でファイルを書く力が無いので「無理やり書く」はできないが、
 * **保存できたかを確実に知らせる**ことはできる。
 *
 * 画面は［保存］を押されると、いまの本文を `edit`（便の番号つき）で送り、
 * 続けて同じ番号で `saveRequest` を送る。こちらは**その番号までの便を
 * 当て終わってから**保存し、成否と字数を `saveResult` で返す。
 *
 * ## なぜ番号まで待つのか
 *
 * 便は順番待ち（`editQueue.ts`）で1つずつ当てる。保存の頼みは便より後に
 * 届くが、届いた時点で前の便はまだ当てている途中のことがある。そこで先に
 * 保存すると、**最後に打った字が入る前のファイル**を「保存しました」と言う。
 *
 * VS Code に依存させない（ここは順序と判定だけ。保存そのものは呼び出し側が渡す）。
 */

/** 画面へ返す保存の結果 */
export interface SaveResult {
  type: "saveResult";
  /** 画面が頼んだ便の番号（押した回ごとに違う） */
  seq: number;
  ok: boolean;
  /** 保存後の字数（下の欄の「このファイル」と同じ数え方）。ok のときだけ */
  chars?: number;
  /** 保存できなかった理由（画面にそのまま出す）。ok:false のときだけ */
  reason?: string;
}

/**
 * 便を当て終わるまで待つ長さ。ふだんの往復は0.1秒に満たない。
 *
 * 画面は受付（`saveAccepted`）を3秒、そのあと結果を30秒待つ。受付は頼みを
 * 受け取ったその場で返すので、この待ちは結果の30秒の内側に収まればよい。
 */
export const SAVE_APPLY_WAIT_MS = 2000;

/** 便を待った結果 */
export type AppliedWait = "applied" | "rejected" | "timeout";

/**
 * 「どの便まで当て終わったか」を覚えて、待たせる。
 *
 * 当てている間に届いた便は畳まれる（途中の番号は返事が来ないまま飛ぶ）ので、
 * **待っている番号以上の便が当たれば解く。**
 */
export interface AppliedTracker {
  /** 便を当て終えた（`editApplied` を返すのと同じとき） */
  markApplied(seq: number, ok: boolean): void;
  /** その番号以上の便が当たるまで待つ */
  waitFor(seq: number, timeoutMs: number): Promise<AppliedWait>;
}

export function createAppliedTracker(): AppliedTracker {
  let lastSeq = 0;
  let lastOk = true;
  const waiters: Array<{ seq: number; done: (result: AppliedWait) => void }> = [];

  return {
    markApplied(seq, ok) {
      if (seq > lastSeq) {
        lastSeq = seq;
        lastOk = ok;
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (seq >= waiter.seq) {
          waiters.splice(i, 1);
          waiter.done(ok ? "applied" : "rejected");
        }
      }
    },
    waitFor(seq, timeoutMs) {
      if (lastSeq >= seq) return Promise.resolve(lastOk ? "applied" : "rejected");
      return new Promise<AppliedWait>((resolve) => {
        let settled = false;
        const waiter = {
          seq,
          done: (result: AppliedWait) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          waiter.done("timeout");
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

/** 保存の手順で、呼び出し側（VS Code の文書）に頼むこと */
export interface SaveSteps {
  /** 頼まれた番号までの便が当たるのを待つ */
  waitApplied(seq: number): Promise<AppliedWait>;
  /** 文書が未保存か */
  isDirty(): boolean;
  /** 保存する（`TextDocument.save()`） */
  save(): Promise<boolean>;
  /** いまの文書の字数 */
  chars(): number;
  /**
   * 差のある便を「入った」と数えたあと、まだ一度も保存されていないか。
   * 未保存でない文書にだけ訊く。
   *
   * 読み取り専用の原稿（設定 `files.readonlyInclude`）では、便を当てると
   * `applyEdit` は true を返し、文書の本文も変わるのに、**未保存にならず、
   * 保存もされない**（2026-10-15、画面の自動テストで確かめた。閉じると本文は
   * ファイルの中身へ戻る）。未保存でないから保存済み、と読むと、**打った字の
   * 入っていないファイルを「保存しました」と言う。**
   */
  appliedButNeverSaved?(): boolean;
}

/** 便を当てたあと、文書が未保存になるのを待つ長さ（ふつうは当てた時点でなっている） */
export const EDIT_TAKEN_WAIT_MS = 300;

/**
 * 差のある便を当てたあと、文書が未保存になったか（設計書6.25.9）。
 *
 * 読み取り専用の原稿では `applyEdit` が true を返し本文も変わるのに、未保存に
 * ならない——**保存されないので、閉じると字が消える。** 差のある便を当てた
 * あとにだけ訊く（差の無い便では文書は変わらないので、未保存にならなくて正しい。
 * 未変更の文書を取り違えないよう、呼び出し側が差の有無で分ける）。
 *
 * ふつうの原稿は当てた時点で未保存になっているので、待たずに true を返す。
 * なっていないときだけ少し待って見直す——印の届き方が遅れた場合に、入った
 * 字を「入らなかった」と言わないため。
 */
export async function editTakenByDocument(
  isDirty: () => boolean,
  waitMs: number = EDIT_TAKEN_WAIT_MS,
  stepMs = 25
): Promise<boolean> {
  if (isDirty()) return true;
  for (let waited = 0; waited < waitMs; waited += stepMs) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    if (isDirty()) return true;
  }
  return false;
}

/**
 * 番号までの便を待ってから保存し、結果を返す。**投げない**（失敗も結果で返す）。
 *
 * - 便が「入れられなかった」・待ちが切れた → 保存しない。保存できても、
 *   打った字が入っていないファイルを「保存しました」と言うことになる
 * - 未保存でない文書は保存し直さない。VS Code は未変更の文書の保存に
 *   false を返すので、それを失敗と取り違えない
 * - ただし未保存でないのに、入ったと数えた字が一度も保存されていなければ
 *   失敗で返す（`appliedButNeverSaved`。読み取り専用の原稿。2026-10-15）
 */
export async function runSaveRequest(seq: number, steps: SaveSteps): Promise<SaveResult> {
  const fail = (reason: string): SaveResult => ({ type: "saveResult", seq, ok: false, reason });
  const waited = await steps.waitApplied(seq);
  if (waited === "rejected") {
    return fail("打った字を原稿へ入れられませんでした（保存はしていません）");
  }
  if (waited === "timeout") {
    return fail("打った字を原稿へ入れ終わる前に時間切れになりました（保存はしていません）");
  }
  if (steps.isDirty()) {
    let saved = false;
    try {
      saved = await steps.save();
    } catch (error) {
      return fail(
        "保存の途中で失敗しました：" + (error instanceof Error ? error.message : String(error))
      );
    }
    if (!saved || steps.isDirty()) {
      return fail("VS Code が保存できなかったと返しました");
    }
  } else if (steps.appliedButNeverSaved?.()) {
    // 未保存でないのに、入ったはずの字が保存されていない（読み取り専用の原稿）
    return fail(
      "打った字が保存されていません（原稿が読み取り専用などで、VS Code が保存しない状態です）。" +
        "［本文をコピー］で控えてください"
    );
  }
  return { type: "saveResult", seq, ok: true, chars: steps.chars() };
}

/** 操作ログの1行 */
export function describeSaveResult(result: SaveResult): string {
  return result.ok
    ? `［保存］で保存しました（便${result.seq}まで入れてから。${result.chars ?? 0}字）`
    : `［保存］で保存できませんでした（便${result.seq}）：${result.reason ?? "理由不明"}`;
}
