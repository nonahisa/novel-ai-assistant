/**
 * 未保存があるまま検知・抽出を押したときの「保存の1行」の残り（画面の自動テスト、設計書6.80・6.113。
 * 実機確認リスト 0.122.0 の 374 行のうち、proofreadKeyFlow〔推敲〕と manuscriptProofMenu〔誤字脱字（この話）〕が
 * 見ていない所。作者の判断 2026-11-02「保存の問いは実行の確認の窓の1行にまとめる」）。
 *
 * 1. 誤字脱字（作品）：右下の「未保存の変更が N 件あります…」は出ず、実行の確認の窓（画面の上）に
 *    「未保存の 1 件を保存してから実行します。」。Esc で取りやめると保存されず（タブの●が残る）、［実行］で保存して走る
 * 2. 校正をまとめて実行：選ぶ画面で誤字脱字だけを選ぶと、確認に同じ1行が出る。Esc で保存されず、［実行］で保存する。
 *    **項目の文との違い**：まとめて校正の確認は画面の上の選ぶ窓でなく、真ん中の確認の窓（モーダル）に出る
 *    （`features/proofreadingSuite.ts`。量と料金の確認を1枚で見せる窓。2026-11-02 この件を書いたときの画面）
 * 3. 設定資料の抽出：人物設定の JSON を未保存のまま押しても「未保存の人物設定があります」で止まらず、
 *    同じ確認の窓に保存の1行が出て、［実行］で JSON が保存される（●が消える）
 * 4. 「以降は訊かない」を覚えている誤字脱字でも、未保存があると確認の窓が出る（そのときは「以降は訊かない」を並べない）。
 *    未保存が無ければ訊かずに走る（覚え書きが効いていることの対照）
 *
 * **本物の AI は呼ばない。** ［実行］のあとは偽の Ollama（指摘0件・空の抽出）が答える。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { emptyCharacter, type Character } from "../../src/models/character";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { composeText, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { runCommand } from "./support/quickInput";
import { defaultCharactersFolder, writeCharactersTo } from "./support/settingsFixture";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  acceptQuickPick,
  closeDialog,
  dialogText,
  focusTextEditor,
  notificationTexts,
  pressDialogButton,
  quickInputWaitContext,
  quickOpen,
  quickPickRows,
  quickPickTitle,
  tabIsDirty,
  toggleQuickPickRow,
  waitForQuickPick,
} from "./support/workbenchDom";
import { EDITOR_BOTTOM_PRESS } from "./support/keys";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";
const MARK = "【打ちかけ】";
/** 確認の窓に出る、保存の1行（`views/notify.ts` の `presaveLine`） */
const PRESAVE_LINE = "未保存の 1 件を保存してから実行します。";
/** 以前の、右下の知らせの問い（出てはいけない） */
const OLD_NOTICE = "保存してから実行しますか";

let fake: FakeOllama;
beforeAll(async () => {
  // 誤字脱字は指摘0件。抽出は空（どちらも答えの中身は見ない。見るのは保存と確認の窓）
  fake = await startFakeOllama((request) => (request.user.includes("誤字") || request.system.includes("誤字") ? JSON.stringify({ issues: [] }) : "{}"));
});
afterAll(async () => {
  await fake.close();
});

async function readEpisode(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

async function actionLog(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

/** 原稿エディターで打ちかけ（未保存）を作り、タブに●が付くまで待つ */
async function typeUnsaved(page: Page): Promise<void> {
  const frame = await openEpisode(page, EPISODE, "静かだった");
  await placeCaretAfter(frame, "静かだった。");
  await page.keyboard.insertText(MARK);
  await waitUntil(async () => (await composeText(frame)).includes(MARK), "打った字が面に出る");
  await waitUntil(async () => tabIsDirty(page, EPISODE), "原稿のタブに未保存の印（●）が付く", 10_000);
}

/** 実行の確認の窓（画面の上の選ぶ窓）を待ち、題と行を合わせた字と行の名前を返す */
async function waitRunConfirm(page: Page, label: string, from: number): Promise<{ text: string; rows: string[] }> {
  let text = "";
  let rows: string[] = [];
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      rows = (await quickPickRows(page)).map((row) => row.label);
      text = [(await quickPickTitle(page)) ?? "", ...rows].join("\n");
      return text.includes("件を処理します");
    },
    `${label}：実行の確認の窓が出る`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}／知らせ：${JSON.stringify(await notificationTexts(page))}／${describeFakeRequests(fake.requests, from)}）${await quickInputWaitContext(page)}`);
  });
  return { text, rows };
}

/** 確認の窓の［実行］の行を押す（焦点がどこにあっても届くように、Enter でなく行を押す） */
async function pressRun(page: Page): Promise<void> {
  let index = -1;
  await waitUntil(async () => (index = (await quickPickRows(page)).findIndex((row) => row.label === "実行")) >= 0, "確認の窓に［実行］の行がある", 5_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（行：${JSON.stringify(await quickPickRows(page))}）`);
  });
  await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").nth(index).click();
}

