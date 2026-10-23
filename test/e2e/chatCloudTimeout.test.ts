/**
 * クラウドのAI（Gemini）の相談が時間切れになったときの、赤字の文言と「タイムアウトを○秒にする」の札
 * （画面の自動テスト、設計書6.63・6.113。実機確認リスト 0.96.16 の節【束：時間切れ】。リーダーの依頼 2026-10-23）。
 *
 * **ふだんの全件（`npm run test:e2e`）では走らない。** 1件ごとに本当に300〜900秒待つので、
 * `NOVELAI_E2E_LONG=1` のときだけ走らせる（4件で約45分）。待ち時間を縮められない理由：
 * クラウドの上限 `novelai.cloudMaxTimeoutSeconds` は600秒より下へ挟まれ（`core/modelTuning.ts` の
 * `cloudTimeoutCeilingSeconds`）、「上限に達した」「上限より長い設定」の文はどちらも600秒以上待った
 * ときにしか出ないため。
 *
 * **本物の Gemini は呼ばない。** `novelai.gemini.endpoint` を、この機械の 127.0.0.1 の偽のサーバーへ向ける
 * （使い捨ての user-data の中だけ）。鍵は**テスト用の作り物の文字列**を、使い捨ての保管庫へ AI設定の
 * ウィザードで入れる（`aiAssignCloudFlow.test.ts` と同じ形）。偽のサーバーは
 * - `/models` を Gemini の形で返す
 * - `:generateContent` は、生成の確かめ（AI設定）と場面探しの検索語づくりには即答し、
 *   **相談の本体だけ返さない**
 *
 * 返さない形は2つ：
 * - `hang`：ヘッダーも返さずに黙る（向こうが詰まったときの形）。VS Code が差し替えた fetch は
 *   こちらの待ち時間を捨てて300秒で切ると記録がある（`ai/fetchTimeouts.ts`）。**何秒で切れたか**を測る
 * - `trickle`：ヘッダーだけ返し、本文の空白を20秒おきに1字ずつ流す（Node の本文の待ち時間に掛からない）。
 *   製品の待ち時間（`fetchJson` の AbortController）が先に効くので、設定どおりの秒数で切れる
 *
 * 製品との違い：相手が偽物で永遠に返らないこと、宛先が手元（127.0.0.1）であること（プロキシを通らない）。
 * 見張る文言は `workChatTimeoutAdvice`（`features/workChatPanel.ts`）。全文と経過秒は標準エラーへ書く。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { SEARCH_TERMS_SYSTEM_PROMPT } from "../../src/prompts/searchTerms";
import { sendChatQuestion } from "./support/chatInput";
import { openEpisode } from "./support/manuscriptFrame";
import { answerInput, runCommand, waitForQuickInput } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { dialogText, pickQuickPickRow, pressWorkbenchKey, quickPickTitle, statusBarTexts, waitForQuickPick } from "./support/workbenchDom";

const LONG = process.env.NOVELAI_E2E_LONG === "1";
/** 撮った写真の置き場（既定は失敗の写真と同じ所。リーダーの依頼ではスクラッチパッドを渡す） */
const SHOT_DIR = process.env.NOVELAI_E2E_SHOTS || path.join(tmpdir(), "novelai-e2e-screenshots");

const MODEL = "gemini-e2e-slow";
const API_KEY = "e2e-fake-gemini-key-0123456789abcdef";
const EPISODE = "001_はじまり.txt";
const BODY = ["　朝の駅は静かだった。", "　改札の横で、リナは古い切符を握りしめていた。", "　発車のベルが鳴った。", ""].join("\n");
const QUESTION = "この話の冒頭について講評してください";

const OPEN_SIDE_KEY = "ctrl+alt+shift+c";
const OPEN_SIDE_PRESS = "Control+Alt+Shift+KeyC";

type SlowMode = "hang" | "trickle";

interface FakeGemini {
  endpoint: string;
  /** 相談の本体を受けた時刻（返さない頼み） */
  chatReceivedAt: number[];
  seen: string[];
  close: () => Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function geminiText(text: string): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
  };
}

