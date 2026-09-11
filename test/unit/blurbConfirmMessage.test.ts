import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: {},
  workspace: { fs: {} },
  commands: {},
}));

import { blurbConfirmMessage } from "../../src/features/generateBlurb";

describe("作品紹介文の実行前の確認（0.45.3）", () => {
  test("各話あらすじが無いときは、本筋を外すことがあると添える", () => {
    const text = blurbConfirmMessage({
      model: "gemma4:26b",
      costNotice: "",
      synopsisCount: 0,
    });
    expect(text).toContain("各話あらすじがまだありません");
    expect(text).toContain("先に「各話あらすじを生成」");
    // 止めはしない。文面は「作ります」のまま
    expect(text).toContain("作品紹介文を作ります");
  });

  test("あらすじがあれば、これまでどおりの文面", () => {
    const text = blurbConfirmMessage({
      model: "gemma4:26b",
      costNotice: "\n有料です。",
      synopsisCount: 18,
    });
    expect(text).not.toContain("各話あらすじ");
    expect(text).toContain("モデル: gemma4:26b");
    expect(text).toContain("有料です。");
  });
});
