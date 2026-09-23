import { describe, expect, test } from "vitest";
import {
  collectedEpisodeAt,
  extractEpisodeParts,
  sourceForPostingCopy,
  nameWithSubtitle,
} from "../../src/core/episodeCopy";
import { convertForPosting } from "../../src/core/postingConvert";
import type { PostingCopyTarget } from "../../src/core/postingCopyTargets";
import {
  formatChapterLabel,
  stripChapterLabel,
} from "../../src/core/episodeLabel";

/**
 * サブタイトル・本文のコピーと、ファイル名への付与（設計書6.2.3）。
 *
 * **投稿するときの手作業を減らす。** 投稿欄はサブタイトルと本文が別々の
 * 入力になっている。毎話、ファイルを開いてヘッダーを避けて本文を選んで、
 * ルビを書き換えて……を繰り返すのは、書く時間を削る。
 */
const WITH_HEADER = [
  "【タイトル】",
  "転生",
  "",
  "【公開状態】",
  "公開",
  "",
  "【本文】",
  "気がつくと{森|もり}の中だった。",
].join("\n");

describe("サブタイトルと本文を取り出す", () => {
  test("ヘッダーがあれば、そこから読む", () => {
    const parts = extractEpisodeParts(WITH_HEADER, null);

    expect(parts.subtitle).toBe("転生");
    expect(parts.body).toContain("気がつくと");
    // **ヘッダーは本文に含めない**
    expect(parts.body).not.toContain("【公開状態】");
  });

  test("ファイルの中の題を、ファイル名より優先する", () => {
    // **ファイル名は作者が自由に変えられるが、
    // 中の【タイトル】は投稿したときの題そのものである**
    expect(extractEpisodeParts(WITH_HEADER, "べつの題").subtitle).toBe("転生");
  });

  test("ヘッダーが無ければ、全体が本文", () => {
    const parts = extractEpisodeParts("ただの本文。", "ファイル名の題");

    expect(parts.body).toBe("ただの本文。");
    expect(parts.subtitle).toBe("ファイル名の題");
  });

  test("どこにも題が無ければ null", () => {
    expect(extractEpisodeParts("本文だけ。", null).subtitle).toBeNull();
  });
});

/**
 * 投稿サイト用の本文（設計書6.84）。
 *
 * **変換そのものは `convertForPosting` が1つだけ持つ**（0.37.5に寄せた）。
 * ここに記法だけの変換を残しておくと、それを呼ぶ入口が「noteだけ整えない
 * 経路」になる——実際に投稿キットがそうなっていた。
 */
describe("投稿サイト用の本文", () => {
  /** 記法だけを見る貼り付け先。`site` を持たせない（noteの整えを通さない） */
  function notation(
    style: PostingCopyTarget["style"],
    emphasis: PostingCopyTarget["emphasis"] = "kakuyomu"
  ): PostingCopyTarget {
    return { label: "試験", detail: "", style, emphasis, registered: false };
  }

  test("ルビを投稿サイトの記法へ直す", () => {
    const parts = extractEpisodeParts(WITH_HEADER, null);

    expect(convertForPosting(parts.body, notation("site")).text).toContain(
      "｜森《もり》"
    );
  });

  test("HTMLでも出せる", () => {
    expect(convertForPosting("{森|もり}", notation("html")).text).toBe(
      "<ruby>森<rt>もり</rt></ruby>"
    );
  });

  test("1話まるごとの経路では、前後の空行を落とす", () => {
    // **投稿欄の先頭に空行が入ると、1行目が空いた状態で公開される**
    expect(
      convertForPosting("\n\n本文。\n\n", notation("site"), {
        trimEdges: true,
      }).text
    ).toBe("本文。");
  });

  test("ルビが無ければ、本文はそのまま", () => {
    expect(convertForPosting("ただの本文。", notation("site")).text).toBe(
      "ただの本文。"
    );
  });

  /**
   * **傍点はサイトによって書き方が違う**（設計書6.12.4）。
   * なろう・アルファポリスへ貼る本文にカクヨムの `《《…》》` が出ると、
   * 読者の目の前に記号が並ぶ。
   */
  describe("傍点の貼り付け先", () => {
    test("なろう・アルファポリスはルビで代用する", () => {
      expect(
        convertForPosting("これは{{大事}}だ", notation("site", "narou")).text
      ).toBe("これは｜大事《・・》だ");
    });

    test("カクヨム・ネオページは専用の記法", () => {
      expect(
        convertForPosting("これは{{大事}}だ", notation("site", "kakuyomu")).text
      ).toBe("これは《《大事》》だ");
    });

    test("noteへ貼る括弧書きでは、傍点の印だけを落とす", () => {
      expect(
        convertForPosting("{森|もり}と{{大事}}", notation("paren")).text
      ).toBe("森（もり）と大事");
    });
  });
});

