import { formatCount } from "./charCount";

/**
 * 長い処理の「終わった」と「何が残ったか」を、記録に1行ずつ残す
 * （作者の裁定、2026-09-19）。
 *
 * ## なぜ要るか
 *
 * 2026-09-19 の実機確認で、AIチューニングが終わって反映待ちで止まって
 * いたのに、誰も気づかないまま10分以上が過ぎた。**終わったことは知らせ
 * （通知）にしか出ず、消えたら何も残らなかった**ためである。12分かけて
 * 測ったのに、測った値も「反映しなかったこと」もどこにも残らなかった。
 *
 * 同じことが「ひと通り仕上げる」でも起きる。12段が終わって結果の紙は
 * 出るが、**途中の段が何をして何をしなかったか**は通知に散っている。
 *
 * ## ここが引き受けるのは「文面を組むこと」だけ
 *
 * 記録の仕組みは `core/logger.ts`（`logStep` / `logFailure` /
 * `useLogFile`）のものをそのまま使う。**新しいログの仕組みは作らない。**
 * ここは `vscode` に触らない純粋な関数だけを置くので、期待する1行が
 * 出るかを単体テストで直に確かめられる。
 *
 * ## 「できました」だけの行は書かない
 *
 * 今回の困りごとは「終わったことが分からなかった」ことと、
 * **「反映しなかった理由が分からなかった」こと**の2つである。後者を
 * 落とすと同じことがまた起きるので、飛ばした・失敗した・反映しなかった
 * ときは、**必ず理由か、理由の手がかりになる事実を添える。**
 */

/** 記録に出す、走らせ終わった1段（校正のまとめ実行・ひと通り仕上げる共通） */
export interface RunStepLog {
  readonly label: string;
  /** 分類を持つ段だけ。そのあと提案パネルに残っていた件数 */
  readonly count?: number;
  /** 走ろうとして失敗した */
  readonly failed?: boolean;
  /** 走らせなかった（既にある・前提が足りない） */
  readonly skipped?: boolean;
  /** 飛ばした短い理由 */
  readonly reason?: string;
  /** 走れなかった理由などの持ち越し */
  readonly notes?: readonly string[];
}

/**
 * まとめ実行を始めた1行。
 *
 * **始まりも残す。** 終わりの行だけだと、途中で VS Code ごと落ちたときに
 * 「走らせたのかどうか」すら残らない。
 */
export function describeRunStart(input: {
  runLabel: string;
  workTitle: string;
  total: number;
}): string {
  return `${input.runLabel} 開始 ${input.workTitle} ${input.total}段`;
}

/**
 * 段ごとの1行。
 *
 * 形は「処理名 3/12 段の名前 → 結果（理由）」で揃える。左から読んで
 * どこまで進んだかが分かり、`→` の右だけを拾えば結果だけを追える。
 */
export function describeRunStep(input: {
  runLabel: string;
  /** 何段目か（1から数える） */
  done: number;
  total: number;
  step: RunStepLog;
}): string {
  const head = `${input.runLabel} ${input.done}/${input.total} ${input.step.label} → `;
  return head + describeStepOutcome(input.step);
}

/** `→` の右側。結果と、その理由 */
function describeStepOutcome(step: RunStepLog): string {
  const notes = (step.notes ?? []).join("").trim();

  if (step.skipped) {
    // **理由の無い「飛ばしました」を書かない。** 黙って飛ばしたのと
    // 変わらず、あとから見て「なぜ作られなかったのか」が追えない
    const reason = step.reason || notes || "理由は記録されていません";
    return `飛ばしました（${reason}）`;
  }
  if (step.failed) {
    return notes ? `失敗しました（${notes}）` : "失敗しました";
  }
  // 件数を持たない段（あらすじ・紹介文・冒頭診断）は、パネルに出ないので
  // 数えない。0件と書くと「指摘が無かった」と読めてしまう
  if (step.count === undefined) {
    return notes
      ? `できました（結果は別の文書に出しました。${notes}）`
      : "できました（結果は別の文書に出しました）";
  }
  const count = `できました（指摘 ${formatCount(step.count)}件）`;
  return notes ? `${count}（${notes}）` : count;
}

/**
 * 作者が止めた段の1行。
 *
 * **「失敗」と書かない。** 止めたのは作者なので、不具合を疑わせる語を
 * 使うと、あとでログを読み返したときに原因探しが始まる。
 */
