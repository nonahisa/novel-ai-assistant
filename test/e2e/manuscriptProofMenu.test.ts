/**
 * 原稿エディターの上の列の［校正］（画面の自動テスト、設計書6.25・6.113。実機確認リスト 0.122.0 の 362 行と、
 * 366 行のうち「誤字脱字（この話）」の保存の1行を機械へ移した。作者の判断 2026-11-02）。
 *
 * 1. ［校正］を押すと、ボタンの下に「誤字脱字（この話）」「推敲」「表記ゆれ（作品全体）」「まとめて校正（作品全体）」、
 *    区切りの下に「校正・メモパネルを開く」が並ぶ。もう一度押す・外（本文）を押す・Esc で閉じる
 * 2. 作品一覧で別の作品（作品B）を選んだまま、打ちかけ（未保存）のある原稿で「誤字脱字（この話）」を押すと、
 *    作品を訊かれず、実行の確認の窓（画面の上）が押した原稿の作品（作品A）で出て、
 *    「未保存の 1 件を保存してから実行します。」の1行が付く（右下の「未保存の変更が N 件あります」は出ない）。
 *    Esc で取りやめると保存されない。もう一度押して［実行］（Enter）で、保存してから作品Aの誤字脱字検知が走る
 * 3. 「推敲」は範囲の窓の先頭が「この話だけ」。「校正・メモパネルを開く」でその話の校正・メモパネルが横に開く
 *
 * **本物の AI は呼ばない。** 偽の Ollama（指摘0件）。縦書きと、窓を 400px ほどに狭めたときの崩れ・はみ出しは
 * 見た目なので作者の手に残す。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { clickToolButton, composeText, memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, notificationTexts, pressWorkbenchKey, quickInputWaitContext, quickPickRows, quickPickTitle } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";
const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";
const MENU_ITEMS = ["誤字脱字（この話）", "推敲", "表記ゆれ（作品全体）", "まとめて校正（作品全体）", "校正・メモパネルを開く"];
/** 確認の窓に出る、保存の1行（`views/notify.ts` の `presaveLine`。proofreadKeyFlow と同じ） */
const PRESAVE_LINE = "未保存の 1 件を保存してから実行します。";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => JSON.stringify({ issues: [] }));
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

async function menuOpen(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => document.getElementById("menu")?.classList.contains("open") ?? false);
}

async function menuItems(frame: Frame): Promise<{ items: string[]; rules: number }> {
  return frame.evaluate(() => {
    const menu = document.getElementById("menu");
    return {
      items: Array.from(menu?.querySelectorAll(".item") ?? []).map((node) => (node.textContent ?? "").trim()),
      rules: menu?.querySelectorAll(".rule").length ?? 0,
    };
  });
}

/** ［校正］を押して品書きを開く */
async function openProofMenu(frame: Frame): Promise<void> {
  await clickToolButton(frame, "proof");
  await waitUntil(() => menuOpen(frame), "［校正］の品書きが開く", 5_000);
}

/**
 * 本文（#compose）のうち、開いた品書き（#menu）に覆われていない点（#compose の左上からの位置）。
 * 品書きの右へ 40px ずらし、本文の幅に収まらなければ品書きの下を使う
 */
async function composePointBesideMenu(frame: Frame): Promise<{ x: number; y: number }> {
  const compose = await frame.locator("#compose").boundingBox();
  const menu = await frame.locator("#menu").boundingBox();
  if (!compose || !menu) throw new Error(`本文か品書きの位置が読めません（本文：${JSON.stringify(compose)}／品書き：${JSON.stringify(menu)}）`);
  const right = menu.x + menu.width + 40 - compose.x;
  if (right < compose.width - 10) return { x: right, y: 20 };
  const below = menu.y + menu.height + 40 - compose.y;
  if (below < compose.height - 10) return { x: 20, y: below };
  throw new Error(`品書きが本文を覆っていて、外を押せる所がありません（本文：${JSON.stringify(compose)}／品書き：${JSON.stringify(menu)}）`);
}

