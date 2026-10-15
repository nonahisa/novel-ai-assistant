/**
 * 焼いた表紙のファイル名（設計書6.65.8）。
 *
 * `coverBake.ts` から名前だけを出した（2026-10-15）。あちらは保存のために `vscode` を
 * 使うので、MCP サーバー（`cover.ink` が焼いた表紙を読む）からは import できない。
 * **名前の定義はここ1か所**——MCP 側に写すと、片方だけ名前が変わる日が来る。
 */

/** 表紙と裏表紙。焼いた画像はこの2枚しかない */
export type CoverSide = "front" | "back";

/**
 * 焼いた画像のファイル名。
 *
 * **「_合成済み」を名前に入れてある。** これがあるから、作者が手で置いた
 * `表紙.png` とぶつからず、生成物として上書きしてよいと分かる。
 */
export const BAKED_COVER_FILES: Record<CoverSide, string> = {
  front: "表紙_合成済み.png",
  back: "裏表紙_合成済み.png",
};