describe("ファイル名にサブタイトルを付ける", () => {
  test("話数の後ろに足す", () => {
    // **話数の部分は変えない。** そこは並び順を決めている
    expect(nameWithSubtitle("episode_0001.txt", null, "転生")).toBe(
      "episode_0001_転生.txt"
    );
  });

  test("既に同じものが付いていれば、何もしない", () => {
    expect(
      nameWithSubtitle("episode_0001_転生.txt", "転生", "転生")
    ).toBeUndefined();
  });

  test("違う題なら、付け替える（重ねない）", () => {
    // **重ねると episode_0001_転生_出会い.txt になる**
    expect(nameWithSubtitle("episode_0001_転生.txt", "転生", "出会い")).toBe(
      "episode_0001_出会い.txt"
    );
  });

  test("題が無ければ、何もしない", () => {
    expect(nameWithSubtitle("episode_0001.txt", null, null)).toBeUndefined();
    expect(nameWithSubtitle("episode_0001.txt", null, "  ")).toBeUndefined();
  });

  test("ファイル名に使えない記号を落とす", () => {
    const next = nameWithSubtitle("episode_0001.txt", null, "第一章/序");

    expect(next).toBeDefined();
    expect(next).not.toContain("/");
  });

  test("拡張子は変えない", () => {
    expect(nameWithSubtitle("episode_0001.md", null, "転生")).toBe(
      "episode_0001_転生.md"
    );
  });
});

describe("投稿サイトの題から話数を落としてから足す", () => {
  /**
   * **投稿サイトのヘッダーには話数込みで入っている。**
   *
   * ```
   * 【タイトル】
   * 第15話　イジメっ子襲撃
   * ```
   *
   * そのまま足すと `episode_0015_第15話　イジメっ子襲撃.txt` になり、
   * 話数が二重になる（2026-08-21、作者の指摘）。一覧の見出しは
   * `stripChapterLabel` を通しているのに、改名だけ通っていなかった。
   */
  const episode = {
    kind: "本編" as const,
    chapterStart: 15,
    chapterEnd: 15,
    date: null,
    dateSeq: null,
  };

  test("話数を落としてからファイル名に足す", () => {
    const stripped = stripChapterLabel(
      "第15話　イジメっ子襲撃",
      formatChapterLabel(episode)
    );
    expect(stripped).toBe("イジメっ子襲撃");
    expect(nameWithSubtitle("episode_0015.txt", null, stripped)).toBe(
      "episode_0015_イジメっ子襲撃.txt"
    );
  });

  test("題が話数だけなら、足すものが無い", () => {
    // 「第16話」だけの題。足しても情報が増えない
    const stripped = stripChapterLabel("第16話", formatChapterLabel({
      ...episode,
      chapterStart: 16,
      chapterEnd: 16,
    }));
    expect(stripped).toBeNull();
    expect(nameWithSubtitle("episode_0016.txt", null, stripped)).toBeUndefined();
  });

  test("話数が付いていない題は、そのまま足す", () => {
    const stripped = stripChapterLabel("転生", formatChapterLabel(episode));
    expect(nameWithSubtitle("episode_0015.txt", null, stripped)).toBe(
      "episode_0015_転生.txt"
    );
  });
});

/**
 * 「投稿サイト用に変換してコピー」で、何を変換にかけるか（設計書6.12.1）。
 *
 * **選択していないときに、ヘッダーごとコピーしていた**（2026-09-06、
 * 作者の裁定）。カクヨム形式のファイルは頭に【タイトル】〜【本文】が
 * 付いており、それを投稿欄へ貼ると、題名の行から二重に入ってしまう。
 */
describe("コピーする元を決める", () => {
  test("選んでいなければ、ヘッダーを外した本文だけ", () => {
    const source = sourceForPostingCopy(WITH_HEADER);

    expect(source).toBe("気がつくと{森|もり}の中だった。");
    expect(source).not.toContain("【タイトル】");
  });

  test("ヘッダーが無ければ、これまでどおり全文", () => {
    expect(sourceForPostingCopy("ただの本文。")).toBe("ただの本文。");
  });

  test("選んであれば、選んだ範囲だけ", () => {
    // ヘッダーごと選ぶのは作者の意思。**選択には手を入れない**
    expect(sourceForPostingCopy(WITH_HEADER, "【タイトル】\n転生")).toBe(
      "【タイトル】\n転生"
    );
  });
});

