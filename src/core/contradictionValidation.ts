import type { Chunk } from "./chunker";
import { normalizeForComparison } from "./groundedEvidence";
import {
  CONTRADICTION_CATEGORIES,
  type ContradictionCategory,
} from "../prompts/contradictionCheck";

/**
 * 矛盾検知の応答の検証（設計書6.10.1）。
 *
 * **AIの出力を信用しない。** とくに矛盾検知は、
 *
 * - **本文に無い箇所を「引用」してくる。** 照らし合わせる材料が多いほど、
 *   材料側の文をそのまま引いて「本文にこうある」と言う
 * - **設定に無いことまで矛盾にする。** 照らし合わせる相手が無ければ
 *   矛盾とは言えない
 *
 * 前者はここで弾ける（本文に実在するかを見る）。後者はプロンプトでしか
 * 抑えられないので、**確信度を残して作者に判断させる。**
 *
 * VS Code APIに依存しない。
 */

export interface ExtractedContradiction {
  line: number;
  excerpt: string;
  category: ContradictionCategory;
  settingSays: string;
  textSays: string;
  note: string;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
}

export interface AcceptedContradiction extends ExtractedContradiction {
  filePath: string;
  chunkHash: string;
}

export interface RejectedContradiction {
  raw: unknown;
  reason:
    | "shape"
    | "line_out_of_range"
    | "excerpt_not_found"
    | "unknown_category"
    | "empty_comparison"
    /** 補足に「矛盾していません」と書いてある */
    | "self_denied"
    /** 設定と本文に同じことが書いてある */
    | "not_different"
    /** 設定の側が「設定が無い」と言っている */
    | "no_setting";
}

/**
 * 「これは矛盾ではない」と自分で書いている指摘を見分ける。
 *
 * **実データで実際に返ってきた。** 出力の配列があると、モデルは
 * 何かを埋めようとする。補足に「矛盾していません」と書きながら
 * 指摘として並べてくるので、コード側で落とす。
 */
const DENIAL_PATTERN =
  /((矛盾|食い違い?)(で)?は?(あり)?(し)?(て)?(い)?(ない|ませ|なく)|一致してい(る|ます)|問題(は)?(あり)?ませ)/;

export function deniesContradiction(text: string): boolean {
  return DENIAL_PATTERN.test(text);
}

/**
 * 設定の側が、実は設定を述べていないものを見分ける。
 *
 * **実データで返ってきた。**「設定情報なし」「本文からは読み取れない」を
 * `settingSays` に書いて指摘してくる。**照らし合わせる相手が無いのだから、
 * それは矛盾ではない。**
 */
const NO_SETTING_PATTERN =
  /(設定(情報)?(は)?(が)?(特に)?(あり)?(記載)?(され)?(て)?(い)?(ない|ませ|なし)|記述(は)?(あり)?(ませ|ない)|見当たり?(ませ|ない)|読み取れ(ない|ませ)|不明|言及(は)?(され)?(て)?(い)?(ない|ませ))/;

export function lacksSetting(settingSays: string): boolean {
  return NO_SETTING_PATTERN.test(settingSays);
}

/**
 * 分類を1つに決める。
 *
 * **選択肢をそのまま写して返してくる**（`"人物|状態|時系列"`）。
 * 実データで3件すべてがこの形になり、**正しい指摘を全部捨てていた**。
 * プロンプトでも直したが、モデルは指示を無視するので両方で受ける。
 */
export function normalizeCategory(
  raw: string
): ContradictionCategory | undefined {
  const trimmed = raw.trim();
  if (CATEGORY_SET.has(trimmed)) return trimmed as ContradictionCategory;

  // 「人物|状態」「人物：一人称、口調…」のような形から、先頭の分類を拾う
  for (const candidate of CONTRADICTION_CATEGORIES) {
    if (trimmed.startsWith(candidate)) return candidate;
  }
  for (const candidate of CONTRADICTION_CATEGORIES) {
    if (trimmed.includes(candidate)) return candidate;
  }
  return undefined;
}

const LEVELS = new Set(["high", "medium", "low"]);
const CATEGORY_SET = new Set<string>(CONTRADICTION_CATEGORIES);

/**
 * 構造化出力でも前後に説明やコードフェンスが付くモデルがあるため、
 * 生のJSON、コードフェンス除去、最外の波括弧抽出の順で解析する。
 */
