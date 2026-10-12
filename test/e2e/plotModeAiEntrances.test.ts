/**
 * プロットモードの AI の入口（画面の自動テスト、設計書6.4.7・6.4.8・6.113。実機確認リスト 578・5673 行を、
 * 仕分け 2026-10-12 の束 E5 として移した。作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 1. 578：「名前の候補を出す」で候補を考えている間、［名前の候補を出す］が押せなくなり、一文が
 *    「名前の候補を考えています…」になる。答えが返ると押せる形に戻り、人物ごとに「選ばない」（既定）＋候補
 *    （名前・読み・一言）が並び、資料にいる名前と重なった候補は「落とした候補 1件」に理由つきで畳まれる。
 *    **考えている間を見るため、偽の AI の答えはテストが解くまで止めておく**（一瞬で返すと見る隙が無い。
 *    2026-10-10 の写真撮りでは短くて撮れなかった）
 * 2. 5673：プロットモードの AI のボタン「プロット逆算」「対話式プロット作成」が、**作品を訊かずに**、
 *    プロットモードを開いた作品で始まる。作品を2つ登録し、別の作品の話を前に出してから押す——
 *    ボタンが作品を渡していなければ、前に出ている話の作品で始まるか、作品を訊かれる。
 *    「プロット逆算」は処理量の確認（題に作品名）まで進めて取りやめる（AI は呼ばない）。
 *    「対話式プロット作成」は相談パネルに型を選ぶ一言（「「作品名」のプロットを、問答で一緒に考えます」）が出る
 *    ところまで（ここも AI は呼ばない）。「形式とジャンルを決める」は AI を使わず、2026-09-11 に確認済み
 *
 * **本物の AI は呼ばない**（偽の Ollama）。名前の出来は見えない。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import {
  EXISTING_PERSON,
  FIRST_CANDIDATES,
  isPlotNamesRequest,
  LEDGER_ROLE,
  openPlotMode,
  plotNamesAnswer,
  preparePlotWork,
  startNameSuggest,
  waitNameResults,
} from "./support/plotNames";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, quickInputWaitContext, quickOpen, quickPickRows, quickPickTitle } from "./support/workbenchDom";

/** 名前の候補の答えを止めておく栓。`release` で解く */
let releaseNames: (() => void) | undefined;
let namesGate: Promise<void> = Promise.resolve();

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(async (request) => {
    if (isPlotNamesRequest(request)) {
      await namesGate;
      return plotNamesAnswer(request);
    }
    return "{}";
  });
});
afterAll(async () => {
  releaseNames?.();
  await fake.close();
});

function plotLaunch(extra: LaunchOptions = {}): LaunchOptions {
  return fakeOllamaLaunch(fake, {
    ...SIDEBAR_LAUNCH,
    ...extra,
    settings: {
      ...SIDEBAR_LAUNCH.settings,
      // plot.md は作者の既定どおり素のテキストエディターで開く（6.4.8）
      "workbench.editorAssociations": { "*.txt": "novelai.manuscriptEditorHorizontal", "*.md": "default" },
      ...extra.settings,
    },
    keybindings: [...SIDEBAR_LAUNCH.keybindings, ...(extra.keybindings ?? [])],
  });
}

/* ── 1. 名前の候補を考えている間 ── */

