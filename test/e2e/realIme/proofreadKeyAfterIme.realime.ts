/**
 * 本物の日本語入力（オリジナルIME）で打って確定した**直後**に、推敲のキー（Ctrl+Alt+P）で範囲の窓
 * 「どこまで見ますか」が出るか（2026-11-15。⑤）。
 *
 * ノートPCの実機確認（2026-11-15）で、縦書きの原稿で打った直後に Ctrl+Alt+P を押すと、3回のうち1回、
 * 60秒何も出なかった。クリックしてから押す形・Playwright の変換の口で打った直後に押す形では、
 * 18回とも窓が出て再現しなかった。残っていたのが「本物の IME で打った直後」の形。
 *
 * 打って確定するところまでは本物の IME（OS のキー）で送る。**Ctrl+Alt+P は Playwright のキーで押す**
 * （IME の側の台本は Ctrl と1字までしか送れないため）。このキーは OS の日本語入力を通らずに画面へ届くので、
 * 作者の手と完全に同じではない。それでも「本物の IME の確定の直後に、焦点が原稿の面にあり、キーが届くか」は見られる。
 *
 * **流すのは作者がこの PC を使っていないときだけ**。門は `NOVELAI_REAL_IME=1`。AI は呼ばない（窓を閉じて止める）。
 */
import { expect, test } from "vitest";
import { composeText, openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { turnVertical, VERTICAL_LAUNCH } from "../support/verticalFace";
import { waitUntil } from "../support/wait";
import { waitForQuickPick } from "../support/workbenchDom";
import { REAL_IME_ENABLED, runRealImeTest } from "./support/imeBridge";

const EPISODE = "001_推敲.txt";
const BODY = "雨が上がった。\nそのとき言った。\n";
const RANGE_TITLE = "どこまで見ますか";

test.skipIf(!REAL_IME_ENABLED)("本物の IME：縦書きの原稿で打って確定した直後に Ctrl+Alt+P を押すと、推敲の範囲の窓が出る（3回）", async (ctx) => {
  await runRealImeTest(
    ctx,
    "縦書き 打った直後の推敲のキー",
    [{ name: EPISODE, text: BODY }],
    async (session, ime) => {
      await openEpisode(session.page, EPISODE, "そのとき");
      const frame = await turnVertical(session, "そのとき");
      for (let round = 1; round <= 3; round++) {
        await placeCaretAfter(frame, "そのとき");
        const before = (await composeText(frame)).length;
        await ime.type(frame, ["romaji:a", "key:ENTER"]);
        await waitUntil(async () => (await composeText(frame)).length > before, `${round}回目：打った字が画面に出る`, 15_000);
        // 確定の直後（クリックしない）に押す
        const pressedAt = Date.now();
        await session.page.keyboard.press("Control+Alt+KeyP");
        await waitForQuickPick(session.page, RANGE_TITLE, 20_000).catch((error: unknown) => {
          throw new Error(`${round}回目：打った直後の Ctrl+Alt+P で「${RANGE_TITLE}」が出ません（${String(error)}）`);
        });
        const shownMs = Date.now() - pressedAt;
        console.error(`[本物のIME] 推敲のキー ${round}回目：${shownMs}ms で窓が出た`);
        await ctx.annotate(`${round}回目：${shownMs}ms`, "推敲の範囲の窓");
        // AI は呼ばずに閉じる
        await session.page.keyboard.press("Escape");
        await waitUntil(
          async () => (await session.page.locator(".quick-input-widget").isVisible().catch(() => false)) === false,
          `${round}回目：窓が閉じる`,
          10_000
        );
        expect(shownMs, `${round}回目の窓が出るまでの時間`).toBeLessThan(20_000);
      }
    },
    VERTICAL_LAUNCH
  );
});
