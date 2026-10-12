/**
 * 検索用の索引づくり（意味検索）を、外部AIの依頼（run.request の vectorIndex）とコマンドパレットの
 * 両方から回す（画面の自動テスト、設計書6.87.23・6.19.11・6.113。実機確認リスト 62・64・65 を、
 * 仕分け 2026-10-12 の束 E3 として移した。作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 何を見張るか：
 * - 62：外部AIの依頼（`scope: all`）を受けると、作者の VS Code に「外部AI（claude-code）からの依頼です。
 *   N作品の検索用の索引を作りますか？」の確認が出て、作品の一覧・「手元の Ollama（bge-m3）」・「料金：無料」・
 *   許可の無い作品の「回さない作品」の行が読める。押すと進捗が出て、結果（`run.result` が読む
 *   `<依頼番号>.state.json`）が `done` で、作品ごとの `built`・`reused`・`seconds`、許可の無い作品が `skipped`。
 *   各作品の `.aiwriter/cache/vector/index.json` に `builtAt` と `endpoint` が入る
 * - 64：索引づくりの途中で［中止］を押すと止まり、止めた作品と後の作品が `cancelled`、それまでの作品が
 *   `done`。もう一度頼むと、止めた作品が続きから進む（`reused` が増える）
 * - 65：コマンドパレットの「検索索引作成／更新（全作品）」で、確認（作品の一覧）→ 進捗 →
 *   「検索用の索引：できた N作品（N秒）」の知らせ。意味検索が「切」のときは「準備を開く」の知らせだけ
 *
 * **項目の前提と実装が違っていたところ**：62・64 は進捗と［中止］を「右下」と書いているが、
 * 製品の進捗は**ステータスバー**（`views/progress.ts` の `withCancellableProgress`。`ProgressLocation.Window`
 * と、隣の「中止」の項目）に出る。ここではステータスバーを読んで押す。
 *
 * 依頼の届け方：MCP の `run.request` は、保管庫の `run-requests/<依頼番号>.request.json` に札を置き、
 * `vscode://nonahisa.novel-ai-assistant/run?id=…&token=…` を **OS に**開かせる。テストで OS に開かせると
 * 作者の VS Code へ届いてしまうので、**札は同じ形でテストが置き**（`src/core/runRequest.ts` の部品で組む）、
 * URI はテスト用の VS Code の中の「Developer: Open URL」（`workbench.action.url.openUrl`。使い捨ての
 * keybindings.json に足したキー）で開く。拡張機能の受け口（`features/readerStatsHelperLink.ts` →
 * `features/runRequestHandler.ts`）から先は、製品の道そのまま。**製品には何も足さない。**
 *
 * 許可の印（`.aiwriter/external-access.json`）は、作り物の作品にだけ、製品の書き方
 * （`formatExternalAccessPermission`）で置く。作者の作品の印には触れない。
 *
 * **本物の AI は呼ばない。** 埋め込みは偽の Ollama（`support/fakeOllama.ts` の `/api/embed`）が
 * 決まった語の数え方で返す。料金はかからず、作者の Ollama にも触れない。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, test } from "vitest";
import { formatExternalAccessPermission } from "../../src/core/externalAccessPermission";
import { sha256Text } from "../../src/core/hash";
import {
  buildRunUri,
  parseRunState,
  RUN_INDEX_FEATURE,
  RUN_REQUEST_DIRECTORY,
  runStateFileName,
  runTicketFileName,
  type RunIndexRow,
  type RunStateRecord,
  type RunTicket,
} from "../../src/core/runRequest";
import { VECTOR_INDEX_DIR, VECTOR_INDEX_META_FILE, type StoredMeta } from "../../src/core/vectorIndexFormat";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { describeNotices, recordedNotices, waitForNotice } from "./support/noticeRecord";
import { fillInput, runCommand } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  notificationTexts,
  pressDialogButton,
  pressWorkbenchKey,
  quickInputWaitContext,
  statusBarTexts,
} from "./support/workbenchDom";

/** 頼んだ接続元の名乗り（MCP の `getExternalClientName` が Claude Code で返すもの） */
const CLIENT = "claude-code";
/** 埋め込みのモデル（設定 `novelai.vectorSearch.model` の既定。確認の文に出る） */
const EMBED_MODEL = "bge-m3";

