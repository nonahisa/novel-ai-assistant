/**
 * 読める長さを測って反映する（画面の自動テスト、設計書6.113・6.49.6。仕分け 2026-10-12 の束 E21。
 * 実機確認リスト 309「J3」を移したもの。作者の裁定 2026-09-26「Ollama は実測が申告より短いときだけ実測を使う」）。
 *
 * 何を見張るか（申告より短いところで頭打ちになる偽のモデルで、AIチューニングの「読める長さだけ測る」を押す）：
 * 1. 反映の確認の文に、J3 の断り「読める長さは、このAIが申告する長さより短いときだけ、測った値を使います
 *    （申告より長くは使いません）。」がある（文面は `features/measureContext.ts` の `offerToSave` から写した）
 * 2. ［設定に反映］を押すと、台帳（保管庫の `model-tuning.json`）に測った長さが入り、
 *    モデル選択の一覧（AI設定）のその行が「文脈 Nk（実測。申告 16k）」になる（`ai/registry.ts` の `formatModelContext`）
 * 3. 「Ollama：… の読める長さは、作者の実測 N トークンを使います（申告 16384。AIチューニングの記録から）。」の行が1度だけ出る
 *    （`ai/ollamaProvider.ts` の `withMeasured`）。**出力パネルは actions.log で読む**——`core/logger.ts` の
 *    `writeLine` が出力パネルと作品の actions.log へ同じ行を書くので、ファイルで数えれば同じことが分かる
 * 4. 続けて誤字脱字を1話走らせると、actions.log の「Ollama：num_ctx N」の N が測った長さそのものになる
 *    （誤字脱字の出力の見込み 8,000 トークン余りが測った長さを超えるので、送る直前の関所が出力を縮め、
 *    確保する長さは読める長さちょうどに丸まる。`ai/contextGuard.ts` の `outputTokensWithinWindow`・
 *    `core/chunker.ts` の `contextSizeForPrompt`）
 *
 * **偽のモデルの作り**（`support/fakeOllama.ts`）：申告（`/api/show`）は 16,384 トークン。入力トークン数
 * （`prompt_eval_count`）は送った字数と同じだけ数え、6,000 で頭打ちにする。製品は入力トークン数の伸びが
 * 止まるところを限界と読む（`core/contextProbe.ts`）。手元で製品の判定関数に同じ数字を通すと、通った長さは
 * 5,350字（6回送る）だった。**期待値は数字を直書きせず、台帳に書かれた値から導く**——字/トークンの換算
 * （実測が5件貯まるまでは 0.7）で台帳の値が変わっても、見ている関係は崩れない。
 *
 * **本物の AI は呼ばない。** 見えるのは「測る → 反映 → 台帳 → 一覧・ログ・送る長さ」の配線で、本物の Ollama が
 * 切り捨てたときに入力トークン数がこう止まるか（モデルの振る舞い）は見えない（→〔AIの測定〕の側）。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { describeFakeRequests, FAKE_OLLAMA_MODEL, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { describeNotices, waitForNotice } from "./support/noticeRecord";
import { runCommand, waitForQuickInput } from "./support/quickInput";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  clearNotifications,
  pickQuickPickRow,
  quickInputWaitContext,
  quickPickRows,
  quickPickTitle,
  statusBarTexts,
  type QuickPickRow,
} from "./support/workbenchDom";

/** 偽のモデルが申告する読める長さ（トークン） */
const DECLARED_TOKENS = 16_384;
/** 偽のモデルが本当に読める長さ（入力トークン数の頭打ち）。申告より短い */
const READABLE_TOKENS = 6_000;
/** 台帳の鍵（`core/modelTuning.ts` の `modelTuningKey`＝`プロバイダID/モデル名`） */
const TUNING_KEY = `ollama/${FAKE_OLLAMA_MODEL}`;

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";
const TYPO_START = "誤字脱字検知を開始:";
const TYPO_END = "誤字脱字検知を終了:";

