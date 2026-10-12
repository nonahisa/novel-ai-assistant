/**
 * 原稿エディターのキーと右クリック（画面の自動テスト、設計書6.25.9・6.25.10・6.113。仕分け 2026-10-12 の
 * 束 E8 を移したもの。作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 1. 打ってから Ctrl+S を押すと、下の欄に「保存しています…」→「保存しました（N字）」が出て、ファイルに入る
 *    （実機確認リスト 267 行。**変換中の Ctrl+S が日本語入力に任されるかは見られない**——IME の本物の変換は
 *    届かない。作者の手に残す）
 * 2. メモのキー（校正・メモパネルを開く）を作者が別のキーへ替えても、同じく横に開き、作品を訊かれない。
 *    外した Ctrl+Alt+M では開かない（実機確認リスト 276 行）。キーの替え方は、キーボード ショートカットの画面で
 *    替えたときに VS Code が書くのと同じ形（`args`・`when` を写した行と、元のキーを外す `-` の行）を、
 *    使い捨ての keybindings.json に書く。**キーボード ショートカットの画面で重なりの表示を見るのは作者**
 *    （画面の見た目）。作品を2つ登録しておく——1つだと、印が写っていなくても訊かれないので、確かめたことにならない
 * 3. 選んで右クリック「切り取り」→ 字が消え、別の所で右クリック「貼り付け」→ 入る。そのまま Ctrl+S で
 *    ファイルに入り、上に警告の帯（保存できなかった）が出ない。Ctrl+Z で貼り付けと切り取りが戻る
 *    （実機確認リスト 301 行）。切り取りは**本物の OS のクリップボード**を通るので、走らせたあと前の中身へ戻す
 *
 * なお実機確認リスト 272 行（Ctrl+Alt+M で校正・メモパネルが横に出る）は、既にある
 * `sceneMemoPanel.test.ts`（原稿の中から Ctrl+Alt+M で右の列にパネルが開く）が覆っているので、ここには書かない。
 *
 * **AI は呼ばない。**
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import {
  classOpen,
  composeText,
  footText,
  memoPanelFrame,
  openEpisode,
  placeCaretAfter,
  selectText,
} from "./support/manuscriptFrame";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, editorGroupTabs, quickPickTitle } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";

async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

/* ── 1. Ctrl+S と下の欄 ── */

test("原稿エディターで打って Ctrl+S を押すと、下の欄に「保存しています…」のあと「保存しました（N字）」が出て、ファイルに入る", async () => {
  await withVsCode(
    "Ctrl+S の下の欄",
    [{ name: EPISODE, text: "一行目の文。\n二行目の文。\n三行目の文。\n" }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "二行目の文");
      await placeCaretAfter(frame, "二行目の");
      await page.keyboard.insertText("短い");
      await waitUntil(async () => (await composeText(frame)).includes("二行目の短い文。"), "打った字が画面に出る");

      /*
        **下の欄の移り変わりを、画面の中で全部書き留める。** 「保存しています…」は受付から結果までの
        一瞬しか出ない（ふだん0.1秒に満たない）ので、外から刻んで見ると取りこぼす。受付と結果は
        別々の便で届く（`features/manuscriptEditor.ts` の saveAccepted と saveResult）ので、
        書き換わるたびに呼ばれる見張り（MutationObserver）なら両方を拾える
      */
      await frame.evaluate(() => {
        const note = document.getElementById("note");
        const seen: string[] = [];
        (window as unknown as { __e2eNoteSeen: string[] }).__e2eNoteSeen = seen;
        if (!note) return;
        new MutationObserver(() => seen.push(note.textContent ?? "")).observe(note, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
      const noteSeen = () => frame.evaluate(() => (window as unknown as { __e2eNoteSeen?: string[] }).__e2eNoteSeen ?? []);

      await page.keyboard.press("Control+KeyS");
      await waitUntil(async () => (await fileText(session)).includes("二行目の短い文。"), "Ctrl+S で打った字がファイルに入る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session))}／下の欄の移り変わり：${JSON.stringify(await noteSeen())}）`);
        }
      );
      await waitUntil(async () => /保存しました（\d+字）/.test(await footText(frame, "note")), "下の欄に「保存しました（N字）」が出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(
            `${String(error)}（いまの下の欄：${JSON.stringify(await footText(frame, "note"))}／移り変わり：${JSON.stringify(await noteSeen())}／` +
              `警告の帯：${await classOpen(frame, "saveFail")}）`
          );
        }
      );
      const seen = await noteSeen();
      expect(seen, `「保存しています…」が一度も出ていません（移り変わり：${JSON.stringify(seen)}）`).toContain("保存しています…");
      const savedAt = seen.findIndex((text) => /保存しました（\d+字）/.test(text));
      expect(seen.indexOf("保存しています…"), `「保存しています…」が「保存しました」より後です（${JSON.stringify(seen)}）`).toBeLessThan(savedAt);
      const chars = Number(/保存しました（(\d+)字）/.exec(await footText(frame, "note"))?.[1] ?? "0");
      expect(chars, "「保存しました（N字）」の字数が0です").toBeGreaterThan(0);
      expect(await classOpen(frame, "saveFail"), "保存できなかったときの赤い帯が出ています").toBe(false);
      expect(await fileText(session)).toBe("一行目の文。\n二行目の短い文。\n三行目の文。\n");
    }
  );
});

