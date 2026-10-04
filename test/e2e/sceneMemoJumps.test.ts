/**
 * メモ（`//` の付箋）の足し方・飛び方・済ませ方（画面の自動テスト、設計書6.113・6.40。
 * 実機確認リスト F-45 を 2026-10-04 に移した）。
 *
 * 何を見張るか：
 * - 本文の右クリック「メモ追加」で、カーソルのある行の**上**に `// ` の行が入る
 * - 校正・メモパネルの［済み］で、**閉じている話**はファイルからその行が消え、
 *   **開いている話**は画面の本文から消えて（未保存）、どちらも上の帯の［戻す］で
 *   戻せる（戻すほうは2件目。作者の裁定 2026-10-04）
 * - パネルの［次へ →］［← 戻る］が話をまたいで飛び（メモの無い話は飛ばす）、
 *   末尾の次は先頭へ、先頭の前は末尾へ回る
 * - 本文のカーソルを動かすと、パネルでいちばん近いメモの行が光る（`.memo.active`）
 *
 * 行を消す条件（読み込み時の行と違えば消さない・CRLF でも改行を保つ）と、次・前の
 * 順番の決め方は単体テスト `sceneMemo.test.ts` が見ている。ここで見るのは、押したら
 * 画面とファイルがそのとおりに動くこと。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import {
  caretPosition,
  composeText,
  manuscriptFrames,
  memoPanelFrame,
  openEpisode,
  placeCaretAfter,
} from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { activeTabNames, tabIsDirty } from "./support/workbenchDom";

const EP1 = "001_いち.txt";
const EP2 = "002_に.txt";
const EP3 = "003_さん.txt";

async function fileText(session: E2ESession, name: string): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, name), "utf8")).replace(/\r\n/g, "\n");
}

/** 本文に `marker` を含む原稿エディターの面（無ければ undefined） */
async function frameShowing(page: Page, marker: string): Promise<Frame | undefined> {
  for (const frame of await manuscriptFrames(page)) {
    if ((await composeText(frame)).includes(marker)) return frame;
  }
  return undefined;
}

/** いま前に出ている原稿のカーソルの行の字（どの話の面でも） */
async function caretLineAnywhere(page: Page): Promise<string> {
  const active = (await activeTabNames(page))[0] ?? "";
  for (const frame of await manuscriptFrames(page)) {
    const text = await composeText(frame);
    // 前に出ている話の面だけを見る（裏の面にも古いカーソルが残っている）
    if (active === EP1 && !text.includes("一の一行目")) continue;
    if (active === EP3 && !text.includes("三の一行目")) continue;
    const caret = await caretPosition(frame);
    if (caret) return caret.lineText;
  }
  return "";
}

/**
 * 飛んだ先のカーソルの行が、拡張機能へ届くのを待つ。
 *
 * 原稿エディターはカーソルの行を**200ミリ秒まとめてから**知らせる（打鍵のたびに
 * 送らないため。`manuscriptEditorHtml.ts` の notifyCaret）。パネルの［次へ］は
 * その知らせを起点にするので、機械の速さで続けて押すと、前の位置から数え直して
 * しまう。**新しく開いた話の面からの知らせは、さらに遅れて届く**（2026-10-04 に
 * 測ると 0.6 秒では足りず、2.5 秒なら届いていた）。知らせが届いたかは画面から
 * 見えない（パネルは飛んだ時点で光る行を付け替える）ので、時間で待つ。
 * 作者が続けて押す間合いもこのくらいはある
 */
async function settleCaret(page: Page): Promise<void> {
  await page.waitForTimeout(2500);
}

