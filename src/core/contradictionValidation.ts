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
 *
 * **2026-09-20 に語を足した。** 抑制をゆるめて測ったとき、唯一の
 * 余計な指摘が「暦の上では約1か月であり、**整合性は取れているが**」
 * と書いていた。**「矛盾していない」は知っていたのに、同じことを
 * 別の言い方でされると素通りしていた**（引継ぎ書8章）。
 *
 * **2026-09-24 に、疑問と理由の形を外した**（縛りの洗い出し1番）。
 * 「一致している」「整合している」は言い切りなら否定だが、
 * 「一致して**いるか**確認が必要」（疑問）や「文体が一致して**いるため**、
 * 誤記の可能性が高い」（理由）は矛盾を否定していない。答え付きの台で、
 * **仕込みの正解（第3話「僕」・第4話「右足」）がこの形で落ちていた。**
 * 「整合しているように見えるが」は外さない——実測では罠（第4話の
 * 「一か月」）に付いた余計な指摘がこの形だった。
 *
 * 同じ日に「**矛盾というより**…」を足した。自分で矛盾ではないと
 * 書いているのに、どの語にも当たらず通っていた（第1話の余計な指摘と、
 * 作者の作品の「矛盾というよりは…表現である」）。
 */
const DENIAL_PATTERN =
  /((矛盾|食い違い?)(で)?は?(あり)?(し)?(て)?(い)?(ない|ませ|なく)|矛盾というより|一致してい(る|ます)(?!の?か|ため|ので|から)|問題(は)?(あり)?ませ|整合(性)?(は|が)?(取|と)れて(いる|います)(?!の?か|ため|ので|から)|整合してい(る|ます)(?!の?か|ため|ので|から)|齟齬(は)?(あり)?(ませ|ない)|破綻(は)?(し)?(て)?(い)?(ない|ませ))/;

/**
 * 断定を避けた否定——「矛盾とは言えません」「矛盾とは断定できません」。
 *
 * **2026-09-21 に足した。** gemma4:26b の実データ（教科書チート_確認用
 * 第5話）で、この形の2件が**そのまま作者に出ていた**。上の網は
 * 「矛盾**では**ありません」しか見ておらず、**「矛盾**とは**言えません」は
 * 通していた**（`矛盾` の直後が `と` の形）。
 *
 * **プロンプトの【判断の注意】に書いた言い回しが、そのまま返ってきている**
 * ——「照らし合わせる相手が無いものは矛盾とは言えません」「指摘は断定形に
 * しないこと」。指示の言葉が答えの中身として返る型なので、**プロンプトに
 * 書いた否定の言い方はぜんぶ網に入れる。**
 *
 * 「断定しにくい」は 2026-09-24 に足した（同じ保留の形。答え付きの台の
 * 第2話で、仕込みの無い所に付いた余計な指摘2件がこの形だった）。
 *
 * **保留の形は、明示の否定と同じく落とす。** 2026-09-24 に「明示の否定
 * だけにする」案もあったが、実測の落とした答え56件のうち、
 * 保留だけで落ちていたのは本物1件（第5話「二週間」）に対し、余計な指摘が
 * 10件あった。本物のほうは食い違いを「乖離」と言い切っているので、
 * 言い切りの網（`AFFIRMATION_PATTERN`）で拾う。
 */
const HEDGED_DENIAL_PATTERN =
  /(矛盾|食い違い?)と(まで)?は?(((言|い)(え|い切れ)|断定でき|判断でき)(ない|ませ|ず|なく)|(断定|判断)し(にく|づら))/;

/**
 * 判断の保留——「矛盾しているかは不明です」「矛盾かどうかは判断できません」。
 *
 * 同じ実データで返ってきたもう1つの形。**「分からない」は「矛盾がある」では
 * ない**ので、指摘として出さない（迷いは確信度ではなく、ここで落とす）。
 *
 * 2026-09-24 に「一致しているかは不明確」「整合しているかは分からない」の
 * 形を足した。上の網から疑問の形（「一致しているか確認が必要」）を外した
 * ところ、この保留の形が通るようになった（過去の測定の答えで当て直して
 * 見つけた）。「確認が必要」「重要」は保留ではないので入れない。
 */
const UNSURE_DENIAL_PATTERN =
  /(矛盾|食い違[いっ]|一致|整合)(し?て)?(いる|います)?(のか|か)(どうか)?(は|が)?(不明|判断でき(ない|ませ|ず)|(分|わ)か(ら|り)(ない|ませ|ず)|定かで(は)?(ない|ありませ))/;

