/**
 * 「矛盾検知」で、場所の位置関係の食い違い（機械の照合）が提案パネルの「矛盾」に区分「場所」で並ぶ
 * （画面の自動テスト、設計書6.93.4・6.113。実機確認リスト 18 行「矛盾を仕込んだ場所の資料（学校は港の北／
 * 港は学校の北、第3話と第7話の引用つき）で「矛盾を検知」を押すと…」を、仕分け 2026-10-12 の束 E1 として
 * 移した。作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 何を見張るか：
 * - 矛盾検知（設定との照合）を走らせると、AI の指摘とは別に、**設定資料の場所の位置関係どうしの食い違い**が
 *   提案パネルの「矛盾」の分類へ、区分「場所」の1件として並ぶ。説明に「AIを使わず」とあり、
 *   飛ぶ先の記述は第7話（あとの話）、もう一方は第3話の引用
 * - ［本文を見る］で、第7話のその行（「港は学校の北に見えた」）へ原稿のカーソルが来る
 * - 完了の知らせに「うち場所の位置関係（機械で照合） 1件」が出る
 * - 本文も場所の資料も書き換わらない
 *
 * **本物の AI は呼ばない。** 偽の Ollama は「指摘0件」を返す。だから並ぶ1件は、AI を通らない
 * 機械の照合（`core/locationConsistency.ts`）から来たものだけになる。照合の規則そのものは
 * 単体テスト `core/locationConsistency.test.ts` が見ている——ここで見るのは、押した道（突き合わせ方→
 * 読み方→確認）を通って結果が画面と知らせに出るまでの配線。
 *
 * 話が2つなので「どこまで見ますか」は出ない（全体に倒れる。`features/typoCheckScope.ts`）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { emptyLocation, locationFileName, type Location, type LocationRelation } from "../../src/models/location";
import { DEFAULT_SETTINGS_DIR } from "../../src/models/types";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { caretPosition, manuscriptFrames } from "./support/manuscriptFrame";
import { describeNotices, recordedNotices } from "./support/noticeRecord";
import { runCommand } from "./support/quickInput";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame } from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  clearNotifications,
  notificationTexts,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickPickRows,
  quickPickTitle,
} from "./support/workbenchDom";

const EPISODE_3 = "003_朝.txt";
const EPISODE_7 = "007_夕方.txt";
const BODY_3 = "　朝。\n　学校は港の北の高台にある。\n　坂を上った。\n";
const BODY_7 = "　夕方。\n\n　港は学校の北に見えた。\n";
const QUOTE_3 = "学校は港の北の高台にある";
const QUOTE_7 = "港は学校の北に見えた";

function rel(target: string, targetId: string, chapter: number, evidence: string): LocationRelation {
  return { kind: "direction", target, targetId, value: "北", chapters: [chapter], evidence, authorLocked: false };
}

/** 学校は港の北（第3話）／港は学校の北（第7話）。互いに相手を「北」に置くので食い違う */
function places(): Location[] {
  return [
    { ...emptyLocation("loc_001", "学校"), appearedChapters: [3], relations: [rel("港", "loc_002", 3, QUOTE_3)] },
    { ...emptyLocation("loc_002", "港"), appearedChapters: [7], relations: [rel("学校", "loc_001", 7, `「${QUOTE_7}。」`)] },
  ];
}

function locationsFolder(workFolder: string): string {
  return path.join(workFolder, DEFAULT_SETTINGS_DIR, "locations");
}

/** 偽の AI は、矛盾検知の答えの形で「指摘0件」を返す（呼ばれたものは何でも同じ答え） */
const NO_FINDINGS = JSON.stringify({ perspective_taking: [], joint_attention: [], contradictions: [] });

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => NO_FINDINGS);
});
afterAll(async () => {
  await fake.close();
});

const COMPLETION_MARK = "場所の位置関係（機械で照合）";

/** 完了の知らせ（記録ファイルか右下）のうち、`since` より後の矛盾検知のもの */
async function completionNotice(session: E2ESession, since: number): Promise<string | undefined> {
  const fromToasts = (await notificationTexts(session.page)).find((text) => text.includes("矛盾検知") && text.includes("完了"));
  if (fromToasts) return fromToasts;
  return (await recordedNotices(session))
    .filter((entry) => Date.parse(entry.at) >= since - 1_000)
    .map((entry) => entry.message)
    .find((message) => message.includes("矛盾検知") && message.includes("完了"));
}

