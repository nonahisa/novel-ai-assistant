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
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return false;
  return BACKUP_FILE_EXTENSIONS.includes(fileName.slice(dot + 1).toLowerCase());
}