async function startFakeGemini(mode: SlowMode): Promise<FakeGemini> {
  const chatReceivedAt: number[] = [];
  const seen: string[] = [];
  const held: ServerResponse[] = [];
  const timers: NodeJS.Timeout[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "/";
      const body = request.method === "POST" ? await readBody(request) : "";
      const sendJson = (value: unknown): void => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.includes("/models?") || url.endsWith("/models")) {
        seen.push("models");
        sendJson({
          models: [
            {
              name: `models/${MODEL}`,
              displayName: MODEL,
              inputTokenLimit: 1_000_000,
              outputTokenLimit: 8192,
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        });
        return;
      }
      if (url.includes(":generateContent")) {
        let system = "";
        try {
          system = (JSON.parse(body) as { systemInstruction?: { parts?: Array<{ text?: string }> } }).systemInstruction?.parts?.[0]?.text ?? "";
        } catch {
          system = "";
        }
        if (system.includes(SEARCH_TERMS_SYSTEM_PROMPT.split("\n")[0])) {
          seen.push("searchTerms");
          sendJson(geminiText(JSON.stringify({ terms: ["切符"] })));
          return;
        }
        if (!body.includes(QUESTION)) {
          // AI設定の「実際に生成できるか」の確かめ
          seen.push("probe");
          sendJson(geminiText("OK"));
          return;
        }
        // 相談の本体：返さない
        seen.push("chat");
        chatReceivedAt.push(Date.now());
        held.push(response);
        if (mode === "trickle") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write(" ");
          const timer = setInterval(() => {
            if (!response.writableEnded) response.write(" ");
          }, 20_000);
          timers.push(timer);
          response.on("close", () => clearInterval(timer));
        }
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  // 握った頼みを Node の側から切らせない（既定の requestTimeout は受け取りの上限で、ここでは効かないが念のため）
  server.requestTimeout = 0;
  server.timeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}/v1beta`,
    chatReceivedAt,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearInterval(timer);
        for (const response of held) response.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** AI設定で Gemini（偽）を選ぶ：鍵（作り物）→接続→モデル→生成の確かめ */
async function chooseFakeGemini(page: Page, fake: FakeGemini): Promise<void> {
  await runCommand(page, "AI設定");
  const providers = await waitForQuickPick(page, "使用するAIを選んでください（1つで構いません）");
  const gemini = providers.find((row) => row.label.includes("Gemini"));
  expect(gemini, `プロバイダの一覧に Gemini が無い（${JSON.stringify(providers.map((row) => row.label))}）`).toBeTruthy();
  await pickQuickPickRow(page, gemini?.label ?? "Gemini");
  await waitForQuickInput(page, "GeminiのAPIキーを入力してください");
  await answerInput(page, API_KEY);
  const models = await waitForQuickPick(page, "使用するモデルを選んでください");
  expect(models.some((row) => row.label.includes(MODEL)), `モデルの一覧に ${MODEL} が無い（${JSON.stringify(models.map((row) => row.label))}）`).toBe(true);
  await pickQuickPickRow(page, MODEL);
  await waitUntil(async () => fake.seen.includes("probe"), "偽の Gemini が生成の確かめを受ける", 30_000).catch((error: unknown) => {
    throw new Error(`${String(error)}（受けた頼み：${JSON.stringify(fake.seen)}）`);
  });
  await waitUntil(
    async () => (await statusBarTexts(page)).some((text) => text.includes("を設定しました")) || (await page.locator(".notification-toast").allInnerTexts()).some((text) => text.includes("を設定しました")),
    "「… を設定しました。」が出る",
    20_000
  );
}

async function sideChatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const side = await frame
      .evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null)
      .catch(() => false);
    if (side) return frame;
  }
  return undefined;
}

interface ErrorTurn {
  text: string;
  actions: string[];
}

async function lastErrorTurn(frame: Frame): Promise<ErrorTurn | undefined> {
  return frame
    .evaluate(() => {
      const turns = Array.from(document.querySelectorAll("#log .turn.error"));
      const last = turns[turns.length - 1];
      if (!last) return undefined;
      return {
        text: (last.querySelector(".body") as HTMLElement | null)?.innerText ?? "",
        actions: Array.from(last.querySelectorAll("button.option")).map((button) => (button as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      };
    })
    .catch(() => undefined);
}

/**
 * 横の相談パネルは左の列の下で高さが約100pxしかなく、赤字が写真に写らない。［メインに表示］で
 * 大きい相談画面へ移し（失敗した問いと札も移る。`postError` の `tail.failure`）、その面を返す
 */
async function showOnMain(page: Page, side: Frame): Promise<Frame> {
  await side.locator("#to-main").click();
  let large: Frame | undefined;
  await waitUntil(
    async () => {
      for (const frame of page.frames()) {
        const ok = await frame
          .evaluate(() => document.getElementById("to-sub") !== null && document.querySelector("#log .turn.error") !== null)
          .catch(() => false);
        if (ok) {
          large = frame;
          return true;
        }
      }
      return false;
    },
    "大きい相談画面に赤字が出る",
    30_000
  );
  return large as Frame;
}

/** 大きい相談画面へ移してから撮る。移した面も返す（札を押すため） */
async function shootMain(page: Page, side: Frame, name: string): Promise<{ file: string; large: Frame }> {
  const large = await showOnMain(page, side);
  // 赤字が画面の下へ隠れないよう、会話の末尾まで巻く
  await large.evaluate(() => {
    const log = document.getElementById("log");
    if (log) log.scrollTop = log.scrollHeight;
  });
  return { file: await shoot(page, name), large };
}

async function shoot(page: Page, name: string): Promise<string> {
  await mkdir(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/**
 * 相談を1問だけ送り（履歴の割合で文が「最初から」の形に化けないよう1問目で）、赤字が出るまで待つ。
 * 送ってから赤字が出るまでの秒数を返す
 */
async function askUntilError(session: E2ESession, fake: FakeGemini, waitMs: number): Promise<{ frame: Frame; turn: ErrorTurn; elapsedSeconds: number }> {
  const { page } = session;
  await openEpisode(page, EPISODE, "発車のベルが鳴った");
  await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
  let side: Frame | undefined;
  await waitUntil(async () => (side = await sideChatFrame(page)) !== undefined, "横の相談パネルが開く", 30_000);
  const frame = side as Frame;
  await waitUntil(
    async () => (await frame.evaluate(() => document.getElementById("context-what")?.textContent ?? "")).includes(E2E_WORK_TITLE),
    "相談の対象に作品名が出る",
    30_000
  );
  await sendChatQuestion(frame, QUESTION, "横の相談パネル");
  // 有料のAIは、会話で一度だけ課金の確認が出る（選ぶ画面「AIへの相談を実行しますか」→ 先頭の行［実行］。
  // 「実行（以降は訊かない）」より上にあるので、名前を含む最初の行で当たる）
  await waitUntil(
    async () => {
      if (((await quickPickTitle(page)) ?? "").includes("AIへの相談を実行しますか")) {
        await pickQuickPickRow(page, "実行");
        return false;
      }
      return fake.chatReceivedAt.length > 0;
    },
    "偽の Gemini が相談の本体を受ける",
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（受けた頼み：${JSON.stringify(fake.seen)}／確認の窓：${JSON.stringify(await dialogText(page))}／選ぶ画面：${JSON.stringify(await quickPickTitle(page))}／赤字：${JSON.stringify(await lastErrorTurn(frame))}）`);
  });
  const sentAt = fake.chatReceivedAt[0];
  let turn: ErrorTurn | undefined;
  await waitUntil(async () => (turn = await lastErrorTurn(frame)) !== undefined, "相談の赤字が出る", waitMs).catch((error: unknown) => {
    throw new Error(`${String(error)}（送ってから${Math.round((Date.now() - sentAt) / 1000)}秒／受けた頼み：${JSON.stringify(fake.seen)}）`);
  });
  const elapsedSeconds = Math.round((Date.now() - sentAt) / 1000);
  return { frame, turn: turn as ErrorTurn, elapsedSeconds };
}

