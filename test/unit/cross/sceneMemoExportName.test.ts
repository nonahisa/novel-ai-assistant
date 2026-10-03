import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 校正・メモパネルの書き出し（設計書6.40.4）の紙の名前（作者の裁定、2026-10-03）。
 *
 * 紙の名前は「校正・メモ」。前の名前「シーンメモ」の写しは、新しい名前では
 * 片づけに拾われないので、書き出すたびに**古い名前の写しも片づける**
 * （ほかの写しと同じ20件・30日。古い名前ではもう作らないので30日で消える）。
 * 片づけは置き場（`.aiwriter/generated/`）の写しだけで、本文の `//` の
 * メモには触れない（`test/unit/core/generatedFiles.test.ts` が確かめる）。
 */
describe("校正・メモの書き出しと、古い名前の片づけ", () => {
  const panel = readFileSync("src/features/sceneMemoPanel.ts", "utf8");
  const openDocument = readFileSync("src/views/openDocument.ts", "utf8");

  test("書き出しは古い名前（SCENE_MEMO_FORMER_TITLES）も片づけるよう頼む", () => {
    const start = panel.indexOf("private async exportMarkdown()");
    const body = panel.slice(start, panel.indexOf("\n  }\n", start));
    expect(body).toContain("openGeneratedMarkdown(");
    expect(body).toMatch(/formerKinds: SCENE_MEMO_FORMER_TITLES/);
  });

  /*
    **古い名前も、ほかの写しと同じ決まり（20件・30日）で片づける**（作者の
    裁定、2026-10-03。0.96.9 では書き出すたびに全部消していた）。決まりを
    渡さない＝既定の `GENERATED_PRUNE_POLICY` を使う。
  */
  test("古い名前は、ほかの写しと同じ決まり（既定）で、同じ置き場だけを片づける", () => {
    expect(openDocument).toMatch(
      /for \(const former of location\?\.formerKinds \?\? \[\]\)[\s\S]{0,200}pruneGeneratedFilesQuietly\(\s*directory,\s*former\s*\)/
    );
    expect(openDocument).not.toContain("RETIRED_GENERATED_PRUNE_POLICY");
  });
});
