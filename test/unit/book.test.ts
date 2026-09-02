import { describe, expect, test } from "vitest";
import {
  BOOK_SCHEMA_VERSION,
  defaultBackCoverLayout,
  defaultBookConfig,
  defaultCoverLayout,
  parseBookConfig,
} from "../../src/models/book";

/**
 * 本の設計図（設計書6.65.2）。
 *
 * **作者が手で書くJSON**なので、壊れていたら勝手に直さず例外にする
 * （他の台帳と同じ約束）。
 */
describe("本の設計図の既定値", () => {
  test("題名だけ渡せば、残りは既定で埋まる", () => {
    const config = defaultBookConfig("氷の街");

    expect(config).toEqual({
      schemaVersion: BOOK_SCHEMA_VERSION,
      title: "氷の街",
      author: "",
      illustrator: "",
      label: "",
      writingMode: "vertical",
      tocEnabled: true,
      collapseBlankLines: true,
      coverImagePath: null,
      backCoverImagePath: null,
      // **既定は「いままでどおりの見た目」**（設計書6.65.6）。
      // 目次は本文と同じ流れの一覧、飾りは無し
      tocPattern: "vertical",
      tocOrnament: "none",
      colophonOrnament: "none",
      coverLayout: defaultCoverLayout(),
      backCoverLayout: defaultBackCoverLayout(),
    });
  });

  test("表紙の合成は、題名と作者名だけを出す（設計書6.65.8）", () => {
    const layout = defaultCoverLayout();

    expect(layout.title).toEqual({
      visible: true,
      anchor: "top-center",
      size: "large",
      color: "#ffffff",
      vertical: true,
    });
    expect(layout.author).toEqual({
      visible: true,
      anchor: "bottom-right",
      size: "medium",
      color: "#ffffff",
      vertical: true,
    });
    // 絵師名とレーベル名は、出すと決めた人だけが出す
    expect(layout.illustrator.visible).toBe(false);
    expect(layout.label.visible).toBe(false);
  });

  test("空のJSONオブジェクトは、既定値そのものになる", () => {
    expect(parseBookConfig({}, "氷の街")).toEqual(defaultBookConfig("氷の街"));
  });

  test("題名が空文字なら作品名で埋める（無題の本を作らない）", () => {
    expect(parseBookConfig({ title: "   " }, "氷の街").title).toBe("氷の街");
  });

  test("書いてある値は既定値より強い", () => {
    const config = parseBookConfig(
      {
        title: "氷の街（文庫版）",
        author: "野中",
        illustrator: "絵師",
        label: "○○文庫",
        writingMode: "horizontal",
        tocEnabled: false,
        collapseBlankLines: false,
        coverImagePath: "素材/表紙.png",
        tocPattern: "chapters",
        tocOrnament: "rule",
        colophonOrnament: "center",
      },
      "氷の街"
    );

    expect(config.title).toBe("氷の街（文庫版）");
    expect(config.author).toBe("野中");
    expect(config.illustrator).toBe("絵師");
    expect(config.label).toBe("○○文庫");
    expect(config.writingMode).toBe("horizontal");
    expect(config.tocEnabled).toBe(false);
    expect(config.collapseBlankLines).toBe(false);
    expect(config.coverImagePath).toBe("素材/表紙.png");
    expect(config.tocPattern).toBe("chapters");
    expect(config.tocOrnament).toBe("rule");
    expect(config.colophonOrnament).toBe("center");
  });
});

