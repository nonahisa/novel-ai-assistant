/**
 * 出先のページの雛形の置き場（設計書6.115・6.116）。`vscode` に触らない。
 *
 * 雛形は拡張機能に同梱する（`media/outbox/`）。製品は MCP の束を
 * 版に依らない保管庫へ写して走らせるので、**雛形も束の隣へ同じ名前で写す**
 * （`features/writeAiInstructions.ts`）。MCP の `outbox.pack` は束の隣を先に、
 * 無ければ拡張機能（リポジトリ）の `media/outbox/` を探し、実在する道を返す。
 * 名前を2か所で別々に書くと、写した先と探す先がずれる。
 */

/** 出先の原稿箱（6.115）。拡張機能（リポジトリ）の根からの相対 */
export const OUTBOX_TEMPLATE_RELATIVE = ["media", "outbox", "outbox.html"] as const;

/** 出先の原稿箱を束の隣へ写すときの名前 */
export const OUTBOX_TEMPLATE_COPY_NAME = "outbox.html";

/** 出先の原稿エディター（6.116）。拡張機能（リポジトリ）の根からの相対 */
export const EDITOR_TEMPLATE_RELATIVE = ["media", "outbox", "editor.html"] as const;

/** 出先の原稿エディターを束の隣へ写すときの名前 */
export const EDITOR_TEMPLATE_COPY_NAME = "editor.html";

/** 束の隣へ写す雛形の一覧（写す側と探す側が同じ表を見る） */
export const PAGE_TEMPLATES = [
  { relative: OUTBOX_TEMPLATE_RELATIVE, copyName: OUTBOX_TEMPLATE_COPY_NAME },
  { relative: EDITOR_TEMPLATE_RELATIVE, copyName: EDITOR_TEMPLATE_COPY_NAME },
] as const;