/**
 * 赤字の全文・札・経過秒を、写真と同じ所の `timeout-report.txt` へ足す（通った件の標準エラーは
 * 走りの出力に残らないことがあるため、ファイルにも書く）
 */
async function report(label: string, result: { turn: ErrorTurn; elapsedSeconds: number }, shot: string): Promise<void> {
  const text = `[時間切れ ${label}] 送ってから${result.elapsedSeconds}秒で赤字\n赤字の全文：${result.turn.text}\n札：${JSON.stringify(result.turn.actions)}\n写真：${shot}\n\n`;
  console.error(text);
  await mkdir(SHOT_DIR, { recursive: true });
  await appendFile(path.join(SHOT_DIR, "timeout-report.txt"), text, "utf8");
}

function launchOptions(fake: FakeGemini, settings: Record<string, unknown>) {
  return {
    keybindings: [{ key: OPEN_SIDE_KEY, command: "novelai.openChat" }],
    settings: { "novelai.gemini.endpoint": fake.endpoint, ...settings },
  };
}

const MINUTE = 60_000;

/*
  **ふだんの全件でも走る短い1件**（設定の下限10秒）。上限より短い待ち時間で切れたときの文と札
  （「下の札を押すと延ばせます」「タイムアウトを20秒にする」）を見る。長い4件と同じ道
  （偽の Gemini・課金の確認・赤字の組み立て）を通るので、長い4件を回す前の下見にもなる
*/
test("待ち時間10秒（上限より短い）で時間切れになると、延ばせる案内と「タイムアウトを20秒にする」の札が出る", async () => {
  const fake = await startFakeGemini("trickle");
  try {
    await withVsCode(
      "時間切れ_10秒",
      [{ name: EPISODE, text: BODY }],
      async (session) => {
        await chooseFakeGemini(session.page, fake);
        const result = await askUntilError(session, fake, 2 * MINUTE);
        await report("trickle 10秒", result, (await shootMain(session.page, result.frame, "timeout_10_below_ceiling")).file);
        expect(result.turn.text).toContain("Geminiの応答がタイムアウトしました（10秒）");
        expect(result.turn.text).toContain("下の札を押すと延ばせます");
        expect(result.turn.actions.some((label) => label.includes("タイムアウトを20秒にする"))).toBe(true);
      },
      launchOptions(fake, { "novelai.gemini.timeoutSeconds": 10 })
    );
  } finally {
    await fake.close();
  }
}, 5 * MINUTE);

