import type { GitSyncStatus } from "./git";
import type { WorkEntry } from "../models/types";
import { divergenceLine } from "./gitSyncStatusText";
import { isPathInside, isSameFolder, join } from "./pathText";
import { settingsToChooseCount, type ConflictWalkStart } from "./divergenceScan";
import { finishReviewLabel, saveAndSyncLabel, setupGithubLabel } from "./syncEntryNames";

/**
 * 「作品をすべて同期する」で、置き場ごとに何をするかを決める（設計書5.5.14）。
 *
 * 作者の依頼（2026-08-24）：「作品をすべて同期するを実装してください」。
 *
 * ## 作品ごとではなく、置き場ごとに動かす
 *
 * 既定では**1つのリポジトリに複数の作品**が入っている（書庫、5.7）。
 * 作品ごとに回すと、同じ置き場を作品の数だけ処理することになる。
 *
 * - 同じ変更を何度も記録しようとする（2回目からは「記録するものがない」）
 * - **送信の確認が作品の数だけ出る**
 *
 * **置き場を鍵にしてまとめてから動かす。**
 *
 * ## やる順番は 記録 → 取り込み → 送信
 *
 * - **記録が先。** 未コミットの変更があると取り込みを行わない決まり
 *   （5.5.1）。先に記録しておかないと、取り込みが必ず飛ばされる
 * - **取り込みが先、送信があと。** 別の環境が先に進んでいると送信は
 *   拒まれる。取り込んでからのほうが1回で通る
 *
 * VS Code APIに依存しない（状態は呼び出し側が読んで渡す）。
 */

/** 置き場1つぶんの、いまの状態 */
export interface SyncTargetState {
  folderPath: string;
  label: string;
  works: WorkEntry[];
  status: GitSyncStatus;
  /**
   * 記録していない変更の数。
   *
   * **`status.dirty` とは別に渡す。** あちらは自動で書き換わるもの
   * （執筆量の記録）を数えない（5.5.13）。**記録するときは全部入る**ので、
   * 「何件記録されるか」はこちらで数えたものを使う
   */
  trackable: number;
  /**
   * 作品の中で、まだ保存していない文書の数（設計書5.5.19。作者の裁定 2026-10-04）。
   *
   * **ディスクの件数（`trackable`）とは別に持つ。** 変更が未保存の文書にしか
   * 無い置き場は `trackable` が0で、数えなければ「同期は取れています」と
   * 飛ばされ、記録の前の保存までたどり着かない。
   */
  unsaved?: number;
  /**
   * **この回に関わる作品**（作者の指摘、2026-10-12 夜）。
   *
   * 記録待ち・送信待ち・取り込み待ちの変更がある作品と、未保存の文書が
   * ある作品。置き場の git が出す変わった道を作品フォルダーへ当てて決める
   * （`worksTouchedByPaths`）。画面とログに出す作品名を、書庫の全作品では
   * なくこれに絞るために使う。**手順（記録・送信）は置き場ぜんぶのまま。**
   *
   * 調べられなかったときは undefined（名前は書庫の名前だけにする）。
   */
  involved?: WorkEntry[];
  /**
   * 状態を調べる前の取りに行き（fetch）が失敗したか（2026-11-02）。
   *
   * 失敗すると遅れの数は手元が知っている古いままで、0件なら「同期は取れています」で
   * 飛ばされ、作者には受け取れなかったことが伝わらなかった（原稿箱の受け取りと同じ形）。
   * ほかにやることが無い置き場だけ、理由を `fetch_failed` に替える
   */
  fetchFailed?: boolean;
  /**
   * 取りに行けなかった理由を GitHub の API で見分けた結果（編集者モードだけ。設計書5.7.5.4、
   * 作者の決定 2026-11-07）。`revoked`＝置き場に届かない（解除か、置き場が無い）、
   * `offline`＝通信そのものが失敗した。分からなければ付けない（今までの `fetch_failed` の文）
   */
  fetchTrouble?: "revoked" | "offline";
  /**
   * この置き場に入っている登録済みの作品のうち、フォルダーが見つからないもの
   * （2026-11-14 の事故。設計書5.5.14）。1つでもあれば、この置き場は記録も取り込みも
   * 送信もしない（`work_missing`）。
   *
   * 消した・移した作品と、OneDrive の移動・外れた外付けドライブ・取り寄せ中のクラウドは
   * 見分けられない。記録すると作品の削除が履歴に入り、送ると GitHub でも作品が消えた形になる
   */
  missingWorks?: WorkEntry[];
}

