import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ scheme: "file", fsPath: p, path: p }),
    parse: (value: string) => ({ scheme: "x", fsPath: value, path: value }),
  },
}));

import {
  describeMergePlans,
  planMerge,
  shouldSkip,
} from "../../src/core/libraryMerge";
import type { WorkEntry } from "../../src/models/types";

/**
 * 別々に置かれている作品を、1つの書庫へまとめ直す（設計書5.7.10）。
 *
 * **上書きを絶対にしない**ための判定がここに集まっている。原稿を扱う操作なので、
 * 「移せない」と判定すべきものを取りこぼしていないかを機械で見張る。
 */

function work(title: string, folderPath: string): WorkEntry {
  return {
    id: title,
    title,
    folderPath,
    registeredAt: "2026-08-22T00:00:00.000Z",
  };
}

const none = new Set<string>();

describe("まとめる先を決める", () => {
  it("書庫の直下に、フォルダー名のまま置く", () => {
    const plans = planMerge(
      [work("いじめられっ子", "C:/小説/いじめられっ子")],
      "C:/小説/書庫",
      none
    );
    expect(plans[0].blocked).toBeUndefined();
    expect(plans[0].folderName).toBe("いじめられっ子");
    expect(plans[0].destination).toContain("書庫");
  });

  /**
   * **上書きは絶対にしない。** 名前が同じというだけで中身が同じとは限らない。
   */
  it("書庫に同じ名前があれば、移さない", () => {
    const plans = planMerge(
      [work("いじめられっ子", "C:/小説/いじめられっ子")],
      "C:/小説/書庫",
      new Set(["いじめられっ子"])
    );
    expect(plans[0].blocked).toContain("同じ名前");
  });

  it("同じ回の中で名前がぶつかれば、あとの1件を移さない", () => {
    // 別の場所に同じフォルダー名の作品があることがある
    const plans = planMerge(
      [
        work("旧版", "C:/小説/A/物語"),
        work("新版", "C:/小説/B/物語"),
      ],
      "C:/小説/書庫",
      none
    );
    expect(plans[0].blocked).toBeUndefined();
    expect(plans[1].blocked).toContain("同じ名前の作品が他にも");
  });

  it("すでに書庫の中にあるものは、移さない", () => {
    const plans = planMerge(
      [work("いじめられっ子", "C:/小説/書庫/いじめられっ子")],
      "C:/小説/書庫",
      none
    );
    expect(plans[0].blocked).toContain("すでに");
  });

  it("その作品そのものを書庫に選んだら、移さない", () => {
    const plans = planMerge(
      [work("いじめられっ子", "C:/小説/いじめられっ子")],
      "C:/小説/いじめられっ子",
      none
    );
    expect(plans[0].blocked).toBeDefined();
  });

  /** 自分の中へ自分を写すと、際限なく入れ子になる */
  it("書庫が作品の中にあれば、移さない", () => {
    const plans = planMerge(
      [work("いじめられっ子", "C:/小説/いじめられっ子")],
      "C:/小説/いじめられっ子/書庫",
      none
    );
    expect(plans[0].blocked).toContain("書庫がこの作品の中");
  });

  it("名前の先頭が同じだけなら、中にあるとは見なさない", () => {
    // 「書庫2」は「書庫」の中ではない
    const plans = planMerge(
      [work("別の作品", "C:/小説/書庫2/別の作品")],
      "C:/小説/書庫",
      none
    );
    expect(plans[0].blocked).toBeUndefined();
  });
});

describe("写さないもの", () => {
  /**
   * **`.git` を写すとリポジトリが入れ子になる。**
   * 書庫の側から見えなくなり、同期しても中身が出ていかない。
   */
  it("リポジトリそのものは写さない", () => {
    expect(shouldSkip(".git")).toBe(true);
    expect(shouldSkip(".git/config")).toBe(true);
  });

  it("再び作れるものは写さない", () => {
    expect(shouldSkip(".novelai-recovery/x.bak")).toBe(true);
    expect(shouldSkip(".aiwriter/cache/typo.json")).toBe(true);
    expect(shouldSkip(".aiwriter/logs/ai_actions.log")).toBe(true);
  });

  /** **これが無いと作品として認識されない** */
  it("作品の設定ファイルは写す", () => {
    expect(shouldSkip(".aiwriter/config.json")).toBe(false);
  });

  it("本文と設定資料は写す", () => {
    expect(shouldSkip("本文/001.txt")).toBe(false);
    expect(shouldSkip("設定/plot.md")).toBe(false);
    expect(shouldSkip("001.txt")).toBe(false);
  });

  it("名前の先頭が同じだけのフォルダーは写す", () => {
    // 「.gitignore」は「.git」ではない
    expect(shouldSkip(".gitignore")).toBe(false);
  });
});

describe("作者に見せる要約", () => {
  it("移すものと移せないものを、分けて並べる", () => {
    const plans = planMerge(
      [
        work("いじめられっ子", "C:/小説/いじめられっ子"),
        work("教科書チート", "C:/小説/書庫/教科書チート"),
      ],
      "C:/小説/書庫",
      none
    );
    const text = describeMergePlans(plans);
    expect(text).toContain("まとめる作品（1件）");
    expect(text).toContain("いじめられっ子");
    expect(text).toContain("まとめられない作品（1件）");
    expect(text).toContain("教科書チート");
  });

  it("移せないものが無ければ、その見出しを出さない", () => {
    const plans = planMerge(
      [work("いじめられっ子", "C:/小説/いじめられっ子")],
      "C:/小説/書庫",
      none
    );
    expect(describeMergePlans(plans)).not.toContain("まとめられない");
  });
});
