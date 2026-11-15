import * as vscode from "vscode";
import * as path from "./paths";
import { hashBytes } from "./hash";
import { isFileNotFound } from "./fsErrors";
import { atomicWriteFile, RECOVERY_DIRECTORY_NAME } from "./atomicWrite";

/**
 * 「読んで、足して、書き戻す」口の、書く前の照合（2026-11-15 作者の決定「足す」）。
 *
 * 1つのファイルを丸ごと読み、手元で足してから書き戻す口は、読んでから書くまでの
 * あいだに外（別の窓・同期・作者の手）で同じファイルが書き換えられても、
 * 確かめずに上書きしていた。外の変更は黙って消える。
 *
 * 考え方は `SettingsStore.assertSaveAllowed`・`ChapterStore.assertSaveAllowed` と同じ
 * ——**読んだときと同じ中身がそこにあるときだけ書く**。消えていた・作られていた・
 * 書き換わっていた、のどれも止める。各ストアが同じ判定を写さないよう、ここに1つ置く。
 *
 * 照合から実際に書くまでの一瞬の隙間は残る（公開のファイルの API に「同じ版なら置き換え」を
 * 1手で行う口が無い。`SettingsStore` と同じ）。
 */

/**
 * 読んだときの控え。
 *
 * - `undefined`：この口ではまだ読んでいない（または読めなかった）
 * - `null`：読んだとき、ファイルは無かった
 * - 文字列：読んだときの中身のハッシュ
 *
 * **「無かった」と「読んでいない」を分ける。** 分けないと、読めずに飛ばしたファイルや
 * あとから同期で届いたファイルを「新規」とみなして上書きしてしまう
 * （`SettingsStore` の控え無しの枝と同じ理由）。
 */
export type ReadSnapshot = string | null | undefined;

/** 読んだ中身から控えを作る（無かったなら null） */
export function snapshotOf(bytes: Uint8Array | null): string | null {
  return bytes ? hashBytes(bytes) : null;
}

/** 外で起きていたこと */
export type ExternalChange = "changed" | "deleted" | "created";

/**
 * 書く直前に、読んだときから外で変わっていないかを見る。変わっていなければ null。
 *
 * 「読んでいない（`undefined`）」は、いま無ければ通す（最初の1つを作るだけなので
 * 誰の中身も消さない）。いまあれば止める。
 */
export async function detectExternalChange(
  target: string,
  snapshot: ReadSnapshot
): Promise<ExternalChange | null> {
  let current: Uint8Array | null = null;
  try {
    current = await vscode.workspace.fs.readFile(path.toUri(target));
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
  if (!current) return typeof snapshot === "string" ? "deleted" : null;
  if (typeof snapshot !== "string") return "created";
  return hashBytes(current) === snapshot ? null : "changed";
}

/**
 * 書けなかった中身を、回復先（`.novelai-recovery`）に控える。控えた場所を返す。
 *
 * **退避の写し（`*.bak`）とは別の名前にする。** 退避の写しは「その時点の正規の版」で、
 * 話のタイムライン（設計書6.119）が過去の版として並べ、5世代で古いものから消える。
 * まだ一度も正規の場所に入っていない案を同じ名前で置くと、古い版に見えるうえ、
 * 本物の退避を1世代押し出す。そこで `bookStore` の未保存の下書き（`book.json.draft`）と
 * 同じく、ファイルごとに1つの決まった名前で、最後に書けなかった中身だけを持つ。
 *
 * 控えられなくても、止めたこと自体は伝えたいので投げない（undefined を返す）。
 */
export async function keepUnsavedCopy(
  target: string,
  bytes: Uint8Array
): Promise<string | undefined> {
  const directory = path.join(path.dirname(target), RECOVERY_DIRECTORY_NAME);
  // `.json` で終わらせない（`book.json.draft` と同じ）。`*.json` を拾う読み手が
  // 回復先を除き忘れても、資料や台帳として読まれない
  const copy = path.join(directory, `${path.basename(target)}.unsaved`);
  try {
    await vscode.workspace.fs.createDirectory(path.toUri(directory));
    // 拡張機能だけが書く管理領域のファイルなので、指定なし（上書き）の道で置き換える
    await atomicWriteFile(copy, bytes);
    return copy;
  } catch {
    return undefined;
  }
}

/** 止めたときの知らせの材料 */
export interface ExternalChangeNotice {
  /** 作者から見た名前（「各話あらすじ」など） */
  label: string;
  /** 作品フォルダーからの場所（「設定/chapter_synopses.json」など） */
  fileLabel: string;
  change: ExternalChange;
  /** 書けなかった中身を控えた場所。控えていなければ省く */
  unsavedCopy?: string;
}

/**
 * 止めたときの知らせ。**保存していないことを先に書く**（実装スタイル「失敗を含む知らせは、
 * 届いていないことを先に書く」）。次にすることを1つ添える。
 * 書き換えた手を「別の機器から」と決め打ちしない（同期・手での編集・別の窓、と道は複数ある）。
 */
export function externalChangeMessage(notice: ExternalChangeNotice): string {
  const reason =
    notice.change === "changed"
      ? "読み込んだあとに、ほかの操作（同期・手での編集・別の窓など）で書き換えられていた"
      : notice.change === "deleted"
        ? "読み込んだあとに、ほかの操作（同期・手での編集・別の窓など）で消されていた"
        : "読み込んだあとに作られていた（または読み込めなかった）";
  const kept = notice.unsavedCopy
    ? `保存しようとした内容は「${notice.unsavedCopy}」に控えました。`
    : "";
  return (
    `${notice.label}（${notice.fileLabel}）は保存していません。` +
    `${reason}ため、上書きすると先に書かれた内容が消えるからです。` +
    kept +
    "もう一度操作すると、いまの中身を読み直してから保存します。"
  );
}

/** 外部変更で止めた失敗か（各ストアの例外は `kind` に "modified_externally" を持つ） */
export function isExternalChangeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { kind?: unknown }).kind === "modified_externally"
  );
}
