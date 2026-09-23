import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIBRARY_NAME,
  decideNewWorkHome,
  describeNewWorkHome,
  findLibraries,
  shouldOfferLibraryMerge,
} from "../../../src/core/libraryHome";
import { normalize } from "../../../src/core/pathText";
import {
  offerLibraryMerge,
  MERGE_ACTION_LABEL,
} from "../../../src/features/offerLibraryMerge";

/**
 * 書庫を既定にする（設計書6.97）。
 *
 * 確かめるのは3つ。
 *
 * 1. **行き先を、機械が決められるところは決めていること**——書庫が1つなら
 *    訊かない。分かれているときだけ訊く（6.97.2）
 * 2. **統合を促すのは2作目の一度だけ**であること（6.97.3）。1作目で勧めず、
 *    3作目以降は言わず、すでに同じ書庫の中なら言わない
 * 3. **説明に「書庫」という言葉を前へ出していない**こと——初めて使う人には
 *    通じない言葉である
 */

function at(folderPath: string): { folderPath: string } {
  return { folderPath };
}

describe("新しい作品の行き先", () => {
  it("作品を置いてあるフォルダーを、作品の多い順に数え上げる", () => {
    const libraries = findLibraries([
      at("C:/novel/いじめられっ子"),
      at("C:/novel/教科書チート"),
      at("D:/backup/むかしの話"),
    ]);

    expect(libraries).toEqual([
      { folderPath: normalize("C:/novel"), workCount: 2 },
      { folderPath: normalize("D:/backup"), workCount: 1 },
    ]);
  });

  it("大文字小文字の違いだけなら、同じ書庫として数える", () => {
    // Windows では `C:/Novel` と `C:/novel` は同じ場所を指す。
    // 別々に数えると、書庫が1つしか無いのに選択画面が出る
    const libraries = findLibraries([
      at("C:/Novel/いじめられっ子"),
      at("C:/novel/教科書チート"),
    ]);

    expect(libraries).toHaveLength(1);
    expect(libraries[0].workCount).toBe(2);
  });

  it("1作目は、書庫がまだ無いので作る", () => {
    expect(decideNewWorkHome([])).toEqual({ kind: "create" });
  });

  it("書庫が1つなら訊かずにそこへ入れる", () => {
    // **機械が判断できることを人に聞かない**（6.97.2）
    expect(
      decideNewWorkHome([
        at("C:/novel/いじめられっ子"),
        at("C:/novel/教科書チート"),
      ])
    ).toEqual({ kind: "library", folderPath: normalize("C:/novel") });
  });

  it("書庫が複数あるときだけ訊く", () => {
    const decided = decideNewWorkHome([
      at("C:/novel/いじめられっ子"),
      at("D:/backup/むかしの話"),
    ]);

    expect(decided.kind).toBe("choose");
    if (decided.kind !== "choose") return;
    expect(decided.candidates.map((entry) => entry.folderPath)).toEqual([
      normalize("C:/novel"),
      normalize("D:/backup"),
    ]);
  });

  it("説明には「書庫」という言葉を出さない", () => {
    const note = describeNewWorkHome(`C:/novel/${DEFAULT_LIBRARY_NAME}`);

    expect(note).toContain(DEFAULT_LIBRARY_NAME);
    expect(note).not.toContain("書庫");
    // **何が起きるかだけを書く。** 初めての人に用語で選ばせない
    expect(note).toContain("まとめて置けます");
  });
});

describe("書庫へまとめる促し", () => {
  const 一作目 = at("C:/novel/いじめられっ子");
  const 別の場所の二作目 = at("D:/backup/教科書チート");
  const 同じ書庫の二作目 = at("C:/novel/教科書チート");

  it("1作目では勧めない", () => {
    expect(
      shouldOfferLibraryMerge({
        works: [一作目],
        added: 一作目,
        alreadyOffered: false,
      })
    ).toBe(false);
  });

  it("書庫の外に2作目が並んだときだけ勧める", () => {
    expect(
      shouldOfferLibraryMerge({
        works: [一作目, 別の場所の二作目],
        added: 別の場所の二作目,
        alreadyOffered: false,
      })
    ).toBe(true);
  });

  it("すでに同じフォルダーの中なら勧めない", () => {
    expect(
      shouldOfferLibraryMerge({
        works: [一作目, 同じ書庫の二作目],
        added: 同じ書庫の二作目,
        alreadyOffered: false,
      })
    ).toBe(false);
  });

  it("3作目以降では勧めない", () => {
    expect(
      shouldOfferLibraryMerge({
        works: [一作目, 同じ書庫の二作目, 別の場所の二作目],
        added: 別の場所の二作目,
        alreadyOffered: false,
      })
    ).toBe(false);
  });

  it("一度勧めたら、二度と勧めない", () => {
    expect(
      shouldOfferLibraryMerge({
        works: [一作目, 別の場所の二作目],
        added: 別の場所の二作目,
        alreadyOffered: true,
      })
    ).toBe(false);
  });

  it("押されたら「作品を書庫にまとめる」へ渡す", async () => {
    const merge = vi.fn(async () => undefined);
    const markOffered = vi.fn(async () => undefined);

    await offerLibraryMerge({
      works: [一作目, 別の場所の二作目],
      added: 別の場所の二作目,
      wasOffered: () => false,
      markOffered,
      notify: async () => MERGE_ACTION_LABEL,
      merge,
    });

    expect(merge).toHaveBeenCalledTimes(1);
    expect(markOffered).toHaveBeenCalledTimes(1);
  });

  it("断られても「勧めた」と覚える（次の登録で言い直さない）", async () => {
    const merge = vi.fn(async () => undefined);
    const markOffered = vi.fn(async () => undefined);

    await offerLibraryMerge({
      works: [一作目, 別の場所の二作目],
      added: 別の場所の二作目,
      wasOffered: () => false,
      markOffered,
      notify: async () => undefined,
      merge,
    });

    expect(merge).not.toHaveBeenCalled();
    expect(markOffered).toHaveBeenCalledTimes(1);
  });

  it("勧める場面でなければ、覚えもしない", async () => {
    // **覚えてしまうと、本当に勧めるべき2作目で黙ることになる**
    const markOffered = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);

    await offerLibraryMerge({
      works: [一作目],
      added: 一作目,
      wasOffered: () => false,
      markOffered,
      notify,
      merge: async () => undefined,
    });

    expect(notify).not.toHaveBeenCalled();
    expect(markOffered).not.toHaveBeenCalled();
  });
});
