/**
 * 0.122.0 で入口をまとめた所（画面の自動テスト、設計書6.113。実機確認リスト 0.122.0 の 369・370・371・372 行を
 * 機械へ移した。作者の判断 2026-11-02「同じことをする入口は1つにして、押してから訊く」）。
 *
 * 1. 370：作品一覧の作品の右クリックに「投稿と読者の反応…」が1つだけ出て、新話投稿・投稿サイト設定・
 *    ランキング記録・読者反応自動取込・読者反応手動入力・連載状態切替の6つは並ばない。押すと6つを選ぶ画面が出て、
 *    選ぶと（作品が2つあっても）作品を訊かずにその作品で始まる
 * 2. 369：話の右クリックに「この話を削除」が1つだけ出て（「ファイルを削除」「この話を削除（話数を詰める）」は無い）、
 *    押すと「話数を詰める／詰めない（ファイルだけ消す）」を訊く。「話数を詰める」では付け替える話の一覧の確認が出る。
 *    **実際には消さない**（どちらの道もファイルを作者の機械のごみ箱へ移すため。確認は閉じて、ファイルが残ることを見る）
 * 3. 371：コマンドパレットで「統合小説執筆環境:」の頭で命令が並び、「小説執筆:」の頭は無い。種類ごとの
 *    「人物一覧を生成」などは出ない。「設定資料集出力」を押すと「すべて／人物／場所／能力／組織／世界観／各話あらすじ」を
 *    選ぶ画面が出て、「組織」で organizations.md だけが書き出される（人物がいても characters.md は作らない）
 * 4. 372：素のエディターの本文の右クリックに「AIに相談」と「原稿エディターで開く」があり、「縦書き表示」は無い。
 *    詳細メニュー「資料抽出」に「能力抽出」があり「スキル抽出」は無い。簡単ステップメニューの「AIに相談」は
 *    薄字が「大きく開く」（詳細メニューの「AIに相談」〈横に開く〉は menuNoticeFollowUps が見ている）
 *
 * **AI は呼ばない。** 設定画面（Ctrl+,）の見出し「統合小説執筆環境」は package.json の設定の題として
 * 単体テストの側で見ている（ここでは見ない）。
 */
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { expect, test } from "vitest";
import { EPISODE_DELETE_CHOICES } from "../../src/core/episodeDeleteChoice";
import { POSTING_MENU_ENTRIES } from "../../src/core/postingMenu";
import { SETTINGS_DOC_CHOICES } from "../../src/core/settingsDocChoices";
import { emptyCharacter } from "../../src/models/character";
import { emptyOrganization, organizationFileName } from "../../src/models/organization";
import { runCommand } from "./support/quickInput";
import { defaultCharactersFolder, writeCharactersTo } from "./support/settingsFixture";
import {
  SIDEBAR_LAUNCH,
  collapseSidebarPane,
  contextMenuLabels,
  expandTreeRow,
  showSidebar,
  treeContextMenu,
  treeRow,
  waitTreeSettled,
} from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  closeDialog,
  commandPaletteLabels,
  dialogText,
  dismissWorkbenchHover,
  focusTextEditor,
  pickQuickPickRow,
  quickInputWaitContext,
  quickOpen,
  quickPickTitle,
  textEditorVisibleText,
  waitForQuickPick,
} from "./support/workbenchDom";

const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";

/** 右クリックで品書きを出し、並んだ名前を読んで閉じる */
async function readContextMenu(page: Page, row: Locator, label: string): Promise<string[]> {
  await dismissWorkbenchHover(page);
  await row.click({ button: "right" });
  await waitUntil(async () => (await contextMenuLabels(page)).length > 0, `${label}の右クリックの品書きが出る`, 10_000);
  // 品書きは出たあと少しのあいだ項目が足されることがあるので、落ち着いてから読む
  await page.waitForTimeout(500);
  const labels = await contextMenuLabels(page);
  await page.keyboard.press("Escape");
  await waitUntil(async () => (await page.locator(".context-view .monaco-menu").count()) === 0, "品書きが閉じる", 5_000);
  return labels;
}

