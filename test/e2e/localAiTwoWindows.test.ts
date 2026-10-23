/**
 * 手元のAIの札を、**本物の VS Code の窓2つ**で取り合う（画面の自動テスト、設計書6.76.1・6.76.2・6.113）。
 *
 * 実機確認リスト「0.87.5 管理外の負荷の警告を、直前の送信の名残で出さない」の1つ目——
 * 「VS Code の窓を2つ開き、片方で手元の Ollama の誤字脱字検知を回している間に、もう片方で相談を送る」——の
 * 画面の部分を移したもの（2026-10-23。札の取り合いそのものは、同じ日に node のプロセス2つで本物の Ollama を
 * 使って確かめ済み。残っていたのは VS Code の中の道だけだった）。
 *
 * **2つの窓は、同じ user-data の同じ Code.exe の中の別の窓**（`workbench.action.duplicateWorkspaceInNewWindow`）。
 * 窓ごとに拡張機能ホストが別のプロセスで立ち、保管庫（globalStorage）は同じ——作者が窓を2つ開いたときと同じ形で、
 * 製品の「別の窓」そのものである。
 *
 * 何を見張るか：
 * 1. 窓1で Ctrl+Alt+T の誤字脱字検知（3〜4チャンク）を走らせ、1チャンク目を AI が返す前に、窓2の横の相談パネルから送ると、
 *    **窓2のステータスバーに待ちの表示**（題「手元のAIの順番待ち」・本文「別の窓の「…」の完了を待っています…」と
 *    ［中止］。`localAiGate.ts` の `openWaitDisplay` が自前で出す側）が出る。待ちの文は1回だけ（2026-10-23 の裁定
 *    「題を短くする」。前は題にも同じ文を渡していて2回並んだ）。窓2のログの待ちの行は「こちらは「AIへの単発の問い合わせ」」
 *    ＝相談は単発（kind=single）として札を取りに行った
 * 2. 窓1の1チャンク目が返ると、窓2の相談が合間に入り、**［待つ］［このまま送る］［やめる］の警告は出ずに**答えが出る
 * 3. 窓2のログ（窓ごとの出力の記録）の「手元のAIへ送る前の負荷：…」の1行に
 *    「直前の送信の終わりから◯秒なので、名残とみなして使用率の線は見ない」が付く
 * 4. 窓1の一括処理は、窓2の相談のあいだ待ち（窓1のログの待ちの行は「こちらは「誤字脱字…」」＝一括処理の本体が
 *    kind=run を決めた）、最後まで走りきる
 *
 * **AI は偽の Ollama。** 誤字脱字の頼みだけ数秒待たせて返す（札を持ち続けさせるため）。GPU の負荷は本物の
 * nvidia-smi で測られるので、**ほかに GPU を使っているもの（本物の Ollama のモデルなど）があると警告が出て落ちる**——
 * 走らせる前に、手元のAIの札（スキル ai-bench）を取り、載っているモデルを下ろしておく。nvidia-smi の無い機械では
 * 負荷の行そのものが出ないので、3 は飛ばす（失敗の文で分かるように名乗る）。
 *
 * 作者の画面を取りかねない「窓の複製」を使うので、**既定では走らせない**（`NOVELAI_E2E_TWO_WINDOWS=1` のときだけ）。
 * 新しい窓も `keepOutOfTheWay` の差し替え（`browser-window-created`）で画面の外へ置かれる。
 */
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { SEARCH_TERMS_SYSTEM_PROMPT } from "../../src/prompts/searchTerms";
import { TYPO_CHECK_SYSTEM_PROMPT } from "../../src/prompts/typoCheck";
import { chatAnswer, SEARCH_TERMS_ANSWER } from "./support/chatAnswerButtons";
import { sendChatQuestion } from "./support/chatInput";
import { describeFakeRequests, fakeOllamaLaunch, startFakeOllama, type FakeOllama, type FakeOllamaRequest } from "./support/fakeOllama";
import { openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { dialogText, pressWorkbenchKey, quickPickRows, quickPickTitle, statusBarTexts } from "./support/workbenchDom";

const RUN = process.env.NOVELAI_E2E_TWO_WINDOWS === "1";

const EPISODE = "001_はじまり.txt";
/** 300字ずつに切ると3〜4チャンクになる長さ（1行およそ50字×18行） */
const BODY =
  Array.from({ length: 18 }, (_, index) => `　${index + 1}番目の段落。朝の駅は静かで、改札の横に立つリナは古い切符を握りしめて、発車のベルを待っていた。`).join("\n") + "\n";

const OPEN_SIDE_KEY = "ctrl+alt+shift+c";
const OPEN_SIDE_PRESS = "Control+Alt+Shift+KeyC";
const DUPLICATE_KEY = "ctrl+alt+shift+m";
const DUPLICATE_PRESS = "Control+Alt+Shift+KeyM";
const SHOW_LOG_KEY = "ctrl+alt+shift+z";
const SHOW_LOG_PRESS = "Control+Alt+Shift+KeyZ";

const QUESTION = "リナの切符の場面について教えてください";
const ANSWER = "偽のAIの答えです：切符の場面は冒頭にあります。";
/** 誤字脱字の1チャンクを返すまで待たせる長さ。窓2の待ちの表示を撮るあいだ、窓1に送信の札を持たせる */
const TYPO_DELAY_MS = 9_000;
/** 相談の答えを返すまで待たせる長さ。窓1（一括処理）の進捗に待ちの文が出ているところを撮るため */
const CHAT_DELAY_MS = 5_000;

const LOAD_LINE = "手元のAIへ送る前の負荷：";
const SETTLING = "名残とみなして使用率の線は見ない";
const GPU_WARNING = "手元のAIへ送る前に確かめてください";
const SINGLE_LABEL = "こちらは「AIへの単発の問い合わせ」";
const WAITING = "の完了を待っています";

const SHOT_DIR = path.join(tmpdir(), "novelai-e2e-screenshots");

function isTypoRequest(request: FakeOllamaRequest): boolean {
  return request.system.includes(TYPO_CHECK_SYSTEM_PROMPT.split("\n")[0]);
}

function isSearchTermsRequest(request: FakeOllamaRequest): boolean {
  return request.system.includes(SEARCH_TERMS_SYSTEM_PROMPT.split("\n")[0]) || request.user.startsWith("次の質問に合う場面を");
}

let fake: FakeOllama;
beforeAll(async () => {
  if (!RUN) return;
  fake = await startFakeOllama(async (request) => {
    if (isTypoRequest(request)) {
      await new Promise((resolve) => setTimeout(resolve, TYPO_DELAY_MS));
      return JSON.stringify({ issues: [] });
    }
    if (isSearchTermsRequest(request)) return SEARCH_TERMS_ANSWER;
    // 相談の答えも少し待たせる。そのあいだ窓1の一括処理が待つので、窓1の進捗に出る待ちの文を撮れる
    await new Promise((resolve) => setTimeout(resolve, CHAT_DELAY_MS));
    return chatAnswer({ reply: ANSWER });
  });
});
afterAll(async () => {
  await fake?.close();
});

/** 横の相談パネルの面（`#context-what` と `#to-main` を持つ） */
async function sideChatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const isSide = await frame
      .evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null)
      .catch(() => false);
    if (isSide) return frame;
  }
  return undefined;
}

