/**
 * 確認の窓が出た直後に、提案パネル（WebView）が焦点を取り返しても、焦点が窓へ戻る
 * （画面の自動テスト、設計書6.113。2026-11-14。0.152.1 の原稿エディターの件
 * `confirmFocusReclaim.test.ts` を写し、ほかのパネルへ広げた直しを見る）。
 *
 * ## 何が起きうるか
 *
 * 窓（突き合わせ方・読み方）が閉じると、VS Code 本体は焦点を前に出ているエディター——
 * ここでは提案パネル——へ戻す。WebView への戻し方は **50ms 遅らせてから「focus」の便を中へ
 * 送る**（本体の `_focusDelayer`）。便の処理が遅れると、続けて出た処理量の確認（外をクリック
 * しても閉じない窓）から焦点を取り、Enter が窓へ届かない。パネルの画面は押さずに受けた焦点を
 * 知らせ（`views/focusReportScript.ts`）、拡張機能が窓へ戻す（`views/pickerFocus.ts`）。
 *
 * ## このテストでの作り方（原稿エディターの件と同じ）
 *
 * - 接続の確かめ（偽の Ollama の `/api/tags`）を 150ms 遅らせる——確認の窓が、本体の 50ms の
 *   遅らせより後に出るようにする
 * - 読み方の窓で「分けて読む」を押す直前に、提案パネルの中（外枠と中身）を空回しさせる——
 *   「focus」の便の処理を、確認の窓が出たあとへずらす
 *
 * 取り返しが起きて拡張機能が窓へ戻したこと（操作ログの「提案パネルが焦点を取ったので、窓へ
 * 戻しました」）を確かめてから、**焦点が確認の窓にあり、Enter で矛盾検知が走る**ことを見る。
 * 取り返しが起きなければ、仕込みが効いていないので落とす（何も確かめずに通さない）。
 *
 * 矛盾検知の題材は `locationContradictionCheck.test.ts` と同じ（場所の位置関係の食い違い）。
 * 話が2つなので「どこまで見ますか」は出ない。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, test } from "vitest";
import { emptyLocation, locationFileName, type Location, type LocationRelation } from "../../src/models/location";
import { DEFAULT_SETTINGS_DIR } from "../../src/models/types";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { runCommand } from "./support/quickInput";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame } from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  activeElementSummary,
  focusInside,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickPickRows,
  quickPickTitle,
} from "./support/workbenchDom";

const EPISODE_3 = "003_朝.txt";
const EPISODE_7 = "007_夕方.txt";
const BODY_3 = "　朝。\n　学校は港の北の高台にある。\n　坂を上った。\n";
const BODY_7 = "　夕方。\n\n　港は学校の北に見えた。\n";
const QUOTE_3 = "学校は港の北の高台にある";
const QUOTE_7 = "港は学校の北に見えた";

/** 接続の確かめを遅らせる長さ。本体が WebView へ焦点を戻すまでの遅らせ（50ms）より長くする */
const TAGS_DELAY_MS = 150;
/**
 * パネルの中を空回しさせる長さ。確認の窓が出るまで（接続の確かめ2回ぶんの遅らせ＋モデルの情報＋
 * 区切りの計算）より長くする。原稿エディターの件（400ms）より、確認までの段が多いぶん長い
 */
const BUSY_MS = 2_000;
/** 拡張機能が窓へ戻したときに操作ログへ書く行（`views/pickerFocus.ts` の `reclaimPickerFocus`） */
const RECLAIM_LOG = "確認の窓が出ている間に提案パネルが焦点を取ったので、窓へ戻しました";

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

/** 偽の AI は、矛盾検知の答えの形で「指摘0件」を返す */
const NO_FINDINGS = JSON.stringify({ perspective_taking: [], joint_attention: [], contradictions: [] });

let fake: FakeOllama;
let tagsDelay = 0;
beforeAll(async () => {
  fake = await startFakeOllama(() => NO_FINDINGS, {
    beforeTags: () => new Promise((resolve) => setTimeout(resolve, tagsDelay)),
  });
});
afterAll(async () => {
  await fake.close();
});

/** パネルの中で、窓（window）が焦点を受けた回数を数え始める */
async function countFaceFocus(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const holder = window as unknown as { __e2eFaceFocus?: number };
    if (holder.__e2eFaceFocus !== undefined) return;
    holder.__e2eFaceFocus = 0;
    window.addEventListener("focus", (event) => {
      if (event.target === window) holder.__e2eFaceFocus = (holder.__e2eFaceFocus ?? 0) + 1;
    });
  });
}

async function faceFocusCount(frame: Frame): Promise<number> {
  return frame.evaluate(() => (window as unknown as { __e2eFaceFocus?: number }).__e2eFaceFocus ?? 0).catch(() => -1);
}