/** 右下に以前の問い（保存してから実行しますか）が出ていないこと */
async function expectNoOldNotice(page: Page, label: string): Promise<void> {
  const notices = await notificationTexts(page);
  expect(notices.some((text) => text.includes(OLD_NOTICE)), `${label}：右下に「${OLD_NOTICE}」が出ました（${JSON.stringify(notices)}）`).toBe(false);
}

test("未保存のまま「誤字脱字検知」（作品）を押すと、右下の問いは出ず確認の窓に保存の1行が出て、Esc では保存されず（●が残る）、［実行］で保存して走る", async () => {
  await withVsCode(
    "保存の1行：誤字脱字（作品）",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const from = fake.requests.length;
      await typeUnsaved(page);

      await runCommand(page, "誤字脱字検知");
      const confirm = await waitRunConfirm(page, "誤字脱字（作品）", from);
      expect(confirm.text, `確認に保存の1行がありません：${confirm.text}`).toContain(PRESAVE_LINE);
      expect(confirm.text, `確認に作品名がありません：${confirm.text}`).toContain(E2E_WORK_TITLE);
      await expectNoOldNotice(page, "誤字脱字（作品）");

      await page.keyboard.press("Escape");
      await holdsFor(
        async () => !(await readEpisode(session)).includes(MARK) && (await tabIsDirty(page, EPISODE)) && (await quickPickTitle(page)) === undefined,
        "Esc で取りやめると保存されず、タブの●が残る",
        2_500
      );
      expect(await actionLog(session), "取りやめたのに誤字脱字検知が始まりました").not.toContain("誤字脱字検知を開始:");

      await runCommand(page, "誤字脱字検知");
      const again = await waitRunConfirm(page, "誤字脱字（作品）・2回目", from);
      expect(again.text).toContain(PRESAVE_LINE);
      await pressRun(page);
      await waitUntil(async () => (await readEpisode(session)).includes(MARK), "［実行］で打った字がファイルに保存される", 20_000);
      await waitUntil(async () => !(await tabIsDirty(page, EPISODE)), "［実行］でタブの●が消える", 10_000);
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await actionLog(session)).includes("誤字脱字検知を開始:");
        },
        "保存したあと誤字脱字検知が始まる",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（操作の記録の終わり：${(await actionLog(session)).split("\n").slice(-10).join(" ／ ")}）${await quickInputWaitContext(page)}`);
      });
    },
    fakeOllamaLaunch(fake)
  );
}, 240_000);

test("未保存のまま「校正一括実行」で誤字脱字を選ぶと、右下の問いは出ず確認の窓に保存の1行が出て、Esc では保存されず、［実行］で保存する", async () => {
  await withVsCode(
    "保存の1行：まとめて校正",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await typeUnsaved(page);

      /** 選ぶ画面で誤字脱字だけを選んで決め、確認の窓（真ん中）の文を返す */
      const openSuiteConfirm = async (label: string): Promise<string> => {
        await runCommand(page, "校正一括実行");
        const rows = await waitForQuickPick(page, `校正をまとめて実行：${E2E_WORK_TITLE}`, 20_000);
        for (const row of rows) {
          const wanted = row.label === "誤字脱字";
          if (row.checked !== wanted) await toggleQuickPickRow(page, row.label);
        }
        await acceptQuickPick(page);
        let text = "";
        await waitUntil(async () => (text = (await dialogText(page)) ?? "").includes("走らせるもの"), `${label}：まとめて校正の確認の窓が出る`, 30_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
        });
        return text;
      };

      const confirm = await openSuiteConfirm("1回目");
      expect(confirm, `確認に保存の1行がありません：${confirm}`).toContain(PRESAVE_LINE);
      await expectNoOldNotice(page, "まとめて校正");
      await closeDialog(page);
      await holdsFor(async () => !(await readEpisode(session)).includes(MARK) && (await tabIsDirty(page, EPISODE)), "Esc で取りやめると保存されず、タブの●が残る", 2_500);

      const again = await openSuiteConfirm("2回目");
      expect(again).toContain(PRESAVE_LINE);
      await pressDialogButton(page, "実行");
      await waitUntil(async () => (await readEpisode(session)).includes(MARK), "［実行］で打った字がファイルに保存される", 20_000);
      await waitUntil(async () => !(await tabIsDirty(page, EPISODE)), "［実行］でタブの●が消える", 10_000);
      // 中の誤字脱字は確認を省いて走る（まとめ側が確認済み）。始まったことだけ見て、終わりは待たない
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await actionLog(session)).includes("誤字脱字検知を開始:");
        },
        "まとめて校正の中で誤字脱字検知が始まる",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（操作の記録の終わり：${(await actionLog(session)).split("\n").slice(-10).join(" ／ ")}）${await quickInputWaitContext(page)}`);
      });
    },
    fakeOllamaLaunch(fake)
  );
}, 240_000);

