/**
 * はじめて開いたときの「使うAIを選ぶ」案内（画面の自動テスト、設計書6.113。`features/firstRun.ts`。
 * 実機確認リストの仕分け 2026-10-12 の束 E10 のうち 4623 行「案内が出るか」を移したもの。
 * 作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 作者の機械では確かめられなかった項目（2026-09-08 の記録）：案内は「AIがもう決まっていれば
 * 出さない」作りで、作者の機械では Ollama が常に応え、クラウドの鍵も OS の資格情報ストアで
 * プロファイルをまたいで共有されるため、新しいプロファイルでも出なかった。
 * ここでは**使い捨ての user-data-dir**（鍵の置き場も一時フォルダーの中）で起こし、
 * 手元のAIの接続先を**誰も応えない番地**へ向けて、まっさらな環境を作る。
 *
 * 見張ること：
 * - 拡張機能が起きると、右下に「小説執筆へようこそ。使うAIを選ぶと…」の案内が出て、
 *   押し口［AIを選ぶ］［道案内を見る］が並ぶ（Claude Code は入っていないので［Claude Code接続］は出ない）
 * - ［AIを選ぶ］を押すと「使用するAIを選んでください（1つで構いません）」の選ぶ画面が出て、
 *   Ollama などと［取りやめる］が並ぶ（Esc で閉じ、AI は選ばない）
 *
 * 「断ったあと次の起動で出ない」は単体テスト `firstRun.test.ts` が見ている。
 *
 * **案内は起動の直後に出るので、作品を登録する前に読む**（`LaunchOptions.beforeRegister`）。
 * 登録の途中で知らせを閉じるため、本体からは見えない。案内は一度出したら二度と出ない
 * （出した印を先に残す）ので、閉じられたあとで探しても見つからない。
 *
 * 作風診断の声かけ（「はじめまして。いくつかお答えいただくと…」）は、AIの案内より先に出て
 * 答えを待つ（`extension.ts` で診断の声かけを待ってから AIの案内を出す）。待たせないよう、
 * globalState に「声かけは済んだ」（`novelai.writerWelcome: "done"`）を置いて起こす。
 * **AI は呼ばない。**
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { WRITER_WELCOME_KEY } from "../../src/core/writerProfileStore";
import { waitForQuickInput } from "./support/quickInput";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { notificationTexts, pressWorkbenchKey, quickInputWaitContext, quickPickRows, quickPickTitle } from "./support/workbenchDom";

/** 誰も応えない番地（discard のポート）。手元のAIが「決まっている」と数えられないようにする */
const DEAD_ENDPOINT = "http://127.0.0.1:9";

const WELCOME_HEAD = "小説執筆へようこそ";
const PICKER_TITLE = "使用するAIを選んでください（1つで構いません）";

test("まっさらな環境で起こすと、使うAIを選ぶ案内が出て、［AIを選ぶ］で選ぶ画面が開く", async () => {
  let seen: { text: string; buttons: string[]; pickerTitle: string; rows: string[] } | undefined;

  const readWelcome = async (page: Page): Promise<void> => {
    const toast = page.locator(".notification-toast", { hasText: WELCOME_HEAD });
    await waitUntil(async () => (await toast.count()) > 0, "起動のあと「小説執筆へようこそ」の案内が出る", 90_000).catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（出ている知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      }
    );
    const text = (await toast.first().innerText()).replace(/\s+/g, " ");
    const buttons = (await toast.first().locator(".monaco-button").allInnerTexts()).map((label) => label.trim()).filter(Boolean);

    // ［AIを選ぶ］を押すと、選ぶ画面が出る
    await toast.first().locator(".monaco-button", { hasText: "AIを選ぶ" }).first().click();
    await waitForQuickInput(page, PICKER_TITLE, 20_000);
    let rows: string[] = [];
    await waitUntil(async () => (rows = (await quickPickRows(page)).map((row) => row.label)).length > 1, "AIの選ぶ画面に行が並ぶ", 10_000).catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
      }
    );
    const pickerTitle = (await quickPickTitle(page)) ?? "";
    // 選ばずに閉じる（AI を選ぶと接続の確かめが走る）
    await page.keyboard.press("Escape");
    await waitUntil(async () => (await quickPickTitle(page)) === undefined, "AIの選ぶ画面が Esc で閉じる", 10_000);
    seen = { text, buttons, pickerTitle, rows };
  };

  await withVsCode(
    "はじめての案内",
    [{ name: "001_はじまり.txt", text: "最初の話の一行目。\n" }],
    async () => {
      // 案内は登録の前に読んである（下の beforeRegister）。ここではその結果を確かめる
      if (!seen) throw new Error("案内を読む前に本体へ来ました（beforeRegister が呼ばれていません）");
      expect(seen.text, `案内の文：${seen.text}`).toContain("使うAIを選ぶと");
      expect(seen.text).toContain("AIなしでも使えます");
      expect(seen.buttons, `案内の押し口：${JSON.stringify(seen.buttons)}`).toContain("AIを選ぶ");
      expect(seen.buttons).toContain("道案内を見る");
      expect(seen.buttons, "Claude Code が入っていないのに［Claude Code接続］が出ています").not.toContain("Claude Code接続");
      expect(seen.pickerTitle).toBe(PICKER_TITLE);
      expect(seen.rows.some((row) => row.includes("Ollama")), `選ぶ画面の行：${JSON.stringify(seen.rows)}`).toBe(true);
      expect(seen.rows.some((row) => row.includes("取りやめる")), `選ぶ画面の行：${JSON.stringify(seen.rows)}`).toBe(true);
    },
    {
      settings: {
        // 手元のAI（Ollama・LM Studio）が動いている機械でも「決まっている」と数えない
        "novelai.ollama.endpoint": DEAD_ENDPOINT,
        "novelai.lmstudio.endpoint": DEAD_ENDPOINT,
      },
      globalState: { [WRITER_WELCOME_KEY]: "done" },
      beforeRegister: readWelcome,
    }
  );
});

