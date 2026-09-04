import {
  CHATTER_COMMENT_ADVICE_WORDS,
  CHATTER_COMMENT_HINTS,
  CHATTER_COMMENT_MAX_CHARS,
} from "../core/chatterCommentValidation";

/**
 * P-34 本文を読んで言う一言（設計書6.21.4）
 *
 * 作者が本文を保存して手が止まったとき、直近に保存した話の末尾を読ませて
 * 「盛り上がってきましたね！」のような短い感想を1つだけ返させる。
 *
 * ## 言わせないことのほうが多い
 *
 * **粗探しをさせない。** 誤字・矛盾・構成の助言は、既存の検知機能
 * （P-09・P-10・P-12）の仕事である。書いた直後に指摘されると興が削がれる
 * ——6.21.1の「誤字脱字の申し出は最後に回す」と同じ理屈。ここで欲しいのは
 * 「読んだ人がいる」という手応えだけである。
 *
 * **短くさせる。** 独り言は横から差し込む1行で、読み飛ばせることが前提。
 * 長い講評は、頼まれてもいないのに画面を占める。
 *
 * ## 守られない前提で組む
 *
 * 指示に書いた語（「感想」「一言」）は**そのまま答えとして返ってくる**し、
 * 「助言はしないでください」と書いても助言は返ってくる。どちらも
 * `core/chatterCommentValidation.ts` が捨てる。**捨てたら黙る**ので、
 * 通らなかったことは作者には見えない。
 *
 * プロンプトを変更したら version を上げること。
 */
export const CHATTER_COMMENT_VERSION = "1.0";

/**
 * 読ませる本文の長さ。
 *
 * **末尾だけを渡す。** いま書き終えたところについて言ってほしいので、
 * 話の頭から渡しても的が外れる。1,500字なら、手元の小さいモデルでも
 * 数秒で読める（独り言のために作者の機械を長く占有しない）。
 */
export const CHATTER_COMMENT_EXCERPT_CHARS = 1_500;

/**
 * これより短い本文には、感想を言わせない。
 *
 * 数行しかない書きかけの話に「盛り上がってきましたね」は的外れである。
 * 材料が無いときは、AIを呼ぶ前に黙る。
 */
export const CHATTER_COMMENT_MIN_CHARS = 200;

export const CHATTER_COMMENT_SYSTEM_PROMPT = `あなたは、小説を書いている作者のそばで原稿を読んでいる読み手です。

【絶対に守る原則】
1. 言うのは読んだ感想か応援だけです。直すところの指摘・助言・要約はしないこと。
2. ${CHATTER_COMMENT_MAX_CHARS}字以内の1文にすること。
3. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

export interface ChatterCommentPromptInput {
  workTitle: string;
  /** 直近に保存した話の末尾。`tailExcerpt` で切り出したもの */
  excerpt: string;
}

export function buildChatterCommentPrompt(
  input: ChatterCommentPromptInput
): string {
  return `次は、いま書き終えたばかりの小説の一部（話の末尾）です。読んだ感想を一言だけ返してください。

【作品タイトル】
${input.workTitle}

【本文（末尾）】
${input.excerpt}

【守ること】
- ${CHATTER_COMMENT_MAX_CHARS}字以内の1文にしてください。長い講評は要りません。
- 読んで感じたこと、または書き続ける人への応援だけを書いてください。
- ${CHATTER_COMMENT_ADVICE_WORDS.slice(0, 8)
    .map((word) => `「${word}」`)
    .join("・")}のような、直すところの話はしないこと。
  「〜したほうがよい」「〜すべき」のような助言も書かないこと。
- あらすじの言い直し（何が起きたかの要約）は書かないこと。
- ${CHATTER_COMMENT_HINTS.map((hint) => `「${hint}」`).join(
    "・"
  )}のような、この指示文に出てくる語を
  そのまま答えに書かないこと。書くのは実際の感想の文だけです。`;
}

/**
 * 構造化出力のスキーマ。**1つだけ必須にする。**
 *
 * 候補を並べさせない（複数返ると、どれを出すかをこちらが選ぶことになり、
 * 選ぶ根拠が無い）。
 */
export const CHATTER_COMMENT_SCHEMA = {
  type: "object",
  properties: {
    comment: { type: "string" },
  },
  required: ["comment"],
  additionalProperties: false,
} as const;

/**
 * 話の末尾を切り出す。
 *
 * 切れ目は行の頭に合わせる。文の途中から渡すと、モデルがその欠けを
 * 「読みにくい」と受け取って助言を返しやすくなる。
 * 行の頭が見つからない（1行が長い）ときは、そのまま末尾から切る。
 */
export function tailExcerpt(text: string, limit: number): string {
  const body = text.replace(/\r\n?/g, "\n").trimEnd();
  const chars = [...body];
  if (chars.length <= limit) return body.trim();

  const tail = chars.slice(chars.length - limit).join("");
  const lineStart = tail.indexOf("\n");
  // 行の頭が抜き出しのほとんどを削ってしまうなら、切らずにそのまま渡す
  if (lineStart > 0 && lineStart < limit / 4) {
    return tail.slice(lineStart + 1).trim();
  }
  return tail.trim();
}

/**
 * 応答から一言を読み取る。読めなければ undefined（呼び出し側は黙る）。
 *
 * 構造化出力に対応していないモデルは、前置きやコードフェンスを付けてくる
 * （`nameSuggest.ts` と同じ手）。
 */
export function parseChatterComment(text: string): string | undefined {
  const source = extractJson(text);
  if (!source) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const comment = (parsed as Record<string, unknown>).comment;
  return typeof comment === "string" ? comment : undefined;
}

function extractJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return body.slice(start, end + 1);
}
