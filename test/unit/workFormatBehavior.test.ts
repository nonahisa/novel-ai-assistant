import { describe, expect, test } from "vitest";
import { episodeUnit, formatChapterLabel } from "../../src/core/episodeLabel";
import { matchWorkFormat } from "../../src/core/workFormatStore";
import { formatWarningFor } from "../../src/core/formatFit";
import type { EpisodeFile } from "../../src/models/types";

/**
 * 形式を実際の振る舞いへ効かせる（設計書6.4.5）。
 *
 * **形式が書かれていない作品では、今までどおりに振る舞う。**
 * 「決めていない」を「長編と決めた」と読み替えないこと。
 */
function episode(
  overrides: Partial<Pick<EpisodeFile, "kind" | "chapterStart" | "chapterEnd">>
): Pick<EpisodeFile, "kind" | "chapterStart" | "chapterEnd"> {
  return { kind: "本編", chapterStart: 3, chapterEnd: null, ...overrides };
}

describe("形式の読み取り", () => {
  test("選択肢から選んだ値を読める", () => {
    expect(matchWorkFormat("短編")).toBe("short");
    expect(matchWorkFormat("SNS記事")).toBe("sns");
  });

  test("但し書きが添えてあっても読める", () => {
    // 自由に書ける文書なので、完全一致しか拾えないのでは意味がない
    expect(matchWorkFormat("長編（連載中）")).toBe("long");
    expect(matchWorkFormat("いまのところ短編集のつもり")).toBe(
      "shortCollection"
    );
  });

  test("長いほうから当てる", () => {
    // 「長編」で先に当てると「大長編」が拾えない。
    // 「短編」と「短編集」も同じ
    expect(matchWorkFormat("大長編")).toBe("epic");
    expect(matchWorkFormat("短編集")).toBe("shortCollection");
  });

  test("書かれていなければ決めない", () => {
    expect(matchWorkFormat("")).toBeUndefined();
    expect(matchWorkFormat("   ")).toBeUndefined();
    expect(matchWorkFormat("まだ決めていません")).toBeUndefined();
  });
});

describe("数えるものの呼び方", () => {
  test("SNS記事は「話」ではなく「投稿」", () => {
    // 同じアカウントの投稿を並べたもので、続きものではない。
    // 「第3話」と出すと連なった物語に見える
    expect(formatChapterLabel(episode({}), "sns")).toBe("投稿3");
    expect(episodeUnit("sns").noun).toBe("投稿");
  });

  test("SNS記事でも範囲は範囲として出す", () => {
    expect(
      formatChapterLabel(episode({ chapterStart: 3, chapterEnd: 5 }), "sns")
    ).toBe("投稿3〜5");
  });

  test("他の形式はこれまでどおり「第3話」", () => {
    for (const format of ["short", "shortCollection", "long", "epic"] as const) {
      expect(formatChapterLabel(episode({}), format), format).toBe("第3話");
    }
  });

  test("形式が決まっていなければ、これまでどおり", () => {
    expect(formatChapterLabel(episode({}))).toBe("第3話");
    expect(episodeUnit(undefined).noun).toBe("話");
  });

  test("プロローグなどは形式によらず種別を出す", () => {
    const prologue = episode({ kind: "プロローグ", chapterStart: null });

    expect(formatChapterLabel(prologue, "sns")).toBe("プロローグ");
  });

  test("話数が読み取れなければ何も返さない", () => {
    // 想像で番号を振らない
    expect(formatChapterLabel(episode({ chapterStart: null }), "sns")).toBe("");
  });
});

describe("形式に合わない機能への断り", () => {
  test("短編では、各話あらすじと感情曲線を止める前に断る", () => {
    expect(formatWarningFor("episodeSynopses", "short")?.detail).toContain(
      "1話で完結"
    );
    expect(formatWarningFor("emotionCurve", "short")).toBeDefined();
  });

  test("短編集・SNS記事では、プロット逆算の前提が合わないと言う", () => {
    // あらすじを時系列に並べて筋を組み立てる作りなので、
    // 話が続かない作品では実際には無い話が出てくる
    expect(formatWarningFor("plotReverse", "shortCollection")?.detail).toContain(
      "1本の筋になりません"
    );
    expect(formatWarningFor("plotReverse", "sns")?.detail).toContain(
      "連続した物語ではない"
    );
  });

  test("短編集では、各話あらすじは止めない", () => {
    // 短編ごとのあらすじは意味がある。話が続かないだけである
    expect(formatWarningFor("episodeSynopses", "shortCollection")).toBeUndefined();
  });

  test("長編・大長編では何も言わない", () => {
    for (const feature of [
      "episodeSynopses",
      "emotionCurve",
      "plotReverse",
    ] as const) {
      expect(formatWarningFor(feature, "long"), feature).toBeUndefined();
      expect(formatWarningFor(feature, "epic"), feature).toBeUndefined();
    }
  });

  test("形式が書かれていなければ何も言わない", () => {
    // プロットを書いていない作者に毎回ダイアログを出すことになる
    for (const feature of [
      "episodeSynopses",
      "emotionCurve",
      "plotReverse",
    ] as const) {
      expect(formatWarningFor(feature, undefined), feature).toBeUndefined();
    }
  });
});
