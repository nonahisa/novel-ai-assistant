/**
 * P-49 写真の向きと見開きを尋ねる（設計書6.117.11）
 *
 * 写真から原稿を起こす画面で、写真を読み込んだあと・書き起こす前に、
 * **手元のAIだけ**へ小さくした写真（長辺1,024px）を渡し、
 * 「字の頭がどの辺を向いているか」と「見開きか1ページか」だけを尋ねる。
 * 答えは画面の既定（回す角度・左右に切るか）に使い、作者がボタンで直せる。
 *
 * ## 角度ではなく「字の頭の向き」を尋ねる
 *
 * 「何度回せば直るか」は頭の中で回す問いになる。「字の頭が写真のどの辺を
 * 向いているか」は見たままを答えればよい。回す角度への読み替えはコードが行う。
 *
 * ## 回した写しで何度か尋ね、2つ以上が一致したときだけ推す
 *
 * 1回だけ尋ねた答えは当てにならない（2026-10-12、作者の写真4枚を4通りに
 * 回した16枚。gemma4:e4b はどの向きにも16枚とも「上」、gemma4:26b は
 * 11〜13枚で、逆さの写真をほとんど当てない）。そこで、見えている向きと、
 * 右へ90度・左へ90度回した写しを別々に尋ね（`ORIENT_PROBE_TURNS`）、
 * **読み替えた向きが2つ以上一致したときだけ推す**
 * （`core/photoOrientValidation.ts` の `combinePhotoOrient`）。いつも同じ辺を
 * 答えるモデルは、回した写しで読み替えた向きが必ずばらけるので、
 * モデルの名前で決めずに外せる（規則6）。逆さ（180度）の写しは使わない
 * ——いちばん当たらない向きで、一致を邪魔するだけだった。
 *
 * ## 長辺1,024px
 *
 * 字の形が見えないと向きは分からない。gemma4:26b の1回の当たり（16枚）は
 * 長辺640pxで6、768pxで7、1,024pxで11〜13だった（2026-10-12）。
 *
 * ## 答えは列挙だけ
 *
 * 自由な文を受けない（実装ルール6）。スキーマの列挙に無い値は、
 * 推さなかったことにする。
 *
 * プロンプトを変更したら version を上げること。
 */
import type { GenerateParams, ImageInput } from "../ai/types";

/**
 * 変更履歴
 * - 1.0: 初版（0.103.10）
 */
export const PHOTO_ORIENT_VERSION = "1.0";

/** 向きを尋ねる写真の長辺（px）。字の形が見える大きさ（理由は冒頭） */
export const PHOTO_ORIENT_EDGE = 1024;

/**
 * 尋ねる写しの回し方（見えている向きから時計回りの角度）。**この順に尋ねる。**
 * 最初の2つが一致すれば3つ目は尋ねない（時間の節約）
 */
export const ORIENT_PROBE_TURNS = [0, 90, 270] as const;
export type OrientProbeTurn = (typeof ORIENT_PROBE_TURNS)[number];

/**
 * 手元のAIへ送る `num_ctx`（規則6）。写真1枚（gemma4 で約550〜1,100トークン）と
 * 短い指示・短い答えで足りる
 */
export const PHOTO_ORIENT_NUM_CTX = 4096;

/** 答えは2つの列挙だけなので、短く切る */
export const PHOTO_ORIENT_OUTPUT_TOKENS = 64;

/** 字の頭が向いている辺。列挙の値は英語の短い語にして、指示の日本語が答えに混ざらないようにする */
export const ORIENT_TOPS = ["up", "right", "down", "left"] as const;
export type OrientTop = (typeof ORIENT_TOPS)[number];

/** 見開き（左右2ページ）か1ページか */
export const ORIENT_LAYOUTS = ["single", "spread"] as const;
export type OrientLayout = (typeof ORIENT_LAYOUTS)[number];

export const PHOTO_ORIENT_SYSTEM_PROMPT = `あなたは、手書きのノートを撮った写真の向きを見分ける係です。出力は指定されたJSON形式のみとし、前置き・後書き・説明文・マークダウンのコードフェンスを一切含めないこと。`;

export function buildPhotoOrientPrompt(): string {
  return `添えた写真は、手書きの日本語のノートを撮ったものです。横倒しや逆さまのことがあります。字の頭（正しく読むときの上の側）が写真のどの辺を向いているかを top に答えてください。上の辺なら up、右の辺なら right、下の辺なら down、左の辺なら left。また、字を正しい向きに直したとき、ノートの見開き（左右に2ページが並んでいる）なら layout に spread、1ページだけなら single と答えてください。`;
}

/**
 * 1枚ぶんの依頼を組む。**製品（`features/photoTranscribe.ts`）も実接続の
 * 確かめ（`test/live/photoOrient.test.ts`）もここを通す**（CLAUDE.md の失敗5）。
 * 中止の合図と記録の添え物は呼ぶ側が足す。
 */
export function buildPhotoOrientRequest(input: {
  image: ImageInput;
  model: string;
  /** モデルの長さが短ければ呼ぶ側が縮めて渡す */
  numCtx: number;
}): GenerateParams {
  return {
    systemPrompt: PHOTO_ORIENT_SYSTEM_PROMPT,
    userPrompt: buildPhotoOrientPrompt(),
    images: [input.image],
    model: input.model,
    temperature: 0,
    numCtx: input.numCtx,
    plannedOutputTokens: PHOTO_ORIENT_OUTPUT_TOKENS,
    maxOutputTokens: PHOTO_ORIENT_OUTPUT_TOKENS,
    jsonSchema: PHOTO_ORIENT_SCHEMA,
    disableThinking: true,
  };
}

/** 構造化出力のスキーマ。列挙だけ */
export const PHOTO_ORIENT_SCHEMA = {
  type: "object",
  properties: {
    top: { type: "string", enum: [...ORIENT_TOPS] },
    layout: { type: "string", enum: [...ORIENT_LAYOUTS] },
  },
  required: ["top", "layout"],
  additionalProperties: false,
} as const;