/* ── 2. メモのキーを別のキーへ替える ── */

/** 製品の package.json の割り当てと同じ条件（キーボード ショートカットの画面で替えると、この `when` が写る） */
const MANUSCRIPT_WHEN =
  "(activeCustomEditorId == 'novelai.manuscriptEditor' || activeCustomEditorId == 'novelai.manuscriptEditorHorizontal') && !terminalFocus && !inputFocus && !sideBarFocus && !auxiliaryBarFocus && !panelFocus";
/** 替えた先のキー（使い捨ての keybindings.json だけ。製品の割り当てにも、ほかの画面テストにも無い組） */
const NEW_MEMO_KEY = "ctrl+alt+shift+l";
const NEW_MEMO_PRESS = "Control+Alt+Shift+KeyL";

const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";

function reboundLaunch(): LaunchOptions {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  return {
    keybindings: [
      registerOther,
      // キーボード ショートカットの画面で「校正・メモパネルを開く」のキーを替えたときと同じ2行
      { key: NEW_MEMO_KEY, command: "novelai.openSceneMemos", when: MANUSCRIPT_WHEN, args: { source: "manuscriptEditor" } },
      { key: "ctrl+alt+m", command: "-novelai.openSceneMemos", when: MANUSCRIPT_WHEN },
    ],
    // keybindings.json はこの準備のあとに書かれるので、作品Bの置き場はここで args へ入れる
    prepareWork: async ({ workFolder }) => {
      const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
      await mkdir(path.join(otherFolder, "本文"), { recursive: true });
      await writeFile(path.join(otherFolder, "本文", "001_別の作品.txt"), "　別の作品の本文。\n", "utf8");
      registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
    },
  };
}

async function describeScreen(page: Page): Promise<string> {
  return `列とタブ：${JSON.stringify(await editorGroupTabs(page))}／選ぶ画面の題：${JSON.stringify(await quickPickTitle(page))}`;
}

