import { describe, expect, test } from "vitest";
import {
  MANUAL_INSTALL_DETAIL,
  RECHECK_AFTER_MANUAL,
  installFailureButtons,
} from "../../../src/features/setupWizard";

/**
 * セットアップで「ご自身で入れてください」と案内したあとの、押せる道（作者の判断 2026-11-01）。
 *
 * 以前は「入れ終わったら、もう一度『セットアップ（必要なものを入れる）』を実行してください」
 * と言うだけで、その名前の操作は詳細メニューに無かった（設定管理へ移した。設計書6.56.3）。
 */
describe("手で入れたあとに確かめ直す道", () => {
  test("手で入れるものがあれば、［入れ終えたので確かめる］を先に出す", () => {
    expect(installFailureButtons([MANUAL_INSTALL_DETAIL, "取得に失敗しました"])).toEqual([
      RECHECK_AFTER_MANUAL,
      "ログを見る",
    ]);
  });

  test("手で入れるものが無ければ、ログだけ", () => {
    expect(installFailureButtons(["Ollamaを起動できませんでした。"])).toEqual(["ログを見る"]);
  });

  test("案内の文は、メニューに無い名前を言わず、ボタンの名前を言う", () => {
    expect(MANUAL_INSTALL_DETAIL).not.toContain("必要なものを入れる");
    expect(MANUAL_INSTALL_DETAIL).toContain(`［${RECHECK_AFTER_MANUAL}］`);
  });
});