test("矛盾検知（設定との照合）で、場所の位置関係の食い違いが「矛盾」に区分「場所」で並び、［本文を見る］で第7話のその行へ飛び、完了の知らせに機械で照合した件数が出る", async () => {
  await withVsCode(
    "場所の矛盾（機械の照合）",
    [
      { name: EPISODE_3, text: BODY_3 },
      { name: EPISODE_7, text: BODY_7 },
    ],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);
      const started = Date.now();
      await runCommand(page, "矛盾検知");

      /*
        ── 選ぶ画面を順に通す ──
        突き合わせ方（設定との照合だけ）→ 読み方（分けて読む）→ 処理量の確認（実行）。
        確認は送るものがあるときだけ出るので、出たら押す形で待つ。手元のAIの関所も出たら通す
      */
      const seenTitles: string[] = [];
      let notice: string | undefined;
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const title = (await quickPickTitle(page)) ?? "";
          if (title !== "" && seenTitles[seenTitles.length - 1] !== title) seenTitles.push(title);
          if (title === "矛盾検知：何と何を突き合わせるか") {
            await pickQuickPickRow(page, "設定との照合だけ");
          } else if (title === "矛盾検知：読み方を選ぶ") {
            await pickQuickPickRow(page, "分けて読む");
          } else if (title !== "") {
            // 処理量の確認（上の選ぶ画面）。文の頭は題に、残りは行に入る（`views/notify.ts` の `askInTopPicker`）
            const rows = await quickPickRows(page);
            const words = [title, ...rows.map((row) => row.label)].join(" ");
            if (rows.some((row) => row.label === "実行") && words.includes("矛盾を検知します")) {
              await pickQuickPickRow(page, "実行");
            }
          }
          notice = await completionNotice(session, started);
          return notice !== undefined;
        },
        "矛盾検知の選ぶ画面を通って、完了の知らせが出る",
        120_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（通った選ぶ画面：${JSON.stringify(seenTitles)}／偽のAIへの呼び出し：${fake.requests.length}回／` +
            `${await describeNotices(session, started - 1_000)}）${await quickInputWaitContext(page)}`
        );
      });
      expect(notice, "完了の知らせに、機械で照合した件数がありません").toContain(`うち${COMPLETION_MARK} 1件`);
      expect(seenTitles, "突き合わせ方を選ぶ画面を通っていません").toContain("矛盾検知：何と何を突き合わせるか");

      /*
        ── 提案パネルの「矛盾」に、区分「場所」の1件が並ぶ ──
        検知が終わると開くのは校正・メモパネル（設計書6.96.5）。提案パネルは作者と同じく
        「提案パネルを開く」で開く（今回の分類「矛盾」が出る。`checkOpensMemoPanel.test.ts` の3）
      */
      let proposals: Frame | undefined;
      const placeCard = () => proposals?.locator(".issue.contradiction", { has: proposals.locator(".badge.cat", { hasText: "場所" }) });
      await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
      await waitUntil(
        async () => {
          proposals = await proposalPanelFrame(page);
          return proposals !== undefined && ((await placeCard()?.count()) ?? 0) > 0;
        },
        "提案パネルに区分「場所」の矛盾が並ぶ",
        30_000
      ).catch(async (error: unknown) => {
        const text = proposals ? await proposals.evaluate(() => document.body.innerText) : "（提案パネルが開いていません）";
        throw new Error(`${String(error)}（提案パネル：${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 500))}）`);
      });
      if (!proposals) throw new Error("提案パネルが見つかりません");
      const panel = proposals;
      expect(await panel.locator("#category").innerText(), "提案パネルの分類が「矛盾」ではありません").toBe("矛盾");
      const cards = panel.locator(".issue.contradiction", { has: panel.locator(".badge.cat", { hasText: "場所" }) });
      expect(await cards.count(), "区分「場所」の行が1件ではありません").toBe(1);
      const card = cards.first();
      const cardText = (await card.innerText()).replace(/\s+/g, " ");
      expect(cardText, `説明に機械で照らしたことが書かれていません：${cardText}`).toContain("AIを使わず");
      expect(cardText, `飛ぶ先の記述（第7話）が出ていません：${cardText}`).toContain("第7話");
      expect(cardText, `もう一方の記述（第3話の引用）が出ていません：${cardText}`).toContain(QUOTE_3);
      expect(await card.locator(".location").innerText(), "行の頭が第7話のファイルを指していません").toContain(EPISODE_7);

      /* ── ［本文を見る］で、第7話の「港は学校の北に見えた」の行へ ── */
      await card.locator('button[data-action="jump"]').click();
      await waitUntil(
        async () => {
          for (const frame of await manuscriptFrames(page)) {
            if (((await caretPosition(frame).catch(() => undefined))?.lineText ?? "").includes(QUOTE_7)) return true;
          }
          return false;
        },
        `［本文を見る］で、原稿のカーソルが第7話の「${QUOTE_7}」の行へ来る`,
        20_000
      ).catch(async (error: unknown) => {
        const carets: string[] = [];
        for (const frame of await manuscriptFrames(page)) carets.push(JSON.stringify(await caretPosition(frame).catch(() => undefined)));
        throw new Error(`${String(error)}（原稿の面：${carets.length}枚／カーソル：${carets.join(" / ")}）`);
      });

      /* ── 本文も資料も書き換えない ── */
      const read = async (file: string) => (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
      expect(await read(path.join(session.manuscriptFolder, EPISODE_3))).toBe(BODY_3);
      expect(await read(path.join(session.manuscriptFolder, EPISODE_7))).toBe(BODY_7);
      for (const location of places()) {
        const saved = JSON.parse(await read(path.join(locationsFolder(session.workFolder), locationFileName(location)))) as Location;
        expect(saved.relations, `場所「${location.name}」の位置関係が書き換わりました`).toEqual(location.relations);
      }
    },
    fakeOllamaLaunch(fake, {
      ...OPEN_PROPOSALS_LAUNCH,
      prepareWork: async ({ workFolder }) => {
        const folder = locationsFolder(workFolder);
        await mkdir(folder, { recursive: true });
        for (const location of places()) {
          await writeFile(path.join(folder, locationFileName(location)), `${JSON.stringify(location, null, 2)}\n`, "utf8");
        }
      },
    })
  );
});