/**
 * 合本（1ファイルに全話）のときに、1話ぶんだけコピーする（設計書6.12.1）。
 *
 * **全話が、区切り行と頭書きごとクリップボードへ入っていた**（2026-09-12、
 * 作者の問いから見つけた）。`parseEpisodeMetadata` は区切り行が2本以上ある
 * ファイルを**わざと**素通しする（半端に切ると文字数が混ざるため）ので、
 * `extractEpisodeParts` が生の全文を「本文」として返していた。
 */
const COLLECTED_LINES = [
  "【タイトル】",
  "湖畔の物語",
  "",
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１話　転生",
  "",
  "【本文】",
  "",
  "　気がつくと森の中だった。",
  "",
  "【後書き】",
  "　読んでくださりありがとうございます。",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２話　湖畔の誓い",
  "",
  "【本文】",
  "",
  "　湖のほとりで誓いを立てた。",
  "",
  "【リアクション】",
  "いいね: 24件",
  "",
  "------------------------- エピソード3開始 -------------------------",
  "【エピソードタイトル】",
  "３話　別れ",
  "",
  "【本文】",
  "",
  "　朝の駅で手を振った。",
  "",
];
/** **改行は CRLF で試す。** 投稿サイトのダウンロードはこの形で降ってくる */
const COLLECTED = COLLECTED_LINES.join("\r\n");

/** その一行が何行目か（1始まり）。行番号を数え間違えないように引く */
function lineOf(text: string): number {
  const at = COLLECTED_LINES.indexOf(text);
  if (at < 0) throw new Error(`見本に「${text}」がありません`);
  return at + 1;
}

describe("合本は1話ぶんだけコピーする", () => {
  /** 入口がやるのと同じ手順（1話を決める → 変換にかける元にする） */
  function copySource(caretLine: number): string {
    return sourceForPostingCopy(
      COLLECTED,
      undefined,
      collectedEpisodeAt(COLLECTED, caretLine)?.body
    );
  }

  test("カーソルのある話だけを渡す（区切り行と頭書きを含めない）", () => {
    const source = copySource(lineOf("　湖のほとりで誓いを立てた。"));

    expect(source).toBe("　湖のほとりで誓いを立てた。");
    expect(source).not.toContain("エピソード2開始");
    expect(source).not.toContain("【エピソードタイトル】");
    expect(source).not.toContain("【後書き】");
    expect(source).not.toContain("【リアクション】");
  });

  test("カーソルが1話目の頭書きに居ても、1話目が返る", () => {
    // 区切り行と【本文】のあいだ。**そこは1話目の中である**
    expect(copySource(lineOf("１話　転生"))).toBe("　気がつくと森の中だった。");
    // 読めなかったとき（0）も1話目の頭に居るものとして扱う
    expect(copySource(0)).toBe("　気がつくと森の中だった。");
  });

  test("サブタイトルは合本の中の題から取る", () => {
    const found = collectedEpisodeAt(
      COLLECTED,
      lineOf("　湖のほとりで誓いを立てた。")
    );

    expect(found?.chapter).toBe(2);
    expect(found?.title).toBe("湖畔の誓い");
  });

  test("合本でなければ undefined（これまでどおりの道へ落ちる）", () => {
    expect(collectedEpisodeAt(WITH_HEADER, 1)).toBeUndefined();
    expect(collectedEpisodeAt("ただの本文。", 1)).toBeUndefined();
    // **1話ぶんに区切り行が付いているだけのファイルは合本ではない**
    // （`MIN_COLLECTED_EPISODES`。全ファイルに印が付いた失敗がある）
    expect(
      collectedEpisodeAt(
        [
          "------------------------- エピソード1開始 -------------------------",
          "【本文】",
          "　一話きり。",
        ].join("\n"),
        1
      )
    ).toBeUndefined();
  });

  test("合本でないファイルの渡し方は、いままでと同じ", () => {
    // **ここが変わったら退行である。** 3つ目の引数を渡さなければ以前のまま
    expect(sourceForPostingCopy(WITH_HEADER, undefined, undefined)).toBe(
      "気がつくと{森|もり}の中だった。"
    );
    expect(sourceForPostingCopy("ただの本文。", undefined, undefined)).toBe(
      "ただの本文。"
    );
  });

  test("選んであれば、合本でも選んだ範囲がそのまま返る", () => {
    // 範囲を選んだのは作者の意思。**話の切れ目より選択が優先**
    expect(
      sourceForPostingCopy(
        COLLECTED,
        "選んだところ",
        collectedEpisodeAt(COLLECTED, lineOf("　朝の駅で手を振った。"))?.body
      )
    ).toBe("選んだところ");
  });
});