/*
  黙る相手は、VS Code が差し替えた fetch の300秒で切れる（2026-10-23 の実測で302秒）。作者の裁定「案内を直す」
  （同じ日）で、このときは**待った秒数で言い、待ち時間や上限を延ばす案内と札を出さない**。効く手（送る量を減らす・
  質問を分けて送り直す）だけを言う。文は `ai/httpClient.ts`（頭）と `workChatTimeoutAdvice` の `fetchCeiling`（続き）
*/
test.skipIf(!LONG)("黙ったままの相手（ヘッダーも返さない）に、待ち時間900秒で相談すると、Node の上限で切れ、待った秒数で言い、延ばす案内と札を出さない", async () => {
  const fake = await startFakeGemini("hang");
  try {
    await withVsCode(
      "時間切れ_黙る相手_900秒",
      [{ name: EPISODE, text: BODY }],
      async (session) => {
        await chooseFakeGemini(session.page, fake);
        const result = await askUntilError(session, fake, 16 * MINUTE);
        await report("hang 900秒", result, (await shootMain(session.page, result.frame, "timeout_hang_900")).file);
        const text = result.turn.text;
        const cut = /Geminiの応答がタイムアウトしました（Node側の上限。(\d+)秒で切れました）。/.exec(text);
        expect(cut, `Node の上限の頭が無い：${text}`).not.toBeNull();
        // 300秒の壁（実測302秒）。設定の900秒ではない
        const waited = Number(cut?.[1]);
        expect(waited).toBeGreaterThanOrEqual(280);
        expect(waited).toBeLessThan(400);
        expect(text).toContain("この上限は待ち時間の設定では変わりません。一度に送る量を減らしてください。");
        // 最初の問いなので、これまでのやり取りは軽い。質問を分けて送り直す手を言う
        expect(text).toContain("質問を短く分けて、もう一度送ってください。");
        expect(text).not.toContain("延ば");
        expect(text).not.toContain("900秒");
        expect(text).not.toContain("novelai.cloudMaxTimeoutSeconds");
        expect(result.turn.actions).toEqual([]);
      },
      launchOptions(fake, { "novelai.gemini.timeoutSeconds": 900 })
    );
  } finally {
    await fake.close();
  }
}, 22 * MINUTE);

