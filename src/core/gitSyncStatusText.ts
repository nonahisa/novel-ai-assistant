import type { DivergenceConflicts, GitSyncStatus } from "./git";
import { authoredConflictCount } from "./divergenceScan";
import { folderKeyForComparison } from "./pathText";

/**
 * 同期状態を、ツリーの右側に出す短い印にする（設計書5.5.1）。
 *
 * **`features/gitSync.ts` から切り出した。** あちらは先頭で `node:child_process`
 * を読み込む `core/git.ts` を使うため、importするだけでブラウザ向けビルドが
 * 壊れる。この関数はツリーの各行（作品一覧）を描くたびに呼ぶので、
 * ブラウザでも安全に使える形で独立させる必要があった（設計書5.8.5）。
 *
 * ここで見ているのは `GitSyncStatus` という**型**だけで、
 * gitを実際に呼ぶ処理は一切無い。
 *
 * ## 矢印をやめて、言葉と数字にした（2026-08-26）
 *
 * 作者の指摘：「未同期の作品がわかりません。横に数字をだせませんか？」
 *
 * それまでは `↓3 ↑2` の形で、**コミットの数だけ**を出していた。2つ足りなかった。
 *
 * 1. **記録していない変更が出ていなかった。** 書いたまま記録も送信もしていない
 *    作品は、印が何も付かず**同期済みに見えていた**
 * 2. **矢印が読み解けなかった。** 印は出ていたのに「どれが未同期か分からない」
 *    と言われた。**印があることと、伝わることは別である**
 *
 * 数は**その作品のぶんだけ**を出す。書庫（1つの置き場に複数の作品）では、
 * 置き場ぜんぶの数を各行に出すことになり、**全部の行に同じ数字が並ぶ**。
 * 実データで確かめたところ、11作品すべてに「送信待ち13」と出た——
 * **これでは、どの作品を送ればよいのか分からない。**
 *
 * 置き場ぜんぶの数は、ホバーの説明に回す（送るのも取り込むのも置き場が単位で、
 * **1つ送れば同じ置き場の作品はまとめて出ていく**。設計書5.7.9）。
 */
export function describeSyncBadge(
  status: GitSyncStatus | undefined
): string | undefined {
  if (!status) return undefined;

  switch (status.kind) {
    case "no_remote":
      // 送り先が無い作品。**記録だけは進められる**ので、その数は出す
      return join([pending("記録待ち", status.dirtyHere)]);
    case "no_upstream":
      // まだ一度も送っていない。件数では表せないので、そのまま書く
      return join([pending("記録待ち", status.dirtyHere), "未送信"]);
    case "tracked":
      return join([
        // **競合はここに出さない。** 作品の行には本文を読んで数えた
        // 「⚠競合 N件」が既に出ており、並べると同じことを2度言うことになる。
        // gitから見た未解決は、ホバーの説明で補う
        pending("記録待ち", status.dirtyHere),
        pending("送信待ち", status.aheadHere),
        pending("受け取り", status.behindHere),
        // **分かれていることは、行に出す**（作者の指摘、2026-09-10：
        // 「競合解決があるかないかわからない。件数が出ない」）。
        // 置き場ぜんぶの性質なので同じ置き場の作品には同じ印が並ぶが、
        // それは事実である（5.7.9と同じ扱い）
        divergenceBadge(status),
      ]);
    default:
      // gitを使っていない作品には何も出さない（設計書5.5.1）
      return undefined;
  }
}

/**
 * ホバーで読む説明。
 *
 * **一覧の印は短く、意味はここで補う。** 「記録待ち」「送信待ち」が
 * それぞれ何を指すのかは、言葉だけでは伝わりきらない。
 */
