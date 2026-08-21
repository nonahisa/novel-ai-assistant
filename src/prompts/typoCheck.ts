/**
 * P-09 誤字脱字検知（チャンク単位）
 *
 * これが最も誤検出を出しやすい機能のため、固有名詞・造語の保護辞書を
 * プロンプトへ必ず注入する（プロンプト設計書P-09の方針）。
 * それでも小さいモデルは指示を無視することがあるため、
 * コード側（`core/typoCheckValidation.ts`）でも二重に弾く。
 *
 * プロンプトを変更したら version を上げること。
 * キャッシュのキーに含まれており、版が変わると再処理される。
 */
// 1.1: 作品の作法（一人称・文語体・直さない語）を渡すようにした（6.8.14）
export const TYPO_CHECK_VERSION = "1.1";

export const TYPO_CHECK_SYSTEM_PROMPT = `あなたは日本語の小説の誤字脱字だけを検出する校正アシスタントです。

【絶対に守る原則】
1. 確信が持てないものは指摘しないこと。見逃しよりも誤検出の方が作者の作業を妨げる。
2. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。
3. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。`;

export interface TypoCheckInput {
  /** 行番号付きの本文（`core/chunker.ts` の `withLineNumbers` で作る） */
  chunkTextWithLineNumbers: string;
  /** この作品の固有名詞・造語。誤りとして指摘させないため */
  properNounDictionary: string[];
  /**
   * この作品の書き方（`core/workStyle.ts` の `buildStyleNote`）。
   *
   * **語り手の一人称・文語体・作者が直さないと決めた語**を伝える。
   * これまでは渡しておらず、モデルが知りようのないことを
   * コード側で後から弾いていた（設計書6.8.14）。
   *
   * 分かっていることが何も無ければ空文字。**そのときは何も書かない。**
   */
  styleNote?: string;
}

export function buildTypoCheckPrompt(input: TypoCheckInput): string {
  const dictionary =
    input.properNounDictionary.length > 0
      ? input.properNounDictionary.join("、")
      : "（まだ登録されていません）";

  return `以下の小説本文から、誤字・脱字・変換ミスのみを検出してください。

【本文】
${input.chunkTextWithLineNumbers}

【この作品の固有名詞・造語】（これらは誤りではありません。指摘しないこと）
${dictionary}
${input.styleNote ? `\n${input.styleNote}\n` : ""}
【検出対象】
- 誤変換（例：「以外」と「意外」、「行動」と「講堂」）
- 脱字（助詞抜け、文字抜け）
- 衍字（重複入力、例：「ししかし」）
- 送り仮名の誤り
- 明らかな入力ミス

【検出しないもの】
- 上記の固有名詞・造語リストに含まれる語
- 意図的な表現、方言、古語、キャラクターの口癖や訛り
- 文体・語彙の選択（「良い」を「よい」にする等の提案は不要）
- 表記ゆれ（別機能で扱うため、ここでは扱わない）
- ら抜き言葉など、会話文中の口語表現

【重要】
確信が持てないものは指摘しないこと。見逃しよりも誤検出の方が
作者の作業を妨げます。

【出力形式】JSONのみ
{
  "issues": [
    {
      "line": 42,
      "original": "誤りを含む箇所（前後を含め30字以内）",
      "target": "誤っている語のみ",
      "suggestion": "修正案",
      "reason": "誤変換／脱字／衍字／送り仮名",
      "confidence": "high|medium|low"
    }
  ]
}`;
}

/** Ollamaの構造化出力に渡すJSONスキーマ */
export const TYPO_CHECK_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "integer" },
          original: { type: "string" },
          target: { type: "string" },
          suggestion: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: [
          "line",
          "original",
          "target",
          "suggestion",
          "reason",
          "confidence",
        ],
      },
    },
  },
  required: ["issues"],
} as const;

export interface ExtractedTypoIssue {
  line: number;
  original: string;
  target: string;
  suggestion: string;
  reason: string;
  confidence: string;
}

export interface TypoCheckResult {
  issues: ExtractedTypoIssue[];
}
