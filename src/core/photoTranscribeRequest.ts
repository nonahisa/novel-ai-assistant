import type * as vscode from "vscode";
import { verifiedState } from "./verifiedMemento";

/**
 * 写真の書き起こしの「AIへの頼み」（設計書6.117.12）。VS Code の型だけに依存する。
 *
 * 作者が画面に自由に書く1〜数行（「旧字体はそのまま」「ルビの小さい字は（）に
 * 入れる」）。依頼文の末尾に添える（`prompts/photoTranscribe.ts`）。
 *
 * **置き場は `globalState`（作品IDごと）**。助言方針（`advicePolicyStore.ts`）と
 * 同じ形。作品フォルダーの `.aiwriter/` に置くと GitHub へ送られ編集部と共有されるが、
 * これは作者の手元の作業の癖で、共有するものではない。端末はまたがない。
 */

/** 頼みの上限（字。サロゲートペアも1字に数える）。画面も同じ数え方で数える */
export const PHOTO_REQUEST_MAX_CHARS = 300;

export const PHOTO_REQUEST_KEY_PREFIX = "novelai.photoTranscribeRequest.";

export function photoRequestKey(workId: string): string {
  return `${PHOTO_REQUEST_KEY_PREFIX}${workId}`;
}

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

export class PhotoTranscribeRequestStore {
  constructor(private readonly state: vscode.Memento) {}

  /** その作品の頼み。無ければ空 */
  get(workId: string): string {
    const stored = this.state.get<string>(photoRequestKey(workId));
    return typeof stored === "string" ? stored : "";
  }

  /**
   * 覚える。空なら消す。**上限を超えた頼みは覚えない**（呼ぶ側が先に
   * `checkPhotoRequest` で確かめる。ここでも念のため断る）
   */
  async set(workId: string, raw: string): Promise<boolean> {
    const check = checkPhotoRequest(raw);
    if (!check.ok) return false;
    if (check.text === this.get(workId)) return true;
    // globalState へは確かめて書く（設計書5.7.8。mementoWrites.test.ts が見張る）
    await verifiedState(this.state).update(
      photoRequestKey(workId),
      check.text === "" ? undefined : check.text
    );
    return true;
  }
}
