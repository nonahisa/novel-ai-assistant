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
import { activeElementSummary, dismissWorkbenchHover, pressWorkbenchKey, startQuickInputWatch } from "./workbenchDom";

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

/**
 * 左の列の区画（作品一覧・簡単ステップメニュー・詳細メニュー・AIに相談）を、見出しを押して畳む。
 *
 * 0.111.7 から、横の「AIに相談」は初めて開くときに畳まずに出る（設計書6.6.3。作者の判断）。
 * まっさらなプロファイルで起こすテストでは、相談が左の列の下半分を取り、上の木の区画が数行まで
 * 低くなる。**木は見えている行しか DOM に描かない**ので、下のほうの行（「6. 編集部校正・校閲」
 * など）が現れないまま待ちで落ちた（2026-10-24）。木の行を押す件は、先にここで相談を畳む。
 *
 * `showSidebar` には入れない——横の相談の高さそのものを見る件があり、畳むと 0.111.7 が直した
 * 状態（畳んだ区画には initialSize が効かない）へ戻してしまうため
 */
export async function collapseSidebarPane(page: Page, title: string): Promise<void> {
  const header = page.locator(".pane-header", { hasText: title }).first();
  await header.waitFor({ state: "visible", timeout: 15_000 });
  const expanded = async () => (await header.getAttribute("aria-expanded")) === "true";
  if (!(await expanded())) return;
  await header.click();
  await waitUntil(async () => !(await expanded()), `左の列の「${title}」が畳まれる`, 5_000);
}

/**
 * 行の探し方。ふつうは名前（aria-label）の頭の文字列だけでよい。
 *
 * **頭が同じ行が2つあるときは、名前に含む語・含まない語で絞る。** 幕間.txt と閑話.txt は
 * どちらも種別が「幕間」なので、木の行の名前がどちらも「幕間」で始まる（episodeParser の
 * detectKind）。頭だけで選ぶと、並びが上の行を押す——Mac（2026-11-07）では閑話.txt が上に来て、
 * 幕間.txt のつもりで閑話.txt を右クリックしていた
 */
export type TreeRowTarget = string | { head: string; contains?: string; lacks?: string };

