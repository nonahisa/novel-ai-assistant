/**
 * P-04a 登場人物抽出（チャンク単位）
 *
 * プロンプトを変更したら version を上げること。
 * キャッシュのキーに含まれており、版が変わると再処理される。
 */
export const CHARACTER_EXTRACT_VERSION = "1.5";

export const BASE_SYSTEM_PROMPT = `あなたは日本語の小説執筆を支援する編集アシスタントです。

【絶対に守る原則】
1. 本文に書かれていない情報を推測で補って断定しないこと。根拠が本文にない場合は
   該当フィールドを null または空配列とし、confidence を low とすること。
2. 作者の文体・表現の好みを尊重すること。あなたの好みで書き換えを提案しない。
3. 指摘や提案を行う際は、必ず本文中の該当箇所を特定できる情報を添えること。
4. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。
5. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
   判断に迷う場合は指摘せず、confidence を low にすること。`;

export interface CharacterExtractInput {
  chunkText: string;
  chapterLabel: string;
  knownCharacterNames: string[];
}

export function buildCharacterExtractPrompt(
  input: CharacterExtractInput
): string {
  const known =
    input.knownCharacterNames.length > 0
      ? input.knownCharacterNames.join("、")
      : "（まだ登録されていません）";

  return `以下の小説本文から、登場人物の情報を抽出してください。

【本文】（${input.chapterLabel}）
${input.chunkText}

【既知の登場人物】（同一人物の判定に使用）
${known}

【抽出ルール】
- entityType で候補を person / group / location / unknown に分類すること。characters に
  出力してよいのは entityType が person の候補だけである。group / location / unknown は
  レコードを出力しないこと。
- 一人称・二人称などの代名詞、汎用的な役職語、家族関係語、集団、場所、組織、種族、
  生物種は人物レコードを作らないこと。特定の人物名が本文から確認できない話者についても、
  仮の名前や説明的な名前を発明してレコードを作らないこと。
- 同一人物が別の呼称で登場する場合（本名／通称／あだ名／役職）、既知の登場人物と
  照合し、同一と判断できる場合は既知の名前を name とし、別呼称を aliases に入れること。
  判断できない場合は新規人物として扱うこと。
- 各項目は、この本文範囲から読み取れる内容のみを書くこと。読み取れない項目は
  null とすること。推測で埋めないこと。
- 役職・肩書きと本名が両方本文から読み取れる場合、name には本名のみを書き、
  役職・肩書きは role に書くこと。
  例：「衛兵隊副隊長のエバン」→ name: "エバン", role: "衛兵隊副隊長"
- 各人物には、本文からそのまま抜き出した短い evidence を必ず付けること。
  evidence は説明や要約ではなく、人物名または本文上の呼称を含む逐語引用にすること。

【呼称の抽出ルール】（重要）
呼称は「誰が誰をどう呼んだか」の方向を持つ情報です。
1. 会話文・心内語の中で、ある人物が別の人物を呼んだ表現をすべて拾うこと。
   例：「白瀬さん、それは違う」→ 話者が白瀬を「白瀬さん」と呼んでいる
2. 同じ相手に複数の呼び方がある場合、すべて記録すること。
   まとめたり代表的なもの1つに絞ったりしないこと。
   例：平時は「澪」、怒った時は「白瀬」、人前では「白瀬さん」→ 3件すべて記録
3. 使い分けの条件が本文から読み取れる場合のみ context に記述する。
4. 話者が誰か特定できない発話の呼称は抽出しないこと。推測で話者を決めつけないこと。
5. 敬称・接尾辞（さん、くん、様、ちゃん、先輩、殿）は省略せず、
   本文に出てきた形のまま記録すること。
6. 「君」「お前」「あなた」など特定の相手を持たない一般的な呼びかけは
   defaultSecondPerson に入れ、addressTerms には入れないこと。

【出力形式】
指定されたJSON形式のみを出力してください。`;
}

/**
 * Ollamaの構造化出力に渡すJSONスキーマ。
 * これを指定すると形式が強制され、パース失敗がほぼ無くなる。
 */
export const CHARACTER_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          entityType: {
            type: "string",
            enum: ["person", "group", "location", "unknown"],
          },
          aliases: { type: "array", items: { type: "string" } },
          isMob: { type: "boolean" },
          role: { type: ["string", "null"] },
          personality: { type: ["string", "null"] },
          appearance: { type: ["string", "null"] },
          firstPerson: { type: ["string", "null"] },
          defaultSecondPerson: { type: ["string", "null"] },
          addressTerms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                targetName: { type: "string" },
                term: { type: "string" },
                category: { type: ["string", "null"] },
                context: { type: ["string", "null"] },
                evidence: { type: ["string", "null"] },
              },
              required: ["targetName", "term"],
            },
          },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                relation: { type: "string" },
              },
              required: ["name", "relation"],
            },
          },
          evidence: { type: "string", minLength: 1 },
        },
        required: ["name", "entityType", "evidence"],
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["characters"],
} as const;

/** AIから返る抽出結果 */
export interface ExtractedCharacter {
  name: string;
  aliases?: string[];
  entityType?: "person" | "group" | "location" | "unknown";
  isMob?: boolean;
  role?: string | null;
  personality?: string | null;
  appearance?: string | null;
  firstPerson?: string | null;
  defaultSecondPerson?: string | null;
  addressTerms?: Array<{
    targetName: string;
    term: string;
    category?: string | null;
    context?: string | null;
    evidence?: string | null;
  }>;
  relations?: Array<{ name: string; relation: string }>;
  evidence?: string | null;
}

export interface CharacterExtractResult {
  characters: ExtractedCharacter[];
  confidence?: string;
}