const CHARACTER: Character = { ...emptyCharacter("char_001", "あかり"), autoGenerated: false };

test("人物設定の JSON を未保存のまま「一括抽出」を押すと、「未保存の人物設定があります」で止まらず確認の窓に保存の1行が出て、［実行］で JSON が保存される", async () => {
  let characterFile = "";
  await withVsCode(
    "保存の1行：設定資料の抽出",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const from = fake.requests.length;
      const name = path.basename(characterFile);
      await quickOpen(page, name);
      await waitUntil(async () => (await page.locator(".monaco-editor .view-lines", { hasText: "あかり" }).count()) > 0, "人物設定の JSON が素のエディターで開く", 15_000);
      await focusTextEditor(page);
      // JSON を壊さない字（末尾の改行）を足して未保存にする
      await page.keyboard.press(EDITOR_BOTTOM_PRESS);
      await page.keyboard.press("Enter");
      await waitUntil(async () => tabIsDirty(page, name), "人物設定の JSON のタブに●が付く", 10_000);
      const before = await readFile(characterFile, "utf8");

      await runCommand(page, "一括抽出");
      const confirm = await waitRunConfirm(page, "設定資料の抽出", from);
      expect(confirm.text, `確認に保存の1行がありません：${confirm.text}`).toContain(PRESAVE_LINE);
      const notices = await notificationTexts(page);
      expect(notices.some((text) => text.includes("未保存の人物設定があります")), `「未保存の人物設定があります」で止まりました（${JSON.stringify(notices)}）`).toBe(false);
      await expectNoOldNotice(page, "設定資料の抽出");

      await pressRun(page);
      await waitUntil(async () => !(await tabIsDirty(page, name)), "［実行］で人物設定の JSON のタブの●が消える", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
      });
      expect((await readFile(characterFile, "utf8")).length, "保存しても JSON のファイルが変わっていません").toBeGreaterThan(before.length);
      const after = await notificationTexts(page);
      expect(after.some((text) => text.includes("未保存の人物設定があります")), `保存のあと「未保存の人物設定があります」が出ました（${JSON.stringify(after)}）`).toBe(false);
    },
    fakeOllamaLaunch(fake, {
      prepareWork: async ({ workFolder }) => {
        [characterFile] = await writeCharactersTo(defaultCharactersFolder(workFolder), [CHARACTER]);
      },
    })
  );
}, 240_000);

test("「以降は訊かない」を覚えている誤字脱字は、未保存が無ければ訊かずに走り、未保存があると確認の窓が出て保存の1行が付き「以降は訊かない」は並ばない", async () => {
  await withVsCode(
    "保存の1行：以降は訊かない",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const from = fake.requests.length;

      /* ── 対照：未保存が無ければ訊かずに走る ── */
      await runCommand(page, "誤字脱字検知");
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await actionLog(session)).includes("確認を省略（以降は訊かない）: ai.run.checkTypos");
        },
        "未保存が無いと確認を省いて走る（操作の記録に「確認を省略（以降は訊かない）」）",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（操作の記録の終わり：${(await actionLog(session)).split("\n").slice(-10).join(" ／ ")}）${await quickInputWaitContext(page)}`);
      });
      await waitUntil(async () => fake.requests.length > from, "偽の AI に誤字脱字の頼みが届く", 30_000);

      /* ── 未保存があると確認の窓が出る ── */
      await typeUnsaved(page);
      await runCommand(page, "誤字脱字検知");
      const confirm = await waitRunConfirm(page, "以降は訊かない・未保存あり", from);
      expect(confirm.text, `確認に保存の1行がありません：${confirm.text}`).toContain(PRESAVE_LINE);
      expect(confirm.rows, `確認の行：${JSON.stringify(confirm.rows)}`).toContain("実行");
      expect(confirm.rows.some((row) => row.includes("以降は訊かない")), `覚えている回に「以降は訊かない」が並んでいます：${JSON.stringify(confirm.rows)}`).toBe(false);
      await expectNoOldNotice(page, "以降は訊かない・未保存あり");
      expect(await actionLog(session)).toContain("未保存の文書を保存するので確認を出す（以降は訊かないを覚えていても）");

      await pressRun(page);
      await waitUntil(async () => (await readEpisode(session)).includes(MARK), "［実行］で打った字がファイルに保存される", 20_000);
      await waitUntil(async () => !(await tabIsDirty(page, EPISODE)), "［実行］でタブの●が消える", 10_000);
    },
    fakeOllamaLaunch(fake, { settings: { "novelai.confirm.remembered": { "ai.run.checkTypos": "実行" } } })
  );
}, 240_000);
