import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ scheme: "file", fsPath: p, path: p }),
    parse: (value: string) => ({ scheme: "x", fsPath: value, path: value }),
  },
}));

import {
  buildSyncTarget,
  describeCompanions,
  describeSyncTarget,
  parentFolderOf,
  worksInside,
} from "../../src/core/syncTarget";
import type { WorkEntry } from "../../src/models/types";

/**
 * 同期する置き場（設計書5.7.9）。
 *
 * **1つのリポジトリに複数の作品が入っている形を既定とする**（作者の判断、
 * 2026-08-22）。ここは「どの作品が同じ置き場にいるか」を場所から導く部分で、
 * 覚えないぶん、作者がフォルダーを動かしても食い違わない。
 */

function work(title: string, folderPath: string): WorkEntry {
  return {
    id: title,
    title,
    folderPath,
    registeredAt: "2026-08-22T00:00:00.000Z",
  };
}

const works = [
  work("いじめられっ子", "C:/小説/HisasNovels/いじめられっ子"),
  work("教科書チート", "C:/小説/HisasNovels/教科書チート"),
  work("別の作品", "C:/小説/よそ/別の作品"),
];

describe("置き場に入っている作品", () => {
  it("その中にある作品だけを拾う", () => {
    const inside = worksInside(works, "C:/小説/HisasNovels");
    expect(inside.map((w) => w.title)).toEqual([
      "いじめられっ子",
      "教科書チート",
    ]);
  });

  it("フォルダー自身が作品なら、それも拾う", () => {
    const inside = worksInside(works, "C:/小説/よそ/別の作品");
    expect(inside.map((w) => w.title)).toEqual(["別の作品"]);
  });

  it("名前の先頭が同じだけのフォルダーを拾わない", () => {
    // 「HisasNovels2」は「HisasNovels」の中ではない
    const inside = worksInside(
      [work("紛らわしい", "C:/小説/HisasNovels2/紛らわしい")],
      "C:/小説/HisasNovels"
    );
    expect(inside).toEqual([]);
  });

  it("何も入っていなければ空", () => {
    expect(worksInside(works, "C:/小説/空っぽ")).toEqual([]);
  });
});

describe("置き場の名前", () => {
  it("複数入っていればフォルダー名を使う", () => {
    const target = buildSyncTarget("C:/小説/HisasNovels", works);
    expect(target.label).toBe("HisasNovels");
    expect(describeSyncTarget(target)).toBe("HisasNovels（2作品）");
  });

  /**
   * **フォルダー名と作品名は違うことがある。**
   * フォルダー名だけを出されても、作者にはどれのことか分からない。
   */
  it("その作品そのものなら、作品名を使う", () => {
    const target = buildSyncTarget("C:/小説/よそ/別の作品", works);
    expect(target.label).toBe("別の作品");
    expect(describeSyncTarget(target)).toBe("別の作品");
  });

  it("中に1作品しか無くても、置き場が別のフォルダーならフォルダー名", () => {
    const target = buildSyncTarget("C:/小説/よそ", works);
    expect(target.label).toBe("よそ");
  });
});

describe("一緒に扱われる作品", () => {
  /**
   * **1作品を選んで同期しても、他の作品も一緒に出ていく。**
   * 画面に作品名が1つしか出ていないと、そうは読めない。
   */
  it("同じ置き場の他の作品を、名前で挙げる", () => {
    const target = buildSyncTarget("C:/小説/HisasNovels", works);
    const text = describeCompanions(target, works[0]);
    expect(text).toContain("教科書チート");
    expect(text).not.toContain("いじめられっ子");
  });

  it("一緒に出るものが無ければ、何も言わない", () => {
    // 余計な行を足さない
    const target = buildSyncTarget("C:/小説/よそ/別の作品", works);
    expect(describeCompanions(target, works[2])).toBeUndefined();
  });
});

describe("まとめる先の候補", () => {
  it("1つ上のフォルダーを返す", () => {
    expect(parentFolderOf("C:/小説/HisasNovels/いじめられっ子")).toBe(
      "C:/小説/HisasNovels"
    );
  });

  it("これ以上たどれなければ返さない", () => {
    expect(parentFolderOf("C:/")).toBeUndefined();
  });
});
