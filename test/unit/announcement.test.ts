import { describe, expect, test } from "vitest";
import {
  announceEpisodeLabel,
  buildAnnouncementMarkdown,
  composeXPost,
  remainingCopyChoices,
  validateAnnouncement,
  X_URL_WEIGHT,
  X_WEIGHTED_LIMIT,
  xPostWithUrl,
  xWeightedLength,
} from "../../src/core/announcement";
import {
  X_POST_MAX_CHARS,
  type AnnounceResult,
} from "../../src/prompts/announce";

/** 注意ゼロの状態を作る土台。各テストは壊したい欄だけを上書きする */
function result(over: Partial<AnnounceResult> = {}): AnnounceResult {
  return {
    xPost: "灯を継ぐ者は、誰も名を持たない。",
    activityReport: "更新しました。今回は塔の内側の話です。",
    afterword: "読んでくださってありがとうございます。",
    spoilerCheck: "終盤で明かされる名前は伏せました。",
    confidence: "medium",
    ...over,
  };
}

describe("Xの数え方", () => {
  test("日本語は1文字あたり2", () => {
    expect(xWeightedLength("あ")).toBe(2);
    expect(xWeightedLength("あいう")).toBe(6);
  });

  test("半角英数字は1文字あたり1", () => {
    expect(xWeightedLength("a")).toBe(1);
    expect(xWeightedLength("abc123")).toBe(6);
  });

  test("URLは長さに関わらず23で数える", () => {
    // Xが短縮するため。実際の文字数で数えると、長いURLを貼っただけで
    // 「超えている」と注意が出る
    expect(xWeightedLength("https://example.com")).toBe(X_URL_WEIGHT);
    expect(
      xWeightedLength(
        "https://kakuyomu.jp/works/1234567890123456789/episodes/9876543210987654321"
      )
    ).toBe(X_URL_WEIGHT);
  });

  test("URLの目印も23で数える", () => {
    // **目印のままだと5文字で数えられる。** URLを設定していない作品だけ
    // 判定が18甘くなり、作者がURLへ貼り替えた瞬間に280を超える
    expect(xWeightedLength("{URL}")).toBe(X_URL_WEIGHT);
  });

  test("絵文字は2（半端に割って2回数えない）", () => {
    // コードポイントで回さないと、サロゲートペアが1文字で2回数えられる
    expect(xWeightedLength("\u{1F600}")).toBe(2);
  });

  test("混ざっていても足し合わせる", () => {
    // 「あ」2 ＋ 半角空白1 ＋ URL23 ＝ 26
    expect(xWeightedLength("あ https://example.com")).toBe(26);
  });

  test("何度呼んでも同じ値を返す", () => {
    // モジュールの外に `g` 付きの正規表現を置くと、`lastIndex` が残って
    // 2回目から結果が変わる
    const text = "第1話 https://example.com";
    expect(xWeightedLength(text)).toBe(xWeightedLength(text));
  });

  test("140字の日本語がちょうど上限になる", () => {
    expect(xWeightedLength("あ".repeat(140))).toBe(X_WEIGHTED_LIMIT);
  });
});

describe("X用の投稿の組み立て", () => {
  test("見出し・本文・ハッシュタグ・URLを並べる", () => {
    expect(
      composeXPost({
        body: "本文です。",
        episodeLabel: "第3話「灯を継ぐ」",
        hashtags: ["#創作", "#カクヨム"],
        workUrl: "https://example.com/works/1",
      })
    ).toBe(
      "第3話「灯を継ぐ」 更新しました\n本文です。\n#創作 #カクヨム\nhttps://example.com/works/1"
    );
  });

  test("ハッシュタグが無ければ、その行ごと省く", () => {
    // 空行が残ると、貼ったときに間の抜けた投稿になる
    expect(
      composeXPost({
        body: "本文です。",
        episodeLabel: "第3話",
        hashtags: [],
        workUrl: "https://example.com/works/1",
      })
    ).toBe("第3話 更新しました\n本文です。\nhttps://example.com/works/1");
  });

  test("URLが空なら目印を残す", () => {
    // 作者が貼るときに差し替えられるようにする。黙って消すと、
    // URLを付け忘れたまま投稿されてしまう
    expect(
      composeXPost({
        body: "本文です。",
        episodeLabel: "第3話",
        hashtags: [],
        workUrl: "",
      })
    ).toContain("{URL}");
  });
});