export function describeRunCancelledStep(input: {
  runLabel: string;
  done: number;
  total: number;
  label: string;
}): string {
  return (
    `${input.runLabel} ${input.done}/${input.total} ${input.label} → ` +
    "中止しました（ここで止めたので、残りは走らせません）"
  );
}

/**
 * 終わったときの1行。**これが今回いちばん要る行である。**
 *
 * 通知は消えるので、「終わった」ことがどこにも残らなかった。
 */
export function describeRunEnd(input: {
  runLabel: string;
  done: readonly RunStepLog[];
  /** 中止で走らせなかった段の名前。走り切ったら空 */
  remaining: readonly string[];
}): string {
  const head = `${input.runLabel} 終了 → `;

  const ran = input.done.filter((step) => !step.failed && !step.skipped);
  const skipped = input.done.filter((step) => step.skipped);
  const failed = input.done.filter((step) => step.failed);

  if (input.done.length === 0) {
    return (
      head +
      (input.remaining.length === 0
        ? "走らせる段がありませんでした"
        : `1段も実行せずに止まりました（残り：${input.remaining.join("・")}）`)
    );
  }

  const parts = [`できました ${ran.length}段`];
  // 0件の行は並べない。毎回「失敗 0段」と書くと、本当に失敗した回を
  // 目で拾えなくなる
  if (skipped.length > 0) parts.push(`飛ばしました ${skipped.length}段`);
  if (failed.length > 0) parts.push(`失敗 ${failed.length}段`);
  if (input.remaining.length > 0) {
    parts.push(`中止で走らせず ${input.remaining.length}段`);
  }
  return head + parts.join(" / ");
}

/**
 * 探索を打ち切った理由。
 *
 * `features/measureContext.ts` の `ProbeStopReason` と同じ並びを、
 * **`core` から `features` を見に行かずに受け取るために**ここにも書く
 * （依存の向きは `features` → `core` の一方通行）。呼ぶ側がそのまま
 * 渡せるので、片方だけ増えれば型が合わなくなって気づける。
 */
export type TuningStopReason = "timeout" | "rate_limit_floor" | "fatal";

const TUNING_STOP_LABELS: Record<TuningStopReason, string> = {
  timeout: "時間切れ",
  rate_limit_floor: "AIの分あたりの上限",
  fatal: "測定中の失敗",
};

/**
 * AIチューニングの結果を残す行。
 *
 * **測った値と、それを記録したかどうかを、必ず両方書く。** 実機で困った
 * のは「12分測ったのに何も残らなかった」ことなので、記録しなかったときも
 * 測った値は残す——次に測る前に「前回いくつ出たか」が読める。
 *
 * ## 反映するかどうかの判定は、ここでやり直さない
 *
 * 判定と保存は `features/measureContext.ts` の `offerToSave` が持って
 * いる。ここでその条件を書き写すと、片方だけ直したときに**記録と実際の
 * 動きが食い違う**（この作品で何度も起きた壊れ方）。だからここは
 * 「記録したか（`recorded`）」という**結果**と、判断の材料になった事実
 * （打ち切り・前の記録・天井）を並べるだけにしてある。
 */
export function describeTuningLog(input: {
  /** 「ollama/gemma4:26b」の形 */
  modelKey: string;
  /** 通った最大の字数。一度も通らなければ 0 */
  measuredChars: number;
  /** 上の字数をトークンに直したもの */
  measuredTokens: number;
  /** 台帳へ書いたか */
  recorded: boolean;
  /**
   * そのAIで「読める長さ」を台帳へ書くか。
   *
   * Ollama や LM Studio は申告値を API から取れるので書かない。
   * **書かないことを黙ると、作者には「測ったのに反映されない」と映る。**
   */
  recordsContextLength: boolean;
  /** 測れる上限（天井）まで通ってしまったか */
  hitCeiling: boolean;
  /** 途中で打ち切ったなら、その理由 */
  stoppedBy?: TuningStopReason;
  /** いま台帳に入っている「読める長さ」（字） */
  previousChars?: number;
  /** 作者が途中で止めたか */
  cancelled: boolean;
}): string {
  const measured =
    input.measuredChars > 0
      ? `読める長さ ${formatCount(input.measuredChars)}字` +
        `（${formatCount(input.measuredTokens)}トークン）`
      : "読める長さは測れませんでした";

  const facts: string[] = [];
  if (input.cancelled) facts.push("途中で中止");
  if (input.stoppedBy) {
    facts.push(`打ち切り：${TUNING_STOP_LABELS[input.stoppedBy]}`);
  }
  if (input.hitCeiling) facts.push("天井まで通ったため、これ以上は試していない");
  if (input.previousChars !== undefined) {
    facts.push(`前の記録：${formatCount(input.previousChars)}字`);
  }
  const tail = facts.length > 0 ? `。${facts.join(" / ")}` : "";

  return (
    `AIチューニング ${input.modelKey} ${measured}\n` +
    `  → ${describeTuningRecorded(input)}${tail}`
  );
}

