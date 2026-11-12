/**
 * Shift_JIS の話へ、提案パネルの［適用］で修正の案を書く（画面の自動テスト、設計書5.4.2・6.113。
 * 0.148.0。作者の決定 2026-11-08「〜などは黙って置き換える」・11-09「置き換え先の無い字は、どこにあるかを
 * 出して止める」）。
 *
 * 実機確認リスト 0.148.0 の「Mac の日本語入力で「〜」を含む修正の案を置いて［適用］すると止まらずに書け…」を
 * 機械へ移したもの。**Mac の日本語入力は「打つ手段」の話**なので、確定した字は `keyboard.insertText`
 * 相当（指摘の見本の案に「〜」を入れる）で足す。IME の変換そのものは見張れない。
 * 校正の指摘の見本（`support/sampleFinding.ts`）を置いて［適用］を押す道は、
 * 提案の置き方（手で置いた修正の案）と同じ書き戻し（`writeTextFilePreservingFormat`）を通る。
 * キーは Mac でも通る形で押す（`OPEN_PROPOSALS_PRESS` は Control+Alt+Shift+F8 の使い捨て）。
 *
 * 1. 「〜」を含む案を［適用］：止まらずに書け、ファイルのその字が 81 60（～）になり、
 *    **ほかのバイトは1つも変わらない**（元のバイト列の「〜」の所だけが違う）。
 *    出力の「統合小説執筆環境」の行「Shift_JIS の原稿へ書くため、字を置き換えました（…）：〜→～ 1個」が出る
 *    （出力欄そのものは DOM から読めないので、同じ行を写している作品のログ `.aiwriter/logs/actions.log` を読む）
 * 2. 「♡」を含む案：書かずに止め、ファイルのバイトは1つも変わらず、知らせに「N行目「…♡…」の「♡」」が出る
 *
 * **AI は呼ばない。**
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import iconv = require("iconv-lite");
import { expect, test } from "vitest";
import { composeText, openEpisode } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  writeSampleFinding,
} from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, notificationTexts } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。", "　ホームの時計が、零時を指していた。", ""].join("\n");

/** 「〜」（U+301C。波ダッシュ）。Shift_JIS（CP932）には無く、「～」（U+FF5E。81 60）へ置き換えて書く */
const WAVE_DASH = "〜";
const FULLWIDTH_TILDE = "～";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

const LAUNCH = {
  ...OPEN_PROPOSALS_LAUNCH,
  // 話を原稿エディターで開いたまま適用する（作者の使い方）。Shift_JIS の話を読ませる
  settings: { "files.encoding": "shiftjis" },
  prepareWork: async ({ manuscriptFolder }: { manuscriptFolder: string }) => {
    await writeFile(path.join(manuscriptFolder, EPISODE), iconv.encode(TEXT, "shift_jis"));
  },
};

async function episodeBytes(session: E2ESession): Promise<Uint8Array> {
  return readFile(path.join(session.manuscriptFolder, EPISODE)).catch(() => new Uint8Array());
}

/** 提案パネルを開き、［適用］が並ぶまで待つ */
async function openProposals(page: Page): Promise<Frame> {
  await clearNotifications(page);
  await page.keyboard.press(OPEN_PROPOSALS_PRESS);
  let proposals: Frame | undefined;
  await waitUntil(
    async () => {
      proposals = await proposalPanelFrame(page);
      return proposals !== undefined && (await proposals.locator('button[data-action="apply"]').count()) > 0;
    },
    "提案パネルに［適用］が並ぶ",
    20_000
  );
  if (!proposals) throw new Error("提案パネルが見つかりません");
  return proposals;
}

async function actionLog(session: E2ESession): Promise<string> {
  return readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
}

