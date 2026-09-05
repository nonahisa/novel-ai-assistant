import { describe, expect, it } from "vitest";
import {
  classifyScriptLine,
  scriptLineClass,
  splitSerifu,
  SCRIPT_LINE_CSS,
  SCRIPT_LINE_RULES,
} from "../../src/core/scriptLines";

/**
 * 脚本の行の種別（設計書6.70）。
 *
 * **判定は文字列の形だけを見る。** 本文の意味も、作品の設定も見ない。
 * 原稿エディタ・PDFの両方が同じ答えを使うので、ここがずれると
 * 画面と紙で組み方が食い違う。
 */

/** 見分けの付かない字は符号から作る（○ と 〇 は別の文字である） */
/** ○ WHITE CIRCLE（柱に使われる記号） */
const CIRCLE = String.fromCodePoint(0x25cb);
/** 〇 IDEOGRAPHIC NUMBER ZERO（見た目は同じ。IMEによってはこちらが出る） */
const ZERO = String.fromCodePoint(0x3007);
/** 　 全角空白（ト書きの字下げ） */
const WIDE_SPACE = String.fromCodePoint(0x3000);

describe("柱（○シーン名）", () => {
  it("○ で始まる行は柱", () => {
    expect(classifyScriptLine(CIRCLE + "駅前・夜")).toBe("hashira");
  });

  /**
   * **漢数字のゼロも受ける。** 見た目が同じで、IMEの候補としては
   * こちらが先に出ることがある。作者が「柱のつもりで書いた行」を
   * 記号の違いだけで落とすと、原因に気づけない。
   */
  it("〇（漢数字のゼロ）で始まる行も柱", () => {
    expect(classifyScriptLine(ZERO + "駅前・夜")).toBe("hashira");
  });

  it("行の途中の ○ は柱にしない", () => {
    expect(classifyScriptLine("彼は" + CIRCLE + "を描いた")).toBe("plain");
  });

  /** 柱の中に「」があっても、柱のまま（先に見る） */
  it("柱が先。セリフの形に見えても柱", () => {
    expect(classifyScriptLine(CIRCLE + "喫茶「みなと」")).toBe("hashira");
  });
});

describe("ト書き（全角空白で始まる行）", () => {
  it("全角空白で始まる行はト書き", () => {
    expect(classifyScriptLine(WIDE_SPACE + "太郎、ドアを開ける。")).toBe(
      "togaki"
    );
  });

  it("半角空白では、ト書きにしない", () => {
    // 半角の字下げは、小説の原稿では使わない書き方である。
    // **推測で拾わない**——拾うと、英文の引用が全部ト書きになる
    expect(classifyScriptLine(" 太郎、ドアを開ける。")).toBe("plain");
  });

  /** 全角空白のあとにセリフの形が続いても、ト書きのまま */
  it("ト書きはセリフより先に見る", () => {
    expect(classifyScriptLine(WIDE_SPACE + "太郎「…」")).toBe("togaki");
  });
});

describe("セリフ（役名「…」）", () => {
  it("役名のあとに「が来る行はセリフ", () => {
    expect(classifyScriptLine("太郎「おはよう」")).toBe("serifu");
  });

  it("役名は12字まで", () => {
    expect(classifyScriptLine("あ".repeat(12) + "「はい」")).toBe("serifu");
    // 13字は役名ではない。地の文が「で始まる会話に当たってしまう
    expect(classifyScriptLine("あ".repeat(13) + "「はい」")).toBe("plain");
  });

  it("いきなり「で始まる行（小説の会話文）はセリフにしない", () => {
    expect(classifyScriptLine("「おはよう」と太郎が言った。")).toBe("plain");
  });

  it("役名に空白が入っていたらセリフにしない", () => {
    expect(classifyScriptLine("太郎 「おはよう」")).toBe("plain");
    expect(classifyScriptLine("太郎" + WIDE_SPACE + "「おはよう」")).toBe(
      "plain"
    );
  });

  it("括弧付きの指示も役名の側に含める", () => {
    expect(classifyScriptLine("太郎（小声）「行こう」")).toBe("serifu");
    expect(splitSerifu("太郎（小声）「行こう」")).toEqual({
      role: "太郎（小声）",
      speech: "「行こう」",
    });
  });

  /**
   * **ルビ記法が混ざっても壊れない。** 判定は文字列の形だけを見るので、
   * 役名にルビが振ってあっても、ただの字として数える。
   */
  it("ルビ記法つきの役名でもセリフ", () => {
    expect(classifyScriptLine("{太郎|たろう}「おはよう」")).toBe("serifu");
    expect(classifyScriptLine("｜太郎《たろう》「おはよう」")).toBe("serifu");
  });

  /** **役名と発話を足すと元の行に戻る**（1文字も落とさない） */
  it("分けたものを繋ぐと、元の行に戻る", () => {
    const line = "花子（ため息）「またなの」";
    const parts = splitSerifu(line);
    expect(parts).toBeDefined();
    expect((parts?.role ?? "") + (parts?.speech ?? "")).toBe(line);
  });

  it("セリフでない行を分けようとしたら、何も返さない", () => {
    expect(splitSerifu("　太郎、ドアを開ける。")).toBeUndefined();
    expect(splitSerifu("")).toBeUndefined();
  });
});

describe("それ以外", () => {
  it("空行は plain", () => {
    expect(classifyScriptLine("")).toBe("plain");
  });

  it("ふつうの地の文は plain", () => {
    expect(classifyScriptLine("　　　　　")).toBe("togaki");
    expect(classifyScriptLine("太郎は駅へ向かった。")).toBe("plain");
  });
});

describe("class の名前", () => {
  it("種別ごとの class が付き、plain には付かない", () => {
    expect(scriptLineClass(CIRCLE + "駅前")).toBe("script-hashira");
    expect(scriptLineClass(WIDE_SPACE + "歩く")).toBe("script-togaki");
    expect(scriptLineClass("太郎「はい」")).toBe("script-serifu");
    expect(scriptLineClass("ふつうの行")).toBe("");
  });
});

describe("組み方の指定（SCRIPT_LINE_CSS）", () => {
  /**
   * **縦書きでも横書きでも同じ規則で効かせる。** 上下左右で書くと、
   * 縦書きにしたときに字下げが行の頭ではなく紙の左へ寄る。
   */
  it("論理プロパティで書いてある（上下左右で書かない）", () => {
    expect(SCRIPT_LINE_CSS).toContain("padding-inline-start");
    expect(SCRIPT_LINE_CSS).not.toContain("padding-left");
    expect(SCRIPT_LINE_CSS).not.toContain("margin-top");
    expect(SCRIPT_LINE_CSS).not.toContain("padding-top");
  });

  it("3つの種別ぶんの規則がある", () => {
    expect(SCRIPT_LINE_CSS).toContain(".script-hashira");
    expect(SCRIPT_LINE_CSS).toContain(".script-togaki");
    expect(SCRIPT_LINE_CSS).toContain(".script-serifu");
  });

  /** 画面側JSへ渡す規則の表（写しを置かないための入口） */
  it("種別の並びは、柱・ト書き・セリフの順", () => {
    expect(SCRIPT_LINE_RULES.map((rule) => rule.kind)).toEqual([
      "hashira",
      "togaki",
      "serifu",
    ]);
  });
});
