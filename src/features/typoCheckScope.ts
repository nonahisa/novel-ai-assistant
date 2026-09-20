import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { workPaths } from "../core/workRegistry";
import { scanWork } from "../core/scanner";
import {
  TRIAL_EPISODE_COUNT,
  changedSince,
  describeScope,
  describeScopeWithoutLastCheck,
  firstEpisodes,
  scopeKinds,
  type ScopeChoice,
  type ScopeKind,
} from "../core/typoCheckScope";
import { cancelItem } from "../views/dialogs";
import {
  confirmRun,
  pickWithMemory,
  type MemorablePick,
} from "../views/notify";
import { atomicWriteFile } from "../core/atomicWrite";
import { logStep, useLogFile } from "../core/logger";

/**
 * 検知の対象範囲（設計書6.8.7）。
 *
 * **前回の検知の時刻を覚えて、そのあとに書いた話だけを対象にできる。**
 * 「はじめの10話だけ試す」もここから選ぶ。
 *
 * ## 機能ごとに分ける（作者の指摘、2026-09-20）
 *
 * **誤字脱字の「前回」と矛盾検知の「前回」は別物である。** 1つのファイルを
 * 共有すると、誤字脱字を走らせた時刻で矛盾検知が絞られ、**まだ一度も矛盾を
 * 見ていない話が黙って対象から外れる。** 覚え（「以降はこの選択で進む」）も
 * 同じ理由で分ける——誤字脱字は差分で足りても、矛盾は全体で見たいことがある。
 *
 * 時刻は `.aiwriter/cache/` に置く。**同期しない。**
 * 「いつ検知したか」は環境ごとの話で、別のパソコンへ持っていく意味がない。
 * `cache/` は `.gitignore` で除かれている。
 */

/** 範囲を選べる検知。**足すときは下の表にも1行足す** */
export type ScopeFeature =
  | "typo"
  | "contradiction"
  | "proofread"
  | "foreshadow"
  | "deviation";

interface ScopeFeatureSpec {
  /** 時刻を控えるファイル名。**機能ごとに違う名前にする**（上の理由） */
  readonly fileName: string;
  /** 「以降はこの選択で進む」の覚えの鍵。これも機能ごとに分ける */
  readonly rememberId: string;
  /** ログと案内に出す呼び名 */
  readonly label: string;
}

/**
 * 機能ごとの置き場。
 *
 * **誤字脱字のファイル名は変えない。** 変えると、作者の手元にある
 * 「前回の検知の時刻」が無かったことになり、次の1回だけ絞り込みが
 * 出なくなる（消えても実害は小さいが、黙って消す理由も無い）。
 */
const FEATURES: Record<ScopeFeature, ScopeFeatureSpec> = {
  typo: {
    fileName: "typo_last_check.json",
    rememberId: "scope.typoCheck",
    label: "誤字脱字検知",
  },
  contradiction: {
    fileName: "contradiction_last_check.json",
    rememberId: "scope.contradictionCheck",
    label: "矛盾検知",
  },
  proofread: {
    fileName: "proofread_last_check.json",
    rememberId: "scope.proofread",
    label: "推敲",
  },
  foreshadow: {
    fileName: "foreshadow_last_check.json",
    rememberId: "scope.foreshadowCheck",
    label: "伏線の検知",
  },
  deviation: {
    fileName: "deviation_last_check.json",
    rememberId: "scope.deviationCheck",
    label: "プロット逸脱の検知",
  },
};

/** 試験と、置き場の食い違いの検査から見えるようにしておく */
export function scopeFeatureSpec(feature: ScopeFeature): ScopeFeatureSpec {
  return FEATURES[feature];
}

function filePath(work: WorkEntry, feature: ScopeFeature): string {
  return path.join(
    workPaths(work).aiwriter,
    "cache",
    FEATURES[feature].fileName
  );
}

/** 前回の検知の時刻。読めなければ undefined（＝一度も検知していない扱い） */
export async function readLastCheck(
  work: WorkEntry,
  feature: ScopeFeature
): Promise<number | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(filePath(work, feature))
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const at =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { checkedAt?: unknown }).checkedAt
        : undefined;
    return typeof at === "number" && Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 検知した時刻を記録する。
 *
 * **失敗しても呼び出し側を止めない。** 記録できないと次回に絞り込めない
 * だけで、検知そのものは終わっている。
 */
export async function recordCheck(
  work: WorkEntry,
  feature: ScopeFeature
): Promise<void> {
  const target = filePath(work, feature);
  try {
    await vscode.workspace.fs.createDirectory(
      path.toUri(path.dirname(target))
    );
    await atomicWriteFile(
      target,
      new TextEncoder().encode(
        JSON.stringify({ checkedAt: Date.now() }, null, 2) + "\n"
      )
    );
  } catch {
    // 絞り込めなくなるだけ
  }
}

/**
 * 対象範囲を決める。
 *
 * **聞く意味があるときだけ聞く。** 選べるものが「全体」しか無ければ聞かない。
 *
 * @returns 取りやめなら undefined
 */