describe("貼り付ける直前のURLの差し込み", () => {
  const composed = composeXPost({
    body: "本文です。",
    episodeLabel: "第3話",
    hashtags: ["#創作"],
    workUrl: "",
  });

  test("目印（{URL}）を、決まったURLへ差し替える", () => {
    // 貼り付け先（6.79.8）で決めたURLは、目印の場所へ入れる。
    // 末尾へ足すだけにすると、目印が残ったまま投稿されてしまう
    expect(xPostWithUrl(composed, "https://ncode.syosetu.com/n1234ab/")).toBe(
      "第3話 更新しました\n本文です。\n#創作\nhttps://ncode.syosetu.com/n1234ab/"
    );
  });

  test("URLが決まらなければ、目印の行ごと落とす", () => {
    // 「{URL}」がそのまま読者の目に触れないようにする（URL無しで文だけ貼る）
    expect(xPostWithUrl(composed, "")).toBe("第3話 更新しました\n本文です。\n#創作");
  });

  test("既にURLが入っている告知には、足さない", () => {
    // 告知の設定でURLを入れてある作品。2つ並ぶと、どちらが本物か分からない
    const withUrl = composeXPost({
      body: "本文です。",
      episodeLabel: "第3話",
      hashtags: [],
      workUrl: "https://example.com/works/1",
    });
    expect(xPostWithUrl(withUrl, "https://ncode.syosetu.com/n1234ab/")).toBe(
      withUrl
    );
  });
});

describe("告知文の検査", () => {
  test("問題が無ければ注意は出ない", () => {
    const composed = composeXPost({
      body: result().xPost,
      episodeLabel: "第3話",
      hashtags: ["#創作"],
      workUrl: "https://example.com/1",
    });

    expect(validateAnnouncement(result(), composed)).toEqual([]);
  });

  test("合成すると上限を超えるX用に注意する", () => {
    // **本文だけでは収まっていても、ハッシュタグとURLを足すと超える。**
    // 数えるのは合成したあとでなければ意味がない
    const body = "あ".repeat(130);
    const composed = composeXPost({
      body,
      episodeLabel: "第3話「灯を継ぐ」",
      hashtags: ["#創作", "#カクヨム"],
      workUrl: "https://example.com/1",
    });

    const warnings = validateAnnouncement(result({ xPost: body }), composed);
    expect(warnings.some((w) => w.includes("X用"))).toBe(true);
  });

  test("活動報告用が400字を超えたら注意する", () => {
    const warnings = validateAnnouncement(
      result({ activityReport: "あ".repeat(401) }),
      "第3話 更新しました\n本文\n{URL}"
    );

    expect(warnings.some((w) => w.includes("活動報告用"))).toBe(true);
  });

  test("後書き用が80字を超えたら注意する", () => {
    const warnings = validateAnnouncement(
      result({ afterword: "あ".repeat(81) }),
      "第3話 更新しました\n本文\n{URL}"
    );

    expect(warnings.some((w) => w.includes("後書き用"))).toBe(true);
  });

  test("URLを書いてきたら注意する", () => {
    // URLはこちらで付けるので、書かれていると二重になる
    const warnings = validateAnnouncement(
      result({ xPost: "続きはこちら https://example.com/1" }),
      "第3話 更新しました\n本文\n{URL}"
    );

    expect(warnings.some((w) => w.includes("URL"))).toBe(true);
  });

  test("X用がハッシュタグを書いてきたら注意する", () => {
    const warnings = validateAnnouncement(
      result({ xPost: "更新しました。#創作" }),
      "第3話 更新しました\n本文\n{URL}"
    );

    expect(warnings.some((w) => w.includes("ハッシュタグ"))).toBe(true);
  });

  test("活動報告用と後書き用の「#」には注意しない", () => {
    // **こちらでタグを付けるのはX用だけ。** 他の2つに「こちらで付けます」と
    // 出るのは嘘であるうえ、「## 見どころ」のような見出しにも当たる
    expect(
      validateAnnouncement(
        result({
          activityReport: "## 見どころ\n更新しました。",
          afterword: "# ここまで読んでくださって感謝します。",
        }),
        "第3話 更新しました\n本文\n{URL}"
      )
    ).toEqual([]);
  });

  test("X用の本文が100字を超えたら注意する", () => {
    // **Xの重みでは収まっても、字数では超えていることがある。**
    // 半角英数字は重み1なので、101字でも重みは101にしかならない
    const body = "a".repeat(X_POST_MAX_CHARS + 1);
    const composed = composeXPost({
      body,
      episodeLabel: "第3話",
      hashtags: [],
      workUrl: "",
    });

    const warnings = validateAnnouncement(result({ xPost: body }), composed);
    expect(
      warnings.some((w) => w.includes(`${X_POST_MAX_CHARS}字`))
    ).toBe(true);
  });

  test("こちらの指示語がそのまま返ってきたら注意する", () => {
    // **指示の言葉が、答えの中身として返ってくる**（この作品で繰り返した失敗）。
    // 「（まだありません）」が混ざったまま貼られると読者の目に触れる
    for (const mark of [
      "（まだありません）",
      "（まだ書かれていません）",
      "（本文はここまで。以降は省略）",
    ]) {
      const warnings = validateAnnouncement(
        result({ afterword: `今回の話は${mark}という感じです。` }),
        "第3話 更新しました\n本文\n{URL}"
      );
      expect(
        warnings.some((w) => w.includes(mark)),
        mark
      ).toBe(true);
    }
  });

  test("伏せたものが空でも注意しない", () => {
    // 伏せる要素が無い話もある。書かれていないこと自体は問題ではない
    expect(
      validateAnnouncement(
        result({ spoilerCheck: null }),
        "第3話 更新しました\n本文\n{URL}"
      )
    ).toEqual([]);
  });

  test("長すぎても切り詰めない（判断は作者がする）", () => {
    const long = "あ".repeat(401);
    const parsed = result({ activityReport: long });

    validateAnnouncement(parsed, "第3話 更新しました\n本文\n{URL}");

    expect(parsed.activityReport).toBe(long);
  });
});