/* ── 1・2. 作品の右クリック「投稿と読者の反応…」と、話の右クリック「この話を削除」 ── */

test("作品の右クリックに「投稿と読者の反応…」が1つだけ出て6つを選べ、選ぶと作品を訊かずに始まり、話の右クリックの「この話を削除」1つから「話数を詰める／詰めない」を訊く", async () => {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  await withVsCode(
    "作品と話の右クリックの入口",
    [
      { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
      { name: "第2話_つづき.txt", text: "二話の本文。\n" },
      { name: "第3話_山場.txt", text: "三話の本文。\n" },
    ],
    async (session) => {
      const { page } = session;
      // 作品を2つにする（「作品を訊かずに」を見るため）
      await page.keyboard.press(REGISTER_OTHER_PRESS);
      await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
      await clearNotifications(page);
      await showSidebar(page, E2E_WORK_TITLE);
      await collapseSidebarPane(page, "AIに相談");
      await waitTreeSettled(page);

      /* ── 370：作品の右クリック ── */
      const workMenu = await readContextMenu(page, treeRow(page, E2E_WORK_TITLE), "作品の行");
      expect(workMenu.filter((label) => label === "投稿と読者の反応…"), `作品の右クリック：${JSON.stringify(workMenu)}`).toHaveLength(1);
      for (const entry of POSTING_MENU_ENTRIES) {
        expect(workMenu, `作品の右クリックに「${entry.label}」が並んでいます：${JSON.stringify(workMenu)}`).not.toContain(entry.label);
      }
      expect(POSTING_MENU_ENTRIES.map((entry) => entry.label)).toEqual(["新話投稿", "投稿サイト設定", "ランキング記録", "読者反応自動取込", "読者反応手動入力", "連載状態切替"]);

      await treeContextMenu(page, E2E_WORK_TITLE, "投稿と読者の反応…");
      const postingTitle = `投稿と読者の反応（${E2E_WORK_TITLE}）`;
      const rows = await waitForQuickPick(page, postingTitle, 15_000);
      expect(
        rows.map((row) => row.label).filter((label) => label !== "取りやめる"),
        `「投稿と読者の反応…」の選ぶ画面：${JSON.stringify(rows)}`
      ).toEqual(POSTING_MENU_ENTRIES.map((entry) => entry.label));
      await pickQuickPickRow(page, "連載状態切替");
      let next = "";
      await waitUntil(
        async () => {
          next = (await quickPickTitle(page)) ?? "";
          return next !== "" && next !== postingTitle;
        },
        "「連載状態切替」を選ぶと、その作品の次の画面が出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
      });
      expect(next, "選んだのに作品を訊かれました").not.toBe("作品を選択");
      await page.keyboard.press("Escape");
      await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 5_000);

      /* ── 369：話の右クリック ── */
      await expandTreeRow(page, E2E_WORK_TITLE);
      await waitTreeSettled(page);
      const episodeMenu = await readContextMenu(page, treeRow(page, "第2話"), "話の行");
      expect(episodeMenu.filter((label) => label === "この話を削除"), `話の右クリック：${JSON.stringify(episodeMenu)}`).toHaveLength(1);
      expect(episodeMenu, `話の右クリックに「ファイルを削除」が残っています：${JSON.stringify(episodeMenu)}`).not.toContain("ファイルを削除");
      expect(episodeMenu, `話の右クリックに「この話を削除（話数を詰める）」が残っています：${JSON.stringify(episodeMenu)}`).not.toContain(
        "この話を削除（話数を詰める）"
      );

      await treeContextMenu(page, "第2話", "この話を削除");
      let ask = "";
      await waitUntil(async () => (ask = (await dialogText(page)) ?? "").includes("あとの話の話数を詰めますか"), "「話数を詰めますか」の問いが出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの窓：${JSON.stringify(ask)}）${await quickInputWaitContext(page)}`);
        }
      );
      expect(ask, `問いの窓：${ask}`).toContain("第2話_つづき.txt");
      const buttons = await page.locator(".monaco-dialog-box .monaco-button").allInnerTexts();
      expect(buttons.map((text) => text.trim()), `問いのボタン：${JSON.stringify(buttons)}`).toEqual(
        expect.arrayContaining([EPISODE_DELETE_CHOICES.renumber, EPISODE_DELETE_CHOICES.fileOnly])
      );
      /*
        「話数を詰める」を選ぶと、付け替えの確認が出る（そこで閉じる。消さない）。
        **項目の文との違い**：確認は付け替える話を名前で並べず、「第2話以降の1件の話数を詰めます」
        「付け替え1件」と件数で言う（2026-11-02 この件を書いたときの画面）
      */
      await page.locator(".monaco-dialog-box .monaco-button", { hasText: EPISODE_DELETE_CHOICES.renumber }).first().click();
      let list = "";
      await waitUntil(
        async () => {
          list = (await dialogText(page)) ?? "";
          return list.includes("話数を詰めます") && list.includes("付け替え1件");
        },
        "「話数を詰める」で、付け替える話の数（1件）の確認が出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの窓：${JSON.stringify(list)}）${await quickInputWaitContext(page)}`);
      });
      await closeDialog(page);
      await holdsFor(
        async () => ["第1話_はじまり.txt", "第2話_つづき.txt", "第3話_山場.txt"].every((name) => existsSync(path.join(session.manuscriptFolder, name))),
        "確認を閉じたら、どの話も消えず番号も変わらない",
        2_000
      );
    },
    {
      ...SIDEBAR_LAUNCH,
      keybindings: [...SIDEBAR_LAUNCH.keybindings, registerOther],
      prepareWork: async ({ workFolder }) => {
        const other = path.join(path.dirname(workFolder), OTHER_TITLE);
        await mkdir(path.join(other, "本文"), { recursive: true });
        await writeFile(path.join(other, "本文", "001_別の話.txt"), "　別の作品の本文。\n", "utf8");
        registerOther.args = { folderPath: other, title: OTHER_TITLE };
      },
    }
  );
}, 300_000);

