/**
 * 原稿エディターの上でマウスの横のボタン（戻る・進む）を押すと、**押した時点で**前の話・
 * 次の話へ移る（2026-10-04。人物相関図と同じ形。設計書6.25.5）。
 *
 * 0.98.6 までは離したとき（mouseup）に受けていたが、作者の画面では mouseup が届かず、
 * 効いていない疑いがあった。VS Code 1.138 の本体も横のボタンは押した時点で動かし、
 * 離したときは止めるだけにしている。Playwright の mouse は左・右・中しか押せないので、
 * Chromium の入力の口（CDP の Input.dispatchMouseEvent、button "back"／"forward"）から押す。
 *
 * 見張ること：押しただけ（離す前）で隣の話へ移る。離しても、もう1話ぶんは動かない。
 *
 * **どの話が前に出ているかは、本体のタブで見る**（2026-10-04 に改めた）。最初は WebView の
 * 中の `document.visibilityState` で「見えている面」を探していたが、裏に回ったタブの WebView も
 * "visible" のまま（隠れるのは器の表示だけで、内側の文書の見え方は変わらない）で、
 * ノートPCで6回とも「二話へ移らない」と誤って落ちた。
 */
import type { Frame } from "playwright-core";
import { test } from "vitest";
import { composeText, manuscriptFrames, openEpisode } from "./support/manuscriptFrame";
import { activeTabNames, editorGroupTabs } from "./support/workbenchDom";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";

const EPISODES = [
  { name: "001_一話.txt", text: "一話の本文。\n" },
  { name: "002_二話.txt", text: "二話の本文。\n" },
  { name: "003_三話.txt", text: "三話の本文。\n" },
];

/** 本文の上の押す点（ページの座標）。隣の話へ移っても同じ列の同じ所に本文がある */
async function pointOn(frame: Frame): Promise<{ x: number; y: number }> {
  const box = await frame.locator("#compose").boundingBox();
  if (!box) throw new Error("本文の場所が測れません");
  return { x: Math.round(box.x + 40), y: Math.round(box.y + 40) };
}

async function sendMouseSide(
  session: E2ESession,
  point: { x: number; y: number },
  side: "back" | "forward",
  phase: "mousePressed" | "mouseReleased"
): Promise<void> {
  const { x, y } = point;
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

/** 前に出ているタブ（どの列でも）が `name` か */
async function frontIs(session: E2ESession, name: string): Promise<boolean> {
  return (await activeTabNames(session.page)).includes(name);
}

/** 本文に `marker` を描いた原稿エディターの面 */
async function frameWith(session: E2ESession, marker: string): Promise<Frame> {
  let found: Frame | undefined;
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(session.page)) {
        if ((await composeText(frame).catch(() => "")).includes(marker)) {
          found = frame;
          return true;
        }
      }
      return false;
    },
    `「${marker}」の面が描かれる`
  );
  if (!found) throw new Error(`「${marker}」の面が見つかりません`);
  return found;
}

test("原稿エディターの上でマウスの戻るボタンを押しただけで前の話へ移り、離しても2話ぶんは動かず、進むボタンで戻る", async () => {
  await withVsCode("原稿エディターのマウスの横のボタン", EPISODES, async (session) => {
    const third = await openEpisode(session.page, "003_三話.txt", "三話の本文");
    const report = async () => `（タブ：${JSON.stringify(await editorGroupTabs(session.page))}／前：${JSON.stringify(await activeTabNames(session.page))}）`;

    const point = await pointOn(third);
    // 押しただけ（離す前）で前の話へ
    await sendMouseSide(session, point, "back", "mousePressed");
    await waitUntil(() => frontIs(session, "002_二話.txt"), "押しただけで二話が前に出る").catch(async (error: unknown) => {
      throw new Error(`${String(error)}${await report()}`);
    });
    await sendMouseSide(session, point, "back", "mouseReleased");
    // 離しても、もう1話ぶん（一話）へは動かない
    await holdsFor(
      async () => (await frontIs(session, "002_二話.txt")) && !(await frontIs(session, "001_一話.txt")),
      "離しても二話のまま（一話へ動かない）",
      1_500
    );

    // 進むボタンで三話へ戻る
    const secondPoint = await pointOn(await frameWith(session, "二話の本文"));
    await sendMouseSide(session, secondPoint, "forward", "mousePressed");
    await waitUntil(() => frontIs(session, "003_三話.txt"), "進むボタンを押しただけで三話が前に出る").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}${await report()}`);
      }
    );
    await sendMouseSide(session, secondPoint, "forward", "mouseReleased");
  });
});
