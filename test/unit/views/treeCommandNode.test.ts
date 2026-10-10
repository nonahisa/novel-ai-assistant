import { describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の右クリックの命令に、行が渡らなかったとき（0.102.8）。
 *
 * 一覧の描き直しの最中に品書きを押すと、VS Code は命令へ行の代わりに
 * `undefined` を渡す（`workTreeRedrawRace.test.ts` の説明）。これまでは
 * `if (!node) return;` で**黙って終わり**、作者には「押したのに何も起きない」
 * としか見えなかった。理由と次の一手（もう一度右クリック）を知らせる。
 */

vi.mock("vscode", () => ({
  window: { showWarningMessage: vi.fn() },
}));

import { requireTreeNode } from "../../../src/views/treeCommandNode";

describe("requireTreeNode", () => {
  test("行が渡ればそのまま返し、何も知らせない", () => {
    const warn = vi.fn();
    const node = { type: "episode" as const };

    expect(requireTreeNode(node, "この話の前に挿入", warn)).toBe(node);
    expect(warn).not.toHaveBeenCalled();
  });

  test("行が渡らなければ undefined を返し、理由と次の一手を1回知らせる", () => {
    const warn = vi.fn();

    expect(requireTreeNode(undefined, "この話の前に挿入", warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("この話の前に挿入");
    expect(message).toContain("右クリック");
    // 内輪の呼び名を画面に出さない
    expect(message).not.toContain("母艦");
  });

  test("null（VS Code が対応表に無い行を変換した値）も同じに扱う", () => {
    const warn = vi.fn();

    expect(requireTreeNode(null, "ここから章を始める", warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
