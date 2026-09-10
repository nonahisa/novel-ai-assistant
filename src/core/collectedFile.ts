/**
 * 1ファイルに全話が入ったダウンロードファイル（合本）を、話ごとに分ける。
 *
 * 小説家になろうのダウンロードツールは、全話を1ファイルにまとめた形を出す。
 *
 *   ------------------------- エピソード1開始 -------------------------
 *   【第1章】
 *   第一章『死の谷』
 *
 *   【エピソードタイトル】
 *   １話　転生
 *
 *   【本文】
 *   （本文）
 *
 *   【後書き】
 *   （作者のあとがき）
 *
 *   【リアクション】
 *   いいね: 19件
 *
 * これを1つの塊として扱うと、次の不都合が起きる（実データで確認）。
 *
 * - **登場話数が1つも付かない。** ファイル名から話数を取れないため、
 *   人物・能力・場所・世界観のすべてが「登場話なし」になる
 * - **後書き・リアクションを本文として数え、AIにも渡してしまう。**
 *   73万字の作品で1万字あった。作者が書いた物語ではないものが混ざる
 * - **1文字直すと全体を再処理する。** 話ごとに切れていれば、
 *   変わった話だけを送り直せる
 *
 * 区切りは機械的に読めるので、AIを使わずに分ける。
 */

/** 合本ファイルの中の1話 */
export interface CollectedEpisode {
  /** ファイル内での並び順。区切り行の「エピソードN開始」のN（1始まり） */
  order: number;
  /**
   * タイトルから読み取った話数。
   *
   * **読み取れなければ null にする。** 並び順で埋めると、
   * 「プロローグ」を第1話、実際の「1話」を第2話と数えるような
   * ずれが起きる。話数が分からないことは、間違った話数より害が小さい。
   */
  chapter: number | null;
  /** 話数を除いたサブタイトル。「１話　転生」→「転生」 */
  title: string | null;
  /** 本文だけ。前書き・後書き・リアクション・章題は含まない */
  body: string;
  /** 直前に置かれていた章題（【第1章】の値）。無ければ null */
  part: string | null;
}

/** 区切り行。「------- エピソード12開始 -------」 */
const SEPARATOR = /^-{3,}\s*エピソード\s*(\d+)\s*開始\s*-{3,}$/;

/** 【本文】【本文（69行）】のどちらも本文とみなす */
const BODY_LABELS = ["本文", "ほんぶん"];

/**
 * 改行を LF に揃えて行へ割る。
 *
 * **話へ割るのも、行番号を数えるのも同じ数え方でなければならない。**
 * 片方だけが CRLF を1行と数えると、指した行が1つずつずれる。
 */
function toLines(rawText: string): string[] {
  return rawText.replace(/\r\n?/g, "\n").split("\n");
}

/** 区切り行の位置（0始まり）と、「エピソードN開始」のN */
function findSeparators(
  lines: string[]
): Array<{ line: number; order: number }> {
  const starts: Array<{ line: number; order: number }> = [];
  lines.forEach((line, index) => {
    const m = SEPARATOR.exec(line.trim());
    if (m) starts.push({ line: index, order: parseInt(m[1], 10) });
  });
  return starts;
}

/**
 * 合本ファイルを話ごとに分ける。
 *
 * 区切り行が1つも無ければ合本ではないので null を返す。
 * 呼び出し側は、これまでどおり1ファイル＝1話として扱えばよい。
 */
export function parseCollectedFile(rawText: string): CollectedEpisode[] | null {
  const lines = toLines(rawText);

  const starts = findSeparators(lines);
  if (starts.length === 0) return null;

  const episodes: CollectedEpisode[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].line + 1;
    const to = i + 1 < starts.length ? starts[i + 1].line : lines.length;
    const blocks = splitLabeledBlocks(lines.slice(from, to));

    const body = blocks.get(bodyLabelIn(blocks)) ?? "";
    const rawTitle = firstLine(blocks.get("エピソードタイトル"));
    const parsed = parseEpisodeTitle(rawTitle);

    episodes.push({
      order: starts[i].order,
      chapter: parsed.chapter,
      title: parsed.title,
      body: body.replace(/^\n+/, "").replace(/\n+$/, ""),
      part: firstLine(blocks.get(partLabelIn(blocks))),
    });
  }

  return episodes;
}

/**
 * 話のタイトルから話数を取り出す。
 *
 * 「１話　転生」→ 1・転生／「第12話 再会」→ 12・再会。
 * 数字が無ければ話数は null にし、タイトルはそのまま残す。
 */
export function parseEpisodeTitle(raw: string | null): {
  chapter: number | null;
  title: string | null;
} {
  const text = raw?.trim();
  if (!text) return { chapter: null, title: null };

  const half = text.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  const m = /^第?\s*(\d+)\s*話[\s　:：・．.、,，\-–—]*(.*)$/.exec(half);
  if (!m) return { chapter: null, title: text };

  const rest = m[2].trim();
  return { chapter: parseInt(m[1], 10), title: rest.length > 0 ? rest : null };
}

/**
 * 行頭の【ラベル】で区切る。
 *
 * **知っているラベルでしか区切らない。** 本文には
 * 「看板には【立入禁止】と書かれていた」のような【】が出てくる。
 * どんな【】でも区切ると、そこで本文が終わったことにしてしまう。
 * 逆に「本文に入ったら以降は一切区切らない」（`metadataParser` の作り）では、
 * 後ろに続く【後書き】【リアクション】まで本文に取り込んでしまう。
 */