/*
  作品の題。**登録簿の並びは題の順**（`core/workRegistry.ts` の `list()`。日本語の照合）で、
  全作品の索引づくりはこの順に回す。英字で始まる題は漢字で始まる題（`E2E_WORK_TITLE`）より前に来るので、
  「先の作品（できる）→ 長い作品（途中で止める）→ 画面テストの作品（止めたあと＝回さない）」の順にする。
  並びを決め打ちせず、結果の行の順で前後を確かめる（違えば並びを添えて落とす）
*/
const BEFORE_TITLE = "Index1 先の作品";
const LONG_TITLE = "Index2 長い作品";
/** 許可の印を置かない作品（回さない作品に並ぶ） */
const DENIED_TITLE = "Index0 許可の無い作品";

/**
 * 長い作品の話の数。**埋め込みは16場面ずつ**（`features/vectorSearch.ts` の `EMBED_BATCH`）送るので、
 * 17場面以上あれば2束になり、1束目のあとで中止すると「途中まで保存して止めた」形になる。
 * 1話は1場面（400字に満たない。`core/passages.ts` の `PASSAGE_CHARS`）にする
 */
const LONG_EPISODES = 20;
const EMBED_BATCH = 16;

/** 1つの作品の話（題ごとに語を変える。同じ文の場面は1回しか埋め込まれないので、全部違う文にする） */
function shortEpisode(title: string): { name: string; text: string } {
  return { name: "001_はじまり.txt", text: `　${title}の駅に雨が降った。\n　改札の前で切符を握りしめた。\n` };
}

function longEpisodes(): Array<{ name: string; text: string }> {
  return Array.from({ length: LONG_EPISODES }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return { name: `${number}_第${index + 1}話.txt`, text: `　第${index + 1}話。港の灯台に船が${index + 1}隻戻った。\n` };
  });
}

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

async function writeWork(folder: string, episodes: ReadonlyArray<{ name: string; text: string }>): Promise<void> {
  await mkdir(path.join(folder, "本文"), { recursive: true });
  for (const episode of episodes) await writeFile(path.join(folder, "本文", episode.name), episode.text, "utf8");
}

/** ほかの作品を登録するキー（使い捨ての keybindings.json。製品にもこのファイルのほかのキーにも無い組） */
const EXTRA_WORKS = [
  { title: BEFORE_TITLE, key: "ctrl+alt+shift+a", press: "Control+Alt+Shift+KeyA" },
  { title: LONG_TITLE, key: "ctrl+alt+shift+d", press: "Control+Alt+Shift+KeyD" },
  { title: DENIED_TITLE, key: "ctrl+alt+shift+e", press: "Control+Alt+Shift+KeyE" },
] as const;

/** 「Developer: Open URL」のキー（URI をテスト用の VS Code の中で開く） */
const OPEN_URL_KEY = "ctrl+alt+shift+q";
const OPEN_URL_PRESS = "Control+Alt+Shift+KeyQ";

function folderOf(session: E2ESession, title: string): string {
  return title === E2E_WORK_TITLE ? session.workFolder : path.join(path.dirname(session.workFolder), title);
}

/** 起こし方。作品の置き場は書庫の中（ワークスペースの中）。登録のキーの引数は準備のときに埋める */
function launchFor(fake: FakeOllama | undefined, enabled: boolean): LaunchOptions {
  const registerBindings = EXTRA_WORKS.map((work) => ({
    key: work.key,
    command: "novelai.addWork",
    args: { folderPath: "", title: work.title } as Record<string, unknown>,
  }));
  const base: LaunchOptions = {
    settings: {
      "novelai.vectorSearch.enabled": enabled,
      /*
        **拡張機能へ URI を渡す前の「開かせますか」の窓を出さない。** 作者の VS Code では、
        依頼のたびに MCP が OS に開かせ、VS Code がこの拡張機能へ渡す（一度許せば訊かれない）。
        ここで見たいのはその先の、製品の確認の窓である
      */
      "extensions.confirmedUriHandlerExtensionIds": ["nonahisa.novel-ai-assistant"],
    },
    keybindings: [...registerBindings, { key: OPEN_URL_KEY, command: "workbench.action.url.openUrl" }],
    // keybindings.json はこの準備のあとに書かれるので、置き場の道はここで args へ入れる
    prepareWork: async ({ workFolder }) => {
      const library = path.dirname(workFolder);
      for (const [index, work] of EXTRA_WORKS.entries()) {
        const folder = path.join(library, work.title);
        await writeWork(folder, work.title === LONG_TITLE ? longEpisodes() : [shortEpisode(work.title)]);
        if (work.title !== DENIED_TITLE) await allowRunRequest(folder);
        registerBindings[index].args = { folderPath: folder, title: work.title };
      }
      await allowRunRequest(workFolder);
    },
  };
  return fake ? fakeOllamaLaunch(fake, base) : base;
}

