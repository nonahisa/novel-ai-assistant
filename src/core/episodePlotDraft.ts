/**
 * 単話プロットの「展開」に、plot.md の「あらすじ」のうち**その話に当たる所**を
 * 下書きとして引く（設計書6.36.2。作者の裁定 2026-09-27「単話プロットの作成に、
 * 作品全体のプロットの共通部分を生かす」）。
 *
 * **AIを使わない。** 作者が書いた行をそのまま引くだけで、言い換えも要約もしない。
 * 作者が書き換えて使う下書きであって、この話の答えではない。
 *
 * 当たる所の決め方は2つだけ：
 * - **話ごとのあらすじ**（「第3話：…」「第2〜4話：…」）→ その話を含む行
 * - **幕ごとのあらすじ**（「第一幕：…（1.5万字）」）→ 1話の字数から、その話が
 *   何字目から何字目に当たるかを出し、重なる幕の行
 *
 * **決められないときは何も入れない**（推測で入れない）。字数の無い幕が1つでも
 * 混じると、後ろの幕が何字目から始まるかが分からない。
 *
 * VS Code APIに依存しない。
 */

import { toChapterNumber } from "./chapterCitations";
import { toHalfWidthDigits } from "./episodeParser";

/** 1話の長さと、その出どころ（添え書きに出す。作者が数字を確かめられるように） */
export interface EpisodeLength {
  chars: number;
  /** 作品の目標（`goals.json` の1話あたり）か、書いた話の平均か */
  source: "goal" | "average";
}

export interface EpisodePlotDraft {
  /**
   * どこから引いたかの1行。**丸ごと括弧書きにする**——`parseEpisodePlot` は
   * そういう行を空として読むので、消さずに残しても展開の中身として数えない
   */
  note: string;
  /** 引いた行（箇条書きの形に揃えてある） */
  lines: string[];
}

/** 話数の文字（`chapterCitations.ts` と同じ範囲） */
const NUMBER = "[0-9０-９〇零一二三四五六七八九十百]+";

/**
 * 行の頭の「第N話」「第N〜M話」「第N話〜第M話」。
 *
 * **行の頭だけを見る。** 文中の「第3話で張った伏線」のような言及を、
 * その話のあらすじと取り違えないため。
 */
const EPISODE_HEAD = new RegExp(
  `^第\\s*(${NUMBER})\\s*話?\\s*(?:[〜～~\\-－ー―]\\s*第?\\s*(${NUMBER})\\s*)?話`,
  "u"
);

/**
 * 字数の書き方（「1.5万字」「15,000字」「1万5千字」「5千字」「15000文字」）。
 *
 * **範囲（「1〜1.5万字」）は読まない**——どちらの端を取るかを決められない。
 * 前に範囲の印や数字が付いているものは数えず、その幕は字数の無い幕になる。
 */
const LENGTH =
  /(?<![〜～~\-－ー0-9０-９.,，．])([0-9０-９]+(?:[,，][0-9０-９]{3})*(?:[.．][0-9０-９]+)?)\s*(?:(万)\s*(?:([0-9０-９]+)\s*千)?|(千))?\s*文?字/gu;

/** 箇条書きの印（`episodePlotDoc.ts` と同じ） */
const BULLET = /^([-*+・]|\d+[.)])\s*/u;

/** あらすじの1項目。字下げした行は前の項目に続くものとして持つ */
interface OutlineItem {
  /** 印を落とした頭の行 */
  head: string;
  /** 字下げした続きの行（元の字下げのまま） */
  rest: string[];
}

function outlineItems(outline: string): OutlineItem[] {
  const lines = outline
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => line.trim() !== "" && !/^\s*<!--.*-->\s*$/u.test(line));
  if (lines.length === 0) return [];

  // **いちばん浅い字下げを頭とみなす。** 全体を字下げして書く作者もいる
  const indentOf = (line: string) => /^\s*/u.exec(line)?.[0].length ?? 0;
  const top = Math.min(...lines.map(indentOf));

  const items: OutlineItem[] = [];
  for (const line of lines) {
    const head = line.trim().replace(BULLET, "").trim();
    if (indentOf(line) <= top || items.length === 0) {
      // 印だけの行（雛形の「- 」）は項目にしない
      if (head === "") continue;
      items.push({ head, rest: [] });
    } else {
      items[items.length - 1].rest.push(line);
    }
  }
  return items;
}

