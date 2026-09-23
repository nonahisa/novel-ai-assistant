import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROOFREADING_CHECKS } from "../../src/core/proofreadingSuite";
import { buildFinishConfirm, planFinish } from "../../src/core/finishNewWork";

/**
 * **確認は、まとめ実行が最初に1回だけ取る**（設計書6.80）。
 *
 * 「新しい作品を、ひと通り仕上げる」の確認にはこう書いてある——
 * 「校正の段では確認は出しません」。ところが 2026-09-19 の実機確認で、
 * **冒頭診断（8/12）で確認が出て、まとめ実行が10分以上止まっていた。**
 * 作者は確認が出ない前提で画面を離れており、止まっていることに気づけない。
 *
 * 原因は、コマンドの登録側（`extension.ts`）が第2引数を受けておらず、
 * まとめ実行が送った `{ suite: { confirmed: true } }` が機能まで
 * 届いていなかったこと。**型では止められない**（第2引数は省ける）ので、
 * 登録の書きぶりをここで見る。
 */

const SRC = resolve(__dirname, "../../src");
const read = (path: string): string => readFileSync(resolve(SRC, path), "utf8");

/** そのコマンドの登録のかたまりだけを切り出す */
function registrationOf(source: string, command: string): string {
  const start = source.indexOf(`"${command}"`);
  expect(start, `${command} の登録が見つからない`).toBeGreaterThan(0);
  const next = source.indexOf("registerCommand(", start);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

describe("まとめ実行の印が、校正の各機能まで届く", () => {
  const extension = read("extension.ts");
  const usesAI = PROOFREADING_CHECKS.filter((check) => check.usesAI);

  test("AIを使う校正の段は、すべて登録側で印を読んでいる", () => {
    const missing = usesAI
      .filter(
        (check) =>
          !registrationOf(extension, check.command).includes(
            "isSuiteConfirmed(options)"
          )
      )
      .map((check) => check.label);
    expect(
      missing,
      "まとめ実行が送った確認済みの印を、この段だけ受け取っていない"
    ).toEqual([]);
  });

  test("冒頭診断は、確認済みなら自分の確認を出さない", () => {
    const source = read("features/checkOpening.ts");
    // 料金の確認を出す手前で、まとめ実行かどうかを見ていること
    // （import 行にも名前が出るので、呼び出しの位置で見る）
    const paidAt = source.indexOf("confirmPaidUsage(resolved.provider");
    const suiteAt = source.indexOf("options.suiteConfirmed");
    expect(paidAt).toBeGreaterThan(0);
    expect(suiteAt).toBeGreaterThan(0);
    expect(suiteAt).toBeLessThan(paidAt);
    // 飛ばした中身は操作ログへ残す（この作品の決まり）
    expect(source).toContain("まとめ実行のため確認を省略");
  });

  test("確認の文面は「校正の段では確認は出しません」のまま", () => {
    /*
      直し方は2通りあった。**実装のほうを文面へ合わせた。**

      作者は「校正の段は確認なしで走る」と思って実行し、画面を離れる。
      文面を「冒頭診断だけは確認が出ます」と直すと、13段のうち1段だけ
      前提の違う段ができ、離れられない時間が読めなくなる。
    */
    const confirm = buildFinishConfirm({
      workTitle: "試しの作品",
      plan: planFinish([]),
    });
    expect(confirm?.detail).toContain("校正の段では確認は出しません。");
    expect(confirm?.detail).not.toContain("冒頭診断だけは");
  });
});