async function chatLog(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("log")?.innerText ?? "").catch(() => "");
}

/**
 * 窓ごとの出力の記録（VS Code が出力の窓の中身を書く `logs/<日時>/window<N>/exthost/output_logging_*／N-小説AI執筆補助.log`）。
 * 作品の操作ログは2つの窓が同じファイルへ書くので、どちらの窓の行かを分けられない。こちらは窓ごとに分かれる
 */
async function outputLogs(session: E2ESession): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (folder: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith("小説AI執筆補助.log")) found.set(full, await readFile(full, "utf8").catch(() => ""));
    }
  };
  await walk(path.join(session.root, "user-data", "logs"));
  return found;
}

/** 相談を送った窓（待ちの行に「こちらは「AIへの単発の問い合わせ」」が出る窓）の記録と、それ以外 */
async function logsByRole(session: E2ESession): Promise<{ single?: string; others: string[] }> {
  const logs = [...(await outputLogs(session)).values()];
  const single = logs.find((text) => text.includes(SINGLE_LABEL));
  return { single, others: logs.filter((text) => text !== single) };
}

async function describeState(session: E2ESession, pages: Page[]): Promise<string> {
  const parts: string[] = [];
  for (const [index, page] of pages.entries()) {
    parts.push(
      `窓${index + 1}：ステータスバー ${JSON.stringify(await statusBarTexts(page))}／確認の窓 ${JSON.stringify(await dialogText(page).catch(() => undefined))}`
    );
  }
  const logs = await outputLogs(session);
  for (const [file, text] of logs) {
    const tail = text
      .split(/\r?\n/)
      .filter((line) => line.includes("待って") || line.includes(LOAD_LINE) || line.includes("GPU") || line.includes("誤字脱字"))
      .slice(-12)
      .join("\n");
    parts.push(`記録 ${path.basename(path.dirname(path.dirname(path.dirname(file))))}：\n${tail}`);
  }
  parts.push(describeFakeRequests(fake.requests));
  return parts.join("\n");
}

