import {
  groupByTimepoint,
  type ChronicleRow,
  type ChronicleSection,
} from "./chronicle";

/**
 * 年表をMarkdownに組み立てる（設計書6.39.4）。
 *
 * 画面は絞り込みや折りたたみで「いま見たいところ」を出すが、書き出しは
 * **そのとき見えている形をそのまま**残すためのものである。段（本編／IF・
 * 夢・劇中劇／時期未設定）と時期の見出しを立て、話を表で並べる。
 *
 * `foreshadowMarkdown.ts` と同じく、VS Code APIに依らない純粋関数にして
 * ある（試験しやすくするため）。
 */

export const CHRONICLE_TITLE = "年表";

/** 表の列。**画面の列と同じ並び**にする（見比べるものなので） */
const COLUMNS = ["話数", "題", "登場", "出来事", "あらすじ"] as const;

/**
 * まだ何も無いときに出す1枚。
 *
 * **黙って空の表を出さない。** 何も出ないと、作者は「壊れている」のか
 * 「まだ書いていない」のか見分けられない（伏線の一覧と同じ判断）。
 */
export function buildEmptyChronicleGuide(): string {
  return [
    `# ${CHRONICLE_TITLE}`,
    "",
    "並べる話がありません。",
    "作品に本文ファイルを入れてから、もう一度開いてください。",
    "",
  ].join("\n");
}

export interface ChronicleMarkdownOptions {
  /** 作品名。見出しに添える */
  workTitle?: string;
  /** どちらの並びを書き出したか。読み返したときに分かるようにする */
  order?: "chapter" | "timeline";
}

export function chronicleToMarkdown(
  sections: readonly ChronicleSection[],
  options: ChronicleMarkdownOptions = {}
): string {
  const rows = sections.reduce((sum, section) => sum + section.rows.length, 0);
  if (rows === 0) return buildEmptyChronicleGuide();

  const heading = options.workTitle
    ? `# ${CHRONICLE_TITLE}（${options.workTitle}）`
    : `# ${CHRONICLE_TITLE}`;
  const lines: string[] = [heading, ""];
  if (options.order) {
    lines.push(
      options.order === "timeline" ? "並び：時系列順" : "並び：話数順",
      ""
    );
  }

  for (const section of sections) {
    // **段の見出しは、行が1つでも必ず出す。** IF編の話を本編と
    // 見分けられなくなるのが、いちばん困る（設計書6.39.5）
    lines.push(`## ${section.label}`, "");
    for (const group of groupByTimepoint(section.rows)) {
      if (group.label) lines.push(`### ${group.label}`, "");
      lines.push(...table(group.rows), "");
    }
  }

  return lines.join("\n");
}

function table(rows: readonly ChronicleRow[]): string[] {
  const lines = [
    `| ${COLUMNS.join(" | ")} |`,
    `|${COLUMNS.map(() => "---").join("|")}|`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${[
        cell(row.chapterLabel),
        cell(row.title ?? ""),
        cell(row.appeared.map((entry) => entry.name).join("、")),
        cell(row.events.map((event) => event.text).join("／")),
        cell(row.synopsis ?? ""),
      ].join(" | ")} |`
    );
  }
  return lines;
}

/**
 * 表のます目に入れられる形にする。
 *
 * **改行と `|` を落とす。** あらすじは複数行のことがあり、そのまま
 * 入れると表がその行で崩れる。中身は消さず、1行に畳んで残す。
 */
function cell(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .split("|")
    .join("｜")
    .trim();
}
