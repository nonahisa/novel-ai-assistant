import { describe, expect, test } from "vitest";
import {
  buildResumeSheet,
  type ResumeOverview,
  type ResumeSheetInput,
} from "../../src/core/resumeSheet";

/**
 * **作品の大きな流れ**（設計書6.36.1）。
 *
 * 作者の指摘（2026-09-13）：「直近の数話はわかりますが、大きな流れが
 * わかりません。コンパクトにまとめて提示できないでしょうか？」
 *
 * これまでの1枚は**手前しか映していなかった**——前回どこまで、直前3話の
 * あらすじ、未回収の伏線、この話の単話プロット。書き出す前に思い出したいのは
 * まず「作品がどこへ向かっていて、自分がいまどのあたりにいるか」である。
 *
 * **「コンパクト」を守る。** 話ごとのあらすじを全部並べると、200話の作品では
 * 1枚に収まらず、大きな流れを読むのに端から端まで目を通すことになる。
 * 出すのは3つだけ——作品ぜんぶのあらすじ・章の並び・いまの位置。
 */

function overview(overrides: Partial<ResumeOverview> = {}): ResumeOverview {
  return {
    plotOutline: "湖のほとりで出会った二人が、記憶を取り戻すまでの話。",
    chapters: [
      { name: "第一章　出会い", episodeCount: 7, from: 1, to: 7, current: false },
      { name: "第二章　別れ", episodeCount: 11, from: 8, to: 18, current: true },
    ],
    totalEpisodes: 18,
    latestChapter: 18,
    ...overrides,
  };
}

function input(over?: ResumeOverview): ResumeSheetInput {
  return {
    workTitle: "湖畔の誓い",
    overview: over,
    latest: null,
    synopses: [],
    openForeshadows: [],
    episodePlot: { kind: "missing", path: "設定/episode-plots/第19話.md" },
    todayGoal: null,
  };
}

describe("作品の大きな流れ", () => {
  test("**いちばん上に出す**（直近の数話より先）", () => {
    const sheet = buildResumeSheet(input(overview()));
    const flow = sheet.indexOf("## 作品の大きな流れ");
    const latest = sheet.indexOf("## 前回どこまで");
    expect(flow).toBeGreaterThan(0);
    expect(latest).toBeGreaterThan(0);
    expect(flow).toBeLessThan(latest);
  });

  test("プロットのあらすじを、そのまま載せる", () => {
    const sheet = buildResumeSheet(input(overview()));
    expect(sheet).toContain("湖のほとりで出会った二人が、記憶を取り戻すまでの話。");
  });

  test("章の並びと、いまいる章に印が付く", () => {
    const sheet = buildResumeSheet(input(overview()));
    expect(sheet).toContain("| 第一章　出会い | 第1〜7話 | 7話 |  |");
    expect(sheet).toContain("| 第二章　別れ | 第8〜18話 | 11話 | **← いまここ** |");
  });

  test("いまの位置を1行で言う", () => {
    const sheet = buildResumeSheet(input(overview()));
    expect(sheet).toContain("いまは第18話まで書けています（18話）。");
  });

  test("1話しか無い章は「第3話」と書く（「第3〜3話」にしない）", () => {
    const sheet = buildResumeSheet(
      input(
        overview({
          chapters: [
            { name: "序", episodeCount: 1, from: 3, to: 3, current: false },
          ],
        })
      )
    );
    expect(sheet).toContain("| 序 | 第3話 | 1話 |  |");
    expect(sheet).not.toContain("第3〜3話");
  });
});

describe("材料が揃っていないとき", () => {
  test("**あらすじが空なら、書く場所を教える**（空欄を黙って置かない）", () => {
    const sheet = buildResumeSheet(input(overview({ plotOutline: "" })));
    expect(sheet).toContain("プロットの「あらすじ」がまだ空です");
    expect(sheet).toContain("plot.md");
  });

  test("**章立てが無いなら、作り方を1行だけ添える**", () => {
    const sheet = buildResumeSheet(input(overview({ chapters: [] })));
    expect(sheet).toContain("章立てはまだありません");
    // 空の表を出さない（見出しだけの表は壊れて見える）
    expect(sheet).not.toContain("| 章 | 範囲 | 話数 |");
  });

  test("話数を読めなくても、書けている量は言える", () => {
    const sheet = buildResumeSheet(
      input(overview({ latestChapter: null, totalEpisodes: 42 }))
    );
    expect(sheet).toContain("いまは42話ぶん書けています。");
  });

  test("**材料が渡らなければ、節ごと出さない**", () => {
    // 古い呼び出し（材料を渡さない試験）で、見出しだけが並ばないこと
    const sheet = buildResumeSheet(input(undefined));
    expect(sheet).not.toContain("## 作品の大きな流れ");
  });
});
