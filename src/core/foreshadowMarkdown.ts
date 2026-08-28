import type { Foreshadow, ForeshadowStatus } from "../models/foreshadow";

/**
 * 伏線の一覧をMarkdownに組み立てる（設計書6.35.5）。
 *
 * **未回収を上に置く。** 作者がこの一覧を開く目的は「まだ回収していない
 * ものを思い出すこと」であり、回収済みは確認のために残っているだけである。
 * 意図して開けたままのものは、未回収と回収済みの間に置く——回収を忘れた
 * わけではないが、作品としてはまだ閉じていない。
 *
 * VS Code APIに依らない純粋関数にしてある（テストしやすくするため）。
 */

/** 出す順。`status` の値の並びではなく、**読む順**である */
const STATUS_ORDER: readonly ForeshadowStatus[] = [
  "open",
  "intentional",
  "resolved",
];

const STATUS_HEADINGS: Record<ForeshadowStatus, string> = {
  open: "未回収",
  intentional: "意図して開けたまま",
  resolved: "回収済み",
};

/** 話数が分からないときの言い方。**推測で埋めない** */
const UNKNOWN_CHAPTER = "話数不明";

/** 一覧の見出し。空の案内と揃える（同じ画面として読めるように） */
export const FORESHADOW_LIST_TITLE = "伏線の一覧";

/**
 * まだ1件も無いときに出す1枚。
 *
 * **黙って空の一覧を出さない。** 何も出ないと、作者は「壊れている」のか
 * 「まだ登録していない」のか見分けられない（表記ゆれ検知の0件で実際に
 * 起きた）。次に何をすればよいかまで書く。
 *
 * 組み立てをここへ置くのは、**このファイルがMarkdownを書く場所**だから
 * である（`plainTextUi.test.ts` の一覧に載っている）。画面側のファイルへ
 * 記法を混ぜると、プレーンテキストの文言と見分けが付かなくなる。
 */
export function buildEmptyForeshadowGuide(): string {
  return [
    `# ${FORESHADOW_LIST_TITLE}`,
    "",
    "まだ伏線が登録されていません。",
    "矛盾検知の指摘から「伏線として登録」するか、",
    "「伏線を手で追加」で登録できます。",
    "",
  ].join("\n");
}

export function buildForeshadowMarkdown(records: Foreshadow[]): string {
  const lines: string[] = [
    `# ${FORESHADOW_LIST_TITLE}`,
    "",
    summarize(records),
    "",
  ];

  for (const status of STATUS_ORDER) {
    const group = sortForReading(
      records.filter((record) => record.status === status)
    );
    // **空の見出しは出さない。** 「回収済み（0件）」だけが並ぶ一覧は、
    // 何も無いことを3回言っているのと同じである
    if (group.length === 0) continue;

    lines.push(`## ${STATUS_HEADINGS[status]}（${group.length}件）`, "");
    for (const record of group) lines.push(...entryLines(record));
  }

  return lines.join("\n");
}

/**
 * 冒頭の要約。
 *
 * **未回収の件数は0でも出す。** 「0件」と書いてあることが、
 * 「まだ数えていない」との違いになる。
 */
function summarize(records: Foreshadow[]): string {
  const parts = [`未回収 ${countOf(records, "open")}件`];
  for (const status of ["intentional", "resolved"] as const) {
    const count = countOf(records, status);
    if (count > 0) parts.push(`${STATUS_HEADINGS[status]} ${count}件`);
  }
  return parts.join("／");
}

function countOf(records: Foreshadow[], status: ForeshadowStatus): number {
  return records.filter((record) => record.status === status).length;
}

/**
 * 話数の早い順に並べる。
 *
 * **話数不明は最後へ回す。** 先頭に来ると、順に読んでいく作者が
 * 「どこから始まる話か」を掴めないまま一覧に入ることになる。
 * 話数が同じ・どちらも不明のときは、登録した順（ID順）で安定させる。
 */
function sortForReading(records: Foreshadow[]): Foreshadow[] {
  return [...records].sort((left, right) => {
    const a = left.plantedChapter;
    const b = right.plantedChapter;
    if (a !== b) {
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    }
    return left.id.localeCompare(right.id);
  });
}

function entryLines(record: Foreshadow): string[] {
  const lines: string[] = [`### ${record.label}`, ""];

  if (record.note.trim()) lines.push(record.note.trim(), "");

  lines.push(`- ${chapterText(record.plantedChapter)}で張った`);
  if (record.plantedQuote.trim()) {
    lines.push(`  - 引用：「${record.plantedQuote.trim()}」`);
  }

  if (record.status === "resolved") {
    lines.push(`- ${chapterText(record.resolvedChapter)}で回収`);
    if (record.resolvedQuote.trim()) {
      lines.push(`  - 引用：「${record.resolvedQuote.trim()}」`);
    }
  }

  // 作者メモはAIが触らない項目。書いてあれば必ず出す
  if (record.authorNotes.trim()) {
    lines.push(`- 作者メモ：${record.authorNotes.trim()}`);
  }

  lines.push("");
  return lines;
}

function chapterText(chapter: number | null): string {
  return chapter === null ? UNKNOWN_CHAPTER : `第${chapter}話`;
}