export function describeSyncTooltip(
  status: GitSyncStatus | undefined
): string[] {
  if (!status) return [];

  switch (status.kind) {
    case "not_a_repo":
      return ["- Gitで管理していません（同期しません）"];
    case "git_missing":
      return ["- gitが見つかりません"];
    case "no_remote":
      return [
        line("記録待ち", status.dirtyHere, "書いたまま、まだ履歴に残していない"),
        "- 送り先（GitHub）が未設定です",
      ].filter(isText);
    case "no_upstream":
      return [
        line("記録待ち", status.dirtyHere, "書いたまま、まだ履歴に残していない"),
        "- **まだ一度も送信していません**",
      ].filter(isText);
    case "tracked":
      return [
        status.unmerged > 0
          ? `- **未解決の競合が ${status.unmerged} 件あります**（先に解決してください）`
          : undefined,
        divergenceLine(status) ? `- ${divergenceLine(status)}` : undefined,
        line("記録待ち", status.dirtyHere, "書いたまま、まだ履歴に残していない"),
        line("送信待ち", status.aheadHere, "記録したが、まだGitHubへ出していない"),
        line(
          "受け取り",
          status.behindHere,
          "別の環境で書かれた分。まだ取り込んでいない"
        ),
        // **置き場ぜんぶの数は、ここでだけ出す。** 送信は置き場が単位で、
        // 1つ送れば同じ置き場の作品はまとめて出ていく（設計書5.7.9）
        wholeRepository(status),
        isSynced(status) ? "- GitHubと揃っています" : undefined,
      ].filter(isText);
    default:
      return [];
  }
}

/**
 * ステータスバーに出す一文を作る（設計書6.15.1）。
 *
 * **`features/gitSync.ts` の `updateStatusBar` から切り出した**（2026-09-21）。
 * あちらは `vscode.ThemeColor` や `show()`／`hide()` と混ざっていて、
 * テストで確かめられなかった。**11倍の数え違いが、ここだけ見張られていない
 * まま残っていた。**
 *
 * ## 置き場ごとに1回だけ数える
 *
 * `behind`／`ahead`／`dirty`／`unmerged` は**置き場ぜんぶの数**である
 * （設計書5.5.1）。書庫では1つのリポジトリに11作品が入るので、
 * 作品ごとに足すと**11倍になる**。置き場（`root`）で畳んでから足す。
 * 同じ守りは印の側（`unsentMark.ts` の `summarizeUnsent`）にもある。
 *
 * 渡すのは `isWarning` で絞ったもの。出すものが無ければ `undefined`
 * （＝ステータスバーを隠す）。**常に出していると、出ていること自体が
 * 普通になり、警告として働かなくなる。**
 */
export function describeSyncStatusBar(
  entries: readonly { status: GitSyncStatus }[]
): string | undefined {
  const perRoot = uniqueByRoot(entries);
  const behind = sumTracked(perRoot, (status) => status.behind);
  const ahead = sumTracked(perRoot, (status) => status.ahead);
  const dirty = sumTracked(perRoot, (status) => status.dirty);
  const unmerged = sumTracked(perRoot, (status) => status.unmerged);

  const parts: string[] = [];
  if (behind > 0) parts.push(`未取得 ${behind}`);
  if (ahead > 0) parts.push(`未送信 ${ahead}`);
  if (dirty > 0) parts.push(`未記録 ${dirty}`);
  if (unmerged > 0) parts.push(`競合 ${unmerged}`);

  if (parts.length === 0) return undefined;
  return `$(git-branch) ${parts.join(" / ")}`;
}

/**
 * 警告として出すべき状態か（`features/gitSync.ts` から移した。2026-10-05）。
 *
 * **記録していない変更も数える**（設計書6.15.1。作者の指示、2026-09-21）。
 * 記録も送信もしていない原稿は、別の機械からは存在しないのと同じなので、
 * 「送っていないもの」として同じ扱いにする。
 */
export function isWarning(status: GitSyncStatus): boolean {
  if (status.kind !== "tracked") return false;
  return (
    status.behind > 0 ||
    status.ahead > 0 ||
    status.dirty > 0 ||
    status.unmerged > 0
  );
}