/** その置き場でやること */
export interface SyncTargetPlan {
  target: SyncTargetState;
  /** 記録する（コミットする）か */
  commit: boolean;
  /** 取り込むか */
  pull: boolean;
  /** 送信するか */
  push: boolean;
  /**
   * 何もしない理由。**やることが無いのと、できないのは違う。**
   * できないなら理由を出す
   */
  skip?: SkipReason;
  /**
   * 受け取るだけの手順か（編集者モード。作者の判断 2026-11-01）。
   *
   * 確認の窓で「GitHubへ送信します」と言わず、送るのは「校閲を終えて返す」だと
   * 言うために持つ。**`commit`・`push` は必ず偽**（`planSyncTarget`）
   */
  receiveOnly?: boolean;
}

/** `planSyncTarget` に渡す、いまの環境の立場 */
export interface SyncPlanMode {
  /**
   * 編集者モードか。**編集者の「保存・同期」は受け取るだけ**（作者の判断 2026-11-01）。
   * core は VS Code の設定を読まないので、呼び出し側（`features/handoffSync.ts`）が
   * `isEditorMode()` を読んで渡す
   */
  editor?: boolean;
}

export type SkipReason =
  /** gitコマンドが無い */
  | "git_missing"
  /** リポジトリではない（Gitを使わずに書いている作品） */
  | "not_a_repo"
  /** リモートが未設定。記録はできるが、送受信はできない */
  | "no_remote"
  /** 上流が未設定。まだ一度も送信していない */
  | "no_upstream"
  /** ブランチを見ていない */
  | "detached"
  /** 競合が解決していない */
  | "unmerged"
  /** 状態を読めなかった */
  | "failed"
  /**
   * 編集者モードで、作者の側と分かれている（手元に送っていない提案の記録がある）。
   * 合わせて送るのは「校閲を終えて返す」の役目（`finishReview.ts` の台帳だけの合わせ直し）
   */
  | "editor_diverged"
  /**
   * 手元ではやることが無いが、GitHub を取りに行けなかった（`SyncTargetState.fetchFailed`）。
   * 「同期は取れています」とは言えない
   */
  | "fetch_failed"
  /** 取りに行けず、GitHub の API で見ても置き場に届かなかった（`fetchTrouble: "revoked"`） */
  | "fetch_revoked"
  /** 取りに行けず、通信そのものが失敗した（`fetchTrouble: "offline"`） */
  | "fetch_offline"
  /** 登録済みの作品のフォルダーが見つからない（`SyncTargetState.missingWorks`） */
  | "work_missing"
  /** やることが無い（同期は取れている） */
  | "nothing";

/**
 * 飛ばした理由の文。
 *
 * **関数にしてあるのは、メニューの名前を木から引くため**（`syncEntryNames.ts`）。
 * 定数の表にすると、読み込みの順で木がまだ無いうちに名前を引くことになる。
 */
export function skipReasonText(reason: SkipReason): string {
  switch (reason) {
    case "git_missing":
      return "gitが見つかりません";
    case "not_a_repo":
      return "Gitで管理していません";
    case "no_remote":
      return `送り先が未設定です（「${setupGithubLabel()}」で決められます）`;
    case "no_upstream":
      return `まだ一度も送信していません（「${setupGithubLabel()}」で送れます）`;
    case "detached":
      return "ブランチを見ていません";
    case "unmerged":
      return "どちらの文を残すか決まっていない原稿があります（「残す文を選ぶ」で選べます）";
    case "failed":
      return "状態を読めませんでした";
    case "editor_diverged":
      return (
        "作者の側と、手元の提案の記録が分かれています" +
        `（「${finishReviewLabel()}」で、そろえて作者へ届けます）`
      );
    case "fetch_failed":
      // 理由は当てない（実装ルール5）。git の文はログに残してある
      return "GitHub から受け取れませんでした（詳しくはログにあります）";
    case "fetch_revoked":
      // 見分けは git の文でなく GitHub の API の返事（404）で決めてある（`fetchTrouble`）
      return "置き場に届きませんでした（作者が連携を解除したか、置き場が無くなった見込みです）";
    case "fetch_offline":
      return "ネットにつながっていないようです（つながってから、もう一度押してください）";
    case "work_missing":
      // 作品名を入れた文は `describeMissingWorks`（理由だけでは名前が分からない）
      return "作品のフォルダーが見つかりません";
    case "nothing":
      return "同期は取れています";
  }
}