describe("壊れた設計図は受け取らない", () => {
  test("オブジェクトでなければ弾く", () => {
    expect(() => parseBookConfig("こわれている", "氷の街")).toThrow();
    expect(() => parseBookConfig(null, "氷の街")).toThrow();
    expect(() => parseBookConfig([1, 2, 3], "氷の街")).toThrow();
  });

  test("知らない綴じ方向は弾く（黙って縦書きにしない）", () => {
    expect(() => parseBookConfig({ writingMode: "たて" }, "氷の街")).toThrow();
  });

  test("知らない目次のパターン・飾りは弾く", () => {
    // 綴じ方向と同じ扱い。読めない値を黙って既定へ倒すと、
    // 作者は「指定が効いていない」ことに気づけない
    expect(() => parseBookConfig({ tocPattern: "たて組み" }, "氷の街")).toThrow();
    expect(() => parseBookConfig({ tocOrnament: "花" }, "氷の街")).toThrow();
    expect(() =>
      parseBookConfig({ colophonOrnament: "けいせん" }, "氷の街")
    ).toThrow();
  });

  test("真偽値のところに文字列が入っていたら弾く", () => {
    expect(() => parseBookConfig({ tocEnabled: "はい" }, "氷の街")).toThrow();
    expect(() =>
      parseBookConfig({ collapseBlankLines: 1 }, "氷の街")
    ).toThrow();
  });

  test("題名や作者名が文字列でなければ弾く", () => {
    expect(() => parseBookConfig({ title: 123 }, "氷の街")).toThrow();
    expect(() => parseBookConfig({ author: {} }, "氷の街")).toThrow();
  });

  test("表紙の場所は作品フォルダの外を指せない", () => {
    // 相対パスと言いながら `..` や絶対パスを書かれると、作品の外の
    // ファイルを本へ詰めることになる
    expect(() =>
      parseBookConfig({ coverImagePath: "../../秘密.png" }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ coverImagePath: "C:/tmp/表紙.png" }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ coverImagePath: "/etc/passwd" }, "氷の街")
    ).toThrow();
  });

  test("表紙を使わないときは null（省略も同じ）", () => {
    expect(parseBookConfig({ coverImagePath: null }, "氷の街").coverImagePath).toBe(
      null
    );
    expect(parseBookConfig({}, "氷の街").coverImagePath).toBe(null);
  });

  test("裏表紙の場所も作品フォルダの外を指せない", () => {
    // 表紙とまったく同じ検証。片方だけ緩いと、そちらが抜け道になる
    expect(() =>
      parseBookConfig({ backCoverImagePath: "../../秘密.png" }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ backCoverImagePath: "D:\\写真\\裏.png" }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ backCoverImagePath: "/etc/passwd" }, "氷の街")
    ).toThrow();
    expect(
      parseBookConfig({ backCoverImagePath: "素材/裏表紙.png" }, "氷の街")
        .backCoverImagePath
    ).toBe("素材/裏表紙.png");
  });
});

/**
 * 表紙・裏表紙の合成指定（設計書6.65.8）。
 *
 * 置き場所は9か所のプリセットで、座標は持たない。**知らない値は
 * 黙って既定へ倒さない**——ほかの項目と同じで、倒すと作者は指定が
 * 効いていないことに気づけない。
 */
describe("合成指定の検証", () => {
  test("9つのプリセットの外は弾く", () => {
    expect(() =>
      parseBookConfig({ coverLayout: { title: { anchor: "まんなか" } } }, "氷の街")
    ).toThrow();
    // 「上・中・下」「左・中央・右」の組み合わせ以外は作らない
    expect(() =>
      parseBookConfig({ coverLayout: { title: { anchor: "center" } } }, "氷の街")
    ).toThrow();
  });

  test("9つのプリセットはすべて受け取る", () => {
    for (const anchor of [
      "top-left",
      "top-center",
      "top-right",
      "middle-left",
      "middle-center",
      "middle-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ]) {
      expect(
        parseBookConfig({ coverLayout: { title: { anchor } } }, "氷の街")
          .coverLayout.title.anchor
      ).toBe(anchor);
    }
  });

  test("字の大きさは大・中・小だけ", () => {
    expect(() =>
      parseBookConfig({ coverLayout: { title: { size: "特大" } } }, "氷の街")
    ).toThrow();
    expect(
      parseBookConfig({ coverLayout: { title: { size: "small" } } }, "氷の街")
        .coverLayout.title.size
    ).toBe("small");
  });

  test("色は16進でなければ弾く", () => {
    expect(() =>
      parseBookConfig({ coverLayout: { title: { color: "しろ" } } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ coverLayout: { title: { color: "#12345" } } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ coverLayout: { title: { color: "rgb(0,0,0)" } } }, "氷の街")
    ).toThrow();
  });

  test("16進は3桁でも6桁でもよく、小文字に揃える", () => {
    expect(
      parseBookConfig({ coverLayout: { title: { color: "#FA0" } } }, "氷の街")
        .coverLayout.title.color
    ).toBe("#fa0");
    expect(
      parseBookConfig({ coverLayout: { title: { color: "#1A2B3C" } } }, "氷の街")
        .coverLayout.title.color
    ).toBe("#1a2b3c");
  });

  test("書いてある要素だけを差し替え、残りは既定のまま", () => {
    const config = parseBookConfig(
      { backCoverLayout: { label: { visible: true, anchor: "middle-center" } } },
      "氷の街"
    );

    expect(config.backCoverLayout.label.visible).toBe(true);
    expect(config.backCoverLayout.label.anchor).toBe("middle-center");
    // 触っていない要素は既定のまま（部分的に書かれたJSONを壊さない）
    expect(config.backCoverLayout.title).toEqual(
      defaultBackCoverLayout().title
    );
    // 表紙の指定は裏表紙とは別物である
    expect(config.coverLayout).toEqual(defaultCoverLayout());
  });

  test("合成指定の形が違えば弾く", () => {
    expect(() => parseBookConfig({ coverLayout: "上" }, "氷の街")).toThrow();
    expect(() =>
      parseBookConfig({ coverLayout: { title: "上" } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ coverLayout: { title: { visible: "はい" } } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ coverLayout: { title: { vertical: 1 } } }, "氷の街")
    ).toThrow();
  });
});