/**
 * ほかの作品を登録する（キーを押し、作品の印 `.aiwriter/config.json` ができるまで待つ）。
 * 拡張機能が起ききっていないとキーが空振りするので、できるまで押し直す（同じ場所の二重の登録は製品が断る）
 */
async function registerExtraWorks(session: E2ESession): Promise<void> {
  const { page } = session;
  for (const work of EXTRA_WORKS) {
    const config = path.join(folderOf(session, work.title), ".aiwriter", "config.json");
    const until = Date.now() + 60_000;
    for (;;) {
      await pressWorkbenchKey(page, work.press);
      const done = await waitUntil(() => existsSync(config), `「${work.title}」の ${config} ができる`, 5_000)
        .then(() => true)
        .catch(() => false);
      if (done) break;
      if (Date.now() > until) {
        throw new Error(`「${work.title}」を登録できません（${await describeNotices(session)}）`);
      }
    }
  }
  // 登録のあと遅れて消える形の見張り（製品は2秒まで見張る）を待ち、知らせを閉じる
  await page.waitForTimeout(2_500);
  await clearNotifications(page);
}

/** 保管庫（この拡張機能の globalStorage）。VS Code が作る名前を探し、無ければ同じ名前で作る */
async function storageRoot(session: E2ESession): Promise<string> {
  const base = path.join(session.root, "user-data", "User", "globalStorage");
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const found = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === "nonahisa.novel-ai-assistant");
  return path.join(base, found?.name ?? "nonahisa.novel-ai-assistant");
}

/**
 * MCP の `run.request` と同じ形の札を置き、URI をテスト用の VS Code の中で開く。依頼番号を返す。
 * 札の時刻は開く直前（受け口は10分を過ぎた札を断る）
 */
async function sendIndexRequest(session: E2ESession): Promise<string> {
  const { page } = session;
  const id = randomBytes(8).toString("hex");
  const token = randomBytes(32).toString("hex");
  const ticket: RunTicket = {
    version: 1,
    id,
    tokenHash: sha256Text(token),
    feature: RUN_INDEX_FEATURE,
    folder: session.workFolder,
    scope: "all",
    client: CLIENT,
    createdAt: new Date().toISOString(),
  };
  const folder = path.join(await storageRoot(session), RUN_REQUEST_DIRECTORY);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, runTicketFileName(id)), `${JSON.stringify(ticket, null, 2)}\n`, "utf8");

  const uri = buildRunUri(id, token);
  await pressWorkbenchKey(page, OPEN_URL_PRESS);
  await fillInput(page, uri).catch(async (error: unknown) => {
    throw new Error(`「Open URL」の入力欄が出ません（${String(error)}）${await quickInputWaitContext(page)}`);
  });
  await page.keyboard.press("Enter");
  return id;
}

/** 依頼の確認の窓（製品の `describeIndexConfirm`）が出るまで待ち、文を返す */
async function waitForIndexConfirm(session: E2ESession): Promise<string> {
  const { page } = session;
  let text: string | undefined;
  await waitUntil(
    async () => {
      text = await dialogText(page);
      if (text?.includes("手元のAIへ送る前に確かめてください")) await passLocalAiGate(page);
      return (text ?? "").includes("検索用の索引を作りますか");
    },
    "外部AIの依頼の確認の窓が出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(text)}／${await describeNotices(session)}）`);
  });
  return text ?? "";
}

