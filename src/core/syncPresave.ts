import { basename, isPathInside, pathKeyForComparison } from "./pathText";
import { containsConflictMarkers } from "./mergeGuard";

/**
 * 「すべて同期」で、記録（コミット）の前に保存する文書を選ぶ（設計書5.5.19）。
 *
 * 作者の裁定（2026-10-04）：「記録の前に自動で保存する」。
 *
 * 作者の画面で「未記録1」が、同期しても1に戻る件が続いていた
 * （`files.autoSave: afterDelay`）。同期の時点で保存されていない話は
 * `git add -A` に入らず、そのあと自動保存で書かれて未記録に戻る——という
 * 筋が疑わしい。記録の前に、その置き場の作品の中の未保存を保存する。
 *
 * ## 保存するのは、同期する作品のフォルダーの中だけ
 *
 * 置き場（リポジトリ）の根ではなく、**登録された作品のフォルダー**で絞る。
 * 書庫の根には登録していないフォルダーもあり、そこで作者が開いている
 * 書きかけを、同期の都合で勝手に確定させない。ほかの作品・作品の外の
 * ファイルも同じ理由で触らない。
 *
 * ## 競合の印が入った文書は保存しない
 *
 * 保存すると印ごとディスクへ書かれ、続く `git add -A` が履歴へ入れる
 * （設計書5.5.3）。保存せずに止め、どの話かを知らせる。
 *
 * VS Code に依存しない（文書の事実は呼び出し側が読んで渡す）。
 */

/** 開いている文書1つぶんの事実 */
export interface PresaveDocument {
  filePath: string;
  isDirty: boolean;
  /** まだ名前の無い文書（保存すると場所を訊かれる。同期では触らない） */
  isUntitled: boolean;
  /** いまの本文。未保存で作品の中にあるものだけ読む（ほかは読まない） */
  readText(): string;
}

/** 選んだ結果 */
export interface PresavePick {
  /** 保存する文書 */
  save: string[];
  /** 競合の印が入っているので保存しない文書 */
  conflicted: string[];
}

/** その場所が、どれかの作品フォルダーの中か */
export function isInsideAnyFolder(
  folders: readonly string[],
  filePath: string
): boolean {
  return folders.some((folder) => isPathInside(folder, filePath));
}

/**
 * 記録の前に保存する文書を選ぶ。
 *
 * **同じ文書を二度数えない**（大文字小文字・区切りの違いだけの道は、
 * Windows では同じ文書である）。
 */
export function pickPresaveDocuments(
  documents: readonly PresaveDocument[],
  folders: readonly string[]
): PresavePick {
  const save: string[] = [];
  const conflicted: string[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    if (!document.isDirty || document.isUntitled) continue;
    if (!isInsideAnyFolder(folders, document.filePath)) continue;
    const key = pathKeyForComparison(document.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    if (containsConflictMarkers(document.readText())) {
      conflicted.push(document.filePath);
    } else {
      save.push(document.filePath);
    }
  }
  return { save, conflicted };
}

/** 保存できなかった理由 */
export type PresaveFailureReason =
  /** 競合の印が入っているので保存しなかった */
  | "conflict"
  /** 保存を頼んだが、保存されなかった */
  | "saveFailed"
  /** 原稿エディターで打った字を、原稿へ入れられなかった */
  | "rejected"
  /** 原稿エディターで打った字が原稿へ入るのを、待ちきれなかった */
  | "timeout"
  /** 原稿エディターの画面に、まだ原稿へ届いていない字がある */
  | "unsent";

export interface PresaveFailure {
  filePath: string;
  reason: PresaveFailureReason;
}

export const PRESAVE_FAILURE_TEXT: Record<PresaveFailureReason, string> = {
  conflict: "競合の印（<<<<<<<）が入っているので保存しませんでした",
  saveFailed: "保存できませんでした",
  rejected: "原稿エディターで打った字を原稿へ入れられませんでした",
  timeout: "原稿エディターで打った字が原稿へ入り終わるのを待ちきれませんでした",
  unsent: "原稿エディターの画面の字が、まだ原稿へ届いていません",
};

/**
 * 保存できなかった話を、報告の1行にまとめる。
 *
 * **どの話が、なぜ保存できなかったかを出す。** 「保存できませんでした」
 * だけでは、作者はどれを開いて直せばよいか分からない。
 * 同じ話に理由が2つ付いたら（画面の字が届かず、保存も通らなかった等）、
 * 先に見つけた方だけを出す——直す手は同じ画面にある。
 */
export function describePresaveFailures(
  failures: readonly PresaveFailure[]
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const failure of failures) {
    const key = pathKeyForComparison(failure.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(
      `「${basename(failure.filePath)}」（${PRESAVE_FAILURE_TEXT[failure.reason]}）`
    );
  }
  return (
    `保存できなかった話があるので、記録を止めました：${parts.join("、")}。` +
    "保存してから、もう一度同期してください。"
  );
}