function quoteAttr(value: string): string {
  return value.replace(/"/g, '\\"');
}

/** 失敗の文に出す、行の探し方の言い方 */
export function treeRowName(target: TreeRowTarget): string {
  if (typeof target === "string") return target;
  return [
    target.head,
    target.contains ? `「${target.contains}」を含む` : "",
    target.lacks ? `「${target.lacks}」を含まない` : "",
  ]
    .filter((part) => part !== "")
    .join("・");
}

/** 名前（aria-label）が `head` で始まる行（`TreeRowTarget` の絞り込みも効く） */
export function treeRow(page: Page, target: TreeRowTarget): Locator {
  const spec = typeof target === "string" ? { head: target } : target;
  const selector = [
    `.monaco-list-row[aria-label^="${quoteAttr(spec.head)}"]`,
    spec.contains ? `[aria-label*="${quoteAttr(spec.contains)}"]` : "",
    spec.lacks ? `:not([aria-label*="${quoteAttr(spec.lacks)}"])` : "",
  ].join("");
  return page.locator(selector).first();
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
export async function treeContextMenu(page: Page, head: TreeRowTarget, item: string): Promise<void> {
  /*
    **前の確認の窓が閉じきるのを待つ。** Mac（1.141.0、2026-11-07）で、確認の窓を閉じた直後の右クリックが
    品書きの入れ物（`.context-view`）だけ出て中身（`.monaco-menu`）が組み上がらないまま止まった
    （品書きの数 {"contextView":1,"menu":0}）。窓が無ければすぐ抜ける
  */
  await page
    .locator(".monaco-dialog-box")
    .first()
    .waitFor({ state: "detached", timeout: 5_000 })
    .catch(() => undefined);
  // 前に出ていた吹き出しが品書きの上に残らないよう、先に払う（矢印は右クリックで行の上へ戻る）
  await dismissWorkbenchHover(page);
  /*
    **品書きが組み上がらなければ、閉じて右クリックし直す（3回まで）。** Windows では1回目で項目が出て
    すぐ抜けるので、道は変わらない。行の選び直しは左クリックでしない——話の行は左クリックで原稿が開き
    （workTree.ts の item.command）、タブと焦点が変わってテストの前提が崩れる。右クリックそのものが行を選ぶ
  */
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    await treeRow(page, head).click({ button: "right" });
    const shown = await waitUntil(
      async () => (await contextMenuLabels(page)).includes(item),
      `右クリックの品書きに「${item}」が出る`,
      attempt < attempts ? 5_000 : undefined
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    if (shown === undefined) break;
    if (attempt >= attempts) {
      throw new Error(
        `${String(shown)}（右クリックを${attempts}回試した／品書き：${(await contextMenuLabels(page)).join(" / ")}／${await contextMenuState(page, head)}）`
      );
    }
    // 「やり直したら通った」で黙らない。通ったときも、やり直しが要ったことと様子を出力に残す
    console.warn(`[treeContextMenu] 「${treeRowName(head)}」の品書きが組み上がらず、右クリックし直します（${attempt}回目／${await contextMenuState(page, head)}）`);
    // 組み上がらなかった品書きを閉じてから、もう一度右クリックする
    await page.keyboard.press("Escape");
    await waitUntil(
      async () => (await page.locator(".context-view .monaco-menu").count()) === 0,
      "組み上がらなかった右クリックの品書きが閉じる",
      3_000
    ).catch(() => undefined);
    await dismissWorkbenchHover(page);
  }
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
  // 押したあとの画面が出ないとき、「出ない」か「一度出て閉じた」かを落ちた文で分けるため
  await startQuickInputWatch(page);
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
      throw new Error(`右クリックの品書きで「${item}」を押しましたが閉じず、焦点は「${focused}」に載っています（${await contextMenuState(page, head)}）`);
    }
    await page.keyboard.press("Enter");
    await waitUntil(closed, `右クリックの品書きで「${item}」を選んで閉じる`, 5_000).catch(async (error: unknown) => {
      // Mac で5秒で止まった（2026-11-07）。押したあと Enter も送ったうえで閉じない様子を、次の1回で読めるように添える
      throw new Error(
        `${String(error)}（押したあと閉じず Enter も送った。Enter の前の焦点の行「${focused}」／` +
          `品書き：${(await contextMenuLabels(page)).join(" / ")}／${await contextMenuState(page, head)}）`
      );
    });
  });
}

/**
 * 右クリックの品書きまわりの様子（失敗の文に添える。2026-11-07 に Mac で品書きの件が止まったので足した）。
 * 品書きの枠（`.context-view`）と中身（`.monaco-menu`）の数、焦点の載った品書きの行、右クリックした行が
 * 選ばれた・焦点を持ったか、本体の焦点
 */
async function contextMenuState(page: Page, head: TreeRowTarget): Promise<string> {
  const counts = await page
    .evaluate(() => ({
      contextView: document.querySelectorAll(".context-view").length,
      menu: document.querySelectorAll(".context-view .monaco-menu").length,
      focusedItem: (document.querySelector(".context-view .action-item.focused .action-label")?.textContent ?? "").trim(),
    }))
    .catch((error: unknown) => String(error));
  const rowClass = await treeRow(page, head)
    .first()
    .getAttribute("class")
    .catch(() => null);
  const rowState = rowClass === null ? "行が無い" : ["selected", "focused"].filter((name) => rowClass.split(/\s+/).includes(name)).join("・") || "選ばれていない";
  return `品書きの数：${JSON.stringify(counts)}／右クリックした行「${treeRowName(head)}」：${rowState}／焦点：${await activeElementSummary(page)}／${process.platform}`;
}