test("Shift_JIS の話に「〜」を含む案を［適用］すると、止まらずに書け、その字だけが「～」（81 60）になり、ほかのバイトは変わらず、置き換えた旨が出力の行に残る", async () => {
  await withVsCode(
    "Shift_JIS 提案の適用 〜",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const before = await episodeBytes(session);
      expect(before.length, "見本が Shift_JIS のバイトで置かれている").toBe(iconv.encode(TEXT, "shift_jis").length);

      await writeSampleFinding(session.workFolder, {
        episode: EPISODE,
        text: TEXT,
        original: "男は以外にも若かった。",
        target: "以外",
        suggestion: `意外${WAVE_DASH}`,
        message: "「思いのほか」の意味なら「意外」です",
      });
      const frame = await openEpisode(page, EPISODE, "零時を指していた");
      const proposals = await openProposals(page);
      await proposals.locator('button[data-action="apply"]').first().click();

      // 期待するバイト列：元の本文の「以外」だけが「意外～」に替わる（ほかの字・改行は元のまま）
      const expectedText = TEXT.replace("男は以外にも若かった。", `男は意外${FULLWIDTH_TILDE}にも若かった。`);
      const expected = iconv.encode(expectedText, "shift_jis");
      let now: Uint8Array = new Uint8Array();
      await waitUntil(
        async () => {
          now = await episodeBytes(session);
          return now.length > 0 && now.length !== before.length;
        },
        "適用した案がファイルに書かれる",
        20_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（いまのバイト：${hex(now)}）`);
      });
      expect(hex(now), "ファイル全体のバイト（「～」は 81 60。ほかは元のまま）").toBe(hex(expected));
      // 「〜」の所は 81 60（～）で、「?」（0x3f）にはなっていない
      expect(now.includes(0x3f), "ファイルに「?」が入っています").toBe(false);

      // 原稿エディターの画面も、書いた字（置き換えたあとの「～」）に揃う
      await waitUntil(
        async () => (await composeText(frame)).includes(`意外${FULLWIDTH_TILDE}にも`),
        "原稿エディターの本文が「意外～にも」になる",
        15_000
      );

      // 出力の行（作品のログに同じ行が残る）：何を何に何個か。本文の前後は書かない
      let log = "";
      await waitUntil(
        async () => {
          log = await actionLog(session);
          return log.includes(`Shift_JIS の原稿へ書くため、字を置き換えました（${EPISODE}）：${WAVE_DASH}→${FULLWIDTH_TILDE} 1個`);
        },
        "出力の行「字を置き換えました（…）：〜→～ 1個」が出る",
        15_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（ログの終わり：${JSON.stringify(log.split("\n").slice(-8))}）`);
      });
      // 置き換えは作者に知らせない（作者の決定 2026-11-08）
      expect((await notificationTexts(page)).join("\n")).not.toContain("字を置き換えました");
    },
    LAUNCH
  );
}, 240_000);

test("Shift_JIS の話に「♡」を含む案を［適用］すると、書かずに止め、ファイルのバイトは変わらず、知らせに「N行目「…♡…」の「♡」」が出る", async () => {
  await withVsCode(
    "Shift_JIS 提案の適用 ♡",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const before = await episodeBytes(session);

      await writeSampleFinding(session.workFolder, {
        episode: EPISODE,
        text: TEXT,
        original: "雨の音だけが残っていた。",
        target: "だけ",
        suggestion: "だけ♡",
        message: "見本の指摘（書けない字を含む案）",
      });
      await openEpisode(page, EPISODE, "零時を指していた");
      const proposals = await openProposals(page);
      await clearNotifications(page);
      await proposals.locator('button[data-action="apply"]').first().click();

      // 知らせ：何行目のどの字が書けないかを、場所つきで出す（作者が直す所を探さずに済む）
      let notices: string[] = [];
      await waitUntil(
        async () => {
          notices = await notificationTexts(page);
          return notices.some((text) => text.includes("♡") && /\d+行目「/.test(text));
        },
        "知らせに「N行目「…♡…」の「♡」」が出る",
        20_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(notices)}）`);
      });
      const notice = notices.find((text) => text.includes("♡")) ?? "";
      expect(notice).toMatch(/1行目「[^」]*♡[^」]*」の「♡」/);
      // 次の操作を1つ示す：UTF-8 に変換する（書けない字を、そのまま書けるようにする道）
      expect(notice).toContain("UTF-8 に変換");

      // 書かずに止めた：ファイルのバイトは1つも変わらない（数秒見続ける）
      await holdsFor(async () => hex(await episodeBytes(session)) === hex(before), "止めたのに、ファイルのバイトが変わった", 3_000);
    },
    LAUNCH
  );
}, 240_000);
