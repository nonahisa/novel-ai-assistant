/**
 * LM Studio の欄で llama.cpp の server（llama-server）をつなぐ（画面の自動テスト、設計書6.24・6.113。
 * 作者の決定 2026-11-23「llama.cpp を製品を直して正式に」の画面の確かめ）。
 *
 * PR #45 で `ai/lmstudioProvider.ts` が、LM Studio の自前の口（`/api/v0/models`）が無いときだけ
 * llama-server の `/v1/models` の `meta` と `/props` から大きさと文脈長を補い、思考を切る頼み
 * （`disableThinking`）には `chat_template_kwargs: { enable_thinking: false }` を送るようになった。
 * 単体テストは provider の中だけを見ている。ここでは**拡張機能を動かして、画面の道から**確かめる：
 *
 * 1. 設定 `novelai.lmstudio.endpoint` を llama-server の口（`…/v1`）にして「AI設定」で「LM Studio」を選ぶと、
 *    接続の確かめが通ってモデルを選ぶ画面へ進む。設定のあと「AI接続確認」を走らせると、
 *    「LM Studioに接続しました（モデル 1 件）…」の知らせが出る
 *    （**成功の文を画面に出すのは「AI接続確認」だけ**。AI設定の流れは、成功なら黙って次の画面へ進む）
 * 2. モデルを選ぶ画面に llama-server のモデル `gemma4:26b` が出て、説明に `meta.n_params` から読んだ
 *    「25.2B」と `/props` から読んだ「文脈 8k」が並び、選べる
 * 3. 選んだあと原稿エディターで誤字脱字検知（Ctrl+Alt+T）を1回走らせると、作り物のサーバーに届いた
 *    検知の本文に `chat_template_kwargs.enable_thinking: false` が入っている
 *    （生成の試し `probeGeneration` の本文にも入るので、検知を押す前の件数を控え、そのあとの
 *    `response_format` つきの本文だけを見る）
 *
 * **AI は作り物の llama-server（`support/fakeLlamaServer.ts`）。** 本物の b12647 で取った形を返す。
 * 手元の Ollama は誰も応えない番地へ向けて、作者の Ollama には触れない。
 *
 * 任意：環境変数 `NOVELAI_E2E_LLAMA_ENDPOINT`（例 `http://127.0.0.1:8080`。`/v1` は付けても付けなくてもよい）が
 * あれば、作り物の代わりにその宛先を使う（本物の llama-server で1回流すため）。そのときモデルは
 * `NOVELAI_E2E_LLAMA_MODEL`（無ければ一覧の最初の行）。本文の記録（3）と件数・大きさの確かめは作り物のときだけ。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { WRITER_WELCOME_KEY } from "../../src/core/writerProfileStore";
import { passLocalAiGate } from "./support/fakeOllama";
import { FAKE_LLAMA_MODEL, startFakeLlamaServer, type FakeLlamaChatBody, type FakeLlamaServer } from "./support/fakeLlamaServer";
import { CHECK_TYPOS_PRESS } from "./support/keys";
import { waitForNotice } from "./support/noticeRecord";
import { openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { runCommand, waitForQuickInput } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  activateTab,
  clearNotifications,
  notificationTexts,
  pickQuickPickRow,
  quickPickRows,
  quickPickTitle,
  statusBarTexts,
  type QuickPickRow,
} from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";

/** 誰も応えない番地（discard のポート）。手元の Ollama を「決まっている」と数えさせず、作者の Ollama にも触れない */
const DEAD_ENDPOINT = "http://127.0.0.1:9";

const PROVIDER_TITLE = "使用するAIを選んでください（1つで構いません）";
const PROVIDER_ROW = "LM Studio（ローカル）";
const MODEL_TITLE = "使用するモデルを選んでください";
const CONNECTED = "LM Studioに接続しました（モデル 1 件）";
const TYPO_START = "誤字脱字検知を開始:";
const TYPO_END = "誤字脱字検知を終了:";

/** 本物の llama-server で流すときの宛先（無ければ作り物） */
const REAL_ENDPOINT = process.env.NOVELAI_E2E_LLAMA_ENDPOINT?.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
const REAL_MODEL = process.env.NOVELAI_E2E_LLAMA_MODEL?.trim();

