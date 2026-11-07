import type { RepositoryProbe } from "./githubCollaboration";
import { parseGithubRepoRef, type GithubRepoRef } from "./githubRepoRef";
import { EDITOR_MENU_LABELS } from "./stepDefs";

/**
 * 編集者の側で、作者の原稿を受け取れなかった理由を分ける（設計書5.7.5.4。作者の決定 2026-11-07
 * 「分けて知らせる」）。
 *
 * 作者が連携を解除する（GitHub で権利を外す）か、編集用リポジトリを消すと、編集者の環境では
 * 取りに行き（git fetch）が失敗する。以前は「受け取れませんでした（詳しくはログ）」としか言わず、
 * 編集者は回線のせいか作者の事情かを見分けられなかった。
 *
 * **原因の見分けは git の文で当てない**（実装ルール5）。git の文は版や言語の設定で変わる。
 * GitHub の API（`GET /repos/{owner}/{repo}`）の返事の番号で決める（`probeRepository`）。
 *
 * `vscode` にも `node:` にも触れない（文言を単体テストで当てるため）。
 */

/**
 * 受け取れなかった理由の見分け。
 *
 * - `revoked`＝置き場に届かない（404。作者が解除したか、置き場が無くなった見込み）
 * - `offline`＝通信そのものが失敗した
 * - `unknown`＝分からない（リポジトリは見える・鍵が取れない・401 など）。今までの文のまま
 */
export type FetchTrouble = "revoked" | "offline" | "unknown";

export function fetchTroubleOf(probe: RepositoryProbe): FetchTrouble {
  switch (probe) {
    case "notFound":
      return "revoked";
    case "network":
      return "offline";
    case "visible":
    case "unknown":
      return "unknown";
  }
}

/**
 * 送り先（origin）が github.com の https なら、その持ち主とリポジトリ名。
 *
 * **https に限る。** ssh（`git@github.com:`）の送り先は鍵の仕組みが違い、API の鍵で見えるかと
 * git が届くかが一致しない。分からないものは見分けに使わない（`unknown` のまま）。
 */
export function githubHttpsRef(originUrl: string): GithubRepoRef | undefined {
  const trimmed = originUrl.trim();
  if (!/^https:\/\/(?:[^@/]+@)?github\.com\//i.test(trimmed)) return undefined;
  return parseGithubRepoRef(trimmed.replace(/^https:\/\/[^@/]+@/i, "https://"));
}

/** 回線の知らせ（ブラウザ版の書き方と、`describeNetworkFailure` の文に揃える） */
export const OFFLINE_RECEIVE_MESSAGE =
  "ネットにつながっていないようです。つながってから、もう一度押してください。";

/** 置き場に届かないときの知らせ */
export function revokedMessage(workTitle: string): string {
  return (
    `「${workTitle}」の置き場に届きませんでした。` +
    "作者が連携を解除したか、置き場が無くなった見込みです。"
  );
}

/** 置き場に届かないときの知らせに付けるボタン（編集者メニューの同じ名前の行と同じ動き） */
export const END_WORK_BUTTON: string = EDITOR_MENU_LABELS.endWork;

/**
 * 見分けの結果から、知らせの文。`unknown` は `undefined`（呼ぶ側が今までの文を出す）
 */
export function fetchTroubleMessage(
  trouble: FetchTrouble,
  workTitle: string
): string | undefined {
  switch (trouble) {
    case "revoked":
      return revokedMessage(workTitle);
    case "offline":
      return OFFLINE_RECEIVE_MESSAGE;
    case "unknown":
      return undefined;
  }
}

/**
 * 開いたときの自動の取りに行きで、API を引く間隔（作品ごと）。
 *
 * 取りに行きは見張りのたびに走るので、失敗のたびに API を引くと処理量が増える。
 * 解除はすぐには戻らない事情なので、10分に1回見れば足りる。
 */
export const AUTO_PROBE_INTERVAL_MS = 10 * 60 * 1000;

/** 前に引いた時刻から見て、いま API を引いてよいか */
export function shouldProbeNow(
  lastProbedAt: number | undefined,
  now: number,
  interval: number = AUTO_PROBE_INTERVAL_MS
): boolean {
  return lastProbedAt === undefined || now - lastProbedAt >= interval;
}
