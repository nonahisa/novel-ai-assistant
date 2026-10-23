/**
 * 外部AIからの実行の依頼（`run.request` の `typo`）を、作者の VS Code の側で受けて確かめ・走らせ・断る
 * （画面の自動テスト、設計書6.87.22・6.113。実機確認リスト「0.88.1 外部AIから、作者のAI設定で走らせて
 * もらう」の3項目を、仕分け 2026-10-16 の束 E27 として移した）。
 *
 * 何を見張るか：
 * - 1件目（リストの1項目めと3項目め）：依頼が届くと、**VS Code 自身の「拡張機能にこの URI を開かせますか」**
 *   の問いが出るか（出たら文と「今後は確認しない」の有無を控える）。その先に製品の確認
 *   「外部AI（claude-code）からの依頼です。あなたのAIで「誤字脱字の検知」を走らせますか？」が出て、
 *   保管庫の `<依頼番号>.state.json` が `confirming`。確認の中身に作品名・対象・使うAIとモデル・送る量・
 *   「料金：無料」。「走らせる」を押すと `running` になり、ステータスバーに進み具合が出て、終わると
 *   「外部AIから頼まれた「誤字脱字の検知」を終えました（N件）」の知らせ、`done` と指摘 N件。
 *   **提案パネルは開かず、`.aiwriter/findings.jsonl` も作られない**
 * - 2件目（リストの2項目め）：誤字脱字をクラウドのAI（Gemini）に割り当てると、確認に料金の断り
 *   （画面の確認と同じ3行「Gemini（無料枠あり・超えると有料）で送ります／送るもの：本文 約N字（1話）／料金：…」。
 *   設計書7.1.1）が出る。**押さずに閉じる**と `declined`。
 *   鍵は置かない——確認はAIを呼ぶ前に出るので、鍵が無くても確認までは届く（押さないので送らない）
 *
 * 依頼の届け方は `vectorIndexRequests.test.ts` と同じ：MCP の `run.request` と同じ形の札を保管庫へ置き、
 * URI はテスト用の VS Code の中の「Developer: Open URL」で開く。**OS には開かせない**（作者の VS Code へ
 * 届いてしまう）。だから「作者の VS Code が前に出るか」は見えない（画面の外で起こしている）。
 * 許可の印は作り物の作品にだけ、製品の書き方（`formatExternalAccessPermission`）で置く。
 *
 * **本物の AI は呼ばない。** 1件目は偽の Ollama（答えはテストが解くまで止めておき、走っている間の
 * 様子を読む）。2件目は確認で閉じるので、どの AI も呼ばれない。
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { formatExternalAccessPermission } from "../../src/core/externalAccessPermission";
import { sha256Text } from "../../src/core/hash";
import {
  buildRunUri,
  parseRunState,
  RUN_REQUEST_DIRECTORY,
  runStateFileName,
  runTicketFileName,
  type RunStateRecord,
  type RunTicket,
} from "../../src/core/runRequest";
import { describeFakeRequests, FAKE_OLLAMA_MODEL, fakeOllamaLaunch, passLocalAiGate, startFakeOllama } from "./support/fakeOllama";
import { describeNotices, waitForNotice } from "./support/noticeRecord";
import { fillInput } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  closeDialog,
  countTabsNamed,
  dialogText,
  editorGroupTabs,
  pressDialogButton,
  pressWorkbenchKey,
  quickInputWaitContext,
  statusBarTexts,
} from "./support/workbenchDom";

/** 頼んだ接続元の名乗り（MCP の `getExternalClientName` が Claude Code で返すもの） */
const CLIENT = "claude-code";
const EPISODE = "001_はじまり.txt";
/** 2行目に「け」の重なり（偽の AI が指摘する所。本文に実在するので検算を通る） */
const TEXT = "　朝の駅は静かだった。\n　改札を抜けけて、白い息を吐いた。\n";
/** 製品の確認の一文（`core/runRequest.ts` の `describeRunConfirm` の message） */
const CONFIRM_HEAD = `外部AI（${CLIENT}）からの依頼です。あなたのAIで「誤字脱字の検知」を走らせますか？`;

/** 「Developer: Open URL」のキー（URI をテスト用の VS Code の中で開く。製品のキーとも重ならない組） */
const OPEN_URL_KEY = "ctrl+alt+shift+q";
const OPEN_URL_PRESS = "Control+Alt+Shift+KeyQ";

/** 作品へ許可の印（claude-code に run.request だけ）を、製品の書き方で置く */
async function allowRunRequest(workFolder: string): Promise<void> {
  const folder = path.join(workFolder, ".aiwriter");
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "external-access.json"),
    formatExternalAccessPermission({
      clients: [
        { name: CLIENT, tools: ["run.request"], sampling: false, decidedAt: "", decidedOn: "画面テスト", note: "" },
      ],
      legacy: false,
    }),
    "utf8"
  );
}

/**
 * 起こし方。`askUriHandler` が真なら、VS Code 自身の「この URI を開かせますか」の問いを止めない
 * （作者の VS Code で最初の依頼のときに出るはずのもの。リストの1項目めが訊いている）
 */