/** パネルの外枠と中身を、`at` ms 後から `ms` ms 空回しさせる（どちらも待たずに戻る） */
async function busyFace(frame: Frame, at: number, ms: number): Promise<void> {
  for (const target of [frame, frame.parentFrame()]) {
    if (!target) continue;
    await target.evaluate(
      ({ delay, length }) => {
        setTimeout(() => {
          const start = performance.now();
          while (performance.now() - start < length) {
            /* 遅い機械で画面が塞がっている代わり。何もしないで時間だけ使う */
          }
        }, delay);
      },
      { delay: at, length: ms }
    );
  }
}

async function actionLog(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

async function stateText(page: Page, session: E2ESession, frame: Frame): Promise<string> {
  const rows = await quickPickRows(page).catch(() => []);
  return (
    `焦点：${await activeElementSummary(page)}` +
    `\n窓：「${(await quickPickTitle(page)) ?? "なし"}」 行：${JSON.stringify(rows.map((row) => row.label).slice(0, 4))}` +
    `\nパネルが焦点を受けた回数：${await faceFocusCount(frame)}` +
    `\n${describeFakeRequests(fake.requests)}` +
    `\n操作ログの終わり：\n${(await actionLog(session)).split("\n").slice(-12).join("\n")}`
  );
}

test("確認の窓が出た直後に提案パネルが焦点を取り返しても、焦点は確認の窓へ戻り、Enter で矛盾検知が走る", async () => {
  await withVsCode(
    "確認の窓の焦点の取り返し（提案パネル）",
    [
      { name: EPISODE_3, text: BODY_3 },
      { name: EPISODE_7, text: BODY_7 },
    ],
    async (session) => {
      const { page } = session;

      /* ── 提案パネルを開き、押して前に出す（窓が閉じたあと、本体はここへ焦点を戻す） ── */
      let found: Frame | undefined;
      await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
      await waitUntil(async () => (found = await proposalPanelFrame(page)) !== undefined, "提案パネルが開く", 30_000);
      if (!found) throw new Error("提案パネルが見つかりません");
      const frame = found;
      await frame.locator("body").click({ position: { x: 4, y: 4 } });
      await countFaceFocus(frame);
      const fail = async (error: unknown): Promise<never> => {
        throw new Error(`${String(error)}\n${await stateText(page, session, frame)}`);
      };

      /* ── 突き合わせ方 → 読み方 ── */
      await runCommand(page, "矛盾検知");
      await waitUntil(async () => (await quickPickTitle(page)) === "矛盾検知：何と何を突き合わせるか", "突き合わせ方の窓が出る", 20_000).catch(fail);
      await pickQuickPickRow(page, "設定との照合だけ");
      await waitUntil(async () => (await quickPickTitle(page)) === "矛盾検知：読み方を選ぶ", "読み方の窓が出る", 20_000).catch(fail);

      tagsDelay = TAGS_DELAY_MS;
      const before = await faceFocusCount(frame);
      await busyFace(frame, 30, BUSY_MS);
      await pickQuickPickRow(page, "分けて読む");

      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const title = (await quickPickTitle(page)) ?? "";
          const words = [title, ...(await quickPickRows(page)).map((row) => row.label)].join(" ");
          return words.includes("矛盾を検知します");
        },
        "処理量の確認の窓が出る",
        30_000
      ).catch(fail);

      // 仕込みが効いて、確認の窓が出たあとにパネルが焦点を受け、拡張機能が窓へ戻したこと
      // （受けなければ、このテストは何も見ていない）
      await waitUntil(
        async () => (await faceFocusCount(frame)) > before && (await actionLog(session)).includes(RECLAIM_LOG),
        "確認の窓が出たあとにパネルが焦点を受け、拡張機能が窓へ戻す（仕込みが効いたしるし）",
        15_000
      ).catch(fail);

      await waitUntil(
        async () => await focusInside(page, ".quick-input-widget"),
        "パネルに取られた焦点が、確認の窓へ戻る",
        10_000
      ).catch(fail);

      tagsDelay = 0;
      // 偽の AI の `requests` は `/api/chat` の頼みだけを数える。確認の前には0件のはず
      const sentBefore = fake.requests.length;
      await page.keyboard.press("Enter");
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          return (await quickPickTitle(page)) === undefined && fake.requests.length > sentBefore;
        },
        "確認の窓で Enter を押すと矛盾検知が走る（偽の AI へ頼みが届く）",
        60_000
      ).catch(fail);
    },
    fakeOllamaLaunch(fake, {
      ...OPEN_PROPOSALS_LAUNCH,
      prepareWork: async ({ workFolder }) => {
        const folder = path.join(workFolder, DEFAULT_SETTINGS_DIR, "locations");
        await mkdir(folder, { recursive: true });
        for (const location of places()) {
          await writeFile(path.join(folder, locationFileName(location)), `${JSON.stringify(location, null, 2)}\n`, "utf8");
        }
      },
    })
  );
}, 300_000);