async function readState(session: E2ESession, id: string): Promise<RunStateRecord | undefined> {
  const file = path.join(await storageRoot(session), RUN_REQUEST_DIRECTORY, runStateFileName(id));
  const text = await readFile(file, "utf8").catch(() => undefined);
  return text === undefined ? undefined : parseRunState(text);
}

/** 依頼の結果が `done` になるまで待ち、作品ごとの行を返す（`run.result` が読むのと同じファイル） */
async function waitForIndexRows(session: E2ESession, id: string, fake: FakeOllama): Promise<RunIndexRow[]> {
  let state: RunStateRecord | undefined;
  await waitUntil(
    async () => {
      state = await readState(session, id);
      return state?.state === "done" || state?.state === "failed" || state?.state === "refused" || state?.state === "declined";
    },
    "依頼の結果（state.json）が終わりの状態になる",
    90_000
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（いまの状態：${JSON.stringify(state)}／ステータスバー：${JSON.stringify(await statusBarTexts(session.page))}` +
        `／埋め込みの呼び出し ${fake.embedRequests.length}回／${await describeNotices(session)}）`
    );
  });
  expect(state?.state, `依頼の結果：${JSON.stringify(state)}`).toBe("done");
  return (state?.result?.findings ?? []) as RunIndexRow[];
}

async function readIndexMeta(folder: string): Promise<StoredMeta | undefined> {
  const text = await readFile(path.join(folder, ...VECTOR_INDEX_DIR, VECTOR_INDEX_META_FILE), "utf8").catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as StoredMeta);
}

function rowOf(rows: readonly RunIndexRow[], title: string): RunIndexRow {
  const row = rows.find((entry) => entry.workTitle === title);
  if (!row) throw new Error(`結果に「${title}」の行がありません（${JSON.stringify(rows)}）`);
  return row;
}

/** 進捗のステータスバーの項目（「検索用の索引を作っています…」）の字 */
async function progressText(page: Page): Promise<string> {
  return (await statusBarTexts(page)).find((text) => text.includes("検索用の索引を作っています")) ?? "";
}

test("外部AIからの全作品の索引づくりは、確認に作品・手元のOllama・無料・回さない作品が並び、途中の［中止］で止めた作品と後の作品が cancelled、頼み直すと続きから進み、パレットの全作品の索引づくりは「できた N作品」で終わる", async () => {
  /*
    **門**：長い作品の1束目（16場面）の埋め込みだけを止める。止めている間にステータスバーの［中止］を押し、
    押したあとで開ける。2回目の依頼・パレットの索引づくりでは止めない（1回きり）
  */
  let gateUsed = false;
  let heldResolve: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    heldResolve = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = await startFakeOllama(() => "{}", {
    extraModels: [EMBED_MODEL],
    beforeEmbed: async (inputs) => {
      if (gateUsed || inputs.length !== EMBED_BATCH) return;
      gateUsed = true;
      heldResolve();
      await released;
    },
  });
  try {
    await withVsCode(
      "索引づくり：外部AIの依頼と中止と頼み直し",
      [shortEpisode(E2E_WORK_TITLE)],
      async (session) => {
        const { page } = session;
        await registerExtraWorks(session);

        /* ── 62：確認の窓（作品の一覧・手元のOllama・無料・回さない作品） ── */
        const firstId = await sendIndexRequest(session);
        const confirm = await waitForIndexConfirm(session);
        expect(confirm).toContain(`外部AI（${CLIENT}）からの依頼です。3作品の検索用の索引を作りますか？`);
        for (const title of [BEFORE_TITLE, LONG_TITLE, E2E_WORK_TITLE]) expect(confirm).toContain(title);
        expect(confirm).toContain(`手元の Ollama（${EMBED_MODEL}）`);
        expect(confirm).toContain("料金：無料");
        expect(confirm).toContain(`回さない作品：${DENIED_TITLE}（許可が無い）`);
        await pressDialogButton(page, "走らせる");

        /* ── 64：長い作品の途中で、ステータスバーの［中止］を押す ── */
        await Promise.race([
          held,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("長い作品の1束目の埋め込みが60秒たっても来ません")), 60_000)
          ),
        ]).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}（埋め込みの呼び出し：${JSON.stringify(fake.embedRequests.map((inputs) => inputs.length))}` +
              `／ステータスバー：${JSON.stringify(await statusBarTexts(page))}／${await describeNotices(session)}）`
          );
        });
        // 進捗はステータスバーに出る（項目の「右下」ではない）。外部AIからの依頼だと分かる題と、何作品目かが読める
        await waitUntil(async () => (await progressText(page)).includes(LONG_TITLE), "進捗に長い作品の名前が出る", 15_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（ステータスバー：${JSON.stringify(await statusBarTexts(page))}）`);
          }
        );
        expect(await progressText(page)).toContain("検索用の索引を作っています（外部AIからの依頼）");
        const stop = page.locator(".part.statusbar .statusbar-item", { hasText: "中止" }).first();
        await stop.waitFor({ state: "visible", timeout: 10_000 }).catch(async (error: unknown) => {
          throw new Error(`ステータスバーに［中止］が出ません（${String(error)}／ステータスバー：${JSON.stringify(await statusBarTexts(page))}）`);
        });
        await stop.click();
        // 押したことが製品に届いてから門を開ける（届く前に開けると、2束目まで進んでしまう）
        await page.waitForTimeout(1_000);
        release();

        const firstRows = await waitForIndexRows(session, firstId, fake);
        // 結果の行は回した順（登録簿の題の順）＋回さない作品。長い作品の前後で分ける
        const ran = firstRows.filter((row) => row.status !== "skipped");
        const longAt = ran.findIndex((row) => row.workTitle === LONG_TITLE);
        const order = `回した順：${ran.map((row) => `${row.workTitle}=${row.status}`).join(" → ")}`;
        expect(longAt, `長い作品が先頭でも末尾でもないこと（${order}）`).toBeGreaterThan(0);
        expect(longAt, `長い作品の後にも作品があること（${order}）`).toBeLessThan(ran.length - 1);
        for (const row of ran.slice(0, longAt)) {
          expect(row.status, `中止の前の作品は done（${order}）`).toBe("done");
          expect(row.built ?? 0, `中止の前の作品は埋め込んでいる ${JSON.stringify(row)}`).toBeGreaterThan(0);
          expect(typeof row.seconds, `秒が入る ${JSON.stringify(row)}`).toBe("number");
        }
        const stopped = ran[longAt];
        expect(stopped.status, `止めた作品は cancelled ${JSON.stringify(stopped)}`).toBe("cancelled");
        expect(stopped.reason ?? "").toContain("途中で中止しました");
        expect(stopped.built, `止めた作品は1束目（${EMBED_BATCH}場面）まで作って保存した ${JSON.stringify(stopped)}`).toBe(EMBED_BATCH);
        for (const row of ran.slice(longAt + 1)) {
          expect(row.status, `中止の後の作品は cancelled（${order}）`).toBe("cancelled");
          expect(row.reason ?? "").toContain("中止したため回していません");
        }
        const denied = rowOf(firstRows, DENIED_TITLE);
        expect(denied.status).toBe("skipped");
        expect(denied.reason ?? "").toContain("許可されていません");

        // 索引のファイル：できた作品には builtAt と endpoint（偽の Ollama の場所）。止めた作品は1束目まで
        const beforeMeta = await readIndexMeta(folderOf(session, BEFORE_TITLE));
        expect(beforeMeta?.builtAt, `先の作品の index.json ${JSON.stringify(beforeMeta)}`).toEqual(expect.any(String));
        expect(beforeMeta?.endpoint).toBe(fake.endpoint);
        expect((await readIndexMeta(folderOf(session, LONG_TITLE)))?.hashes.length, "止めた作品の索引は1束目まで").toBe(EMBED_BATCH);
        expect(await readIndexMeta(folderOf(session, DENIED_TITLE)), "許可の無い作品には索引を作らない").toBeUndefined();

        await waitForNotice(session, (message) => message.includes("外部AIから頼まれた索引づくりを終えました"), "依頼の終わりの知らせ");
        await clearNotifications(page);

        /* ── 64 の続き：もう一度頼むと、止めた作品は続きから（reused が増える） ── */
        const secondId = await sendIndexRequest(session);
        await waitForIndexConfirm(session);
        await pressDialogButton(page, "走らせる");
        const secondRows = await waitForIndexRows(session, secondId, fake);
        const resumed = rowOf(secondRows, LONG_TITLE);
        expect(resumed.status, JSON.stringify(secondRows)).toBe("done");
        expect(resumed.reused, `止めた作品は、作った1束目をそのまま使う ${JSON.stringify(resumed)}`).toBe(EMBED_BATCH);
        expect(resumed.built, `残りだけを作る ${JSON.stringify(resumed)}`).toBe(LONG_EPISODES - EMBED_BATCH);
        const again = rowOf(secondRows, BEFORE_TITLE);
        expect(again.status).toBe("done");
        expect(again.built, `前に作った作品は作り直さない ${JSON.stringify(again)}`).toBe(0);
        expect(rowOf(secondRows, E2E_WORK_TITLE).status, "前回回さなかった作品は今回できる").toBe("done");
        expect(rowOf(secondRows, DENIED_TITLE).status).toBe("skipped");
        await waitForNotice(
          session,
          (message) => message.includes("外部AIから頼まれた索引づくりを終えました（できた 3作品）"),
          "2回目の依頼の終わりの知らせ（できた 3作品）"
        );
        await clearNotifications(page);

        /* ── 65：コマンドパレットの全作品の索引づくり（自分で押すときは許可の印を見ない＝4作品） ── */
        const since = Date.now();
        await runCommand(page, "検索索引作成／更新（全作品）");
        let paletteConfirm: string | undefined;
        await waitUntil(
          async () => ((paletteConfirm = await dialogText(page)) ?? "").includes("検索用の索引を、順に作る・更新します"),
          "全作品の索引づくりの確認の窓が出る",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（いま出ている窓：${JSON.stringify(paletteConfirm)}／${await describeNotices(session, since)}）`);
        });
        expect(paletteConfirm).toContain("登録されている 4作品の検索用の索引を、順に作る・更新します。");
        for (const title of [BEFORE_TITLE, LONG_TITLE, E2E_WORK_TITLE, DENIED_TITLE]) expect(paletteConfirm).toContain(title);
        expect(paletteConfirm).toContain(`手元の Ollama（${EMBED_MODEL}）で作ります。料金はかかりません。`);
        await pressDialogButton(page, "作る");
        const done = await waitForNotice(session, (message) => message.startsWith("検索用の索引："), "全作品の索引づくりの終わりの知らせ", {
          since,
          timeoutMs: 90_000,
        });
        expect(done).toMatch(/検索用の索引：できた 4作品（\d+秒）/);
        expect(await readIndexMeta(folderOf(session, DENIED_TITLE)), "自分で押した索引づくりは、許可の印の無い作品にも作る").toBeDefined();
      },
      launchFor(fake, true)
    );
  } finally {
    release();
    await fake.close();
  }
}, 420_000);

