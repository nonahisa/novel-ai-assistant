import type { WorkEntry } from "../models/types";
import { parsePlotMarkdown } from "./plotDoc";
import { readPlotText } from "./plotFile";

/**
 * 作品の作法（設計書6.8.14）の、**作者の文書を読む部分**。
 *
 * 作法そのものの組み立て（`collectWorkStyle`・`buildStyleNote`）は
 * `workStyleFacts.ts` にある。分けたのは、**`plot.md` を読む道が
 * `vscode.workspace.fs` を通る**からで、外から呼ぶ束（設計書6.87.8）が
 * 文体メモを組み立てられなくなる。**文体メモを渡さないと、文語体の作品で
 * 漢字ひらきの指摘が乱発する**（F-21で実測）ので、MCP からも同じものを通す。
 *
 * **使う側の既定はこれまでどおりここ。** 作法の組み立ても再輸出する。
 */
export {
  detectFirstPerson,
  collectWorkStyle,
  buildStyleNote,
} from "./workStyleFacts";
export type { WorkStyleFacts } from "./workStyleFacts";

/**
 * `plot.md` の「人称」を読む。
 *
 * **誤字脱字と推敲の両方が要る。** 別々に書くと、片方だけ直したときに
 * 同じ本文へ違う前提を渡すことになる。
 *
 * 読めなければ空文字（プロットを作っていない作品もある）。
 */
export async function readNarrativePerson(work: WorkEntry): Promise<string> {
  try {
    const sections = parsePlotMarkdown(await readPlotText(work)).sections;
    return sections.narrativePerson.trim();
  } catch {
    return "";
  }
}
