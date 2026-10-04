import { isPlaceholderText } from "./placeholderText";
import {
  FINDING_ADVICE_EXAMPLE_MAX_CHARS,
  FINDING_ADVICE_EXAMPLES_MAX,
  FINDING_ADVICE_HINTS,
  FINDING_ADVICE_NO_NEED,
  FINDING_ADVICE_POINT_MAX_CHARS,
} from "../prompts/findingAdvice";

/**
 * 推敲の指摘への短い助言（P-47、設計書6.96.5）の応答の検証。
 *
 * **AIの出力を信用しない**（規則3）。見るのは次のとおり。
 *
 *   1. `point`（何が引っかかっているか）：空・埋め草・指示の言葉の返り・
 *      前後の段落の写しは捨てる。上限を超えたら切る（言いたいことは頭にある）
 *   2. `examples`（言い換え）：
 *      - `from` が**本文の一文に無い**ものは捨てる（どこを言い換えたのか確かめられない）
 *      - `to` が上限を超えるもの、空・埋め草・指示の言葉、`from` と同じもの、
 *        **案の名前だけのもの**（「Aの方向」）、前後の段落の写しは捨てる
 *      - 上限を超えるものは**切らずに捨てる**——切った言い換えは文として壊れている
 *      - 3つ目以降は捨てる
 *   3. 「直す必要は薄い」と答えたら、言い換えは出さない（指示と食い違う組み合わせ）
 *
 * `point` も言い換えも残らなければ undefined（読めなかった扱い）。
 *
 * VS Code APIに依存しない（単体テストの対象）。
 */

export interface FindingAdviceExample {
  /** 本文の一文から写した部分（**必ず一文の中にある**） */
  from: string;
  /** その部分の言い換え */
  to: string;
}

export interface FindingAdvice {
  /** 何が引っかかっているか（1文）。読み取れなければ空 */
  point: string;
  /** 言い換えの例（0〜2個） */
  examples: FindingAdviceExample[];
  /** 「直す必要は薄い」と答えたか */
  noNeed: boolean;
  /** 検証で捨てた言い換えの数（記録に残すため） */
  dropped: number;
}

export interface FindingAdviceMaterial {
  /** 指摘された一文 */
  quote: string;
  /** 前後の段落（答えに写されていないかを見る） */
  before?: string;
  after?: string;
}

/**
 * 前後の段落の写しとみなす長さ。短い語（「彼女は」）は一文にも前後にも
 * 自然に出るので、これより短いものは写しとして扱わない
 */
const NEIGHBOR_COPY_MIN_CHARS = 8;

/**
 * 案の名前だけの言い換え（作者の報告 2026-10-04「選択肢の意味もわかりません」）。
 * 「Aの方向」「案1」「方向性B」「パターン2」のようなもの
 */
const ABSTRACT_OPTION_PATTERNS: readonly RegExp[] = [
  /^(案|方向性?|方針|選択肢|パターン|プラン)\s*[0-9０-９A-Za-zＡ-Ｚａ-ｚ一二三①-⑨]/u,
  /^[0-9０-９A-Za-zＡ-Ｚａ-ｚ①-⑨][\s.．:：、]*(の)?(方向性?|案|方針|パターン)/u,
  // 「内面に寄せる方向で」のように、言い換えではなく向きだけを言うもの
  /(方向性?|路線)(で|に|へ)?。?$/u,
];

export function parseFindingAdvice(
  text: string,
  material: FindingAdviceMaterial
): FindingAdvice | undefined {
  const parsed = parseObject(text);
  if (!parsed) return undefined;

  const neighbors = [material.before ?? "", material.after ?? ""].filter(
    (paragraph) => paragraph.trim() !== ""
  );

  let point = typeof parsed.point === "string" ? unquote(parsed.point) : "";
  if (isEmptyAnswer(point) || copiesNeighbor(point, neighbors)) point = "";
  point = clipPoint(point);
  const noNeed = point.startsWith(FINDING_ADVICE_NO_NEED);

  const rawExamples = Array.isArray(parsed.examples) ? parsed.examples : [];
  const examples: FindingAdviceExample[] = [];
  let dropped = 0;
  for (const raw of rawExamples) {
    const example = readExample(raw, material.quote, neighbors);
    if (
      !example ||
      noNeed ||
      examples.length >= FINDING_ADVICE_EXAMPLES_MAX ||
      examples.some((kept) => kept.to === example.to)
    ) {
      dropped += 1;
      continue;
    }
    examples.push(example);
  }

  if (!point && examples.length === 0) return undefined;
  return { point, examples, noNeed, dropped };
}