/**
 * フォルダーが見つからない作品があって、置き場の同期を止めたときの文（2026-11-14）。
 *
 * 前の確認の窓では「同期しません」、あとの報告では「同期を止めました」と場面で分ける
 * （`describeSyncSkips` の `when` と同じ考え）。単独の同期（`gitSync.ts`）も同じ文を使う。
 */
export function describeMissingWorks(
  missing: readonly WorkEntry[],
  when: "before" | "after" | "share"
): string {
  const names = missing.map((work) => work.title).join("、");
  // 「編集者へ渡す」は同期ではないので、同期の言葉を使わない（2026-11-14）
  if (when === "share") {
    return (
      `作品のフォルダーが見つからないので、編集者へ渡していません：${names}。` +
      "消したり移したりした作品なら、作品の一覧から外してから渡してください。"
    );
  }
  const stop = when === "before" ? "この置き場は同期しません" : "この置き場は同期を止めました";
  return (
    `作品のフォルダーが見つからないので、${stop}：${names}。` +
    "消したり移したりした作品なら、作品の一覧から外してから同期してください。"
  );
}

/**
 * フォルダーが見つからない作品を、作品の一覧から外すボタンの字。
 * 押すと既存の「作品の登録を解除」（`novelai.removeWork`。確認の窓が出る）へ渡す
 */
export function unregisterMissingWorkLabel(work: WorkEntry): string {
  return `「${work.title}」の登録を解除`;
}

/**
 * 置き場ごとの手順を決める。
 *
 * **競合が残っているものには触らない。** 記録すると競合マーカーごと
 * 履歴に入る（5.5.3）。
 */
export function planSyncTarget(
  target: SyncTargetState,
  mode: SyncPlanMode = {}
): SyncTargetPlan {
  /*
    **フォルダーが無い作品がある置き場は、何もしない**（2026-11-14 の事故。編集者モードも同じ）。
    `git add -A` は作品の削除ごと記録し、送れば GitHub でも作品が消えた形になる。取り込みも
    しない——無いフォルダーへ書き戻すと、作者が移した先と元の場所に作品が2つできる
  */
  if (target.missingWorks && target.missingWorks.length > 0) {
    return {
      target,
      commit: false,
      pull: false,
      push: false,
      skip: "work_missing",
      ...(mode.editor ? { receiveOnly: true } : {}),
    };
  }
  if (mode.editor) return planReceiveOnly(target);
  const base = { target, commit: false, pull: false, push: false };
  const status = target.status;
  // 未保存の文書は、記録の前に保存してから入れる（設計書5.5.19）
  const recordable = target.trackable > 0 || (target.unsaved ?? 0) > 0;

  switch (status.kind) {
    case "git_missing":
      return { ...base, skip: "git_missing" };
    case "not_a_repo":
      return { ...base, skip: "not_a_repo" };
    case "detached":
      return { ...base, skip: "detached" };
    case "failed":
      return { ...base, skip: "failed" };
    case "no_remote":
      // 送り先が無くても、履歴に残すことはできる
      return recordable
        ? { ...base, commit: true }
        : { ...base, skip: "no_remote" };
    case "no_upstream":
      return recordable
        ? { ...base, commit: true, skip: "no_upstream" }
        : { ...base, skip: "no_upstream" };
    case "tracked":
      break;
  }

  // **競合マーカーを履歴へ入れない**（5.5.3）
  if (status.unmerged > 0) return { ...base, skip: "unmerged" };

  const commit = recordable;
  const pull = status.behind > 0;
  // 記録するぶんも送る。記録すれば ahead が増える
  const push = status.ahead > 0 || commit;

  if (!commit && !pull && !push) return { ...base, skip: nothingOrFetchFailed(target) };
  return { ...base, commit, pull, push };
}

/**
 * 編集者モードの手順：**受け取るだけ**（作者の判断 2026-11-01）。
 *
 * 編集者が作者へ送るのは「校閲を終えて返す」だけにする。ここで記録すると
 * `git add -A` が本文の書きかけまで履歴に入れ、送れば作者の原稿の履歴へ流れる。
 *
 * - 作者が先へ進んでいれば受け取る（書きかけの提案は git が退避して戻す。
 *   `syncAllWorks.ts` の記録の前の早送り）
 * - 手元に送っていない提案の記録があって分かれているなら、合わせにいかない。
 *   合わせて送るのは「校閲を終えて返す」（台帳だけを混ぜ、本文は作者の側を使う）
 * - 送り先が無い・競合が残るなどは、作者モードと同じ理由で飛ばす
 */
