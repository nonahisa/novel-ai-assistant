import * as vscode from "vscode";
import * as path from "../core/paths";
import { AIWRITER_DIR, type WorkEntry } from "../models/types";
import { atomicWriteFile } from "../core/atomicWrite";
import { logFailure } from "../core/logger";

/**
 * 「前に反映したのと同じか」を覚えておく覚え書き。
 *
 * プロットからの反映（設計書6.4.9）と相談からの反映（6.72）が使う。
 * どちらも**同じ提案を二度積まない**ために、前回の内容ハッシュを持つ。
 *
 * **`.aiwriter` に置くのは、これが台帳ではなく機械の覚え書きだから**である
 * （承認待ちやチャンクキャッシュと同じ置き場）。作者が読む `設定/` を
 * 未確定のファイルで散らかさない。消えても、同じ提案がもう一度積まれる
 * だけで済む（別の端末で反映済みなら、差分が無いので何も起きない）。
 *
 * **2か所で同じ処理を書かない。** 片方だけ直したときに「プロットからは
 * 二度積まれないのに、相談からは積まれる」という食い違いが出る。
 */

function statePath(work: WorkEntry, fileName: string): string {
  return path.join(work.folderPath, AIWRITER_DIR, fileName);
}

/** 前回の内容ハッシュ。無い・壊れていれば undefined */
export async function readSyncDigest(
  work: WorkEntry,
  fileName: string,
  key: string
): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(statePath(work, fileName))
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    // 覚え書きなので、無ければ「まだ積んでいない」と読めばよい。
    // 壊れていても直さない（次の書き込みで作り直る）
    return undefined;
  }
}

/**
 * 今回の内容ハッシュを覚える。
 *
 * **書けなくても失敗にしない。** 積んだこと自体は成立しており、
 * 次に押したときに同じ提案がもう一度並ぶだけで済む。
 */
export async function writeSyncDigest(
  work: WorkEntry,
  fileName: string,
  key: string,
  digest: string,
  label: string
): Promise<void> {
  const target = statePath(work, fileName);
  try {
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    const body = `${JSON.stringify(
      { [key]: digest, updatedAt: new Date().toISOString() },
      null,
      2
    )}\n`;
    // 機械の覚え書きなので上書きしてよい（作者の原稿ではない）
    await atomicWriteFile(target, new TextEncoder().encode(body));
  } catch (error) {
    logFailure(`${label}の覚え書きを保存できませんでした`, {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }
}