/**
 * 同じ置き場の兄弟の作品の控えを、新しく読んだ置き場ぜんぶの数へ揃える
 * （設計書6.15.1。作者の報告、2026-10-05「未記録９がふえました」）。
 *
 * `dirty`・`ahead`・`behind`・`unmerged` は**置き場ぜんぶの数**なのに、
 * 控えは作品ごとに持っている。1作品だけ数え直すと、兄弟の作品には古い数が
 * 残る。ステータスバー・押したときの候補・「送らずに閉じた」印はどれも
 * 置き場ごとに**1作品の控えだけ**を見るので、古い兄弟が代表になると
 * 「git status は0件なのに未記録 9」が出る。
 *
 * **置き場ぜんぶの項目は新しい読みをそのまま使う**（どの作品から読んでも
 * 同じ値になる）。**作品のぶん（`…Here`）は作品ごとなので写さない**——
 * ただし置き場ぜんぶを超えることはありえないので、そこで頭を押さえる
 * （置き場ぜんぶが0なら、どの作品も0）。正しい値は、続けて兄弟を
 * 数え直したとき（`refreshRoot`）に入る。
 *
 * `sibling` が `fresh` と別の置き場なら、そのまま返す。
 */
export function alignToRepository(
  sibling: GitSyncStatus,
  fresh: GitSyncStatus
): GitSyncStatus {
  if (!("root" in sibling) || !("root" in fresh)) return sibling;
  if (rootKey(sibling.root) !== rootKey(fresh.root)) return sibling;
  // 兄弟の控えに作品のぶんが無い形（切り離されたHEADなど）なら0から始める。
  // 正しい値は、続く兄弟の数え直しで入る
  const dirtyHere = "dirtyHere" in sibling ? sibling.dirtyHere : 0;
  const aheadHere = sibling.kind === "tracked" ? sibling.aheadHere : 0;
  const behindHere = sibling.kind === "tracked" ? sibling.behindHere : 0;

  switch (fresh.kind) {
    case "tracked":
      // 衝突の件数（`conflicts`）も置き場ぜんぶの性質なので、新しい読みのものを使う
      return {
        ...fresh,
        dirtyHere: Math.min(dirtyHere, fresh.dirty),
        aheadHere: Math.min(aheadHere, fresh.ahead),
        behindHere: Math.min(behindHere, fresh.behind),
      };
    case "no_remote":
    case "no_upstream":
      return { ...fresh, dirtyHere: Math.min(dirtyHere, fresh.dirty) };
    case "detached":
      return { ...fresh };
  }
}

/**
 * その読みが、すでに受け取った読みより古いか（設計書6.15.1）。
 *
 * 数え直しは非同期で、**始めた順に返るとは限らない。** 記録の途中で始まった
 * 読み（まだ未記録が残っている）が、記録のあとの読み（0件）より遅れて返ると、
 * 古い数が画面を上書きする。数え直しを始めるときに通し番号を取り、
 * 同じ置き場で**それより後に始めた読みが既に受け取られていれば**捨てる。
 */
export function isStaleRead(
  lastAccepted: number | undefined,
  sequence: number
): boolean {
  return lastAccepted !== undefined && lastAccepted > sequence;
}

/**
 * 置き場の根を比べる鍵。区切りや末尾の違いで同じ置き場を割らない
 * （比べ方は `pathText.ts` の1か所に任せる。写しを作らない）
 */
export function rootKey(root: string): string {
  return folderKeyForComparison(root);
}

/** ステータスバーから押したときに出す、同期の候補（置き場1つ） */
export interface SyncTarget<W extends { title: string }> {
  /** 同期へ渡す作品（その置き場の先頭の作品。同期は置き場が単位） */
  work: W;
  /** 置き場に入っている作品ぜんぶ */
  works: W[];
  label: string;
  /** 件数。例「未記録 2・送信待ち 1」 */
  description: string;
  /** 置き場ぜんぶの状態（代表の作品の控え）。分岐・同期できるかの判定に使う */
  status: Extract<GitSyncStatus, { kind: "tracked" }>;
}