/* ── 3. 371：パレットの頭と「設定資料集出力」の種類 ── */

test("コマンドパレットの頭が「統合小説執筆環境:」で、種類ごとの「人物一覧を生成」は出ず、「設定資料集出力」で「組織」を選ぶと organizations.md だけが書き出される", async () => {
  await withVsCode(
    "パレットの頭と設定資料集出力",
    [{ name: "001_港.txt", text: "　港の娘は朝早く起きた。\n" }],
    async (session) => {
      const { page, workFolder } = session;
      const head = await commandPaletteLabels(page, "統合小説執筆環境:");
      expect(head.filter((label) => label.startsWith("統合小説執筆環境:")).length, `「統合小説執筆環境:」の頭の命令：${JSON.stringify(head.slice(0, 10))}`).toBeGreaterThan(10);
      const old = await commandPaletteLabels(page, "小説執筆:");
      expect(old.filter((label) => label.startsWith("小説執筆:")), "「小説執筆:」の頭の命令が残っています").toEqual([]);
      const perKind = await commandPaletteLabels(page, "一覧を生成");
      expect(perKind.filter((label) => /人物一覧を生成|場所一覧を生成|能力一覧を生成|世界観一覧を生成/.test(label)), "種類ごとの書き出しがパレットに出ています").toEqual([]);

      /*
        起動のあとに製品が裏で資料を書き出していることがある（登録のあとの書き出しなど）。押す前の様子を控え、
        押したあとに**変わったのが organizations.md だけ**であることを見る
      */
      const settings = path.join(workFolder, "設定");
      const docNames = ["characters.md", "locations.md", "abilities.md", "organizations.md", "world.md"];
      const snapshot = async (): Promise<Record<string, number>> =>
        Object.fromEntries(
          await Promise.all(docNames.map(async (name) => [name, (await stat(path.join(settings, name)).catch(() => undefined))?.mtimeMs ?? -1] as const))
        );
      await page.waitForTimeout(2_000);
      const before = await snapshot();
      await runCommand(page, "設定資料集出力");
      const title = `どの資料を書き出しますか（${E2E_WORK_TITLE}）`;
      const rows = await waitForQuickPick(page, title, 15_000);
      expect(
        rows.map((row) => row.label).filter((label) => label !== "取りやめる"),
        `種類を選ぶ画面：${JSON.stringify(rows)}`
      ).toEqual(SETTINGS_DOC_CHOICES.map((choice) => choice.label));
      expect(SETTINGS_DOC_CHOICES.map((choice) => choice.label)).toEqual(["すべて", "人物", "場所", "能力", "組織", "世界観", "各話あらすじ"]);
      // **名前がちょうど「組織」の行を押す**（`pickQuickPickRow` は行の字に含むかで探すので、説明欄に
      // 「…組織…」とある「すべて」に当たってしまう。2026-11-02 この件で踏んだ）
      const index = rows.findIndex((row) => row.label === "組織");
      await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").nth(index).click();

      await waitUntil(async () => (await snapshot())["organizations.md"] !== before["organizations.md"], "「組織」で organizations.md が書き出される", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（押す前：${JSON.stringify(before)}）${await quickInputWaitContext(page)}`);
        }
      );
      expect(existsSync(path.join(settings, "organizations.md"))).toBe(true);
      // 人物がいても、選ばなかった種類は書き出さない（押す前のまま）
      await holdsFor(
        async () => {
          const now = await snapshot();
          return docNames.filter((name) => name !== "organizations.md").every((name) => now[name] === before[name]);
        },
        "選ばなかった種類（人物など）は書き出さない",
        2_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（押す前：${JSON.stringify(before)}／押したあと：${JSON.stringify(await snapshot())}）`);
      });
    },
    {
      prepareWork: async ({ workFolder }) => {
        await writeCharactersTo(defaultCharactersFolder(workFolder), [{ ...emptyCharacter("char_001", "港の娘"), appearedChapters: [1] }]);
        const organization = emptyOrganization("org_001", "港の組合");
        const folder = path.join(workFolder, "設定", "organizations");
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, organizationFileName(organization)), JSON.stringify(organization, null, 2), "utf8");
      },
    }
  );
}, 300_000);

