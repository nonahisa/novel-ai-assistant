import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { WorkRegistry } from "../core/workRegistry";
import {
  changedFilesEachSide,
  fetchRemote,
  pullFastForward,
  push,
  readSyncStatus,
  runGit,
  type GitCommandRunner,
  type GitSyncStatus,
} from "../core/git";
import {
  orderStartupTargets,
  overlappingChangedFiles,
  planHandoff,
  type HandoffAction,
} from "../core/handoffPlan";
import {
  clearUnsentMark,
  describeUnsentMark,
  readUnsentMark,
  summarizeUnsent,
  writeUnsentMark,
  type UnsentMarkStorage,
} from "../core/unsentMark";
import { buildSyncTarget } from "../core/syncTarget";
import { logFailure, logStep, showLog, useLogFile } from "../core/logger";
import type { GitSyncMonitorLike } from "./gitSyncStub";

/**
 * 機械を行き来しても原稿が食い違わないようにする（設計書6.15.1）。
 *
 * 作者の指示（2026-09-21）——
 *
 * > 開くときと閉じたときで、動きがあれば同期、あとは保存ボタン
 * > （ファイル保存と同期）を作りましょう。
 * > あとは通信や電池が切れて版がズレた時等の対応もあると嬉しいです
 *
 * ここが持つのは3つ。
 *
 * 1. **開いたときの点検**（`runStartupHandoff`）
 * 2. **保存ボタン**（`saveAndSyncAll`。保存 → 記録 → 送信）
 * 3. **「送らずに閉じた」印**の付け外し（`refreshUnsentMark` / `noticeBeforeClose`）
 *
 * **ブラウザ版では動かない**（gitの子プロセスが要る）。呼び出し側
 * （`extension.ts`）が `canRunProcesses()` を見てから動的importする。
 */

export interface HandoffDeps {
  registry: WorkRegistry;
  /** 済んだあとに状態表示を作り直す／取り込み・送信の本体を借りる */
  monitor: GitSyncMonitorLike;
  /** 「送らずに閉じた」印の置き場（`globalState`） */
  storage: UnsentMarkStorage;
  run?: GitCommandRunner;
  /**
   * 取り込みのあいだ、設定資料の見張りを止める（設計書5.5.18）。
   * gitが書いたファイルも外部変更として拾うため
   */
  pauseSettingsWatch?: () => () => void;
}

/** 置き場1つぶんの、点検の材料 */
interface HandoffTarget {
  root: string;
  label: string;
  works: WorkEntry[];
  status: GitSyncStatus;
  pending: boolean;
}

/** 点検した結果、その置き場で起きたこと */
interface HandoffOutcome {
  label: string;
  action: HandoffAction;
  /** 実際に通ったか。止めた／できなかったものは false */
  done: boolean;
  /** 通らなかった理由（ログと知らせに出す） */
  detail?: string;
}

/**
 * VS Code を開いた時点で点検する（設計書6.15.1の①）。
 *
 * ## なぜ「本文を開いたとき」では足りないのか
 *
 * これまでの点検は `onDidChangeActiveTextEditor`（本文を開いた時点）だった。
 * **作品を開く前に取りこぼしへ気づけない**——前回、送らずに閉じていたことに
 * 気づくのは、書き始めたあとになる。
 *
 * ## 開いた瞬間に全部取りに行かない
 *
 * 作品が何十もあると、開いた瞬間に全部 fetch すると遅い。
 *
 * - **置き場（リポジトリ）ごとに1回**にする。書庫では11作品が同じ置き場に
 *   入っており、作品ごとに取りに行くと11回とも同じ結果になる
 * - **手元に送り残しのある置き場を先に見る**（`orderStartupTargets`）。
 *   取りこぼしが起きるのは、書いたのに送っていない置き場である
 * - **上限を超えたぶんは、あとに回す。** 漏れたものは本文を開いたときの
 *   点検が今までどおり拾う
 *
 * **await しない前提で呼ばれる**（起動を待たせない）。中で落ちても
 * 拡張機能の起動は止めない。
 */