function readExample(
  raw: unknown,
  quote: string,
  neighbors: readonly string[]
): FindingAdviceExample | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const from = typeof record.from === "string" ? unquote(record.from) : "";
  const to = typeof record.to === "string" ? unquote(record.to) : "";
  if (!from || !to) return undefined;
  // **本文の一文に無い `from` は捨てる。** どこを言い換えたのか確かめられない
  if (!quote.includes(from)) return undefined;
  if (from === to) return undefined;
  if ([...to].length > FINDING_ADVICE_EXAMPLE_MAX_CHARS) return undefined;
  if (isEmptyAnswer(to)) return undefined;
  if (ABSTRACT_OPTION_PATTERNS.some((pattern) => pattern.test(to))) return undefined;
  if (copiesNeighbor(to, neighbors)) return undefined;
  return { from, to };
}

/**
 * 上限を超えた `point` を切る。上限の中に句点があればそこまで、
 * 無ければ上限の手前で切って「…」を付ける
 */
function clipPoint(point: string): string {
  const chars = [...point];
  if (chars.length <= FINDING_ADVICE_POINT_MAX_CHARS) return point;
  const head = chars.slice(0, FINDING_ADVICE_POINT_MAX_CHARS).join("");
  const stop = head.lastIndexOf("。");
  if (stop >= 10) return head.slice(0, stop + 1);
  return `${chars.slice(0, FINDING_ADVICE_POINT_MAX_CHARS - 1).join("")}…`;
}

/** 前後の段落をそのまま写したものか */
function copiesNeighbor(text: string, neighbors: readonly string[]): boolean {
  const body = text.replace(/[。、]$/u, "");
  if ([...body].length < NEIGHBOR_COPY_MIN_CHARS) return false;
  return neighbors.some((paragraph) => paragraph.includes(body));
}

/** 前後の鉤括弧・引用符・空白を落とす（中身は変えない） */
function unquote(text: string): string {
  return text
    .trim()
    .replace(/^[「『"“]+/u, "")
    .replace(/[」』"”]+$/u, "")
    .trim();
}

/**
 * 中身のつもりで書かれた「中身が無い」言葉か。
 *
 *   1. 「特になし」「該当なし」のような、中身が無いことを表す言葉
 *   2. **プロンプトに書いた項目名・指示の言葉そのもの**（「言い換え例」「60字以内」）
 */
function isEmptyAnswer(text: string): boolean {
  if (!text) return true;
  if (isPlaceholderText(text, true)) return true;
  const body = normalizeForHintMatch(text);
  if (!body) return true;
  if (FINDING_ADVICE_HINTS.some((hint) => body === normalizeForHintMatch(hint))) {
    return true;
  }
  /*
    指示の1行をまるごと写してくることもある（「何が引っかかっているかを、
    60字以内の1文で…」）。長い項目名を含むもの・字数の指示を含むものは捨てる。
    短い語（「一文」）は助言の中に自然に出るので、含むだけでは捨てない
  */
  if (/[0-9０-９]+字以内/u.test(text)) return true;
  return FINDING_ADVICE_HINTS.some((hint) => {
    const needle = normalizeForHintMatch(hint);
    return [...needle].length >= 8 && body.includes(needle);
  });
}

/** 指示語との突き合わせ用。約物と空白の違いで取り逃がさないようにする */
function normalizeForHintMatch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(
      /[、。，．,.:：;；!！?？「」『』（）()〔〕【】《》〈〉[\]{}｛｝“”"'’‘]/gu,
      ""
    );
}

/**
 * 応答からJSONの本体を切り出して読む。
 *
 * 構造化出力に対応していないモデルは、前置きやコードフェンスを付けてくる
 * （`notationAdviceValidation.ts` と同じ手順）。
 */
function parseObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;

  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
