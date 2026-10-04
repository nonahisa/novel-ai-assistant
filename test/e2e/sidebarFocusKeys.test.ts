/**
 * 左の列（作品一覧）や検索の欄に焦点があるときは、原稿エディターのキー（Ctrl+Alt+T）が
 * 効かない（画面の自動テスト、設計書6.25.10・6.113）。
 *
 * 0.96.18 で、原稿エディターのキー割り当ての `when` に
 * `!sideBarFocus && !auxiliaryBarFocus && !panelFocus && !inputFocus && !terminalFocus`
 * を足した。作者の実機（2026-10-04、0.98.6）で「作品一覧を押して焦点を移し、Ctrl+Alt+T を
 * 押したら誤字脱字が走った」と報告があり、その調べとして書いた。
 *
 * **キーは本物の焦点のまま押す**（`pressWorkbenchKey` を使わない）。見たいのは焦点の
 * 状態そのものなので、焦点を本体へ戻してから押すと確かめたことにならない。
 *
 * **AI は呼ばない。** AI を設定していない状態で起こすので、Ctrl+Alt+T が走れば
 * 「AIがまだ設定されていません」の知らせで止まる。その知らせ（と、確認の窓・選ぶ画面）が
 * 「走った」の印になる。
 *
 * 調べで分かったこと（2026-10-04、1.138.0）：
 * - 作品の行を押すと、焦点は左の列の木（`workbench.parts.sidebar` の `.monaco-list`）に載り、
 *   Ctrl+Alt+T は効かない。`when` の無い対照のキーは同じ焦点から届く——「キーが本体に
 *   届かなかった」のではなく「`when` が止めた」
 * - **話の行を押すと、その話が原稿エディターで開き（既に開いていれば前に出て）、焦点が
 *   原稿エディター（WebView の iframe）へ移る**。行は選ばれた色のまま残るので、見た目は
 *   「左の列を押した」ままだが、焦点は原稿にある。そこで押した Ctrl+Alt+T は `when` が
 *   真で、誤字脱字が走る。開き方（焦点を移すか残すか）は判断待ちなので、この件では
 *   どちらにも決めつけない（下の `test.todo`）
 */
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { openEpisode } from "./support/manuscriptFrame";
import { expandTreeRow, showSidebar, SIDEBAR_LAUNCH, treeRowLabels } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { closeDialog, dialogText, quickPickTitle } from "./support/workbenchDom";

const EPISODES = [
  { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
  { name: "第2話_つづき.txt", text: "二話の本文。\n" },
];

/**
 * `when` の無い対照のキー（使い捨ての keybindings.json に足す）。押すと「版を表示」の
 * 確認の窓が出る。製品の package.json にも、ほかの件にも無い組
 */
const CONTROL_KEY = "ctrl+alt+shift+u";
const CONTROL_PRESS = "Control+Alt+Shift+KeyU";

/** 誤字脱字を when なしで呼ぶ対照のキー（検出器が「走った」を拾えるかを見る。AI は未設定なので呼ばれない） */
const TYPO_CONTROL_KEY = "ctrl+alt+shift+i";
const TYPO_CONTROL_PRESS = "Control+Alt+Shift+KeyI";

/** 焦点の在り処（要素と、それが入っている本体の部品） */
async function focusWhere(page: Page): Promise<{ element: string; part: string }> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      element: active ? `${active.tagName}.${String(active.className).slice(0, 60)}` : "なし",
      part: active?.closest(".part")?.id ?? "（部品の外）",
    };
  });
}

/**
 * 誤字脱字が走った印。AI が未設定なので「AIがまだ設定されていません」の知らせで止まる。
 * AI が選ばれていれば確認の窓、作品が引けなければ選ぶ画面になるので、それも数える
 */
async function typoCheckStarted(page: Page): Promise<string | undefined> {
  const toasts = await page.locator(".notification-toast").allInnerTexts();
  const aiToast = toasts.find((text) => text.includes("AIがまだ設定されていません"));
  if (aiToast) return `知らせ：${aiToast}`;
  const dialog = await dialogText(page);
  if (dialog) return `確認の窓：${dialog}`;
  const pick = await quickPickTitle(page);
  if (pick) return `選ぶ画面：${pick}`;
  return undefined;
}

