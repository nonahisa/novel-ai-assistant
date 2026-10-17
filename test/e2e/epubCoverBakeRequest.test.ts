/**
 * 外部AIの依頼（`run.request` の `coverBake`）で表紙を焼くと、EPUBエディターの欄にも焼いた体裁が入る
 * （画面の自動テスト、設計書6.65.9・6.87.22・6.113。0.107.25）。
 *
 * 0.107.25 で、依頼で焼いた体裁を、その面の合成の欄へ書き戻すようにした（作者の裁定、2026-10-17
 * 「焼いた体裁を欄にも反映する」）。単体テストまでは通っているが、**本物の WebView で欄が変わるところ**は
 * 誰も見ていなかった。ここで見張るのは次のとおり。
 *
 * - 題名の大きさの欄が「大」の作品で、`cover {side:"front", vertical:true, size:"medium"}` の依頼を通す
 *   （確認の窓の［焼く］を押す）と、**表紙の題名の大きさの欄が「中」になる**
 * - 面の見出しに **「（まだ焼いていません）」が出ない**（焼いた画像と欄が揃っている）
 * - **未保存の印**（「未保存の変更があります」）が出る
 * - **book.json は変わっていない**（欄は未保存。［保存］を押すまで設計図は触らない）
 * - ［保存］を押すと、book.json の `coverLayout.title.size` に `medium` が残る
 *
 * 依頼の通し方は `runRequestTypo.test.ts` と同じ：MCP の `run.request` と同じ形の札を保管庫へ置き、
 * URI はテスト用の VS Code の中の「Developer: Open URL」で開く（**作者の vscode:// の受け手は使わない**）。
 * 作品は一時フォルダーの作り物（小さな元イラストと本の設計図を起こす前に置く）。**AI は呼ばない。**
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { formatExternalAccessPermission } from "../../src/core/externalAccessPermission";
import { sha256Text } from "../../src/core/hash";
import { buildRunUri, parseRunState, RUN_REQUEST_DIRECTORY, runStateFileName, runTicketFileName, type RunStateRecord, type RunTicket } from "../../src/core/runRequest";
import { defaultBookConfig } from "../../src/models/book";
import { describeNotices } from "./support/noticeRecord";
import { fillInput } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { dialogText, pressDialogButton, pressWorkbenchKey, quickInputWaitContext, statusBarTexts } from "./support/workbenchDom";

const CLIENT = "claude-code";
const EPISODES = [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }];

/** 1×1 の赤い PNG（元イラストの代わり） */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** 「Developer: Open URL」のキー（URI をテスト用の VS Code の中で開く） */
const OPEN_URL_KEY = "ctrl+alt+shift+q";
const OPEN_URL_PRESS = "Control+Alt+Shift+KeyQ";

function bookFile(session: E2ESession): string {
  return path.join(session.workFolder, "設定", "書籍", "book.json");
}

async function readBookText(session: E2ESession): Promise<string> {
  return readFile(bookFile(session), "utf8");
}

/** 保管庫（この拡張機能の globalStorage）。VS Code が作る名前を探し、無ければ同じ名前で作る */
async function storageRoot(session: E2ESession): Promise<string> {
  const base = path.join(session.root, "user-data", "User", "globalStorage");
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const found = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === "nonahisa.novel-ai-assistant");
  return path.join(base, found?.name ?? "nonahisa.novel-ai-assistant");
}

/** MCP の `run.request`（`feature: coverBake`）と同じ形の札を置き、URI をテスト用の VS Code の中で開く */
async function sendCoverRequest(session: E2ESession): Promise<string> {
  const { page } = session;
  const id = randomBytes(8).toString("hex");
  const token = randomBytes(32).toString("hex");
  const ticket: RunTicket = {
    version: 1,
    id,
    tokenHash: sha256Text(token),
    feature: "coverBake",
    folder: session.workFolder,
    cover: { side: "front", vertical: true, size: "medium" },
    client: CLIENT,
    createdAt: new Date().toISOString(),
  };
  const folder = path.join(await storageRoot(session), RUN_REQUEST_DIRECTORY);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, runTicketFileName(id)), `${JSON.stringify(ticket, null, 2)}\n`, "utf8");

  await pressWorkbenchKey(page, OPEN_URL_PRESS);
  await fillInput(page, buildRunUri(id, token)).catch(async (error: unknown) => {
    throw new Error(`「Open URL」の入力欄が出ません（${String(error)}）${await quickInputWaitContext(page)}`);
  });
  await page.keyboard.press("Enter");
  return id;
}