function planReceiveOnly(target: SyncTargetState): SyncTargetPlan {
  const base = {
    target,
    commit: false,
    pull: false,
    push: false,
    receiveOnly: true,
  };
  const status = target.status;
  switch (status.kind) {
    case "git_missing":
    case "not_a_repo":
    case "detached":
    case "failed":
    case "no_remote":
    case "no_upstream":
      return { ...base, skip: status.kind };
    case "tracked":
      break;
  }
  if (status.unmerged > 0) return { ...base, skip: "unmerged" };
  if (status.behind > 0 && status.ahead > 0) {
    return { ...base, skip: "editor_diverged" };
  }
  if (status.behind > 0) return { ...base, pull: true };
  return { ...base, skip: nothingOrFetchFailed(target) };
}

/**
 * やることが無い置き場の理由。取りに行けなかったなら「同期は取れています」と言わない
 * （2026-11-02。遅れの数が古いままなので、取れているかは分からない）
 */
function nothingOrFetchFailed(target: SyncTargetState): SkipReason {
  if (!target.fetchFailed) return "nothing";
  if (target.fetchTrouble === "revoked") return "fetch_revoked";
  if (target.fetchTrouble === "offline") return "fetch_offline";
  return "fetch_failed";
}

/** 置き場をまとめて、やることを決める */
export function planSyncAll(
  targets: readonly SyncTargetState[],
  mode: SyncPlanMode = {}
): SyncTargetPlan[] {
  // `map(planSyncTarget)` と書かない。2つ目の引数に並びの番号が渡ってしまう
  return targets.map((target) => planSyncTarget(target, mode));
}

/** 実際に動かすものだけ */
export function actionablePlans(
  plans: readonly SyncTargetPlan[]
): SyncTargetPlan[] {
  return plans.filter((plan) => plan.commit || plan.pull || plan.push);
}

/**
 * 何が起きるかを1行で書く。
 *
 * **押す前に、外へ何が出るのかが分かるようにする。**
 */
export function describePlan(plan: SyncTargetPlan): string {
  const parts: string[] = [];
  if (plan.commit) {
    const unsaved = plan.target.unsaved ?? 0;
    // **保存してから記録することを、押す前に見せる**（設計書5.5.19）。
    // ディスクの件数だけだと、未保存しか無い置き場が「記録 0件」に見える
    parts.push(
      unsaved > 0
        ? `${plan.target.trackable > 0 ? `記録 ${plan.target.trackable}件` : "記録"}` +
            `（未保存 ${unsaved}件を先に保存）`
        : `記録 ${plan.target.trackable}件`
    );
  }
  if (plan.pull) {
    const status = plan.target.status;
    // **分かれているなら、そう書く**（設計書5.5.18）。押す前に、
    // 選ぶことになるのかどうかが分かるようにする
    const diverged = divergenceLine(status);
    parts.push(
      diverged ?? `取り込み ${status.kind === "tracked" ? status.behind : 0}件`
    );
  }
  if (plan.push) {
    const status = plan.target.status;
    const ahead = status.kind === "tracked" ? status.ahead : 0;
    // 記録するぶんも送られる。数字だけ出すと足りなく見える
    parts.push(
      plan.commit ? `送信 ${ahead}件＋記録したぶん` : `送信 ${ahead}件`
    );
  }
  if (parts.length === 0) {
    return skipReasonText(plan.skip ?? "nothing");
  }
  return parts.join(" / ");
}

/**
 * 記録（コミット）の結果を、次にどうするかへ翻訳する。
 *
 * **「記録するものが無い」で打ち切らない**（2026-08-26、作者の実機）。
 * gitは記録するものが無いとき終了コード1を返す。これを失敗として扱って
 * いたため、
 *
 *   ・novel（…）：記録できませんでした: On branch main / nothing to commit
 *
 * と出て**そこで打ち切っていた**。この置き場は取り込み1件・送信11件を
 * 抱えており、**本当に必要な手順がまるごと飛んでいた。**
 *
 * 件数を数えてから記録するまでの間に、別の窓・前回の実行・作者自身の操作が
 * 先に記録すれば、記録するものは無くなる。**それは失敗ではない。**
 */
export function afterCommit(result: {
  ok: boolean;
  detail?: string;
  nothingToCommit?: boolean;
}): { stop: true; error: string } | { stop: false; committed: boolean } {
  if (!result.ok) {
    return {
      stop: true,
      error: `記録できませんでした: ${result.detail ?? "（詳細なし）"}`,
    };
  }
  return { stop: false, committed: !result.nothingToCommit };
}

