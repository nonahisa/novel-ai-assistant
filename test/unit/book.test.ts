import { describe, expect, test } from "vitest";
import {
  BOOK_SCHEMA_VERSION,
  defaultBookConfig,
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
    });
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
});
