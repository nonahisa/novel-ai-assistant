import * as vscode from "vscode";
import { fromUri } from "./paths";
import * as path from "./paths";
import { hashBytes } from "./hash";
import { decodeBytes, hasConflictMarkers } from "./textDecode";
import type { Encoding, TextFileContent } from "./textDecode";
import {
  encodePreservingFormat,
  encodeTextFragment,
} from "./textEncodePreserving";
import {
  AtomicWriteFileError,
  atomicWriteFile,
  createManagedRecoveryPath,
  pruneManagedRecoveries,
} from "./atomicWrite";
import type { Eol } from "../models/types";

// バイト列の読み方（文字コード・改行・ハッシュ）は `textDecode.ts` にある
// ——`vscode` の要らない部分なので、外から呼ぶ束（設計書6.87.8）が
// 同じ判定を通せるように分けてある。**使う側はこれまでどおりここを指す**
export { decodeBytes };
export type { Encoding, TextFileContent };
// 改行コードの型は `models` に置いてある（走査の結果も持つため）。
// ここからは、これまでどおりの名前で再輸出する
export type { Eol };

export async function readTextFile(
  filePath: string
): Promise<TextFileContent> {
  const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath));
  return decodeBytes(bytes);
}

export type WriteTextFailureReason =
  | "modified_externally"
  | "path_conflict"
  | "conflict_markers"
  | "unsaved_changes"
  | "encoding_error";

export type WriteTextFileResult =
  /**
   * 書けた。`recoveryPath` は書き換える前の本文を退避した先
   * （`.novelai-recovery` の中の `.bak`）。**「元に戻す」を出すのに要る**——
   * この関数は「削除→作り直し」で書くため、VS Codeの取り消し履歴には
   * 載らず Ctrl+Z では戻せない（設計書6.12.5）。
   */
  | { ok: true; recoveryPath?: string }
  | {
      ok: false;
      reason: WriteTextFailureReason;
      detail?: string;
      recoveryPaths?: string[];
    };

export interface WriteTextFileOptions {
  /**
   * **書かなかった行の改行コードまで、`original.eol` に揃え直す。**
   *
   * 既定（`false`）は、これまでどおり**変わらなかったところの元バイトを
   * そのまま置く**——1文字直しただけで全行が変更扱いになるのを防ぐための
   * 決まりで（設計書5.4.2）、そこには改行のバイトも含まれる。つまり
   * **本文が同じなら、`eol` に別の値を渡しても1バイトも変わらない。**
   *
   * 「改行コードを揃える」（`features/eolUnify.ts`）だけは、変えたいものが
   * その改行そのものなので、ここを `true` にして通る。**本文の文字は
   * 1文字も変わらない**（改行以外のバイトは元のまま置く）。
   */
  rewriteEol?: boolean;
}

/**
 * 読み込み時と同じ形式で書き戻す。
 *
 * @param expectedHash 読み込み時のハッシュ。ディスク上の現在の内容と
 *   一致しない場合は書き込まず `{ ok: false, reason: "modified_externally" }` を返す
 *   （外部編集による上書き事故の防止）。
 */
