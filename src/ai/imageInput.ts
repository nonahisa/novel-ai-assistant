import { AIError, type ImageInput, type ModelInfo, type ProviderId } from "./types";

/**
 * 写真（画像）をAIへ渡すための部品（設計書6.117.4）。
 *
 * **VS Code に依存しない。** プロバイダごとに違う送り方の組み立てと、
 * 「そのAIが写真を読めるか」の判定をここ1か所に置く——判定を選ぶ画面と
 * 書き起こしの機能の2か所に書くと、片方だけ直ったときに「選べたのに
 * 送ると断られる」ができる。
 */

/** 写真を読めるか。3つの値で持つ（「分からない」を「読めない」へ丸めない） */
export type ImageSupport =
  | { readonly kind: "yes" }
  /** 申告が無い。選べるが、送って断られたら、その失敗を出す */
  | { readonly kind: "unknown"; readonly note: string }
  | { readonly kind: "no"; readonly reason: string };

/** 「分からない」の行に添える文（選ぶ画面と書き起こしの画面で同じ言い方にする） */
export const IMAGE_SUPPORT_UNKNOWN_NOTE =
  "写真を読めるかは、AIが申告していません。送って断られたら知らせます。";

/**
 * そのプロバイダ・モデルが写真を読めるか。
 *
 * **モデル名で決めない**（CLAUDE.md 規則6）。申告（`ModelInfo.imageInput`）を
 * 返す3つ（Ollama・LM Studio・Claude）はそれに従い、申告の無い2つ（Gemini・
 * ChatGPT）は「分からない」。写真を送る口をこの製品が持たない2つ
 * （さくらのAI・VS Code 経由）は「読めない」。
 *
 * @param model 分かっていれば渡す。渡さなければ、プロバイダだけで決まる分を返す
 */
export function imageSupportFor(
  providerId: ProviderId,
  model?: Pick<ModelInfo, "imageInput">
): ImageSupport {
  switch (providerId) {
    case "sakura":
      return {
        kind: "no",
        reason: "さくらのAIへ写真を送れることを、まだ確かめていません。",
      };
    case "vscode-lm":
      return {
        kind: "no",
        reason: "VS Code 経由の接続は、文字だけを送る作りです。",
      };
    case "gemini":
    case "openai":
      // 一覧に申告が無い。名前で当て推量の表を持たない
      return { kind: "unknown", note: IMAGE_SUPPORT_UNKNOWN_NOTE };
    case "ollama":
    case "lmstudio":
    case "claude": {
      if (model?.imageInput === true) return { kind: "yes" };
      if (model?.imageInput === false) {
        return {
          kind: "no",
          reason: "このモデルは、写真を読めると申告していません。写真を読めるモデルを選んでください。",
        };
      }
      return { kind: "unknown", note: IMAGE_SUPPORT_UNKNOWN_NOTE };
    }
  }
}

/** 写真を送れる（読める、または分からない）か */
export function canSendImages(support: ImageSupport): boolean {
  return support.kind !== "no";
}

/**
 * 写真を送る口を持たないプロバイダで、写真を渡されたら止める。
 *
 * **黙って捨てない。** 捨てると写真を見ないまま依頼文だけで答えが作られ、
 * それらしい作文が「書き起こし」として返る（測定で、写真を読めない
 * 小さいモデルが読めない所を作文した。引継ぎ書8章 2026-10-11）。
 */
export function rejectImagesIfAny(
  images: readonly ImageInput[] | undefined,
  providerLabel: string
): void {
  if (!images || images.length === 0) return;
  throw new AIError(
    `${providerLabel}へは写真を送れません。写真を読めるAIを選んでください。`,
    "bad_response",
    `images: ${images.length}`
  );
}

/** Ollama の `/api/chat` の利用者の発言（`images` は頭の無い base64 の並び） */
export function ollamaUserMessage(
  text: string,
  images: readonly ImageInput[] | undefined
): Record<string, unknown> {
  return images && images.length > 0
    ? { role: "user", content: text, images: images.map((image) => image.base64) }
    : { role: "user", content: text };
}

/**
 * OpenAI互換（ChatGPT・LM Studio）の利用者の発言の中身。
 * 画像が無ければ従来どおり文字列のまま（送る形を変えない）。
 */
export function openAiUserContent(
  text: string,
  images: readonly ImageInput[] | undefined
): string | Array<Record<string, unknown>> {
  if (!images || images.length === 0) return text;
  return [
    { type: "text", text },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
    })),
  ];
}

/**
 * Anthropic の Messages API の利用者の発言の中身。
 * **画像を文より前に置く**（Anthropic の案内する並べ方）。
 */
export function claudeUserContent(
  text: string,
  images: readonly ImageInput[] | undefined
): string | Array<Record<string, unknown>> {
  if (!images || images.length === 0) return text;
  return [
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.base64 },
    })),
    { type: "text", text },
  ];
}

/** Gemini の `contents[].parts`。画像を文より前に置く */
export function geminiUserParts(
  text: string,
  images: readonly ImageInput[] | undefined
): Array<Record<string, unknown>> {
  return [
    ...(images ?? []).map((image) => ({
      inlineData: { mimeType: image.mimeType, data: image.base64 },
    })),
    { text },
  ];
}