test("校正・メモパネルを開くキーを別のキーへ替えると、原稿の中からそのキーで横に開き、作品を訊かれず、外した Ctrl+Alt+M では開かない", async () => {
  await withVsCode(
    "メモのキーを替える",
    [{ name: EPISODE, text: "一行目の文。\n// 見張りのメモ\n三行目の文。\n" }],
    async (session) => {
      const { page } = session;
      // 作品を2つにする（1つだと、印が写っていなくても作品は訊かれない）
      await page.keyboard.press(REGISTER_OTHER_PRESS);
      await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
      await clearNotifications(page);

      const frame = await openEpisode(page, EPISODE, "三行目の文");
      await placeCaretAfter(frame, "一行目");

      // 外した Ctrl+Alt+M では開かない（字も入らない）
      await page.keyboard.press("Control+Alt+KeyM");
      await holdsFor(async () => (await memoPanelFrame(page)) === undefined && (await quickPickTitle(page)) === undefined, "外した Ctrl+Alt+M で何も開かない").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（${await describeScreen(page)}）`);
        }
      );
      expect(await composeText(frame), "Ctrl+Alt+M で本文に字が入りました").toContain("一行目の文。");

      // 替えた先のキーで、校正・メモパネルが原稿の横（右の列）に開く
      await placeCaretAfter(frame, "一行目");
      await page.keyboard.press(NEW_MEMO_PRESS);
      let panel: Frame | undefined;
      await waitUntil(
        async () => {
          if ((await quickPickTitle(page)) !== undefined) {
            throw new Error(`替えたキーで、選ぶ画面「${await quickPickTitle(page)}」が出ました（作品を訊かれた＝キーの印が写っていない形）`);
          }
          panel = await memoPanelFrame(page);
          return panel !== undefined && (await panel.locator("button.go").count()) > 0;
        },
        "替えたキーで、校正・メモパネルにメモの行が出る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeScreen(page)}）`);
      });
      const groups = await editorGroupTabs(page);
      expect(groups.length, `列が2つになっていません：${JSON.stringify(groups)}`).toBe(2);
      // 開いたあとも、作品を選ぶ画面が遅れて出てこない
      await holdsFor(async () => (await quickPickTitle(page)) === undefined, "替えたキーで開いたあと、選ぶ画面が出ない");
    },
    reboundLaunch()
  );
});

/* ── 3. 右クリックの切り取り・貼り付け・Ctrl+S・Ctrl+Z ── */

