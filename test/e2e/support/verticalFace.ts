/**
 * 開いている原稿エディターを縦書きの入口へ替える（画面の自動テスト、設計書6.113）。
 *
 * 「縦書き表示」（`novelai.openVertical`）は同じタブを縦書きの面へ替える（0.96.10）。
 * 面は作り直されるので、縦書きになった面を探し直して返す。キーは使い捨ての
 * keybindings.json に足す（`VERTICAL_LAUNCH` を `withVsCode` の起こし方へ渡す）。
 */
import type { Frame } from "playwright-core";
import { composeText, manuscriptFrames } from "./manuscriptFrame";
import type { E2ESession } from "./vscodeApp";
import { waitUntil } from "./wait";
import { pressWorkbenchKey } from "./workbenchDom";

/** 縦書きにするキー（`findingJumpVertical.test.ts` と同じ組。起こすたびに別の keybindings.json） */
const OPEN_VERTICAL_KEY = "ctrl+alt+shift+v";
const OPEN_VERTICAL_PRESS = "Control+Alt+Shift+KeyV";

export const VERTICAL_LAUNCH = {
  keybindings: [{ key: OPEN_VERTICAL_KEY, command: "novelai.openVertical" }],
};

/** 面が縦書きで組まれているか */
export async function isVerticalFace(frame: Frame): Promise<boolean> {
  return frame
    .evaluate(() => {
      const compose = document.getElementById("compose");
      return compose ? getComputedStyle(compose).writingMode.startsWith("vertical") : false;
    })
    .catch(() => false);
}

/**
 * 前に出ている原稿エディターを縦書きにし、縦書きで `marker` を描いた面を返す
 * （`VERTICAL_LAUNCH` を渡して起こしたときだけ使える）
 */
export async function turnVertical(session: E2ESession, marker: string): Promise<Frame> {
  await pressWorkbenchKey(session.page, OPEN_VERTICAL_PRESS);
  let found: Frame | undefined;
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(session.page)) {
        if ((await isVerticalFace(frame)) && (await composeText(frame).catch(() => "")).includes(marker)) {
          found = frame;
          return true;
        }
      }
      return false;
    },
    "原稿エディターが縦書きになる",
    15_000
  );
  if (!found) throw new Error("縦書きの面が見つかりません");
  return found;
}
