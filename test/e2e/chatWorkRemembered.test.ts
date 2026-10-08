/**
 * 「AIに相談する」で選んだ作品が、VS Code を閉じて開き直したあとも覚えられている
 * （画面の自動テスト、設計書6.104・窓の札。残課題 R7、2026-10-01）。
 *
 * 実機確認リストの「「AIに相談する」で作品Bを選び、VS Code を開き直してファイルを開かずに
 * 相談パネルを開くと、上部に作品Bが出るか。MCP の `windows.list` の `chatWork` が作品Bか」を
 * 機械へ移したもの。**VS Code を本当に閉じて、同じ一時フォルダー・同じ設定で起こし直す**
 * （`restartVsCode`。拡張機能ホストも作り直される）。
 *
 * - 作品A・作品Bを登録し、ファイルは何も開かずに、相談作品の選択（`相談作品選択`）で作品Bを選ぶ
 * - 相談パネルの上部「相談の対象」に「作品B（作品全体）」が出る
 * - VS Code を開き直す（ファイルは開かない）
 * - 相談パネルを開くと、上部に作品Bが出る（作品Aでも空でもない）
 * - 窓の札（`windows.list` が読むファイル。`chatWork`）が作品Bを指す（**ファイルで見る**）
 *
 * **AI は呼ばない**（作品の選択と表示だけ）。
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { runCommand } from "./support/quickInput";
import { E2E_WORK_TITLE, restartVsCode, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, pickQuickPickRow, waitForQuickPick } from "./support/workbenchDom";

const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";
const OPEN_CHAT_KEY = "ctrl+alt+shift+c";
const OPEN_CHAT_PRESS = "Control+Alt+Shift+KeyC";

function launchOptionsFor(): LaunchOptions {
  const registerOther: Record<string, unknown> = {
    key: REGISTER_OTHER_KEY,
    command: "novelai.addWork",
    args: { folderPath: "", title: OTHER_TITLE },
  };
  return {
    keybindings: [registerOther, { key: OPEN_CHAT_KEY, command: "novelai.openChat" }],
    // keybindings.json はこの準備のあとに書かれるので、置き場の道はここで args へ入れる
    prepareWork: async ({ workFolder }) => {
      const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
      await mkdir(path.join(otherFolder, "本文"), { recursive: true });
      await writeFile(path.join(otherFolder, "本文", "001_別の作品.txt"), "　別の作品の本文。\n", "utf8");
      registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
    },
  };
}

/** 相談パネル（「相談の対象」を持つ面）の、いまの対象の字。無ければ undefined */
async function chatTarget(page: Page): Promise<string | undefined> {
  for (const frame of page.frames()) {
    const text = await frame
      .evaluate(() => document.getElementById("context-what")?.textContent ?? undefined)
      .catch(() => undefined);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * 窓の札（`.aiwriter/windows/<窓のプロセス番号>.json`）の `chatWork`。
 * **開き直したあとの窓の札だけを読む**（前の窓の札が残っていても、それは見ない）。
 * 窓のプロセス番号は VS Code 本体ではなく拡張機能ホストのものなので、番号では引かず、
 * 更新時刻が`since`より新しい札のうち最新のものを読む
 */
async function cardChatWork(session: E2ESession, since: number): Promise<{ id: string; title: string } | null | undefined> {
  const found: Array<{ file: string; at: number }> = [];
  const walk = async (folder: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".json") && path.basename(folder) === "windows") {
        const at = (await stat(full)).mtimeMs;
        if (at >= since) found.push({ file: full, at });
      }
    }
  };
  await walk(path.join(session.root, "user-data", "User", "globalStorage"));
  found.sort((a, b) => b.at - a.at);
  if (found.length === 0) return undefined;
  const card = JSON.parse(await readFile(found[0].file, "utf8")) as { chatWork?: { id: string; title: string } | null };
  return card.chatWork;
}

test("相談する作品を選んでおくと、VS Code を開き直したあと、ファイルを開かなくても相談パネルの上部と窓の札にその作品が出る", async () => {
  await withVsCode(
    "相談作品の記憶",
    [{ name: "001_はじまり.txt", text: "　朝の駅は静かだった。\n" }],
    async (session) => {
      const page0 = session.page;
      await page0.keyboard.press(REGISTER_OTHER_PRESS);
      await waitUntil(async () => (await page0.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
      await clearNotifications(page0);

      // ファイルは開かず、相談する作品を作品Bに選ぶ
      await runCommand(page0, "相談作品選択");
      await waitForQuickPick(page0, "どの作品について相談しますか");
      await pickQuickPickRow(page0, OTHER_TITLE);

      // 相談パネルを開くと、上部に作品Bが出る
      await page0.keyboard.press(OPEN_CHAT_PRESS);
      await waitUntil(async () => ((await chatTarget(page0)) ?? "").includes(OTHER_TITLE), "開き直す前：相談パネルの上部に作品Bが出る", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの上部：${JSON.stringify(await chatTarget(page0))}）`);
        }
      );
      expect(await chatTarget(page0)).not.toContain(E2E_WORK_TITLE);

      // VS Code を閉じて、開き直す（ファイルは開かない）
      const restartedAt = Date.now();
      await restartVsCode(session);
      const { page } = session;

      await page.keyboard.press(OPEN_CHAT_PRESS);
      await waitUntil(async () => ((await chatTarget(page)) ?? "").includes(OTHER_TITLE), "開き直したあと：相談パネルの上部に作品Bが出る", 60_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの上部：${JSON.stringify(await chatTarget(page))}）`);
        }
      );
      expect(await chatTarget(page), "作品Aに戻っていない").not.toContain(E2E_WORK_TITLE);

      // 窓の札（windows.list が読むファイル）の chatWork が作品B
      await waitUntil(async () => (await cardChatWork(session, restartedAt))?.title === OTHER_TITLE, "窓の札の chatWork が作品Bを指す", 30_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（札の chatWork：${JSON.stringify(await cardChatWork(session, restartedAt))}）`);
        }
      );
    },
    launchOptionsFor()
  );
}, 300_000);
