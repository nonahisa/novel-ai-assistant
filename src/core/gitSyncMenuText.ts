import type { DivergenceConflicts, GitSyncStatus } from "./git";

/**
 * 「GitHubと同期」を押したときの一覧の文（設計書5.5.18。作者の裁定 2026-10-13 夜「案A」）。
 *
 * 作者の指摘：一覧に開発の言葉（main・分かれています・衝突・退避の枝・未コミット・
 * リモート／ローカル）が出る。**何が起きるかを、このPCと GitHub の言葉で言う。**
 *
 * 画面の部品（vscode）に依らない形にしてある——文が作者の選んだとおりか、
 * 開発の言葉が出ていないかを、機械で確かめられるようにするため。
 * 件数の数え方は、これまでの状態の文（`describeStatus`・`divergenceLine`）と同じ。
 *
 * 初めての人へ出す準備の項目（「Gitで管理を始める」など。`gitOnboarding.ts`）は、
 * この見直しの外に置いた（別の場面の文で、作者の裁定の対象ではない）。
 */

/** 一覧の1行が何をするか */
export type GitSyncMenuAction =
  | "saveAndSync"
  | "commit"
  | "pull"
  | "push"
  | "refresh"
  | "log";

export interface GitSyncMenuEntry {
  label: string;
  description: string;
  detail: string;
  action: GitSyncMenuAction;
}

/** 一覧の題 */
export function gitSyncMenuTitle(workTitle: string): string {
  return `${workTitle} を GitHub とそろえる`;
}

/**
 * いまの状態を1文で（一覧の入力欄の薄い字と、「読み直す」の知らせに出す）。
 *
 * 文は「。」でつなぎ、最後には付けない（作者の裁定の文の形に合わせる）。
 */
export function describeSyncMenuStatus(status: GitSyncStatus): string {
  switch (status.kind) {
    case "git_missing":
      return "このパソコンに Git が入っていないため、GitHub とそろえられません";
    case "not_a_repo":
      return "この作品は、まだ履歴を残す準備をしていません";
    case "no_remote":
      return "送り先（GitHub）がまだ決まっていません";
    case "detached":
      // 作者が自分でこの形にすることはまず無い。何をすればよいかは記録を見て決める
      return "いまは過去の版を開いているため、そろえられません";
    case "no_upstream":
      return "この作品は、まだ一度も GitHub へ送っていません";
    case "failed":
      return "GitHub とそろっているかを確かめられませんでした";
    case "tracked": {
      const parts: string[] = [];
      if (status.behind > 0 && status.ahead > 0) {
        // **両方にあるときは、そう書く**（設計書5.5.18）。どちらか片方の数だけでは、
        // 合わせる作業が要ることが読み取れなかった（作者の指摘、2026-09-10）
        parts.push(
          "このPCと GitHub の両方で書き換えがあります" +
            `（GitHub から来る分 ${status.behind}件・このPCから送る分 ${status.ahead}件）`
        );
        parts.push(describeSamePlace(status.conflicts));
      } else if (status.behind > 0) {
        parts.push(`GitHub に、このPCへまだ来ていない書き換えが ${status.behind}件あります`);
      } else if (status.ahead > 0) {
        parts.push(`このPCに、GitHub へまだ送っていない書き換えが ${status.ahead}件あります`);
      }
      if (status.unmerged > 0) {
        parts.push(`どちらの文を残すか決まっていない原稿が ${status.unmerged}件あります`);
      }
      // **履歴に残していない書き換えも出す**（設計書6.15.1）。残しも送りもしていない
      // 原稿は、もう1台からは無いのと同じである
      if (status.dirty > 0) {
        parts.push(`履歴に残していない書き換えが ${status.dirty}件あります`);
      }
      if (parts.length === 0) return "このPCと GitHub の原稿はそろっています";
      return parts.join("。");
    }
  }
}

/**
 * 同じ所を両方で直したものの数。**調べられなかったことは、そう書く**
 * （古い git では数えられない。0件と嘘をつかない）。
 */
