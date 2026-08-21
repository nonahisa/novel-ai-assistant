import * as path from "./paths";

/**
 * 本文の .txt を .md へ変える判断（設計書6.12）。
 *
 * **ルビは .md でしか使えない。** 投稿サイトからそのまま持ってきた .txt に
 * 独自記法を混ぜると、元の場所へ戻せなくなるためである。
 * そこで作者が .txt でルビを使おうとしたときに、変換を提案する。
 *
 * **中身は1文字も変えない。名前だけを変える。**
 * 文字コードも改行コードもそのまま残る。Markdownとして書き換えると
 * （見出しを付ける、空行を詰めるなど）、それは原稿の改変になる。
 *
 * VS Code APIに依存しない。
 */

export interface ConversionPlan {
  /** 変える対象 */
  from: string;
  /** 変えた後 */
  to: string;
}

export type ConversionRefusal =
  /** 本文のファイルではない */
  | "not_text"
  /** 同じ名前の .md が既にある */
  | "target_exists";

export interface ConversionDecision {
  plan?: ConversionPlan;
  refusal?: ConversionRefusal;
}

/** その名前は本文の .txt か */
export function isPlainTextManuscript(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".txt";
}

/**
 * 1件ぶんの変換を決める。
 *
 * @param existingFiles 同じフォルダーに既にある名前（拡張子込み）。
 *   **同じ名前の .md があれば変換しない。** 上書きすれば、
 *   そちらに書いてあった本文が消える。
 */
export function planConversion(
  filePath: string,
  existingFiles: string[]
): ConversionDecision {
  if (!isPlainTextManuscript(filePath)) return { refusal: "not_text" };

  const to = filePath.slice(0, -path.extname(filePath).length) + ".md";
  const targetName = path.basename(to).toLowerCase();
  if (existingFiles.some((name) => name.toLowerCase() === targetName)) {
    return { refusal: "target_exists" };
  }
  return { plan: { from: filePath, to } };
}

/**
 * フォルダーの .txt をまとめて変換する計画を立てる。
 *
 * **1つでも変換できないものがあれば、そこだけ外して残りは進める。**
 * 全部止めると、作者は何が悪いのか分からないまま先へ進めない。
 */
export function planFolderConversion(
  filePaths: string[],
  existingFiles: string[]
): { plans: ConversionPlan[]; skipped: Array<{ file: string; refusal: ConversionRefusal }> } {
  const plans: ConversionPlan[] = [];
  const skipped: Array<{ file: string; refusal: ConversionRefusal }> = [];
  // 変換で増える名前も見ていく。同じ回の中で衝突することがある
  const seen = [...existingFiles];

  for (const filePath of filePaths) {
    const decision = planConversion(filePath, seen);
    if (decision.plan) {
      plans.push(decision.plan);
      seen.push(path.basename(decision.plan.to));
    } else if (decision.refusal) {
      skipped.push({ file: filePath, refusal: decision.refusal });
    }
  }
  return { plans, skipped };
}

/** 断った理由を、作者に伝わる言葉にする */
export function describeRefusal(refusal: ConversionRefusal): string {
  switch (refusal) {
    case "not_text":
      return "本文のテキストファイル（.txt）ではありません。";
    case "target_exists":
      return "同じ名前の .md が既にあります。上書きすると、そちらの本文が消えます。";
  }
}
