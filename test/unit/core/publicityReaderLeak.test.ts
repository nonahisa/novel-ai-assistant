import { describe, expect, test } from "vitest";
import {
  blurbReaderLeakNote,
  screenCatchphrases,
} from "../../../src/core/blurbValidation";
import {
  buildAnnouncementMarkdown,
  validateAnnouncement,
} from "../../../src/core/announcement";

/**
 * 層の呼び名が、読者に見せる文章へ出ていないかを見る（作者の問い、2026-09-23）。
 *
 * プロンプトに「考察層」「没入層」と書いて渡すので、**そのまま答えに
 * 返ってくる前提で検査を書く**（CLAUDE.md の失敗3）。「考察層のあなたへ」と
 * 書かれた紹介文を、作者がそのまま投稿サイトへ貼ってしまうのを止めたい。
 *
 * - 紹介文：捨てずに、注意を添える（字数と同じ扱い。直すのは作者）
 * - キャッチコピー：落とす（字数超えと同じ扱い。貼れない案を選ばせない）
 * - 告知文：注意を出す（ほかの注意と同じく、冒頭に並ぶ）
 */

describe("紹介文", () => {
  test("層の呼び名が入っていれば、注意の文を返す", () => {
    const note = blurbReaderLeakNote("考察層の読者に贈る、伏線の物語。");
    expect(note).toContain("考察層");
  });

  test("入っていなければ undefined（誤検出しない）", () => {
    expect(blurbReaderLeakNote("塔の上で、魔女は名前を忘れた。")).toBeUndefined();
  });
});

describe("キャッチコピー", () => {
  test("層の呼び名が入った案は、理由を付けて落とす", () => {
    const screened = screenCatchphrases([
      { text: "すきま層に贈る、三分の冒険。", kind: "謎・引き型", intent: null },
      { text: "その塔は、名前を覚えている。", kind: "謎・引き型", intent: null },
    ]);

    expect(screened.kept.map((item) => item.text)).toEqual([
      "その塔は、名前を覚えている。",
    ]);
    expect(screened.dropped).toHaveLength(1);
    expect(screened.dropped[0].reason).toContain("すきま層");
  });
});

describe("告知文", () => {
  test("読者に出す3つのどれかに層の呼び名があれば注意する", () => {
    const warnings = validateAnnouncement(
      {
        xPost: "第3話を更新しました。",
        activityReport: "没入層の皆さま、今回は港町の夜です。",
        afterword: "読んでくださってありがとうございます。",
        spoilerCheck: null,
        confidence: "high",
      },
      "第3話を更新しました。"
    );

    expect(warnings.join("\n")).toContain("活動報告用");
    expect(warnings.join("\n")).toContain("没入層");
  });

  test("何に向けて書いたかの1行を、見出しのすぐ下に出す（渡さなければ出さない）", () => {
    const base = {
      workTitle: "図書塔の魔女",
      episodeLabel: "第3話",
      composedX: "更新しました",
      weightedLength: 12,
      activityReport: "報告",
      afterword: "後書き",
      spoilerCheck: null,
      warnings: [],
    };
    const note = "狙いの読者（考察層）に向けて書きました。";

    const withNote = buildAnnouncementMarkdown({ ...base, readerNote: note });
    expect(withNote.split("\n").slice(0, 5)).toEqual([
      "# 更新告知文",
      "",
      "図書塔の魔女　第3話",
      "",
      note,
    ]);
    expect(buildAnnouncementMarkdown(base)).not.toContain("向けて書きました");
  });

  test("伏せたものの申告（作者向け）は見ない", () => {
    const warnings = validateAnnouncement(
      {
        xPost: "第3話を更新しました。",
        activityReport: "今回は港町の夜です。",
        afterword: "ありがとうございます。",
        spoilerCheck: "考察層向けの伏線の答えは伏せました",
        confidence: "high",
      },
      "第3話を更新しました。"
    );

    expect(warnings.join("\n")).not.toContain("考察層");
  });
});