function describeSamePlace(conflicts: DivergenceConflicts | undefined): string {
  if (!conflicts) return "同じ所を両方で直した話があるかは、調べられませんでした";
  const manuscripts = conflicts.manuscripts.length;
  const settings = conflicts.settings.length;
  if (manuscripts === 0 && settings === 0) {
    return "同じ所を両方で直した話はありません（そのまま合わせられます）";
  }
  if (settings === 0) return `同じ所を両方で直した話が ${manuscripts} つあります`;
  if (manuscripts === 0) return `同じ所を両方で直した設定資料が ${settings} つあります`;
  return `同じ所を両方で直した話が ${manuscripts} つ、設定資料が ${settings} つあります`;
}

/**
 * 一覧の項目（準備の項目と「取りやめる」は呼び出し側が足す）。
 *
 * 並びはこれまでと同じ：送れるなら「保存してそろえる」を先頭（2026-10-10）→
 * 履歴に残す → 合わせる／受け取る → 送る → 読み直す → 記録を見る。
 *
 * - `canSaveAndSync`：保存してそろえる を出してよいか（`gitSyncStatusText.ts`）
 * - `canRecord`：履歴に残す を出してよいか（`gitOnboarding.ts`）
 */
export function buildGitSyncMenuEntries(
  status: GitSyncStatus,
  allowed: { canSaveAndSync: boolean; canRecord: boolean }
): GitSyncMenuEntry[] {
  const entries: GitSyncMenuEntry[] = [];

  if (allowed.canSaveAndSync && status.kind === "tracked") {
    entries.push({
      label: "$(cloud-upload) 保存してそろえる（ほかの作品もまとめて）",
      description: [
        status.dirty > 0 ? `履歴に残す分 ${status.dirty}件` : undefined,
        status.ahead > 0 ? `送る分 ${status.ahead}件` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join("・"),
      detail:
        "開いている原稿を保存して履歴に残し、GitHub へ送ります。" +
        "同じ場所にあるほかの作品もまとめてそろえます（送る前に1回だけ確かめます）。",
      action: "saveAndSync",
    });
  }

  if (allowed.canRecord) {
    const pending = status.kind === "tracked" ? status.dirty : undefined;
    entries.push({
      label: "$(save) いまの原稿を履歴に残す（送らない）",
      description: pending !== undefined && pending > 0 ? `${pending}件の書き換え` : "",
      detail:
        "残しておくと、書き直す前の原稿へ戻せます。GitHub へは送りません。",
      action: "commit",
    });
  }

  if (status.kind === "tracked") {
    if (status.behind > 0 && status.ahead > 0) {
      // **押せば合わせにいく**（設計書5.5.18）。説明は作者の裁定の文のまま、
      // 見出しの行（説明）と下の行（詳しく）に分けて置く。1行に入れると幅で切れる
      entries.push({
        label: "$(git-merge) 両方の書き換えを合わせる",
        description: "GitHub の書き換えをこのPCへ持ってきて合わせます。",
        detail:
          "同じ所を直した話は、どちらを残すか選べます。" +
          "合わせる前の状態は控えておくので、あとで戻せます。",
        action: "pull",
      });
    } else if (status.behind > 0) {
      entries.push({
        label: "$(cloud-download) GitHub の書き換えを受け取る",
        description: `GitHub から来る分 ${status.behind}件`,
        // 書きかけの原稿を守るため（取り込みは早送りできるときだけ。設計書5.5.1）
        detail: "履歴に残していない書き換えがあると、受け取りません。",
        action: "pull",
      });
    }
    if (status.ahead > 0) {
      entries.push({
        label: "$(cloud-upload) このPCの書き換えだけ送る",
        description: `このPCから送る分 ${status.ahead}件`,
        detail: "GitHub へ送ります。送る前に件数を確かめます。",
        action: "push",
      });
    }
  }

  entries.push({
    label: "$(sync) GitHub の様子を読み直す（原稿は変えない）",
    description: "",
    detail: "GitHub の様子を取りに行き、いまの状態を知らせます。",
    action: "refresh",
  });
  entries.push({
    label: "$(output) 記録を見る",
    description: "",
    detail: "そろえるのに失敗した理由は、ここに残しています。",
    action: "log",
  });
  return entries;
}
