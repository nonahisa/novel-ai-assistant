/**
 * 原稿エディターの上でマウスの横のボタン（戻る・進む）を押すと、**押した時点で**前の話・
 * 次の話へ移る（2026-10-04。人物相関図と同じ形。設計書6.25.10）。
 *
 * 0.98.6 までは離したとき（mouseup）に受けていたが、作者の画面では mouseup が届かず、
 * 効いていない疑いがあった。VS Code 1.138 の本体も横のボタンは押した時点で動かし、
 * 離したときは止めるだけにしている。Playwright の mouse は左・右・中しか押せないので、
 * Chromium の入力の口（CDP の Input.dispatchMouseEvent、button "back"／"forward"）から押す。
 *
 * 見張ること：押しただけ（離す前）で隣の話へ移る。離しても、もう1話ぶんは動かない。
 */
import type { Frame } from "playwright-core";
import { test } from "vitest";
import { composeText, manuscriptFrames, openEpisode } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";

const EPISODES = [
  { name: "001_一話.txt", text: "一話の本文。\n" },
  { name: "002_二話.txt", text: "二話の本文。\n" },
  { name: "003_三話.txt", text: "三話の本文。\n" },
];

async function sendMouseSide(
  session: E2ESession,
  frame: Frame,
  side: "back" | "forward",
  phase: "mousePressed" | "mouseReleased"
): Promise<void> {
  const box = await frame.locator("#compose").boundingBox();
  if (!box) throw new Error("本文の場所が測れません");
  const x = Math.round(box.x + 40);
  const y = Math.round(box.y + 40);
  const cdp = await session.page.context().newCDPSession(session.page);
  try {
    if (phase === "mousePressed") {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    }
    const buttons = phase === "mousePressed" ? (side === "back" ? 8 : 16) : 0;
    await cdp.send("Input.dispatchMouseEvent", { type: phase, x, y, button: side, buttons, clickCount: 1 });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * 本文に `marker` を描いた、**前に出ている**原稿エディターの面（無ければ undefined）。
 * 隣の話へ移ったあとも前の話のタブが裏に残ることがあるので、見えているものだけを数える
 */
async function frameShowing(session: E2ESession, marker: string): Promise<Frame | undefined> {
  for (const frame of await manuscriptFrames(session.page)) {
    const shown = await frame.evaluate(() => document.visibilityState === "visible").catch(() => false);
    if (shown && (await composeText(frame).catch(() => "")).includes(marker)) return frame;
  }
  return undefined;
}

test("原稿エディターの上でマウスの戻るボタンを押しただけで前の話へ移り、離しても2話ぶんは動かず、進むボタンで戻る", async () => {
  await withVsCode("原稿エディターのマウスの横のボタン", EPISODES, async (session) => {
    const third = await openEpisode(session.page, "003_三話.txt", "三話の本文");

    // 押しただけ（離す前）で前の話へ
    await sendMouseSide(session, third, "back", "mousePressed");
    await waitUntil(
      async () =>
        (await frameShowing(session, "二話の本文")) !== undefined &&
        (await frameShowing(session, "三話の本文")) === undefined,
      "押しただけで二話へ移る"
    );
    const second = await frameShowing(session, "二話の本文");
    if (!second) throw new Error("二話の面が見つかりません");
    await sendMouseSide(session, second, "back", "mouseReleased");
    // 離しても、もう1話ぶん（一話）へは動かない
    await holdsFor(async () => (await frameShowing(session, "一話の本文")) === undefined, "離しても一話へ動かない", 1_500);

    // 進むボタンで三話へ戻る
    await sendMouseSide(session, second, "forward", "mousePressed");
    await waitUntil(
      async () =>
        (await frameShowing(session, "三話の本文")) !== undefined &&
        (await frameShowing(session, "二話の本文")) === undefined,
      "進むボタンを押しただけで三話へ移る"
    );
    const back = await frameShowing(session, "三話の本文");
    if (back) await sendMouseSide(session, back, "forward", "mouseReleased");
  });
});
