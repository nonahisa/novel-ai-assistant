import { describe, expect, test } from "vitest";
import {
  describeChapterHint,
  inferChapterHint,
  toChapterHintNote,
} from "../../../src/core/episodeChapterHint";
import { parseEpisodeFileName } from "../../../src/core/episodeParser";

/**
 * 話数の補い（作者の裁定、2026-10-25「話数を判定する要素がある場合は補い、
 * それ以外の場合は不明として扱うのが良い」。設計書6.2）。
 *
 * **見逃しと誤検出の両方を測る**（CLAUDE.md の失敗2）。補うべき例だけを
 * 並べると、何でも補う実装が満点になる。補ってはいけない例を同じ数だけ置く。
 */

const chapterOf = (input: Parameters<typeof inferChapterHint>[0]) => {
  const result = inferChapterHint(input);
  return result?.status === "inferred" ? result.chapter : null;
};

describe("補う（見逃さない）", () => {
  test.each([
    ["再会（第三話）.txt", 3],
    ["【第3話】再会.txt", 3],
    ["第3話「再会」.txt", 3],
    ["第十二話　旅立ち.md", 12],
    ["第二十一話.txt", 21],
    ["いじめられっ子_第7話.txt", 7],
    ["再会_3話.txt", 3],
    ["#3_再会.txt", 3],
    ["再会＃12.txt", 12],
    ["再会_ep3.txt", 3],
    ["再会 episode 4.txt", 4],
    // 作者の作品（コールドスリープ）の名付け。カタカナ＋半角・全角・空白つき
    ["エピソード32.txt", 32],
    ["エピソード３３.txt", 33],
    ["エピソード 34_目覚め.txt", 34],
  ])("ファイル名 %s → 第%i話", (fileName, chapter) => {
    expect(parseEpisodeFileName(fileName).kind, "規則では読めない名前であること").toBe("不明");
    expect(chapterOf({ fileName })).toBe(chapter);
  });

  test("本文の最初の見出し（第三話　旅立ち）から補う", () => {
    expect(chapterOf({ fileName: "旅立ち.txt", body: "\n第三話　旅立ち\n\n　朝が来た。" })).toBe(3);
  });

  test("Markdown の見出し（## 第3話）から補う", () => {
    expect(chapterOf({ fileName: "続き.md", body: "## 第3話 再会\n\n本文" })).toBe(3);
  });

  test("全角数字の見出し（１話　転生）から補う", () => {
    expect(chapterOf({ fileName: "転生.txt", body: "１話　転生\n本文" })).toBe(1);
  });

  test("頭書きの題（【エピソードタイトル】１話　転生）から補う", () => {
    expect(chapterOf({ fileName: "転生.txt", metaTitle: "１話　転生", body: "　目が覚めた。" })).toBe(1);
  });

  test("ファイル名と見出しが同じ話数なら補う（一致は食い違いではない）", () => {
    const result = inferChapterHint({ fileName: "再会（第三話）.txt", body: "第3話　再会\n本文" });
    expect(result?.status).toBe("inferred");
    expect(result?.status === "inferred" && result.chapter).toBe(3);
    // どこから読んだかを作者に見せる
    expect(result?.evidence).toContain("ファイル名");
    expect(result?.evidence).toContain("本文の最初の見出し");
  });

  test("ファイル名から話数の印を落とした残りを題として返す", () => {
    const result = inferChapterHint({ fileName: "【第3話】再会.txt" });
    expect(result?.status === "inferred" && result.subtitle).toBe("再会");
    const tail = inferChapterHint({ fileName: "再会（第三話）.txt" });
    expect(tail?.status === "inferred" && tail.subtitle).toBe("再会");
  });
});