/**
 * ステータスバーから押したときの、同期の候補を作る（作者の指摘、2026-10-01）。
 *
 * 「未記録 2」を押すと全作品が並び、どれが未記録か分からなかった。
 * **手当ての要る置き場だけ**を、競合・分岐のあるものを先にして返す。
 * 数え方は `describeSyncStatusBar` と同じく**置き場ごとに1回**（書庫で11倍にしない）。
 * 手当ての要るものが無ければ空。
 */
export function listSyncTargets<W extends { title: string }>(
  entries: readonly { work: W; status: GitSyncStatus }[]
): Array<SyncTarget<W>> {
  const groups = new Map<
    string,
    { works: W[]; status: Extract<GitSyncStatus, { kind: "tracked" }> }
  >();
  for (const { work, status } of entries) {
    if (status.kind !== "tracked") continue;
    if (!needsAttention(status)) continue;
    const found = groups.get(status.root);
    if (found) found.works.push(work);
    else groups.set(status.root, { works: [work], status });
  }

  const targets = [...groups.entries()].map(([root, { works, status }]) => {
    const diverged = status.ahead > 0 && status.behind > 0;
    const parts = [
      status.unmerged > 0 ? `競合 ${status.unmerged}` : undefined,
      diverged ? "分岐" : undefined,
      status.dirty > 0 ? `未記録 ${status.dirty}` : undefined,
      status.ahead > 0 ? `送信待ち ${status.ahead}` : undefined,
      status.behind > 0 ? `取り込み待ち ${status.behind}` : undefined,
    ].filter(isText);
    const first = works[0];
    const label =
      works.length === 1
        ? first.title
        : `${basenameOf(root)}（${first.title} ほか${works.length - 1}作品）`;
    return {
      heavy: status.unmerged > 0 || diverged,
      target: {
        work: first,
        works,
        label,
        description: parts.join("・"),
        status,
      },
    };
  });

  // 同じ重さのあいだは、元の並び（登録順）を保つ。sort は安定
  return targets
    .sort((a, b) => Number(b.heavy) - Number(a.heavy))
    .map((one) => one.target);
}

/**
 * その置き場を「保存・同期」で前へ進められるか（設計書6.15.1。2026-10-10）。
 *
 * 送り先があり（`tracked`）、記録待ちか未送信がある置き場。
 * **競合の残る置き場は外す**——すべて同期（`planSyncTarget`）は競合マーカーを
 * 履歴へ入れないために飛ばすので、出しても押して何も起きない項目になる。
 * 取り込み待ちだけの置き場も外す（記録も送信も無い。取り込みは作品ごとの一覧から）。
 */
export function canSaveAndSync(status: GitSyncStatus): boolean {
  if (status.kind !== "tracked") return false;
  if (status.unmerged > 0) return false;
  return status.dirty > 0 || status.ahead > 0;
}

/** ステータスバーから押したときの一覧の1行（画面の部品に依らない形） */
export type StatusBarSyncChoice<W extends { title: string }> =
  | { kind: "divergence"; work: W; label: string; description: string }
  | { kind: "syncAll"; label: string; description: string }
  | { kind: "work"; work: W; label: string; description: string }
  | { kind: "log"; label: string; description: string };

export type StatusBarSyncMenu<W extends { title: string }> =
  /** 手当ての要る置き場が無い */
  | { kind: "nothing" }
  /** 置き場が1つだけ（分岐なし）。作品ごとの一覧へ直接進む */
  | { kind: "direct"; work: W }
  | { kind: "menu"; choices: Array<StatusBarSyncChoice<W>> };