/**
 * 書庫で関わる作品がこの数以上なら、先頭だけ名前を出して残りは「ほか N作品」にする。
 *
 * 確認の窓・進み具合・ログの1行に入るので、長くすると読めなくなる。
 */
const INVOLVED_SHORTEN_FROM = 4;
/** 縮めるときに名前を出す数 */
const INVOLVED_SHOWN_WHEN_SHORT = 2;

/**
 * 置き場の名前と、**その回に関わる作品**の名前（作者の指摘、2026-10-12 夜）。
 *
 * 「書庫単位で同期する際、書庫の全部作品名がでるのはわかりにくいです。
 * 作品名を特定してください」。それまでは書庫の名前のあとに中の作品を
 * 全部並べていたため、1作品しか直していないのに5作品の名前が出て、
 * どれが送られたのか読み取れなかった。
 *
 * - 作品が1つだけの置き場：その作品名（これまでどおり）
 * - 書庫で関わる作品が1つ：「いじめられっ子（書庫 novel-works）」
 * - 2〜3作品：「novel-works の いじめられっ子・たゆたう鉛」
 * - 4作品以上：「novel-works の いじめられっ子・たゆたう鉛 ほか2作品」
 * - 作品に当てられない変更しか無い・調べられなかった：書庫の名前だけ。
 *   **全作品を並べる形には戻さない**——関わらない作品の名前を出すと、
 *   作者はそれも送られたと読む
 *
 * 自動の送り直し（`autoResend.ts`）も同じ書き方にするので、置き場の
 * 状態（`SyncTargetState`）に縛らない形で受け取る。
 */
export function describePlaceWorks(
  label: string,
  works: readonly WorkEntry[],
  involved: readonly WorkEntry[] | undefined
): string {
  if (works.length === 0) return label;
  if (works.length === 1) return works[0].title;
  const names = (involved ?? []).map((work) => work.title);
  if (names.length === 0) return label;
  if (names.length === 1) return `${names[0]}（書庫 ${label}）`;
  if (names.length < INVOLVED_SHORTEN_FROM) {
    return `${label} の ${names.join("・")}`;
  }
  const shown = names.slice(0, INVOLVED_SHOWN_WHEN_SHORT);
  return `${label} の ${shown.join("・")} ほか${names.length - shown.length}作品`;
}

/** 置き場の名前と、その回に関わる作品名（`describePlaceWorks`） */
export function describeTargetWorks(target: SyncTargetState): string {
  return describePlaceWorks(target.label, target.works, target.involved);
}

/**
 * 置き場の根からの道（git が出す `/` 区切りの相対の道）を、作品フォルダーへ当てる。
 *
 * **作品の並びは登録の順のまま返す**（文の「・」の順が実行のたびに
 * 入れ替わらないように）。書庫の直下のファイル（README など）は
 * どの作品にも当たらない。
 *
 * 作品フォルダーが置き場の根そのもののときは、どの道もその作品に当てる。
 */
export function worksTouchedByPaths(
  root: string,
  works: readonly WorkEntry[],
  relativePaths: readonly string[]
): WorkEntry[] {
  if (relativePaths.length === 0) return [];
  const absolute = relativePaths.map((one) => join(root, one));
  return works.filter(
    (work) =>
      isSameFolder(work.folderPath, root) ||
      absolute.some((file) => isPathInside(work.folderPath, file))
  );
}

/**
 * 飛ばしたものの理由をまとめる（確認と報告の末尾に添える行）。
 *
 * **「同期は取れています」は書かない。** それは飛ばした理由ではなく、
 * 何もすることが無かったというだけで、作者が直すところが無い。
 *
 * `syncAllWorks` の中に置いていたが、**出す文言そのものを試験から
 * 見たい**ので、VS Code に依存しない側へ移した。
 */
export function describeSyncSkips(
  plans: readonly SyncTargetPlan[],
  /**
   * 前の確認の窓か、あとの報告か（作者の答え 2026-11-05：場面で分ける）。
   * 以前は両方「次は同期しません。」で、あとの報告では「次回は同期しない」と読めた
   */
  when: "before" | "after" = "before"
): string {
  const skipped = plans.filter(
    (plan) => plan.skip && !plan.commit && !plan.pull && !plan.push
  );
  const notable = skipped.filter((plan) => plan.skip !== "nothing");
  if (notable.length === 0) return "";
  const detail = notable
    .map(
      (plan) =>
        `・${describeTargetWorks(plan.target)}：${
          plan.skip === "work_missing" && plan.target.missingWorks
            ? describeMissingWorks(plan.target.missingWorks, when)
            : skipReasonText(plan.skip ?? "nothing")
        }`
    )
    .join("\n");
  const head = when === "after" ? "以下は同期できませんでした。" : "以下は同期しません。";
  return `\n\n${head}\n${detail}`;
}