/** AIチューニングのコマンドの題（package.json） */
const TUNING_COMMAND = "AIチューニング（測って設定を合わせる）";
/** 何を測るかの選ぶ画面の行（`core/tuningScope.ts` の `TUNING_SCOPE_CHOICES`） */
const INPUT_ONLY = "読める長さだけ測る";
/** 反映の確認の頭（`core/tuningOffer.ts` の `tuningOfferMessage`） */
const OFFER_HEAD = `${TUNING_KEY} に反映しますか：読める長さ 約`;
/** J3 の断り（`features/measureContext.ts` の `offerToSave` の notes。一字一句写す） */
const J3_NOTE =
  "読める長さは、このAIが申告する長さより短いときだけ、測った値を使います" + "（申告より長くは使いません）。";
const APPLY_BUTTON = "設定に反映";

/** 作品の操作ログ（`.aiwriter/logs/actions.log`）の行 */
async function actionLogLines(session: E2ESession): Promise<string[]> {
  const text = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** 「作者の実測 N トークンを使います」の行（`ai/ollamaProvider.ts` の `withMeasured` の文を写す） */
function measuredLine(tokens: number): string {
  return `Ollama：${FAKE_OLLAMA_MODEL} の読める長さは、作者の実測 ${tokens} トークンを使います（申告 ${DECLARED_TOKENS}。AIチューニングの記録から）。`;
}

/** 一覧の文脈の表記（`ai/registry.ts` の `formatContext`：1,000 以上は 1,024 で割って丸めた k） */
function formatContext(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1024)}k` : String(tokens);
}

/** 台帳の1行（このテストが読む欄だけ） */
interface TuningRow {
  contextWindow?: number;
  contextHitCeiling?: boolean;
  measuredChars?: number;
}

/**
 * 保管庫の台帳（`model-tuning.json`）から、偽のモデルの行を読む。無ければ undefined。
 *
 * 置き場は使い捨ての user-data の中（`globalStorage/<拡張機能>/`）。拡張機能の id の綴りに頼らず、
 * 名前で歩いて探す（`support/noticeRecord.ts` と同じ手）
 */
async function tuningRow(session: E2ESession): Promise<{ row: TuningRow | undefined; files: string[] }> {
  const files: string[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name === "model-tuning.json") files.push(full);
    }
  };
  await walk(path.join(session.root, "user-data", "User", "globalStorage"), 0);
  for (const file of files) {
    // 書いている最中は読めないことがある（一時ファイル経由で置き換える）。次の回で読めればよい
    const text = await readFile(file, "utf8").catch(() => "");
    if (!text) continue;
    try {
      const table = JSON.parse(text) as Record<string, TuningRow | undefined>;
      if (table[TUNING_KEY] !== undefined) return { row: table[TUNING_KEY], files };
    } catch {
      // 読めなければ次の回へ
    }
  }
  return { row: undefined, files };
}

/** 落ちたときに添える様子：窓・知らせ・ステータスバー・偽の AI への頼み・操作ログの終わり */
async function describeState(session: E2ESession, fake: FakeOllama, from: number, since = 0): Promise<string> {
  const { page } = session;
  const rows = await quickPickRows(page).catch(() => [] as QuickPickRow[]);
  const log = (await actionLogLines(session)).slice(-20).join("\n");
  return (
    `いまの窓：「${(await quickPickTitle(page)) ?? "なし"}」 行：${JSON.stringify(rows.map((row) => `${row.label}｜${row.description}`).slice(0, 8))}` +
    `\n${await describeNotices(session, since)}` +
    `\nステータスバー：${JSON.stringify(await statusBarTexts(page))}` +
    `\n${describeFakeRequests(fake.requests, from)}` +
    `\n操作ログの終わり：\n${log}`
  );
}

test("申告より短いところで頭打ちになるモデルで読める長さを測って反映すると、確認に J3 の断りが出て、一覧が「文脈 Nk（実測。申告 16k）」になり、実測を使う行が1度だけ出て、誤字脱字の num_ctx が測った長さになる", async () => {
  // 測定の詰め物（合言葉の検査）にも誤字脱字にも同じ偽の AI が答える。構造化を求められたら指摘0件
  const fake = await startFakeOllama((request) => (request.structured ? JSON.stringify({ issues: [] }) : "読みました"), {
    contextLength: DECLARED_TOKENS,
    promptTokens: { perChar: 1, cap: READABLE_TOKENS },
  });
  try {
    await withVsCode(
      "読める長さの反映（J3）",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        const from = fake.requests.length;
        const started = Date.now();

        /* ── 1. AIチューニング → 読める長さだけ測る ── */
        await clearNotifications(page);
        await runCommand(page, TUNING_COMMAND);
        // 題にモデル名が入る（「AIチューニング：Ollama（ローカル） / e2e-fake:1b の何を測りますか」）ので部分で待つ
        await waitForQuickInput(page, "の何を測りますか");
        expect(await quickPickTitle(page), "何を測るかの題に偽のモデルが出ていない").toContain(FAKE_OLLAMA_MODEL);
        await pickQuickPickRow(page, INPUT_ONLY);

        /*
          反映の確認（右下の知らせ。ボタン付き）を待ち、見えたその場で文を控えてボタンを押す。
          **待つ間に clearNotifications を押さない**——確認の知らせごと消え、「押さなかった」側へ倒れる
        */
        let offer = "";
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            const toast = page.locator(".notification-toast", { hasText: "に反映しますか" });
            if ((await toast.count()) === 0) return false;
            offer = await toast.first().innerText();
            return true;
          },
          "読める長さを測り終え、反映の確認が右下に出る",
          180_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(session, fake, from, started - 1_000)}`);
        });
        const flat = offer.replace(/\s+/g, "");
        // 知らせの文は折り返しで空白が入りうるので、空白を除いて比べる
        expect(flat, `反映の確認の頭が違う：${offer}`).toContain(OFFER_HEAD.replace(/\s+/g, ""));
        expect(flat, `反映の確認に J3 の断りが無い：${offer}`).toContain(J3_NOTE);
        const offeredText = /読める長さ約([\d,]+)トークン/.exec(flat)?.[1];
        expect(offeredText, `反映の確認から読める長さの数字が読めない：${offer}`).toBeDefined();
        const offered = Number((offeredText ?? "").replace(/,/g, ""));
        expect(offered, `確認に出た読める長さ（${offered}）が申告（${DECLARED_TOKENS}）より短くない`).toBeLessThan(DECLARED_TOKENS);
        // 測定の頼みが偽の AI に届いた（構造化でない頼みが数回）
        expect(
          fake.requests.slice(from).filter((request) => !request.structured).length,
          `測定の詰め物が偽の AI に届いていない\n${describeFakeRequests(fake.requests, from)}`
        ).toBeGreaterThan(1);

        await page
          .locator(".notification-toast", { hasText: "に反映しますか" })
          .locator(".monaco-button", { hasText: APPLY_BUTTON })
          .first()
          .click();
        await waitForNotice(session, (message) => message.includes(`${TUNING_KEY} の記録として覚えました`), "「記録として覚えました」の知らせが出る", {
          since: started,
          timeoutMs: 30_000,
        });

        /* ── 2a. ファイル：台帳に測った長さが入る（申告より短く、天井の印は無い） ── */
        let row: TuningRow | undefined;
        let files: string[] = [];
        await waitUntil(
          async () => {
            ({ row, files } = await tuningRow(session));
            return row?.contextWindow !== undefined;
          },
          `台帳に ${TUNING_KEY} の読める長さが書かれる`,
          15_000
        ).catch((error: unknown) => {
          throw new Error(`${String(error)}（見つけた台帳：${JSON.stringify(files)}／行：${JSON.stringify(row)}）`);
        });
        const measured = (row as TuningRow).contextWindow as number;
        expect(measured, "台帳の読める長さが、確認に出した数字と違う").toBe(offered);
        expect(measured, "台帳の読める長さが申告より短くない").toBeLessThan(DECLARED_TOKENS);
        expect((row as TuningRow).contextHitCeiling, "天井まで通った印が付いている（頭打ちを見つけられていない）").toBe(false);

        /* ── 2b. 画面：モデル選択の一覧の文脈が「文脈 Nk（実測。申告 16k）」 ── */
        const wantedContext = `文脈 ${formatContext(measured)}（実測。申告 ${formatContext(DECLARED_TOKENS)}）`;
        await clearNotifications(page);
        await runCommand(page, "AI設定");
        await waitForQuickInput(page, "使用するAIを選んでください");
        await pickQuickPickRow(page, "Ollama（ローカル）");
        let modelRow: QuickPickRow | undefined;
        await waitUntil(
          async () => {
            if (!((await quickPickTitle(page)) ?? "").includes("使用するモデルを選んでください")) return false;
            modelRow = (await quickPickRows(page)).find((candidate) => candidate.label === FAKE_OLLAMA_MODEL);
            return modelRow !== undefined;
          },
          "モデル選択の一覧に偽のモデルの行が出る",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}${await quickInputWaitContext(page)}\n${await describeState(session, fake, from)}`);
        });
        expect(modelRow?.description, `一覧の文脈の表記が違う（行：${JSON.stringify(modelRow)}）`).toContain(wantedContext);
        // 選ばずに閉じる（割当は変えない）
        await page.keyboard.press("Escape");
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "モデル選択の一覧が閉じる", 10_000);

        /* ── 3. 出力パネルの行（actions.log で読む）：一覧を開いた時点で出ている ── */
        const line = measuredLine(measured);
        await waitUntil(
          async () => (await actionLogLines(session)).some((text) => text.includes(line)),
          "「作者の実測 N トークンを使います」の行が書かれる",
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（探した行：${line}）\n${await describeState(session, fake, from)}`);
        });

        /* ── 4. 誤字脱字を1話：送る num_ctx が測った長さ ── */
        await clearNotifications(page);
        const typoFrom = fake.requests.length;
        const frame = await openEpisode(page, EPISODE, "改札を抜けて");
        await placeCaretAfter(frame, "静かだった。");
        await page.keyboard.press("Control+Alt+KeyT");
        // 量の確認（上部の選ぶ窓。行に「1 チャンク中 1 件を処理します」）で先頭の［実行］を Enter で選ぶ
        let firstRow = "";
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            const title = (await quickPickTitle(page)) ?? "";
            const rows = await quickPickRows(page);
            const text = [title, ...rows.map((candidate) => candidate.label)].join("\n");
            if (!text.includes("チャンク中") || !text.includes("件を処理します")) return false;
            firstRow = rows[0]?.label ?? "";
            return true;
          },
          "誤字脱字の量の確認（チャンク中・件を処理します）が出る",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(session, fake, typoFrom)}`);
        });
        expect(firstRow, "確認の先頭は［実行］（Enter でそのまま走る）").toContain("実行");
        await page.keyboard.press("Enter");
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            const lines = await actionLogLines(session);
            return lines.some((text) => text.includes(TYPO_START)) && lines.some((text) => text.includes(TYPO_END));
          },
          "操作ログに「誤字脱字検知を開始」と「誤字脱字検知を終了」が書かれる",
          60_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(session, fake, typoFrom)}`);
        });

        const lines = await actionLogLines(session);
        const startAt = lines.findIndex((text) => text.includes(TYPO_START));
        // 測定の回の num_ctx の行（送る長さに合わせて変わる）を混ぜないよう、誤字脱字の開始より後だけを見る
        const numCtxLines = lines.slice(startAt).filter((text) => text.includes("Ollama：num_ctx ") && text.includes(`（${FAKE_OLLAMA_MODEL} / 送信`));
        const context = `誤字脱字の num_ctx の行：${JSON.stringify(numCtxLines)}\n${describeFakeRequests(fake.requests, typoFrom)}`;
        expect(numCtxLines.length, `誤字脱字の呼び出しで num_ctx の行が書かれていない\n${context}`).toBeGreaterThan(0);
        const sent = numCtxLines.map((text) => Number(/Ollama：num_ctx (\d+)/.exec(text)?.[1]));
        // 測った長さを超えない（実機確認リストの言い方）うえで、ちょうどその長さになる（上の冒頭の4）
        for (const value of sent) expect(value, `num_ctx が測った長さ（${measured}）を超えている\n${context}`).toBeLessThanOrEqual(measured);
        expect(sent, `num_ctx が測った長さ（${measured}）になっていない\n${context}`).toEqual(sent.map(() => measured));
        expect(
          fake.requests.slice(typoFrom).some((request) => request.structured && request.user.includes("改札を抜けて")),
          `誤字脱字の頼み（本文を載せた構造化の頼み）が届いていない\n${describeFakeRequests(fake.requests, typoFrom)}`
        ).toBe(true);

        /* ── 3（続き）. 実測を使う行は、一覧と誤字脱字の両方を通しても1度だけ ── */
        const measuredLines = lines.filter((text) => text.includes(line));
        expect(measuredLines, `「作者の実測 ${measured} トークンを使います」の行が1度だけでない`).toHaveLength(1);
      },
      fakeOllamaLaunch(fake)
    );
  } finally {
    await fake.close();
  }
}, 360_000);
