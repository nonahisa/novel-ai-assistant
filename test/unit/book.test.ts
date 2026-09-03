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
      tocEntryStyle: "numberAndTitle",
      tocOrnament: "none",
      colophonOrnament: "none",
      coverLayout: defaultCoverLayout(),
      backCoverLayout: defaultBackCoverLayout(),
      // 挿絵とページ分割は、指定するまで空（設計書6.65.10）
      illustrations: [],
      pageBreaks: [],
      // **登場人物一覧の既定は「出さない」**（設計書6.65.11）。設定資料は
      // AIが読み取ったものが混ざっており、不意に本へ入るのは事故である
      characterPage: { enabled: false, showIcons: true },
      // 書体も、指定するまで同梱しない（ライセンスの確認は作者の責任）
      fonts: { body: null, heading: null },
    });
  });

  test("登場人物一覧は、選ばないかぎり本へ入らない（設計書6.65.11）", () => {
    expect(defaultBookConfig("氷の街").characterPage.enabled).toBe(false);
    // 出すと決めた人は、たいてい顔も出したい。イラストの側は既定で入
    expect(defaultBookConfig("氷の街").characterPage.showIcons).toBe(true);
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

  test("表紙の枠の余白は黒が既定（設計書6.65.15）", () => {
    expect(defaultCoverLayout().frameBackground).toBe("#000000");
    expect(defaultBackCoverLayout().frameBackground).toBe("#000000");
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
        tocEntryStyle: "titleOnly",
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
    expect(config.tocEntryStyle).toBe("titleOnly");
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
    expect(() =>
      parseBookConfig({ tocEntryStyle: "番号だけ" }, "氷の街")
    ).toThrow();
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

  /**
   * **schemaVersion だけを特別扱いしない。**
   *
   * ここだけ「文字列でなければ既定へ倒す」だったので、`schemaVersion: 2` と
   * 書いた設計図が黙って `"0.1"` の本として組まれていた。倒すと作者は
   * 「指定が効いていない」ことに気づけない（綴じ方向・飾りと同じ扱いにする）。
   */
  test("schemaVersion が文字列でなければ弾く（黙って既定へ倒さない）", () => {
    expect(() => parseBookConfig({ schemaVersion: 2 }, "氷の街")).toThrow();
    expect(() => parseBookConfig({ schemaVersion: null }, "氷の街")).toThrow();
  });

  test("schemaVersion が書かれていなければ既定で埋める", () => {
    // 「書いていない」と「別の型で書いた」は違う。無い項目は既定でよい
    expect(parseBookConfig({}, "氷の街").schemaVersion).toBe(
      BOOK_SCHEMA_VERSION
    );
    expect(
      parseBookConfig({ schemaVersion: "9.9" }, "氷の街").schemaVersion
    ).toBe("9.9");
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
 * 登場人物一覧と書体（設計書6.65.11）。
 *
 * どちらも**指定するまで本の見た目を変えない**（ほかの項目と同じ約束）。
 */
describe("登場人物一覧の検証", () => {
  test("出す・出さないとイラストの有無を受け取る", () => {
    const config = parseBookConfig(
      { characterPage: { enabled: true, showIcons: false } },
      "氷の街"
    );

    expect(config.characterPage).toEqual({ enabled: true, showIcons: false });
  });

  test("書いてある側だけを差し替える（片方だけ書いても消えない）", () => {
    expect(
      parseBookConfig({ characterPage: { enabled: true } }, "氷の街")
        .characterPage
    ).toEqual({ enabled: true, showIcons: true });
  });

  test("真偽値でなければ弾く", () => {
    expect(() =>
      parseBookConfig({ characterPage: { enabled: "はい" } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ characterPage: { showIcons: 1 } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ characterPage: "出す" }, "氷の街")
    ).toThrow();
  });
});

describe("書体の検証", () => {
  test("作品フォルダの中の .ttf / .otf を受け取る", () => {
    const config = parseBookConfig(
      { fonts: { body: "素材/本文.ttf", heading: "素材\\見出し.OTF" } },
      "氷の街"
    );

    expect(config.fonts.body).toBe("素材/本文.ttf");
    // 区切りは `/` に揃える（表紙・挿絵と同じ）
    expect(config.fonts.heading).toBe("素材/見出し.OTF");
  });

  test("指定しなければ null（同梱しない）", () => {
    expect(parseBookConfig({ fonts: {} }, "氷の街").fonts).toEqual({
      body: null,
      heading: null,
    });
    expect(parseBookConfig({ fonts: { body: "  " } }, "氷の街").fonts.body).toBe(
      null
    );
  });

  test("作品フォルダの外は指せない（表紙・挿絵とまったく同じ）", () => {
    expect(() =>
      parseBookConfig({ fonts: { body: "../../C:/Windows/Fonts/msmincho.ttc" } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ fonts: { body: "C:/Windows/Fonts/msgothic.ttf" } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ fonts: { heading: "/usr/share/fonts/a.otf" } }, "氷の街")
    ).toThrow();
  });

  /**
   * **本へ入れられない種類は、書いた時点で断る。** 組み立ての途中で
   * 落ちると、書体1つのために本そのものが出ない（表紙と同じ考え方）。
   */
  test("扱えない拡張子は弾く", () => {
    expect(() =>
      parseBookConfig({ fonts: { body: "素材/本文.woff2" } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ fonts: { body: "素材/本文.ttc" } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ fonts: { heading: "素材/見出し" } }, "氷の街")
    ).toThrow();
  });

  test("文字列でなければ弾く", () => {
    expect(() => parseBookConfig({ fonts: { body: 1 } }, "氷の街")).toThrow();
    expect(() => parseBookConfig({ fonts: "明朝" }, "氷の街")).toThrow();
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

  /**
   * 枠の余白の色（設計書6.65.15）。表紙の枠を横1：縦1.4に固定したので、
   * 元イラストが比率違いのときに余った部分をこの色で塗る。
   * **文字要素の色とまったく同じ検証**（白・黒・16進のみ）を通す。
   */
  test("枠の余白の色は白・黒・16進だけ", () => {
    expect(
      parseBookConfig({ coverLayout: { frameBackground: "#ffffff" } }, "氷の街")
        .coverLayout.frameBackground
    ).toBe("#ffffff");
    expect(
      parseBookConfig({ coverLayout: { frameBackground: "#000000" } }, "氷の街")
        .coverLayout.frameBackground
    ).toBe("#000000");
    expect(
      parseBookConfig({ coverLayout: { frameBackground: "#1A2B3C" } }, "氷の街")
        .coverLayout.frameBackground
    ).toBe("#1a2b3c");
    expect(() =>
      parseBookConfig({ coverLayout: { frameBackground: "しろ" } }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig(
        { coverLayout: { frameBackground: "rgb(0,0,0)" } },
        "氷の街"
      )
    ).toThrow();
    expect(() =>
      parseBookConfig({ coverLayout: { frameBackground: 0 } }, "氷の街")
    ).toThrow();
  });

  test("枠の余白の色を書かなければ既定（黒）のまま", () => {
    expect(
      parseBookConfig({ coverLayout: { title: { visible: false } } }, "氷の街")
        .coverLayout.frameBackground
    ).toBe("#000000");
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

/**
 * 挿絵とページ分割（設計書6.65.10）。
 *
 * どちらも「第N話の第M段落のあと」という位置指定で、**原稿には目印を
 * 書き込まない**。ここで見るのは、手で書かれたJSONを受け取ってよいかだけ
 * である（話が実在するかは書き出し時に確かめる——ここはファイルの一覧を
 * 持たない）。
 */
describe("挿絵の指定", () => {
  const one = {
    episodePath: "本文/第1話.txt",
    afterParagraph: 3,
    imagePath: "素材/挿絵1.png",
    caption: "出会いの場面",
  };

  test("書いてあれば、そのまま読み取る", () => {
    expect(parseBookConfig({ illustrations: [one] }, "氷の街").illustrations)
      .toEqual([one]);
  });

  test("解説文は空でよい（省略も同じ）", () => {
    const config = parseBookConfig(
      {
        illustrations: [
          { ...one, caption: "" },
          {
            episodePath: "本文/第2話.txt",
            afterParagraph: 1,
            imagePath: "素材/挿絵2.png",
          },
        ],
      },
      "氷の街"
    );

    expect(config.illustrations[0].caption).toBe("");
    expect(config.illustrations[1].caption).toBe("");
  });

  test("画像の場所は作品フォルダの外を指せない（表紙と同じ検証）", () => {
    for (const imagePath of ["../../秘密.png", "C:/tmp/挿絵.png", "/etc/passwd"]) {
      expect(() =>
        parseBookConfig({ illustrations: [{ ...one, imagePath }] }, "氷の街")
      ).toThrow();
    }
  });

  test("画像の場所が空なら弾く（絵の無い挿絵は作らない）", () => {
    expect(() =>
      parseBookConfig({ illustrations: [{ ...one, imagePath: "" }] }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig(
        { illustrations: [{ ...one, imagePath: undefined }] },
        "氷の街"
      )
    ).toThrow();
  });

  test("段落番号は1以上の整数だけ", () => {
    for (const afterParagraph of [0, -1, 1.5, "3", null]) {
      expect(() =>
        parseBookConfig({ illustrations: [{ ...one, afterParagraph }] }, "氷の街")
      ).toThrow();
    }
    expect(
      parseBookConfig(
        { illustrations: [{ ...one, afterParagraph: 1 }] },
        "氷の街"
      ).illustrations[0].afterParagraph
    ).toBe(1);
  });

  test("話の指定が空なら弾く", () => {
    expect(() =>
      parseBookConfig({ illustrations: [{ ...one, episodePath: "  " }] }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ illustrations: [{ ...one, episodePath: 3 }] }, "氷の街")
    ).toThrow();
  });

  test("話の区切りは / に揃える（Windowsで書かれても同じ指定になる）", () => {
    expect(
      parseBookConfig(
        { illustrations: [{ ...one, episodePath: "本文\\第1話.txt" }] },
        "氷の街"
      ).illustrations[0].episodePath
    ).toBe("本文/第1話.txt");
  });

  test("配列でなければ弾く", () => {
    expect(() =>
      parseBookConfig({ illustrations: { ...one } }, "氷の街")
    ).toThrow();
    expect(() => parseBookConfig({ illustrations: ["挿絵"] }, "氷の街")).toThrow();
  });
});

describe("ページ分割の指定", () => {
  const one = { episodePath: "本文/第1話.txt", afterParagraph: 5 };

  test("書いてあれば、そのまま読み取る", () => {
    expect(parseBookConfig({ pageBreaks: [one] }, "氷の街").pageBreaks).toEqual([
      one,
    ]);
  });

  test("挿絵とまったく同じ検証を通す", () => {
    // 片方だけ緩いと、そちらが抜け道になる（表紙と裏表紙と同じ理由）
    for (const afterParagraph of [0, -2, 2.5, "5"]) {
      expect(() =>
        parseBookConfig({ pageBreaks: [{ ...one, afterParagraph }] }, "氷の街")
      ).toThrow();
    }
    expect(() =>
      parseBookConfig({ pageBreaks: [{ ...one, episodePath: "" }] }, "氷の街")
    ).toThrow();
    expect(() => parseBookConfig({ pageBreaks: "5" }, "氷の街")).toThrow();
  });
});
