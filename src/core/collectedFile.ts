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
 * 合本ファイルを話ごとに分ける。
 *
 * 区切り行が1つも無ければ合本ではないので null を返す。
 * 呼び出し側は、これまでどおり1ファイル＝1話として扱えばよい。
 */
export function parseCollectedFile(rawText: string): CollectedEpisode[] | null {
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");

  const starts: Array<{ line: number; order: number }> = [];
  lines.forEach((line, index) => {
    const m = SEPARATOR.exec(line.trim());
    if (m) starts.push({ line: index, order: parseInt(m[1], 10) });
  });
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
    const m = /^【([^】]+)】\s*$/.exec(line.trim());
    const found = m ? normalizeLabel(m[1]) : null;
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

/** ダウンロードツールが付ける見出しかどうか */
function isKnownLabel(label: string): boolean {
  if (BODY_LABELS.some((l) => label.startsWith(l))) return true;
  if (/^第\d+章$/.test(label)) return true;
  return ["エピソードタイトル", "前書き", "後書き", "リアクション"].includes(
    label
  );
}

/** 「本文（69行）」→「本文」 */
function normalizeLabel(label: string): string {
  return label.replace(/[（(].*?[）)]\s*$/, "").trim();
}

function bodyLabelIn(blocks: Map<string, string>): string {
  for (const label of blocks.keys()) {
    if (BODY_LABELS.some((l) => label.startsWith(l))) return label;
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
