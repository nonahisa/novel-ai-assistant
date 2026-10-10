/**
 * 左の「統合小説執筆環境」の列（作品一覧・簡単ステップメニュー・詳細メニュー）を
 * 押す（設計書6.113）。
 *
 * - 行は**読み上げ用の名前（aria-label）の頭で探す**。名前と添え書き（「3ファイル /
 *   12字」）は画面では別の字の並びに分かれていて、見えている字の連なりでは探しにくい
 * - **右クリックの品書きを読めるように、品書きを VS Code の中に描かせる**
 *   （`window.menuStyle: "custom"`。`SIDEBAR_LAUNCH` に入れてある）。既定の Windows では
 *   OS のメニューになり、Playwright から読めないうえ、作者の画面の前面に出る
 *
 * VS Code 本体の DOM に頼るのは `quickInput.ts` と同じく、ここに閉じ込める。
 * 確かめた版：1.138.0（2026-10-04）。1.141.0 は**未実行**——頼っているクラス名
 * （`.context-view`・`.monaco-menu`・`.action-label`・`.monaco-list-row`）が 1.141.0 の配布物の
 * `workbench.desktop.main.js` にも残っていることだけを確かめた（2026-10-10）。
 */
import type { Locator, Page } from "playwright-core";
import { waitUntil } from "./wait";
import { dismissWorkbenchHover, pressWorkbenchKey } from "./workbenchDom";

/**
 * 左の列を出すキー（使い捨ての keybindings.json に書く）。F1〜F12 は埋まったので、
 * 文字キーとの組にする（製品の package.json にも VS Code の既定にも無い組）
 */
export const SHOW_SIDEBAR_KEY = "ctrl+alt+shift+j";
const SHOW_SIDEBAR_PRESS = "Control+Alt+Shift+KeyJ";

/** 左の列を使う件が `withVsCode` の起こし方へ渡すもの */
export const SIDEBAR_LAUNCH = {
  settings: {
    "window.menuStyle": "custom",
    /*
      **行の吹き出し（作品・話の紹介）を出さない。** 右クリックで品書きが出るのを待つあいだ、矢印は
      行の上に止まったままになり、既定の 500ms で吹き出しが出る。吹き出しも品書きも矢印の下へ開くので、
      品書きの行の上に重なりうる（`treeContextMenu`）。左の列の件で吹き出しの中身を見るものは無い
    */
    "workbench.hover.delay": 600_000,
  } as Record<string, unknown>,
  keybindings: [{ key: SHOW_SIDEBAR_KEY, command: "workbench.view.extension.novelai" }] as Record<string, unknown>[],
};

/** 左の列（統合小説執筆環境）を出し、作品一覧に作品の行が出るまで待つ */
export async function showSidebar(page: Page, workTitle: string): Promise<void> {
  // WebView を開いたあとでも本体のキー割り当てに届くよう、焦点を本体へ戻してから押す
  await pressWorkbenchKey(page, SHOW_SIDEBAR_PRESS);
  await waitUntil(async () => (await treeRow(page, workTitle).count()) > 0, `作品一覧に「${workTitle}」の行が出る`);
}

/** 名前（aria-label）が `head` で始まる行 */
export function treeRow(page: Page, head: string): Locator {
  return page.locator(`.monaco-list-row[aria-label^="${head.replace(/"/g, '\\"')}"]`).first();
}

/** 名前（aria-label）が `head` で始まる行の、読み上げ用の名前全体（添え書きを含む） */
export async function treeRowLabel(page: Page, head: string): Promise<string> {
  const row = treeRow(page, head);
  if ((await row.count()) === 0) return "";
  return (await row.getAttribute("aria-label")) ?? "";
}

/** 左の列に並んでいる行の名前（上から） */
export async function treeRowLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".monaco-list-row")).map((row) => row.getAttribute("aria-label") ?? "")
  );
}

/**
 * 名前が `head` で始まる行が DOM に現れるまで、`anchorHead` の行の上でホイールを回して
 * 下へ送る（見つからなければ時間切れで落とす）。
 *
 * **VS Code の木は見えている行しか DOM に描かない**（仮想化）。窓が狭いと、開いた段の
 * 下のほうの行は描かれず、`treeRow` では見つからない（2026-10-10、ノートPCの 1.141.0 で
 * 「4. 自己校正」の中が「プロット逸脱検知」までしか出ず、「伏線手動追加」が見えなかった。
 * こちらの機械でも `NOVELAI_E2E_WINDOW=1024x640` で同じ形に落ちた）。
 * キーの↓は選んだ行を動かすだけだが、押す行を取り違えないよう、選びを動かさないホイールで送る
 */
