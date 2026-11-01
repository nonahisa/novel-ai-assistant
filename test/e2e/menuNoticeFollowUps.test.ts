/**
 * 0.121.0 で直した「次の一手」の3つ（画面の自動テスト、設計書6.113。実機確認リスト 0.121.0 の
 * 336・337・339 行を機械へ移した。作者の判断 2026-11-01「押せる道を付ける」「名前はメニューから引く」）。
 *
 * 見張ること：
 * 1. 設定資料が1件も無い作品で「矛盾検知」を押すと、AI を呼ぶ前に止まり、メニューの名前「一括抽出」で
 *    次の一手を案内する（メニューに無い名前「設定資料をまとめて抽出」は出ない）。作者がメニューから押して
 *    見るのは前提の関所の選ぶ画面（件の中の断り書き）
 * 2. 「ベクトル検索準備」で設定を入にすると、知らせに［検索索引作成／更新］が付き、押すと索引づくりが始まる
 *    （作品が1つなので選ぶ画面は出ずに索引ができる）。知らせに「検索用の索引を作る」の名前は出ない。
 *    ボタンの名前は 0.122.0 で動作の言葉「索引を作る」から命令の題へそろえた（作者の判断 2026-11-02）
 * 3. 詳細メニューの見出しの「他のメニューを閉じる」で「AIに相談」などを隠したあと、詳細メニュー
 *    →「作品執筆」→「相談・助言」→「AIに相談」（説明欄「横に開く」。0.122.0 で「相談パネルを開く」から
 *    名前をそろえた。作者の判断 2026-11-02）を押すと、隠れていたメニューが全部戻って
 *    相談パネルが開き、「相談パネルを開けませんでした」は出ない（「他のメニューを閉じる」は右クリックでなく
 *    見出しの「…」にある。件の中の断り書き）
 *
 * **本物の AI は呼ばない。** 手元の AI は偽の Ollama（答えは空。1・2では AI の答えまで進まない）。
 * Claude Code が入っている環境の初回の声かけ・道案内の題（339 の後半）は、入っているかどうかが
 * 機械によるので、ここでは見ない（作者の手に残す）。
 */
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { runCommand } from "./support/quickInput";
import { SIDEBAR_LAUNCH, contextMenuLabels, scrollTreeUntilRow, showSidebar, treeRow, treeRowLabels } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  dismissWorkbenchHover,
  notificationTexts,
  pickQuickPickRow,
  quickInputWaitContext,
  quickPickRows,
  quickPickTitle,
  waitForQuickPick,
} from "./support/workbenchDom";

const EPISODE = { name: "001_はじまり.txt", text: "　港の朝は早い。\n" };
const EMBED_MODEL = "bge-m3";

let fake: FakeOllama;
beforeAll(async () => {
  // 答えは空。どの件も AI の答えを使う所までは進まない（呼ばれたら数で分かる）
  fake = await startFakeOllama(() => "{}", { extraModels: [EMBED_MODEL] });
});
afterAll(async () => {
  await fake.close();
});

/* ── 1. 設定資料の無い作品の矛盾検知 ── */

test("設定資料が1件も無い作品で矛盾検知を押すと、AI を呼ばずに止まり、確認の窓に「先に「一括抽出」を実行してください。」が出る", async () => {
  await withVsCode(
    "設定資料の無い作品の矛盾検知",
    [EPISODE],
    async (session) => {
      const { page } = session;
      const before = fake.requests.length;
      await clearNotifications(page);
      await runCommand(page, "矛盾検知");
      /*
        **項目の前提と画面が違う所**：コマンドパレット・メニューから押すと、矛盾検知の本体
        （`checkContradictions.ts` の確認の窓「先に「一括抽出」を実行してください。」）より先に、
        前提の関所（`prerequisiteGate.ts`）の選ぶ画面「「矛盾検知」には「設定資料」が要ります」が出て、
        道が「いま「一括抽出」を実行する」になる。作者が押して見るのはこちらなので、ここを見る。
        どちらもメニューの名前「一括抽出」で案内していること（2026-11-01 の直しの中身）を確かめる
      */
      const gateTitle = "「矛盾検知」には「設定資料」が要ります";
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await quickPickTitle(page)) === gateTitle;
        },
        "設定資料が要ることの選ぶ画面が出る",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（窓：${JSON.stringify(await dialogText(page))}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
      });
      const rows = await quickPickRows(page);
      const labels = rows.map((row) => row.label);
      expect(labels, `選ぶ画面の行：${JSON.stringify(rows)}`).toContain("いま「一括抽出」を実行する");
      expect(JSON.stringify(rows), "メニューに無い名前で案内しています").not.toContain("まとめて抽出");
      // 設定が無いので「このまま実行する」は出さない（走っても機能の側が断るだけ）
      expect(labels.some((label) => label.startsWith("このまま")), `走れないのに「このまま実行する」があります：${JSON.stringify(labels)}`).toBe(false);
      await page.keyboard.press("Escape");
      await holdsFor(async () => (await dialogText(page)) === undefined, "取りやめたあとに確認の窓が出ない", 2_000);
      // AI の答えを求める呼び出し（/api/chat）はしていない
      expect(fake.requests.length - before, "設定資料が無いのに AI へ送りました").toBe(0);
    },
    fakeOllamaLaunch(fake)
  );
});