/** 組んで書く面の、いまの選択（かカーソル）の真ん中を、`#compose` の中の位置で返す（右クリックの場所） */
async function selectionPoint(frame: Frame): Promise<{ x: number; y: number }> {
  const point = await frame.evaluate(() => {
    const compose = document.getElementById("compose");
    const selection = window.getSelection();
    if (!compose || !selection || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    // 畳んだ選択（カーソルだけ）は幅0の矩形が返る。高さが0なら、行の矩形から取る
    const rects = Array.from(range.getClientRects());
    const rect = rects.find((entry) => entry.height > 0) ?? range.getBoundingClientRect();
    const base = compose.getBoundingClientRect();
    return { x: rect.left - base.left + Math.max(rect.width / 2, 1), y: rect.top - base.top + rect.height / 2 };
  });
  if (!point) throw new Error("組んで書く面の選択が取れません（右クリックの場所が決まりません）");
  return point;
}

/** 右クリックの品書き（原稿エディターの自前の `#menu`）で `label` を押す */
async function pressMenu(frame: Frame, label: string): Promise<void> {
  await frame.locator("#compose").click({ button: "right", position: await selectionPoint(frame) });
  const item = frame.locator("#menu .item", { hasText: label }).first();
  await waitUntil(async () => (await frame.locator("#menu").evaluate((menu) => menu.classList.contains("open"))) && (await item.count()) > 0, `右クリックの品書きに「${label}」が出る`).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（品書き：${JSON.stringify(await frame.locator("#menu").innerText().catch(() => ""))}）`);
    }
  );
  expect(await item.getAttribute("class"), `品書きの「${label}」が押せない形です`).not.toContain("disabled");
  await item.click();
}

test("選んで右クリック「切り取り」で字が消え、別の所で「貼り付け」で入り、Ctrl+S でファイルに入って警告の帯が出ず、Ctrl+Z で両方戻る", async () => {
  const ORIGINAL = "一行目の文。\n二行目の文。\n三行目の文。\n";
  await withVsCode("右クリックの切り取りと貼り付け", [{ name: EPISODE, text: ORIGINAL }], async (session) => {
    const { page, app } = session;
    // 切り取りは OS のクリップボードを使う。走らせたあと前の中身へ戻す
    const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "");
    try {
      const frame = await openEpisode(page, EPISODE, "三行目の文");
      const original = await composeText(frame);
      const states: string[] = [];

      /* ── 選んで「切り取り」 ── */
      await selectText(frame, "二行目");
      await pressMenu(frame, "切り取り");
      await waitUntil(async () => !(await composeText(frame)).includes("二行目"), "切り取った字が画面から消える", 10_000).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（画面：${JSON.stringify(await composeText(frame))}／下の欄：${JSON.stringify(await footText(frame, "note"))}／` +
            `クリップボード：${JSON.stringify(await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "読めない"))}）`
        );
      });
      const afterCut = await composeText(frame);
      states.push(afterCut);

      /* ── 別の所（三行目の終わり）で「貼り付け」 ── */
      await placeCaretAfter(frame, "三行目の文。");
      await pressMenu(frame, "貼り付け");
      await waitUntil(async () => (await composeText(frame)).includes("三行目の文。二行目"), "貼り付けた字が三行目の終わりに入る", 10_000).catch(
        async (error: unknown) => {
          throw new Error(
            `${String(error)}（画面：${JSON.stringify(await composeText(frame))}／下の欄：${JSON.stringify(await footText(frame, "note"))}／` +
              `クリップボード：${JSON.stringify(await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "読めない"))}）`
          );
        }
      );
      const afterPaste = await composeText(frame);
      states.push(afterPaste);

      /* ── そのまま Ctrl+S：ファイルに入り、警告の帯が出ない ── */
      await page.keyboard.press("Control+KeyS");
      await waitUntil(async () => (await fileText(session)) === "一行目の文。\nの文。\n三行目の文。二行目\n", "切り取りと貼り付けがファイルに入る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session))}／下の欄：${JSON.stringify(await footText(frame, "note"))}）`);
        }
      );
      await waitUntil(async () => (await footText(frame, "note")).includes("保存しました"), "「保存しました」が出る", 15_000);
      expect(await classOpen(frame, "saveFail"), "保存のあと、上に警告の帯（保存できなかった）が出ています").toBe(false);

      /* ── Ctrl+Z で、貼り付け → 切り取りの順に戻る ── */
      await frame.locator("#compose").click();
      for (let press = 1; press <= 4 && (await composeText(frame)) !== original; press++) {
        const before = await composeText(frame);
        await page.keyboard.press("Control+KeyZ");
        await waitUntil(async () => (await composeText(frame)) !== before, `${press}回目の Ctrl+Z で画面が戻る`, 10_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（いまの画面：${JSON.stringify(await composeText(frame))}／ここまでの移り変わり：${JSON.stringify(states)}）`);
        });
        states.push(await composeText(frame));
      }
      expect(await composeText(frame), `Ctrl+Z を4回まで押しても元に戻りません（移り変わり：${JSON.stringify(states)}）`).toBe(original);
      // 1回目の Ctrl+Z は、あとからした貼り付けを先に戻す（切り取った字はまだ戻らない）
      expect(states[2], `1回目の Ctrl+Z で、貼り付けが戻っていません（移り変わり：${JSON.stringify(states)}）`).not.toContain("三行目の文。二行目");

      // 戻した形も保存できる
      await page.keyboard.press("Control+KeyS");
      await waitUntil(async () => (await fileText(session)) === ORIGINAL, "Ctrl+Z で戻した形が Ctrl+S でファイルに入る", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（ファイル：${JSON.stringify(await fileText(session))}）`);
      });
      expect(await classOpen(frame, "saveFail"), "戻したあとの保存で、警告の帯が出ています").toBe(false);
    } finally {
      await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboardBefore).catch(() => undefined);
    }
  });
});