test("右クリック「メモ追加」で行の上に // が入り、［済み］は閉じた話ならファイルから・開いた話なら画面から（ファイルは残して）消え、［次へ］［戻る］は話をまたいで端で回り、カーソルの近くのメモが光る", async () => {
  await withVsCode(
    "メモの足し方と飛び方",
    [
      { name: EP1, text: "一の一行目。\n// 一のメモ\n一の三行目。\n" },
      { name: EP2, text: "二の本文。\n" },
      { name: EP3, text: "三の一行目。\n// 三のメモA\n三の三行目。\n// 三のメモB\n" },
    ],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EP1, "一の三行目");

      /* ── 右クリック「メモ追加」（F-45） ── */
      // カーソルを「一の三行目」の行に置き、**そのカーソルの上で**右クリックする
      // （作者がする形。右クリックでカーソルが別の行へ動かないように）
      await placeCaretAfter(frame, "一の三");
      const caretBox = await frame.evaluate(() => {
        const selection = window.getSelection();
        const compose = document.getElementById("compose");
        if (!selection || selection.rangeCount === 0 || !compose) return undefined;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        const box = compose.getBoundingClientRect();
        return { x: rect.left - box.left + 1, y: rect.top + rect.height / 2 - box.top };
      });
      if (!caretBox) throw new Error("カーソルの位置が測れません");
      await frame.locator("#compose").click({ button: "right", position: caretBox });
      const addItem = frame.locator("#menu .item", { hasText: "メモ追加" }).first();
      await waitUntil(async () => (await addItem.count()) > 0 && (await addItem.isVisible()), "右クリックの品書きに「メモ追加」が出る");
      await addItem.click();
      await waitUntil(async () => /\/\/ ?\n+一の三行目。/.test(await composeText(frame)), "「メモ追加」で行の上に // が入る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（本文：${JSON.stringify(await composeText(frame))}）`);
        }
      );
      await page.keyboard.press("Control+KeyS");
      await waitUntil(async () => /\n\/\/ ?\n一の三行目。/.test(await fileText(session, EP1)), "足したメモの行がファイルに入る");
      expect((await fileText(session, EP1)).split("\n").slice(0, 2)).toEqual(["一の一行目。", "// 一のメモ"]);

      /* ── 校正・メモパネルを横に開く ── */
      await placeCaretAfter(frame, "一の一行目");
      await page.keyboard.press("Control+Alt+KeyM");
      let found: Frame | undefined;
      await waitUntil(async () => {
        found = await memoPanelFrame(page);
        return found !== undefined && (await found.locator("button.go", { hasText: "三のメモB" }).count()) > 0;
      }, "校正・メモパネルに3つの話のメモが出る", 30_000);
      if (!found) throw new Error("校正・メモパネルが見つかりません");
      const panel = found;
      const doneButtonOf = (text: string) =>
        panel.locator(".memo", { has: panel.locator("button.go", { hasText: text }) }).locator("button[data-act=done]");

      /*
        ── カーソルの近くのメモが光る（F-45） ──
        パネルを開いた**あとで**カーソルを動かして見る。開く前のカーソルの知らせは、
        まだ無いパネルには届かない（開いた直後に光っているかは、知らせの届く順しだいで
        揺れた。2026-10-04 の全件の走りで1回落ちた）
      */
      await placeCaretAfter(frame, "一の三行目");
      await waitUntil(async () => {
        const active = panel.locator(".memo.active");
        return (await active.count()) === 1 && !((await active.innerText()).includes("一のメモ"));
      }, "最後の行へカーソルを動かすと、その上の足したメモが光る");
      await placeCaretAfter(frame, "一の一行目");
      await waitUntil(
        async () => (await panel.locator(".memo.active", { hasText: "一のメモ" }).count()) === 1,
        "1行目へカーソルを動かすと、光りが「一のメモ」へ移る"
      );

      /* ── ［済み］：閉じている話（ファイルが書き換わる）（F-45） ── */
      expect(await frameShowing(page, "三の一行目"), "第3話がまだ開いていないはずです").toBeUndefined();
      await doneButtonOf("三のメモB").click();
      await waitUntil(async () => !(await fileText(session, EP3)).includes("三のメモB"), "閉じている第3話のファイルから「三のメモB」が消える");
      expect(await fileText(session, EP3)).toBe("三の一行目。\n// 三のメモA\n三の三行目。\n");

      /* ── ［次へ →］［← 戻る］：話をまたぎ、端で回る（F-45） ── */
      // いまのメモ：第1話「一のメモ」・足した // 、第3話「三のメモA」（第2話には無い）
      await placeCaretAfter(frame, "一の三行目");
      await settleCaret(page);
      await panel.locator("#next").click();
      // 第1話の最後のメモより後ろにはもう無いので、第2話を飛ばして第3話へ
      await waitUntil(async () => (await activeTabNames(page)).includes(EP3), "［次へ］で第2話を飛ばして第3話が前に出る");
      await waitUntil(async () => (await caretLineAnywhere(page)).includes("三のメモA"), "［次へ］で第3話のメモの行へ飛ぶ");
      expect((await activeTabNames(page)).includes(EP2), "メモの無い第2話が開きました").toBe(false);

      // 末尾の次は先頭（第1話の最初のメモ）へ回る
      await settleCaret(page);
      await panel.locator("#next").click();
      await waitUntil(async () => (await activeTabNames(page)).includes(EP1), "末尾の［次へ］で第1話へ戻る");
      await waitUntil(async () => (await caretLineAnywhere(page)).includes("一のメモ"), "末尾の［次へ］で先頭のメモ（一のメモ）へ回る");

      // 先頭の前は末尾（第3話のメモ）へ回る
      await settleCaret(page);
      await panel.locator("#prev").click();
      await waitUntil(async () => (await activeTabNames(page)).includes(EP3), "先頭の［戻る］で第3話へ回る");
      await waitUntil(async () => (await caretLineAnywhere(page)).includes("三のメモA"), "先頭の［戻る］で末尾のメモへ回る");

      // 第1話を前に戻してから（クイックオープンで、開いているタブへ移る）
      const ep1Frame = await openEpisode(page, EP1, "一の三行目");
      /* ── ［済み］：開いている話（画面から消え、ファイルは書き換えない）（F-45） ──
         帯の［戻す］で戻るかは、下の別の件で見る */
      await doneButtonOf("一のメモ").click();
      await waitUntil(async () => !(await composeText(ep1Frame)).includes("一のメモ"), "開いている第1話の画面から「一のメモ」が消える");
      await waitUntil(async () => await tabIsDirty(page, EP1), "開いている話は未保存のまま（ファイルは書き換えない）");
      expect(await fileText(session, EP1), "開いている話のファイルが直に書き換わりました").toContain("// 一のメモ");
    }
  );
});

