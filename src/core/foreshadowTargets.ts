import type { Foreshadow } from "../models/foreshadow";
import type { Chunk } from "./chunker";
import type { OpenForeshadowBrief } from "../prompts/foreshadowResolve";

/**
 * 回収を探すとき、そのチャンクに掛ける未回収の伏線を絞る（設計書6.35）。
 *
 * **張った話より後の本文にだけ掛ける。** それより前の本文へ掛けると、
 * 張った箇所そのものを「回収」と言い出す（誤検知は検証側の `planted_echo`
 * でも弾くが、送らないのがいちばん安い）。
 *
 * **話数が分からないもの（どちらか一方でも null）は外さない**——前後を
 * 決められないのに落とすと、話数の読めないファイルで回収が一度も
 * 見つからなくなる。
 *
 * ここに置くのは、拡張機能（`features/checkForeshadows.ts`）と MCP
 * （`mcp/tools/foreshadow.ts`）の両方が同じ規則を使うため（0.49.0 で
 * 一度写しになり、その場で寄せた。写しは黙って食い違う）。
 */
export function targetsFor(
  open: readonly Foreshadow[],
  chunk: Pick<Chunk, "chapterStart">
): Foreshadow[] {
  return open.filter((record) => {
    if (record.plantedChapter === null) return true;
    if (chunk.chapterStart === null) return true;
    return chunk.chapterStart >= record.plantedChapter;
  });
}

/** AIへ渡す形へ落とす（台帳の全項目は渡さない） */
export function toBrief(record: Foreshadow): OpenForeshadowBrief {
  return {
    id: record.id,
    label: record.label,
    note: record.note,
    plantedQuote: record.plantedQuote,
    plantedChapter: record.plantedChapter,
  };
}