test("意味検索が「切」のとき、パレットの「検索索引作成／更新（全作品）」は確認を出さず「準備を開く」の知らせだけを出す", async () => {
  await withVsCode(
    "索引づくり：意味検索が切",
    [shortEpisode(E2E_WORK_TITLE)],
    async (session) => {
      const { page } = session;
      const since = Date.now();
      await runCommand(page, "検索索引作成／更新（全作品）");
      const message = await waitForNotice(
        session,
        (text) => text.includes("意味検索が「切」になっています"),
        "意味検索が切の知らせ",
        { since }
      );
      expect(message).toContain("切のままでも相談は語句一致で場面を探すので、索引は要りません。");
      // 記録（MCP の notices.recent が読むファイル）にも残る
      await waitUntil(
        async () => (await recordedNotices(session)).some((entry) => entry.message.includes("意味検索が「切」になっています")),
        "知らせの記録に「切」の知らせが残る",
        10_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await describeNotices(session, since)}）`);
      });
      // 右下の知らせには［準備を開く］が付いている
      await waitUntil(
        async () => (await notificationTexts(page)).some((text) => text.includes("意味検索が「切」") && text.includes("準備を開く")),
        "右下の知らせに［準備を開く］が付く",
        10_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      // 確認の窓は出ない（知らせだけ）
      await holdsFor(async () => (await dialogText(page)) === undefined, "確認の窓が出ない", 3_000);
    },
    launchFor(undefined, false)
  );
}, 240_000);