export async function scrollTreeUntilRow(page: Page, anchorHead: string, head: string, timeoutMs = 30_000): Promise<Locator> {
  const target = treeRow(page, head);
  /*
    回すのは `anchorHead` の行がある区画（簡単ステップメニューなど）の真ん中。行そのものの上で
    回すと、送ったあとに上へ貼り付く見出し（sticky scroll。同じ名前の行が2つになる）の上で
    回すことになり、1.141.0 ではそこから先へ送れなかった（2026-10-10）
  */
  const pane = page.locator(".pane-body").filter({ has: treeRow(page, anchorHead) }).first();
  const deadline = Date.now() + timeoutMs;
  while ((await target.count()) === 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `「${head}」の行が出るまで左の列を下へ送りましたが、出ません（いまの行：${(await treeRowLabels(page)).join(" / ")}）`
      );
    }
    const box = await pane.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
      await page.mouse.wheel(0, 120);
    }
    await page.waitForTimeout(200);
  }
  return target;
}

/**
 * 左の列の行が落ち着くまで待つ（行の名前の並びが `quietMs` のあいだ変わらず、
 * 「読み込み中」「前回の値」の行が無い）。
 *
 * 作品一覧は、控えを先に出してから裏で走査し直し、git の記録待ちの数が分かると描き直す
 * （設計書6.107・5.5.17）。描き直しの最中に右クリックの品書きを押すと、品書きが指していた
 * 行がもう無く、命令に行が渡らずに黙って終わることがある。押す前にここで待つ
 */
export async function waitTreeSettled(page: Page, quietMs = 2_000, timeoutMs = 30_000): Promise<void> {
  let last = "";
  let since = Date.now();
  await waitUntil(
    async () => {
      const labels = await treeRowLabels(page);
      const now = labels.join("\n");
      if (now !== last || labels.some((label) => label.includes("読み込み中") || label.includes("前回の値"))) {
        last = now;
        since = Date.now();
        return false;
      }
      return Date.now() - since >= quietMs;
    },
    "左の列の行が落ち着く",
    timeoutMs
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
  });
}

/** 作品の行を開く（畳まれていれば押して開く） */
export async function expandTreeRow(page: Page, head: string): Promise<void> {
  const row = treeRow(page, head);
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await row.click();
  await waitUntil(async () => (await row.getAttribute("aria-expanded")) === "true", `「${head}」の行が開く`);
}

/** 右クリックの品書き（VS Code の中に描いたもの）の名前 */
export async function contextMenuLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".context-view .action-label"))
      .map((item) => (item.textContent ?? "").trim())
      .filter((text) => text !== "")
  );
}

/** 行を右クリックし、品書きの `item` を押す */
export async function treeContextMenu(page: Page, head: string, item: string): Promise<void> {
  // 前に出ていた吹き出しが品書きの上に残らないよう、先に払う（矢印は右クリックで行の上へ戻る）
  await dismissWorkbenchHover(page);
  await treeRow(page, head).click({ button: "right" });
  await waitUntil(async () => (await contextMenuLabels(page)).includes(item), `右クリックの品書きに「${item}」が出る`).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（品書き：${(await contextMenuLabels(page)).join(" / ")}）`);
    }
  );
  const entry = page.locator(".context-view .action-label", { hasText: item }).first();
  /*
    **押す前に、品書きの行がいちばん上に出ているかを確かめる。** 吹き出しなどが重なっていると、
    押したつもりが重なったほうに当たり、品書きだけが閉じて何も起きない形になりうる（2026-10-11
    ノートPCの `episodeInsertRenameCommit` が、品書きは閉じたのに入力欄が出ない形で落ちた）。
    重なっていたら黙って押さずに、上に何があるかを名乗って落とす
  */
  const covering = await entry.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!top || element.contains(top) || top.contains(element)) return undefined;
    const row = element.closest(".action-item");
    if (row && row.contains(top)) return undefined;
    return `${top.tagName.toLowerCase()}.${String(top.className)}「${(top.textContent ?? "").trim().slice(0, 30)}」`;
  });
  if (covering) throw new Error(`右クリックの品書きの「${item}」の上に別のものが重なっています：${covering}`);
  await entry.click();
  /*
    **押しても品書きが閉じないことがある**（2026-10-04、作品の行の右クリックで踏んだ。
    行は選ばれた色になるが、押したことにならない）。押した行には焦点が載っているので、
    閉じていなければ Enter で選び直す
  */
  const closed = async () => (await page.locator(".context-view .monaco-menu").count()) === 0;
  await waitUntil(closed, "右クリックの品書きが閉じる", 2_000).catch(async () => {
    // 焦点の載った行が目当てと違えば、Enter で別の命令を走らせてしまう。名乗って止める
    const focused = await page.evaluate(() =>
      (document.querySelector(".context-view .action-item.focused .action-label")?.textContent ?? "").trim()
    );
    if (focused !== "" && !focused.includes(item)) {
      throw new Error(`右クリックの品書きで「${item}」を押しましたが閉じず、焦点は「${focused}」に載っています`);
    }
    await page.keyboard.press("Enter");
    await waitUntil(closed, `右クリックの品書きで「${item}」を選んで閉じる`, 5_000);
  });
}