test("「名前の候補を出す」で考えている間はボタンが押せず、答えが返ると「選ばない」＋候補が並び、資料と重なった候補が「落とした候補 1件」に理由つきで畳まれる", async () => {
  namesGate = new Promise<void>((resolve) => {
    releaseNames = resolve;
  });
  await withVsCode(
    "名前の候補を考えている間",
    [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
    async (session) => {
      const plot = await openPlotMode(session);
      await startNameSuggest(session, plot, () => fake.requests.some(isPlotNamesRequest));

      /* ── 偽の AI が答えを止めている間 ── */
      const button = plot.locator("[data-suggest-names]");
      await waitUntil(async () => await button.isDisabled(), "考えている間、［名前の候補を出す］が押せなくなる", 10_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（ボタン：${await button.evaluate((node) => node.outerHTML).catch(() => "見つからない")}／一文：${JSON.stringify(await plot.locator("#namesNote").innerText().catch(() => ""))}）`);
      });
      expect(await plot.locator("#namesNote").innerText(), "考えている間の一文が出ていません").toContain("名前の候補を考えています");
      // 止めている間は押せないまま（あとから押せる形に戻らない）
      await holdsFor(async () => await button.isDisabled(), "答えを待つ間、ボタンが押せないまま", 1_500);

      /* ── 答えを解く ── */
      releaseNames?.();
      await waitNameResults(plot);
      expect(await button.isEnabled(), "答えが返ったのに、ボタンが押せないままです").toBe(true);

      /* ── 主人公の欄：「選ばない」が先頭で選ばれており、候補が名前・読み・一言で並ぶ ── */
      const person = plot.locator(".name-person", { hasText: "主人公" }).first();
      const radios = person.locator('input[type="radio"]');
      expect(await radios.first().isChecked(), "先頭の「選ばない」が既定で選ばれていません").toBe(true);
      expect(await person.locator("label").first().innerText()).toContain("選ばない");
      const text = (await person.innerText()).replace(/\s+/g, " ");
      // 読みの空白は製品が揃えることがあるので、空白を抜いて比べる
      const packed = text.replace(/\s+/g, "");
      for (const candidate of FIRST_CANDIDATES.slice(0, 2)) {
        expect(packed, `候補「${candidate.name}」が名前・読み・一言で並んでいません：${text}`).toContain(
          `${candidate.name}（${candidate.reading}）${candidate.note}`.replace(/\s+/g, "")
        );
      }
      // 資料にいる「白瀬 灯」と同じ候補は、候補の丸には並ばず「落とした候補 1件」に畳まれる
      expect(await radios.count(), `丸の数が「選ばない」＋残った候補2件ではありません：${text}`).toBe(3);
      const dropped = person.locator("details");
      expect((await dropped.locator("summary").innerText()).replace(/\s+/g, " ").trim()).toBe("落とした候補 1件");
      expect(await dropped.evaluate((node) => (node as HTMLDetailsElement).open), "落とした候補が畳まれていません").toBe(false);
      await dropped.locator("summary").click();
      const reason = (await dropped.innerText()).replace(/\s+/g, " ");
      expect(reason, `落とした理由が出ていません：${reason}`).toContain(`${EXISTING_PERSON.name}：「${EXISTING_PERSON.name}」と重なります`);
    },
    plotLaunch({ prepareWork: async ({ workFolder }) => preparePlotWork(workFolder, [EXISTING_PERSON, LEDGER_ROLE]) })
  );
});

/* ── 2. AI の入口は作品を訊かずに始まる ── */

const OTHER_TITLE = "作品B";
const OTHER_EPISODE = "001_別の作品.txt";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";

/** 相談パネル（横）の会話の字。開いていなければ空 */
async function sideChatLog(page: Page): Promise<string> {
  for (const frame of page.frames()) {
    const text = await frame
      .evaluate(() => (document.getElementById("to-main") !== null ? document.getElementById("log")?.innerText ?? "" : undefined))
      .catch(() => undefined);
    if (text !== undefined) return text;
  }
  return "";
}

test("プロットモードの「プロット逆算」「対話式プロット作成」は、別の作品の話を前に出していても、作品を訊かずにプロットモードの作品で始まる", async () => {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  await withVsCode(
    "プロットモードのAIの入口",
    [{ name: "第1話_はじまり.txt", text: "　朝の港で、少年は船を見上げた。\n" }],
    async (session) => {
      const { page } = session;
      await page.keyboard.press(REGISTER_OTHER_PRESS);
      await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
      await clearNotifications(page);

      const plot: Frame = await openPlotMode(session);
      // 別の作品（作品B）の話を前に出す。ボタンが作品を渡していなければ、こちらの作品で始まるか、作品を訊かれる
      await quickOpen(page, OTHER_EPISODE);

      /* ── 「プロット逆算」：処理量の確認に、プロットモードの作品名が出る ── */
      const titles: string[] = [];
      await plot.locator('button[data-command="novelai.generatePlot"]').click();
      let confirm = "";
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const title = (await quickPickTitle(page)) ?? "";
          if (title !== "" && titles[titles.length - 1] !== title) titles.push(title);
          confirm = [title, ...(await quickPickRows(page)).map((row) => row.label)].join(" ／ ");
          return confirm.includes("のプロットを、書いた本文から組み立て直します");
        },
        "「プロット逆算」の処理量の確認が出る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（通った選ぶ画面：${JSON.stringify(titles)}）${await quickInputWaitContext(page)}`);
      });
      expect(titles.length, `確認の前に別の選ぶ画面が出ました（作品を訊かれた形）：${JSON.stringify(titles)}`).toBe(1);
      expect(confirm, `確認がプロットモードの作品のものではありません：${confirm}`).toContain(E2E_WORK_TITLE);
      expect(confirm, `確認が作品Bのものになっています：${confirm}`).not.toContain(OTHER_TITLE);
      expect(fake.requests.length, "確認の前に AI が呼ばれました").toBe(0);
      // 取りやめる（AI は呼ばない）
      await page.keyboard.press("Escape");
      await waitUntil(async () => (await quickPickTitle(page)) === undefined, "確認を Esc で閉じる", 10_000);

      /* ── 「対話式プロット作成」：相談パネルに、プロットモードの作品の問答が始まる ── */
      await quickOpen(page, OTHER_EPISODE);
      await plot.locator('button[data-command="novelai.plotInterview"]').click();
      const opening = `「${E2E_WORK_TITLE}」のプロットを、問答で一緒に考えます`;
      await waitUntil(async () => (await sideChatLog(page)).includes(opening), "相談パネルに、プロットモードの作品の問答の一言が出る", 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（相談パネルの会話：${JSON.stringify((await sideChatLog(page)).slice(-400))}）${await quickInputWaitContext(page)}`);
      });
      await holdsFor(async () => (await quickPickTitle(page)) === undefined, "対話式プロット作成で、作品を選ぶ画面が出ない", 2_000);
      expect(await sideChatLog(page), "問答が作品Bで始まっています").not.toContain(`「${OTHER_TITLE}」のプロット`);
      expect(fake.requests.length, "問答の始めに AI が呼ばれました（型を選ぶまではコードが答える）").toBe(0);
    },
    plotLaunch({
      keybindings: [registerOther],
      prepareWork: async ({ workFolder }) => {
        await preparePlotWork(workFolder, [EXISTING_PERSON, LEDGER_ROLE]);
        // 「プロット逆算」は各話あらすじを材料にする。無いと確認の前に止まる
        await writeFile(
          path.join(workFolder, "設定", "chapter_synopses.json"),
          JSON.stringify({ schemaVersion: "0.1", episodes: [{ chapter: 1, fileName: "第1話_はじまり.txt", title: "はじまり", synopsis: "少年が朝の港で船を見上げる。" }] }, null, 2),
          "utf8"
        );
        // 作品B（keybindings.json はこの準備のあとに書かれるので、置き場はここで args へ入れる）
        const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
        await mkdir(path.join(otherFolder, "本文"), { recursive: true });
        await writeFile(path.join(otherFolder, "本文", OTHER_EPISODE), "　別の作品の本文。\n", "utf8");
        registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
      },
    })
  );
});
