import { describe, expect, test } from "vitest";
import {
  parseCollectedFile,
  parseEpisodeTitle,
} from "../../src/core/collectedFile";

const sample = [
  "【タイトル】",
  "転生受験生の教科書チート生活",
  "",
  "【あらすじ】",
  "　受験生の少年が異世界に転生する。",
  "",
  "------------------------- エピソード1開始 -------------------------",
  "【第1章】",
  "第一章『死の谷』",
  "",
  "【エピソードタイトル】",
  "１話　転生",
  "",
  "【本文】",
  "",
  "　化学の先生が、授業中に無駄話をしていた。",
  "",
  "【リアクション】",
  "いいね: 19件",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２話　てこの原理と救助",
  "",
  "【本文】",
  "",
  "　何の気配もないところから急に声がした。",
  "",
  "【後書き】",
  "　読んでいただきありがとうございます。",
  "",
  "【リアクション】",
  "いいね: 24件",
  "",
].join("\r\n");

describe("合本ファイルの解析", () => {
  test("話ごとに分け、話数とタイトルを取り出す", () => {
    const episodes = parseCollectedFile(sample);

    expect(episodes).not.toBeNull();
    expect(episodes).toHaveLength(2);
    expect(episodes![0]).toMatchObject({
      order: 1,
      chapter: 1,
      title: "転生",
      part: "第一章『死の谷』",
    });
    expect(episodes![1]).toMatchObject({ order: 2, chapter: 2, title: "てこの原理と救助" });
  });

  test("本文だけを取り出し、後書き・リアクションは含めない", () => {
    const episodes = parseCollectedFile(sample)!;

    expect(episodes[0].body).toBe("　化学の先生が、授業中に無駄話をしていた。");
    // 後書きは作者の文章だが物語の本文ではない。文字数にもAIへの入力にも混ぜない
    expect(episodes[1].body).toBe("　何の気配もないところから急に声がした。");
    expect(episodes[1].body).not.toContain("ありがとうございます");
    expect(episodes[1].body).not.toContain("いいね");
  });

  test("作品全体のヘッダーは、どの話の本文にも入れない", () => {
    const episodes = parseCollectedFile(sample)!;

    for (const episode of episodes) {
      expect(episode.body).not.toContain("あらすじ");
      expect(episode.body).not.toContain("受験生の少年");
    }
  });

  test("区切りが無いファイルは合本ではないので null を返す", () => {
    expect(parseCollectedFile("【タイトル】\n第1話\n\n【本文】\n本文です。")).toBeNull();
    expect(parseCollectedFile("ただの本文。")).toBeNull();
  });

  test("本文中の【】に反応しない", () => {
    const text = [
      "------------------------- エピソード1開始 -------------------------",
      "【エピソードタイトル】",
      "１話　転生",
      "【本文】",
      "　看板には【立入禁止】と書かれていた。",
      "　その先へ進む。",
    ].join("\n");

    const episodes = parseCollectedFile(text)!;

    expect(episodes[0].body).toContain("【立入禁止】");
    expect(episodes[0].body).toContain("その先へ進む。");
  });
});

describe("話のタイトルから話数を取る", () => {
  test.each([
    ["１話　転生", 1, "転生"],
    ["12話 再会", 12, "再会"],
    ["第7話：湖畔の誓い", 7, "湖畔の誓い"],
    ["３話", 3, null],
  ])("%s", (raw, chapter, title) => {
    expect(parseEpisodeTitle(raw)).toEqual({ chapter, title });
  });

  test("話数が書かれていなければ推測せず、タイトルだけ残す", () => {
    // 並び順で埋めると、プロローグを第1話と数えて以降が全部ずれる
    expect(parseEpisodeTitle("プロローグ")).toEqual({
      chapter: null,
      title: "プロローグ",
    });
  });

  test("タイトルが無ければ両方 null", () => {
    expect(parseEpisodeTitle(null)).toEqual({ chapter: null, title: null });
    expect(parseEpisodeTitle("   ")).toEqual({ chapter: null, title: null });
  });
});