/* ── 2. ベクトル検索準備のあとの［検索索引作成／更新］ ── */

const READY_HEAD = "意味検索を入にしました。相談で使うには、作品ごとに検索索引が要ります。";
/** 知らせのボタン。詳細メニューの木の命令の題と同じ名前（`setupVectorSearch.ts` の `buildIndexLabel`） */
const BUILD_INDEX = "検索索引作成／更新";

test("ベクトル検索準備で設定を入にすると、知らせに［検索索引作成／更新］が付き、押すと作品の索引づくりへ進む", async () => {
  await withVsCode(
    "ベクトル検索準備のあとの索引づくり",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);
      await runCommand(page, "ベクトル検索準備");
      await waitForQuickPick(page, "相談で使う「意味検索」の準備", 20_000);
      await pickQuickPickRow(page, "設定を入にする");

      const toast = page.locator(".notification-toast", { hasText: READY_HEAD });
      await waitUntil(async () => (await toast.count()) > 0, "「意味検索を入にしました。」の知らせが出る", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      const texts = await notificationTexts(page);
      const notice = texts.find((text) => text.includes(READY_HEAD)) ?? "";
      expect(notice, `命令の名前を言っています：${notice}`).not.toContain("検索用の索引を作る");
      const buttons = await toast
        .first()
        .evaluate((node) => Array.from(node.querySelectorAll(".monaco-button")).map((button) => (button.textContent ?? "").trim()));
      expect(buttons, `知らせのボタン：${JSON.stringify(buttons)}`).toContain(BUILD_INDEX);

      const embedBefore = fake.embedRequests.length;
      await toast.first().locator(".monaco-button", { hasText: BUILD_INDEX }).first().click();
      /*
        索引づくりへ進む。作品が1つだけなので作品を選ぶ画面は出ず、そのまま索引ができる
        （作品が2つ以上なら選ぶ画面が出る——それは作者の手に残す）。埋め込みは偽の Ollama が答える
      */
      let built = "";
      await waitUntil(
        async () => {
          built = (await notificationTexts(page)).find((text) => text.startsWith("索引ができました")) ?? "";
          return built !== "";
        },
        "［検索索引作成／更新］を押すと、作品の索引ができる",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／窓：${JSON.stringify(await dialogText(page))}）${await quickInputWaitContext(page)}`
        );
      });
      expect(built, `索引の知らせ：${built}`).toContain("新しく1件");
      expect(fake.embedRequests.length - embedBefore, "索引づくりで埋め込みを頼んでいません").toBeGreaterThan(0);
    },
    fakeOllamaLaunch(fake, { settings: { "novelai.vectorSearch.enabled": false } })
  );
});

/* ── 3. 他のメニューを閉じたあとの相談パネル ── */

/**
 * 左の列に出ている区画の名前。区画が1つだけになると VS Code は区画の見出しを描かず、
 * 列の題（「統合小説執筆環境: 詳細メニュー」）に名前を寄せるので、そのときは列の題を返す
 */
async function paneHeaders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll(".part.sidebar .pane-header"))
      .filter((node) => (node as HTMLElement).offsetParent !== null)
      .map((node) => (node.querySelector(".title")?.textContent ?? node.textContent ?? "").trim());
    if (headers.length > 0) return headers;
    const title = (document.querySelector(".part.sidebar .composite.title")?.textContent ?? "").trim();
    return title ? [title] : [];
  });
}

/** 相談パネル（「相談の対象」を持つ面） */
async function chatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame.evaluate(() => document.getElementById("context-what") !== null).catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

test("詳細メニューの見出しの「…」の「他のメニューを閉じる」で相談を隠したあと、詳細メニューの「AIに相談」（横に開く）を押すと、隠れたメニューが全部戻って相談パネルが開く", async () => {
  await withVsCode(
    "他のメニューを閉じたあとの相談",
    [EPISODE],
    async (session) => {
      const { page } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      await clearNotifications(page);

      /*
        ── 詳細メニューの見出しの「…」（その他の操作）から「他のメニューを閉じる」 ──
        **項目の前提と画面が違う所**：見出しを右クリックすると、VS Code 本体の品書き（「Hide '詳細メニュー'」と
        区画の一覧）だけが出て、「他のメニューを閉じる」は無い（2026-11-02 この件を書いたときに確かめた）。
        製品は見出しの「…」の中（package.json の view/title、group 1_solo）に置いているので、そこから押す
      */
      const header = page.locator(".pane-header", { hasText: "詳細メニュー" }).first();
      await header.waitFor({ state: "visible", timeout: 15_000 });
      await dismissWorkbenchHover(page);
      await header.click({ button: "right" });
      await waitUntil(async () => (await contextMenuLabels(page)).length > 0, "見出しの右クリックの品書きが出る", 10_000);
      const rightClick = await contextMenuLabels(page);
      await page.keyboard.press("Escape");
      // 見出しに指を載せると「…」が出る
      await header.hover();
      const more = header.locator(".actions .action-label.codicon-toolbar-more, .actions .codicon-toolbar-more").first();
      await waitUntil(async () => (await more.count()) > 0 && (await more.isVisible()), "見出しに「…」（その他の操作）が出る", 10_000).catch(async (error: unknown) => {
        const actions = await header.evaluate((node) => Array.from(node.querySelectorAll(".actions .action-label")).map((el) => `${el.getAttribute("aria-label")}|${el.className}`));
        throw new Error(`${String(error)}（見出しの押し口：${JSON.stringify(actions)}／右クリックの品書き：${JSON.stringify(rightClick)}）`);
      });
      await more.click();
      /*
        「…」の品書きは影の DOM（shadow root）の中に描かれ、`document.querySelectorAll` では見えない。
        Playwright の locator は影の中まで探すので、そちらで探す
      */
      const soloItem = page.locator(".monaco-menu .action-label", { hasText: "他のメニューを閉じる" }).first();
      await waitUntil(async () => (await soloItem.count()) > 0 && (await soloItem.isVisible()), "見出しの「…」に「他のメニューを閉じる」が出る", 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（右クリックの品書き：${JSON.stringify(rightClick)}）`);
        }
      );
      await soloItem.click();
      await waitUntil(
        async () => {
          const shown = await paneHeaders(page);
          return shown.some((title) => title.includes("詳細メニュー")) && !shown.some((title) => title.includes("AIに相談") || title.includes("作品一覧"));
        },
        "詳細メニューだけが残り、AIに相談・作品一覧が隠れる",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（出ている見出し：${JSON.stringify(await paneHeaders(page))}）`);
      });

      /* ── 詳細メニュー →「作品執筆」→「相談・助言」→「AIに相談」（横に開く） ── */
      for (const head of ["作品執筆", "相談・助言"]) {
        const row = await scrollTreeUntilRow(page, "作品管理", head);
        await row.scrollIntoViewIfNeeded();
        if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
        await waitUntil(async () => (await row.getAttribute("aria-expanded")) === "true", `「${head}」が開く`, 10_000);
      }
      const open = await scrollTreeUntilRow(page, "相談・助言", "AIに相談");
      await open.scrollIntoViewIfNeeded();
      /*
        「AIに相談」は2つある（横に開く・大きく開く）。詳細メニューに出るのは横に開くほうだけで
        （大きく開くほうは `hiddenFromActionList`）、取り違えると別のパネルが開く。説明欄で確かめる
      */
      const openLabel = (await open.getAttribute("aria-label")) ?? "";
      expect(openLabel, `押す行の名前：${openLabel}`).toContain("横に開く");
      await open.click();

      await waitUntil(
        async () => {
          const shown = await paneHeaders(page);
          return (
            ["作品一覧", "簡単ステップメニュー", "詳細メニュー", "AIに相談"].every((title) => shown.some((entry) => entry.includes(title))) &&
            (await chatFrame(page)) !== undefined
          );
        },
        "隠れていたメニューが全部戻り、相談パネルが開く",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（出ている見出し：${JSON.stringify(await paneHeaders(page))}／知らせ：${JSON.stringify(await notificationTexts(page))}／行：${(await treeRowLabels(page)).slice(0, 12).join(" / ")}）`
        );
      });
      await holdsFor(
        async () => !(await notificationTexts(page)).some((text) => text.includes("相談パネルを開けませんでした")),
        "「相談パネルを開けませんでした」が出ない",
        3_000
      );
      // 行の名前で探す道具を使うので、取り違えていないことを念のため見る
      expect(await treeRow(page, E2E_WORK_TITLE).count(), "作品一覧の行が戻っていません").toBeGreaterThan(0);
    },
    SIDEBAR_LAUNCH
  );
});