function describeTuningRecorded(input: {
  measuredChars: number;
  recorded: boolean;
  recordsContextLength: boolean;
}): string {
  if (input.recorded) {
    return input.recordsContextLength
      ? "記録しました（読める長さと待ち時間）"
      : "記録しました（待ち時間だけ。読める長さはAIの申告値を使うため記録しません）";
  }
  // **「記録なし」の理由を必ず書く。** これが無かったせいで、作者は
  // 反映待ちのダイアログに気づかないまま10分待った
  if (input.measuredChars <= 0) {
    return "記録なし（一度も通らなかったため、覚える値がありません）";
  }
  return "記録なし（設定へ反映していません）";
}

/** 設定資料の抽出が残す件数の内訳 */
export interface ExtractionLogCounts {
  readonly added: number;
  readonly updated: number;
  readonly rejected: number;
  readonly conflicts: number;
  /** 作中の変化として自動で畳んだ件数（設計書6.18） */
  readonly folded: number;
  readonly failedChunks: number;
  readonly saved: number;
  /** 既存人物への更新のうち、承認待ちに回した人数 */
  readonly pendingUpdates: number;
  readonly cacheWarnings: number;
  /**
   * 根拠（本文の引用）が無いので、本体の値を変えなかった変化の件数
   * （作者の裁定、2026-09-23。`characterMerge.ts` の `heldChanges`）。
   * 0件なら行に書かない
   */
  readonly heldChanges?: number;
}

/**
 * 設定資料の抽出が終わったときの行。
 *
 * **「新規0名・更新0名」で終わった回こそ、この行が要る。** 通知だけだと
 * 消えたあとに「何も増えなかった」しか残らず、除外や失敗のせいなのか、
 * 本当に増えるものが無かったのかを区別できない。
 */
export function describeExtractionLog(counts: ExtractionLogCounts): string {
  const parts = [
    `新規 ${formatCount(counts.added)}名`,
    `更新 ${formatCount(counts.updated)}名`,
    `除外 ${formatCount(counts.rejected)}件`,
    `競合 ${formatCount(counts.conflicts)}件`,
    `作中の変化として記録 ${formatCount(counts.folded)}件`,
    `失敗 ${formatCount(counts.failedChunks)}チャンク`,
    `保存 ${formatCount(counts.saved)}名`,
  ];
  if (counts.pendingUpdates > 0) {
    parts.push(`承認待ち ${formatCount(counts.pendingUpdates)}名`);
  }
  if (counts.cacheWarnings > 0) {
    parts.push(`キャッシュ保存警告 ${formatCount(counts.cacheWarnings)}件`);
  }
  if ((counts.heldChanges ?? 0) > 0) {
    parts.push(
      `根拠が無いので本体を変えなかった変化 ${formatCount(counts.heldChanges ?? 0)}件`
    );
  }

  // 資料が1件も増えなかったときは、なぜ増えなかったかの手がかりを添える
  const nothingAdded = counts.added === 0 && counts.updated === 0;
  const causes: string[] = [];
  if (counts.rejected > 0) causes.push(`除外 ${formatCount(counts.rejected)}件`);
  if (counts.failedChunks > 0) {
    causes.push(`失敗 ${formatCount(counts.failedChunks)}チャンク`);
  }
  if (counts.conflicts > 0) {
    causes.push(`競合 ${formatCount(counts.conflicts)}件`);
  }
  const tail = !nothingAdded
    ? ""
    : causes.length > 0
      ? `\n  → 資料は増えていません（${causes.join(" / ")}）`
      : "\n  → 資料は増えていません（本文から新しく取れるものがありませんでした）";

  return `設定資料の抽出 → ${parts.join(" / ")}${tail}`;
}

/** 設定資料の抽出を、作者が途中で止めたときの行 */
export function describeExtractionCancelled(): string {
  return (
    "設定資料の抽出 → 中止しました" +
    "（完了済みの処理は次回再利用されます。資料は書き換えていません）"
  );
}
