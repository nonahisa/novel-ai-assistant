import { describe, expect, test } from "vitest";
import {
  buildStoryDateSources,
  describeStoryDates,
  readStoryDates,
} from "../../../src/core/storyCalendar";

/*
  **作中の日付は、コードで読んでコードで数える**（設計書6.10.9）。

  答え付きの台の仕込み——「十月三日に折ったのに、十二月八日の話で
  『ちょうど二週間が過ぎた』」——は、26bでも27bでも3回とも見逃した。
  日付の引き算はAIにさせず、材料として渡す。
*/
describe("作中の日付を読む（設計書6.10.9）", () => {
  test("漢数字で書かれた日付を読む", () => {
    const dates = readStoryDates([
      { chapter: 2, text: "　十月三日は、朝から雨だった。" },
      { chapter: 5, text: "　十二月八日、この冬の初雪が降った。" },
    ]);

    expect(dates.map((date) => [date.chapter, date.text, date.month, date.day])).toEqual([
      [2, "十月三日", 10, 3],
      [5, "十二月八日", 12, 8],
    ]);
  });

  test("十一月二十三日のような二桁の漢数字も読む", () => {
    const dates = readStoryDates([
      { chapter: 1, text: "十一月二十三日の朝。" },
      { chapter: 2, text: "十二月三十一日、年の終わり。" },
    ]);

    expect(dates.map((date) => [date.month, date.day])).toEqual([
      [11, 23],
      [12, 31],
    ]);
  });

  test("算用数字（半角・全角）でも読む", () => {
    const dates = readStoryDates([
      { chapter: 1, text: "10月3日の話。" },
      { chapter: 2, text: "１０月５日の話。" },
    ]);

    expect(dates.map((date) => [date.text, date.month, date.day])).toEqual([
      ["10月3日", 10, 3],
      ["１０月５日", 10, 5],
    ]);
  });

  test("月日がそろっていない書き方は、黙って落とす", () => {
    // **推測で埋めない。** 曖昧・相対・架空の暦は読まない
    const dates = readStoryDates([
      { chapter: 1, text: "　九月の終わりの坂を上った。" },
      { chapter: 2, text: "　十月の半ば、松葉杖で窓口に座る。" },
      { chapter: 3, text: "　十一月の最初の月曜、ギプスが外れた。" },
      { chapter: 4, text: "　あれから三日後のことだった。" },
      { chapter: 5, text: "　王暦312年春、王都は静かだった。" },
    ]);

    expect(dates).toEqual([]);
  });

  test("期間の長さとして書かれた数は、日付として採らない", () => {
    // 「一月十日ほど」は1か月と10日ほどの意味で、日付ではない
    const dates = readStoryDates([
      { chapter: 1, text: "旅は一月十日ほどかかった。" },
      { chapter: 2, text: "二月三日間の休みをもらった。" },
    ]);

    expect(dates).toEqual([]);
  });

  test("暦に無い月日は読み違えとみなして落とす", () => {
    const dates = readStoryDates([
      { chapter: 1, text: "十三月四日という日は無い。" },
      { chapter: 2, text: "二月三十五日も無い。" },
    ]);

    expect(dates).toEqual([]);
  });

  test("同じ話に複数あれば、いちばん先に出たものを採る", () => {
    // 場面転換で複数出るが、どれがその話の「今」かは機械には決められない
    const dates = readStoryDates([
      { chapter: 3, text: "十月三日の坂。……やがて十一月五日になった。" },
    ]);

    expect(dates.map((date) => date.text)).toEqual(["十月三日"]);
  });

  test("同じ話のあらすじと本文は、繋いでから読む", () => {
    // 片方に日付が無いだけで落とさない
    const dates = readStoryDates([
      { chapter: 4, text: "十一月の最初の月曜、ギプスが外れる。" },
      { chapter: 4, text: "　十一月五日。空は高かった。" },
    ]);

    expect(dates.map((date) => [date.chapter, date.text])).toEqual([
      [4, "十一月五日"],
    ]);
  });

  test("通算の日数を数える（十月三日から十二月八日は66日）", () => {
    const dates = readStoryDates([
      { chapter: 2, text: "十月三日。" },
      { chapter: 4, text: "十一月五日。" },
      { chapter: 5, text: "十二月八日。" },
    ]);

    // いちばん前の話が起点（0日）
    expect(dates.map((date) => date.dayNumber)).toEqual([0, 33, 66]);
  });

  test("月日が前の話より前へ戻ったら、翌年として数える", () => {
    const dates = readStoryDates([
      { chapter: 1, text: "十二月二十八日。" },
      { chapter: 2, text: "一月四日。" },
    ]);

    // 12月28日→1月4日は7日。年をまたいだとみなさないと負の数になる
    expect(dates.map((date) => date.dayNumber)).toEqual([0, 7]);
  });

  test("話数の順に並べ直してから数える", () => {
    const dates = readStoryDates([
      { chapter: 5, text: "十二月八日。" },
      { chapter: 2, text: "十月三日。" },
    ]);

    expect(dates.map((date) => [date.chapter, date.dayNumber])).toEqual([
      [2, 0],
      [5, 66],
    ]);
  });
});