/*
  ── Claude Code が入っている環境（実機確認リスト 0.121.0「設定資料が1件も無い作品で矛盾検知を押すと…」の後半） ──

  案内の［Claude Code接続］は `vscode.extensions.getExtension("anthropic.claude-code")` があるときだけ出る。
  拡張機能の置き場は空の一時フォルダーなので、**package.json だけの見本**を同じ ID で開発中の形として読ませる
  （`LaunchOptions.extraExtensions`。中身のコードは無く、本物の Claude Code は動かない）。
  ［Claude Code接続］は**押さない**——押すと作者の機械の Claude Code の設定（MCP の登録）へ書きにいく。
  道案内の段の題は、案内の［道案内を見る］と同じ道（`workbench.action.openWalkthrough`）で開いて読む。
*/

/** 道案内を開くキー（数字のキーは製品の package.json とも、ほかの件とも重ならない） */
const OPEN_WALKTHROUGH_PRESS = "Control+Alt+Shift+Digit2";

async function fakeClaudeCodeExtension(root: string): Promise<string[]> {
  const folder = path.join(root, "見本の拡張機能", "claude-code");
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "package.json"),
    JSON.stringify(
      {
        name: "claude-code",
        publisher: "anthropic",
        displayName: "Claude Code の見本（画面の自動テスト用。中身は無い）",
        version: "0.0.1",
        engines: { vscode: "^1.80.0" },
      },
      null,
      2
    ),
    "utf8"
  );
  return [folder];
}

test("Claude Code が入っている環境では、はじめての案内に［Claude Code接続］が並び、道案内の段の題も「Claude Code接続」になっている", async () => {
  let seen: { text: string; buttons: string[] } | undefined;
  const readWelcome = async (page: Page): Promise<void> => {
    const toast = page.locator(".notification-toast", { hasText: WELCOME_HEAD });
    await waitUntil(async () => (await toast.count()) > 0, "起動のあと「小説執筆へようこそ」の案内が出る", 90_000).catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（出ている知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      }
    );
    seen = {
      text: (await toast.first().innerText()).replace(/\s+/g, " "),
      buttons: (await toast.first().locator(".monaco-button").allInnerTexts()).map((label) => label.trim()).filter(Boolean),
    };
  };

  await withVsCode(
    "はじめての案内（Claude Code あり）",
    [{ name: "001_はじまり.txt", text: "最初の話の一行目。\n" }],
    async (session) => {
      if (!seen) throw new Error("案内を読む前に本体へ来ました（beforeRegister が呼ばれていません）");
      expect(seen.buttons, `案内の押し口：${JSON.stringify(seen.buttons)}`).toEqual(["AIを選ぶ", "Claude Code接続", "道案内を見る"]);
      expect(seen.text, `案内の文：${seen.text}`).toContain("Claude Code とつなぐと、Claude Code のチャットで会話しながらセットアップを進められます。");

      // 道案内を開いて、段の題を読む
      const { page } = session;
      await pressWorkbenchKey(page, OPEN_WALKTHROUGH_PRESS);
      let titles: string[] = [];
      await waitUntil(
        async () => {
          titles = await page.evaluate(() =>
            Array.from(document.querySelectorAll(".gettingStartedContainer .getting-started-step .step-title")).map((node) => (node.textContent ?? "").trim())
          );
          return titles.length > 0;
        },
        "道案内の段が並ぶ",
        30_000
      ).catch(async (error: unknown) => {
        const body = await page.evaluate(
          () => (document.querySelector(".gettingStartedContainer") as HTMLElement | null)?.innerText.slice(0, 600) ?? "（道案内の面がありません）"
        );
        throw new Error(`${String(error)}（道案内の字：${body}）`);
      });
      expect(titles, `道案内の段：${JSON.stringify(titles)}`).toContain("Claude Code接続（任意）");
      expect(titles.some((title) => title.includes("Claude Code とつなぐ")), `古い名前の段があります：${JSON.stringify(titles)}`).toBe(false);
    },
    {
      settings: {
        "novelai.ollama.endpoint": DEAD_ENDPOINT,
        "novelai.lmstudio.endpoint": DEAD_ENDPOINT,
      },
      keybindings: [
        {
          key: "ctrl+alt+shift+2",
          command: "workbench.action.openWalkthrough",
          args: "nonahisa.novel-ai-assistant#novelai.gettingStarted",
        },
      ],
      globalState: { [WRITER_WELCOME_KEY]: "done" },
      beforeRegister: readWelcome,
      extraExtensions: fakeClaudeCodeExtension,
    }
  );
});