export async function chooseScope(
  work: WorkEntry,
  feature: ScopeFeature
): Promise<ScopeChoice | undefined> {
  const lastCheckedAt = await readLastCheck(work, feature);

  let candidates: Array<{ filePath: string; modifiedAt: number | undefined }>;
  try {
    const scanned = await scanWork(work);
    candidates = await Promise.all(
      scanned.episodes.map(async (episode) => ({
        filePath: episode.filePath,
        modifiedAt: await modifiedAt(episode.filePath),
      }))
    );
  } catch {
    // 走査できないなら絞らない
    return { kind: "all" };
  }

  const changed = changedSince(candidates, lastCheckedAt);
  const kinds = scopeKinds(candidates.length, changed.length, lastCheckedAt);
  if (kinds.length <= 1) {
    // **1件も無いときは、その旨を伝えて止める。**
    // 黙って全体を見ると、作者は「差分だけのはずが全部出た」と思う
    if (
      lastCheckedAt !== undefined &&
      changed.length === 0 &&
      candidates.length > 0
    ) {
      // **モーダルで訊く**（設計書6.81 / `views/notify.ts`）。トーストに
      // ボタンを載せていたので、押す前に数秒で閉じてしまい、押したつもりの
      // 空クリックになっていた（実機確認 2026-09-06）。これは完了の知らせ
      // ではなく、走らせてよいかの**確認**なので、答えるまで待たせる
      // **文言は変えない**（作者が覚えている言葉を壊さない。
      // `notifyRouting.test.ts`）。どの検知の「前回」かだけを後ろへ添える
      const runAll = await confirmRun(
        `前回の検知のあとに書いた話はありません。（${FEATURES[feature].label}）`,
        "作品全体を見る"
      );
      return runAll ? { kind: "all" } : undefined;
    }
    return { kind: "all" };
  }

  const trial = firstEpisodes(candidates);

  // **「以降はこの選択で進む」は右上のピンで入れる**（`pickWithMemory`）。
  // 覚えるのは選び方だけで、対象のファイルは毎回数え直す
  const picked = await pickWithMemory<ScopeKind>({
    items: [
      ...kinds.map((kind) => scopePick(kind, candidates.length, changed.length)),
      // 出口を目に見える形で置く（設計書6.17.2）。**呼び出しの中に置く**
      // ——閉じる道があるかは、この呼び出しを見て判断される
      // （`quickPickCancel.test.ts`）
      cancelItem(),
    ],
    title: "どこまで見ますか",
    placeHolder:
      lastCheckedAt === undefined
        ? describeScopeWithoutLastCheck(candidates.length)
        : describeScope(candidates.length, changed.length),
    remember: { id: FEATURES[feature].rememberId },
  });
  if (!picked) return undefined;

  if (picked === "changed") return { kind: "changed", filePaths: changed };
  if (picked === "first") return { kind: "first", filePaths: trial };
  return { kind: "all" };
}

/** 1行ぶんの選択肢。**どれだけ減るのかを数で示す** */
function scopePick(
  kind: ScopeKind,
  total: number,
  changed: number
): MemorablePick<ScopeKind> {
  if (kind === "changed") {
    return {
      label: `$(diff) 前回から書いた分だけ（${changed}話）`,
      detail:
        "前回の検知のあとに書いた話だけを見ます。一覧が短くなり、待ち時間も減ります。",
      // `kind` は QuickPickItem が区切り線に使う予約名。別名にする
      value: "changed",
    };
  }
  if (kind === "first") {
    return {
      label: `$(beaker) はじめの${TRIAL_EPISODE_COUNT}話だけ（試す）`,
      detail:
        "設定やモデルを変えたときに、まともな指摘が出るかを短時間で確かめます。" +
        "残りの話は対象になりません。",
      value: "first",
      // **試すための選択肢は覚えない。** 覚えると、以後すべての実行が
      // 黙って10話だけになり、見ていない話が「指摘なし」として通る
      noRemember: true,
    };
  }
  return {
    label: `$(book) 作品全体（${total}話）`,
    detail:
      "すべての話を見ます。AIは呼び直しません（変わっていない話は前の結果を使います）。",
    value: "all",
  };
}

/**
 * まとめ実行を踏まえて対象範囲を決める。
 *
 * **まとめ実行では聞かない**（設計書6.80）。量と料金の確認を1枚へまとめた
 * のに、そのあと個々の検知が選択画面を出すと、**作者はボタン1回で放置
 * できない**——まとめ実行の目的そのものが果たせなくなる。
 *
 * 飛ばすときは**「全体」を選んだことにする。** 処理済みのチャンクは
 * キャッシュが飛ばすので送る量はほとんど変わらず、逆に「書いた分だけ」を
 * 勝手に選ぶと、まだ一度も見ていない話が黙って対象から外れる。
 *
 * @returns 取りやめなら undefined（呼び出し側は検知へ進まない）
 */
export async function resolveCheckScope(
  work: WorkEntry,
  feature: ScopeFeature,
  options: { suiteConfirmed?: boolean } = {}
): Promise<ScopeChoice | undefined> {
  if (!options.suiteConfirmed) return chooseScope(work, feature);

  // **飛ばした判断はログへ残す**（確認を省略したときと同じ扱い）。
  // 残さないと、あとから「なぜ全話ぶん走ったのか」を追えない
  useLogFile(work.folderPath);
  logStep(
    `${FEATURES[feature].label}：まとめ実行のため対象は全体` +
      "（範囲は聞かず、処理済みはキャッシュで飛ばします）"
  );
  return { kind: "all" };
}

/**
 * 完了の知らせに添える、範囲の断り。
 *
 * **絞ったことを黙らない。** 指摘の件数が減るので、理由が画面に出ていないと
 * 作者には「前より減った」としか見えない。
 */
export function describeChosenScope(kind: ScopeKind): string {
  if (kind === "changed") return "（前回から書いた分）";
  if (kind === "first") return `（はじめの${TRIAL_EPISODE_COUNT}話）`;
  return "";
}

async function modifiedAt(file: string): Promise<number | undefined> {
  try {
    return (await vscode.workspace.fs.stat(path.toUri(file))).mtime;
  } catch {
    return undefined;
  }
}