export async function writeTextFilePreservingFormat(
  filePath: string,
  newText: string,
  original: Pick<TextFileContent, "encoding" | "eol" | "hasTrailingNewline">,
  expectedHash: string,
  options: WriteTextFileOptions = {}
): Promise<WriteTextFileResult> {
  const uri = path.toUri(filePath);

  if (hasUnsavedChanges(filePath)) {
    return { ok: false, reason: "unsaved_changes" };
  }

  if (hasConflictMarkers(newText)) {
    return { ok: false, reason: "conflict_markers" };
  }

  let current: Uint8Array;
  try {
    current = await vscode.workspace.fs.readFile(uri);
  } catch {
    // ファイルが消えている場合も外部変更として扱う
    return { ok: false, reason: "modified_externally" };
  }

  if (decodeBytes(current).hasConflictMarkers) {
    return { ok: false, reason: "conflict_markers" };
  }

  if (hashBytes(current) !== expectedHash) {
    return { ok: false, reason: "modified_externally" };
  }

  // バイト列の作り方は `textEncodePreserving.ts`（MCP の取り込みも同じものを通る。6.115）
  const bytes = encodePreservingFormat(current, newText, original, {
    rewriteEol: options.rewriteEol === true,
  });
  if (!bytes) {
    return { ok: false, reason: "encoding_error" };
  }

  /**
   * 公開FS APIには「期待した版なら置換」を一命令で行う原子的CASが無い
   * （`atomicWrite.ts` の `replaceGuarded` は、そのため正規パスへは触れず
   * 必ず失敗する）。人物設定など既存レコードの更新と同じ
   * 「①今の原稿を回復先へコピー → ②元ファイルを削除 → ③新しい内容で作り直す」
   * の手順で書き戻す。
   *
   * **退避は `rename` ではなく「コピー＋削除」で行う。** `rename` で退避すると、
   * そのファイルがエディターで開いている場合にVS Codeが開いたタブを
   * リネーム先（回復フォルダの中の `.bak` ファイル）へ追従させてしまい、
   * 開いていたタブが本文と無関係な回復ファイルを指したまま取り残される
   * （実機で発覚、2026-08-12・2026-08-13）。`delete` はリネームと違い
   * 「追従先」が無いため、この事故が起きない。
   */
  let recoveryPath: string;
  try {
    recoveryPath = await createManagedRecoveryPath(filePath);
  } catch (error) {
    return {
      ok: false,
      reason: "path_conflict",
      detail: `回復先を準備できませんでした: ${describeError(error)}`,
    };
  }

  let recheck: Uint8Array;
  try {
    // 退避の直前にもう一度ハッシュを確かめる。ここまでの間に
    // 外部から書き換えられている可能性がわずかに残るため
    recheck = await vscode.workspace.fs.readFile(uri);
    if (hashBytes(recheck) !== expectedHash) {
      return { ok: false, reason: "modified_externally" };
    }
  } catch {
    return { ok: false, reason: "modified_externally" };
  }

  try {
    // 今の原稿を回復先へコピーする（まだ元ファイルには触れない）
    await atomicWriteFile(recoveryPath, recheck, { mode: "create" });
  } catch (error) {
    const detail =
      error instanceof AtomicWriteFileError
        ? error.message
        : describeError(error);
    return {
      ok: false,
      reason: "path_conflict",
      detail: `回復先へコピーできませんでした: ${detail}`,
    };
  }

  try {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  } catch {
    // 削除できなければ原稿本体にはまだ触れていない。回復先のコピーだけ残るが実害はない
    return { ok: false, reason: "modified_externally" };
  }

  try {
    await atomicWriteFile(filePath, bytes, { mode: "create" });
  } catch (error) {
    // 新しい内容の配置に失敗しても、元の原稿は退避先にそのまま残っている
    const detail =
      error instanceof AtomicWriteFileError
        ? error.message
        : describeError(error);
    return {
      ok: false,
      reason: "path_conflict",
      detail: `元の原稿は「${recoveryPath}」に退避されています。${detail}`,
      recoveryPaths: [recoveryPath],
    };
  }

  await pruneManagedRecoveries(filePath);
  // 退避先を呼び出し側へ返す。いま作ったものが最新なので、
  // pruneManagedRecoveries（5世代まで残す）で消えることはない
  return { ok: true, recoveryPath };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 新しいファイルとして書き出すためのバイト列を作る。
 *
 * 競合の「両方を残す」（設計書5.5.4）で、別環境の版を
 * 別ファイルへ残すときに使う。**元のファイルと同じ文字コード・
 * 改行コードで書く。** 片方だけUTF-8/LFになると、あとで見比べる
 * ときに全行が変更扱いになって差分が読めなくなる。
 *
 * Shift_JISで表せない文字が混ざっていたら undefined を返す。
 * 代替文字に置き換えて「保存できた」ことにすると本文が壊れる。
 */
export function encodeForNewFile(
  text: string,
  original: Pick<TextFileContent, "encoding" | "eol" | "hasTrailingNewline">
): Uint8Array | undefined {
  let normalized = text.replace(/\r\n?/g, "\n");
  if (original.hasTrailingNewline && !normalized.endsWith("\n")) {
    normalized += "\n";
  } else if (!original.hasTrailingNewline) {
    normalized = normalized.replace(/\n+$/, "");
  }

  const body = encodeTextFragment(
    normalized.replace(/\n/g, original.eol),
    original.encoding
  );
  if (!body) return undefined;
  if (original.encoding !== "utf8-bom") return body;

  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(body, 3);
  return withBom;
}

/**
 * 内容のハッシュは `hash.ts` へ移した（設計書6.87.3）。
 *
 * **ここに置いたままだと、`hashText` を1つ借りるだけの `chunker.ts` が
 * `vscode` 依存になる。** 呼び出し側（`textFile.hashText` と書いている
 * 箇所）は変えなくてよいように、ここから再輸出する。
 */
export { hashBytes, hashText } from "./hash";

/** 現在ディスク上にあるファイルのハッシュを取得する */
export async function currentFileHash(
  filePath: string
): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(filePath)
    );
    return hashBytes(bytes);
  } catch {
    return undefined;
  }
}

/**
 * エディタで開いている未保存の内容を優先して取得する。
 * 文字数計測では書きかけの内容を反映する必要があるため。
 */
export function getOpenDocumentText(filePath: string): string | undefined {
  const doc = vscode.workspace.textDocuments.find(
    (d) => sameFilePath(fromUri(d.uri), filePath)
  );
  if (!doc) return undefined;
  return doc.getText();
}

/** 未保存の変更があるか */
export function hasUnsavedChanges(filePath: string): boolean {
  const doc = vscode.workspace.textDocuments.find(
    (d) => sameFilePath(fromUri(d.uri), filePath)
  );
  return doc?.isDirty ?? false;
}

/**
 * 同じファイルか。比べ方は `paths.isSamePath` の1か所（2026-09-24）。
 * ブラウザ版では、開いた文書の場所（`fromUri`）の日本語が符号化されて来るので、
 * そのまま比べると開いている話の書きかけが文字数に入らなかった
 */
export function sameFilePath(left: string, right: string): boolean {
  return path.isSamePath(left, right);
}
