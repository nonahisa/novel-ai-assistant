/**
 * バックアップとして受け取れるファイルの種類と大きさ（設計書6.99）。
 *
 * **ZIPの読み取り（`workZip.ts`）から分けて置く。** 相談パネルは起動のときに
 * 読み込まれるので、受け口の確かめ（拡張子・大きさ）のためだけに ZIP の
 * 展開の部品まで一緒に読み込ませない。取り込みの本体は、ファイルが
 * 落とされたときに初めて読む（`features/backupDrop.ts`）。
 *
 * VS Code API には依存しない。
 */

/**
 * 取り込める入れ物の拡張子（作者にファイルを選ばせるときの絞り込み）。
 *
 * **アルファポリスは ZIP ではなく `.txt` 直で降りてくる**（0.69.10）。
 * ここを `zip` だけにしておくと、選ぶ画面にそもそも出てこない。
 */
export const BACKUP_FILE_EXTENSIONS = ["zip", "txt", "md"];

/**
 * 相談パネルへの持ち込みを受け付ける大きさの上限（バイト）。
 *
 * 実物のなろうの合本は大きいもので2MB前後、ZIPで固めるともっと小さい。
 * 上限は、**取り違えて動画や別のアーカイブを落とした**ときに、読み込みで
 * 固まらないための柵である。画面の側でも同じ数で先に止める
 * （`views/workChatPanelHtml.ts` はこの値を受け取って使う）。
 */
export const BACKUP_DROP_MAX_BYTES = 64 * 1024 * 1024;

/** 上限を超えたときの言い方 */
export function tooLargeMessage(fileName: string): string {
  return (
    `「${fileName}」は大きすぎるため受け取れませんでした` +
    `（${Math.round(BACKUP_DROP_MAX_BYTES / 1024 / 1024)}MBまで）。` +
    "投稿サイトのバックアップかどうか、ご確認ください。"
  );
}

/** 拡張子（点なし・小文字）がバックアップとして受け取れるものか */
export function isBackupFileName(fileName: string): boolean {
  return BACKUP_FILE_EXTENSIONS.includes(extensionOf(fileName));
}

/**
 * Word 原稿の拡張子（作者の裁定、2026-09-23：相談パネルへ落とせるように）。
 *
 * **古い形式の `.doc` は入れない。** 中身が別物（ZIPではない）で、既存の
 * Word 変換（設計書6.85）も読めない。受け取ってから断るより、選ぶ画面に
 * 出さないほうが迷わない（落とされたら、バックアップでも Word でもないと言う）。
 */
export const WORD_FILE_EXTENSIONS = ["docx"];

/** 相談パネルへ落とせるものの拡張子（バックアップと Word 原稿） */
export const DROP_FILE_EXTENSIONS = [...BACKUP_FILE_EXTENSIONS, ...WORD_FILE_EXTENSIONS];

/** Word 原稿（.docx）か */
export function isWordFileName(fileName: string): boolean {
  return WORD_FILE_EXTENSIONS.includes(extensionOf(fileName));
}

/** 相談パネルへ落として受け取れるものか */
export function isDroppableFileName(fileName: string): boolean {
  return DROP_FILE_EXTENSIONS.includes(extensionOf(fileName));
}

/** 点なし・小文字の拡張子。無ければ空 */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
}