export function parseContradictionResult(
  text: string
): { contradictions: unknown[] } | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed) && Array.isArray(parsed.contradictions)) {
        return { contradictions: parsed.contradictions };
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

export function validateContradictions(
  raw: unknown,
  chunk: Chunk
): {
  accepted: AcceptedContradiction[];
  rejected: RejectedContradiction[];
} {
  const accepted: AcceptedContradiction[] = [];
  const rejected: RejectedContradiction[] = [];

  const list = isRecord(raw) && Array.isArray(raw.contradictions)
    ? raw.contradictions
    : [];

  const normalizedChunk = normalizeForComparison(chunk.text);
  const lineCount = chunk.text.split("\n").length;
  const firstLine = chunk.startLine + 1;
  const lastLine = chunk.startLine + lineCount;

  for (const item of list) {
    if (!isRecord(item)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }

    const excerpt = asString(item.excerpt);
    const settingSays = asString(item.settingSays);
    const textSays = asString(item.textSays);
    const category = normalizeCategory(asString(item.category));
    const line = typeof item.line === "number" ? Math.round(item.line) : NaN;

    if (!excerpt || !Number.isFinite(line)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }
    if (!category) {
      rejected.push({ raw: item, reason: "unknown_category" });
      continue;
    }
    // **「これは矛盾ではありません」と書いてある指摘を通さない。**
    // 配列があると何か埋めようとするモデルがあり、実データで
    // 補足に「矛盾していません」と書いた指摘が返ってきた
    if (deniesContradiction(`${textSays} ${asString(item.note)}`)) {
      rejected.push({ raw: item, reason: "self_denied" });
      continue;
    }
    // **設定の側が「設定が無い」と言っているものを通さない。**
    // 照らし合わせる相手が無いのだから、それは矛盾ではない
    if (lacksSetting(settingSays)) {
      rejected.push({ raw: item, reason: "no_setting" });
      continue;
    }
    // 設定と本文に同じことが書いてあれば、食い違っていない
    if (
      normalizeForComparison(settingSays) === normalizeForComparison(textSays)
    ) {
      rejected.push({ raw: item, reason: "not_different" });
      continue;
    }
    // **並べるものが片方しか無ければ、指摘として成り立たない。**
    // 「設定ではこう」だけでは、本文の何が問題なのか分からない
    if (!settingSays || !textSays) {
      rejected.push({ raw: item, reason: "empty_comparison" });
      continue;
    }
    if (line < firstLine || line > lastLine) {
      rejected.push({ raw: item, reason: "line_out_of_range" });
      continue;
    }
    // **引用が本文に実在するかを見る。** 材料側（設定やあらすじ）の文を
    // そのまま引いて「本文にこうある」と言うことがある
    if (!normalizedChunk.includes(normalizeForComparison(excerpt))) {
      rejected.push({ raw: item, reason: "excerpt_not_found" });
      continue;
    }

    accepted.push({
      line,
      excerpt,
      category: category as ContradictionCategory,
      settingSays,
      textSays,
      note: asString(item.note),
      // 読めない値は low に寄せる。**強い指摘として扱わない**
      severity: level(item.severity),
      confidence: level(item.confidence),
      filePath: chunk.filePath,
      chunkHash: chunk.hash,
    });
  }

  return { accepted, rejected };
}

/**
 * 見せる順を決める。
 *
 * **確信度の高いものを上に。** 下のほうは読まれないので、
 * 迷っている指摘を上に置くと、確かな指摘が埋もれる。
 * 同じ確信度なら重さの順、それも同じなら本文の順に並べる。
 */
export function sortContradictions(
  items: AcceptedContradiction[]
): AcceptedContradiction[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...items].sort((left, right) => {
    if (left.confidence !== right.confidence) {
      return rank[left.confidence] - rank[right.confidence];
    }
    if (left.severity !== right.severity) {
      return rank[left.severity] - rank[right.severity];
    }
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    return left.line - right.line;
  });
}

/**
 * 無視した指摘を覚えるための鍵。
 *
 * **本文の中身（チャンクのハッシュ）を含める。** 本文を書き直したら、
 * 同じ場所でも別の指摘になりうる。含めないと、直したあとの本当の矛盾まで
 * 黙って捨てることになる。
 */
export function contradictionKey(item: AcceptedContradiction): string {
  return [
    item.chunkHash,
    item.line,
    item.category,
    normalizeForComparison(item.excerpt),
  ].join("\u0000");
}

function level(raw: unknown): "high" | "medium" | "low" {
  const value = asString(raw);
  return LEVELS.has(value) ? (value as "high" | "medium" | "low") : "low";
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * 「どの値が何話で分かるか」の索引（設計書6.10.5）。
 *
 * ## なぜ鍵を1か所に集めるか
 *
 * 以前は、書く側（`checkContradictions.ts` の索引作り）と読む側
 * （`knownAtFor`）が**それぞれ**テンプレートリテラルで鍵を組み立てていた。
 * 書く側は空白区切り、読む側はNUL区切りになっており、**読みは一度も
 * 当たっていなかった**——裏取りプロンプトの「この設定が分かる話」は
 * 常に「（不明）」だった（0.22.10で修正）。
 *
 * しかも読む側の区切りが**生のNUL文字**でソースに書かれていたため、
 * grepがこのファイルをバイナリ扱いし、検索でも見つからなかった。
 * 鍵の組み立てを1つの関数にすれば、ずれること自体が起きない。
 *
 * 区切りは項目名にも値にも現れないNULにする（`characterUnify.ts` と
 * 同じ理由。エスケープで書く——生のまま置くとgit/grepが差分を見せない）。
 */
export function buildKnownAtIndex(
  people: ReadonlyArray<{ changes: readonly RecordChangeLike[] }>
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const person of people) {
    for (const change of person.changes) {
      const chapters = change.chapters.filter(Number.isFinite);
      if (chapters.length === 0) continue;
      index.set(knownAtKey(change.field, change.value), chapters);
    }
  }
  return index;
}

/** 索引を引く。見つからなければ空配列 */
export function lookupKnownAt(
  index: ReadonlyMap<string, number[]>,
  field: string,
  value: string
): number[] {
  return index.get(knownAtKey(field, value)) ?? [];
}

interface RecordChangeLike {
  field: string;
  value: string;
  chapters: number[];
}

function knownAtKey(field: string, value: string): string {
  return `${field}\u0000${value.trim()}`;
}

/**
 * 項目名が分からないとき、値だけで索引を引く。
 *
 * 裏取りの指摘（`settingSays`）には「どの項目の話か」が付いてこない。
 * 以前は "role" と決め打ちで引いており、外見や状態の指摘では
 * **当たりようがなかった**。どの項目であれ、その値が記録された話数は
 * 「いつ分かったか」の答えとして正しい。
 */
export function lookupKnownAtValue(
  index: ReadonlyMap<string, number[]>,
  value: string
): number[] {
  const suffix = `\u0000${value.trim()}`;
  for (const [key, chapters] of index) {
    if (key.endsWith(suffix)) return chapters;
  }
  return [];
}
