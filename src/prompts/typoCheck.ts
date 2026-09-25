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
// 1.2: 大きいモデル向けに、検算と食い違っていたところを揃えた（正解つきの台、
//      2026-09-26。設計書6.8.20）。target と suggestion の書き方（脱字・衍字・
//      空白・行末の句点）、reason の「入力ミス」、確信度の意味、境目（ら抜き・
//      同音の語）を書いた。**確信の強さは 1.1 のまま**（下の断り書き）。
//      **小さいモデルへは 1.1 の文をそのまま送る**（`TYPO_CHECK_VERSION_SMALL`）
export const TYPO_CHECK_VERSION = "1.2";

/**
 * 小さいモデル（20B 未満）へ送る版の名前。**文は 1.1 と1字も違わない**ので、
 * 鍵も 1.1 のままにする——既定の `gemma4:e4b` で作者が貯めた処理済みが飛ばない。
 * キャッシュは読み取ったあとの答えを持ち、検算は取り出すたびに通し直すので、
 * 直した検算はそのまま効く。
 */
export const TYPO_CHECK_VERSION_SMALL = "1.1";

/**
 * 送るときの温度。誤字脱字は事実の照合なので揺らさない。
 *
 * **製品も測定台もここを見る**（プロンプトと温度は一対なので、版と同じ場所に置く）。
 */
export const TYPO_CHECK_TEMPERATURE = 0.0;

/*
  **1.2 で試して、採ったものと採らなかったもの**（正解つきの台、2026-09-26。
  設計書6.8.20、プロンプト設計書 P-09 の実測メモ）。

  - **採った：書き方を揃える指示**（target と suggestion の範囲、脱字・衍字・
    空白・行末の句点の書き方、reason の「入力ミス」、ら抜き・同音の語の境目）。
    26b は当たりが同じ12件のまま、画面に出る誤検出が 7 → 5。さくらの Kimi-K2.6 も
    誤検出を増やさなかった
  - **採らなかった：「確信が持てなくても low で出してよい」**（前後の流れから
    推し量る指摘も頼む版）。26b では画面に出る誤検出が 7 → 2 に減ったが、
    **Kimi-K2.6 は誤検出が 2 → 14 に増え、ほとんどが確信度「高」「中」**だった
    （low で絞る前提が崩れる）。モデルによって逆に振れるので、1.1 の強さを残す
  - **小さいモデルには 1.1 の文をそのまま送る**（作者の指示「増えるなら、
    小さいモデルには今の強さを残す」）。`gemma4:e4b` では、書き方を揃える指示を
    足しただけで誤検出が 13 → 29 に増えた（文まるごとを target にした言い換え）。
    **書き方の指示を足すこと自体が、小さいモデルを「範囲を広く取る」側へ動かす**
    ——2026-09-05 に「最小の範囲」を足して測ったときと同じ動き

  境目は矛盾検知の抑制（P-12、設計書6.10.8）と同じ 20B（`ai/capability.ts` の
  `useSmallModelTypoPrompt`）。検算の直しは、どちらの版にも効く。
*/
export const TYPO_CHECK_SYSTEM_PROMPT = `あなたは日本語の小説の誤字脱字だけを検出する校正アシスタントです。

【絶対に守る原則】
1. 誤りだと言える根拠が本文にあるものだけを指摘すること。書き方の好み・言い換え・表記ゆれは指摘しない。
2. 確信が持てないものは指摘しないこと。見逃しよりも誤検出の方が作者の作業を妨げる。
3. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。
4. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。`;

/**
 * 小さいモデルへ送る版。**1.1 のシステムプロンプトと1字も違わない。**
 *
 * **キャッシュの鍵には `typoPromptVersion(true)`（＝ 1.1）を使う。**
 */
export const TYPO_CHECK_SYSTEM_PROMPT_SMALL = `あなたは日本語の小説の誤字脱字だけを検出する校正アシスタントです。

【絶対に守る原則】
1. 確信が持てないものは指摘しないこと。見逃しよりも誤検出の方が作者の作業を妨げる。
2. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。
3. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。`;

/**
 * 送った版の名前（キャッシュの鍵・操作ログ・MCP の記録に使う）。
 * 小さいモデル向けは文が 1.1 そのままなので、名前も 1.1。
 */
export function typoPromptVersion(forSmallModel: boolean): string {
  return forSmallModel ? TYPO_CHECK_VERSION_SMALL : TYPO_CHECK_VERSION;
}

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
  /**
   * 小さいモデル向けの版（1.1 の文そのまま）にするか。
   *
   * 省略すれば大きいモデル向けの既定（1.2）。システムプロンプトも
   * `TYPO_CHECK_SYSTEM_PROMPT_SMALL` と対で送ること。
   */
  forSmallModel?: boolean;
}