/** 確認の窓のボタン。**押された文字で分けるので、定数を1か所に置く** */
const SYNC = "同期する";
const SYNC_NEWEST = "同期する（設定資料は新しいほうへ）";
const SYNC_ONE_BY_ONE = "同期する（1件ずつ選ぶ）";
/** 編集者モードの確認のボタン（受け取るだけ） */
const RECEIVE = "受け取る";

/**
 * 同期の確認の窓に出す中身（作者の裁定、2026-10-01 案2）。
 *
 * 作者の報告（2026-09-27）：別の機械で変えた分との合流が3クリックかかる
 * （［保存・同期］→［同期する］→ 見比べの入口［全部、新しいほうを採る］）。
 *
 * **選ぶ設定資料があるときだけ**、この窓に選び方のボタンを並べて、
 * 続けて出ていた入口の窓を省く。無ければ「同期する」1つ。
 * 入口の窓が言っていたこと（作者が選ぶ件数・途中でやめたら戻すこと・
 * 退避の枝）は、ここへ移す。**本文は今までどおり1件ずつ選ぶ。**
 */
export function describeSyncConfirm(
  doing: readonly SyncTargetPlan[],
  all: readonly SyncTargetPlan[]
): { message: string; detail: string; buttons: string[] } {
  const lines = doing.map(
    (plan) => `・${describeTargetWorks(plan.target)}：${describePlan(plan)}`
  );

  /*
    **編集者モードは受け取るだけ**（作者の判断 2026-11-01）。「GitHubへ送信します」
    「送り先が未設定です」とは言わず、送る道（校閲を終えて返す）を名指す。
    分かれた置き場は合わせにいかない（`planReceiveOnly`）ので、選ぶものの説明も要らない
  */
  if (doing.length > 0 && doing.every((plan) => plan.receiveOnly)) {
    return {
      message: `${doing.length}か所で、作者の最新の原稿を受け取ります。`,
      detail:
        `${lines.join("\n")}\n\n` +
        "受け取るだけで、GitHubへは何も送りません。" +
        `提案は「${finishReviewLabel()}」で作者へ届きます。` +
        describeSyncSkips(all),
      buttons: [RECEIVE],
    };
  }

  const sending = doing.filter((plan) => plan.push).length;

  let settings = 0;
  let manuscripts = 0;
  for (const plan of doing) {
    const status = plan.target.status;
    if (!plan.pull || status.kind !== "tracked") continue;
    settings += settingsToChooseCount(status.conflicts);
    manuscripts += status.conflicts?.manuscripts.length ?? 0;
  }

  const choosing: string[] = [];
  if (settings > 0 || manuscripts > 0) {
    choosing.push(
      `作者が選ぶものがあります（設定資料 ${settings}件・本文 ${manuscripts}件）。`
    );
    if (settings > 0) {
      choosing.push(
        "設定資料は、押したボタンで決めます（新しいほうへまとめて／1件ずつ）。"
      );
    }
    if (manuscripts > 0) choosing.push("本文は1件ずつお選びいただきます。");
    choosing.push(
      "途中でやめると、合わせるのをやめて元の状態へ戻します。" +
        "合わせる前に退避の枝を作るので、あとから丸ごと戻せます。"
    );
  }

  return {
    message: `${doing.length}か所を同期します。`,
    detail:
      `${lines.join("\n")}\n\n` +
      (choosing.length > 0 ? `${choosing.join("\n")}\n\n` : "") +
      (sending > 0
        ? `${sending}か所はGitHubへ送信します。\n`
        : "GitHubへは送信しません（送り先が未設定です）。\n") +
      "記録の説明は、日付から自動で付けます。" +
      describeSyncSkips(all),
    buttons: settings > 0 ? [SYNC_NEWEST, SYNC_ONE_BY_ONE] : [SYNC],
  };
}

/**
 * 押されたボタンを、見比べの始め方へ直す。**押さずに閉じたら undefined**（同期しない）。
 *
 * 「同期する」1つのときは `manuscriptsOnly`——選ぶ設定資料は無いと見込んだ
 * ので、見込みが外れたら入口の窓で訊く（`ConflictWalkStart`）。
 */
