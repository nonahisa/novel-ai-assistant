/**
 * メニューの名前と、指を載せたときの説明（画面の自動テスト、設計書6.113。実機確認リストの仕分け
 * 2026-10-12 の束 E10 のうち 181・235 行を移したもの。作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 1. 原稿エディターの右クリックの「コピー（投稿サイト用）」に指を載せると、
 *    「選んだ範囲（選んでいなければこの話ぜんぶ）を…」の説明が出る（181 行。4か所の名前は
 *    写真と `commandNames.test.ts`・`manuscriptEditor.test.ts` で確かめ済み。残っていたのは説明だけ）。
 *    吹き出しそのものはブラウザが描くもので DOM に出ないので、確かめるのは項目の `title` の字と、
 *    項目が何にも覆われず指を載せられること
 * 2. 左の列のメニューに「校正・メモパネル」の名前で出る（235 行。パレット・キーの画面・パネルの
 *    タブ・右クリックは `commandNames.test.ts` と校正・メモパネルの各件で確かめ済み。残っていたのは
 *    サイドバーのメニュー）。**この操作は詳細メニューには出さない**（`actionTree.ts` の
 *    `hiddenFromActionList`。作者の裁定 2026-09-23 問5 A）ので、出る所は簡単ステップメニューの
 *    「3. 作品執筆 › 執筆の場」。あわせて、旧称「シーンメモ」の名前がどの行にも残っていないことを見る
 *
 * **AI は呼ばない。**
 */
import { expect, test } from "vitest";
import { findAction } from "../../src/core/actionTree";
import { openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { scrollTreeUntilRow, showSidebar, SIDEBAR_LAUNCH, treeRow, treeRowLabels } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.txt";
const COPY_FOR_POSTING = "コピー（投稿サイト用）";
const COPY_FOR_POSTING_TITLE = "選んだ範囲（選んでいなければこの話ぜんぶ）を、投稿サイトの記法に直してコピーします";

test("原稿エディターの右クリックの「コピー（投稿サイト用）」に指を載せると、選んだ範囲（選んでいなければこの話ぜんぶ）を写す説明が出る", async () => {
  await withVsCode("右クリックの説明", [{ name: EPISODE, text: "右クリックを試す行。\n" }], async (session) => {
    const frame = await openEpisode(session.page, EPISODE, "右クリックを試す行");
    await placeCaretAfter(frame, "右クリック");
    await frame.locator("#compose").click({ button: "right" });
    const menu = frame.locator("#menu");
    await waitUntil(async () => ((await menu.innerText().catch(() => "")) ?? "").length > 0, "右クリックの品書きが出る");

    const item = menu.locator(".item", { hasText: COPY_FOR_POSTING }).first();
    await waitUntil(async () => (await item.count()) > 0, `品書きに「${COPY_FOR_POSTING}」が出る`, 5_000).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（品書き：${(await menu.innerText().catch(() => "")).split("\n").join(" / ")}）`);
    });
    expect(await item.getAttribute("title"), "「コピー（投稿サイト用）」に指を載せたときの説明").toBe(COPY_FOR_POSTING_TITLE);

    // 指を載せられる（項目が何にも覆われていない）。覆われていると説明が出ない
    await item.hover();
    const covering = await item.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top === element || element.contains(top) ? "" : `${top?.tagName ?? "なし"}.${String(top?.className ?? "")}`;
    });
    expect(covering, `「${COPY_FOR_POSTING}」の上に別のものが重なっています：${covering}`).toBe("");
  });
});

test("左の列の簡単ステップメニュー「3. 作品執筆 › 執筆の場」に「校正・メモパネル」の名前で出て、旧称は残っていない", async () => {
  const expected = findAction("novelai.openSceneMemos")?.label;
  if (!expected) throw new Error("actionTree に novelai.openSceneMemos がありません");
  expect(expected.startsWith("校正・メモパネル"), `メニューの名前：${expected}`).toBe(true);

  await withVsCode(
    "左の列の校正・メモパネル",
    [{ name: EPISODE, text: "一行目の文。\n" }],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);

      const step = treeRow(page, "3. 作品執筆");
      await waitUntil(async () => (await step.count()) > 0, "簡単ステップメニューに「3. 作品執筆」が出る").catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
      });
      await step.scrollIntoViewIfNeeded();
      if ((await step.getAttribute("aria-expanded")) !== "true") await step.click();
      await waitUntil(async () => (await step.getAttribute("aria-expanded")) === "true", "「3. 作品執筆」が開く");

      // 狭い窓では開いた段の下のほうが描かれない（仮想化）ので、下へ送って出す
      const section = await scrollTreeUntilRow(page, "3. 作品執筆", "執筆の場");
      if ((await section.getAttribute("aria-expanded")) !== "true") await section.click();
      await waitUntil(async () => (await section.getAttribute("aria-expanded")) === "true", "「執筆の場」が開く");
      const row = await scrollTreeUntilRow(page, "3. 作品執筆", expected);
      const label = (await row.getAttribute("aria-label")) ?? "";
      expect(label.startsWith(expected), `行の名前：${label}`).toBe(true);

      // 旧称（シーンメモ一覧など）の名前の行が、見えている左の列のどこにも無い
      const stale = (await treeRowLabels(page)).filter((name) => name.includes("シーンメモ"));
      expect(stale, `旧称のままの行：${JSON.stringify(stale)}`).toEqual([]);
    },
    SIDEBAR_LAUNCH
  );
});
