import { describe, expect, it } from "vitest";
import {
  parseNarouBackup,
  parseNarouBackupHeader,
} from "../../src/core/narouBackup";
import { parseCollectedFile } from "../../src/core/collectedFile";
import { parseWorkInfo } from "../../src/core/workInfoParse";

/**
 * なろうのバックアップ（投稿済み作品テキストダウンロード）の読み取り（設計書6.99）。
 *
 * **形は実物どおりに組む**（2026-09-19、作者の `N4190FX.zip`）。頭に作品情報、
 * 区切り行、話ごとに【エピソードタイトル】【本文】【リアクション】、最後に
 * 【免責事項】——本文に混ぜてはいけないものが前にも後ろにも付いている。
 */

const BACKUP = [
  "【ユーザ情報】",
  "ユーザID: 1125969",
  "ユーザ名: hisa",
  "",
  "【Nコード】",
  "N4190FX",
  "",
  "【タイトル】",
  "肉片とラジオと心霊現象",
  "",
  "【作者名】",
  "hisa",
  "",
  "【ジャンル】",
  "ホラー〔文芸〕",
  "",
  "【キーワード】",
  "怪談 実体験 飛び降り",
  "",
  "【あらすじ】",
  "筆者が中学３年生の頃に体験した実体験です。",
  "",
  "【評価】",
  "総合評価ポイント: 2pt",
  "評価者数: 0人",
  "お気に入り登録: 1件",
  "評価ポイント: 0pt",
  "評価平均: 0pt",
  "",
  "【収益情報】",
  "収益化設定: 無効",
  "累計獲得チアスコア: 0.00",
  "累計獲得なろうリワード: 0",
  "",
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１　自殺の後始末",
  "",
  "【本文】",
  "　あれは、確か中学３年生の頃。",
  "",
  "【リアクション】",
  "0件",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２　ラジオ",
  "",
  "【本文】",
  "　その夜、ラジオが鳴った。",
  "",
  "【リアクション】",
  "3件",
  "",
  "【免責事項】",
  "本作品の著作権は作者に帰属します。",
  "このファイルは『小説家になろう』の投稿済み作品テキストダウンロード機能を用いて作成されました。",
  "",
].join("\n");

