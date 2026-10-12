import * as vscode from "vscode";
import * as path from "./paths";
import type { WorkEntry } from "../models/types";
import { atomicWriteFile } from "./atomicWrite";
import { isNotFound } from "./fileRead";
import { workPaths } from "./workRegistry";
import {
  PHOTO_REQUEST_FILE_NAME,
  checkPhotoRequest,
  formatPhotoRequestFile,
  parsePhotoRequestFile,
  type PhotoRequestFileRead,
} from "./photoTranscribeRequest";

/**
 * 写真の書き起こしの「AIへの頼み」の置き場（設計書6.117.7。作者の裁定、2026-10-12 夜）。
 *
 * **作品フォルダーの `.aiwriter/photo-transcribe-request.json`。** 2台のパソコンで
 * 同じ作品を書くとき、頼みも一緒に持っていけるようにする。作品の同期で GitHub へも
 * 送られる（作者が承知のうえで選んだ）。`IGNORED_PATHS` には入れない。
 *
 * **`.aiwriter/config.json` に1項目足す形にはしない。** config.json は同期で
 * 食い違ったとき片側を黙って残す側にある（`mergePreview.ts` の `isAutoWrittenPath`）。
 * 作者の書いた文をそこへ置くと、2台で違う頼みを書いたときに片方が消える。
 * 別のファイルにしておけば「作者のもの」として、食い違いは作者に見てもらう側へ回る。
 * また config.json が読めないと作品の一覧まで止まるので、頼みの壊れをそこへ
 * 広げない意味もある。
 *
 * 書き込みは拡張機能だけなので `atomicWriteFile` を引数無しで呼ぶ（③の
 * `replaceGuarded` ではない）。上書きで作者の文を消さない守りは、**書く直前に
 * 読み直して、この画面が知っている文と食い違っていれば書かない**ことで持つ
 * （`SettingsStore.assertSaveAllowed` と同じ考え方）。断っても作者の文は画面に
 * 残っているので、何も失わない。
 */

function filePath(work: WorkEntry): string {
  return path.join(workPaths(work).aiwriter, PHOTO_REQUEST_FILE_NAME);
}

/** その作品の頼みを読む。無ければ空。壊れていれば理由を返す（直さない） */
export async function readPhotoRequest(work: WorkEntry): Promise<PhotoRequestFileRead> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(path.toUri(filePath(work)));
  } catch (error) {
    if (isNotFound(error)) return { ok: true, text: "" };
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "broken",
      reason: `AIへの頼みのファイル（.aiwriter/${PHOTO_REQUEST_FILE_NAME}）を読めません（${detail}）。`,
    };
  }
  return parsePhotoRequestFile(new TextDecoder().decode(bytes));
}

export type PhotoRequestSave =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      /**
       * - `over`：上限を超えた（覚えない）
       * - `changed`：この画面が読んだあとに、ファイルの頼みが変わった（同期など）
       * - `conflict`・`broken`：ファイルが読めない（直さない）
       */
      readonly kind: "over" | "changed" | "conflict" | "broken";
      readonly reason: string;
    };

/**
 * 頼みを覚える。空なら置き場のファイルを消す。
 *
 * @param known この画面が最後に読んだ（または書いた）頼み。ファイルの頼みが
 *   これと違い、新しい頼みとも違えば、**書かずに断る**——別のパソコンで書いた
 *   頼みが同期で届いているのに、古い画面の文で上書きして消さないため
 */
export async function savePhotoRequest(
  work: WorkEntry,
  known: string,
  raw: string
): Promise<PhotoRequestSave> {
  const check = checkPhotoRequest(raw);
  if (!check.ok) return { ok: false, kind: "over", reason: check.reason };
  const next = check.text;

  const current = await readPhotoRequest(work);
  if (!current.ok) return current;
  if (current.text === next) return { ok: true, text: next };
  if (current.text !== known) {
    return {
      ok: false,
      kind: "changed",
      reason:
        "この画面を開いたあとに、AIへの頼みのファイルが書き換わりました（別のパソコンからの同期など）。" +
        "上書きして消さないよう、いまの欄の頼みは覚えていません（書き起こしには使えます）。" +
        "画面を開き直すと、ファイルの頼みが入ります。",
    };
  }

  if (next === "") {
    try {
      await vscode.workspace.fs.delete(path.toUri(filePath(work)));
    } catch (error) {
      // 既に無ければ消せたのと同じ
      if (!isNotFound(error)) throw error;
    }
    return { ok: true, text: "" };
  }
  await vscode.workspace.fs.createDirectory(path.toUri(workPaths(work).aiwriter));
  await atomicWriteFile(filePath(work), new TextEncoder().encode(formatPhotoRequestFile(next)));
  return { ok: true, text: next };
}
