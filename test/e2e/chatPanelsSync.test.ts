/**
 * 相談パネル（横）と大きい画面を同時に開いたときの同期と、「会話をメモに保存」
 * （画面の自動テスト、設計書6.21・6.113。実機確認リスト F-23 の
 * 「横のパネルと大きい画面を同時に開いて質問すると、もう片方にも発言と答えが出るか」
 * 「『会話をメモに保存』で 設定/相談メモ/相談 <日付>.md が新規にでき、開いて見えるか。
 * 同じ分に2回保存しても上書きされず別名になるか」を 2026-10-09 に移した）。
 *
 * 何を見張るか：
 * - 横のパネル（`novelai.openChat`）と大きい画面（`novelai.openChatPanel`）を両方開き、
 *   大きい画面で質問すると、**横のパネルにも**その発言と（偽の AI の）答えが出る
 * - 大きい画面の「会話をメモに保存」で `設定/相談メモ/相談 <日付>.md` が新規にでき、
 *   そのファイルがエディターのタブとして開く（中身は会話）
 * - 同じ分に続けて2回保存しても、1回目のファイルは上書きされず、別名の2つ目ができる
 *
 * **本物の AI は呼ばない。** 偽の Ollama（`support/fakeOllama.ts`）が決まった答えを返す
 * ——答えの出来は見えない（AI の測定の仕事）。見えるのは、答えが返ったあとの画面の配線だけ。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { activeTabNames, clearNotifications, editorGroupTabs, pressWorkbenchKey, tabNamesInclude } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const OPEN_SIDE_KEY = "ctrl+alt+shift+c";
const OPEN_SIDE_PRESS = "Control+Alt+Shift+KeyC";
const OPEN_LARGE_KEY = "ctrl+alt+shift+h";
const OPEN_LARGE_PRESS = "Control+Alt+Shift+KeyH";

const QUESTION = "主人公の名前の由来を考えてください";
const ANSWER = "偽のAIの答えです：名前は朝の駅にちなんで付けましょう。";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => ANSWER);
});
afterAll(async () => {
  await fake.close();
});

/** 相談パネルの面（`#context-what` を持つ）。大きい画面は `#to-sub`、横は `#to-main` を持つ */
async function chatFrames(page: Page): Promise<{ side?: Frame; large?: Frame }> {
  const found: { side?: Frame; large?: Frame } = {};
  for (const frame of page.frames()) {
    const kind = await frame
      .evaluate(() => {
        if (document.getElementById("context-what") === null) return "";
        if (document.getElementById("to-sub") !== null) return "large";
        if (document.getElementById("to-main") !== null) return "side";
        return "";
      })
      .catch(() => "");
    if (kind === "large") found.large = frame;
    if (kind === "side") found.side = frame;
  }
  return found;
}

/** 会話の欄（`#log`）に出ている字 */
async function logText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("log")?.innerText ?? "");
}

async function noteFiles(workFolder: string): Promise<string[]> {
  const names = await readdir(path.join(workFolder, "設定", "相談メモ")).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".md")).sort();
}