/** 頭の行が「第N話」で始まれば、その範囲 */
function episodeRangeOf(head: string): { from: number; to: number } | null {
  const matched = EPISODE_HEAD.exec(head);
  if (!matched) return null;
  const from = toChapterNumber(matched[1]);
  const to = matched[2] === undefined ? from : toChapterNumber(matched[2]);
  if (from === undefined || to === undefined || from <= 0 || to < from) {
    return null;
  }
  return { from, to };
}

/** 項目に書いた字数。**ちょうど1つ**読めたときだけ返す */
function lengthOf(item: OutlineItem): number | null {
  const text = [item.head, ...item.rest].join("\n");
  const found = [...text.matchAll(LENGTH)];
  if (found.length !== 1) return null;
  const [, rawNumber, man, senAfterMan, senOnly] = found[0];
  const value = Number(
    toHalfWidthDigits(rawNumber).replace(/[,，]/gu, "").replace(/．/gu, ".")
  );
  if (!Number.isFinite(value)) return null;
  let chars = value;
  if (man) {
    chars = value * 10000;
    if (senAfterMan) chars += Number(toHalfWidthDigits(senAfterMan)) * 1000;
  } else if (senOnly) {
    chars = value * 1000;
  }
  chars = Math.round(chars);
  return chars > 0 ? chars : null;
}

/** 引く行の形。頭は箇条書きに揃え、続きは書いたままにする */
function quote(item: OutlineItem): string[] {
  return [`- ${item.head}`, ...item.rest];
}

const formatChars = (chars: number) => chars.toLocaleString("ja-JP");

/** あらすじが話ごとに書いてあるか（1項目でも「第N話」で始まれば話ごと） */
function isPerEpisode(items: readonly OutlineItem[]): boolean {
  return items.some((item) => episodeRangeOf(item.head) !== null);
}

/**
 * 幕から引くには1話の長さが要るか。
 *
 * 長さを出すには本文の走査が要ることがあるので、**要るときだけ**呼び出し側が
 * 求める（話ごとのあらすじや、決められないあらすじでは走査しない）。
 */
export function outlineNeedsEpisodeLength(outline: string): boolean {
  const items = outlineItems(outline);
  return (
    items.length > 0 &&
    !isPerEpisode(items) &&
    items.every((item) => lengthOf(item) !== null)
  );
}

/**
 * その話に当たる所を引く。決められなければ null（何も入れない）。
 *
 * @param outline plot.md の「あらすじ」節の中身
 * @param chapter 何話か（1始まり）
 * @param length 1話の長さ。幕ごとのあらすじでだけ使う。分からなければ null
 */
export function episodePlotDraft(
  outline: string,
  chapter: number,
  length: EpisodeLength | null
): EpisodePlotDraft | null {
  if (!Number.isSafeInteger(chapter) || chapter <= 0) return null;
  const items = outlineItems(outline);
  if (items.length === 0) return null;

  if (isPerEpisode(items)) {
    const picked = items.filter((item) => {
      const range = episodeRangeOf(item.head);
      return range !== null && range.from <= chapter && chapter <= range.to;
    });
    if (picked.length === 0) return null;
    return {
      note: `（plot.md の「あらすじ」から、第${chapter}話に当たる行を引きました。書き換えて使う下書きです）`,
      lines: picked.flatMap(quote),
    };
  }

  const lengths = items.map(lengthOf);
  if (lengths.some((value) => value === null)) return null;
  if (!length || !Number.isFinite(length.chars) || length.chars <= 0) {
    return null;
  }

  // この話が何字目から何字目か（(start, end]）。話は1話から隙間なく並ぶとみなす
  const per = Math.round(length.chars);
  const start = (chapter - 1) * per;
  const end = chapter * per;

  // **境目をまたぐ話は、またいだ幕を両方引く。** どちらか片方に寄せるのは推測になる
  const picked: OutlineItem[] = [];
  let before = 0;
  items.forEach((item, index) => {
    const after = before + (lengths[index] as number);
    if (start < after && end > before) picked.push(item);
    before = after;
  });
  // あらすじの字数を書き切った先の話には、当たる幕が無い
  if (picked.length === 0) return null;

  const source = length.source === "goal" ? "作品の目標" : "書いた話の平均";
  return {
    note:
      `（plot.md の「あらすじ」から、第${chapter}話に当たる幕を引きました。` +
      `1話${formatChars(per)}字（${source}）として${formatChars(start + 1)}〜${formatChars(end)}字目です。` +
      `書き換えて使う下書きです）`,
    lines: picked.flatMap(quote),
  };
}