function launch(askUriHandler: boolean, extra: LaunchOptions = {}): LaunchOptions {
  return {
    ...extra,
    settings: {
      ...(askUriHandler ? {} : { "extensions.confirmedUriHandlerExtensionIds": ["nonahisa.novel-ai-assistant"] }),
      ...extra.settings,
    },
    keybindings: [...(extra.keybindings ?? []), { key: OPEN_URL_KEY, command: "workbench.action.url.openUrl" }],
    prepareWork: async (context) => {
      await allowRunRequest(context.workFolder);
      await extra.prepareWork?.(context);
    },
  };
}

/** 保管庫（この拡張機能の globalStorage）。VS Code が作る名前を探し、無ければ同じ名前で作る */
async function storageRoot(session: E2ESession): Promise<string> {
  const base = path.join(session.root, "user-data", "User", "globalStorage");
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const found = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === "nonahisa.novel-ai-assistant");
  return path.join(base, found?.name ?? "nonahisa.novel-ai-assistant");
}

/**
 * MCP の `run.request`（`feature: typo`、作品全体）と同じ形の札を置き、URI をテスト用の VS Code の中で開く。
 * 依頼番号を返す。札の時刻は開く直前（受け口は10分を過ぎた札を断る）
 */
async function sendTypoRequest(session: E2ESession): Promise<string> {
  const { page } = session;
  const id = randomBytes(8).toString("hex");
  const token = randomBytes(32).toString("hex");
  const ticket: RunTicket = {
    version: 1,
    id,
    tokenHash: sha256Text(token),
    feature: "typo",
    folder: session.workFolder,
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

async function waitState(session: E2ESession, id: string, state: RunStateRecord["state"], label: string): Promise<RunStateRecord> {
  let last: RunStateRecord | undefined;
  await waitUntil(
    async () => {
      last = await readState(session, id);
      return last?.state === state;
    },
    label,
    60_000
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（いまの状態：${JSON.stringify(last)}／窓：${JSON.stringify(await dialogText(session.page))}` +
        `／ステータスバー：${JSON.stringify(await statusBarTexts(session.page))}／${await describeNotices(session)}）`
    );
  });
  return last as RunStateRecord;
}

/** 確認の窓のボタンの名前 */
async function dialogButtons(page: Page): Promise<string[]> {
  return page.locator(".monaco-dialog-box .monaco-button").allInnerTexts().catch(() => [] as string[]);
}

/**
 * 製品の確認の窓が出るまで待つ。途中で VS Code 自身の「URI を開かせますか」の問いが出たら、文とボタン・
 * チェック欄を控えて、開かせる側のボタン（先頭の主ボタン）を押す。控えた文を返す（出なければ undefined）
 */
async function waitProductConfirm(session: E2ESession): Promise<{ confirm: string; uriPrompt?: string }> {
  const { page } = session;
  let text: string | undefined;
  let uriPrompt: string | undefined;
  await waitUntil(
    async () => {
      text = await dialogText(page);
      if (text === undefined) return false;
      if (text.includes("手元のAIへ送る前に確かめてください")) {
        await passLocalAiGate(page);
        return false;
      }
      if (text.includes(CONFIRM_HEAD)) return true;
      if (uriPrompt === undefined) {
        // 製品の確認でない窓＝VS Code 自身の問い。文・ボタン・チェック欄をそのまま控える
        const buttons = await dialogButtons(page);
        const checkbox = await page.locator(".monaco-dialog-box .dialog-checkbox-row").allInnerTexts().catch(() => [] as string[]);
        uriPrompt = `${text.replace(/\s+/g, " ").trim()}［ボタン：${buttons.join("／")}］［チェック欄：${checkbox.join("／") || "なし"}］`;
        await page.locator(".monaco-dialog-box .monaco-button").first().click();
      }
      return false;
    },
    "製品の確認「外部AI（claude-code）からの依頼です…」が出る",
    45_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(text)}／控えた URI の問い：${JSON.stringify(uriPrompt)}／${await describeNotices(session)}）`);
  });
  return { confirm: text ?? "", ...(uriPrompt !== undefined ? { uriPrompt } : {}) };
}

/** 偽の AI の指摘（2行目の「抜けけて」）。誤字脱字のスキーマ（`prompts/typoCheck.ts` の `TYPO_CHECK_SCHEMA`）の形 */
const TYPO_ANSWER = JSON.stringify({
  issues: [
    { line: 2, original: "　改札を抜けけて、白い息を吐いた。", target: "抜けけて", suggestion: "抜けて", reason: "「け」が重なっている", confidence: "high" },
  ],
});