export async function runStartupHandoff(deps: HandoffDeps): Promise<void> {
  // **印は、何かする前に読む。** この先の点検で付け直されるので、
  // あとから読むと「前回」かどうかが分からなくなる
  const previous = readUnsentMark(deps.storage);

  const targets = await collectTargets(deps);
  const { checked, deferred } = orderStartupTargets(targets);

  const outcomes: HandoffOutcome[] = [];
  for (const target of checked) {
    try {
      outcomes.push(await handleTarget(deps, target));
    } catch (error) {
      // **1つ落ちても、残りは点検する**（この作品の一括処理と同じ考え方）
      useLogFile(target.works[0]?.folderPath ?? target.root);
      logFailure("開いたときの点検で例外", {
        置き場: target.label,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 点検で状態が変わっているので、一覧とステータスバーを作り直す。
  // **ここでは取りに行かない**（たった今取ってきたばかりである）
  await deps.monitor.refreshAll({ fetch: false });
  await refreshUnsentMark(deps);

  await reportStartup(deps, previous, outcomes, deferred.length);
}

/** 置き場ごとにまとめる。**ここではまだネットワークに出ない** */
async function collectTargets(deps: HandoffDeps): Promise<HandoffTarget[]> {
  const works = deps.registry.list();
  const byRoot = new Map<string, HandoffTarget>();

  for (const work of works) {
    const status = await readSyncStatus(work.folderPath, deps.run);
    if (!("root" in status)) continue;
    const found = byRoot.get(status.root);
    if (found) {
      found.works.push(work);
      continue;
    }
    const ahead = status.kind === "tracked" ? status.ahead : 0;
    const dirty = "dirty" in status ? status.dirty : 0;
    byRoot.set(status.root, {
      root: status.root,
      label: buildSyncTarget(status.root, works).label,
      works: [work],
      status,
      pending: ahead > 0 || dirty > 0,
    });
  }

  return [...byRoot.values()];
}

/** 置き場1つを点検して、決まったとおりに動かす */
async function handleTarget(
  deps: HandoffDeps,
  target: HandoffTarget
): Promise<HandoffOutcome> {
  const run = deps.run ?? runGit;
  const work = target.works[0];
  useLogFile(work?.folderPath ?? target.root);

  // 取りに行く。**失敗しても止めない**——オフラインでの執筆は普通にある
  if (canFetchStatus(target.status)) {
    const fetched = await fetchRemote(target.root, deps.run);
    if (!fetched.ok) {
      logFailure("開いたときの点検でfetchに失敗", {
        置き場: target.label,
        詳細: fetched.detail ?? "（詳細なし）",
      });
    }
  }

  const status = await readSyncStatus(target.root, deps.run);
  const overlap = await readOverlap(target.root, status, run);
  const action = planHandoff({
    status,
    overlap,
    unsaved: hasUnsavedInside(target.root),
  });

  switch (action.kind) {
    case "nothing":
      return { label: target.label, action, done: true };
    case "blocked":
      return { label: target.label, action, done: false };
    case "take":
      return await takeRemote(deps, target, action);
    case "send":
      return await sendLocal(deps, target, action);
    case "fold":
      return await foldBoth(deps, target, action);
    case "ask":
      // **止めて訊く。** ここでは動かさず、報告から競合解決へ渡す
      logStep(
        `分かれていて、同じファイルが両方で変わっている（${target.label}／` +
          `${action.overlap.length}件）`
      );
      return { label: target.label, action, done: false };
  }
}

/**
 * 両側で変わったファイルの重なりを調べる。
 *
 * **調べられなかったら「重なっている」側へ倒す**（安全な側）。見落として
 * 自動で混ぜるより、余分に訊くほうがましである。
 */
async function readOverlap(
  root: string,
  status: GitSyncStatus,
  run: GitCommandRunner
): Promise<string[] | undefined> {
  if (status.kind !== "tracked") return undefined;
  if (status.ahead === 0 || status.behind === 0) return undefined;

  const sides = await changedFilesEachSide(root, status.upstream, run);
  if (!sides.ok) {
    logFailure("分かれた両側の変更を調べられなかった", { 置き場: root });
    // 中身は使わないが、**空でない**ことが「訊く」へ倒す合図になる
    return ["（調べられませんでした）"];
  }
  return overlappingChangedFiles(sides.local, sides.remote);
}

/** リモートだけ進んでいる。**黙って取る**（作者の裁定） */
async function takeRemote(
  deps: HandoffDeps,
  target: HandoffTarget,
  action: Extract<HandoffAction, { kind: "take" }>
): Promise<HandoffOutcome> {
  const resume = deps.pauseSettingsWatch?.();
  let result: Awaited<ReturnType<typeof pullFastForward>>;
  try {
    result = await pullFastForward(target.root, deps.run);
  } finally {
    resume?.();
  }

  if (result.ok) {
    logStep(`開いたときに取り込んだ（${target.label}／${action.behind}件）`);
    return { label: target.label, action, done: true };
  }
  logFailure("開いたときの取り込みに失敗", {
    置き場: target.label,
    詳細: "detail" in result.failure ? result.failure.detail : result.failure.kind,
  });
  return { label: target.label, action, done: false, detail: "取り込めませんでした" };
}

/** ローカルに溜まっている。**送る**（作者の裁定） */
async function sendLocal(
  deps: HandoffDeps,
  target: HandoffTarget,
  action: Extract<HandoffAction, { kind: "send" }>
): Promise<HandoffOutcome> {
  // **確認は挟まない**（作者の裁定「開いたときに気づき、送る」）。
  // 出ていくのは**既にコミット済みのもの**だけで、作者が「記録」を押した
  // 時点で手は離れている。書きかけ（未記録）は1文字も外へ出ない
  const result = await push(target.root, deps.run);
  if (result.ok) {
    logStep(`開いたときに送信した（${target.label}／${action.ahead}件）`);
    return { label: target.label, action, done: true };
  }
  logFailure("開いたときの送信に失敗", {
    置き場: target.label,
    詳細: result.detail ?? "（詳細なし）",
  });
  return { label: target.label, action, done: false, detail: "送信できませんでした" };
}

/** 両方に動きがあり、ファイルが重ならない。**黙って揃える**（作者の裁定） */
async function foldBoth(
  deps: HandoffDeps,
  target: HandoffTarget,
  action: Extract<HandoffAction, { kind: "fold" }>
): Promise<HandoffOutcome> {
  const status = await readSyncStatus(target.root, deps.run);
  if (status.kind !== "tracked") {
    return { label: target.label, action, done: false, detail: "状態が変わりました" };
  }

  const { foldDivergence } = await import("./resolveDivergence.js");
  const resume = deps.pauseSettingsWatch?.();
  let folded: Awaited<ReturnType<typeof foldDivergence>>;
  try {
    folded = await foldDivergence(
      { registry: deps.registry, run: deps.run },
      { root: target.root, label: target.label, upstream: status.upstream }
    );
  } finally {
    resume?.();
  }

  if (!folded.ok) {
    logFailure("開いたときに合わせられなかった", {
      置き場: target.label,
      詳細: folded.reason,
    });
    return { label: target.label, action, done: false, detail: "合わせられませんでした" };
  }

  // 合わせただけでは手元に溜まったまま。**揃えるとは、送るところまでである**
  const sent = await push(target.root, deps.run);
  if (!sent.ok) {
    logFailure("合わせたあとの送信に失敗", {
      置き場: target.label,
      詳細: sent.detail ?? "（詳細なし）",
    });
    return { label: target.label, action, done: false, detail: "合わせましたが送信できませんでした" };
  }

  logStep(
    `開いたときに合わせて送った（${target.label}／取り込み ${folded.incoming}件）`
  );
  return { label: target.label, action, done: true };
}

/**
 * 点検の結果を、**1回だけ**知らせる。
 *
 * **置き場ごとに出さない**（設計書5.5.18）。書庫では同じ問いが並び、
 * 読まずに閉じる癖がつく。
 */
async function reportStartup(
  deps: HandoffDeps,
  previous: ReturnType<typeof readUnsentMark>,
  outcomes: readonly HandoffOutcome[],
  deferred: number
): Promise<void> {
  const lines: string[] = [];
  // **前回のことを先に言う。** 閉じる前の問いは出ないことがあるので、
  // これが受け皿になる（設計書6.15.1）
  if (previous) lines.push(describeUnsentMark(previous));

  const done = outcomes.filter((one) => one.done && one.action.kind !== "nothing");
  const stopped = outcomes.filter((one) => !one.done);
  if (done.length > 0) lines.push(describeDone(done));
  for (const one of stopped) lines.push(describeStopped(one));

  if (lines.length === 0) return;
  if (deferred > 0) {
    lines.push(
      `他に ${deferred}か所は、開いたときには点検していません（作品を開いたときに確かめます）。`
    );
  }

  const needsFold = outcomes.some((one) => one.action.kind === "ask");
  const buttons = needsFold
    ? ["分かれた分を合わせる", "ログを表示"]
    : ["同期する", "ログを表示"];
  const answer = await vscode.window.showWarningMessage(
    lines.join("\n"),
    ...buttons
  );
  if (answer === "分かれた分を合わせる") {
    await vscode.commands.executeCommand("novelai.resolveDivergence");
  } else if (answer === "同期する") {
    await vscode.commands.executeCommand("novelai.saveAndSync");
  } else if (answer === "ログを表示") {
    showLog();
  }
}

/** 済んだことを1行で */
function describeDone(outcomes: readonly HandoffOutcome[]): string {
  const took = outcomes.filter((one) => one.action.kind === "take").length;
  const sent = outcomes.filter((one) => one.action.kind === "send").length;
  const folded = outcomes.filter((one) => one.action.kind === "fold").length;
  const parts: string[] = [];
  if (took > 0) parts.push(`取り込み ${took}か所`);
  if (sent > 0) parts.push(`送信 ${sent}か所`);
  if (folded > 0) parts.push(`合わせて送信 ${folded}か所`);
  return `開いたときの点検で、${parts.join("・")}を済ませました。`;
}

/** 止めたこと・できなかったことを1行で。**何をすればよいかまで書く** */
function describeStopped(outcome: HandoffOutcome): string {
  const action = outcome.action;
  if (action.kind === "ask") {
    return (
      `「${outcome.label}」は分かれていて、同じファイルが両方で変わっています` +
      `（${action.overlap.length}件）。どちらを残すかお選びください。`
    );
  }
  if (action.kind === "blocked") {
    switch (action.reason) {
      case "unmerged":
        return `「${outcome.label}」に未解決の競合が残っています。先に解決してください。`;
      case "unsaved":
        return (
          `「${outcome.label}」に保存していない原稿があるので、同期していません。` +
          "保存してから「保存して同期」をお使いください。"
        );
      case "dirty":
        return (
          `「${outcome.label}」に記録していない変更が ${action.dirty}件あります` +
          (action.behind > 0 ? `（別の環境の変更 ${action.behind}件も未取得です）` : "") +
          "。「保存して同期」で記録して送れます。"
        );
    }
  }
  return `「${outcome.label}」は最後まで通りませんでした（${outcome.detail ?? "詳細なし"}）。`;
}

/**
 * 保存ボタン（設計書6.15.1の②）。**1押しで 保存 → 記録 → 送信。**
 *
 * **既存の「GitHubと同期」との違いは、先に未保存を保存するところ**である。
 * あちらは未保存があると保存を促して止まる（設計書6.15の手順1）。
 * 作者が「送った」と言い切れる口を1つ持つために、ここだけは保存から始める。
 *
 * 記録と送信そのものは「作品をすべて同期」に任せる——**写しを2つ持つと、
 * 片方だけ直したときに手順が食い違う。**
 */
export async function saveAndSyncAll(
  deps: HandoffDeps & {
    batchFileNotices?: () => () => Promise<void>;
  }
): Promise<void> {
  // **作者が押したときだけ保存する。** 自動の経路（開いたとき・閉じる前）は
  // 保存しない（書いている途中を勝手に確定させない）
  const saved = await vscode.workspace.saveAll(false);
  if (!saved) {
    // 保存できないファイルがあっても、**送れるぶんは送る**。
    // ここで止めると「送った」と言い切れる口が無くなる
    logFailure("保存して同期：保存しきれなかったファイルがある", {});
    const go = await vscode.window.showWarningMessage(
      "保存できなかったファイルがあります。そのまま同期しますか？",
      { modal: true, detail: "保存できていない中身は、同期に含まれません。" },
      "このまま同期する"
    );
    if (go !== "このまま同期する") return;
  }

  const { syncAllWorks } = await import("./syncAllWorks.js");
  await syncAllWorks({
    registry: deps.registry,
    monitor: deps.monitor,
    run: deps.run,
    pauseSettingsWatch: deps.pauseSettingsWatch,
    batchFileNotices: deps.batchFileNotices,
  });

  await refreshUnsentMark(deps);
}

/**
 * 「送らずに閉じた」印を、いまの状態に合わせる（設計書6.15.1）。
 *
 * **付けるのは同期の処理、消すのは送信が通ったときだけ。**
 * `deactivate()` で書こうとすると、そこが待たれない以上**印まで残らない**
 * ことがある。だから**未送信を見つけた時点で先に書いておく。**
 */
export async function refreshUnsentMark(deps: HandoffDeps): Promise<void> {
  const summary = summarizeUnsent(currentEntries(deps), new Date());
  const current = readUnsentMark(deps.storage);

  if (!summary) {
    if (current) await clearUnsentMark(deps.storage);
    return;
  }
  // **中身が同じなら書かない。** 状態が変わるたびに呼ばれるので、
  // 日時だけが違う書き込みで保管庫を叩き続けないようにする
  if (
    current &&
    current.ahead === summary.ahead &&
    current.dirty === summary.dirty &&
    current.labels.join("\0") === summary.labels.join("\0")
  ) {
    return;
  }
  await writeUnsentMark(deps.storage, summary);
}

/**
 * 閉じる前の確認（設計書6.15.1の④）。
 *
 * **確実には動かない。** VS Code は `deactivate()` の非同期の完了を
 * 待ち切らないので、問いが出ないまま閉じることがある。作者はそれを承知の
 * うえで「閉じる前に問いただして」と裁定した。
 *
 * **だから、これを唯一の守りにしない。** 出なかったときの受け皿が
 * 「送らずに閉じた」印と、次に開いたときの点検である。ここでは
 *
 * 1. 印を**もう一度**書く（同期のたびに書いてあるが、閉じ際の数で上書きする）
 * 2. 問いを出す（出れば儲けもの）
 *
 * **gitは呼ばない。** 見張りが持っている控えだけを読む——閉じ際に
 * ネットワークや子プロセスを起こしても、待ってもらえない。
 */
export function noticeBeforeClose(deps: HandoffDeps): void {
  const summary = summarizeUnsent(currentEntries(deps), new Date());
  if (!summary) return;

  // 待たれない前提なので、投げっぱなしにする（await できる相手がいない）
  void writeUnsentMark(deps.storage, summary);
  void vscode.window.showWarningMessage(
    `${describeUnsentMark(summary)}このまま閉じると、別の機械からは見えません。`,
    "保存して同期"
  ).then((answer) => {
    if (answer === "保存して同期") {
      void vscode.commands.executeCommand("novelai.saveAndSync");
    }
  });
}

/** いまの控えを、置き場の名前つきで並べる */
function currentEntries(
  deps: HandoffDeps
): Array<{ label: string; status: GitSyncStatus }> {
  const works = deps.registry.list();
  const entries: Array<{ label: string; status: GitSyncStatus }> = [];
  for (const work of works) {
    const status = deps.monitor.statusFor(work.id);
    if (!status || !("root" in status)) continue;
    entries.push({ label: buildSyncTarget(status.root, works).label, status });
  }
  return entries;
}

/** 取りに行ける状態か。`features/gitSync.ts` の `canFetch` と同じ判断 */
function canFetchStatus(status: GitSyncStatus): boolean {
  return (
    status.kind === "tracked" ||
    status.kind === "no_upstream" ||
    status.kind === "detached"
  );
}

/**
 * その置き場に、保存していないエディタがあるか。
 *
 * **保存していない中身はgitから見えない。** このまま記録・送信すると
 * 「送った」はずのものが欠ける（実装ルール1）。
 */
function hasUnsavedInside(root: string): boolean {
  return vscode.workspace.textDocuments.some((document) => {
    if (!document.isDirty) return false;
    // 名前のないもの（未保存の新規タブ）は、どの置き場にも属さない
    if (document.uri.scheme !== "file") return false;
    return isPathInside(root, document.uri.fsPath);
  });
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  // 比べ方は `paths.normalizeForComparison` の1か所に任せる（2026-09-23。
  // 以前はここに同じ正規化の写しがあった）
  const parent = path.normalizeForComparison(parentPath);
  const candidate = path.normalizeForComparison(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !path.goesOutside(parent, relative);
}