/**
 * 見えた文言の控え（写真と同じ置き場の `<時刻>-窓2つの札の記録.txt`）。
 * 一時フォルダーは終わると消え、通った件の標準出力は vitest が出さないので、画面とログの文言はここへ残す
 */
const NOTE_FILE = path.join(SHOT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-窓2つの札の記録.txt`);
async function note(text: string): Promise<void> {
  console.log(text);
  await mkdir(SHOT_DIR, { recursive: true });
  await appendFile(NOTE_FILE, `${text}\n`, "utf8");
}

async function shoot(page: Page, name: string): Promise<string> {
  await mkdir(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** 確認の窓が GPU の警告なら、その文を添えて落とす（このテストでは出てはいけない） */
async function failOnGpuWarning(page: Page, where: string): Promise<void> {
  const text = await dialogText(page).catch(() => undefined);
  if (text !== undefined && text.includes(GPU_WARNING)) {
    throw new Error(`${where}に GPU の負荷の警告が出ました（出てはいけない）：${text}`);
  }
}

test.skipIf(!RUN)(
  "窓1で誤字脱字検知を回している間に窓2で相談を送ると、窓2に待ちの表示が出て、警告なしに答えが出て、負荷の1行に名残の文が付く",
  async () => {
    await withVsCode(
      "手元のAIの札を2つの窓で取り合う",
      [{ name: EPISODE, text: BODY }],
      async (session) => {
        const page1 = session.page;

        /* ── 窓2を開く（同じ書庫を新しい窓で）。拡張機能ホストは別のプロセスで立つ ── */
        const opened = session.app.waitForEvent("window", { timeout: 60_000 });
        await pressWorkbenchKey(page1, DUPLICATE_PRESS);
        const page2 = await opened;
        const cdp = await page2.context().newCDPSession(page2);
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
        await page2.locator(".monaco-workbench").waitFor({ timeout: 60_000 });
        const pages = [page1, page2];

        // 窓2の横の相談パネルを先に開いておく（拡張機能が起きたことの確かめも兼ねる）
        await waitUntil(
          async () => {
            if (await sideChatFrame(page2)) return true;
            await pressWorkbenchKey(page2, OPEN_SIDE_PRESS);
            await page2.waitForTimeout(2_000);
            return (await sideChatFrame(page2)) !== undefined;
          },
          "窓2で横の相談パネルが開く",
          90_000
        );
        const side = (await sideChatFrame(page2)) as Frame;
        await waitUntil(
          async () => (await side.evaluate(() => document.getElementById("context-what")?.textContent ?? "")).includes(E2E_WORK_TITLE),
          "窓2の相談の対象に作品名が出る",
          30_000
        );

        /* ── 窓1：誤字脱字検知（3〜4チャンク）を走らせる ── */
        const frame = await openEpisode(page1, EPISODE, "発車のベルを待っていた");
        await placeCaretAfter(frame, "発車のベルを待っていた。");
        await page1.keyboard.press("Control+Alt+KeyT");
        await waitUntil(
          async () => {
            await failOnGpuWarning(page1, "窓1（誤字脱字の始まり）");
            const title = (await quickPickTitle(page1)) ?? "";
            const rows = await quickPickRows(page1);
            return [title, ...rows.map((row) => row.label)].join("\n").includes("件を処理します");
          },
          "窓1：誤字脱字の量の確認が出る",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(session, pages)}`);
        });
        const confirmRows = (await quickPickRows(page1)).map((row) => row.label);
        // 字数の数え方（空白・改行）で3〜4に揺れるので、2つ以上に分かれたことだけを見る
        const chunkCount = Number(/(\d+) チャンク中 \1 件を処理します/.exec(confirmRows.join("\n"))?.[1] ?? "0");
        expect(chunkCount, `2チャンク以上に分かれていない：${JSON.stringify(confirmRows)}`).toBeGreaterThanOrEqual(2);
        await page1.keyboard.press("Enter");

        // 1チャンク目が偽の AI に届いた（＝窓1が送信の札を持って待っている）
        await waitUntil(async () => {
          await failOnGpuWarning(page1, "窓1（1チャンク目）");
          return fake.requests.filter(isTypoRequest).length >= 1;
        }, "窓1の1チャンク目が偽の AI に届く", 60_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(session, pages)}`);
        });
        const typoSentAt = Date.now();

        /* ── 窓2：相談を送る。窓1の1チャンク目のあいだは待ちの表示が出る ── */
        await sendChatQuestion(side, QUESTION, "窓2の横の相談パネル");
        let waitingText = "";
        await waitUntil(
          async () => {
            await failOnGpuWarning(page2, "窓2（待ちのあいだ）");
            waitingText = (await statusBarTexts(page2)).find((text) => text.includes(WAITING)) ?? "";
            return waitingText !== "";
          },
          "窓2のステータスバーに「別の窓の…の完了を待っています」が出る",
          Math.max(1_000, TYPO_DELAY_MS - (Date.now() - typoSentAt) - 500)
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(session, pages)}`);
        });
        const waitingShot = await shoot(page2, "窓2の待ちの表示");
        const statusWhileWaiting = await statusBarTexts(page2);
        await note(`[E2E] 窓2の待ちの表示：${JSON.stringify(statusWhileWaiting)}\n[E2E] 写真：${waitingShot}`);
        expect(statusWhileWaiting.some((text) => text.includes("中止")), `待ちの表示に［中止］が無い：${JSON.stringify(statusWhileWaiting)}`).toBe(true);
        // 題と本文に同じ文を並べない（2026-10-23）
        expect(waitingText.split(WAITING).length - 1, `待ちの文が2回以上並んでいる：${waitingText}`).toBe(1);

        /*
          ── 窓1が1チャンク目を返すと、窓2の相談が入り、警告なしに答えが出る。そのあいだ窓1の一括処理は
          2チャンク目の前で待ち、その待ちの文は**一括処理の進捗**（`openWaitDisplay` の control の側）へ出る ──
        */
        let runWaitingText = "";
        let runWaitingShot = "";
        await waitUntil(
          async () => {
            await failOnGpuWarning(page2, "窓2（相談の送信）");
            await failOnGpuWarning(page1, "窓1");
            if (runWaitingShot === "") {
              runWaitingText = (await statusBarTexts(page1)).find((text) => text.includes(WAITING)) ?? "";
              if (runWaitingText !== "") {
                runWaitingShot = await shoot(page1, "窓1の一括処理の待ち");
                await note(`[E2E] 窓1の待ちの表示：${JSON.stringify(await statusBarTexts(page1))}\n[E2E] 写真：${runWaitingShot}`);
              }
            }
            return (await chatLog(side)).includes(ANSWER);
          },
          "窓2の相談パネルに答えが出る",
          60_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n窓2の会話：${JSON.stringify((await chatLog(side)).slice(-400))}\n${await describeState(session, pages)}`);
        });

        /* ── 窓2の記録：待ちの行（単発）と、負荷の1行（名残） ── */
        let single = "";
        await waitUntil(
          async () => {
            single = (await logsByRole(session)).single ?? "";
            return single.includes(LOAD_LINE);
          },
          "窓2の記録に「手元のAIへ送る前の負荷：」の1行が書かれる",
          10_000
        ).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}（nvidia-smi の無い機械では負荷の行は出ない）\n${await describeState(session, pages)}`
          );
        });
        const singleLines = single.split(/\r?\n/);
        const waitLine = singleLines.find((line) => line.includes(WAITING) && line.includes(SINGLE_LABEL)) ?? "";
        const loadLine = singleLines.find((line) => line.includes(LOAD_LINE)) ?? "";
        const sentLine = singleLines.find((line) => line.includes("を送ります。") && line.includes("AIへの単発の問い合わせ")) ?? "";
        await note(`[E2E] 窓2の待ちの行：${waitLine}\n[E2E] 窓2の送る行：${sentLine}\n[E2E] 窓2の負荷の行：${loadLine}`);
        expect(waitLine, "窓2の待ちの行が無い").not.toBe("");
        expect(loadLine, `負荷の1行に名残の文が付いていない：${loadLine}`).toContain(SETTLING);
        expect(loadLine, `負荷の1行に経過の秒が付いていない：${loadLine}`).toMatch(/直前の送信の終わりから\d+\.\d秒なので/);
        expect(single, "窓2で GPU の警告が選ばれた記録がある").not.toContain("GPU の負荷の警告：");

        // 出力の窓にも同じ行が出ていることを写真に残す（見るのはファイル。画面は写真だけ）
        await pressWorkbenchKey(page2, SHOW_LOG_PRESS);
        await page2.waitForTimeout(1_500);
        const outputShot = await shoot(page2, "窓2の出力のログ");
        await note(`[E2E] 写真：${outputShot}`);

        /* ── 窓1：一括処理は合間に相談を通し、最後まで走りきる ── */
        await waitUntil(
          async () => {
            await failOnGpuWarning(page1, "窓1（2チャンク目以降）");
            return fake.requests.filter(isTypoRequest).length >= chunkCount &&
              (await logsByRole(session)).others.some((text) => text.includes("誤字脱字検知を終了"));
          },
          `窓1の誤字脱字検知が${chunkCount}チャンクとも送って終わる`,
          90_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${await describeState(session, pages)}`);
        });
        const others = (await logsByRole(session)).others.join("\n").split(/\r?\n/);
        const runWait = others.filter((line) => line.includes(WAITING) || line.includes("を送ります。"));
        const runLoad = others.filter((line) => line.includes(LOAD_LINE));
        // 窓1は一括処理として待った（一括処理の本体が kind=run を決め、単発の相談に合間を譲った）
        expect(
          runWait.some((line) => line.includes("「AIへの単発の問い合わせ」の完了を待っています") && line.includes("こちらは「誤字脱字の検知」")),
          `窓1の記録に、一括処理として単発を待った行が無い：\n${runWait.join("\n")}`
        ).toBe(true);
        expect(runWaitingText, "窓1の一括処理の進捗に待ちの文が出ていない").toContain("「AIへの単発の問い合わせ」の完了を待っています");
        expect(others.join("\n"), "窓1で GPU の警告が選ばれた記録がある").not.toContain("GPU の負荷の警告：");
        await note(`[E2E] 窓1の待ちの行：\n${runWait.join("\n")}\n[E2E] 窓1の負荷の行：\n${runLoad.join("\n")}`);
        const shot1 = await shoot(page1, "窓1の終わり");
        await note(`[E2E] 写真：${shot1}`);
        // 両方の窓の記録を丸ごと控える（一時フォルダーは終わると消える）
        for (const [file, text] of await outputLogs(session)) {
          await note(`[E2E] ── 記録 ${path.relative(session.root, file)} ──\n${text}`);
        }
      },
      fakeOllamaLaunch(fake, {
        settings: {
          "novelai.chunkSizeMode": "文字数を指定する",
          "novelai.chunkChars": 300,
        },
        keybindings: [
          { key: OPEN_SIDE_KEY, command: "novelai.openChat" },
          { key: DUPLICATE_KEY, command: "workbench.action.duplicateWorkspaceInNewWindow" },
          { key: SHOW_LOG_KEY, command: "novelai.showLog" },
        ],
      })
    );
  },
  420_000
);
