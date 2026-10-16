/**
 * 推敲と相談に別のAIを割り当てた作品で、校正・メモパネルの［AIに相談］が**相談の割当**で答える
 * （画面の自動テスト、設計書6.96.5・6.28.7・6.113。実機確認リスト「推敲と相談に別のAIを割り当て、
 * 校正・メモパネルの［AIに相談］が相談のAIで答える」を、仕分け 2026-10-16 の束 E28 として移した）。
 *
 * 何を見張るか：
 * - 推敲は鍵の無い Gemini、相談は偽の Ollama の別のモデル（`CHAT_MODEL`）、既定は偽の Ollama の
 *   既定のモデル（`FAKE_OLLAMA_MODEL`）に割り当てる。推敲の割当や既定で動いてしまえば、頼みが来ない
 *   （Gemini）かモデル名が違う（既定）ので取り違えが見える
 * - 修正案の無い推敲の指摘で［AIに相談］を押すと、偽の Ollama へ頼みが**1件だけ**、`CHAT_MODEL` で届く
 * - 答えが行のすぐ下に出る（`.advice .point` と言い換え）。本文は変わらない。手元のAIなので料金の確認は出ない
 *
 * 割当は globalState の `novelai.ai.featureAssignments` に、製品が読む形で置く（割当の画面は
 * モデル一覧を引く通信を伴うので通らない。割当の画面そのものは対象外）。
 *
 * **本物の AI は呼ばない。** 指摘は `.aiwriter/findings.jsonl` に見本を置き、答えは偽の Ollama が返す。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import {
  describeFakeRequests,
  FAKE_OLLAMA_MODEL,
  fakeOllamaLaunch,
  passLocalAiGate,
  startFakeOllama,
} from "./support/fakeOllama";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { describeNotices } from "./support/noticeRecord";
import { writeSampleFinding, type SampleFinding } from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, dialogText } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const QUOTE = "　彼はとても大きな、とても重い、とても古い鞄を、とてもゆっくりと持ち上げた。";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", QUOTE, "　ホームの時計が、零時を指していた。", ""].join("\n");

/** 相談に割り当てる、既定とは別のモデル（偽の Ollama の一覧にも載せる） */
const CHAT_MODEL = "e2e-fake-chat:1b";

/** 偽の AI の助言（`FINDING_ADVICE_SCHEMA` の形。言い換えの from は指摘の一文に実在する字） */
const ADVICE_POINT = "「とても」が4回続き、どれも同じ強さに聞こえます。";
const ADVICE_ANSWER = JSON.stringify({
  point: ADVICE_POINT,
  examples: [{ from: "とても大きな、とても重い、とても古い鞄", to: "大きく重い古びた鞄" }],
});

async function fileText(session: E2ESession): Promise<string> {
  const raw = await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "");
  return raw.replace(/\r\n/g, "\n");
}

async function countIn(frame: Frame, selector: string): Promise<number> {
  return frame.evaluate((query) => document.querySelectorAll(query).length, selector);
}

/** 原稿の中から Ctrl+Alt+M で校正・メモパネルを開き、［AIに相談］が並ぶまで待つ（memoFindingActions と同じ形） */
async function openMemoPanel(page: Page): Promise<Frame> {
  await page.keyboard.press("Control+Alt+KeyM");
  let memo: Frame | undefined;
  await waitUntil(
    async () => {
      memo = await memoPanelFrame(page);
      return memo !== undefined && (await countIn(memo, 'button[data-act="consult"]')) > 0;
    },
    "校正・メモパネルに推敲の指摘の［AIに相談］が並ぶ",
    30_000
  );
  if (!memo) throw new Error("校正・メモパネルが見つかりません");
  return memo;
}

test("推敲と相談に別のAIを割り当てると、校正・メモパネルの［AIに相談］は相談に割り当てたモデルへ1回だけ頼み、答えが行の下に出て、本文は変わらない", async () => {
  const sample: SampleFinding = {
    episode: EPISODE,
    text: TEXT,
    original: QUOTE,
    target: "とても",
    suggestion: "",
    message: "「とても」が重なり、文が間延びしています",
    category: "proofread",
    label: "推敲",
  };
  const fake = await startFakeOllama(() => ADVICE_ANSWER, { extraModels: [CHAT_MODEL] });
  try {
    await withVsCode(
      "推敲と相談に別のAI",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        await writeSampleFinding(session.workFolder, sample);
        const frame = await openEpisode(page, EPISODE, "零時を指していた");
        await placeCaretAfter(frame, "終電を逃した");
        const memo = await openMemoPanel(page);
        await clearNotifications(page);
        const from = fake.requests.length;

        await memo.locator('button[data-act="consult"]').first().click();

        let shown = "";
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            shown = await memo
              .evaluate(() => (document.querySelector(".advice")?.textContent ?? "").replace(/\s+/g, " ").trim())
              .catch(() => "");
            return shown.includes(ADVICE_POINT);
          },
          "［AIに相談］の答えが指摘の行の下に出る",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}（行の下の字：${JSON.stringify(shown)}／確認の窓：${JSON.stringify(await dialogText(page))}` +
              `／${describeFakeRequests(fake.requests, from)}／${await describeNotices(session)}）`
          );
        });
        expect(shown, "言い換えの例が出ていない").toContain("大きく重い古びた鞄");

        // ── 頼みは1件だけ、相談に割り当てたモデルへ（推敲の Gemini でも、既定のモデルでもない）──
        const sent = fake.requests.slice(from);
        expect(sent.length, `頼みの数が1件でない（${describeFakeRequests(fake.requests, from)}）`).toBe(1);
        expect(sent[0]?.model, `相談の割当でないモデルへ送られた（${describeFakeRequests(fake.requests, from)}）`).toBe(CHAT_MODEL);
        expect(sent[0]?.model).not.toBe(FAKE_OLLAMA_MODEL);
        expect(sent[0]?.user, "頼みに指摘の一文が載っていない").toContain("とても古い鞄");

        // ── 本文は変わらず、確認の窓（料金の確認など）も出ていない ──
        await holdsFor(
          async () => (await fileText(session)) === TEXT && (await dialogText(page)) === undefined,
          "［AIに相談］のあと、本文が変わらず、確認の窓も出ないこと",
          2_000
        );
      },
      fakeOllamaLaunch(fake, {
        globalState: {
          // 推敲は鍵の無い Gemini（呼ばれれば偽の Ollama に頼みが来ない）。相談は別のモデル
          "novelai.ai.featureAssignments": {
            proofread: { provider: "gemini", model: "gemini-2.5-flash" },
            chat: { provider: "ollama", model: CHAT_MODEL },
          },
        },
      })
    );
  } finally {
    await fake.close();
  }
}, 180_000);
