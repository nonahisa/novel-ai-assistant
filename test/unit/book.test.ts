import { describe, expect, test } from "vitest";
import {
  BOOK_SCHEMA_VERSION,
  activeBookBlocks,
  canAddBookBlock,
  canRemoveBookBlock,
  canResumeBookBlock,
  canSuspendBookBlock,
  defaultBackCoverLayout,
  defaultBookBlocks,
  defaultBookConfig,
  defaultCoverLayout,
  dropBookBlock,
  insertBookBlockAfter,
  isBookBlockSuspended,
  moveBookBlock,
  parseBookConfig,
  removeBookBlockAt,
  resolveBookBlocks,
  setBookBlockSuspended,
  type BookBlock,
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
      // 面の並び（設計書6.65.15）。**既定はいままでの本と同じ並び**で、
      // 目次・人物紹介の有無はその時の設定から組む
      blocks: defaultBookBlocks({
        tocEnabled: true,
        characterPage: { enabled: false },
      }),
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

/**
 * 面の並び（設計書6.65.15の段B）。
 *
 * **並びがそのまま本の並びになる。** ここで見るのは「作者が書いた並びを
 * そのまま読めること」と「blocks の無い既存の book.json が、いままでと
 * 同じ本になること」の2つである。
 */
describe("ブロックの既定の並び（設計書6.65.15）", () => {
  const types = (blocks: readonly BookBlock[]): string[] =>
    blocks.map((block) => block.type);

  test("既定は 表紙→中表紙→目次→本文→あとがき→奥付→裏表紙", () => {
    // **あとがきの面は既定の並びに入れてある。** 原稿
    // （設定/書籍/あとがき.md）が無ければ面ごと出ないので、いままでの
    // 本の中身は変わらない——けれども作者が書いた瞬間に本へ入る
    expect(
      types(
        defaultBookBlocks({ tocEnabled: true, characterPage: { enabled: false } })
      )
    ).toEqual([
      "cover",
      "halfTitle",
      "toc",
      "body",
      "afterword",
      "colophon",
      "backCover",
    ]);
  });

  test("目次を出さない設定なら、目次の面は並びに入らない", () => {
    expect(
      types(
        defaultBookBlocks({
          tocEnabled: false,
          characterPage: { enabled: false },
        })
      )
    ).not.toContain("toc");
  });

  test("人物紹介を出す設定なら、目次の後・本文の前に入る", () => {
    const order = types(
      defaultBookBlocks({ tocEnabled: true, characterPage: { enabled: true } })
    );

    expect(order.indexOf("characters")).toBeGreaterThan(order.indexOf("toc"));
    expect(order.indexOf("characters")).toBeLessThan(order.indexOf("body"));
  });

  test("blocks の無い book.json は、既定の並びで読める（ファイルは書き換えない）", () => {
    const config = parseBookConfig({ title: "氷の街" }, "氷の街");

    expect(types(resolveBookBlocks(config))).toEqual(
      types(
        defaultBookBlocks({ tocEnabled: true, characterPage: { enabled: false } })
      )
    );
  });
});

describe("ブロックの検証（設計書6.65.15）", () => {
  const minimal = [
    { type: "cover" },
    { type: "body" },
    { type: "colophon" },
  ];

  test("書いてある並びは、そのままの順で読み取る", () => {
    const config = parseBookConfig(
      {
        blocks: [
          { type: "cover" },
          { type: "frontIllustration", imagePath: "素材/口絵.png", caption: "旅立ち" },
          { type: "body" },
        ],
      },
      "氷の街"
    );

    expect(config.blocks?.map((block) => block.type)).toEqual([
      "cover",
      "frontIllustration",
      "body",
    ]);
    expect(config.blocks?.[1]).toEqual({
      type: "frontIllustration",
      imagePath: "素材/口絵.png",
      caption: "旅立ち",
    });
  });

  test("本文はちょうど1つ（無い・2つのどちらも弾く）", () => {
    expect(() =>
      parseBookConfig({ blocks: [{ type: "cover" }] }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig(
        { blocks: [{ type: "body" }, { type: "body" }] },
        "氷の街"
      )
    ).toThrow();
  });

  test("1冊に1つの面は、重ねて書けない", () => {
    for (const type of [
      "cover",
      "halfTitle",
      "toc",
      "characters",
      "afterword",
      "colophon",
      "backCover",
    ]) {
      expect(() =>
        parseBookConfig(
          { blocks: [...minimal, { type }, { type }] },
          "氷の街"
        ),
        `${type} が2つ書けてしまう`
      ).toThrow();
    }
  });

  test("扉絵は何枚でも挿せる（1つだけの面ではない）", () => {
    const config = parseBookConfig(
      {
        blocks: [
          { type: "body" },
          { type: "sectionArt", imagePath: "素材/扉1.png" },
          { type: "sectionArt", imagePath: "素材/扉2.png" },
        ],
      },
      "氷の街"
    );

    expect(config.blocks).toHaveLength(3);
  });

  test("知らない種類は受け取らない（黙って落とさない）", () => {
    expect(() =>
      parseBookConfig({ blocks: [...minimal, { type: "chapterBreak" }] }, "氷の街")
    ).toThrow();
    expect(() =>
      parseBookConfig({ blocks: [...minimal, { type: "" }] }, "氷の街")
    ).toThrow();
    expect(() => parseBookConfig({ blocks: [{ type: 3 }] }, "氷の街")).toThrow();
    expect(() => parseBookConfig({ blocks: "cover" }, "氷の街")).toThrow();
  });

  test("画像の面は、作品フォルダの外を指せない（表紙・挿絵と同じ検証）", () => {
    for (const imagePath of [
      "/etc/passwd",
      "C:/秘密/絵.png",
      "../ほかの作品/絵.png",
    ]) {
      expect(() =>
        parseBookConfig(
          { blocks: [{ type: "body" }, { type: "frontIllustration", imagePath }] },
          "氷の街"
        ),
        `${imagePath} を受け取ってしまう`
      ).toThrow();
    }
  });

  test("画像の面に場所が無ければ弾く（絵の無い口絵は作らない）", () => {
    expect(() =>
      parseBookConfig(
        { blocks: [{ type: "body" }, { type: "frontIllustration" }] },
        "氷の街"
      )
    ).toThrow();
    expect(() =>
      parseBookConfig(
        {
          blocks: [
            { type: "body" },
            { type: "sectionArt", imagePath: "   " },
          ],
        },
        "氷の街"
      )
    ).toThrow();
  });

  test("章区切りは blocks に持たない（章立ての台帳が正。設計書6.66）", () => {
    expect(() =>
      parseBookConfig({ blocks: [...minimal, { type: "chapter" }] }, "氷の街")
    ).toThrow();
  });
});

/**
 * **書いてある並びが正である**（設計書6.65.15の段C。本体の裁定）。
 *
 * ## この節は段Bのテストを書き換えたものである
 *
 * 段Bには並びを編む画面が無く、目次・人物紹介の有無を決めるのは左の欄の
 * チェックだった。そのため `resolveBookBlocks` は blocks を欄の値へ
 * 追従させており、ここには「目次を出す設定に戻すと、目次の面が並びへ戻る」
 * 「出さない設定なら、並びに書いてあっても外す」「人物紹介も同じ」の
 * 3つが並んでいた。**段Cで並びを編む画面ができ、blocks が正になったので、
 * その3つは反対のことを確かめるものへ置き換えた**——追従が残っていると、
 * 画面で外した目次が古いチェックの値で戻ってきて、作者が並べたとおりの
 * 本にならない（二重管理をここで断つ）。
 */
describe("並びが正で、設定に追従しない（設計書6.65.15の段C）", () => {
  test("目次を出す設定でも、並びに無ければ目次の面は入らない", () => {
    const config = parseBookConfig(
      { tocEnabled: true, blocks: [{ type: "cover" }, { type: "body" }] },
      "氷の街"
    );

    expect(resolveBookBlocks(config).map((block) => block.type)).toEqual([
      "cover",
      "body",
    ]);
  });

  test("目次を出さない設定でも、並びに書いてあれば入る", () => {
    const config = parseBookConfig(
      {
        tocEnabled: false,
        blocks: [{ type: "cover" }, { type: "toc" }, { type: "body" }],
      },
      "氷の街"
    );

    expect(resolveBookBlocks(config).map((block) => block.type)).toEqual([
      "cover",
      "toc",
      "body",
    ]);
  });

  test("人物紹介も同じ（チェック欄は並びを動かさない）", () => {
    const config = parseBookConfig(
      {
        characterPage: { enabled: true },
        blocks: [{ type: "cover" }, { type: "body" }, { type: "colophon" }],
      },
      "氷の街"
    );

    expect(resolveBookBlocks(config).map((block) => block.type)).toEqual([
      "cover",
      "body",
      "colophon",
    ]);
  });

  /**
   * **チェック欄は読み込み互換のためだけに残っている。** blocks を持たない
   * 古い book.json では、いまも既定の並びを組む材料である（ここが効かなく
   * なると、目次を切っていた本が版を上げただけで目次つきになる）。
   */
  test("blocks の無い本では、いまもチェック欄が既定の並びを決める", () => {
    const config = parseBookConfig({ tocEnabled: false }, "氷の街");

    expect(resolveBookBlocks(config).map((block) => block.type)).not.toContain(
      "toc"
    );
  });
});

/**
 * 並びの編集（設計書6.65.15の段C）。
 *
 * 画面はクリックで挿し、「上へ」「下へ」「削除」で動かす。**その計算は
 * ここが1か所で持つ**——押せる・押せないの判断（パレットを畳む理由）と、
 * 実際に並びが変わる計算が別々だと、押せたのに変わらないボタンができる。
 */
describe("並びを編む（設計書6.65.15の段C）", () => {
  const base: BookBlock[] = [
    { type: "cover" },
    { type: "toc" },
    { type: "body" },
    { type: "colophon" },
  ];
  const types = (blocks: readonly BookBlock[] | null): string[] =>
    (blocks ?? []).map((block) => block.type);

  test("選んだ面の後ろへ入る", () => {
    expect(types(insertBookBlockAfter(base, 1, { type: "characters" }))).toEqual(
      ["cover", "toc", "characters", "body", "colophon"]
    );
  });

  test("選んでいなければ末尾へ入る", () => {
    expect(
      types(insertBookBlockAfter(base, -1, { type: "backCover" }))
    ).toEqual(["cover", "toc", "body", "colophon", "backCover"]);
  });

  test("1冊に1つの面は、既にあれば入れられない（null で断る）", () => {
    expect(insertBookBlockAfter(base, 0, { type: "toc" })).toBeNull();
    expect(canAddBookBlock(base, "toc")).toBe(false);
    // **本文も同じ。** 複製できないことは、パレットの押せなさで伝える
    expect(canAddBookBlock(base, "body")).toBe(false);
  });

  test("扉絵と口絵は何枚でも入る（置ける場所だけが違う面）", () => {
    const once = insertBookBlockAfter(base, 0, {
      type: "sectionArt",
      imagePath: "素材/扉1.png",
      caption: "",
    });
    expect(canAddBookBlock(once ?? [], "sectionArt")).toBe(true);
    expect(
      types(
        insertBookBlockAfter(once ?? [], 2, {
          type: "sectionArt",
          imagePath: "素材/扉2.png",
          caption: "",
        })
      )
    ).toEqual(["cover", "sectionArt", "toc", "sectionArt", "body", "colophon"]);
  });

  test("上へ・下へで入れ替わる", () => {
    expect(types(moveBookBlock(base, 1, -1))).toEqual([
      "toc",
      "cover",
      "body",
      "colophon",
    ]);
    expect(types(moveBookBlock(base, 1, 1))).toEqual([
      "cover",
      "body",
      "toc",
      "colophon",
    ]);
  });

  test("端では動かない（null で断る）", () => {
    expect(moveBookBlock(base, 0, -1)).toBeNull();
    expect(moveBookBlock(base, base.length - 1, 1)).toBeNull();
  });

  test("削除は1つだけ消す", () => {
    expect(types(removeBookBlockAt(base, 1))).toEqual([
      "cover",
      "body",
      "colophon",
    ]);
  });

  /** **本文は消せない。** 0では本にならない（`assertBlockCounts` と同じ判断） */
  test("本文は削除できない", () => {
    expect(canRemoveBookBlock(base, 2)).toBe(false);
    expect(removeBookBlockAt(base, 2)).toBeNull();
    expect(canRemoveBookBlock(base, 0)).toBe(true);
  });

  test("元の並びは書き換えない（保存に失敗しても画面だけが変わらない）", () => {
    insertBookBlockAfter(base, 0, { type: "afterword" });
    moveBookBlock(base, 0, 1);
    removeBookBlockAt(base, 0);

    expect(types(base)).toEqual(["cover", "toc", "body", "colophon"]);
  });
});

/**
 * ドラッグで落とした先の並び（設計書6.65.15の段D。作者の指定）。
 *
 * **ドラッグの見た目と、並びの変化を分ける。** 掴んだ・線が出た・離した
 * という見え方はwebviewでしか確かめられないが、「どこへ落ちたらどうなるか」
 * はここで固定できる。画面が渡すのは「どの隙間へ落としたか」だけで、
 * 計算はこの関数が1か所で持つ。
 */
describe("落とし先の並び（設計書6.65.15の段D）", () => {
  const base: BookBlock[] = [
    { type: "cover" },
    { type: "toc" },
    { type: "body" },
    { type: "colophon" },
  ];
  const types = (blocks: readonly BookBlock[] | null): string[] =>
    (blocks ?? []).map((block) => block.type);

  test("前の隙間へ落とすと、その面の手前に入る", () => {
    // 目次（1）を表紙（0）の前へ
    expect(types(dropBookBlock(base, 1, 0))).toEqual([
      "toc",
      "cover",
      "body",
      "colophon",
    ]);
  });

  test("後ろの隙間へ落とすと、その面の後ろに入る", () => {
    // 表紙（0）を本文（2）の後ろ＝隙間3へ
    expect(types(dropBookBlock(base, 0, 3))).toEqual([
      "toc",
      "body",
      "cover",
      "colophon",
    ]);
  });

  test("末尾の隙間へ落とすと、いちばん後ろに来る", () => {
    expect(types(dropBookBlock(base, 0, base.length))).toEqual([
      "toc",
      "body",
      "colophon",
      "cover",
    ]);
  });

  /**
   * **自分自身の上に落としたら、何も変わらない。** 前の隙間でも後ろの
   * 隙間でも並びは同じなので、どちらも「動かさなかった」と同じに扱う
   * （変わっていないのに未保存の印が付くのを防ぐ）。
   */
  test("自分自身の上に落としても変わらない（null で断る）", () => {
    expect(dropBookBlock(base, 1, 1)).toBeNull();
    expect(dropBookBlock(base, 1, 2)).toBeNull();
  });

  /**
   * **枠の外・範囲の外は何も起きない**（作者の指定）。Escで取りやめたときや、
   * 掴んだまま画面の外で離したときに、並びが黙って変わってはいけない。
   */
  test("範囲の外は何も起きない（null で断る）", () => {
    expect(dropBookBlock(base, -1, 2)).toBeNull();
    expect(dropBookBlock(base, base.length, 0)).toBeNull();
    expect(dropBookBlock(base, 0, -1)).toBeNull();
    expect(dropBookBlock(base, 0, base.length + 1)).toBeNull();
  });

  test("元の並びは書き換えない", () => {
    dropBookBlock(base, 0, 3);
    expect(types(base)).toEqual(["cover", "toc", "body", "colophon"]);
  });
});

/**
 * 面の保留（設計書6.65.15の段D。作者の依頼、2026-09-04）。
 *
 * **消さずに本から外す**ための印である。狙いは比較で、表紙を2案持って
 * 片方を保留にし、見比べてから決められるようにする——だから「1冊に1つ」の
 * 数えは**有効なものだけ**を見る。
 *
 * **保留は消すことの代わりではない。** 保留した面も設計図に残り、保存すれば
 * book.json に `suspended: true` として書かれる（作者の書いた面を消さない、
 * という約束はここでも変わらない）。
 */
describe("面の保留（設計書6.65.15の段D）", () => {
  const types = (blocks: readonly BookBlock[] | null): string[] =>
    (blocks ?? []).map((block) => block.type);

  test("suspended を書いた面は、保留として読み取る", () => {
    const config = parseBookConfig(
      {
        blocks: [
          { type: "cover", suspended: true },
          { type: "cover" },
          { type: "body" },
        ],
      },
      "氷の街"
    );

    expect(config.blocks?.[0]).toEqual({ type: "cover", suspended: true });
    // **有効な面には項目を足さない。** 足すと、いままでの book.json が
    // 保存のたびに `suspended: false` だらけになる
    expect(config.blocks?.[1]).toEqual({ type: "cover" });
  });

  /** **古い book.json はそのまま読める。** 省略＝有効である */
  test("suspended を書いていない面は、有効のまま（項目も増やさない）", () => {
    const config = parseBookConfig(
      { blocks: [{ type: "cover" }, { type: "body" }] },
      "氷の街"
    );

    expect(config.blocks).toEqual([{ type: "cover" }, { type: "body" }]);
    expect(activeBookBlocks(config.blocks ?? [])).toHaveLength(2);
  });

  test("画像の面も保留にできる（絵の場所の検証はそのまま）", () => {
    const config = parseBookConfig(
      {
        blocks: [
          { type: "body" },
          { type: "sectionArt", imagePath: "素材/扉.png", suspended: true },
        ],
      },
      "氷の街"
    );

    expect(config.blocks?.[1]).toEqual({
      type: "sectionArt",
      imagePath: "素材/扉.png",
      caption: "",
      suspended: true,
    });
  });

  test("suspended が真偽値でなければ弾く（黙って有効にしない）", () => {
    expect(() =>
      parseBookConfig(
        { blocks: [{ type: "cover", suspended: "yes" }, { type: "body" }] },
        "氷の街"
      )
    ).toThrow();
  });

  /** **本文は保留にできない**（本文の無い本になる。削除と同じ理由） */
  test("本文の保留は受け取らない", () => {
    expect(() =>
      parseBookConfig(
        { blocks: [{ type: "cover" }, { type: "body", suspended: true }] },
        "氷の街"
      )
    ).toThrow();
  });

  /** これが本命：表紙を2案持って見比べる（作者の依頼） */
  test("1冊に1つの面でも、片方が保留なら2つ書ける", () => {
    const config = parseBookConfig(
      {
        blocks: [
          { type: "cover" },
          { type: "cover", suspended: true },
          { type: "body" },
        ],
      },
      "氷の街"
    );

    expect(config.blocks).toHaveLength(3);
  });

  test("有効な面が2つあれば、いままでどおり弾く", () => {
    expect(() =>
      parseBookConfig(
        {
          blocks: [{ type: "cover" }, { type: "cover" }, { type: "body" }],
        },
        "氷の街"
      )
    ).toThrow();
  });

  /**
   * **仕様を戻した**（0.32.0のレビュー）。0.32.0では「数えるのは有効な面
   * だけ」に緩め、保留にすればもう1枚挿せるようにしていた。
   *
   * だが表紙・遊び紙・目次・人物紹介・奥付・裏表紙の中身は、どれも
   * `BookConfig`（本に1つの設定欄）から来る。2枚置いても**完全に同じ面が
   * 2枚並ぶだけ**で、狙っていた「2案の見比べ」はできない。挿せないほうが
   * 正しい——面ごとに中身を持てるようになったら（将来の段E）緩める。
   */
  test("保留の面が居ても、同じ種類はもう挿せない（同じものが並ぶだけ）", () => {
    const blocks: BookBlock[] = [
      { type: "cover", suspended: true },
      { type: "body" },
    ];

    expect(canAddBookBlock(blocks, "cover")).toBe(false);
    expect(insertBookBlockAfter(blocks, 0, { type: "cover" })).toBeNull();
    // 何枚でも置ける種類は、保留があっても今までどおり挿せる
    expect(canAddBookBlock(blocks, "sectionArt")).toBe(true);
  });

  test("保留にすると suspended が付く（解除すると項目ごと消える）", () => {
    const blocks: BookBlock[] = [{ type: "cover" }, { type: "body" }];

    const suspended = setBookBlockSuspended(blocks, 0, true);
    expect(suspended?.[0]).toEqual({ type: "cover", suspended: true });

    const resumed = setBookBlockSuspended(suspended ?? [], 0, false);
    expect(resumed?.[0]).toEqual({ type: "cover" });
    // 元の並びは書き換えない（ほかの編集と同じ約束）
    expect(blocks[0]).toEqual({ type: "cover" });
  });

  test("本文は保留にできない（null で断る）", () => {
    const blocks: BookBlock[] = [{ type: "cover" }, { type: "body" }];

    expect(canSuspendBookBlock(blocks, 1)).toBe(false);
    expect(setBookBlockSuspended(blocks, 1, true)).toBeNull();
    expect(canSuspendBookBlock(blocks, 0)).toBe(true);
  });

  /**
   * **解除は、同じ種類の有効な面が居れば断る。** 黙って2つ有効にすると、
   * どちらの設定が効いた本なのか作者に分からなくなる（`assertBlockCounts`
   * が保存で断る形と、ここでの断り方を一致させる）。
   */
  test("同じ種類の有効な面が居れば、保留を解除できない", () => {
    const blocks: BookBlock[] = [
      { type: "cover" },
      { type: "cover", suspended: true },
      { type: "body" },
    ];

    expect(canResumeBookBlock(blocks, 1)).toBe(false);
    expect(setBookBlockSuspended(blocks, 1, false)).toBeNull();
  });

  test("同じ種類が居なければ解除できる", () => {
    const blocks: BookBlock[] = [
      { type: "cover", suspended: true },
      { type: "body" },
    ];

    expect(canResumeBookBlock(blocks, 0)).toBe(true);
    expect(types(setBookBlockSuspended(blocks, 0, false))).toEqual([
      "cover",
      "body",
    ]);
  });

  /** 扉絵・口絵は何枚でも置けるので、解除も縛らない */
  test("何枚でも置ける面は、有効なものが居ても解除できる", () => {
    const blocks: BookBlock[] = [
      { type: "body" },
      { type: "sectionArt", imagePath: "素材/扉1.png", caption: "" },
      {
        type: "sectionArt",
        imagePath: "素材/扉2.png",
        caption: "",
        suspended: true,
      },
    ];

    expect(canResumeBookBlock(blocks, 2)).toBe(true);
  });

  test("保留の面も削除はできる（保留は消すことの代わりではない）", () => {
    const blocks: BookBlock[] = [
      { type: "cover", suspended: true },
      { type: "body" },
    ];

    expect(canRemoveBookBlock(blocks, 0)).toBe(true);
    expect(types(removeBookBlockAt(blocks, 0))).toEqual(["body"]);
  });

  test("範囲の外は何も起きない（null で断る）", () => {
    const blocks: BookBlock[] = [{ type: "cover" }, { type: "body" }];

    expect(setBookBlockSuspended(blocks, -1, true)).toBeNull();
    expect(setBookBlockSuspended(blocks, 9, true)).toBeNull();
    expect(canSuspendBookBlock(blocks, 9)).toBe(false);
    expect(canResumeBookBlock(blocks, 9)).toBe(false);
    // 有効な面を「解除」しようとしても、何も起きない
    expect(setBookBlockSuspended(blocks, 0, false)).toBeNull();
  });

  test("有効な面だけを取り出せる（出力はこれを見る）", () => {
    const blocks: BookBlock[] = [
      { type: "cover" },
      { type: "toc", suspended: true },
      { type: "body" },
    ];

    expect(activeBookBlocks(blocks).map((block) => block.type)).toEqual([
      "cover",
      "body",
    ]);
    expect(isBookBlockSuspended(blocks[1])).toBe(true);
    expect(isBookBlockSuspended(blocks[0])).toBe(false);
  });
});