describe("なろうのバックアップを読む", () => {
  it("Nコードを小文字で持ち、作品ページのURLを組み立てる", () => {
    const parsed = parseNarouBackup(BACKUP);
    expect(parsed).not.toBeNull();
    // 照合（封筒の作品ID）と同じ形にするため、小文字で持つ
    expect(parsed?.header.ncode).toBe("n4190fx");
    expect(parsed?.header.workUrl).toBe("https://ncode.syosetu.com/n4190fx/");
    expect(parsed?.header.genre).toBe("ホラー〔文芸〕");
  });

  /*
    **【評価】の5つを1つも取りこぼさない**（0.69.9。作者の裁定
    「投稿サイトごとに持ってください」）。

    共通の欄に当たるのは2つだけで、残る3つ（人数・素点・平均）はカクヨムの
    どの数字とも同じ軸に乗らない——**なろう固有の欄**として持つ。以前は
    名前だけを `unmappedRatings` に残して数字を捨てていた。
  */
  it("【評価】の5つを、共通の欄となろう固有の欄へ分けて読む", () => {
    const parsed = parseNarouBackup(BACKUP);
    expect(parsed?.header.metrics).toEqual({
      points: 2,
      bookmarks: 1,
      narou_raters: 0,
      narou_ratingPoints: 0,
      narou_ratingAverage: 0,
    });
    // 見覚えのない行だけがここへ落ちる（黙って捨てない）
    expect(parsed?.header.unmappedRatings).toEqual([]);
  });

  it("評価平均は小数のまま読む（切り捨てて別の値にしない）", () => {
    const parsed = parseNarouBackup(
      BACKUP.replace("評価平均: 0pt", "評価平均: 4.50pt")
    );
    expect(parsed?.header.metrics.narou_ratingAverage).toBe(4.5);
    // PVのような整数の欄は、小数を受けない（打ち間違いを通さない）
    const broken = parseNarouBackup(
      BACKUP.replace("評価者数: 0人", "評価者数: 1.5人")
    );
    expect(broken?.header.metrics.narou_raters).toBeUndefined();
    expect(broken?.header.unmappedRatings).toEqual(["評価者数"]);
  });

  it("収益情報（チアスコア・なろうリワード）は1つも読まない", () => {
    const parsed = parseNarouBackup(BACKUP);
    const asText = JSON.stringify(parsed?.header);
    expect(asText).not.toContain("チアスコア");
    expect(asText).not.toContain("リワード");
    expect(asText).not.toContain("1125969"); // ユーザIDも持たない
  });

  /*
    **合本の話数は、ファイルの数ではない**（0.69.9）。ここを取り違えて
    いたので、4話の作品で「1話を取り込みました」と出た（実データ）。
  */
  it("合本に入っていた話の数を数える", () => {
    expect(parseNarouBackup(BACKUP)?.episodeCount).toBe(2);
  });

  it("リアクションを読めない話があっても、話数は減らない", () => {
    const parsed = parseNarouBackup(BACKUP.replace("3件", "よくわからない"));
    expect(parsed?.episodeCount).toBe(2);
    // 読めなかったリアクションは**記録しない**（0で埋めない）
    expect(parsed?.episodes).toHaveLength(1);
  });

  it("リアクションは話ごとに1件ずつ読む", () => {
    const parsed = parseNarouBackup(BACKUP);
    expect(parsed?.episodes).toEqual([
      { episode: 1, metrics: { likes: 0 } },
      { episode: 2, metrics: { likes: 3 } },
    ]);
  });

  it("「いいね: 19件」の書き方でも読む", () => {
    const parsed = parseNarouBackup(
      BACKUP.replace("【リアクション】\n3件", "【リアクション】\nいいね: 19件")
    );
    expect(parsed?.episodes[1]).toEqual({ episode: 2, metrics: { likes: 19 } });
  });

  it("なろうのものでなければ、読まない", () => {
    expect(parseNarouBackupHeader("【タイトル】\n星を継ぐ者たち\n")).toBeNull();
    // Nコードの形をしていない値は受けない
    expect(parseNarouBackupHeader("【Nコード】\nよんいちきゅうまる\n")).toBeNull();
  });

  /*
    **本文に混ぜてはいけないもの**（作者の指摘、2026-09-19）。
    区切り行から次の区切り行までを素直に切ると、【リアクション】と
    【免責事項】が本文の末尾に付いてくる。
  */
  it("話の本文に、リアクションと免責事項が入らない", () => {
    const episodes = parseCollectedFile(BACKUP);
    expect(episodes).toHaveLength(2);
    for (const episode of episodes ?? []) {
      expect(episode.body).not.toContain("【リアクション】");
      expect(episode.body).not.toContain("件");
      expect(episode.body).not.toContain("【免責事項】");
      expect(episode.body).not.toContain("著作権");
      expect(episode.body).not.toContain("テキストダウンロード機能");
    }
    expect(episodes?.[0].body).toBe("　あれは、確か中学３年生の頃。");
    expect(episodes?.[1].body).toBe("　その夜、ラジオが鳴った。");
  });

  it("頭の作品情報から、題・あらすじ・キーワードを読める", () => {
    const head = parseNarouBackup(BACKUP)?.head ?? "";
    const info = parseWorkInfo(head);
    expect(info.title).toBe("肉片とラジオと心霊現象");
    expect(info.blurb).toContain("中学３年生の頃に体験した実体験");
    // **なろうは【キーワード】に空白区切りで並べる**（カクヨムは【タグ】）
    expect(info.tags).toEqual(["怪談", "実体験", "飛び降り"]);
    // 本文は1行も混ざらない
    expect(head).not.toContain("ラジオが鳴った");
  });
});
