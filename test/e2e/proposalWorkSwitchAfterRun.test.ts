/**
 * 実機確認リスト B-3「走らせた作品へ提案パネルが切り替わらない（案：処理が終わったらその作品を選ぶ）」が、
 * いまの版で起きるかを確かめる（画面の自動テスト、設計書6.8・6.113。2026-10-18）。
 *
 * 場面（2026-09-08 の実機の再現）：作品A の指摘を提案パネルで見ている途中で、**作品B の誤字脱字検知**を走らせる。
 * 作品Bの結果が届いたあと、提案パネルの「作品」欄がどうなっているかを読む。
 *
 * - 作品A の指摘は、置き場へ見本を置く（AI は呼ばない）。作品B は偽の Ollama が1件の指摘を返す
 * - 作品B の原稿は、作品A と同じ書庫の中。Ctrl+P で開いて（原稿エディター）Ctrl+Alt+T で走らせる
 *
 * **このテストは現状を記録する。** 製品の設計（`proposalPanel.ts` の `replaceContents`、2026-08-27 の作者の指摘）は
 * 「別の作品の結果が届いても、見ている画面は奪わない」で、移るかどうかは「作品」欄で作者が選ぶ。
 * 欄には作品Bの件数が出る。B-3 の「案」（終わったらその作品を選ぶ）は、この設計とぶつかる。
 * 通る＝いまは「欄に作品Bの件数が出て、表示は作品Aのまま」。製品が案どおりになれば、このテストの
 * 「表示は作品Aのまま」の確かめが落ちて知らせる。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama } from "./support/fakeOllama";
import { openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_KEY,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  writeSampleFinding,
  type SampleFinding,
} from "./support/sampleFinding";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { activateTab, clearNotifications, quickOpen, quickPickRows, quickPickTitle } from "./support/workbenchDom";

const EPISODE_A = "001_はじまり.txt";
const TEXT_A = "　朝の駅は静かだった。\n　近づいてみると、男は以外にも若かった。\n";
const OTHER_TITLE = "作品B";
const EPISODE_B = "001_別の作品.txt";
const TEXT_B = "　夜の港は静かだった。\n　灯台を見上げけて、息を吐いた。\n";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";

const SAMPLE_A: SampleFinding = {
  episode: EPISODE_A,
  text: TEXT_A,
  original: "男は以外にも若かった。",
  target: "以外",
  suggestion: "意外",
  message: "「思いのほか」の意味なら「意外」です",
};

/** 偽の AI の答え：作品Bの2行目の「見上げけて」 */
const ANSWER_B = JSON.stringify({
  issues: [{ line: 2, original: "　灯台を見上げけて、息を吐いた。", target: "見上げけて", suggestion: "見上げて", reason: "「け」が重なっている", confidence: "high" }],
});

/** 提案パネルの「作品」欄：選ばれている作品の名前と、選べる作品の並び */
async function worksSelect(frame: Frame): Promise<{ selected: string; options: string[] } | undefined> {
  return frame.evaluate(() => {
    const select = document.querySelector("#works select") as HTMLSelectElement | null;
    if (!select) return undefined;
    return {
      selected: select.selectedOptions[0]?.textContent ?? "",
      options: Array.from(select.options).map((option) => option.textContent ?? ""),
    };
  });
}