/* ── 4. 372：相談の入口の名前・能力抽出・素のエディターの右クリック ── */

test("素のエディターの本文の右クリックに「AIに相談」と「原稿エディターで開く」があり「縦書き表示」は無く、詳細メニュー「資料抽出」は「能力抽出」、簡単ステップメニューの「AIに相談」は「大きく開く」", async () => {
  await withVsCode(
    "相談の入口の名前",
    [{ name: "001_港.txt", text: "　港の娘は朝早く起きた。\n" }],
    async (session) => {
      const { page } = session;
      /* ── 素のエディターの本文の右クリック ── */
      await quickOpen(page, "001_港.txt");
      await waitUntil(async () => (await textEditorVisibleText(page)).includes("港の娘"), "素のテキストエディターに本文が出る", 20_000);
      await focusTextEditor(page);
      const lines = page.locator(".monaco-editor .view-lines").first();
      await dismissWorkbenchHover(page);
      await lines.click({ button: "right", position: { x: 40, y: 8 } });
      /*
        エディターの品書きは影の DOM（shadow root）の中に描かれ、`document.querySelectorAll`（`contextMenuLabels`）では
        見えない。Playwright の locator は影の中まで探すので、そちらで読む（menuNoticeFollowUps の「…」と同じ）
      */
      const menuItems = page.locator(".monaco-menu .action-label");
      await waitUntil(async () => (await menuItems.count()) > 0, "本文の右クリックの品書きが出る", 10_000);
      await page.waitForTimeout(500);
      const editorMenu = (await menuItems.allInnerTexts()).map((text) => text.trim()).filter((text) => text !== "");
      await page.keyboard.press("Escape");
      expect(editorMenu, `素のエディターの右クリック：${JSON.stringify(editorMenu)}`).toContain("AIに相談");
      expect(editorMenu, `素のエディターの右クリック：${JSON.stringify(editorMenu)}`).toContain("原稿エディターで開く");
      expect(editorMenu, `素のエディターの右クリックに「縦書き表示」が残っています：${JSON.stringify(editorMenu)}`).not.toContain("縦書き表示");

      /* ── 左の列 ── */
      await showSidebar(page, E2E_WORK_TITLE);
      await collapseSidebarPane(page, "AIに相談");
      // 簡単ステップメニューの「AIに相談」（薄字「大きく開く」）は、どこかの段の中にある。段を開いて探す
      const stepPane = page.locator(".pane", { has: page.locator(".pane-header", { hasText: "簡単ステップメニュー" }) }).first();
      const stepChat = stepPane.locator('.monaco-list-row[aria-label^="AIに相談"]').first();
      const stepGroups = stepPane.locator('.monaco-list-row[aria-expanded="false"]');
      for (let attempt = 0; attempt < 30 && (await stepChat.count()) === 0; attempt++) {
        if ((await stepGroups.count()) > 0) {
          await stepGroups.first().click();
          await page.waitForTimeout(300);
          continue;
        }
        const box = await stepPane.locator(".pane-body").first().boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
          await page.mouse.wheel(0, 120);
        }
        await page.waitForTimeout(150);
      }
      expect(await stepChat.count(), "簡単ステップメニューに「AIに相談」が見つかりません").toBe(1);
      const stepChatLabel = (await stepChat.getAttribute("aria-label")) ?? "";
      expect(stepChatLabel, `簡単ステップメニューの「AIに相談」の名前：${stepChatLabel}`).toContain("大きく開く");
      await collapseSidebarPane(page, "簡単ステップメニュー");

      // 詳細メニュー「資料管理」→「資料抽出」
      const detailPane = page.locator(".pane", { has: page.locator(".pane-header", { hasText: "詳細メニュー" }) }).first();
      const openDetailGroup = async (head: string): Promise<void> => {
        const group = detailPane.locator(`.monaco-list-row[aria-label^="${head}"]`).first();
        for (let attempt = 0; attempt < 30 && (await group.count()) === 0; attempt++) {
          const box = await detailPane.locator(".pane-body").first().boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
            await page.mouse.wheel(0, 120);
          }
          await page.waitForTimeout(150);
        }
        expect(await group.count(), `詳細メニューに「${head}」が見つかりません`).toBe(1);
        await group.scrollIntoViewIfNeeded();
        if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
        await waitUntil(async () => (await group.getAttribute("aria-expanded")) === "true", `詳細メニューの「${head}」が開く`, 10_000);
      };
      await openDetailGroup("資料管理");
      await openDetailGroup("資料抽出");
      await waitUntil(async () => (await detailPane.locator('.monaco-list-row[aria-label^="能力抽出"]').count()) > 0, "「資料抽出」の中に「能力抽出」が出る", 10_000).catch(
        async (error: unknown) => {
          const labels = await detailPane.locator(".monaco-list-row").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
          throw new Error(`${String(error)}（詳細メニューの行：${labels.join(" / ")}）`);
        }
      );
      expect(await detailPane.locator('.monaco-list-row[aria-label^="スキル抽出"]').count(), "「スキル抽出」が残っています").toBe(0);
    },
    {
      ...SIDEBAR_LAUNCH,
      settings: { ...SIDEBAR_LAUNCH.settings, "workbench.editorAssociations": { "*.txt": "default", "*.md": "default" } },
    }
  );
}, 300_000);