/**
 * 「ここは食い違っている」と言い切っている部分。
 *
 * **落としすぎないための歯止め。** `note` は補足欄なので、作者向けの
 * 但し書き（「断定はできないが」）が混ざりやすい。「矛盾とは言えない部分も
 * あるが、ここは食い違っている」を落とすと、**本物の指摘が消える**——
 * 取りこぼすより、落としすぎるほうが怖い。
 *
 * `(?![かの])` は「矛盾している**か**は不明」を言い切りと読まないため。
 *
 * 「矛盾の可能性が高い」「乖離がある」は 2026-09-24 に足した。仕込みの
 * 正解（第4話「右足」・第5話「二週間」）がこの言い方で食い違いを
 * 言い切りながら、但し書きの保留で落ちていた。「矛盾**ではない**可能性が
 * 高い」は当たらない（「矛盾」の直後に「の」か「して」が要る）。
 */
const AFFIRMATION_PATTERN =
  /(矛盾してい(る|ます|た)(?![かの])|矛盾する(?![かの])|食い違ってい(る|ます|た)(?![かの])|矛盾の可能性が高|乖離(が|は)?(あ|見|生じ|し))/;

export function deniesContradiction(text: string): boolean {
  // 打ち消しの言葉が混ざっていても、どこかで言い切っていれば本物の指摘
  if (AFFIRMATION_PATTERN.test(text)) return false;
  return (
    DENIAL_PATTERN.test(text) ||
    HEDGED_DENIAL_PATTERN.test(text) ||
    UNSURE_DENIAL_PATTERN.test(text)
  );
}

/**
 * 設定の側が、実は設定を述べていないものを見分ける。
 *
 * **実データで返ってきた。**「設定情報なし」「本文からは読み取れない」を
 * `settingSays` に書いて指摘してくる。**照らし合わせる相手が無いのだから、
 * それは矛盾ではない。**
 *
 * 「不明」は 2026-09-24 に「設定は不明」「詳細は不明」の形と単独だけに
 * 絞った。「行方不明になった」「生死不明」は設定そのものである。
 */
const NO_SETTING_PATTERN =
  /(設定(情報)?(は)?(が)?(特に)?(あり)?(記載)?(され)?(て)?(い)?(ない|ませ|なし)|記述(は)?(あり)?(ませ|ない)|見当たり?(ませ|ない)|読み取れ(ない|ませ)|(設定|記述|記載|情報|詳細|言及)(は|が)?(特に)?不明|^不明$|言及(は)?(され)?(て)?(い)?(ない|ませ)|^(特に)?(なし|無し|ありません)$)/;

/**
 * 文と「〜が、」の区切り。設定を述べたあとに不在を言い添える形
 * （「左足首を骨折したとあるが、右足に関する記述はない」）を分けて見るため
 */
const SETTING_CLAUSE_BREAK = /[。．！!？?\n]|(?:が|けれど|けど|ものの)、/;
/** 本文の側を述べている区切り。設定の中身としては数えない */
const TEXT_SIDE_CLAUSE = /^本文(中)?(で|に)?(は|では)/;

/**
 * 設定の欄が「設定が無い」としか言っていないか。
 *
 * **2026-09-24 に、区切りごとに見るようにした**（縛りの洗い出し2番）。
 * 前は欄のどこかに不在の言い回しがあれば落としていたので、設定を正しく
 * 引いたうえで「第2話で左足首を骨折したと記述されている。**右足に関する
 * 言及はない**」と、食い違う側の不在を添えただけの答えが落ちていた。
 * 答え付きの台で、仕込みの正解（第4話「右足」・第5話「ほくろ」）が
 * この形で5回落ちている。**中身のある区切りが1つでもあれば、照らす相手は
 * ある**ので通す。
 */
export function lacksSetting(settingSays: string): boolean {
  const clauses = settingSays
    .split(SETTING_CLAUSE_BREAK)
    .map((clause) =>
      clause.trim().replace(/^[\s（(「『【、]+|[\s）)」』】、]+$/gu, "")
    )
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return false;
  return clauses.every(
    (clause) =>
      NO_SETTING_PATTERN.test(clause) || TEXT_SIDE_CLAUSE.test(clause)
  );
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
