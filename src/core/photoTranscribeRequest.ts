import { hasConflictMarkers } from "./textDecode";

/**
 * 写真の書き起こしの「AIへの頼み」（設計書6.117.7）。純粋関数だけを置く。
 *
 * 作者が画面に自由に書く1〜数行（「旧字体はそのまま」「ルビの小さい字は（）に
 * 入れる」）。依頼文の末尾に添える（`prompts/photoTranscribe.ts`）。
 *
 * 置き場は作品フォルダーの `.aiwriter/photo-transcribe-request.json`
 * （読み書きは `photoTranscribeRequestStore.ts`）。ここにはその中身の形と、
 * 字数の確かめだけを置く——画面の組み立て（`views/`）からも上限を読むため、
 * VS Code にもファイルにも触れない形にしておく。
 */

/** 頼みの上限（字。サロゲートペアも1字に数える）。画面も同じ数え方で数える */
export const PHOTO_REQUEST_MAX_CHARS = 300;

/** 置き場のファイル名（作品の `.aiwriter/` の直下） */
export const PHOTO_REQUEST_FILE_NAME = "photo-transcribe-request.json";

/** ファイルの形の版。形を変えたら上げる */
export const PHOTO_REQUEST_FILE_VERSION = 1;

/** 改行を LF に揃え、前後の空白を落とす。**中の改行はそのまま** */
export function normalizePhotoRequest(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** 字数。画面の数え方（`Array.from`）と揃える。`length` は絵文字などを2字に数える */
export function countPhotoRequestChars(text: string): number {
  return Array.from(normalizePhotoRequest(text)).length;
}

export type PhotoRequestCheck =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 送ってよい頼みか。**上限を超えたら黙って切らない**——切った残りが
 * 作者の意図と違う頼みになるため。理由を返して、作者に縮めてもらう
 */
export function checkPhotoRequest(raw: unknown): PhotoRequestCheck {
  const text = typeof raw === "string" ? normalizePhotoRequest(raw) : "";
  const chars = Array.from(text).length;
  if (chars > PHOTO_REQUEST_MAX_CHARS) {
    return {
      ok: false,
      reason: `AIへの頼みが${PHOTO_REQUEST_MAX_CHARS}字を超えています（${chars}字）。縮めてから、もう一度［書き起こす］を押してください。`,
    };
  }
  return { ok: true, text };
}

/**
 * 頼みの各行。答えに頼みの文が行ごと返ってきたら捨てるのに使う
 * （指示の言葉は答えに返ってくる。CLAUDE.md の失敗3）
 */
export function photoRequestEchoes(request: string): string[] {
  return normalizePhotoRequest(request)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** 置き場のファイルを読んだ結果。読めないときは**理由を持って止まる**（直さない） */
export type PhotoRequestFileRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly kind: "conflict" | "broken"; readonly reason: string };

/**
 * 置き場のファイルの中身を読む。
 *
 * - **先に競合マーカーを見る。** 2台で書き換えて git が両方を残したファイルは
 *   JSON として読めないが、「壊れています」と言うと作者は何が起きたか分からない。
 *   「同期で両方の頼みが残っている」と言えば、ファイルを開いて片方を消せばよいと分かる
 * - 壊れた JSON・形の違うものは直さずに止める（実装ルール2）
 * - 上限を超えた文は**そのまま返す**（作者がファイルを手で直した場合）。切らずに
 *   画面へ入れ、画面と［書き起こす］の確かめが「縮めてください」と出す
 */
export function parsePhotoRequestFile(content: string): PhotoRequestFileRead {
  // 先頭の BOM はメモ帳などで保存し直すと付く。中身ではないので落とす
  const text = content.replace(/^﻿/, "");
  if (hasConflictMarkers(text)) {
    return {
      ok: false,
      kind: "conflict",
      reason:
        `AIへの頼みのファイル（.aiwriter/${PHOTO_REQUEST_FILE_NAME}）に、同期で2つの版が` +
        "混ざった印（<<<<<<< など）が入っています。ファイルを開いて残す頼みを1つにしてから、" +
        "この画面を開き直してください。それまでは頼みを覚え直しません（いま欄にある頼みで書き起こしはできます）。",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, kind: "broken", reason: brokenReason(error instanceof Error ? error.message : String(error)) };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, kind: "broken", reason: brokenReason("中身が { } の形ではありません") };
  }
  const request = (raw as Record<string, unknown>).request;
  if (request === undefined) return { ok: true, text: "" };
  if (typeof request !== "string") {
    return { ok: false, kind: "broken", reason: brokenReason("request が文字列ではありません") };
  }
  return { ok: true, text: normalizePhotoRequest(request) };
}

function brokenReason(detail: string): string {
  return (
    `AIへの頼みのファイル（.aiwriter/${PHOTO_REQUEST_FILE_NAME}）を読めません（${detail}）。` +
    "ファイルは直さずにそのままにしてあります。開いて直すか消してから、この画面を開き直してください。" +
    "それまでは頼みを覚え直しません（いま欄にある頼みで書き起こしはできます）。"
  );
}

/** 置き場のファイルの中身。末尾に改行を付ける（git の差分で「改行なし」と出さない） */
export function formatPhotoRequestFile(text: string): string {
  return `${JSON.stringify(
    { version: PHOTO_REQUEST_FILE_VERSION, request: normalizePhotoRequest(text) },
    null,
    2
  )}\n`;
}