export function syncChoiceOf(
  answer: string | undefined
): ConflictWalkStart | undefined {
  if (answer === SYNC_NEWEST) return "newest";
  if (answer === SYNC_ONE_BY_ONE) return "oneByOne";
  if (answer === SYNC || answer === RECEIVE) return "manuscriptsOnly";
  return undefined;
}

/**
 * 記録（コミット）に付ける説明。「2026-08-24 20:30 の執筆（3件）」。
 *
 * **AIには書かせない**（設計書5.5.1）。記録のたびにAIを呼ぶと、料金が
 * 執筆の回数に比例してかかる。日付と件数だけで十分に目印になる。
 *
 * 「作品をすべて同期」と「変更を記録する」で同じ形にする——**写しを
 * 2つ持つと、片方だけ直したときに履歴の見た目が食い違う。**
 */
export function syncCommitMessage(count: number, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${stamp} の執筆（${count}件）`;
}

/** 済んだあとの報告に使う結果 */
export interface SyncTargetOutcome {
  plan: SyncTargetPlan;
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  /** 途中で止まった理由。無ければ最後まで通った */
  error?: string;
  /**
   * 分岐で止まったか。
   *
   * **理由の文言で見分けない。** 報告から「分かれた分を合わせる」へ
   * 案内するかどうかがこれで決まるので、文を書き換えたら案内が消える、
   * という壊れ方をさせない（設計書5.5.16）
   */
  diverged?: boolean;
  /**
   * 早送りで取り込んだあと、退避した書きかけを戻すときに食い違って止めたか
   * （作者の判断 2026-11-01、洗い出しの3）。報告から残す文を選ぶ画面へ直に
   * 行けるようにするための印。`diverged` と同じく、**理由の文言で見分けない**
   */
  conflicted?: boolean;
  /**
   * 送信だけが GitHub へ届かなかったか（作者の裁定 2026-11-03）。それより前の段
   * （記録・取り込み）は済んでいる。報告で「届いていない」ことと作品の数を言うための印。
   * `diverged` と同じく、**理由の文言で見分けない**。届かなかった原因は当てない（実装ルール5）
   */
  pushFailed?: boolean;
  /**
   * 分かれた分を、その場で合わせた結果（設計書5.5.18）。
   *
   * **件数を持つ。** 作者の指摘（2026-09-10）：「競合解決があるかないか
   * わからない。件数が出ない」。報告に出すのはこれである
   */
  folded?: FoldSummary;
  /**
   * 記録より**先に**早送りで取り込んだ件数（設計書5.5.18）。
   *
   * **黙ってやらない。** 作者が押したのは「同期」であって、順番までは
   * 見えない。ここで先に取り込んだからこそ分岐が生まれなかった、という
   * ことが報告で分かるようにする
   */
  preRecordPulled?: number;
}

/** 合流の結果を、報告に出せる形にしたもの */
export interface FoldSummary {
  /** 取り込んだファイル数 */
  incoming: number;
  /** 規則で新しいほうへ揃えた設定資料の件数 */
  settings: number;
  /** 作者が1件ずつ選んだ件数 */
  manuscripts: number;
  /** 戻すための枝 */
  backup: string;
}

/**
 * まとめの一言を作る。
 *
 * **できたことと、できなかったことを両方書く。** 「同期しました」だけだと、
 * 半分しか通っていないときに気づけない。
 */
export function describeOutcomes(
  outcomes: readonly SyncTargetOutcome[],
  options: {
    /**
     * 自動の送り直し（`novelai.git.autoResend`）が入っているか。届かなかったときの
     * 次の一言を事実に合わせる（`gitSync.ts` の `describeDirtyPull` と同じ考え）。
     * core は設定を読まないので呼び出し側が渡す。省けば入っているとみなす（既定が入）
     */
    autoResend?: boolean;
  } = {}
): string {
  // 送信だけ届かなかった置き場は、下の `describeUnsent` がまとめて言う。
  // 「記録 Nか所」「最後まで通りませんでした」に数えると同じことを2度言う
  const rest = outcomes.filter((one) => !one.pushFailed);
  const pushed = rest.filter((one) => one.pushed).length;
  const pulled = rest.filter((one) => one.pulled).length;
  const committed = rest.filter((one) => one.committed).length;
  const failed = rest.filter((one) => one.error).length;
  const unsent = describeUnsent(outcomes, options.autoResend !== false);

  const parts: string[] = [];
  if (committed > 0) parts.push(`記録 ${committed}か所`);
  if (pulled > 0) parts.push(`取り込み ${pulled}か所`);
  if (pushed > 0) parts.push(`送信 ${pushed}か所`);
  if (parts.length === 0 && failed === 0 && unsent === "") {
    return "同期するものはありませんでした。";
  }

  const head = parts.length > 0 ? `${parts.join("・")}を済ませました。` : "";
  const tail =
    failed > 0 ? `${failed}か所は最後まで通りませんでした。` : "";
  return `${head}${unsent}${tail}${describePreRecordPulls(outcomes)}${describeFolds(
    outcomes
  )}`;
}

/**
 * 送信が GitHub へ届かなかった置き場を1文で（作者の裁定 2026-11-03 夜）。
 *
 * 「手元には記録しました。GitHub へは届いていません（N作品）。ネットにつながったら
 * 自動で送ります。」——**原因は当てない**（回線とは限らない。実装ルール5）。言うのは
 * 届いていない事実と作品の数と、次に起きること。数えるのはその回に関わる作品
 * （分からなければ置き場の作品ぜんぶ）で、確認の窓・報告の作品名と同じ数え方にする。
 *
 * 自動の送り直しが切ってあれば、送るのは作者の操作なので押す所を言う。
 */
function describeUnsent(
  outcomes: readonly SyncTargetOutcome[],
  autoResend: boolean
): string {
  const unsent = outcomes.filter((one) => one.pushFailed);
  if (unsent.length === 0) return "";
  const works = unsent.reduce(
    (sum, one) => sum + (one.plan.target.involved?.length || one.plan.target.works.length || 1),
    0
  );
  // 記録していない置き場（前からの未送信だけ）で「記録しました」と言うと事実と違う
  const recorded = unsent.some((one) => one.committed) ? "手元には記録しました。" : "";
  const next = autoResend
    ? "ネットにつながったら自動で送ります。"
    : `ネットにつながったら「${saveAndSyncLabel()}」をもう一度押してください。`;
  return `${recorded}GitHub へは届いていません（${works}作品）。${next}`;
}

/**
 * 記録より先に取り込んだ置き場を書き添える（設計書5.5.18）。
 *
 * **分岐は、遅れている側が先にコミットした瞬間に生まれる。** 遅れたまま
 * 記録すると、21件遅れていただけの置き場が「25件先・21件遅れ」になって
 * 抜けられなくなる（2026-09-11、作者のノートPC）。先に取り込めば分岐は
 * 生まれないが、**何も出さないと「なぜか競合しなくなった」で終わる**ので、
 * どこで何件を先に入れたかを残す。
 */
export function describePreRecordPulls(
  outcomes: readonly SyncTargetOutcome[]
): string {
  const early = outcomes.filter(
    (one): one is SyncTargetOutcome & { preRecordPulled: number } =>
      one.preRecordPulled !== undefined && one.preRecordPulled > 0
  );
  if (early.length === 0) return "";

  const detail = early
    .map(
      (one) =>
        `${describeTargetWorks(one.plan.target)}（${one.preRecordPulled}件）`
    )
    .join("、");
  return `\n記録より先に、GitHubの分を取り込みました：${detail}。`;
}

/**
 * 合わせた分を、件数つきで書き添える（設計書5.5.18）。
 *
 * 作者の指摘（2026-09-10）：「競合解決があるかないかわからない。件数が出ない」。
 * **黙って片方へ寄せたことにしない。** 何件をどう片づけたかを必ず出す。
 */
export function describeFolds(
  outcomes: readonly SyncTargetOutcome[]
): string {
  const folded = outcomes.filter(
    (one): one is SyncTargetOutcome & { folded: FoldSummary } =>
      one.folded !== undefined
  );
  if (folded.length === 0) return "";

  const settings = folded.reduce((sum, one) => sum + one.folded.settings, 0);
  const manuscripts = folded.reduce(
    (sum, one) => sum + one.folded.manuscripts,
    0
  );
  const detail: string[] = [];
  if (settings > 0) detail.push(`設定資料 ${settings}件は新しいほうに揃えました`);
  if (manuscripts > 0) {
    detail.push(`本文など ${manuscripts}件はお選びいただきました`);
  }
  if (detail.length === 0) detail.push("同じ箇所の衝突はありませんでした");

  return (
    `\n別の環境の変更を ${folded.length}か所で合わせました` +
    `（${detail.join("／")}）。`
  );
}
