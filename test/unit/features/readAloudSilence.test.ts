import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { waitFor } from "../../src/features/manuscriptEditor";

/**
 * **「押しても何も起きない」を作らない**（設計書6.42）。
 *
 * 作者の報告（2026-09-08、0.42.5）：詳細メニューの「原稿を読み上げる」を押して
 * 作品を選ぶと、**何も開かず、何のお知らせも出ない**。2回とも同じだった。
 * 作品一覧から同じ話を開けば読み上げの列は出るので、壊れているのは
 * このコマンドの経路だけだった。
 *
 * そのときの作りは、台帳に載るのを1.5秒待って、空振りしたら
 * **ログに1行残すだけ**。作者の言葉は
 * 「空振りしたときは、ログではなく画面に出してください。
 * 『押しても何も起きない』は作者がいちばん困る形です」。
 *
 * 0.51.7 で2つ直した。
 *
 * - 待つ上限を延ばした（この起動ではじめて開く原稿では、画面の組み立てと
 *   本文の読み込みが同時に走るので1.5秒では足りないことがある）
 * - 空振りしたら画面に出す。**次にできることまで書く**
 */

const source = readFileSync(
  resolve(__dirname, "../../src/features/manuscriptEditor.ts"),
  "utf8"
);

describe("読み上げが始められなかったとき", () => {
  test("**黙って終わらない**（画面に出す）", () => {
    const at = source.indexOf("読み上げ：${filePath} を開けなかったため");
    expect(at).toBeGreaterThan(0);
    const branch = source.slice(at, at + 500);
    expect(branch).toContain("showWarningMessage");
  });

  test("**次にできることを書く**（作品一覧から開いて、上のバーの読み上げ）", () => {
    // 「できませんでした」だけだと、作者は打つ手が無い
    const at = source.indexOf("読み上げを始められませんでした");
    expect(at).toBeGreaterThan(0);
    expect(source.slice(at, at + 300)).toContain("作品一覧から");
  });

  test("待つ上限は、既定より長い", () => {
    expect(source).toContain("const READ_ALOUD_LEDGER_WAIT_MS = 5000;");
    expect(source).toContain("READ_ALOUD_LEDGER_WAIT_MS\n  );");
  });
});

describe("台帳に載るのを待つ", () => {
  test("載ったらすぐ返す", async () => {
    let count = 0;
    const found = await waitFor(
      () => (++count >= 2 ? "載った" : undefined),
      1000,
      1
    );
    expect(found).toBe("載った");
  });

  test("**上限まで載らなければ諦める**（永久に待たない）", async () => {
    const started = Date.now();
    const found = await waitFor(() => undefined, 30, 5);
    expect(found).toBeUndefined();
    // 上限を大きく超えて待ち続けない
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
