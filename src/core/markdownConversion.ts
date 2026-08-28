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

/** 投稿サイトの記法の件数（`core/ruby.ts` の `countSiteNotation` の結果） */
export interface SiteNotationCounts {
  ruby: number;
  emphasis: number;
}

/**
 * 読み仮名の入った `.txt` を開いたときに、MD化を勧めるか
 * （作者の指示、2026-08-29「読み仮名を含んだファイルを開くときは、
 * 理由を添えて、投稿には問題がない旨添えてファイルのMD変換を促しましょう」）。
 *
 * **勧めるのは、勧める理由があるときだけ。**
 *
 * - `.md` は対象外（もう変換されている）
 * - 読み仮名も傍点も無い `.txt` も対象外——**変換して得になることが無い**
 *   のに声をかけると、案内そのものが読まれなくなる
 * - 「今はしない」と断られたファイルには二度と出さない
 *
 * @param declined 断られたファイルの一覧（端末に残してある）
 */
export function shouldSuggestMarkdown(
  filePath: string,
  counts: SiteNotationCounts,
  declined: readonly string[]
): boolean {
  if (!isPlainTextManuscript(filePath)) return false;
  if (counts.ruby + counts.emphasis <= 0) return false;
  const wanted = path.normalizeForComparison(filePath);
  return !declined.some(
    (entry) => path.normalizeForComparison(entry) === wanted
  );
}

/**
 * MD化を勧める文言。
 *
 * **「投稿にも問題ありません」まで言い切る。** 作者がためらうのは
 * 「投稿サイトへ出せなくなるのでは」という一点なので、そこへ先に答える。
 *
 * **「中身は1文字も変わらない」とは書かない。** 名前を変えるだけでは
 * 済まず、中のルビ・傍点は拡張機能の書き方へ揃えられる（設計書6.12.4、
 * `features/markdownConvert.ts` の `importNotation`）。変わらないのは
 * **本文の言葉**のほうで、そこを言い換えずに書くと嘘になる。
 */
export function describeMarkdownSuggestion(counts: SiteNotationCounts): string {
  const found: string[] = [];
  if (counts.ruby > 0) found.push(`読み仮名（ルビ）が${counts.ruby}件`);
  if (counts.emphasis > 0) found.push(`傍点が${counts.emphasis}件`);

  return (
    `この原稿には${found.join("と")}入っています。` +
    "Markdown（.md）にすると、この画面からルビや傍点を振り直せます。" +
    "変換で変わるのは読み仮名の書き方だけで、本文の言葉は1文字も変わりません。" +
    "投稿用のコピーはこれまでどおり投稿サイトの形（｜漢字《かんじ》）で出るので、" +
    "投稿にも問題ありません。"
  );
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