/**
 * ステータスバーの「未送信／未記録」を押したときの一覧（設計書6.15.1）。
 *
 * 作者の報告（2026-10-10）：「一番上を選択しても同期されません。同期可能で
 * あれば、優先順位は同期が上です。また２回も選択肢が表示され冗長です」。
 * それまでは作品を選ばせてから、**その作品の置き場の状態だけ**で操作を並べて
 * いた。ステータスバーの数は置き場ぜんぶの合計なので、選んだ作品に未送信が
 * 無ければ「記録する」「状態を確認」「ログ」だけになり、送る道が無かった。
 *
 * 並び（1つの一覧にまとめ、2段にしない）：
 * 1. **分岐合流**（分かれた置き場ごと）——同期より先に合わせる必要がある
 * 2. **保存・同期（すべての作品）**——同期できる置き場が1つでもあれば
 * 3. 作品ごとの行（`listSyncTargets` の並び。押すと今までの作品ごとの一覧）
 * 4. ログを表示
 *
 * 置き場が1つだけで分かれていなければ、今までどおり作品選びを飛ばす
 * （作品ごとの一覧の先頭にも「保存・同期」が出るので、1押しで同期へ行ける）。
 */
export function buildStatusBarSyncMenu<W extends { title: string }>(
  entries: readonly { work: W; status: GitSyncStatus }[]
): StatusBarSyncMenu<W> {
  const targets = listSyncTargets(entries);
  if (targets.length === 0) return { kind: "nothing" };

  const diverged = targets.filter(
    (target) => target.status.ahead > 0 && target.status.behind > 0
  );
  if (targets.length === 1 && diverged.length === 0) {
    return { kind: "direct", work: targets[0].work };
  }

  const choices: Array<StatusBarSyncChoice<W>> = [];
  for (const target of diverged) {
    choices.push({
      kind: "divergence",
      work: target.work,
      // 何をする行かを、作者の言葉で（作者の裁定、2026-10-11。旧「分岐合流」）
      label: "2台の原稿をそろえる",
      description: `${target.label}：取り込み ${target.status.behind}件・送信 ${target.status.ahead}件`,
    });
  }

  // 数は置き場ごとに1回だけ足す（`listSyncTargets` が置き場で畳んである）
  const syncable = targets.filter((target) => canSaveAndSync(target.status));
  if (syncable.length > 0) {
    const dirty = syncable.reduce((sum, one) => sum + one.status.dirty, 0);
    const ahead = syncable.reduce((sum, one) => sum + one.status.ahead, 0);
    choices.push({
      kind: "syncAll",
      label: "保存・同期（すべての作品）",
      description: [
        dirty > 0 ? `未記録 ${dirty}` : undefined,
        ahead > 0 ? `未送信 ${ahead}` : undefined,
      ]
        .filter(isText)
        .join("・"),
    });
  }

  for (const target of targets) {
    choices.push({
      kind: "work",
      work: target.work,
      label: target.label,
      description: target.description,
    });
  }
  choices.push({ kind: "log", label: "ログを表示", description: "" });
  return { kind: "menu", choices };
}

function needsAttention(
  status: Extract<GitSyncStatus, { kind: "tracked" }>
): boolean {
  return (
    status.behind > 0 ||
    status.ahead > 0 ||
    status.dirty > 0 ||
    status.unmerged > 0
  );
}

function basenameOf(location: string): string {
  const parts = location.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? location;
}

/**
 * 同じ置き場を1回だけにする（設計書5.7.9）。
 *
 * 書庫では1つのリポジトリに11作品が入る。`ahead` などは置き場ぜんぶの数
 * なので、作品ごとに足すと11倍になる。
 */
function uniqueByRoot(
  entries: readonly { status: GitSyncStatus }[]
): Array<{ status: GitSyncStatus }> {
  const seen = new Set<string>();
  const out: Array<{ status: GitSyncStatus }> = [];
  for (const entry of entries) {
    const status = entry.status;
    if (!("root" in status)) continue;
    if (seen.has(status.root)) continue;
    seen.add(status.root);
    out.push({ status });
  }
  return out;
}

