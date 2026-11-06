import { describe, expect, test } from "vitest";
import {
  reviewLockHeldMessage,
  reviewLockReleasedOthersDetail,
  reviewLockTakenMessage,
  reviewRangeNotifyFailedMessage,
  reviewRangeStartedMessage,
} from "../../../src/core/reviewLockMessages";
import { EDITOR_STEP_DEFS, editorStepLabel } from "../../../src/core/stepDefs";

/**
 * 校閲中の知らせの文（作者の裁定 2026-11-07 未明。文はこのとおりに）。
 *
 * 「押さえ」は作者に通じなかったので、画面の文は「校閲中」で言う。
 * メニューの名前は編集者メニューの定義から引く（名前を変えたら文もついてくる）。
 */
describe("校閲中の知らせの文", () => {
  test("範囲を決めたとき：見出しは「〈範囲〉を校閲中にしました。」、続きで「6.」を押すと届くと言う", () => {
    const message = reviewRangeStartedMessage("第2話〜第3話");
    expect(message.headline).toBe("第2話〜第3話を校閲中にしました。");
    expect(message.note).toBe(
      "直し終えたら、編集者メニューの「6. 校閲を終えて作者へ返す」を押すと、提案が作者へ届きます。"
    );
    // 下の帯は1行しか見せないので、見出しと続きをつなげた全文が裁定の文になる
    expect(message.headline + message.note).toBe(
      "第2話〜第3話を校閲中にしました。直し終えたら、編集者メニューの「6. 校閲を終えて作者へ返す」を押すと、提案が作者へ届きます。"
    );
  });

  test("範囲を作者へ知らせられなかったとき", () => {
    expect(reviewRangeNotifyFailedMessage()).toBe(
      "校閲中の範囲を、作者へ知らせられませんでした（ネットにつながっていないなど）。" +
        "範囲は、編集者メニューの「6. 校閲を終えて作者へ返す」を押したときに、提案と一緒に作者へ届きます。"
    );
  });

  test("作者モードの校閲のロック：「押さえ」ではなく「校閲中」で言う", () => {
    expect(reviewLockHeldMessage("001_霧の朝.txt")).toBe("001_霧の朝.txt は校閲中です。");
    expect(reviewLockTakenMessage("001_霧の朝.txt")).toBe("001_霧の朝.txt を校閲中にしました。");
    expect(reviewLockReleasedOthersDetail("kmizu")).toBe("kmizu が校閲中にしていたものを外しました");
  });

  test("メニューの名前は編集者メニューの定義から引く", () => {
    const returnStep = EDITOR_STEP_DEFS.find((def) => def.key === "return");
    expect(editorStepLabel("return")).toBe(returnStep?.label);
    expect(reviewRangeNotifyFailedMessage()).toContain(`「${editorStepLabel("return")}」`);
  });
});