/*
  **［済み］で消えたメモを、校正・メモパネルの上の帯の［戻す］で戻す**（設計書6.40.4。
  作者の裁定 2026-10-04「［済み］の直後に戻す帯を出す。［直す］と同じ形にし、Ctrl+Z の
  動きは変えない」。実機確認リスト F-45）。

  いきさつ：2026-10-04 に「原稿エディターの中の Ctrl+Z で戻る」として移したとき落ちた。
  ［済み］は開いている文書を拡張機能の側から書き換えるので、取り消しの記録は VS Code の
  文書の側に積まれ、原稿エディター（組んで書く面）の中の Ctrl+Z（画面の取り消し）は
  その記録を持たない。裁定で、戻す口を帯の［戻す］に置いた（［直す］の帯と同じ部品）。

  開いている話（文書へ差し込む道）と閉じている話（ファイルを書き直す道）の両方を見る。
*/
test("［済み］で消えたメモが、校正・メモパネルの帯の［戻す］で元の位置へ戻る（開いている話は画面へ・閉じている話はファイルへ）", async () => {
  const ep1Text = "一の一行目。\n// 一のメモ\n一の三行目。\n";
  const ep3Text = "三の一行目。\n// 三のメモ\n三の三行目。\n";
  await withVsCode(
    "済みの帯で戻す",
    [
      { name: EP1, text: ep1Text },
      { name: EP3, text: ep3Text },
    ],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EP1, "一の三行目");
      await placeCaretAfter(frame, "一の一行目");
      await page.keyboard.press("Control+Alt+KeyM");
      let found: Frame | undefined;
      await waitUntil(async () => {
        found = await memoPanelFrame(page);
        return found !== undefined && (await found.locator("button.go", { hasText: "三のメモ" }).count()) > 0;
      }, "校正・メモパネルに2つの話のメモが出る", 30_000);
      if (!found) throw new Error("校正・メモパネルが見つかりません");
      const panel = found;
      const doneButtonOf = (text: string) =>
        panel.locator(".memo", { has: panel.locator("button.go", { hasText: text }) }).locator("button[data-act=done]");
      const banner = panel.locator("#fixed");
      const bannerText = async () => ((await banner.isVisible()) ? await panel.locator("#fixedText").innerText() : "");

      /* ── 開いている話：画面から消え、帯の［戻す］で画面に戻る（ファイルは書き換えない） ── */
      await doneButtonOf("一のメモ").click();
      await waitUntil(async () => !(await composeText(frame)).includes("一のメモ"), "［済み］で画面から「一のメモ」が消える");
      await waitUntil(
        async () => (await bannerText()).includes("メモを済みにしました") && (await bannerText()).includes("2行目"),
        "帯に「メモを済みにしました（… 2行目）」が出る"
      );
      await panel.locator("#undoFix").click();
      await waitUntil(
        async () => {
          // 画面の字は段落の切れ目の数が面しだいなので、並び順で見る
          const text = await composeText(frame);
          const memoAt = text.indexOf("// 一のメモ");
          return memoAt > text.indexOf("一の一行目。") && memoAt < text.indexOf("一の三行目。");
        },
        "帯の［戻す］で「一のメモ」が元の位置（1行目と3行目の間）へ戻る"
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（本文：${JSON.stringify(await composeText(frame))}）`);
      });
      await waitUntil(async () => !(await banner.isVisible()), "戻したら帯が下がる");
      expect(await fileText(session, EP1), "開いている話のファイルが直に書き換わりました").toBe(ep1Text);

      /* ── 閉じている話：ファイルから消え、帯の［戻す］でファイルが元に戻る ── */
      expect(await frameShowing(page, "三の一行目"), "第3話がまだ開いていないはずです").toBeUndefined();
      await doneButtonOf("三のメモ").click();
      await waitUntil(async () => !(await fileText(session, EP3)).includes("三のメモ"), "閉じている第3話のファイルから「三のメモ」が消える");
      await waitUntil(async () => (await bannerText()).includes("メモを済みにしました"), "閉じている話でも帯が出る");
      await panel.locator("#undoFix").click();
      await waitUntil(async () => (await fileText(session, EP3)) === ep3Text, "帯の［戻す］で第3話のファイルが元のとおりに戻る");
      await waitUntil(async () => !(await banner.isVisible()), "戻したら帯が下がる（閉じている話）");
      await waitUntil(
        async () => (await panel.locator("button.go", { hasText: "三のメモ" }).count()) === 1,
        "戻したメモが一覧にまた並ぶ"
      );
    }
  );
});

/*
  **［次へ］を続けて押すと、2つの話のメモを回り続ける**（設計書6.40.4。実機確認リスト F-45
  「次へ・戻るで話をまたいで飛び、末尾で先頭へ回る」）。

  2026-10-04 に移したとき**落ちた**（同日に直した。飛んだ先を拡張機能の側で起点として覚える。
  設計書6.40.4）。下見で分かったこと：第1話→第3話→
  （回って）第1話→第3話と進んだあと、4回目の［次へ］で第3話から動かなくなる。
  ［次へ］の起点は、原稿エディターが知らせる「最後にカーソルがあった行」
  （`lastManuscriptCaret`）だが、原稿エディターは**同じ行に居るあいだは知らせない**
  （`manuscriptEditorHtml.ts` の notifyCaret の `lastCaretLine`）。第3話の面は1回目に
  2行目を知らせ済みなので、2回目に同じ2行目へ飛ばされても知らせず、起点が第1話のまま
  残る。そこから数えた「次」はまた第3話の2行目になり、何度押しても同じ所に留まる。
*/
test("校正・メモパネルの［次へ］を続けて押すと、2つの話のメモを止まらずに回り続ける", async () => {
  await withVsCode(
    "次へで回り続ける",
    [
      { name: EP1, text: "一の一行目。\n// 一のメモ\n一の三行目。\n" },
      { name: EP2, text: "二の本文。\n" },
      { name: EP3, text: "三の一行目。\n// 三のメモA\n三の三行目。\n" },
    ],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EP1, "一の三行目");
      await placeCaretAfter(frame, "一の三行目");
      await page.keyboard.press("Control+Alt+KeyM");
      let found: Frame | undefined;
      await waitUntil(async () => {
        found = await memoPanelFrame(page);
        return found !== undefined && (await found.locator("button.go", { hasText: "三のメモA" }).count()) > 0;
      }, "校正・メモパネルに2つの話のメモが出る", 30_000);
      if (!found) throw new Error("校正・メモパネルが見つかりません");
      const panel = found;

      // 第3話 → 第1話 → 第3話 → 第1話 と、押すたびに話が入れ替わるはず
      const expected = [EP3, EP1, EP3, EP1];
      for (const [index, episode] of expected.entries()) {
        await settleCaret(page);
        await panel.locator("#next").click();
        await waitUntil(
          async () => (await activeTabNames(page)).includes(episode),
          `${index + 1}回目の［次へ］で ${episode} が前に出る`,
          8_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（前に出ているタブ：${JSON.stringify(await activeTabNames(page))}）`);
        });
      }
    }
  );
});
