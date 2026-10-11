/**
 * P-48 写真の書き起こし（設計書6.117）
 *
 * 作者の手書きのノートを撮った写真（1ページずつ）を渡し、**書いてあるとおり
 * 一字一句**を書き起こさせる。原稿の下書きにするのは作者で、AIは字を写すだけ。
 *
 * ## 行をオブジェクトの配列で返させる
 *
 * 手元のAIは、横倒しの写真などで**同じ行を上限まで繰り返す**（gemma4:26b の実測。
 * 引継ぎ書8章 2026-10-11）。流して受け取る途中で止める仕組み
 * （`core/repeatedElements.ts`）は、**配列の中の同じオブジェクトが続けて5回**
 * 出たら止める作りなので、1行を `{ "text": "…" }` の1要素にする。平文や
 * 文字列の配列では、その仕組みが効かない。
 *
 * **空いている行は書かせない。** 空の要素が5つ続くと繰り返しと見なされ、
 * その先が捨てられる。段落の切れ目は、紙のとおり行頭の全角空白（字下げ）で表す。
 *
 * ## AIに決めさせないもの
 *
 * 挿入の位置・取り消し線・挿入の番号の扱い。測定では、清書や一覧を頼むと
 * どのモデルも崩れた（行の大半を書き足しと取り消しの両方に挙げる、原文に
 * 無い文を足す）。ここでは見えるとおり写させ、扱いは作者が画面で直す。
 *
 * プロンプトを変更したら version を上げること。
 */
import type { GenerateParams, ImageInput } from "../ai/types";

/**
 * 変更履歴
 * - 1.0: 初版（0.103.3）
 */
export const PHOTO_TRANSCRIBE_VERSION = "1.0";

/** 字を写すだけなので揺らさない（測定も温度0で行った） */
export const PHOTO_TRANSCRIBE_TEMPERATURE = 0;

/** 読めない字の印。**1字ごとに1つ** */
export const UNREADABLE_MARK = "〓";

/**
 * 手元のAI（Ollama）へ送る `num_ctx`。
 *
 * 写真の分のトークン（gemma4 で1枚約550〜1,100）は、文字数からの見積もり
 * （`contextSizeForPrompt`）に入らないので、機能の側から明示する（規則6）。
 * 測定（2026-10-11）と同じ値。モデルの長さがこれより短ければそちらを使う。
 */
export const PHOTO_TRANSCRIBE_NUM_CTX = 8192;

/**
 * 1ページの答えに見込むトークン。測定（`num_predict` 4,096）と同じ。
 * 手元のAIへは上限として送らない（6.58.2）。繰り返しは途中で止める仕組みが受ける
 */
export const PHOTO_TRANSCRIBE_OUTPUT_TOKENS = 4096;

/**
 * 指示に書く言葉のうち、そのまま答えとして返ってきうるもの。
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（CLAUDE.md の
 * 「繰り返し起きた失敗3」）。プロンプトはこの定数から言葉を埋め込み、
 * 検算（`core/photoTranscribeValidation.ts`）は同じ定数で、**行の全体が
 * これと同じ**ものだけを捨てる（本文の中に同じ語が出ることはある）。
 */
const LINE_HINT = "紙の1行";
const UNREADABLE_HINT = `読めない字は1字ごとに${UNREADABLE_MARK}`;

export const PHOTO_TRANSCRIBE_HINTS: readonly string[] = [
  LINE_HINT,
  UNREADABLE_HINT,
  "読めない字",
  "書き起こした文",
  "書き起こし",
  "一字一句",
  "推測で補わない",
  "空いている行は書かない",
  "（読めない）",
  "（判読不能）",
  "判読不能",
  "text",
];

export const PHOTO_TRANSCRIBE_SYSTEM_PROMPT = `あなたは、手書きの原稿を写真から書き起こす係です。写真に書いてある字を、書いてあるとおりに文字へ写します。

【絶対に守る原則】
1. 一字一句、書いてあるとおりに写すこと。言葉を足さない・削らない・言い換えない・順番を変えない。
2. 昔の字体や言い回しを今の書き方へ直さないこと（「云う」を「言う」に、「居た」を「いた」に、「言へば」を「言えば」に直さない）。
3. 読めない字を推測で補わないこと。読めない字は1字ごとに${UNREADABLE_MARK}と書く。
4. 写真の説明・感想・前置き・まとめを書かないこと。
5. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・マークダウンのコードフェンスを一切含めないこと。`;

/**
 * 依頼文。写真は別に添える（`GenerateParams.images`）。
 *
 * @param pageLabel 「1枚目・左のページ」のような、作者に見せる名前。AIの読みには
 *   使わないが、どのページの依頼かをログで追えるように入れる
 */
export function buildPhotoTranscribePrompt(pageLabel: string): string {
  return `添えた写真は、手書きの原稿の1ページ（${pageLabel}）です。書いてある字を書き起こしてください。

【答え方】
- lines には、${LINE_HINT}を1つの要素として、上から順に入れてください（縦書きなら右の行から順に）。
- 各要素の text には、その行に書いてある字だけを、書いてあるとおりに入れてください。
- ${UNREADABLE_HINT}と書いてください。推測で補わないでください。
- 段落の頭が字下げされていれば、行の頭に全角の空白を1つ入れてください。
- 空いている行は書かないでください。
- 行の上や横に小さく書き足された字、取り消し線の引かれた字、「挿入①」のような印も、見えるとおりの字で写してください。差し込む場所を決めたり、取り消された字を消したりしないでください。
- この指示の言葉や、写真の説明を書かないでください。`;
}

/**
 * 1ページぶんの依頼を組む。**製品（`features/photoTranscribe.ts`）も実接続の
 * 確かめ（`test/live/photoTranscribe.test.ts`）もここを通す**——測る道と
 * 製品の道を分けると、製品に無い不具合を見つけたことになる（CLAUDE.md の失敗5）。
 *
 * 中止の合図と記録の添え物（`signal`・`meta`）は呼ぶ側が足す。
 */
export function buildPhotoTranscribeRequest(input: {
  pageLabel: string;
  image: ImageInput;
  model: string;
  /** 手元のAIへ送る長さ。モデルの長さが短ければ呼ぶ側が縮めて渡す */
  numCtx: number;
}): GenerateParams {
  return {
    systemPrompt: PHOTO_TRANSCRIBE_SYSTEM_PROMPT,
    userPrompt: buildPhotoTranscribePrompt(input.pageLabel),
    images: [input.image],
    model: input.model,
    temperature: PHOTO_TRANSCRIBE_TEMPERATURE,
    numCtx: input.numCtx,
    plannedOutputTokens: PHOTO_TRANSCRIBE_OUTPUT_TOKENS,
    maxOutputTokens: PHOTO_TRANSCRIBE_OUTPUT_TOKENS,
    jsonSchema: PHOTO_TRANSCRIBE_SCHEMA,
    disableThinking: true,
  };
}

/** 構造化出力のスキーマ。1行を1つのオブジェクトにする（理由は冒頭） */
export const PHOTO_TRANSCRIBE_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
} as const;
