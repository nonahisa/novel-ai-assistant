import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

/**
 * 一部が失敗したときに「完了しました」と言わない（設計書6.47）。
 *
 * 実データで、誤字脱字検知が3件中2件タイムアウトした回に
 * 「完了しました。指摘 0件 / 失敗 2チャンク」と出ていた
 * （作者のログ、2026-08-29）。作者からは「誤字が無かった」と読めるが、
 * 実際には**本文の3分の2を見ていない**。
 *
 * 通知の組み立ては vscode に依存するので、**ソースの形で固定する**
 * （`generateCancellation` と同じ方式）。
 */

const EXTENSION = path.join(__dirname, "..", "..", "src", "extension.ts");

function source(): string {
  return fs.readFileSync(EXTENSION, "utf8");
}

describe("一部が失敗したら「完了」と言わない", () => {
  /**
   * 直接 `showInformationMessage` へ「〜が完了しました」を渡している箇所。
   *
   * 共通の入口（`notifyRunCompletion`）の中身は数えない——そこが唯一
   * 「完了しました」と言ってよい場所である。
   */
  function directCompletionNotices(): string[] {
    const code = source();
    const start = code.indexOf("function notifyRunCompletion");
    // **次の関数定義までを丸ごと除く。** `\n}` で切ると、関数の途中の
    // 閉じ括弧に当たって本体の一部が残る（最初の版で実際にそうなった）
    const next = code.indexOf("\nfunction ", start + "function notifyRunCompletion".length);
    const outside = code.slice(0, start) + code.slice(next > 0 ? next : code.length);
    return [...outside.matchAll(/showInformationMessage\(\s*`([^`]*が完了しました[^`]*)`/g)]
      .map((match) => match[1].slice(0, 30))
      // AIを使わない機能はチャンクを回さないので、失敗の概念が無い
      .filter((text) => !text.startsWith("表記ゆれ検知"));
  }

  test("チャンクを回す機能の完了通知は、共通の入口を通る", () => {
    // 落ちたら：その通知を `notifyRunCompletion` へ寄せる。
    // 一部が失敗しても「完了しました」と言ってしまう形になっている
    expect(directCompletionNotices()).toEqual([]);
  });

  test("共通の入口は、失敗があれば警告にして「見ていない」と伝える", () => {
    const code = source();
    const start = code.indexOf("function notifyRunCompletion");
    expect(start).toBeGreaterThan(0);
    const body = code.slice(start, start + 2000);

    // 失敗時は警告、かつ「完了」と言わない
    expect(body).toContain("showWarningMessage");
    expect(body).toMatch(/一部を処理できませんでした/);
    // **数だけで済ませない。** 見ていない部分があることを言葉で伝える
    expect(body).toMatch(/失敗した部分は見ていない/);
    // 成功時だけ「完了しました」
    expect(body).toMatch(/が完了しました/);
  });

  test("失敗の件数を渡している呼び出しが複数ある（空振りしていない）", () => {
    const calls = [...source().matchAll(/notifyRunCompletion\(\{/g)];
    // 誤字脱字・伏線検知・伏線回収・逸脱・推敲・矛盾
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });
});
