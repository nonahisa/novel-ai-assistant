import { TermIndex, isStandaloneName, type TermEntry } from "./termIndex";

/**
 * 本文から「その用語が出てくる場面」だけを抜き出す。
 *
 * 掘り下げやチャットでは本文を根拠にしたいが、
 * 73万字の作品をそのままAIへ渡すことはできない。
 * 名前が出てくる前後だけを集めて渡す。
 *
 * 冒頭から順に詰めると序盤の場面ばかりになり、
 * 「最終話でどうなったか」を聞いても答えられない。
 * そのため作品全体から均等に間引く。
 */

export interface ExcerptSource {
  /** 「第12話」「プロローグ」など、AIに示す出典 */
  label: string;
  text: string;
  /**
   * この出典に含まれる**最後の**話数。読み取れなければ null／未設定。
   *
   * 矛盾検知が「いま調べている話より前だけを渡す」を守るために使う
   * （設計書6.74）。**最後の話数**にしてあるのは、第3〜5話をまとめた
   * ファイルを第4話へ渡すと、第5話（＝後の話）が混ざるためである。
   * 使わない機能（掘り下げ・相談）は見なくてよい。
   */
  chapter?: number | null;
  /**
   * 元のファイル。場面検索・似た場面の検出で「押すとその箇所を開く」ために
   * 持つ（設計書6.19.10）。合本は中の話も同じファイルを指す。使わない機能は
   * 見なくてよい。
   */
  filePath?: string;
}

export interface MentionExcerpt {
  label: string;
  text: string;
}

export interface ExcerptOptions {
  /** 一致箇所の前後に含める文字数の目安 */
  windowChars?: number;
  /** 抜き出す箇所の最大数 */
  maxExcerpts?: number;
  /** 全体の文字数上限。モデルの文脈長に収めるため */
  maxTotalChars?: number;
  /**
   * ほかの記録（別の人物・場所・組織・能力・世界観）の名前と別名。
   *
   * 索引に並べて入れ、その名前の中に含まれる一致を除くために使う
   * （「教皇庁」の中の「教皇」、「ルド王国」の中の「ルド」）。重なりは
   * 左から長い方が勝つ（`resolveOverlaps`）ので、長い別の名前の影に入る。
   * 自分の名前・別名と同じ字面のものは入れない（共有する呼び方で自分が消える）
   */
  otherNames?: string[];
}

/** 抜粋全体の文字数の上限。確保するコンテキスト長の計算にも使う */
export const EXCERPT_MAX_CHARS = 12000;

const DEFAULTS = {
  windowChars: 400,
  maxExcerpts: 30,
  maxTotalChars: EXCERPT_MAX_CHARS,
} as const;

interface Window {
  label: string;
  start: number;
  end: number;
}

/**
 * 用語が出てくる箇所を集める。
 *
 * 抜き出す範囲は行の切れ目に合わせる。
 * 小説は1行が短いので、行の途中で切ると発言が半分になって読めなくなる。
 */
export function collectMentionExcerpts(
  sources: ExcerptSource[],
  terms: string[],
  options: ExcerptOptions = {}
): MentionExcerpt[] {
  const windowChars = options.windowChars ?? DEFAULTS.windowChars;
  const maxExcerpts = options.maxExcerpts ?? DEFAULTS.maxExcerpts;
  const maxTotalChars = options.maxTotalChars ?? DEFAULTS.maxTotalChars;

  const entries = buildEntries(terms);
  if (entries.length === 0) return [];
  const own = new Set(entries.map((entry) => entry.text));
  const index = new TermIndex([
    ...entries,
    ...buildEntries(options.otherNames ?? [], OTHER_ID).filter(
      (entry) => !own.has(entry.text)
    ),
  ]);

  const windows: Window[] = [];
  for (const source of sources) {
    // 別の記録の名前に隠れた一致と、長いカタカナ語の一部の一致は捨てる
    // （「フォー」と「フォートラン」。`isStandaloneName`）
    const matches = index
      .find(source.text)
      .filter(
        (match) =>
          match.entry.id === MENTION_ID &&
          isStandaloneName(source.text, match.start, match.end)
      );
    if (matches.length === 0) continue;

    const half = Math.floor(windowChars / 2);
    const raw: Window[] = matches.map((match) => ({
      label: source.label,
      start: expandToLineStart(source.text, Math.max(0, match.start - half)),
      end: expandToLineEnd(
        source.text,
        Math.min(source.text.length, match.end + half)
      ),
    }));
    windows.push(...mergeOverlaps(raw));
  }

  if (windows.length === 0) return [];

  const textByLabel = new Map(sources.map((s) => [s.label, s.text]));
  const sampled = sampleEvenly(windows, maxExcerpts);
  const excerpts = sampled.map((window) => ({
    label: window.label,
    text: (textByLabel.get(window.label) ?? "")
      .slice(window.start, window.end)
      .trim(),
  }));

  return trimToBudget(excerpts, maxTotalChars);
}

/**
 * 索引に載せる用語を整える。
 *
 * 1文字の名前も落とさない。「灯」「澪」のような一字名は珍しくなく、
 * 除くとその人物だけ材料が集まらず、掘り下げが黙って無意味になる。
 * 「街灯」のような無関係の一致は混ざるが、
 * 件数と文字数の上限で抑えられるので、取りこぼすより害が小さい。
 */
const MENTION_ID = "mention";
const OTHER_ID = "other";

function buildEntries(terms: string[], id: string = MENTION_ID): TermEntry[] {
  const seen = new Set<string>();
  const entries: TermEntry[] = [];
  for (const term of terms) {
    const text = term.trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    entries.push({
      text,
      kind: "character",
      id,
      canonicalName: text,
    });
  }
  return entries;
}

function expandToLineStart(text: string, position: number): number {
  const found = text.lastIndexOf("\n", Math.max(0, position - 1));
  return found === -1 ? 0 : found + 1;
}

function expandToLineEnd(text: string, position: number): number {
  const found = text.indexOf("\n", position);
  return found === -1 ? text.length : found;
}

/** 重なった範囲・隣り合う範囲をまとめる。同じ場面を二重に渡さないため */
function mergeOverlaps(windows: Window[]): Window[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged: Window[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end) {
      last.end = Math.max(last.end, window.end);
      continue;
    }
    merged.push({ ...window });
  }
  return merged;
}

/**
 * 全体から均等に間引く。
 *
 * 先頭から詰めると序盤だけになる。最初と最後は必ず残す。
 */
export function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];
  if (limit === 1) return [items[0]];

  const step = (items.length - 1) / (limit - 1);
  const picked: T[] = [];
  for (let i = 0; i < limit; i++) {
    picked.push(items[Math.round(i * step)]);
  }
  return picked;
}

/**
 * 文字数の上限に収める。
 *
 * 後ろから削ると終盤が落ちるので、収まる件数まで減らして
 * もう一度均等に間引く。
 */
function trimToBudget(
  excerpts: MentionExcerpt[],
  maxTotalChars: number
): MentionExcerpt[] {
  const total = (list: MentionExcerpt[]) =>
    list.reduce((sum, item) => sum + item.text.length, 0);

  let current = excerpts;
  while (current.length > 1 && total(current) > maxTotalChars) {
    current = sampleEvenly(current, current.length - 1);
  }

  // 1件でも上限を超える場合は、その1件を切り詰めるしかない
  if (current.length === 1 && current[0].text.length > maxTotalChars) {
    return [
      { ...current[0], text: current[0].text.slice(0, maxTotalChars) },
    ];
  }
  return current;
}