describe("補わない（誤って補わない）", () => {
  test.each([
    // 話数の印が無い
    ["続き.txt"],
    ["あとがき.txt"],
    ["メモ 2026年8月12日.txt"],
    ["第2巻のまとめ.txt"],
    ["2026年版_設定.txt"],
    // 「第」の無い漢数字は言い回しと見分けられない
    ["一話完結.txt"],
    // 「話」の直後が区切りでない（話数の名乗りではない）
    ["第3話の構想.txt"],
    ["3話目の下書き.txt"],
    ["1話完結の短編.txt"],
    // 範囲はどの話か決めきれない
    ["再会_第3〜4話.txt"],
    // 英単語の一部の ep
    ["手順_step3.txt"],
    // カタカナの「エピソード」も ep と同じ線引き（後ろが区切りでない・範囲・数字なし）
    ["エピソード3の構想.txt"],
    ["エピソード3〜4.txt"],
    ["エピソード集.txt"],
    // 投稿サイトの作品番号・作品情報は話数ではない（母艦の実データの確認）
    ["N5078JI.txt"],
    ["about.txt"],
  ])("ファイル名 %s は補わない", (fileName) => {
    expect(parseEpisodeFileName(fileName).kind).toBe("不明");
    expect(chapterOf({ fileName })).toBeNull();
  });

  test("ファイル名と本文の見出しが食い違えば補わない（食い違いとして返す）", () => {
    const result = inferChapterHint({ fileName: "再会（第三話）.txt", body: "第四話　再会\n本文" });
    expect(result?.status).toBe("conflict");
    expect(result?.evidence).toContain("第三話");
    expect(result?.evidence).toContain("第四話");
  });

  test("ファイル名の中に2つの話数があれば補わない", () => {
    expect(inferChapterHint({ fileName: "再会_第3話_第5話.txt" })?.status).toBe("conflict");
    expect(inferChapterHint({ fileName: "#3_第5話.txt" })?.status).toBe("conflict");
  });

  test("頭書きの題と本文の見出しが食い違えば補わない", () => {
    expect(
      inferChapterHint({ fileName: "転生.txt", metaTitle: "１話　転生", body: "第二話　旅\n本文" })?.status
    ).toBe("conflict");
  });

  test("本文の1行目が地の文なら読まない（第三話で、など）", () => {
    expect(chapterOf({ fileName: "続き.txt", body: "第三話で死んだはずの男が、扉の前に立っていた。" })).toBeNull();
    expect(chapterOf({ fileName: "続き.txt", body: "　彼は第3話のことを思い出した。" })).toBeNull();
  });

  test("本文の1行目が長ければ見出しとみなさない", () => {
    const longLine = `第3話　${"あ".repeat(50)}`;
    expect(chapterOf({ fileName: "続き.txt", body: longLine })).toBeNull();
  });

  test("2行目以降の見出しは見ない", () => {
    expect(chapterOf({ fileName: "続き.txt", body: "　朝が来た。\n第3話\n" })).toBeNull();
  });

  test("創作メモ集では補わない（メモは話ではない）", () => {
    // 同じ名前でも、形式が分からない作品・小説では補う（線引きが形式だけであること）
    expect(chapterOf({ fileName: "第三話 構想メモ.md" })).toBe(3);
    expect(chapterOf({ fileName: "第三話 構想メモ.md", format: "memo" })).toBeNull();
    expect(
      inferChapterHint({ fileName: "構想.md", body: "第3話　再会", format: "memo" })
    ).toBeNull();
  });

  test("話数0は補わない", () => {
    expect(chapterOf({ fileName: "第〇話.txt" })).toBeNull();
    expect(chapterOf({ fileName: "続き.txt", body: "第0話　序" })).toBeNull();
  });
});

describe("作者への見せ方（一覧のホバー）", () => {
  test("補った話は、補ったことと出どころを1行で言う", () => {
    expect(
      describeChapterHint({ status: "inferred", evidence: "ファイル名の「第三話」" })
    ).toBe("- 補った話数です（ファイル名の「第三話」から。ファイル名の規則では読めませんでした）");
  });

  test("食い違って補わなかった話は、何と何が食い違ったかを言う", () => {
    const result = inferChapterHint({ fileName: "再会（第三話）.txt", body: "第四話　再会\n本文" });
    expect(result?.status).toBe("conflict");
    const line = describeChapterHint(result ? toChapterHintNote(result) : undefined);
    expect(line).toContain("話数を補っていません");
    expect(line).toContain("第三話");
  });

  test("規則で読めた話には何も足さない", () => {
    expect(describeChapterHint(undefined)).toBeNull();
  });
});

describe("既存の規則で読めるものには触らない（既存の動きを変えない）", () => {
  test.each([
    ["001.txt"],
    ["007_湖畔の誓い.txt"],
    ["003-005_合本.txt"],
    ["第12話 再会.md"],
    ["12話.txt"],
    ["episode_0001.txt"],
    ["2026-08-12.txt"],
    ["2026-08-16_海辺の話.txt"],
    ["プロローグ.txt"],
    ["幕間1.txt"],
  ])("%s には補いを返さない（本文に別の話数の見出しがあっても）", (fileName) => {
    expect(parseEpisodeFileName(fileName).kind).not.toBe("不明");
    expect(inferChapterHint({ fileName, metaTitle: "第99話　別", body: "第98話\n本文" })).toBeNull();
  });
});