describe("話の見出し", () => {
  const file = {
    kind: "本編" as const,
    fileName: "001.txt",
    date: null,
    dateSeq: null,
  };

  test("話数とサブタイトルがあれば「第N話「題」」", () => {
    expect(
      announceEpisodeLabel({ chapter: 3, title: "灯を継ぐ", file })
    ).toBe("第3話「灯を継ぐ」");
  });

  test("題に話数が含まれていても二重にしない", () => {
    // 投稿サイトからDLした本文の題は「第1話 気がついたら幽霊に」の形で入る
    expect(
      announceEpisodeLabel({
        chapter: 1,
        title: "第1話 気がついたら幽霊に",
        file,
      })
    ).toBe("第1話「気がついたら幽霊に」");
  });

  test("話数もサブタイトルも読めなければ、拡張子を落としたファイル名にする", () => {
    // 「設定メモ.txt 更新しました」と投稿されると、拡張子が読者の目に触れる
    expect(
      announceEpisodeLabel({
        chapter: null,
        title: null,
        file: { ...file, fileName: "設定メモ.txt" },
      })
    ).toBe("設定メモ");
  });
});

describe("コピーのボタン", () => {
  test("1つ押したら、残り2つだけを出す", () => {
    // 押したものをまた並べると、押したのに効いていないように見える
    // （通知は押した記録を持たない）
    expect(remainingCopyChoices(new Set(["x"]))).toEqual([
      { kind: "activityReport", label: "活動報告用をコピー" },
      { kind: "afterword", label: "後書き用をコピー" },
    ]);
  });

  test("3つとも押したら空になる（そこで終わる）", () => {
    expect(
      remainingCopyChoices(new Set(["x", "activityReport", "afterword"]))
    ).toEqual([]);
  });
});

describe("告知文の書き出し", () => {
  const markdown = buildAnnouncementMarkdown({
    workTitle: "図書塔の魔女",
    episodeLabel: "第3話「灯を継ぐ」",
    composedX: "第3話「灯を継ぐ」 更新しました\n本文です。\n#創作\n{URL}",
    weightedLength: 60,
    activityReport: "活動報告の本文。",
    afterword: "後書きの一言。",
    spoilerCheck: "終盤の名前を伏せました。",
    warnings: [],
  });

  test("見出しと、Xの数え方の残りが分かる", () => {
    expect(markdown).toContain("# 更新告知文");
    expect(markdown).toContain(`## X（旧Twitter）用（60/${X_WEIGHTED_LIMIT}）`);
    expect(markdown).toContain("## 活動報告・近況ノート用");
    expect(markdown).toContain("## 後書き用");
    expect(markdown).toContain("## 伏せたもの");
  });

  test("X用はコード柵に入れる", () => {
    // ハッシュタグの行は「#創作」で始まる。素で置くとMarkdownの見出しになり、
    // 表示とコピーした形が食い違う
    expect(markdown).toContain("```\n第3話「灯を継ぐ」 更新しました");
  });

  test("注意は冒頭に出す", () => {
    // 末尾に置くと、上から読んでコピーした作者は気づかないまま貼ってしまう
    const withWarnings = buildAnnouncementMarkdown({
      workTitle: "図書塔の魔女",
      episodeLabel: "第3話",
      composedX: "第3話 更新しました\n本文\n{URL}",
      weightedLength: 40,
      activityReport: "活動報告。",
      afterword: "後書き。",
      spoilerCheck: null,
      warnings: ["X用が長すぎます。"],
    });

    expect(withWarnings).toContain("- ⚠ X用が長すぎます。");
    expect(withWarnings.indexOf("⚠")).toBeLessThan(
      withWarnings.indexOf("## X（旧Twitter）用")
    );
  });
});