test("横のパネルと大きい画面を同時に開いて質問すると両方に出て、「会話をメモに保存」は新規にでき、同じ分の2回目は別名になる", async () => {
  await withVsCode(
    "相談パネルの同期",
    [{ name: EPISODE, text: "　朝の駅は静かだった。\n" }],
    async (session) => {
      const { page, workFolder } = session;

      /* ── 横のパネルと大きい画面を、両方開く ── */
      await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
      await waitUntil(async () => (await chatFrames(page)).side !== undefined, "横の相談パネルが開く", 30_000);
      await pressWorkbenchKey(page, OPEN_LARGE_PRESS);
      await waitUntil(async () => (await chatFrames(page)).large !== undefined, "大きい相談画面が開く", 30_000);
      const { side, large } = await chatFrames(page);
      if (!side || !large) throw new Error("相談パネルの面が見つかりません");
      // 作品が決まるまで待つ（「相談の対象」に作品名が出る）
      await waitUntil(
        async () => (await large.evaluate(() => document.getElementById("context-what")?.textContent ?? "")).includes(E2E_WORK_TITLE),
        "大きい画面の「相談の対象」に作品名が出る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの対象：${JSON.stringify(await large.evaluate(() => document.getElementById("context-what")?.textContent ?? ""))}）`);
      });

      /* ── 大きい画面で質問する ── */
      await large.locator("#input").click();
      await page.keyboard.insertText(QUESTION);
      await large.locator("#send").click();

      /* ── 大きい画面にも横のパネルにも、発言と答えが出る ── */
      for (const [name, frame] of [
        ["大きい画面", large],
        ["横のパネル", side],
      ] as const) {
        await waitUntil(async () => (await logText(frame)).includes(QUESTION), `${name}に質問が出る`, 30_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（${name}の会話：${JSON.stringify(await logText(frame))}）`);
        });
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            return (await logText(frame)).includes(ANSWER);
          },
          `${name}に答えが出る`,
          60_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（${name}の会話：${JSON.stringify(await logText(frame))}）`);
        });
      }
      expect(fake.requests.length, "偽のAIに質問が届いていません").toBeGreaterThan(0);

      /* ── 「会話をメモに保存」：新規にでき、開いて見える ── */
      await clearNotifications(page);
      // 2回の保存が同じ分に収まるよう、分の終わり際（40秒より後）は次の分まで待つ
      await waitUntil(async () => new Date().getSeconds() < 40, "同じ分に2回保存できる秒まで待つ", 30_000);
      await large.locator("#save-note").click();
      await waitUntil(async () => (await noteFiles(workFolder)).length === 1, "設定/相談メモ/ に相談メモが1つできる", 30_000);
      const [first] = await noteFiles(workFolder);
      expect(first, "1つ目の名前が「相談 <日付> <時分>.md」の形ではありません").toMatch(/^相談 \d{4}-\d{2}-\d{2} \d{4}\.md$/);
      const firstText = (await readFile(path.join(workFolder, "設定", "相談メモ", first), "utf8")).replace(/\r\n/g, "\n");
      expect(firstText).toContain("# 相談メモ");
      expect(firstText).toContain(QUESTION);
      expect(firstText).toContain(ANSWER);
      await waitUntil(
        async () => tabNamesInclude((await editorGroupTabs(page)).flat(), first),
        "保存した相談メモがタブとして開く",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（タブ：${JSON.stringify(await editorGroupTabs(page))}／前面：${JSON.stringify(await activeTabNames(page))}）`);
      });

      /* ── 同じ分にもう一度保存しても、1つ目は上書きされず、別名の2つ目ができる ── */
      // 開いた相談メモが同じ列の前に出ているので、大きい相談画面を前へ戻す
      // （開いている画面をもう一度開くと前に出る）
      await pressWorkbenchKey(page, OPEN_LARGE_PRESS);
      await waitUntil(async () => await large.locator("#save-note").isVisible().catch(() => false), "大きい相談画面が前に戻る", 20_000);
      await large.locator("#save-note").click();
      await waitUntil(async () => (await noteFiles(workFolder)).length === 2, "2回目の保存で相談メモが2つになる", 30_000);
      const names = await noteFiles(workFolder);
      expect(new Set(names).size, "同じ名前が2つあります").toBe(2);
      expect(names, "1つ目のファイルが消えたか名前が変わりました").toContain(first);
      // 同じ分にぶつかったので、2つ目は「秒」まで入った別名になる（`timestampedFileNameCandidates`）
      const second = names.find((name) => name !== first) ?? "";
      expect(second, "2つ目が、同じ分の中で秒まで入れた別名になっていません").toMatch(
        new RegExp(`^${first.replace(/\.md$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{2}(-\\d+)?\\.md$`)
      );
      expect((await readFile(path.join(workFolder, "設定", "相談メモ", first), "utf8")).replace(/\r\n/g, "\n"), "1つ目が上書きされました").toBe(firstText);
    },
    fakeOllamaLaunch(fake, {
      keybindings: [
        { key: OPEN_SIDE_KEY, command: "novelai.openChat" },
        { key: OPEN_LARGE_KEY, command: "novelai.openChatPanel" },
      ],
    })
  );
});