/** ［校正］の品書きの項目を押す */
async function pickProofItem(frame: Frame, label: string): Promise<void> {
  await openProofMenu(frame);
  await frame.locator("#menu .item", { hasText: label }).first().click();
}

/** 実行の確認の窓（画面の上の選ぶ窓）を待ち、題と行を合わせた字を返す */
async function waitRunConfirm(page: Page, label: string, from: number): Promise<string> {
  let text = "";
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const title = (await quickPickTitle(page)) ?? "";
      const rows = await quickPickRows(page);
      text = [title, ...rows.map((row) => row.label)].join("\n");
      return text.includes("件を処理します");
    },
    `${label}：実行の確認の窓が出る`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの窓：${JSON.stringify(text)}／知らせ：${JSON.stringify(await notificationTexts(page))}／${describeFakeRequests(fake.requests, from)}）${await quickInputWaitContext(page)}`);
  });
  return text;
}

test("［校正］の品書きは4つの校正と区切りの下の「校正・メモパネルを開く」で、押し直し・外・Esc で閉じ、作品一覧で別の作品を選んだままでも「誤字脱字（この話）」は原稿の作品で保存の1行つきの確認を出し、推敲は「この話だけ」が先頭、メモパネルも開く", async () => {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  await withVsCode(
    "原稿エディターの［校正］",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const from = fake.requests.length;

      /* 作品Bを登録して、作品一覧でそちらを選んだままにする */
      await page.keyboard.press(REGISTER_OTHER_PRESS);
      await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
      await clearNotifications(page);
      await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
      const rowB = page.locator(`.monaco-list-row[aria-label*="${OTHER_TITLE}"]`).first();
      await waitUntil(async () => (await rowB.count()) > 0, "作品一覧に作品Bの行が出る", 20_000);
      await rowB.click();

      const frame = await openEpisode(page, EPISODE, "静かだった");

      /* ── 1. 品書きの並びと閉じ方 ── */
      await openProofMenu(frame);
      const shown = await menuItems(frame);
      expect(shown.items, `［校正］の品書き：${JSON.stringify(shown)}`).toEqual(MENU_ITEMS);
      expect(shown.rules, "区切りが1本ではありません").toBe(1);
      // 区切りは「まとめて校正」と「校正・メモパネルを開く」の間
      const ruleAfter = await frame.evaluate(() => (document.querySelector("#menu .rule")?.previousElementSibling?.textContent ?? "").trim());
      expect(ruleAfter).toBe("まとめて校正（作品全体）");
      // もう一度押すと閉じる
      await clickToolButton(frame, "proof");
      await waitUntil(async () => !(await menuOpen(frame)), "［校正］を押し直すと品書きが閉じる", 5_000);
      // Esc で閉じる
      await openProofMenu(frame);
      await page.keyboard.press("Escape");
      await waitUntil(async () => !(await menuOpen(frame)), "Esc で品書きが閉じる", 5_000);
      // 外（本文）を押すと閉じる
      await openProofMenu(frame);
      /*
        0.145.0 の多段で［校正］が2段目へ下がり、品書きが本文の左上に重なるようになった。
        重なった所を押すのは「品書きの項目を押す」ことで、作者の画面でも同じ（製品の不具合ではない）。
        「外を押す」を確かめるので、品書きの右側の本文を押す
      */
      await frame.locator("#compose").click({ position: await composePointBesideMenu(frame) });
      await waitUntil(async () => !(await menuOpen(frame)), "外（本文）を押すと品書きが閉じる", 5_000);

      /* ── 2. 打ちかけのまま「誤字脱字（この話）」→ 作品Aで保存の1行つきの確認。Esc で保存しない ── */
      const mark = "【打ちかけ】";
      await placeCaretAfter(frame, "静かだった。");
      await page.keyboard.insertText(mark);
      await waitUntil(async () => (await composeText(frame)).includes(mark), "打った字が面に出る");
      await pickProofItem(frame, "誤字脱字（この話）");
      const confirm = await waitRunConfirm(page, "誤字脱字（この話）", from);
      expect(confirm, `確認が原稿の作品（作品A）で出ていません：${confirm}`).toContain(E2E_WORK_TITLE);
      expect(confirm, `確認に作品一覧で選んだ作品Bが出ています：${confirm}`).not.toContain(OTHER_TITLE);
      expect(confirm, `確認に保存の1行がありません：${confirm}`).toContain(PRESAVE_LINE);
      expect((await notificationTexts(page)).some((text) => text.includes("保存してから実行しますか")), "右下に「保存してから実行しますか？」が出ました").toBe(false);
      await page.keyboard.press("Escape");
      await holdsFor(async () => !(await readEpisode(session)).includes(mark) && (await quickPickTitle(page)) === undefined, "Esc で取りやめると保存されない", 2_500);
      expect(await actionLog(session), "取りやめたのに誤字脱字検知が始まりました").not.toContain("誤字脱字検知を開始:");

      /* ── もう一度押して［実行］（Enter）で、保存してから作品Aで走る ── */
      await pickProofItem(frame, "誤字脱字（この話）");
      const again = await waitRunConfirm(page, "誤字脱字（この話）・2回目", from);
      expect(again).toContain(PRESAVE_LINE);
      // ［校正］から押すと焦点は原稿の面に残り、Enter が確認の窓に届かない。先頭の［実行］の行を押す
      const first = page.locator(".quick-input-widget .quick-input-list .monaco-list-row").first();
      expect(((await first.innerText()) ?? "").trim(), "確認の先頭が［実行］ではありません").toMatch(/^実行$/);
      await first.click();
      await waitUntil(async () => (await readEpisode(session)).includes(mark), "［実行］で打った字がファイルに保存される", 20_000);
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await actionLog(session)).includes(`誤字脱字検知を開始: ${E2E_WORK_TITLE} /`);
        },
        "作品Aで誤字脱字検知が始まる",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（操作の記録の終わり：${(await actionLog(session)).split("\n").slice(-10).join(" ／ ")}）${await quickInputWaitContext(page)}`);
      });
      // 「開始」の記録は AI へ頼む直前に書かれるので、頼みが届くまで待つ
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return fake.requests.length > from;
        },
        "偽の AI に誤字脱字の頼みが届く",
        30_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}\n${describeFakeRequests(fake.requests, from)}`);
      });
      await clearNotifications(page);

      /* ── 3. 「推敲」は範囲の窓の先頭が「この話だけ」 ── */
      const front = await openEpisode(page, EPISODE, mark);
      await pickProofItem(front, "推敲");
      await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("どこまで見ますか"), "推敲の範囲の窓が出る", 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
      });
      const scope = await quickPickRows(page);
      expect(scope[0]?.label, `範囲の窓の先頭：${JSON.stringify(scope)}`).toContain("この話だけ");
      expect(scope[0]?.label).toContain(EPISODE);
      await page.keyboard.press("Escape");
      await waitUntil(async () => (await quickPickTitle(page)) === undefined, "範囲の窓が閉じる", 5_000);

      /* ── 「校正・メモパネルを開く」でその話の校正・メモパネルが開く ── */
      await pickProofItem(front, "校正・メモパネルを開く");
      await waitUntil(async () => (await memoPanelFrame(page)) !== undefined, "校正・メモパネルが開く", 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
      });
      expect(await quickPickTitle(page), "メモパネルを開くのに作品を訊かれました").toBeUndefined();
    },
    fakeOllamaLaunch(fake, {
      ...SIDEBAR_LAUNCH,
      keybindings: [...SIDEBAR_LAUNCH.keybindings, registerOther],
      prepareWork: async ({ workFolder }) => {
        const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
        await mkdir(path.join(otherFolder, "本文"), { recursive: true });
        await writeFile(path.join(otherFolder, "本文", "001_別の作品.txt"), "　別の作品の本文。\n", "utf8");
        registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
      },
    })
  );
}, 300_000);