test.skipIf(!LONG)("待ち時間を900秒（上限600秒より長い）にして時間切れになると、「設定どおり900秒待ちましたが」と出て「いまの上限（600秒）に達しました」と出ない。札は出ない", async () => {
  const fake = await startFakeGemini("trickle");
  try {
    await withVsCode(
      "時間切れ_900秒",
      [{ name: EPISODE, text: BODY }],
      async (session) => {
        await chooseFakeGemini(session.page, fake);
        const result = await askUntilError(session, fake, 16 * MINUTE);
        await report("trickle 900秒", result, (await shootMain(session.page, result.frame, "timeout_900_over_ceiling")).file);
        expect(result.turn.text).toContain("設定どおり900秒待ちましたが、返りませんでした");
        expect(result.turn.text).toContain("ふだんの上限600秒より長い設定");
        expect(result.turn.text).not.toContain("いまの上限（600秒）に達しました");
        expect(result.turn.actions).toEqual([]);
      },
      launchOptions(fake, { "novelai.gemini.timeoutSeconds": 900 })
    );
  } finally {
    await fake.close();
  }
}, 22 * MINUTE);

test.skipIf(!LONG)("待ち時間600秒・上限600秒で時間切れになると、「いまの上限（600秒）に達しました」と上限を延ばす設定の名前が出る。札は出ない", async () => {
  const fake = await startFakeGemini("trickle");
  try {
    await withVsCode(
      "時間切れ_上限600秒",
      [{ name: EPISODE, text: BODY }],
      async (session) => {
        await chooseFakeGemini(session.page, fake);
        const result = await askUntilError(session, fake, 12 * MINUTE);
        await report("trickle 600秒・上限600秒", result, (await shootMain(session.page, result.frame, "timeout_600_at_ceiling")).file);
        expect(result.turn.text).toContain("待ち時間はいまの上限（600秒）に達しました");
        expect(result.turn.text).toContain("novelai.cloudMaxTimeoutSeconds");
        expect(result.turn.text).toContain("最大1800秒まで延ばせます");
        expect(result.turn.actions).toEqual([]);
      },
      launchOptions(fake, { "novelai.gemini.timeoutSeconds": 600 })
    );
  } finally {
    await fake.close();
  }
}, 18 * MINUTE);

test.skipIf(!LONG)("上限を1200秒に延ばして600秒で時間切れになると、「タイムアウトを1200秒にする」の札が出て、押すと設定に1200秒が入る", async () => {
  const fake = await startFakeGemini("trickle");
  try {
    await withVsCode(
      "時間切れ_上限1200秒",
      [{ name: EPISODE, text: BODY }],
      async (session) => {
        const { page } = session;
        await chooseFakeGemini(page, fake);
        const result = await askUntilError(session, fake, 12 * MINUTE);
        const shot = await shootMain(page, result.frame, "timeout_600_ceiling_1200");
        await report("trickle 600秒・上限1200秒", result, shot.file);
        expect(result.turn.actions.some((label) => label.includes("タイムアウトを1200秒にする"))).toBe(true);
        expect(result.turn.text).toContain("下の札を押すと延ばせます");

        // 押すのは大きい相談画面の札（横のパネルと同じ札。押したあとの知らせは両方の面に出る）
        await shot.large.locator("#log .turn.error button.option", { hasText: "タイムアウトを1200秒にする" }).last().click();
        await waitUntil(
          async () => (await shot.large.evaluate(() => document.getElementById("log")?.innerText ?? "")).includes("のタイムアウトを1200秒にしました。もう一度お尋ねください"),
          "「<AIの名前>のタイムアウトを1200秒にしました。もう一度お尋ねください。」が出る",
          15_000
        );
        const settingsFile = path.join(session.root, "user-data", "User", "settings.json");
        await waitUntil(async () => (await readFile(settingsFile, "utf8").catch(() => "")).includes('"novelai.gemini.timeoutSeconds": 1200'), "使い捨ての settings.json に 1200 が入る", 15_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（settings.json：${await readFile(settingsFile, "utf8").catch(() => "読めない")}）`);
          }
        );
        console.error(`[時間切れ 札を押したあと] 写真：${await shoot(page, "timeout_raise_pressed")}`);
      },
      launchOptions(fake, { "novelai.gemini.timeoutSeconds": 600, "novelai.cloudMaxTimeoutSeconds": 1200 })
    );
  } finally {
    await fake.close();
  }
}, 18 * MINUTE);