async function actionLog(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.workFolder, "..", OTHER_TITLE, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

test("作品Aの提案パネルを見ている途中で作品Bの誤字脱字検知が終わると、「作品」欄に作品Bの件数が出る（表示は作品Aのまま＝現状の設計）", async () => {
  const fake = await startFakeOllama(() => ANSWER_B);
  try {
    const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
    await withVsCode(
      "提案パネルの作品の切り替え",
      [{ name: EPISODE_A, text: TEXT_A }],
      async (session) => {
        const { page } = session;
        const from = fake.requests.length;
        await writeSampleFinding(session.workFolder, SAMPLE_A);

        // 作品Bを登録する
        await page.keyboard.press(REGISTER_OTHER_PRESS);
        await waitUntil(async () => (await page.locator(".notification-toast", { hasText: "登録" }).count()) > 0, "作品Bを登録した知らせが出る", 30_000);
        await clearNotifications(page);

        // 作品Aの原稿を開き、提案パネルで作品Aの指摘を見る
        const frameA = await openEpisode(page, EPISODE_A, "以外にも");
        await placeCaretAfter(frameA, "朝の駅");
        await page.keyboard.press(OPEN_PROPOSALS_PRESS);
        let proposals: Frame | undefined;
        await waitUntil(
          async () => {
            proposals = await proposalPanelFrame(page);
            if (!proposals) return false;
            return (await proposals.locator('button[data-action="apply"]').count()) > 0;
          },
          "提案パネルに作品Aの指摘が出る（作品が1つのあいだは「作品」欄は出ない）",
          20_000
        );
        if (!proposals) throw new Error("提案パネルが見つかりません");
        const before = await worksSelect(proposals);
        expect(before, `作品Bの結果が届く前なのに「作品」欄が出ています（${JSON.stringify(before)}）`).toBeUndefined();

        // 作品Bの原稿を開いて、誤字脱字検知を走らせる（確認で Enter）
        await clearNotifications(page);
        await quickOpen(page, EPISODE_B);
        let frameB: Frame | undefined;
        await waitUntil(
          async () => {
            for (const candidate of page.frames()) {
              const text = await candidate.evaluate(() => document.getElementById("compose")?.textContent ?? "").catch(() => "");
              if (text.includes("灯台を見上げけて")) {
                frameB = candidate;
                return true;
              }
            }
            return false;
          },
          "作品Bの原稿が原稿エディターで開く",
          30_000
        );
        if (!frameB) throw new Error("作品Bの原稿の面が見つかりません");
        await placeCaretAfter(frameB, "夜の港");
        await page.keyboard.press("Control+Alt+KeyT");
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            const title = (await quickPickTitle(page)) ?? "";
            const rows = await quickPickRows(page);
            return [title, ...rows.map((row) => row.label)].join("\n").includes("件を処理します");
          },
          "誤字脱字の量の確認が出る",
          30_000
        );
        await page.keyboard.press("Enter");
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            const log = await actionLog(session);
            return log.includes("誤字脱字検知を開始:") && log.includes("誤字脱字検知を終了:");
          },
          "作品Bの操作ログに「誤字脱字検知を開始」と「…終了」が書かれる",
          60_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}\n${describeFakeRequests(fake.requests, from)}\n作品Bのログ：${await actionLog(session)}`);
        });
        expect(fake.requests.length - from, "偽の AI に頼みが届いていない").toBeGreaterThan(0);

        // 結果が届いたあとの提案パネルの「作品」欄（走り終わりから少し待って読む）
        await page.waitForTimeout(2_000);
        const frame = (await proposalPanelFrame(page)) ?? proposals;
        let after = await worksSelect(frame);
        await waitUntil(
          async () => {
            after = await worksSelect(frame);
            return (after?.options ?? []).some((label) => label.includes(OTHER_TITLE) && label.includes("1件"));
          },
          "「作品」欄に作品Bの件数（1件）が出る",
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（欄：${JSON.stringify(after)}）`);
        });
        // 現状：表示は作品Aのまま（B-3 の「切り替わらない」が起きている）
        await holdsFor(
          async () => ((await worksSelect(frame))?.selected ?? "").includes(E2E_WORK_TITLE),
          "表示が作品Aのまま",
          2_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（欄：${JSON.stringify(await worksSelect(frame))}。作品Bへ切り替わったなら、B-3 の案どおりになったということ）`);
        });
        void activateTab;
        void OPEN_PROPOSALS_KEY;
      },
      fakeOllamaLaunch(fake, {
        keybindings: [{ key: OPEN_PROPOSALS_KEY, command: "novelai.openProposals" }, registerOther],
        prepareWork: async ({ workFolder }) => {
          const otherFolder = path.join(path.dirname(workFolder), OTHER_TITLE);
          await mkdir(path.join(otherFolder, "本文"), { recursive: true });
          await writeFile(path.join(otherFolder, "本文", EPISODE_B), TEXT_B, "utf8");
          registerOther.args = { folderPath: otherFolder, title: OTHER_TITLE };
        },
      })
    );
  } finally {
    await fake.close();
  }
}, 300_000);

void (undefined as unknown as Page);
