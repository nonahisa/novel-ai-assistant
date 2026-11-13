import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sendToEditor, shareWithEditor } from "../../../src/features/shareWithEditor";
import {
  UNREGISTER_BUTTON,
  moved,
  present,
  setUpMissingWork,
  type MissingWorkHarness,
} from "../support/missingWorkHarness";
import { window } from "../support/vscodeStub";

/**
 * 「編集者へ渡す」も、作品（または同じ置き場の登録済みの作品）のフォルダーが見つからなければ、
 * 写す前に止める（2026-11-14。設計書5.5.14）。
 *
 * 渡す道は、作品のフォルダーから編集用の別リポジトリへ本文と設定を**まるごと置き換えて**写し、
 * 記録して送る。写すものが無いまま進むと、編集用リポジトリでは原稿を全部消した記録になり、
 * 編集者の側へ原稿が消えた形で届く。
 */

let harness: MissingWorkHarness;
let asked: number;
const original = {
  showInputBox: window.showInputBox,
  showQuickPick: window.showQuickPick,
  showOpenDialog: window.showOpenDialog,
  showErrorMessage: window.showErrorMessage,
};
beforeEach(() => {
  harness = setUpMissingWork();
  asked = 0;
  // 置き場を選ぶ・編集者の名前を訊く窓（ここまで来たら、止める確かめを通り過ぎたということ）
  const count = async () => {
    asked += 1;
    return undefined;
  };
  Object.assign(window, {
    showInputBox: count,
    showQuickPick: count,
    showOpenDialog: count,
    showErrorMessage: count,
  });
});
afterEach(() => {
  harness.restore();
  Object.assign(window, original);
});

function expectStopped(): void {
  expect(harness.writes()).toEqual([]);
  expect(asked).toBe(0);
  // 渡す確認の窓（「編集者へ…」）は出さない。見つからない知らせ自身は除いて見る
  expect(
    harness.warned.some(
      (one) => one.message.includes("編集者へ") && !one.message.includes("作品のフォルダーが見つからない")
    )
  ).toBe(false);
  const notices = harness.missingNotices();
  expect(notices).toHaveLength(1);
  // 渡す操作なので「同期を止めました」とは言わない（2026-11-14。担当の気づき）
  expect(notices[0].message).toContain(
    "作品のフォルダーが見つからないので、編集者へ渡していません：たゆたう鉛。消したり移したりした作品なら、作品の一覧から外してから渡してください。"
  );
  expect(notices[0].message).not.toContain("同期");
  expect(notices[0].buttons).toEqual([UNREGISTER_BUTTON]);
}

describe("編集者へ渡す：フォルダーが見つからない作品があるとき", () => {
  test("渡す作品そのものが無い：訊かず・写さず・送らずに知らせる", async () => {
    await shareWithEditor(moved, harness.registry.list(), { run: harness.run });
    expectStopped();
  });

  test("同じ置き場のほかの作品が無い：訊かず・写さず・送らずに知らせる", async () => {
    await shareWithEditor(present, harness.registry.list(), { run: harness.run });
    expectStopped();
  });

  test("写す本体（採否の自動の送り返しも通る）：作品が無ければ写さず・送らずに失敗で返す", async () => {
    const outcome = await sendToEditor(moved, "C:/編集部/たゆたう鉛", {
      run: harness.run,
      site: {},
    } as never);
    expect(outcome.ok).toBe(false);
    expect(harness.calls).toEqual([]);
  });

  test("作品が全部そろっていれば、今までどおり置き場を選ぶ・名前を訊く窓へ進む", async () => {
    harness.bringBack();
    await shareWithEditor(present, harness.registry.list(), { run: harness.run });
    expect(asked).toBeGreaterThan(0);
    expect(harness.missingNotices()).toEqual([]);
  });
});