test("外部AIの誤字脱字の依頼は、確認に作品・対象・手元のAIとモデル・送る量・無料が並び、［走らせる］で走って「…を終えました（N件）」の知らせと done が残り、提案パネルは開かない", async () => {
  /*
    答えはテストが解くまで止めておく（走っている間のステータスバーと state を読むため。一瞬で返すと見る隙が無い）
  */
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = await startFakeOllama(async () => {
    await gate;
    return TYPO_ANSWER;
  });
  try {
    await withVsCode(
      "外部AIの誤字脱字の依頼",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        const from = fake.requests.length;
        const findingsFile = path.join(session.workFolder, ".aiwriter", "findings.jsonl");

        const id = await sendTypoRequest(session);
        const { confirm, uriPrompt } = await waitProductConfirm(session);
        // VS Code 自身の問いの有無は、決め打ちせずに控える（版で変わる。項目は「出るなら文を控える」）
        console.log(`[E2E] VS Code 自身の「URI を開かせますか」の問い：${uriPrompt ?? "出なかった"}`);

        expect((await readState(session, id))?.state, "確認が出ている間の state は confirming").toBe("confirming");
        expect(confirm, "確認に作品名が無い").toContain(`作品：${E2E_WORK_TITLE}`);
        expect(confirm, "確認に対象が無い").toContain("対象：");
        expect(confirm, "確認に使うAIとモデルが無い").toMatch(new RegExp(`使うAI：.*（${FAKE_OLLAMA_MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}）`));
        expect(confirm, "確認に送る量が無い").toMatch(/送る量：本文 約[\d,]+字（1話）/);
        expect(confirm, "手元のAIなのに無料の行が無い").toContain("料金：無料");
        expect(confirm, "手元のAIなのに料金の断りが出た").not.toContain("トークンを消費し");
        expect(fake.requests.length - from, `確認の前に AI が呼ばれました（${describeFakeRequests(fake.requests, from)}）`).toBe(0);

        await pressDialogButton(page, "走らせる");
        await waitState(session, id, "running", "［走らせる］のあと running になる");
        // 走っている間（偽の AI が止めている間）に、ステータスバーへ進み具合が出る
        let progress = "";
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            progress = (await statusBarTexts(page)).find((text) => text.includes("誤字脱字")) ?? "";
            return progress !== "" && fake.requests.length - from > 0;
          },
          "走っている間、ステータスバーに誤字脱字の進み具合が出て、偽の AI に頼みが届く",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}（ステータスバー：${JSON.stringify(await statusBarTexts(page))}／${describeFakeRequests(fake.requests, from)}／${await describeNotices(session)}）`
          );
        });
        console.log(`[E2E] 走っている間のステータスバー：${progress}`);
        release();

        const done = await waitState(session, id, "done", "終わると done になる");
        const count = done.result?.findings.length ?? -1;
        expect(count, `done に結果が無い：${JSON.stringify(done)}`).toBeGreaterThanOrEqual(0);
        await waitForNotice(
          session,
          (message) => message.includes(`外部AIから頼まれた「誤字脱字の検知」を終えました（${count}件）`),
          "依頼の終わりの知らせ（件数は done の指摘の数）"
        );
        console.log(`[E2E] done の指摘：${count}件 ${JSON.stringify(done.result?.findings.map((finding) => finding))}`);

        // 提案パネルは開かず、指摘の置き場も作らない（結果は頼んだ側が読む）
        await holdsFor(
          async () => countTabsNamed((await editorGroupTabs(page)).flat(), "提案") === 0 && !existsSync(findingsFile),
          "提案パネルが開かず、findings.jsonl も作られない",
          3_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（タブ：${JSON.stringify(await editorGroupTabs(page))}／findings.jsonl：${existsSync(findingsFile)}）`);
        });
      },
      fakeOllamaLaunch(fake, launch(true))
    );
  } finally {
    release();
    await fake.close();
  }
}, 240_000);

test("誤字脱字をクラウドのAIに割り当てた作品への依頼は、確認に料金の断りが出て、押さずに閉じると declined になり、AI は呼ばれない", async () => {
  await withVsCode(
    "外部AIの依頼をクラウドで断る",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const id = await sendTypoRequest(session);
      const { confirm } = await waitProductConfirm(session);
      // 有料の断りは画面の確認と同じ3行（設計書7.1.1）。モデル名は［詳しく］の2枚目にある
      expect(confirm, "クラウドのAIなのに料金の断りが無い").toContain("料金：送るたびに、使った量だけかかります");
      expect(confirm, "使うAIが割り当てたクラウドのAIになっていない").toMatch(/Gemini（無料枠あり・超えると有料）で送ります/);
      expect(confirm, "送る量が2行目に無い").toMatch(/送るもの：本文 約[\d,]+字（1話）/);
      expect(confirm, "クラウドのAIなのに無料の行が出た").not.toContain("料金：無料");

      await closeDialog(session.page);
      const state = await waitState(session, id, "declined", "押さずに閉じると declined になる");
      expect(state.startedAt, "押していないのに走り出した印がある").toBeUndefined();
    },
    launch(false, {
      globalState: {
        // 既定は手元の Ollama（行き先は無い所。呼ばれれば落ちる）。誤字脱字だけを Gemini に割り当てる
        "novelai.ai.provider": "ollama",
        "novelai.ai.model": FAKE_OLLAMA_MODEL,
        "novelai.ai.featureAssignments": { typo: { provider: "gemini", model: "gemini-2.5-flash" } },
      },
      settings: { "novelai.ollama.endpoint": "http://127.0.0.1:9" },
    })
  );
}, 180_000);
