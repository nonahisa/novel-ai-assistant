import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  clampReadAloudRate,
} from "../../src/features/manuscriptEditor";
import { manuscriptViewTypeFor } from "../../src/core/manuscriptViewTypes";
import { allActions } from "../../src/views/actionList";
import {
  READ_ALOUD_MEMO_TEXT,
  buildReadingPlan,
} from "../../src/core/readAloud";
import { isMemoLine, parseMemos } from "../../src/core/sceneMemo";

/**
 * 読み上げ（音読推敲。設計書6.42）。
 *
 * **本文は1文字も変わらない**のが前提なので、ここで確かめるのは
 * 「どこで切るか」と「何と読ませるか」、そして**位置が元の本文のものか**の
 * 3つである。位置がずれると、読んでいる文と光っている文が食い違う。
 */

/** その計画を、声に渡す文字列だけの並びにする（読みやすさのため） */
function speeches(text: string, notation: "curly" | "site" = "curly"): string[] {
  return buildReadingPlan(text, notation).map((sentence) => sentence.speech);
}

describe("文の区切り", () => {
  it("句点・感嘆符・疑問符の直後で切る", () => {
    expect(speeches("晴れた。雨だ！本当か？")).toEqual([
      "晴れた。",
      "雨だ！",
      "本当か？",
    ]);
  });

  it("半角の感嘆符・疑問符でも切る", () => {
    expect(speeches("そうか!それで?")).toEqual(["そうか!", "それで?"]);
  });

  /** 「えっ！」「？」と割ると、声が2度途切れる */
  it("終わりの字が続いていたら、まとめて1つの切れ目にする", () => {
    expect(speeches("えっ！？そうか。")).toEqual(["えっ！？", "そうか。"]);
  });

  /** 閉じ括弧だけの文を作らない */
  it("終わりの字のあとの閉じ括弧は、前の文に含める", () => {
    expect(speeches("「行こう。」と彼は言った。")).toEqual([
      "「行こう。」",
      "と彼は言った。",
    ]);
  });

  /** 句点を打たない地の文・台詞だけの行がある */
  it("行末も切れ目になる", () => {
    expect(speeches("空を見た\n海を見た")).toEqual(["空を見た", "海を見た"]);
  });

  it("空行は文にしない", () => {
    expect(speeches("一。\n\n三。")).toEqual(["一。", "三。"]);
  });

  it("空白だけの行も文にしない", () => {
    expect(speeches("一。\n　\n三。")).toEqual(["一。", "三。"]);
  });

  /**
   * Chromium は長すぎる文の途中で黙る。**上限を超えてから最初の読点**で切る
   * （超える前に切ると、短い文が並んでかえって読みが途切れる）。
   */
  it("200字を超えたら、読点の直後でも切る", () => {
    const long =
      "あ".repeat(100) + "、" + "い".repeat(100) + "、" + "う".repeat(100) + "。";
    const plan = buildReadingPlan(long, "curly");

    expect(plan).toHaveLength(2);
    expect(plan[0].speech).toBe("あ".repeat(100) + "、" + "い".repeat(100) + "、");
    expect(plan[1].speech).toBe("う".repeat(100) + "。");
  });

  it("200字までなら、読点があっても割らない", () => {
    expect(speeches("あ、い、う。")).toEqual(["あ、い、う。"]);
  });

  /** 読点の無い長文を字数で切ると、語の途中で息継ぎが入る */
  it("読点が無ければ、長くても割らない", () => {
    const long = "あ".repeat(400) + "。";
    expect(buildReadingPlan(long, "curly")).toHaveLength(1);
  });
});

/**
 * **記法の内側で切らない**（レビュー指摘、2026-08-29）。
 *
 * ルビの親文字や傍点の中に `。！？` が入っていることがある。そこで切ると、
 * 1つの記法が2つの文に割れて**光る範囲が記法の途中で途切れる**うえ、
 * 前半だけを `tokenizeLine` に掛けても記法として読めないので、
 * 声が記号を読み上げる。
 */
describe("記法の内側では切らない", () => {
  it("傍点の中の句点で切らない", () => {
    const text = "それは{{嘘だ。}}と思った。";
    const plan = buildReadingPlan(text, "curly");

    expect(plan).toHaveLength(1);
    // ハイライトの範囲が記法の途中で割れない
    expect(text.slice(plan[0].start, plan[0].end)).toBe(text);
    expect(plan[0].speech).toBe("それは嘘だ。と思った。");
  });

  it("ルビの親文字の中の感嘆符で切らない", () => {
    const plan = buildReadingPlan("{嘘!|うそ}だった。", "curly");

    expect(plan).toHaveLength(1);
    // 親文字ではなく読み仮名を読む（割れていれば「嘘!」が残る）
    expect(plan[0].speech).toBe("うそだった。");
  });

  it("投稿サイトの記法でも、傍点の中で切らない", () => {
    const text = "彼は《《本当か？》》と言った。";
    const plan = buildReadingPlan(text, "site");

    expect(plan).toHaveLength(1);
    expect(text.slice(plan[0].start, plan[0].end)).toBe(text);
    expect(plan[0].speech).toBe("彼は本当か？と言った。");
  });

  it("投稿サイトのルビの中の疑問符でも切らない", () => {
    const plan = buildReadingPlan("｜嘘?《うそ》だった。", "site");

    expect(plan).toHaveLength(1);
    expect(plan[0].speech).toBe("うそだった。");
  });

  /** 書きかけの記法（閉じていない）は、これまでどおり平文として扱う */
  it("記法の外の終わりの字では、これまでどおり切る", () => {
    expect(speeches("{嘘|うそ}だ。本当だ。")).toEqual(["うそだ。", "本当だ。"]);
  });

  /** 200字の割りも同じ（読点が記法の中にあれば、そこでは切らない） */
  it("記法の中の読点では、長くても切らない", () => {
    const inner = "あ".repeat(120) + "、" + "い".repeat(120);
    const plan = buildReadingPlan("{{" + inner + "}}。", "curly");

    expect(plan).toHaveLength(1);
  });
});

