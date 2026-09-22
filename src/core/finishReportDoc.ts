/**
 * 「新作をひと通り仕上げる」の、結果の1枚（Markdown）。
 *
 * ## なぜ `finishNewWork.ts` から分けるか
 *
 * **この作品では、画面に出す文言へMarkdownの記号を混ぜてはいけない**
 * （`test/unit/plainTextUi.test.ts`）。VS Code のダイアログと選択肢の説明は
 * プレーンテキストなので、`**強調**` と書くと記号がそのまま画面に出る——
 * 実際に36か所でそれが起きている（2026-08-20、作者が実機で発見）。
 *
 * ところがこの操作は、**確認のダイアログ**（プレーンテキスト）と
 * **結果の紙**（Markdown）の両方を組み立てる。同じファイルに置くと、
 * そのファイルごと検査の網から外すことになり、確認の文言に `**` を
 * 足しても誰も気づかない。**紙を書くところだけを分けて外す。**
 *
 * VS Code APIに依存しない。
 */

import type { FinishRunSummary, FinishStepResult } from "./finishNewWork";

/** 結果の1枚の題（生成文書の種類名。ファイル名の前置きにもなる） */
export const FINISH_REPORT_KIND = "ひと通り仕上げました";

/**
 * 結果の1枚（Markdown）。
 *
 * **段ごとに「できた／飛ばした（理由）／失敗した」を全部書く。** 通知1行に
 * 畳むと、13段も走ったのに何ができたのか分からない——この操作は「初めて
 * 使う人に、何ができるのかを見せる」ためのものなので、**一覧できることが
 * 中身の半分**である。
 */
export function describeFinishReport(summary: FinishRunSummary): string {
  const lines: string[] = [
    `# ${FINISH_REPORT_KIND}：${summary.workTitle}`,
    "",
    "| 段 | 結果 |",
    "| --- | --- |",
  ];

  for (const step of summary.done) {
    lines.push(`| ${cell(step.label)} | ${cell(resultOf(step))} |`);
  }
  // **中止で走らせなかった段も、同じ表に並べる。** 表から消すと、
  // 走って何も出なかったのか、そもそも走っていないのかが分からない
  for (const label of summary.remaining) {
    lines.push(`| ${cell(label)} | 走らせていません（途中で中止したため） |`);
  }

  const counted = summary.done.filter(
    (step) => !step.failed && !step.skipped && step.count !== undefined
  );
  const total = counted.reduce((sum, step) => sum + (step.count ?? 0), 0);
  lines.push("", "## 溜まった指摘", "");
  if (counted.length === 0) {
    // 数える段が1つも走っていないのに「0件」と書くと、
    // 「調べたが何も無かった」と読める
    lines.push("指摘を数える段は走りませんでした。");
  } else if (total > 0) {
    lines.push(
      `合わせて ${total}件です。下段の「提案」パネルで、1件ずつ確かめてください。`
    );
  } else {
    lines.push("手を付ける指摘は残っていません。");
  }

  // 走れなかった理由は表の外にまとめる。結果の列に混ぜると、どれが成果で
  // どれが断りなのか読み分けられなくなる
  const notes = summary.done.flatMap((step) => step.notes ?? []);
  if (notes.length > 0) {
    lines.push("", "## 気づいたこと", "");
    for (const note of notes) lines.push(`- ${note}`);
  }

  lines.push(
    "",
    "---",
    "",
    "**本文は1文字も書き換えていません。** ここに並んでいるのはすべて提案です。" +
      "どれを採るかは作者が決めてください。",
    ""
  );

  return lines.join("\n");
}

/** 表の1行に入れる、その段の結果 */
function resultOf(step: FinishStepResult): string {
  if (step.skipped) {
    return step.reason ? `飛ばしました（${step.reason}）` : "飛ばしました";
  }
  // **件数は持たせない。** 結果が出ていないので、パネルに残っている数を
  // その段の成果として並べると、前の実行の残りを今回の結果と読ませる
  if (step.failed) return "失敗しました";
  if (step.count === undefined) return "できました";
  return `できました（指摘 ${step.count}件）`;
}

/**
 * 表の升目に入れる形へ直す。
 *
 * 縦棒がそのまま入ると、そこで列が増えて表が崩れる。中身は消さずに逃がす。
 */
function cell(text: string): string {
  return text.split("|").join("\\|");
}