function splitLabeledBlocks(lines: string[]): Map<string, string> {
  const blocks = new Map<string, string>();
  let label: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (label !== null && !blocks.has(label)) {
      blocks.set(label, buffer.join("\n"));
    }
  };

  for (const line of lines) {
    const found = labelOf(line);
    if (found !== null && isKnownLabel(found)) {
      flush();
      label = found;
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();

  return blocks;
}

/** 【本文】の見出しかどうか。ラベルは `normalizeLabel` を通したもの */
function isBodyLabel(label: string): boolean {
  return BODY_LABELS.some((l) => label.startsWith(l));
}

/** ダウンロードツールが付ける見出しかどうか */
function isKnownLabel(label: string): boolean {
  if (isBodyLabel(label)) return true;
  if (/^第\d+章$/.test(label)) return true;
  return ["エピソードタイトル", "前書き", "後書き", "リアクション"].includes(
    label
  );
}

/** その行が見出し（【〜】だけの行）なら、揃えたラベル。違えば null */
function labelOf(line: string): string | null {
  const m = /^【([^】]+)】\s*$/.exec(line.trim());
  return m ? normalizeLabel(m[1]) : null;
}

/** 「本文（69行）」→「本文」 */
function normalizeLabel(label: string): string {
  return label.replace(/[（(].*?[）)]\s*$/, "").trim();
}

function bodyLabelIn(blocks: Map<string, string>): string {
  for (const label of blocks.keys()) {
    if (isBodyLabel(label)) return label;
  }
  return "本文";
}

/** 章題のラベルは「第1章」「第2章」と番号が動くので、形で探す */
function partLabelIn(blocks: Map<string, string>): string {
  for (const label of blocks.keys()) {
    if (/^第\d+章$/.test(label)) return label;
  }
  return "";
}

function firstLine(value: string | undefined): string | null {
  if (value === undefined) return null;
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/* ── 合本の中を移る（設計書6.25.5、0.45.0） ─────────────── */

/** 合本の中の1話の入口。`line` は本文の先頭行（1始まり） */
export interface CollectedEpisodeStart {
  /** 区切り行の「エピソードN開始」のN */
  order: number;
  /** 本文の先頭行（1始まり）。原稿エディタはこの行へ飛ぶ */
  line: number;
}

/**
 * 合本の中の、各話の本文の先頭行を返す（設計書6.25.5）。
 *
 * 原稿エディタの「← 前の話」「次の話 →」は、合本を開いているあいだ
 * **ファイルではなく話を切り替える**。そのための行番号だけを取り出す。
 * 本文そのものが要るなら `parseCollectedFile` を使う——区切りの読み方は
 * どちらも `findSeparators` の1か所で、写しを作らない。
 *
 * **飛び先は【本文】の次の行にする。** 区切り行の直後だと章題や
 * エピソードタイトルの見出しが画面の頭に来て、書き始める場所が見えない。
 * 見出しが無い作りのファイルもあるので、そのときは区切り行の次へ落とす。
 *
 * 区切りが2つに満たなければ**空**を返す（1話しか無いものを合本として
 * 扱うと、「次の話」がファイルの外へ出られなくなる。`isCollectedFile` が
 * 2話以上を合本と数えているのと同じ線引き）。
 */
export function collectedEpisodeStarts(
  rawText: string
): CollectedEpisodeStart[] {
  const lines = toLines(rawText);
  const starts = findSeparators(lines);
  if (starts.length < 2) return [];

  return starts.map((start, index) => {
    const to = index + 1 < starts.length ? starts[index + 1].line : lines.length;
    const bodyLabelAt = findBodyLabelLine(lines, start.line + 1, to);
    const at = bodyLabelAt === null ? start.line + 1 : bodyLabelAt + 1;
    // 1始まりへ直す。末尾が見出しで終わっていても、ファイルの外は指さない
    return { order: start.order, line: Math.min(at + 1, lines.length) };
  });
}

/** 【本文】の見出しがある行（0始まり）。無ければ null */
function findBodyLabelLine(
  lines: string[],
  from: number,
  to: number
): number | null {
  for (let index = from; index < to; index++) {
    const label = labelOf(lines[index]);
    if (label !== null && isBodyLabel(label)) return index;
  }
  return null;
}

/** 合本の中で前後の話へ移るときに、次に何をするか */
export type CollectedStep =
  /** 同じファイルの中で、この行（1始まり）へ飛ぶ */
  | { kind: "reveal"; line: number }
  /** 合本の端に来た。ファイルの前後へ出る（これまでどおりの経路） */
  | { kind: "leave" };

/**
 * 合本の中で「← 前の話」「次の話 →」を押したときの行き先を決める。
 *
 * **いま居る話は「カーソル行以下でいちばん後ろの先頭行」で決める。**
 * 話の途中から「前の話」を押したときに、いまの話の頭ではなく前の話へ
 * 行くのは作者の指定である（頭へ戻りたいときはスクロールで足りる）。
 *
 * カーソルが1話目の頭書き（区切り行と【本文】のあいだ）に居ることがある。
 * そこは1話目の中なので、**先頭行より前でも1話目とみなす**。
 *
 * @param caretLine カーソルの行（1始まり）。読めなければ0でよい——
 *   その場合は1話目の頭に居るものとして扱う
 */
export function planCollectedStep(input: {
  starts: CollectedEpisodeStart[];
  caretLine: number;
  direction: "prev" | "next";
}): CollectedStep {
  const { starts, direction } = input;
  if (starts.length < 2) return { kind: "leave" };

  const caret = input.caretLine > 0 ? input.caretLine : 1;
  let at = 0;
  for (let index = 0; index < starts.length; index++) {
    if (starts[index].line <= caret) at = index;
  }

  const target = direction === "next" ? at + 1 : at - 1;
  if (target < 0 || target >= starts.length) return { kind: "leave" };
  return { kind: "reveal", line: starts[target].line };
}
