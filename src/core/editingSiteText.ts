/**
 * 編集者の送り先と相手（`.aiwriter/editing.json`。設計書5.6）の中身を読む、純粋な部分。
 *
 * **`vscode` に触らない。** 読み書きの口（`features/editingSite.ts`）は `vscode.workspace.fs` を
 * 使うので、MCP サーバー（Node の `fs` で読む）からは import できない。MCP の原稿箱の取り込みが
 * 校閲中の理由に編集者の名前を出せず「編集者」とだけ出ていた（実装の残り 118行）。文字列から
 * 項目を取り出す所だけをここへ置き、両方が同じものを通す（写しを作らない）。
 */
export interface EditingSite {
  /** 編集用リポジトリの取り寄せ用URL（`https://github.com/owner/repo.git`） */
  remoteUrl?: string;
  /** 招待が通った編集者の GitHub 名 */
  editorLogin?: string;
  /**
   * 前の編集者の GitHub 名（0.138.0。作者の答え 2026-11-07）。解除で `editorLogin` を
   * 消すときに写す。次に「編集者へ渡す」で名前を訊くとき、初めの値に入れる（招待は送り直す）
   */
  formerEditorLogin?: string;
}

/** `EditingSite` の項目。書くときはこれだけを入れ替え、ほかの項目は残す */
export const EDITING_SITE_KEYS = ["remoteUrl", "editorLogin", "formerEditorLogin"] as const;

/**
 * ファイルの中身から項目を取り出す。空・壊れた JSON・形の違うものは `{}`。
 * **直さない**（読むだけ。壊れたファイルを書き直すのは作者の仕事。実装ルール2）
 */
export function parseEditingSite(text: string): EditingSite {
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const site: EditingSite = {};
  for (const key of EDITING_SITE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) site[key] = value;
  }
  return site;
}

/**
 * 校閲中の知らせに出す編集者の名前。いまの編集者、解除したあとは前の編集者。
 * どちらも無ければ `undefined`（知らせは「編集者」とだけ出る）。**鍵の holder（git の名前）は使わない**
 */
export function reviewLockLoginOf(site: EditingSite): string | undefined {
  return site.editorLogin ?? site.formerEditorLogin;
}
