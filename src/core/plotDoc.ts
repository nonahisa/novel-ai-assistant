/**
 * プロット（`設定/plot.md`）の項目定義・読み取り・組み立て。
 *
 * **プロットは作者の文書である。** 設定資料集（`characters.md` 等）のように
 * 全体を作り直してよいものではない。AIが逆算した内容（P-02）を書き戻すときも、
 * **作者が既に書いた項目には触れない**のが前提になる。
 *
 * 見出しの一覧をここに集めたのは、テンプレート（新規作成時）と
 * 逆算生成（`features/generatePlot.ts`）が同じ形を使うためである。
 * 2か所に書くと、片方だけ項目を足したときに読み書きが噛み合わなくなる。
 *
 * VS Code APIに依存しない。
 */

export type PlotSectionKey =
  | "title"
  | "logline"
  | "theme"
  | "motif"
  | "worldview"
  | "setting"
  | "narrativePerson"
  | "protagonistMotive"
  | "outline"
  | "mainCharacters";

export interface PlotSectionDef {
  key: PlotSectionKey;
  /** `## ` に続く見出し文字列 */
  heading: string;
  /** テンプレートに置く書き方の案内（HTMLコメント） */
  hint?: string;
  /** 箇条書きで書く項目か。テンプレートに `- ` を置く */
  list?: boolean;
}

/** この順に並べる。画面にもこの順で出る */
export const PLOT_SECTIONS: readonly PlotSectionDef[] = [
  { key: "title", heading: "タイトル" },
  {
    key: "logline",
    heading: "ログライン",
    hint: "誰が / どんな状況で / 何を目指し / 何が障害か を一文で",
  },
  { key: "theme", heading: "テーマ" },
  { key: "motif", heading: "モチーフ" },
  { key: "worldview", heading: "世界観" },
  { key: "setting", heading: "舞台" },
  {
    key: "narrativePerson",
    heading: "人称",
    hint: "一人称 / 三人称一元 / 三人称多元",
  },
  { key: "protagonistMotive", heading: "主人公の行動原理" },
  { key: "outline", heading: "あらすじ", list: true },
  { key: "mainCharacters", heading: "主要登場人物", list: true },
];

/** 見出しごとの中身。書かれていない項目は空文字 */
export type PlotSections = Record<PlotSectionKey, string>;

export function emptyPlotSections(): PlotSections {
  const sections = {} as PlotSections;
  for (const section of PLOT_SECTIONS) sections[section.key] = "";
  return sections;
}

/**
 * `plot.md` を読み取る。
 *
 * **知らない見出しや、見出しの外にある文章は落とさない。** 作者が自由に
 * 書き足した部分を読み飛ばすと、書き戻したときに消える。
 * それらは `extra` にまとめて返し、組み立て時に末尾へ戻す。
 */
export interface ParsedPlot {
  sections: PlotSections;
  /** 定義済みの見出しに当てはまらなかった部分（作者が足した節など） */
  extra: string;
}

export function parsePlotMarkdown(text: string): ParsedPlot {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const byHeading = new Map<string, PlotSectionKey>();
  for (const section of PLOT_SECTIONS) byHeading.set(section.heading, section.key);

  const sections = emptyPlotSections();
  const collected = new Map<PlotSectionKey, string[]>();
  const extra: string[] = [];

  /** 今どの節を読んでいるか。null は「定義済みの節の外」 */
  let current: PlotSectionKey | null = null;
  let insideUnknownSection = false;

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const key = byHeading.get(heading[1]);
      if (key) {
        current = key;
        insideUnknownSection = false;
        if (!collected.has(key)) collected.set(key, []);
        continue;
      }
      // 作者が足した見出しは、そのまま残す
      current = null;
      insideUnknownSection = true;
      extra.push(line);
      continue;
    }

    // 文書の題（# 作品名）は組み立て時に付け直すので落とす
    if (current === null && !insideUnknownSection && /^#\s/.test(line)) {
      continue;
    }

    if (current === null) {
      if (insideUnknownSection || line.trim()) extra.push(line);
      continue;
    }
    collected.get(current)!.push(line);
  }

  for (const [key, body] of collected) {
    sections[key] = trimBlankEdges(stripTemplateMarks(key, body)).join("\n");
  }

  return { sections, extra: trimBlankEdges(extra).join("\n") };
}

/**
 * テンプレートが自分で置いた印（案内コメントと箇条書きの空欄）を落とす。
 *
 * **落とさないと、書き戻すたびに案内が二重に積もる。** 組み立て側は
 * 案内を毎回付け直すので、前回の案内が中身として残っていると重なる。
 * 作者が自分で書いたコメントは残す（この節の案内文と一致するものだけ消す）。
 */
function stripTemplateMarks(key: PlotSectionKey, lines: string[]): string[] {
  const def = PLOT_SECTIONS.find((section) => section.key === key);
  const hintLine = def?.hint ? `<!-- ${def.hint} -->` : undefined;
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (hintLine && trimmed === hintLine) return false;
    if (def?.list && (trimmed === "-" || trimmed === "- ")) return false;
    return true;
  });
}

/**
 * その項目が「まだ書かれていない」か。
 *
 * テンプレートが置く案内（HTMLコメント）と、箇条書きの空欄（`- `）は
 * 書かれていないものとして扱う。**これを空と見なさないと、テンプレートを
 * 作っただけの作品で「すでに作者が書いている」と判断してしまい、
 * 逆算した内容を一切書き込めなくなる。**
 */
export function isBlankPlotSection(body: string): boolean {
  const meaningful = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "-" && line !== "- ");
  return meaningful.length === 0;
}

export function buildPlotMarkdown(
  workTitle: string,
  sections: PlotSections,
  options: { extra?: string; hints?: boolean } = {}
): string {
  const withHints = options.hints ?? false;
  const lines: string[] = [`# ${workTitle}`, ""];

  for (const section of PLOT_SECTIONS) {
    lines.push(`## ${section.heading}`);
    if (withHints && section.hint) lines.push(`<!-- ${section.hint} -->`);

    const body = sections[section.key]?.trim() ?? "";
    if (body) {
      lines.push(body);
    } else if (withHints && section.list) {
      lines.push("- ");
    }
    lines.push("");
  }

  const extra = options.extra?.trim();
  if (extra) lines.push(extra, "");

  return lines.join("\n");
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}
