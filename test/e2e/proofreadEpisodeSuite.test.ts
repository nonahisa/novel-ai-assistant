/**
 * 原稿エディターの［校正］→「この話を校正」（画面の自動テスト、設計書6.25・6.80・6.113。
 * 作者の答え 2026-11-27「そう。この話だけにしたい」）。
 *
 * 1. 2話ある作品の2話目を開き、［校正］→「この話を校正」を押すと、選ぶ画面「この話を校正：002_雨の日.txt」が出る。
 *    並ぶのは話1つに絞れる「誤字脱字・推敲・プロット逸脱・矛盾」で、表記ゆれは並ばない
 * 2. 誤字脱字だけを選んで決めると、確認の窓（真ん中）が「「002_雨の日.txt」を校正します。」で出る。
 *    ［実行］で走らせると、**偽の AI に届く頼みは開いている2話目の本文だけ**で、1話目の本文は1件も届かない
 *    （作品全体で回っていない）
 *
 * 誤字脱字だけを選ぶのは、矛盾検知が前の話のあらすじ・抜粋を参考として送る作りで、「届いた本文が
 * この話だけ」と見られないため。範囲がこの話に絞られること自体は、4つとも単体テスト
 * （test/unit/features/checkScopeSuiteEpisode.test.ts）が見る。
 *
 * **本物の AI は呼ばない。** 偽の Ollama（指摘0件）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { clickToolButton, openEpisode } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  acceptQuickPick,
  dialogText,
  notificationTexts,
  pressDialogButton,
  quickInputWaitContext,
  statusBarTexts,
  toggleQuickPickRow,
  waitForQuickPick,
} from "./support/workbenchDom";

const FIRST = "001_灯台.txt";
const SECOND = "002_雨の日.txt";
/** 1話目にだけある字。届いた頼みにこれが入っていたら、作品全体で回っている */
const FIRST_MARK = "灯台守の朝";
/** 2話目にだけある字 */
const SECOND_MARK = "雨の商店街";
const FIRST_TEXT = `　${FIRST_MARK}は早い。\n　霧の向こうで汽笛が鳴った。\n`;
const SECOND_TEXT = `　${SECOND_MARK}を歩いた。\n　傘の先から雫が落ちた。\n`;

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => JSON.stringify({ issues: [] }));
});
afterAll(async () => {
  await fake.close();
});

async function actionLog(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

async function menuOpen(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => document.getElementById("menu")?.classList.contains("open") ?? false);
}

async function pickProofItem(frame: Frame, label: string): Promise<void> {
  await clickToolButton(frame, "proof");
  await waitUntil(() => menuOpen(frame), "［校正］の品書きが開く", 5_000);
  await frame.locator("#menu .item", { hasText: label }).first().click();
}

test("［校正］の「この話を校正」は、表記ゆれを除いた4つを並べ、誤字脱字だけを選んで走らせると開いている話の本文だけを AI へ送る", async () => {
  await withVsCode(
    "この話を校正",
    [
      { name: FIRST, text: FIRST_TEXT },
      { name: SECOND, text: SECOND_TEXT },
    ],
    async (session) => {
      const { page } = session;
      // 同じファイルの中の件で偽の AI を共有しても数え違えないよう、この件の頭で数を控える
      const from = fake.requests.length;
      const frame = await openEpisode(page, SECOND, SECOND_MARK);

      /* ── 1. 選ぶ画面：題に話の名前、表記ゆれは並ばない ── */
      await pickProofItem(frame, "この話を校正");
      const title = `この話を校正：${SECOND}`;
      const rows = await waitForQuickPick(page, title, 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
      });
      expect(rows.map((row) => row.label), `選ぶ画面の並び：${JSON.stringify(rows)}`).toEqual(["誤字脱字", "推敲", "プロット逸脱", "矛盾"]);

      /* ── 2. 誤字脱字だけを選んで決める ── */
      for (const row of rows) {
        const wanted = row.label === "誤字脱字";
        if (row.checked !== wanted) await toggleQuickPickRow(page, row.label);
      }
      await acceptQuickPick(page);
      let confirm = "";
      await waitUntil(async () => (confirm = (await dialogText(page)) ?? "").includes("走らせるもの"), "この話を校正の確認の窓が出る", 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの窓：${JSON.stringify(confirm)}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
      });
      expect(confirm, `確認がどの話かを名乗っていません：${confirm}`).toContain(`「${SECOND}」を校正します。`);
      expect(confirm).toContain("走らせるもの（この順）：誤字脱字");
      await pressDialogButton(page, "実行");

      /* ── 走り終わるまで待つ（まとめの知らせ。ステータスバーか右下） ── */
      const finished = async (): Promise<boolean> => {
        const texts = [...(await notificationTexts(page)), ...(await statusBarTexts(page))];
        return texts.some((text) => text.includes("校正をまとめて実行しました"));
      };
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return finished();
        },
        "この話を校正が走り終わる",
        90_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（操作の記録の終わり：${(await actionLog(session)).split("\n").slice(-10).join(" ／ ")}／${describeFakeRequests(fake.requests, from)}）${await quickInputWaitContext(page)}`
        );
      });
      // 遅れて届く頼みを拾う（終わりの知らせのあとに何も送られないこと）
      await holdsFor(async () => true, "走り終わったあとの頼みを待つ", 1_500);

      /* ── 届いた頼みは2話目の本文だけ ── */
      const sent = fake.requests.slice(from).map((request) => `${request.system}\n${request.user}`);
      const detail = describeFakeRequests(fake.requests, from);
      expect(sent.some((text) => text.includes(SECOND_MARK)), `開いている話の本文が AI へ届いていません（${detail}）`).toBe(true);
      expect(sent.filter((text) => text.includes(FIRST_MARK)), `開いていない1話目の本文が AI へ届きました（作品全体で回っています。${detail}）`).toEqual([]);
      // 範囲を訊かずにこの話だけにしたことが記録に残る（`resolveCheckScope`）
      expect(await actionLog(session)).toContain(`この話を校正のため対象は ${SECOND} だけ`);
    },
    fakeOllamaLaunch(fake)
  );
}, 240_000);