describe("位置は元の本文のもの", () => {
  const text = "　晴れた。雨だ！\n海を見た";

  it("start と end で切り出すと、記法つきの原文に戻る", () => {
    const plan = buildReadingPlan(text, "curly");

    expect(plan.map((sentence) => text.slice(sentence.start, sentence.end))).toEqual(
      ["晴れた。", "雨だ！", "海を見た"]
    );
  });

  /** 段落の字下げまで光らせると、文の頭が1文字ずれて見える */
  it("字下げの全角空白は範囲に入れない", () => {
    expect(buildReadingPlan(text, "curly")[0].start).toBe(1);
  });

  it("行番号は1始まりで、行をまたいで数える", () => {
    expect(buildReadingPlan(text, "curly").map((s) => s.line)).toEqual([1, 1, 2]);
  });
});

describe("シーンメモ", () => {
  const text = "// TODO 直す\n本文です。";

  it("メモの行は文にしない", () => {
    expect(speeches(text)).toEqual(["本文です。"]);
  });

  /** 行が減ったぶんだけ位置がずれると、別の場所が光る */
  it("メモを飛ばしても、位置は元の本文のまま", () => {
    const plan = buildReadingPlan(text, "curly");

    expect(text.slice(plan[0].start, plan[0].end)).toBe("本文です。");
    expect(plan[0].line).toBe(2);
  });

  it("全角の印（／／）のメモも読まない", () => {
    expect(speeches("／／あとで直す\n本文です。")).toEqual(["本文です。"]);
  });

  /**
   * 「引っかかった」で置く行が、**メモとして数えられる**こと
   * （設計書6.42。数えられないと、シーンメモのパネルに出てこない）。
   */
  it("引っかかったの行は、メモ行として読まれる", () => {
    const line = "// " + READ_ALOUD_MEMO_TEXT;

    expect(isMemoLine(line)).toBe(true);
    const memos = parseMemos(line + "\n本文です。", "1.md");
    expect(memos).toHaveLength(1);
    expect(memos[0].line).toBe(1);
    // タグとして読まれても本文扱いでもよい。**中身が残る**ことだけを見る
    expect(memos[0].tag + memos[0].text).toContain("音読");

    // その行は、読み上げの文にもならない
    expect(speeches(line + "\n本文です。")).toEqual(["本文です。"]);
  });
});

describe("声に渡す文字列", () => {
  /** 読み仮名を振るのは、そう読ませたいからである */
  it("ルビは読み仮名で読む（.md の記法）", () => {
    expect(speeches("{灯|あかり}が点る。")).toEqual(["あかりが点る。"]);
  });

  it("ルビは読み仮名で読む（投稿サイトの記法）", () => {
    expect(speeches("｜灯《あかり》が点る。", "site")).toEqual(["あかりが点る。"]);
  });

  it("縦線を省いたルビも読み仮名で読む", () => {
    expect(speeches("灯《あかり》が点る。", "site")).toEqual(["あかりが点る。"]);
  });

  it("傍点は印を外して中身だけ読む（.md の記法）", () => {
    expect(speeches("それは{{嘘}}だ。")).toEqual(["それは嘘だ。"]);
  });

  it("傍点は印を外して中身だけ読む（投稿サイトの記法）", () => {
    expect(speeches("それは《《嘘》》だ。", "site")).toEqual(["それは嘘だ。"]);
  });

  /** 声は「ダッシュ」と読み上げたり、無音で詰まったりする */
  it("ダッシュの連なりは読点1つになる", () => {
    expect(speeches("そして――彼は消えた。")).toEqual(["そして、彼は消えた。"]);
  });

  it("三点リーダの連なりも読点1つになる", () => {
    expect(speeches("そう……ですか。")).toEqual(["そう、ですか。"]);
  });

  it("ダッシュと三点リーダが続いても、読点は1つ", () => {
    expect(speeches("待って――……行くな。")).toEqual(["待って、行くな。"]);
  });

  /** 書きかけの記法は平文として残る。声に「なみかっこ」と読ませない */
  it("記法の残骸は落とす", () => {
    expect(speeches("書きかけ{漢字|です。")).toEqual(["書きかけ漢字です。"]);
    expect(speeches("｜印です。")).toEqual(["印です。"]);
    expect(speeches("《残り》です。")).toEqual(["残りです。"]);
  });

  it("記号と空白しか無い文は捨てる", () => {
    expect(speeches("本文。\n――\n続き。")).toEqual(["本文。", "、", "続き。"]);
    expect(speeches("本文。\n｜｜\n続き。")).toEqual(["本文。", "続き。"]);
  });
});

