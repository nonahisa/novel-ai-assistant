import { describe, it, expect } from "vitest";
import {
  IMAGE_DIALOG_FILTERS,
  imageChoiceItem,
  imageUsageLabels,
  importNameCandidates,
  isImageFileName,
  normalizeImagePath,
  pickImportName,
  sortImageChoices,
  workRelativePath,
} from "../../src/core/epubImagePick";
import { parseBookConfig } from "../../src/models/book";

/**
 * 画像の投入口と選択画面の、決めごとの部分（設計書6.65.15）。
 *
 * **ファイルを触る部分は試さない。** ここで確かめるのは「中か外か」の
 * 判定と、写し先の名前の決まり方と、一覧の1行の組み立てである。
 */

describe("画像の絞り込み", () => {
  it("EPUBで使える画像だけを通す", () => {
    for (const name of [
      "口絵.png",
      "cover.JPG",
      "扉絵.jpeg",
      "動く.gif",
      "軽い.webp",
    ]) {
      expect(isImageFileName(name)).toBe(true);
    }
  });

  it("画像でないものは通さない", () => {
    for (const name of [
      "本文.txt",
      "book.json",
      "表紙.psd",
      "図.svg",
      "絵.bmp",
      "拡張子なし",
    ]) {
      expect(isImageFileName(name)).toBe(false);
    }
  });

  it("ファイルを選ぶ画面の絞り込みは、受け取る種類と同じ", () => {
    expect(IMAGE_DIALOG_FILTERS["画像"]).toEqual([
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
    ]);
  });
});

describe("作品フォルダの中か外か", () => {
  it("中の画像は、相対パスにして写さずに使う", () => {
    expect(workRelativePath("/work", "/work/素材/口絵.png")).toBe(
      "素材/口絵.png"
    );
  });

  it("作品フォルダ直下も中として扱う", () => {
    expect(workRelativePath("/work", "/work/表紙.png")).toBe("表紙.png");
  });

  it("外の画像は null（写す道へ回す）", () => {
    expect(workRelativePath("/work", "/picture/口絵.png")).toBeNull();
  });

  it("作品フォルダそのものは選べない", () => {
    expect(workRelativePath("/work", "/work")).toBeNull();
  });

  it("ブラウザ版の作品でも、中の画像を相対パスにできる", () => {
    expect(
      workRelativePath(
        "vscode-vfs://github/nonahisa/mynovel",
        "vscode-vfs://github/nonahisa/mynovel/素材/口絵.png"
      )
    ).toBe("素材/口絵.png");
  });

  it("ブラウザ版の作品から見て、別のリポジトリは外", () => {
    expect(
      workRelativePath(
        "vscode-vfs://github/nonahisa/mynovel",
        "vscode-vfs://github/nonahisa/another/素材/口絵.png"
      )
    ).toBeNull();
  });
});

describe("写し先の名前", () => {
  const at = new Date(2026, 8, 13, 14, 32, 5);

  it("同じ名前が無ければ、元の名前のまま写す", () => {
    expect(pickImportName("口絵.png", new Set(), at)).toBe("口絵.png");
  });

  it("同じ名前があったら別名にする（上書きしない）", () => {
    const taken = new Set(["口絵.png"]);
    const name = pickImportName("口絵.png", taken, at);
    expect(name).not.toBeNull();
    expect(taken.has(name as string)).toBe(false);
    // 時刻の付いた名前になる（いつ取り込んだかが読める）
    expect(name).toBe("口絵 2026-09-13 1432.png");
  });

  it("分まで同じ名前もあったら、秒・連番まで下りる", () => {
    const taken = new Set([
      "口絵.png",
      "口絵 2026-09-13 1432.png",
      "口絵 2026-09-13 143205.png",
    ]);
    const name = pickImportName("口絵.png", taken, at);
    expect(name).toBe("口絵 2026-09-13 143205-2.png");
    expect(taken.has(name as string)).toBe(false);
  });

  it("大文字小文字だけが違う名前も、同じ名前として避ける", () => {
    // Windowsでは 口絵.PNG と 口絵.png は同じファイルになる
    const name = pickImportName("口絵.png", new Set(["口絵.PNG"]), at);
    expect(name).not.toBe("口絵.png");
  });

  it("選ばれたのがフォルダ付きの場所でも、名前だけを使う", () => {
    expect(importNameCandidates("C:/写真/2026/口絵.png", at)[0]).toBe(
      "口絵.png"
    );
  });

  it("候補はすべて拡張子を保つ（種類が変わらない）", () => {
    for (const candidate of importNameCandidates("cover.jpeg", at)) {
      expect(candidate.endsWith(".jpeg")).toBe(true);
    }
  });
});

describe("一覧に出す1件", () => {
  it("名前・相対パス・使っている面を分けて出す", () => {
    expect(
      imageChoiceItem({ relativePath: "素材/口絵.png", usedBy: ["口絵"] })
    ).toEqual({
      label: "口絵.png",
      description: "素材/口絵.png",
      detail: "いま口絵で使っています",
    });
  });

  it("使っていなければ、使い道の欄は空にする", () => {
    expect(
      imageChoiceItem({ relativePath: "素材/未使用.png", usedBy: [] }).detail
    ).toBe("");
  });

  it("2つの面で使っていれば、両方を並べる", () => {
    expect(
      imageChoiceItem({
        relativePath: "素材/絵.png",
        usedBy: ["表紙", "口絵"],
      }).detail
    ).toBe("いま表紙・口絵で使っています");
  });

  it("使っている画像を先に、あとは場所の順に並べる", () => {
    const sorted = sortImageChoices([
      { relativePath: "素材/b.png", usedBy: [] },
      { relativePath: "素材/a.png", usedBy: [] },
      { relativePath: "素材/z.png", usedBy: ["表紙"] },
    ]);
    expect(sorted.map((item) => item.relativePath)).toEqual([
      "素材/z.png",
      "素材/a.png",
      "素材/b.png",
    ]);
  });
});

describe("どの面で使われているか", () => {
  const config = parseBookConfig(
    {
      coverImagePath: "素材/表紙.png",
      backCoverImagePath: "素材/裏.png",
      blocks: [
        { type: "cover" },
        { type: "frontIllustration", imagePath: "素材/口絵.png", caption: "" },
        { type: "sectionArt", imagePath: "素材/表紙.png", caption: "" },
        { type: "body" },
      ],
      illustrations: [
        {
          episodePath: "本文/001.txt",
          afterParagraph: 3,
          imagePath: "素材\\挿絵.png",
          caption: "",
        },
      ],
    },
    "作品"
  );

  it("表紙・裏表紙・口絵・扉絵・挿絵を拾う", () => {
    const usage = imageUsageLabels(config);
    expect(usage.get("素材/裏.png")).toEqual(["裏表紙"]);
    expect(usage.get("素材/口絵.png")).toEqual(["口絵"]);
    expect(usage.get("素材/挿絵.png")).toEqual(["挿絵"]);
  });

  it("同じ絵を2つの面で使っていれば、両方の面の名前が付く", () => {
    expect(imageUsageLabels(config).get("素材/表紙.png")).toEqual([
      "表紙",
      "扉絵",
    ]);
  });

  it("使っていない画像は表に載らない", () => {
    expect(imageUsageLabels(config).has("素材/未使用.png")).toBe(false);
  });

  it("Windowsの区切りで書かれた場所も、同じ画像として拾う", () => {
    expect(normalizeImagePath("素材\\挿絵.png")).toBe("素材/挿絵.png");
  });
});
