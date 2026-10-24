import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 組んで書く面の呼び名（設計書6.34）。
 *
 * 組んで書くは 0.24.14 から既定の面で、面は「組んで書く」と「書く」の2つだけになった。
 * それでも安全弁の知らせには「組んで書く（実験）」が残っており、作者が
 * 「実験」を外すと裁定した（2026-10-24 夜）。消えた面（読む面）を数える
 * 「上の3面」も、今の事実と合わないので残さない。
 */
const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");

describe("組んで書く面の呼び名", () => {
  it("「組んで書く（実験）」と書かない", () => {
    expect(html).not.toContain("組んで書く（実験）");
  });

  it("消えた面を数える「3面」と書かない", () => {
    expect(html).not.toContain("3面");
  });

  it("安全弁の知らせは「組んで書く」の名で、戻り先の「書く」面を示す", () => {
    expect(html).toContain("組んで書くは、この原稿では開けませんでした。");
    expect(html).toContain("組んで書くを閉じました。");
  });
});