/** 作品の操作ログ（`.aiwriter/logs/actions.log`）の行 */
async function actionLogLines(session: E2ESession): Promise<string[]> {
  const text = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** 受けた本文の頭（落ちた文に添える用。messages は長いので中身を省く） */
function describeBody(body: FakeLlamaChatBody): string {
  const { messages, ...rest } = body;
  const count = Array.isArray(messages) ? messages.length : 0;
  const json = JSON.stringify({ ...rest, response_format: rest.response_format === undefined ? undefined : "（あり）" });
  return `messages ${count}件 ${json}`;
}

/** 落ちたときに添える様子：選ぶ画面・知らせ・ステータスバー・作り物が受けた道と本文・操作ログの終わり */
async function describeState(session: E2ESession, fake: FakeLlamaServer | undefined): Promise<string> {
  const { page } = session;
  const rows = await quickPickRows(page).catch(() => [] as QuickPickRow[]);
  const log = (await actionLogLines(session)).slice(-15).join("\n");
  const server = fake
    ? `\n作り物の llama-server が受けた道：${JSON.stringify(fake.hits)}` +
      `\n受けた本文：${fake.chatBodies.map((body, index) => `#${index + 1} ${describeBody(body)}`).join(" ／ ") || "なし"}`
    : "\n（本物の llama-server へ向けて流しています）";
  return (
    `いまの画面：「${(await quickPickTitle(page)) ?? "なし"}」 行：${JSON.stringify(rows.map((row) => `${row.label}｜${row.description}`).slice(0, 8))}` +
    `\n出ている知らせ：${JSON.stringify(await notificationTexts(page))}` +
    `\nステータスバー：${JSON.stringify(await statusBarTexts(page))}` +
    server +
    `\n操作ログの終わり：\n${log}`
  );
}

/** 待ちで落ちたら、その時の様子を添えて投げ直す */
async function waitWithState(
  session: E2ESession,
  fake: FakeLlamaServer | undefined,
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs: number
): Promise<void> {
  await waitUntil(
    async () => {
      // LM Studio の欄も手元のAIなので、GPU の負荷の関所を通る（機械の状態しだいで出る）
      await passLocalAiGate(session.page);
      return condition();
    },
    what,
    timeoutMs
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}\n${await describeState(session, fake)}`);
  });
}

/** 知らせかステータスバーに `needle` を含む字が出ているか */
async function noticeShows(page: Page, needle: string): Promise<boolean> {
  return (
    (await notificationTexts(page)).some((text) => text.includes(needle)) ||
    (await statusBarTexts(page)).some((text) => text.includes(needle))
  );
}

/** 作り物のときの `/v1/chat/completions` の答え。検知（構造化）は指摘0件、生成の試しは「はい」 */
function respond(body: FakeLlamaChatBody): string {
  return body.response_format !== undefined ? JSON.stringify({ issues: [] }) : "はい";
}

test("LM Studio の欄で llama-server の口へ向けると、接続が通って gemma4:26b を選べ、誤字脱字検知の本文に enable_thinking: false が載る", async () => {
  const fake = REAL_ENDPOINT === undefined ? await startFakeLlamaServer(respond) : undefined;
  const origin = REAL_ENDPOINT ?? fake!.origin;
  try {
    await withVsCode(
      "llama-server を LM Studio の欄でつなぐ",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;

        /* ── 1. AI設定で「LM Studio（ローカル）」を選ぶ → 接続の確かめが通ってモデルの画面へ進む ── */
        await clearNotifications(page);
        await runCommand(page, "AI設定");
        await waitForQuickInput(page, PROVIDER_TITLE, 20_000);
        await waitWithState(
          session,
          fake,
          async () => (await quickPickRows(page)).some((row) => row.label.includes(PROVIDER_ROW)),
          `AIの選ぶ画面に「${PROVIDER_ROW}」が並ぶ`,
          10_000
        );
        await pickQuickPickRow(page, PROVIDER_ROW);

        /* ── 2. モデルの画面に gemma4:26b が出て、説明に 25.2B と 文脈 8k が並ぶ ── */
        let modelRows: QuickPickRow[] = [];
        await waitWithState(
          session,
          fake,
          async () => {
            if (((await quickPickTitle(page)) ?? "") !== MODEL_TITLE) return false;
            modelRows = (await quickPickRows(page)).filter((row) => !row.label.includes("取りやめる") && !row.label.includes("一覧に無い"));
            return modelRows.length > 0;
          },
          `接続の確かめが通って「${MODEL_TITLE}」の画面にモデルが並ぶ`,
          30_000
        );
        const modelName = REAL_ENDPOINT === undefined ? FAKE_LLAMA_MODEL : (REAL_MODEL ?? modelRows[0].label);
        const modelRow = modelRows.find((row) => row.label === modelName);
        expect(modelRow, `モデルの画面に「${modelName}」が無い：${JSON.stringify(modelRows)}`).toBeDefined();
        if (fake) {
          expect(modelRows, `作り物のモデルは1件だけ：${JSON.stringify(modelRows)}`).toHaveLength(1);
          // 大きさは meta.n_params（25233142046）から、長さは /props のスロットあたりの 8192 から
          expect(modelRow!.description, `大きさが meta.n_params から読めていない：${modelRow!.description}`).toContain("25.2B");
          expect(modelRow!.description, `文脈長が /props から読めていない：${modelRow!.description}`).toContain("文脈 8k");
          // 読み込み済みとして扱う（LM Studio の lms で読み込みに行かない）
          expect(modelRow!.description, `未読込の扱いになっている：${modelRow!.description}`).not.toContain("選ぶと読み込みます");
        }
        await pickQuickPickRow(page, modelName);

        // 生成の試しが通り、設定が保存される（完了はステータスバーに数秒だけ出る）
        const doneText = `LM Studio（ローカル） / ${modelName} を設定しました。`;
        await waitWithState(session, fake, () => noticeShows(page, doneText), `「${doneText}」が出る`, 60_000);
        expect(await noticeShows(page, "LM Studioにモデルを読み込んでいます"), "llama-server なのに LM Studio の読み込みへ進んだ").toBe(false);
        if (fake) {
          const probe = fake.chatBodies.find((body) => body.response_format === undefined);
          expect(probe, `生成の試しが作り物に届いていない\n${await describeState(session, fake)}`).toBeDefined();
          expect(probe!.model, "生成の試しのモデル名").toBe(FAKE_LLAMA_MODEL);
        }

        /*
          ── 1の続き. AI接続確認で「LM Studioに接続しました（モデル 1 件）」が出る ──
          右下の知らせは数秒で畳まれるので、知らせの記録ファイル（`core/noticeLog.ts`）と右下の両方を見る
          （`support/noticeRecord.ts`）。接続確認の行（`logLine`）は出力の窓へ行き、作品の actions.log には
          書かれないので、ここでは見ない
        */
        await clearNotifications(page);
        const connectStarted = Date.now();
        await runCommand(page, "AI接続確認");
        const connected = REAL_ENDPOINT === undefined ? CONNECTED : "LM Studioに接続しました（モデル ";
        const pollGate = setInterval(() => void passLocalAiGate(page).catch(() => undefined), 500);
        let toast = "";
        try {
          toast = await waitForNotice(
            session,
            (message) => message.includes(connected) && message.includes("生成も確認しました"),
            `「${connected}…生成も確認しました。」の知らせが出る`,
            { since: connectStarted, timeoutMs: 60_000 }
          );
        } catch (error) {
          throw new Error(`${String(error)}\n${await describeState(session, fake)}`);
        } finally {
          clearInterval(pollGate);
        }
        expect(toast, `知らせに使用中のモデルが出ていない：${toast}`).toContain(`使用中: ${modelName}`);
        if (fake) {
          // 既定（localhost:1234）と違う宛先なので、宛先の印が添えられる
          expect(toast, `知らせに宛先の印が出ていない：${toast}`).toContain(`宛先: ${new URL(origin).host}`);
          expect(toast, `知らせの文脈長が /props の 8192 でない：${toast}`).toContain("文脈 8192");
        }

        /* ── 3. 原稿で Ctrl+Alt+T（この話の誤字脱字を検知）→ 量の確認を［実行］ → 本文に enable_thinking: false ── */
        await clearNotifications(page);
        await activateTab(page, EPISODE).catch(() => undefined);
        const frame = await openEpisode(page, EPISODE, "改札を抜けて");
        const before = fake?.chatBodies.length ?? 0;
        await placeCaretAfter(frame, "静かだった。");
        await page.keyboard.press(CHECK_TYPOS_PRESS);
        let first = "";
        await waitWithState(
          session,
          fake,
          async () => {
            const title = (await quickPickTitle(page)) ?? "";
            const rows = await quickPickRows(page);
            const text = [title, ...rows.map((row) => row.label)].join("\n");
            if (!text.includes("チャンク中") || !text.includes("件を処理します")) return false;
            expect(text, "確認が開いている原稿の作品で出ていない").toContain(E2E_WORK_TITLE);
            first = rows[0]?.label ?? "";
            return true;
          },
          "誤字脱字の量の確認（チャンク中・件を処理します）が出る",
          30_000
        );
        expect(first, "確認の先頭は［実行］（Enter でそのまま走る）").toContain("実行");
        await page.keyboard.press("Enter");
        await waitWithState(
          session,
          fake,
          async () => {
            const lines = await actionLogLines(session);
            return lines.some((line) => line.includes(TYPO_START)) && lines.some((line) => line.includes(TYPO_END));
          },
          "操作ログに「誤字脱字検知を開始」と「誤字脱字検知を終了」が書かれる",
          120_000
        );

        if (fake) {
          const detections = fake.chatBodies.slice(before).filter((body) => body.response_format !== undefined);
          expect(detections.length, `検知の本文（response_format つき）が作り物に届いていない\n${await describeState(session, fake)}`).toBeGreaterThan(0);
          for (const body of detections) {
            expect(body.model, "検知の本文のモデル名").toBe(FAKE_LLAMA_MODEL);
            expect(body.chat_template_kwargs, `検知の本文に思考を切る指定が無い：${describeBody(body)}`).toEqual({ enable_thinking: false });
          }
        }
      },
      {
        settings: {
          "novelai.lmstudio.endpoint": `${origin}/v1`,
          "novelai.ollama.endpoint": DEAD_ENDPOINT,
        },
        // 作風診断の声かけは AI の案内より先に出て答えを待つので、済んだことにして起こす（firstRunGuide と同じ）
        globalState: { [WRITER_WELCOME_KEY]: "done" },
      }
    );
  } finally {
    await fake?.close();
  }
}, 300_000);
