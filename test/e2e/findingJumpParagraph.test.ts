/**
 * 指摘の場所から本文へ飛んだとき、**折り返した段落がまるごと見える**か
 * （画面の自動テスト、設計書6.113・6.25.11。作者の実機確認 2026-10-04）。
 *
 * 縦書きの組んで書く面で［本文へ］から飛ぶと、行は光るが、その段落が2列以上に
 * 折り返しているとき**2列目が左端で半分隠れた**（0.98.9）。飛ぶ道は F8・パネルの
 * 行・［本文へ］・提案パネルの行のどれも画面の revealLine 1つで受けるので、
 * ここでは提案パネルの場所の字を押す道で見る。転がす量の決め方そのものは
 * `test/unit/views/manuscriptRevealScroll.test.ts` が見張る。
 *
 * 何を見張るか：
 * 1. 縦書きで、段落の全体（すべての列）が本文の見えている枠の中に入る
 * 2. 横書きで、段落の全体（すべての行）が枠の中に入る（続きの行が下に切れない）
 */
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { caretPosition, composeText, manuscriptFrames, openEpisode } from "./support/manuscriptFrame";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame, writeSampleFinding } from "./support/sampleFinding";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_長い段落.txt";

/** 縦書きにするキー（findingJumpVertical.test.ts と同じ割り当て。使い捨ての keybindings.json） */
const OPEN_VERTICAL_KEY = "ctrl+alt+shift+v";
const OPEN_VERTICAL_PRESS = "Control+Alt+Shift+KeyV";

const LAUNCH = {
  keybindings: [...OPEN_PROPOSALS_LAUNCH.keybindings, { key: OPEN_VERTICAL_KEY, command: "novelai.openVertical" }],
};

/**
 * 指摘の段落。何列（何行）にも折り返すが、画面には収まる長さにする
 * （収まらない長さでは、頭の列を優先して続きは切れるのが正しい振る舞い）
 */
const TARGET_HEAD = "長い段落の始まりに以外な客が来た。";
const TARGET = TARGET_HEAD + "続く文が折り返して次の列へ流れていく。".repeat(8);
const TEXT = [
  ...Array.from({ length: 80 }, (_, index) => `前置きの${index + 1}行目、まだ何も起きない。`),
  TARGET,
  "段落のあとの行。",
  "おしまい。",
  "",
].join("\n");

async function frameShowing(page: Page, marker: string): Promise<Frame | undefined> {
  for (const frame of await manuscriptFrames(page)) {
    if ((await composeText(frame)).includes(marker)) return frame;
  }
  return undefined;
}

/** 指摘の段落（組んで書く面の行の入れ物）が、本文の見えている枠の中にまるごと入っているか */
async function paragraphInView(frame: Frame, head: string): Promise<boolean> {
  return frame.evaluate((needle) => {
    const compose = document.getElementById("compose");
    if (!compose) return false;
    const line = Array.from(compose.children).find((child) => (child.textContent ?? "").startsWith(needle));
    if (!line) return false;
    const rect = line.getBoundingClientRect();
    let node: HTMLElement | null = compose;
    let box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    while (node) {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden)/.test(style.overflow + style.overflowX + style.overflowY)) {
        box = {
          left: Math.max(box.left, r.left),
          top: Math.max(box.top, r.top),
          right: Math.min(box.right, r.right),
          bottom: Math.min(box.bottom, r.bottom),
        };
      }
      node = node.parentElement;
    }
    return rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
  }, head);
}

async function jumpToFinding(page: Page): Promise<void> {
  await clearNotifications(page);
  await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
  let found: Frame | undefined;
  await waitUntil(async () => {
    found = await proposalPanelFrame(page);
    return found !== undefined && (await found.locator('.location[data-action="jump"]').count()) >= 1;
  }, "提案パネルに指摘の場所が並ぶ", 15_000);
  if (!found) throw new Error("提案パネルが見つかりません");
  await found.locator('.location[data-action="jump"]').first().click();
}

async function waitCaretOnTarget(page: Page): Promise<Frame> {
  let frame: Frame | undefined;
  await waitUntil(async () => {
    frame = await frameShowing(page, "おしまい");
    return frame !== undefined && ((await caretPosition(frame))?.lineText ?? "").includes(TARGET_HEAD);
  }, "カーソルが指摘の段落に来る", 30_000);
  if (!frame) throw new Error("面が見つかりません");
  return frame;
}

const FINDING = { episode: EPISODE, text: TEXT, original: TARGET, target: "以外", suggestion: "意外", message: "「思いのほか」の意味なら「意外」です" };

test("縦書きで指摘の場所へ飛ぶと、折り返した段落のすべての列が見える", async () => {
  await withVsCode(
    "縦書きで長い段落へ飛ぶ",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, FINDING);
      await openEpisode(page, EPISODE, "おしまい");
      await pressWorkbenchKey(page, OPEN_VERTICAL_PRESS);
      await waitUntil(async () => {
        const frame = await frameShowing(page, "おしまい");
        return frame !== undefined
          ? frame.evaluate(() => getComputedStyle(document.getElementById("compose") as HTMLElement).writingMode.startsWith("vertical"))
          : false;
      }, "縦書きになる", 15_000);
      await jumpToFinding(page);
      const frame = await waitCaretOnTarget(page);
      await waitUntil(async () => await paragraphInView(frame, TARGET_HEAD), "段落のすべての列が見える所まで転がる", 5_000);
      expect(await paragraphInView(frame, TARGET_HEAD)).toBe(true);
    },
    LAUNCH
  );
});

test("横書きで指摘の場所へ飛ぶと、折り返した段落の続きの行が下に切れない", async () => {
  await withVsCode(
    "横書きで長い段落へ飛ぶ",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, FINDING);
      await openEpisode(page, EPISODE, "おしまい");
      await jumpToFinding(page);
      const frame = await waitCaretOnTarget(page);
      await waitUntil(async () => await paragraphInView(frame, TARGET_HEAD), "段落のすべての行が見える所まで転がる", 5_000);
      expect(await paragraphInView(frame, TARGET_HEAD)).toBe(true);
    },
    LAUNCH
  );
});
