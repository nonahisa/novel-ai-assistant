import { describe, expect, test } from "vitest";
import { detectRunIntent } from "../../src/core/chatIntent";

/**
 * 実機のログで見つかった不具合の再現（2026-08-15）。
 *
 * プロンプトで「作業を頼まれたら run に機能名を入れよ」と指示しても、
 * 8Bのモデルは**会話の中で作業を終わらせようとして run を落とす**。
 * 2回続けて確認したので、コード側で見分けることにした。
 */
describe("実機で run が落ちた質問", () => {
  test("「すべての作品の設定を抽出してください」", () => {
    expect(detectRunIntent("すべての作品の設定を抽出してください")).toBe(
      "extractSettings"
    );
  });

  test("「設定を抽出して統合してください」", () => {
    // 「統合」も含むが、頼まれている最初の一手は抽出
    expect(detectRunIntent("設定を抽出して統合してください")).toBe(
      "extractSettings"
    );
  });
});

describe("種別を絞った頼み方", () => {
  test("人物だけなら人物の抽出を勧める", () => {
    // まとめて抽出すると、要らない待ち時間と料金がかかる
    expect(detectRunIntent("登場人物を抽出してください")).toBe(
      "extractCharacters"
    );
  });

  test("場所・能力・組織・世界観も見分ける", () => {
    expect(detectRunIntent("場所を抽出して")).toBe("extractLocations");
    expect(detectRunIntent("スキルを抽出して")).toBe("extractAbilities");
    expect(detectRunIntent("組織を抽出して")).toBe("extractOrganizations");
    expect(detectRunIntent("世界観を抽出して")).toBe("extractWorld");
  });
});

describe("そのほかの作業", () => {
  test.each([
    ["各話あらすじを作ってください", "generateSynopses"],
    ["作品紹介文を作って", "generateWorkBlurb"],
    ["キャッチコピーを考えて", "generateCatchphrases"],
    ["本文からプロットを起こして", "generatePlot"],
    ["誤字脱字を調べてください", "checkTypos"],
    ["表記ゆれを検知して", "checkNotation"],
    ["重複をまとめて", "unifyCharacters"],
    ["設定資料集を出力して", "generateSettingsDocs"],
  ])("「%s」→ %s", (question, expected) => {
    expect(detectRunIntent(question)).toBe(expected);
  });
});

describe("出してはいけない場面", () => {
  test("使い方を聞かれているときは出さない", () => {
    // 説明で答えるのが正しい。処理が始まりそうに見えては困る
    expect(detectRunIntent("抽出ってどうやるの？")).toBeUndefined();
    expect(detectRunIntent("設定の抽出方法を教えて")).toBeUndefined();
    expect(detectRunIntent("誤字脱字を調べる機能はありますか")).toBeUndefined();
  });

  test("依頼の形になっていなければ出さない", () => {
    expect(detectRunIntent("この作品の設定は複雑ですね")).toBeUndefined();
    expect(detectRunIntent("抽出")).toBeUndefined();
  });

  test("関係のない相談では出さない", () => {
    // 迷ったら出さない。関係のないボタンは、押していいのか作者が迷う
    expect(detectRunIntent("この場面をもっと短くしてほしい")).toBeUndefined();
    expect(detectRunIntent("主人公の動機を一緒に考えて")).toBeUndefined();
  });

  test("空でも壊れない", () => {
    expect(detectRunIntent("")).toBeUndefined();
    expect(detectRunIntent("   ")).toBeUndefined();
  });
});

describe("押すのは作者", () => {
  test("見分けても、返すのは機能の種別だけ", () => {
    // 実行はしない。ボタンを出すところまでが、作者から許可された範囲
    const kind = detectRunIntent("設定を抽出してください");

    expect(typeof kind).toBe("string");
  });
});