/*
  **あらすじは、書き出しだけを見る**（設計書6.10.9）。

  あらすじは「その話で何が起きたか」を時の順に書くので、**その話の「いつ」は
  書き出しに来る**。過去への言及は後ろに回る——台の第4話のあらすじ
  「十一月の最初の月曜、**十月三日に折った**左の足首のギプスが外れる。」が
  まさにその形で、先頭の読めない表記を飛ばして**過去の日付を今日として
  拾って**しまっていた（「第4話: 十月三日（第2話から0日）」と並び、
  第4話の「一か月が経っている」と食い違って誤検出を招く）。

  **一文（句点まで）では足りない。** この第4話は、最初の一文の中に過去の
  日付が入っているので、句点で切っても残る。だから最初の読点でも切る。
*/
describe("あらすじの中の、過去の日付を今日にしない（設計書6.10.9）", () => {
  test("読めない表記のあとに過去の日付が来る話は、読み取らない", () => {
    const dates = readStoryDates(
      buildStoryDateSources(
        [
          {
            chapter: 4,
            synopsis:
              "十一月の最初の月曜、十月三日に折った左の足首のギプスが外れる。折ってから一か月が経っている。",
          },
        ],
        // 第4話の本文には月日の表記が無い（台と同じ形）
        [{ chapter: 4, text: "　右足のギプスが外れたのは、十一月の最初の月曜だった。" }]
      )
    );

    expect(dates).toEqual([]);
  });

  test("書き出しに日付があれば読み取る", () => {
    // 台の第2話「十月三日、雨。……」は、読点の前に日付がある
    const dates = readStoryDates(
      buildStoryDateSources(
        [{ chapter: 2, synopsis: "十月三日、雨。春人は坂で自転車ごと転ぶ。" }],
        []
      )
    );

    expect(dates.map((date) => [date.chapter, date.text])).toEqual([
      [2, "十月三日"],
    ]);
  });

  test("本文は書き出しに絞らない（場面がそのまま流れるため）", () => {
    const dates = readStoryDates(
      buildStoryDateSources(
        [],
        [{ chapter: 5, text: "　雪が降っていた。十二月八日、この冬の初雪だった。" }]
      )
    );

    expect(dates.map((date) => date.text)).toEqual(["十二月八日"]);
  });
});

describe("あらすじと本文を繋ぐ（`buildStoryDateSources`）", () => {
  test("話数ごとに、あらすじと本文の両方を渡す", () => {
    const sources = buildStoryDateSources(
      [
        { chapter: 2, synopsis: "十月三日、雨。" },
        { chapter: null, synopsis: "話数の読めないあらすじ" },
      ],
      [
        { chapter: 2, text: "本文2" },
        { chapter: null, text: "話数の読めない本文" },
      ]
    );

    // 話数の分からないものは落とす（並べる場所が決められない）。
    // **あらすじは書き出しだけ**（本文はそのまま）
    expect(sources).toEqual([
      { chapter: 2, text: "十月三日、" },
      { chapter: 2, text: "本文2" },
    ]);
  });
});

describe("欄の文面（`describeStoryDates`）", () => {
  const dates = readStoryDates([
    { chapter: 2, text: "十月三日。" },
    { chapter: 4, text: "十一月五日。" },
    { chapter: 5, text: "十二月八日。" },
  ]);

  test("読み取れたものが2件未満なら、欄ごと出さない", () => {
    // 1件では日数差が出ず、欄を出す意味がない
    expect(describeStoryDates([], 5)).toBe("");
    expect(describeStoryDates(dates.slice(0, 1), 5)).toBe("");
    // その話までに1件しか無いときも同じ
    expect(describeStoryDates(dates, 2)).toBe("");
  });

  test("その話までの日付を、日数の差を添えて並べる", () => {
    const section = describeStoryDates(dates, 5);

    expect(section).toContain("第2話: 十月三日\n");
    expect(section).toContain("第4話: 十一月五日（第2話から33日）");
    expect(section).toContain("この話（第5話）: 十二月八日（第2話から66日）");
    // 起点の話には差を書かない（相手が自分自身になる）
    expect(section).not.toContain("第2話: 十月三日（");
  });

  test("その話より後の日付は並べない（設計書6.10.3）", () => {
    const section = describeStoryDates(dates, 4);

    expect(section).toContain("この話（第4話）: 十一月五日（第2話から33日）");
    expect(section).not.toContain("十二月八日");
  });

  test("話数が分からないときは、全部を「第N話」で並べる", () => {
    const section = describeStoryDates(dates, null);

    expect(section).not.toContain("この話");
    expect(section).toContain("第5話: 十二月八日（第2話から66日）");
  });

  test("数えが狂いうることと、経過の記述と突き合わせることを断る", () => {
    const section = describeStoryDates(dates, 5);

    expect(section).toContain("【作中の日付】");
    expect(section).toContain("話の順に進むものとして数えています");
    expect(section).toContain("読み取れなかった話");
    expect(section).toContain("◯週間ぶり");
    // 断定させない（読み取った日付そのものが誤っていることもある）
    expect(section).toContain("断定せず");
  });
});