function sumTracked(
  entries: readonly { status: GitSyncStatus }[],
  pick: (status: Extract<GitSyncStatus, { kind: "tracked" }>) => number
): number {
  return entries.reduce(
    (total, { status }) =>
      status.kind === "tracked" ? total + pick(status) : total,
    0
  );
}

/**
 * 分かれていることを1行で書く（設計書5.5.18）。
 *
 * 作者の指摘（2026-09-10）：「競合解決があるかないかわからない。件数が出ない」。
 *
 * **分かれているのと、解決が要るのは別のことである。** 分かれていても
 * 同じ箇所が重なっていなければ、同期がそのまま合わせる。だから
 * **「何件ぶつかっているか」まで書かないと、身構えるべきか分からない。**
 *
 * 分かれていないときは `undefined`（何も出さない）。
 */
export function divergenceLine(
  status: GitSyncStatus | undefined
): string | undefined {
  if (!status || status.kind !== "tracked") return undefined;
  if (status.ahead === 0 || status.behind === 0) return undefined;
  return (
    `分かれています：取り込み ${status.behind}件・送信 ${status.ahead}件／` +
    describeConflictCounts(status.conflicts)
  );
}

/** 同じ箇所の衝突の件数。**調べられなかったことも、そう書く** */
export function describeConflictCounts(
  conflicts: DivergenceConflicts | undefined
): string {
  if (!conflicts) return "同じ箇所の衝突は調べられませんでした";
  const total = authoredConflictCount(conflicts);
  if (total === 0) return "同じ箇所の衝突はありません（同期で自動で合わせられます）";
  return (
    `同じ箇所の衝突 ${total}件` +
    `（設定資料 ${conflicts.settings.length}・本文 ${conflicts.manuscripts.length}）`
  );
}

/** 一覧の行に出す短い印。**衝突が無いなら「分岐」だけ** */
function divergenceBadge(status: {
  ahead: number;
  behind: number;
  conflicts?: DivergenceConflicts;
}): string | undefined {
  if (status.ahead === 0 || status.behind === 0) return undefined;
  const total = authoredConflictCount(status.conflicts);
  return total > 0 ? `分岐・要選択${total}` : "分岐";
}

/** その作品に、まだ済んでいないことがあるか。並べ替えや印の色に使う */
export function hasPendingSync(status: GitSyncStatus | undefined): boolean {
  return describeSyncBadge(status) !== undefined;
}

function isSynced(status: {
  dirtyHere: number;
  aheadHere: number;
  behindHere: number;
  unmerged: number;
}): boolean {
  return (
    status.dirtyHere === 0 &&
    status.aheadHere === 0 &&
    status.behindHere === 0 &&
    status.unmerged === 0
  );
}

/** 置き場ぜんぶの数。その作品ぶんと違うときだけ添える */
function wholeRepository(status: {
  ahead: number;
  behind: number;
  aheadHere: number;
  behindHere: number;
}): string | undefined {
  if (status.ahead === status.aheadHere && status.behind === status.behindHere) {
    return undefined;
  }
  const parts = [
    status.ahead > 0 ? `送信待ち ${status.ahead}件` : undefined,
    status.behind > 0 ? `受け取り ${status.behind}件` : undefined,
  ].filter(isText);
  if (parts.length === 0) return undefined;
  return `- 同じ置き場ぜんぶでは: ${parts.join("、")}（1つ送ると、まとめて出ていきます）`;
}

function pending(label: string, count: number): string | undefined {
  return count > 0 ? `${label}${count}` : undefined;
}

function line(label: string, count: number, note: string): string | undefined {
  return count > 0 ? `- ${label}: ${count}件（${note}）` : undefined;
}

function join(parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter(isText);
  // **全角の中黒で区切る。** 「/」は文字数の区切りに使っており、
  // 同じ行に2種類の意味で並ぶと読みにくい
  return kept.length > 0 ? kept.join("・") : undefined;
}

function isText(value: string | undefined): value is string {
  return value !== undefined;
}