export function buildTypoCheckPrompt(input: TypoCheckInput): string {
  const dictionary =
    input.properNounDictionary.length > 0
      ? input.properNounDictionary.join("、")
      : "（まだ登録されていません）";
  if (input.forSmallModel === true) {
    return buildSmallModelPrompt(input, dictionary);
  }

  return `以下の小説本文から、誤字・脱字・変換ミスのみを検出してください。

【本文】
${input.chunkTextWithLineNumbers}

【この作品の固有名詞・造語】（これらは誤りではありません。指摘しないこと）
${dictionary}
${input.styleNote ? `\n${input.styleNote}\n` : ""}
【検出対象】
- 誤変換（例：「以外」と「意外」、「行動」と「講堂」）
- 同音の語の取り違えで、文脈から意味がはっきり決まるもの（例：「会う」と「合う」、「追求」と「追及」）
- 脱字（助詞抜け、文字抜け）
- 衍字（重複入力、例：「ししかし」）
- 送り仮名の誤り
- 明らかな入力ミス（文中に紛れ込んだ空白、地の文の行末の句点抜けを含む）

【検出しないもの】
- 上記の固有名詞・造語リストに含まれる語
- 意図的な表現、方言、古語、キャラクターの口癖や訛り
- 文体・語彙の選択（「良い」を「よい」、「事」を「こと」にする等の提案は不要）
- 表記ゆれ（別機能で扱うため、ここでは扱わない）
- ら抜き言葉・い抜き言葉（会話文でも地の文でも、作者の文体として扱う）
- 同音の語のうち、どちらでも意味が通るもの
- 台詞（「」の中）の末尾に句点を足すこと
- 行頭の字下げ、感嘆符・疑問符のあとの空白
- 文の言い換え・言い回しの改善

【target と suggestion の書き方】
- target は、本文にそのまま出てくる、誤りを含む短い範囲にする。
- suggestion は、target と置き換える文字列にする。target の外にある前後の文字を suggestion に入れないこと。
- 脱字は、抜けた所の前後の字を target に含め、字を足した形を suggestion にする（例：本文「本を読だ」なら target「読だ」、suggestion「読んだ」）。
- 衍字は、余分な字を含む範囲を target にし、除いた形を suggestion にする（例：target「ししかし」、suggestion「しかし」）。
- 紛れ込んだ空白は、空白とその直前の1字を target にする（例：target「が　」、suggestion「が」）。
- 地の文の行末の句点抜けは、行末の語を target にし、句点を足した形を suggestion にする。
- reason は、誤変換・脱字・衍字・送り仮名・入力ミスのどれか1つにする。

【confidence の付け方】
- high：文として成り立たない誤り（字の重なり・抜け、ありえない変換）
- medium：文脈から意味が決まる同音の語の取り違え
- low：誤りの見込みはあるが、ほかの読み方も残るもの
【重要】
確信が持てないものは指摘しないこと。見逃しよりも誤検出の方が
作者の作業を妨げます。

【出力形式】JSONのみ
{
  "issues": [
    {
      "line": 42,
      "original": "誤りを含む箇所（前後を含め30字以内）",
      "target": "誤りを含む短い範囲",
      "suggestion": "target と置き換える文字列",
      "reason": "誤変換／脱字／衍字／送り仮名／入力ミス",
      "confidence": "high|medium|low"
    }
  ]
}`;
}

/**
 * 小さいモデルへ送る版。**1.1 のユーザープロンプトと1字も違わない**
 * （上の断り書きを参照。書き方の指示を足すと、小さいモデルは範囲を広く取る）。
 *
 * 1.1 は「明らかな入力ミス」を拾えと言いながら、空白・句読点だけの直しを
 * 検算が捨てていた。**食い違いは検算の側を直して揃えた**（空白・地の文の
 * 行末の句点を通す。`core/typoCheckValidation.ts`）ので、この文のままで
 * 言っていることと通すものが合う。
 */
function buildSmallModelPrompt(input: TypoCheckInput, dictionary: string): string {
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

/**
 * 辞書へ載せる固有名詞の件数。
 *
 * **固定費の測定と、実際に送るときで同じ値を使う。** 別々に書くと、
 * 片方を直したときに見込みと実物がずれる。
 *
 * **`features/checkTypos.ts` から、ここへ移した**（0.64.1）。MCP から
 * 同じプロンプトを組むとき、`features` は `vscode` に依存していて
 * 届かない。写しを置けば、片方だけが直る日が必ず来る——
 * `MAX_ISSUES_PER_1000_CHARS` を `prompts/proofread.ts` に置いたのと
 * 同じ考えで、**プロンプトの形を決める値はプロンプトの側に置く。**
 */
export const TYPO_DICTIONARY_LIMIT = 200;

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