async function readState(session: E2ESession, id: string): Promise<RunStateRecord | undefined> {
  const file = path.join(await storageRoot(session), RUN_REQUEST_DIRECTORY, runStateFileName(id));
  const text = await readFile(file, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseRunState(text);
}

async function epubFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("railBook") !== null && document.getElementById("front-title-size") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 落ちたときに添える様子：窓・状態・ステータスバー・知らせ */
async function describeState(session: E2ESession, id: string): Promise<string> {
  return (
    `（依頼の状態：${JSON.stringify(await readState(session, id))}／窓：${JSON.stringify(await dialogText(session.page))}` +
    `／ステータスバー：${JSON.stringify(await statusBarTexts(session.page))}／${await describeNotices(session)}）`
  );
}

interface BookJson {
  coverLayout?: { title?: { size?: string; vertical?: boolean } };
}

test("外部AIの表紙を焼く依頼（題名・縦・中）を通すと、EPUBエディターの題名の大きさの欄が「中」になり、未保存の印が出て、book.json は［保存］まで変わらない", async () => {
  await withVsCode(
    "表紙を焼く依頼",
    EPISODES,
    async (session) => {
      const { page } = session;
      const beforeText = await readBookText(session);
      const before = JSON.parse(beforeText) as BookJson;
      expect(before.coverLayout?.title?.size, "起こす前の book.json の題名の大きさは「大」").toBe("large");

      const id = await sendCoverRequest(session);

      // 製品の確認（「…の表紙を焼きますか？」）が出たら［焼く］を押す
      await waitUntil(
        async () => {
          const text = await dialogText(page);
          if (text === undefined) return false;
          if (text.includes("を焼きますか")) return true;
          return false;
        },
        "製品の確認「外部AI（claude-code）からの依頼です。…の表紙を焼きますか？」が出る",
        45_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(session, id)}`);
      });
      const confirm = (await dialogText(page)) ?? "";
      expect(confirm, "確認に作品名が無い").toContain(E2E_WORK_TITLE);
      expect(confirm, "確認に面と体裁（表紙・縦・中）が無い").toContain("題名：縦・中");
      await pressDialogButton(page, "焼く");

      // 依頼は done になる
      let state: RunStateRecord | undefined;
      await waitUntil(
        async () => {
          state = await readState(session, id);
          return state?.state === "done";
        },
        "依頼の結果が done になる",
        60_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await describeState(session, id)}`);
      });

      // EPUBエディターが開いて、欄が「中」になる
      let epub: Frame | undefined;
      await waitUntil(
        async () => {
          epub = await epubFrame(page);
          return epub !== undefined && (await epub.locator("#front-title-size").inputValue().catch(() => "")) === "medium";
        },
        "EPUBエディターの表紙の題名の大きさの欄が「中」になる",
        30_000
      ).catch(async (error: unknown) => {
        const value = epub ? await epub.locator("#front-title-size").inputValue().catch(() => "（読めない）") : "（EPUBエディターが開いていない）";
        throw new Error(`${String(error)}（欄の値：${value}）${await describeState(session, id)}`);
      });
      const frame = epub as Frame;
      expect(await frame.locator("#front-title-size").inputValue(), "題名の大きさの欄は「中」").toBe("medium");
      expect(await frame.locator("#front-title-vertical").isChecked(), "題名の「縦」のチェックが入っている").toBe(true);

      // 面の見出しに「まだ焼いていません」が出ない
      const labels = await frame.locator(".page-label").allInnerTexts();
      expect(labels.join("／"), `面の見出しに「まだ焼いていません」が出ている（見出し：${JSON.stringify(labels)}）`).not.toContain("まだ焼いていません");

      /*
        未保存の印が出る。**出る文は2通りある**：焼いた直後は「表紙を焼きました（…合成の指定はまだ未保存です。
        「保存」で book.json へ残ります）」（依頼の焼きが立てる状態の文）で、続けて面の出し直しが届くと
        「未保存の変更があります」になる（`setStatus(data.dirty ? …)`）。どちらにも「未保存」が入る。
        ここでは「未保存」を含む文が出ることを見る（いまの文は控えて失敗の文にも添える）
      */
      let statusText = "";
      await waitUntil(
        async () => {
          statusText = (await frame.locator("#status").innerText().catch(() => "")) ?? "";
          return statusText.includes("未保存");
        },
        "未保存の印（「未保存」を含む状態の文）が出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（#status：${JSON.stringify(statusText)}）`);
      });
      console.log(`[E2E] 焼いた直後の #status：${statusText}`);

      // book.json は変わっていない
      expect(await readBookText(session), "［保存］の前に book.json が変わっている").toBe(beforeText);

      // ［保存］を押すと medium が残る
      await frame.locator("#save").click();
      await waitUntil(
        async () => ((JSON.parse(await readBookText(session)) as BookJson).coverLayout?.title?.size ?? "") === "medium",
        "［保存］のあと book.json の coverLayout.title.size が medium になる",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（book.json の題名：${JSON.stringify((JSON.parse(await readBookText(session)) as BookJson).coverLayout?.title)}）`);
      });
      const saved = JSON.parse(await readBookText(session)) as BookJson;
      expect(saved.coverLayout?.title?.size).toBe("medium");
      expect(saved.coverLayout?.title?.vertical, "保存した題名は縦").toBe(true);
      expect((await stat(path.join(session.workFolder, "設定", "書籍", "表紙_合成済み.png")).catch(() => undefined))?.size ?? 0, "焼いた画像ができている").toBeGreaterThan(0);
    },
    {
      settings: { "extensions.confirmedUriHandlerExtensionIds": ["nonahisa.novel-ai-assistant"] },
      keybindings: [{ key: OPEN_URL_KEY, command: "workbench.action.url.openUrl" }],
      prepareWork: async ({ workFolder }) => {
        // 作品へ許可の印（claude-code に run.request だけ）を、製品の書き方で置く
        const access = path.join(workFolder, ".aiwriter");
        await mkdir(access, { recursive: true });
        await writeFile(
          path.join(access, "external-access.json"),
          formatExternalAccessPermission({
            clients: [{ name: CLIENT, tools: ["run.request"], sampling: false, decidedAt: "", decidedOn: "画面テスト", note: "" }],
            legacy: false,
          }),
          "utf8"
        );
        // 元イラストと本の設計図（題名の大きさは既定の「大」）
        await mkdir(path.join(workFolder, "素材"), { recursive: true });
        await writeFile(path.join(workFolder, "素材", "表紙.png"), TINY_PNG);
        await mkdir(path.join(workFolder, "設定", "書籍"), { recursive: true });
        const config = { ...defaultBookConfig("画面テストの本"), coverImagePath: "素材/表紙.png" };
        await writeFile(path.join(workFolder, "設定", "書籍", "book.json"), JSON.stringify(config, null, 2), "utf8");
      },
    }
  );
}, 240_000);