/** Ctrl+Alt+T を押しても、走った印が3秒出ないこと */
async function expectTypoKeyIgnored(page: Page, where: string): Promise<void> {
  await page.keyboard.press("Control+Alt+KeyT");
  let seen: string | undefined;
  await holdsFor(
    async () => (seen = await typoCheckStarted(page)) === undefined,
    `${where}で Ctrl+Alt+T を押しても誤字脱字が走らない`,
    3_000
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}（出たもの：${seen}）`);
  });
}

test("作品一覧の作品の行・検索の欄に焦点があると Ctrl+Alt+T は効かず、when の無いキーは同じ焦点から届く", async () => {
  await withVsCode(
    "左の列の焦点とキー",
    EPISODES,
    async (session) => {
      const { page } = session;
      // 原稿エディターを前面にしておく（activeCustomEditorId が原稿のまま、焦点だけが外にある形）
      await openEpisode(page, EPISODES[0].name, "一話の本文");
      await showSidebar(page, E2E_WORK_TITLE);

      // ── 作品の行：押すと焦点は左の列の木に載る ──
      await expandTreeRow(page, E2E_WORK_TITLE);
      await waitUntil(async () => (await treeRowLabels(page)).some((label) => label.startsWith("第2話")), "作品の下に話が並ぶ");
      const focus = await focusWhere(page);
      expect(focus.part, `焦点：${JSON.stringify(focus)}`).toBe("workbench.parts.sidebar");
      await expectTypoKeyIgnored(page, "作品の行");

      // 対照：同じ焦点から、when の無いキーは本体に届く（「届かなかった」のでなく「when が止めた」）
      await page.keyboard.press(CONTROL_PRESS);
      await waitUntil(async () => (await dialogText(page))?.includes("統合小説執筆環境") === true, "対照のキーで版の窓が出る", 10_000);
      await closeDialog(page);

      // ── 検索の欄（inputFocus）：本体の「検索」を開くと焦点が入力欄に載る ──
      await page.keyboard.press("Control+Shift+KeyF");
      await waitUntil(
        async () => (await focusWhere(page)).element.startsWith("TEXTAREA") || (await focusWhere(page)).element.startsWith("INPUT"),
        "検索の欄に焦点が載る",
        10_000
      );
      await expectTypoKeyIgnored(page, "検索の欄");

      // 検出器の対照：when の無いキーで誤字脱字を呼べば「走った印」が拾えること。
      // 拾えないまま（知らせの DOM の名前が版で変わるなど）だと、上の「走らない」は何も見ずに通る
      await page.keyboard.press(TYPO_CONTROL_PRESS);
      await waitUntil(async () => (await typoCheckStarted(page)) !== undefined, "when の無いキーで誤字脱字を呼ぶと、走った印が出る", 10_000);
    },
    {
      ...SIDEBAR_LAUNCH,
      settings: { ...SIDEBAR_LAUNCH.settings, "window.dialogStyle": "custom" },
      keybindings: [
        ...SIDEBAR_LAUNCH.keybindings,
        { key: CONTROL_KEY, command: "novelai.showVersion" },
        // 引数は製品のキーと同じ印（前面の原稿の話で走らせる）。引数なしでは何も出さずに戻った
        { key: TYPO_CONTROL_KEY, command: "novelai.checkTyposForFile", args: { source: "manuscriptEditor" } },
      ],
    }
  );
});

/*
  話の行を押した直後は、焦点が原稿エディターへ移るので Ctrl+Alt+T が効く（2026-10-04 の調べ。
  冒頭のコメント）。「話を押して、そのまま打ち始められる」いまの開き方を残すか、
  VS Code のエクスプローラーの1クリックと同じく焦点を左の列に残すかは判断待ち。
  決まったら、その形をここで見張る
*/
test.todo("話の行を押した直後の焦点の在り処と Ctrl+Alt+T（開き方の判断待ち）");
