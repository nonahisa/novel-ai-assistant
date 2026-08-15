/**
 * P-22 質問を検索語に直す
 *
 * ## なぜこの段が要るか
 *
 * 実データ（78.5万字・219話）で測って分かったことがある。
 * 「妬ましさを感じる場面は？」と聞くと、意味検索も語句一致も
 * 30位以内に正解を入れられなかった。ところが**「嫉妬」と直接聞けば
 * 1〜2位で出た**。つまり足りないのは検索の力ではなく、
 * 作者の言い回しを本文の言葉へ直す段だった。
 *
 * AIに検索語を作らせたところ（嫉妬・羨む・劣等感…）、
 * 5問中1問しか当てられなかったものが5問とも当たるようになった。
 *
 * ## 短く・軽く保つ
 *
 * 検索語を出すだけなので、答えを書かせない。出力はJSONの配列だけ。
 * 相談のたびに1回余計にAIを呼ぶことになるため、**入力も出力も小さくする**。
 * 有料のAIでは、この1回ぶんも料金がかかることを作者に知らせる。
 */
export const SEARCH_TERMS_VERSION = "1.0";

/** 出させる検索語の数。多すぎると関係の薄い語で検索が濁る */
export const SEARCH_TERMS_COUNT = 5;

export const SEARCH_TERMS_SYSTEM_PROMPT = `あなたは小説の本文を検索するための語を選ぶ係です。

【守ること】
1. 質問に答えないこと。検索語だけを出すこと。
2. 作者の言い回しではなく、**本文に実際に書かれていそうな言葉**へ直すこと。
   例：「妬ましさを感じる」→「嫉妬」、「組み技を習う」→「稽古」「道場」
3. 作品固有の名前（人物名・地名・造語）は、そのままの形で残すこと。
4. 出力は指定されたJSON形式のみとし、説明文やコードフェンスを含めないこと。`;

export interface SearchTermsInput {
  question: string;
  /** 相談の対象。人物名など、外せない語があれば渡す */
  focus?: string;
  /** 作品に出てくる名前。造語を勝手に言い換えさせないために渡す */
  knownTerms?: string[];
}

export function buildSearchTermsPrompt(input: SearchTermsInput): string {
  const focus = input.focus?.trim()
    ? `\n【相談の対象】\n${input.focus}\n`
    : "";
  const known =
    input.knownTerms && input.knownTerms.length > 0
      ? `\n【この作品に出てくる名前】（この形のまま使うこと）\n${input.knownTerms
          .slice(0, 60)
          .join("、")}\n`
      : "";

  return `次の質問に合う場面を、小説の本文から探します。
${focus}${known}
【質問】
${input.question}

【出すもの】
本文を探すための検索語を${SEARCH_TERMS_COUNT}個。
- 本文に書かれていそうな言葉にすること
- 一語ずつにすること（文にしない）
- 質問への答えは書かないこと`;
}

export const SEARCH_TERMS_SCHEMA = {
  type: "object",
  properties: {
    terms: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["terms"],
  additionalProperties: false,
} as const;

export interface SearchTermsResult {
  terms: string[];
}

/**
 * 応答から検索語を取り出す。
 *
 * **失敗しても例外にしない。** 検索語が作れなくても、質問文そのままで
 * 検索すれば動く（今より悪くはならない）。ここで止めると相談ができなくなる。
 */
export function parseSearchTerms(text: string): string[] {
  const source = extractJson(text);
  if (!source) return [];
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null) return [];
    const terms = (parsed as { terms?: unknown }).terms;
    if (!Array.isArray(terms)) return [];
    return terms
      .filter((term): term is string => typeof term === "string")
      .map((term) => term.trim())
      .filter((term) => term.length > 0 && term.length <= 30)
      .slice(0, SEARCH_TERMS_COUNT * 2);
  } catch {
    return [];
  }
}

function extractJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return body.slice(start, end + 1);
}

/**
 * 検索に使う文字列を組み立てる。
 *
 * **質問文も残す。** 検索語だけにすると、AIが的外れな語を出したときに
 * 手がかりが無くなる。両方入れておけば、どちらかが当たる。
 */
export function buildSearchQuery(
  question: string,
  terms: readonly string[],
  focus?: string
): string {
  const parts = [focus?.trim(), question.trim(), ...terms].filter(
    (part): part is string => Boolean(part)
  );
  return parts.join(" ");
}