/*
  **「その位置を含む文の添字」の試験は、ここには無い**（レビュー指摘、
  2026-08-29）。同じ探索が画面側（`aloudIndexAt`）にもあり、写しが2つに
  なっていた。「ここから」は往復を待たずに飛ぶ必要があって画面側は消せない
  ので、こちらを消してある（`src/core/readAloud.ts` の注記を参照）。
*/

/**
 * 読み上げの速さの既定（設計書6.42、実機確認リスト F-49）。
 *
 * 列の「速さ」は、開いた時点で**設定の値**から始まる。設定に 2 と
 * 書いてあれば、列の既定も 2 になる。
 *
 * **範囲の外の値は畳む。** `package.json` の `minimum`/`maximum` は案内で
 * あって強制ではなく、`settings.json` へ直接 `10` と書けばその値が届く。
 * 範囲外の `rate` は、環境によっては**声が一言も出ない**（黙って失敗する）。
 */
describe("列に渡す速さの既定", () => {
  it("設定の値を、そのまま列の既定にする（実機確認リスト F-49 の代わり）", () => {
    expect(clampReadAloudRate(2)).toBe(2);
    expect(clampReadAloudRate(0.5)).toBe(0.5);
    expect(clampReadAloudRate(1)).toBe(1);
  });

  it("速すぎる指定は、上限まで畳む（実機確認リスト F-49 の代わり）", () => {
    // 畳まないと、声が一言も出ない環境がある
    expect(clampReadAloudRate(10)).toBe(2);
  });

  it("遅すぎる指定は、下限まで畳む（実機確認リスト F-49 の代わり）", () => {
    expect(clampReadAloudRate(0.1)).toBe(0.5);
  });

  it("数でない値が届いても、標準の速さへ戻す（実機確認リスト F-49 の代わり）", () => {
    expect(clampReadAloudRate(Number.NaN)).toBe(1);
  });

  it("畳む範囲が、設定の定義と合っている（実機確認リスト F-49 の代わり）", () => {
    // 片方だけ動かすと、案内と実際の動きが食い違う
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: {
        configuration: {
          properties: Record<
            string,
            { default?: number; minimum?: number; maximum?: number }
          >;
        };
      };
    };
    const defined =
      manifest.contributes.configuration.properties[
        "novelai.manuscriptEditor.readAloudRate"
      ];

    expect(defined.minimum).toBe(clampReadAloudRate(-1));
    expect(defined.maximum).toBe(clampReadAloudRate(99));
    expect(defined.default).toBe(clampReadAloudRate(Number.NaN));
  });
});

/**
 * 詳細メニューからの入口（設計書6.42、実機確認リスト F-49）。
 *
 * **押しても勝手に読み始めない。** 列を出すだけにしてある——
 * 押した瞬間に声が出ると、周りに人がいる場所では取り返しがつかない。
 * 列が実際に画面へ出ることは実機に残る。
 */
describe("「原稿を読み上げる（音読推敲）」の入口", () => {
  const entry = () => {
    const found = allActions().find(
      (item) => item.command === "novelai.readManuscriptAloud"
    );
    if (!found) throw new Error("読み上げの操作が詳細メニューにありません");
    return found;
  };

  it("詳細メニューに、AIを使わない操作として並ぶ（実機確認リスト F-49 の代わり）", () => {
    expect(entry().label).toBe("原稿を読み上げる");
    expect(entry().note).toBe("音読推敲");
    // OSの声で読むので、料金はかからないし原稿も外へ出ない
    expect(entry().usesAI).toBe(false);
  });

  it("小説では、横書きの入口で開く（実機確認リスト F-49 の代わり）", () => {
    // 縦書きで開くのは脚本だけ（設計書6.70）。作品一覧から開いたときと同じ
    expect(manuscriptViewTypeFor(undefined)).toBe(
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    );
    expect(manuscriptViewTypeFor("novel")).toBe(
      MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE
    );
  });

  it("押した作品の原稿を開く（書庫でも取り違えない）（実機確認リスト F-49 の代わり）", () => {
    // 開く先は、押された作品から選ぶ（`pickReadAloudTarget(work)`）。
    // ここが「いま開いているファイル」だけだと、書庫で別の作品を選んでも
    // 前の作品の原稿が読まれる
    const source = readFileSync("src/features/manuscriptEditor.ts", "utf-8");
    const at = source.indexOf("export async function openManuscriptForReading");
    expect(at).toBeGreaterThan(0);

    expect(source.slice(at, at + 300)).toContain("pickReadAloudTarget(work)");
  });
});
