import * as path from "./paths";
import type { WorkEntry } from "../models/types";

/**
 * 別々に置かれている作品を、1つの書庫へまとめ直す（設計書5.7.10）。
 *
 * 作者の指示（2026-08-22）：「ひとつへまとめなおす道を作ってください」。
 *
 * ## 原本は消さない
 *
 * **移すのではなく、写す。** 元のフォルダーはそのまま残し、作者が中身を
 * 見比べて納得してから自分で消せるようにする。**原稿を動かす操作で、
 * こちらが後戻りできない形にしてはいけない**（設計書5.4）。
 *
 * ## 上書きは、絶対にしない
 *
 * 書き込み先に同じ名前のフォルダーがあれば、その作品は**移さずに理由を返す。**
 * 名前が同じというだけで中身が同じとは限らない。**押し流す危険のあるものは、
 * 機械が決めない。**
 *
 * ここは「どれをどこへ移せるか」を決めるだけで、ファイルには触らない。
 * VS Code APIにもNodeにも依存しないので、機械で見張れる。
 */

export interface MergePlan {
  work: WorkEntry;
  /** 写した先になるフォルダー */
  destination: string;
  /** 書庫の直下に付ける名前 */
  folderName: string;
  /** 移せない理由。あれば実行しない */
  blocked?: string;
}

/**
 * 何をどこへ写すかを決める。
 *
 * @param takenNames 書庫の直下にすでにある名前（比較用に正規化済み）
 */
export function planMerge(
  works: readonly WorkEntry[],
  libraryFolder: string,
  takenNames: ReadonlySet<string>
): MergePlan[] {
  const library = path.normalizeForComparison(libraryFolder);
  // 同じ回の中で名前がぶつかることもある（別の場所に同名の作品がある）
  const claimed = new Set<string>();

  return works.map((work) => {
    const folderName = path.basename(work.folderPath);
    const destination = path.join(libraryFolder, folderName);
    const key = path.normalizeForComparison(folderName);
    const source = path.normalizeForComparison(work.folderPath);

    const plan: MergePlan = { work, destination, folderName };

    if (source === library) {
      plan.blocked = "この作品そのものを書庫に選んでいます";
      return plan;
    }
    if (isInside(library, source)) {
      plan.blocked = "すでにこの書庫の中にあります";
      return plan;
    }
    if (isInside(source, library)) {
      // 自分の中へ自分を写すと、際限なく入れ子になる
      plan.blocked = "書庫がこの作品の中にあります";
      return plan;
    }
    if (takenNames.has(key)) {
      plan.blocked = `書庫に同じ名前のフォルダーがあります（${folderName}）`;
      return plan;
    }
    if (claimed.has(key)) {
      plan.blocked = `同じ名前の作品が他にもあります（${folderName}）`;
      return plan;
    }

    claimed.add(key);
    return plan;
  });
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !path.goesOutside(parent, relative);
}

/** 写さないもの。再び作れるものと、リポジトリそのもの */
export const SKIPPED_ENTRIES = [
  // **`.git` を写すとリポジトリが入れ子になる。** 書庫の側から見えなくなり、
  // 同期しても中身が出ていかない
  ".git",
  ".novelai-recovery",
  "node_modules",
] as const;

/**
 * 写さないもののうち、`.aiwriter` の中にあるもの。
 *
 * **設定ファイル（`config.json`）は写す。** これが無いと作品として
 * 認識されない。キャッシュと記録は再び作れるので置いていく。
 */
export const SKIPPED_AIWRITER_ENTRIES = ["cache", "logs"] as const;

export function shouldSkip(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/).filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  if ((SKIPPED_ENTRIES as readonly string[]).includes(parts[0])) return true;
  if (
    parts[0] === ".aiwriter" &&
    parts.length > 1 &&
    (SKIPPED_AIWRITER_ENTRIES as readonly string[]).includes(parts[1])
  ) {
    return true;
  }
  return false;
}

/**
 * 実行前に、履歴を引き継がないことを伝える文（設計書5.7.10）。
 *
 * **履歴を持つ作品があるときだけ言う。** Gitを使わずに書いている作品に
 * 「履歴は残ります」と言っても、読ませるだけ無駄である。
 *
 * 画面の文言をここへ置いたのは、**見張れるようにするため。** これは
 * 「言ったか言わなかったか」が後で効いてくる類の説明で、画面の中に
 * 埋めておくと、書き換えたときに落ちても誰も気づかない。
 */
export function describeHistoryNotCarried(
  titlesWithHistory: readonly string[]
): string[] {
  if (titlesWithHistory.length === 0) return [];
  return [
    "",
    `書き換えの記録（履歴）は写りません。${titlesWithHistory.join("・")} の記録は`,
    "元のフォルダーに残り、新しい書庫ではまとめた時点からの記録が始まります。",
    "過去の版が要るときは、元のフォルダーを開いてください。",
  ];
}

/**
 * 実行後、元のフォルダーの扱いを伝える文（設計書5.7.10）。
 *
 * **「消してよい」と言う前に、消すと何を失うかを言う。** 履歴は写して
 * いないので、元を消すと**書き換えの記録がまるごと失われる。** そこを
 * 黙って「ご自身で消してください」とだけ書くのは、取り返しのつかない
 * 操作へ背中を押すことになる。
 */
export function describeOriginalsNote(
  titlesWithHistory: readonly string[]
): string[] {
  if (titlesWithHistory.length === 0) {
    return [
      "元のフォルダーはそのまま残っています。中身を見比べて納得できたら、",
      "ご自身で消してください（作品一覧からは外れています）。",
    ];
  }
  return [
    "元のフォルダーはそのまま残っています（作品一覧からは外れています）。",
    "",
    `消す前にご注意ください。${titlesWithHistory.join("・")} は書き換えの記録（履歴）を`,
    "持っていますが、それは写していません。元のフォルダーを消すと、",
    "過去の版に戻せなくなります。",
  ];
}

/** 作者に見せる要約 */
export function describeMergePlans(plans: readonly MergePlan[]): string {
  const movable = plans.filter((plan) => !plan.blocked);
  const blocked = plans.filter((plan) => plan.blocked);

  const lines: string[] = [];
  if (movable.length > 0) {
    lines.push(`まとめる作品（${movable.length}件）`);
    for (const plan of movable) {
      lines.push(`　${plan.work.title} → ${plan.folderName}`);
    }
  }
  if (blocked.length > 0) {
    lines.push("");
    lines.push(`まとめられない作品（${blocked.length}件）`);
    for (const plan of blocked) {
      lines.push(`　${plan.work.title}：${plan.blocked}`);
    }
  }
  return lines.join("\n");
}
