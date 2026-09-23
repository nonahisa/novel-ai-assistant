import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { postingCopySource } from "../../src/core/episodeCopy";

/**
 * 原稿エディタの「投稿サイト用にコピー」を、選んだ範囲だけにする
 * （設計書6.12.8。作者の裁定、2026-09-21）。
 *
 * 作者の報告：「部分選択でコピーして右クリックもページ全体」。
 * 右クリックからは話ぜんぶしか写せず、部分を選んでも全文が入っていた。
 * 裁定は「右クリックに全体コピーは不要です。メニューにあるので」
 * ——**右クリックは選んだ範囲だけ**（全文はメニューとツールバーの口）。
 */

/**
 * 合本（1ファイルに全話）。**区切り行の形は `core/collectedFile.ts` が決める**
 * ので、ここでは実物と同じ書き方をそのまま置く。
 */
const COLLECTED = [
  "--- エピソード 1 開始 ---",
  "【タイトル】第1話",
  "【本文】",
  "　一話目の本文。",
  "",
  "--- エピソード 2 開始 ---",
  "【タイトル】第2話",
  "【本文】",
  "　二話目の本文。",
].join("\n");

describe("選んだところがあれば、そこだけ写す", () => {
  test("選んだ文字列がそのまま変換の元になる", () => {
    const result = postingCopySource(COLLECTED, 9, "　二話目の");

    expect(result.source).toBe("　二話目の");
    expect(result.selected).toBe(true);
  });

  test("選んだときは、合本の切り分けを通さない", () => {
    // どの話かを決める必要そのものが無い。知らせの文言もここで分かれる
    const result = postingCopySource(COLLECTED, 9, "　二話目の");

    expect(result.collected).toBeUndefined();
  });

  test("頭書き（【タイトル】〜【本文】）も、選んだなら外さない", () => {
    // 選ぶのも作者の意思である。選んだ範囲と貼られるものが食い違うほうが困る
    const picked = "【タイトル】第2話\n【本文】\n　二話目の本文。";
    const result = postingCopySource(COLLECTED, 7, picked);

    expect(result.source).toBe(picked);
  });
});

describe("選んでいなければ、これまでどおり", () => {
  test("合本なら、カーソルの居る話だけ", () => {
    const result = postingCopySource(COLLECTED, 9);

    expect(result.selected).toBe(false);
    expect(result.collected).toBeDefined();
    expect(result.source).toContain("二話目の本文");
    expect(result.source).not.toContain("一話目の本文");
  });

  test("合本でなければ、頭書きを外した本文", () => {
    const single = "【タイトル】ある日\n【本文】\n　雪が降っていた。";
    const result = postingCopySource(single, 0);

    expect(result.source).toBe("　雪が降っていた。");
    expect(result.collected).toBeUndefined();
  });

  test("空文字の選択は「選んでいない」と同じに扱う", () => {
    // 画面は選んでいないとき -1 を送るが、0字の範囲が来ても壊れないこと。
    //
    // `result.selected` と `result.collected` が定義済みであることしか
    // 見ていなかった（兄弟の「合本なら、カーソルの居る話だけ」は
    // `result.source` の中身まで見ている）。それでは、空文字のときに
    // 別の話（1話目）の本文を詰めて返しても通ってしまう。
    // カーソルは2話目（行9）にあるので、2話目の本文であることを見る
    const result = postingCopySource(COLLECTED, 9, "");

    expect(result.selected).toBe(false);
    expect(result.collected).toBeDefined();
    expect(result.source).toContain("二話目の本文");
    expect(result.source).not.toContain("一話目の本文");
  });
});

describe("画面から範囲が届く道", () => {
  const html = readFileSync(
    resolve("src/views/manuscriptEditorHtml.ts"),
    "utf8"
  );
  const feature = readFileSync(
    resolve("src/features/manuscriptEditor.ts"),
    "utf8"
  );

  test("右クリックの「投稿サイト用にコピー」が、選択の位置を添えて送る", () => {
    const menu = html.slice(html.indexOf('add("投稿サイト用にコピー"'));

    expect(menu.slice(0, 700)).toContain("menuSelection()");
    expect(menu.slice(0, 700)).toContain('type: "copyForPosting"');
    expect(menu.slice(0, 700)).toContain("start:");
    expect(menu.slice(0, 700)).toContain("end:");
  });

  test("位置はLF空間で届くので、文書の位置へ直してから切る", () => {
    // CRLF の原稿で直し忘れると、選んだところと写るところがずれる
    const handler = feature.slice(feature.indexOf('case "copyForPosting"'));

    expect(handler.slice(0, 300)).toContain("message.start");
    expect(feature).toContain("fromLfOffset(whole, selection.start)");
  });

  test("「記法のままコピー」は、選んでいるときだけ押せる", () => {
    // 選択が無ければ写すものが無い（全文は普通のコピーとメニューの口で足りる）
    const item = html.slice(html.indexOf('add("記法のままコピー"'));

    expect(item.slice(0, 400)).toContain('type: "copyNotation"');
    expect(item.slice(0, 400)).toContain("hasSelection");
  });
});
