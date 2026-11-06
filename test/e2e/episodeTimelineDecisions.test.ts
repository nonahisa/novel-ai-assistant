/**
 * 提案パネルで指摘を［適用］・［戻す］・［見送る］したとき、タイムラインの欄が保存なしで新しくなり、
 * 1回の採否が1行にまとまるか（画面の自動テスト、設計書6.119.1・6.119.3・6.113。0.130.2 の直し。
 * 作者の裁定 2026-11-06 夕「採ったらすぐ新しくする」「同じ出来事は1行にまとめ、中身はその行を開いたときに見せる」）。
 *
 * 見張ること：
 * 1. ［適用］すると、**保存しなくても**数秒のうちに欄へ「AIの指摘（誤字脱字）を採った」が出る
 *    （製品が `workspace.fs` で書いたことを `core/workRecordSignal.ts` が知らせ、0.4秒後に読み直させる）
 * 2. 増えるのはその1行だけ。編集履歴「誤字脱字の指摘を反映した」と操作ログ「誤字の指摘を反映した」は
 *    行として出ず、その行の説明（指を置くと出る吹き出し）に、採否・編集履歴・操作ログの3つが並ぶ
 * 3. ［戻す］は「AIの指摘（誤字脱字）を戻した」の1行（［適用］の回の「を採った」の行は名前も説明もそのまま残る。
 *    0.130.3、作者の裁定 2026-11-06 夕）、［見送る］（前の名前は［無視］）は
 *    「AIの指摘（誤字脱字）を退けた」の1行になる
 * 4. 固定しない欄（既定）は、提案パネルが前の間は話を指さない。原稿のタブへ戻ると［適用］の回が1行で出る（2件目）
 *
 * ## 欄を固定（ピン留め）してから押す
 *
 * タイムラインの欄は前に出ている編集画面を追う。提案パネルは WebView のパネル（`createWebviewPanel`）で、
 * VS Code 1.145 の欄（`timelinePane` の `onActiveEditorChanged`）は WebView のパネルが前に出ると
 * 追う先を失う。そのまま押すと、製品の知らせとは別の理由で欄が替わる。そこで、原稿エディターで話を
 * 開いて欄に出したあと、欄を固定（`timeline.toggleFollowActiveEditor`）してから提案パネルを押す。
 * 原稿のタブを押し直して追わせることはしない——押し直しそのものが読み直しを起こし、0.130.2 の直し
 * （保存なしで新しくなる）を測れなくなる。固定しないときの様子は2件目で見る。
 *
 * **Timeline の口は VS Code 1.145 で正式になった。** `NOVELAI_E2E_VSCODE=1.145.0` で走らせる
 * （1.145 より前では何も見ずに通す）。**AI・GitHub は呼ばない**（指摘は置き場の見本）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { openEpisode } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_KEY,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  writeSampleFindings,
  type SampleFinding,
} from "./support/sampleFinding";
import { E2E_VSCODE_VERSION, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { activateTab, clearNotifications, dismissWorkbenchHover, pressWorkbenchKey, tabIsDirty } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　近づいてみると、男は以外にも若かった。",
  "　彼は灯台を見上げけて、息を吐いた。",
  "　ホームの時計が、零時を指していた。",
  "",
].join("\n");

/** ［適用］して［戻す］指摘 */
const TO_APPLY: SampleFinding = {
  episode: EPISODE,
  text: TEXT,
  original: "男は以外にも若かった。",
  target: "以外",
  suggestion: "意外",
  message: "「思いのほか」の意味なら「意外」です",
};
/** ［見送る］指摘（同じ語の鍵が並ばないよう、別の指摘で押す） */
const TO_DISMISS: SampleFinding = {
  episode: EPISODE,
  text: TEXT,
  original: "彼は灯台を見上げけて、息を吐いた。",
  target: "見上げけて",
  suggestion: "見上げて",
  message: "「け」が重なっています",
};

const TIMELINE_KEY = "ctrl+alt+shift+t";
const TIMELINE_PRESS = "Control+Alt+Shift+KeyT";
/** 欄の固定（ピン留め）の切り替え。使い捨ての keybindings.json にだけ書く */
const PIN_KEY = "ctrl+alt+shift+x";
const PIN_PRESS = "Control+Alt+Shift+KeyX";

/** 指摘が出たときの行（欄がこの話を指しているかの目印。採否で消えない） */
const FOUND_ROW = "AIの指摘（誤字脱字）「以外」→「意外」";
const APPLIED_ROW = "AIの指摘（誤字脱字）を採った";
const REVERTED_ROW = "AIの指摘（誤字脱字）を戻した";
const DISMISSED_ROW = "AIの指摘（誤字脱字）を退けた";

/** 保存なしで欄が新しくなるのを待つ上限。製品の待ちは0.4秒で、読み直しを足しても数秒の内 */
const REFRESH_LIMIT_MS = 5_000;

const launchOptions: LaunchOptions = {
  settings: { "novelai.timeline.show": true, "workbench.hover.delay": 200 },
  keybindings: [
    { key: OPEN_PROPOSALS_KEY, command: "novelai.openProposals" },
    { key: TIMELINE_KEY, command: "timeline.focus" },
    { key: PIN_KEY, command: "timeline.toggleFollowActiveEditor" },
  ],
  // 指摘は起こす前に置く（起きてから書くと「外で変更されました」の知らせが出ることがある）
  prepareWork: async ({ workFolder }) => {
    await writeSampleFindings(workFolder, [TO_APPLY, TO_DISMISS]);
  },
};

function versionAtLeast(actual: string, wanted: readonly number[]): boolean {
  const parts = actual.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < wanted.length; index += 1) {
    const a = parts[index] ?? 0;
    const b = wanted[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** タイムラインの欄（見出しが Timeline／タイムライン の区画） */
function timelinePane(page: Page) {
  return page.locator(".pane", { has: page.locator(".pane-header", { hasText: /Timeline|タイムライン/ }) }).first();
}

/** タイムラインの欄の行の字（英語の画面でも日本語の画面でも拾う） */
async function timelineRows(page: Page): Promise<string[]> {
  const pane = timelinePane(page);
  if ((await pane.count()) === 0) return [];
  return (await pane.locator(".monaco-list-row").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
}

/** 欄が空のときに出る説明（「追えない」と出ていないか、失敗の文に添える） */
async function timelineMessage(page: Page): Promise<string> {
  const pane = timelinePane(page);
  if ((await pane.count()) === 0) return "（欄が無い）";
  return (await pane.locator(".message").allInnerTexts().catch(() => [])).join(" / ").trim();
}

function countRows(rows: readonly string[], needle: string): number {
  return rows.filter((row) => row.includes(needle)).length;
}

async function describeTimeline(page: Page): Promise<string> {
  return `欄の行：${JSON.stringify(await timelineRows(page))}／欄の説明：${JSON.stringify(await timelineMessage(page))}`;
}

/**
 * 欄の `needle` を含む行に矢印を載せ、出た吹き出しの字を返す。
 * 吹き出しは VS Code 本体の `.workbench-hover`（版によって `.monaco-hover`）に出る
 */
async function rowTooltip(page: Page, needle: string): Promise<string> {
  await dismissWorkbenchHover(page);
  const row = timelinePane(page).locator(".monaco-list-row", { hasText: needle }).first();
  const label = row.locator(".monaco-icon-label").first();
  let text = "";
  for (let attempt = 1; attempt <= 3 && !text; attempt++) {
    await ((await label.count()) > 0 ? label : row).hover({ position: { x: 20 + attempt, y: 8 } });
    await waitUntil(
      async () => {
        text = await page.evaluate(() => {
          const shown = Array.from(document.querySelectorAll(".workbench-hover, .monaco-hover")).find((element) => {
            const box = (element as HTMLElement).getBoundingClientRect();
            return box.width > 0 && box.height > 0 && !element.classList.contains("hidden");
          });
          return shown ? (shown as HTMLElement).innerText : "";
        });
        return text.trim() !== "";
      },
      `欄の行「${needle}」に矢印を載せると吹き出しが出る`,
      5_000
    ).catch(() => undefined);
  }
  if (!text) {
    const attributes = await row
      .evaluate((element) => ({
        aria: element.getAttribute("aria-label"),
        titles: Array.from(element.querySelectorAll("[title]")).map((node) => node.getAttribute("title")),
      }))
      .catch(() => ({}));
    throw new Error(`欄の行「${needle}」の吹き出しが出ません（行の属性：${JSON.stringify(attributes)}）（${await describeTimeline(page)}）`);
  }
  await dismissWorkbenchHover(page);
  return text;
}

async function fileText(session: E2ESession): Promise<string> {
  const raw = await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "");
  return raw.replace(/\r\n/g, "\n");
}

/** 原稿エディターで話を開き、欄を出して、指摘の「出たとき」の行が並ぶまで */
async function showEpisodeTimeline(page: Page): Promise<void> {
  await openEpisode(page, EPISODE, "零時を指していた");
  await pressWorkbenchKey(page, TIMELINE_PRESS);
  await waitUntil(async () => countRows(await timelineRows(page), FOUND_ROW) === 1, "欄に第1話の指摘の行が出る", 20_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（${await describeTimeline(page)}）`);
    }
  );
}

/** 欄を固定する。押したあと、見出しの操作が「固定をやめる」側へ替わるのを待つ */
async function pinTimeline(page: Page): Promise<void> {
  await pressWorkbenchKey(page, PIN_PRESS);
  const header = timelinePane(page).locator(".pane-header");
  await waitUntil(
    async () => {
      const labels = await header.locator(".action-label").evaluateAll((nodes) =>
        nodes.map((node) => `${node.getAttribute("aria-label") ?? ""} ${node.getAttribute("title") ?? ""}`)
      );
      return labels.some((label) => /Unpin|固定を解除|ピン留めを外す/.test(label));
    },
    "欄が固定される（見出しの操作が「Unpin Current Timeline」になる）",
    10_000
  ).catch(async (error: unknown) => {
    const labels = await header
      .locator(".action-label")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? node.getAttribute("title") ?? ""))
      .catch(() => []);
    throw new Error(`${String(error)}（見出しの操作：${JSON.stringify(labels)}）`);
  });
}

/** 提案パネルを開き、2件の指摘が［適用］つきで並ぶまで */
async function openProposals(page: Page): Promise<Frame> {
  await clearNotifications(page);
  await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
  let proposals: Frame | undefined;
  await waitUntil(
    async () => {
      proposals = await proposalPanelFrame(page);
      return proposals !== undefined && (await proposals.locator('button[data-action="apply"]').count()) >= 2;
    },
    "提案パネルに2件の指摘が［適用］つきで並ぶ",
    20_000
  ).catch(async (error: unknown) => {
    const shown = proposals ? await proposals.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => "") : "（提案パネルが無い）";
    throw new Error(`${String(error)}（提案パネルの字：${JSON.stringify(shown)}）`);
  });
  if (!proposals) throw new Error("提案パネルが見つかりません");
  return proposals;
}

function issueRow(frame: Frame, needle: string) {
  return frame.locator("#list .issue", { hasText: needle }).first();
}

/** 欄に `needle` の行が出るまで待ち、押してからの時間（ミリ秒）を返す */
async function waitForRow(page: Page, needle: string, pressedAt: number, what: string): Promise<number> {
  await waitUntil(async () => countRows(await timelineRows(page), needle) >= 1, what, REFRESH_LIMIT_MS + 1_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（押してから ${Date.now() - pressedAt}ms。保存はしていない）（${await describeTimeline(page)}）`);
    }
  );
  return Date.now() - pressedAt;
}

/** まとめたあとの欄の形が、数秒たっても崩れない（遅れて別の行が増えない）ことを見る */
async function rowsHold(page: Page, expectation: (rows: string[]) => boolean, what: string): Promise<void> {
  await holdsFor(async () => expectation(await timelineRows(page)), what, 3_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await describeTimeline(page)}）`);
  });
}

test.skipIf(!versionAtLeast(E2E_VSCODE_VERSION, [1, 145]))(
  "固定したタイムラインの欄は、提案パネルの［適用］［戻す］［見送る］のたびに保存なしで新しくなり、1回の採否が1行にまとまって、説明に3つの記録の中身が並ぶ",
  async () => {
    await withVsCode(
      "タイムラインの採否の1行",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        await showEpisodeTimeline(page);
        await pinTimeline(page);
        const proposals = await openProposals(page);
        // 欄はまだ第1話を指している（固定が効いている）
        expect(countRows(await timelineRows(page), FOUND_ROW), await describeTimeline(page)).toBe(1);
        expect(countRows(await timelineRows(page), APPLIED_ROW)).toBe(0);

        /* ── ［適用］：保存なしで「を採った」の1行が出る ── */
        const appliedAt = Date.now();
        await issueRow(proposals, "以外").locator('button[data-action="apply"]').click();
        await waitUntil(async () => (await fileText(session)).includes("男は意外にも若かった。"), "［適用］で本文のファイルが直る", 15_000);
        const appliedMs = await waitForRow(page, APPLIED_ROW, appliedAt, "［適用］のあと、保存なしで欄に「AIの指摘（誤字脱字）を採った」が出る");
        console.log(`［適用］から欄に行が出るまで ${appliedMs}ms`);
        expect(appliedMs, "保存なしで欄が新しくなるまでの時間").toBeLessThan(REFRESH_LIMIT_MS);
        await rowsHold(
          page,
          (rows) => countRows(rows, APPLIED_ROW) === 1 && countRows(rows, "反映した") === 0 && countRows(rows, FOUND_ROW) === 1,
          "［適用］の記録は「を採った」の1行だけ（編集履歴・操作ログの「反映した」は行にならない）"
        );
        const appliedTip = await rowTooltip(page, APPLIED_ROW);
        expect(appliedTip, `［適用］の行の説明：${appliedTip}`).toContain(APPLIED_ROW);
        expect(appliedTip, `［適用］の行の説明：${appliedTip}`).toContain("編集履歴：誤字脱字の指摘を反映した");
        expect(appliedTip, `［適用］の行の説明：${appliedTip}`).toContain("誤字の指摘を反映した");

        /* ── ［戻す］：「を戻した」の1行 ── */
        const undo = issueRow(proposals, "意外").locator('button[data-action="undo"]');
        await waitUntil(async () => (await undo.count()) > 0, "［適用］した行に［戻す］が出る", 10_000);
        const revertedAt = Date.now();
        await undo.click();
        await waitUntil(async () => (await fileText(session)) === TEXT, "［戻す］で本文のファイルが元へ戻る", 15_000);
        const revertedMs = await waitForRow(page, REVERTED_ROW, revertedAt, "［戻す］のあと、保存なしで欄に「AIの指摘（誤字脱字）を戻した」が出る");
        console.log(`［戻す］から欄に行が出るまで ${revertedMs}ms`);
        expect(revertedMs).toBeLessThan(REFRESH_LIMIT_MS);
        /*
          ［適用］の回の行は、［戻す］のあとも「AIの指摘（誤字脱字）を採った」の名前と中身のまま1行で残る
          （作者の裁定 2026-11-06 夕「「採った」のまま残す」。0.130.3 の直し）。0.130.2 までは指摘の置き場の
          最後の判断（`decision`）しか見ず、［戻す］で「を採った」の行が消えて、操作ログ「誤字の指摘を反映した」
          （編集履歴を吸った1行）に名前が替わっていた
        */
        await rowsHold(
          page,
          (rows) =>
            countRows(rows, "戻した") === 1 &&
            countRows(rows, REVERTED_ROW) === 1 &&
            countRows(rows, "反映を戻した") === 0 &&
            countRows(rows, "誤字の指摘を戻した") === 0 &&
            countRows(rows, APPLIED_ROW) === 1 &&
            countRows(rows, "反映した") === 0,
          "［戻す］の記録は「を戻した」の1行だけ（編集履歴「誤字脱字の反映を戻した」・操作ログ「誤字の指摘を戻した」は行にならない）。［適用］の回は「を採った」の1行のまま（「反映した」の行にならない）"
        );
        const appliedTipAfterUndo = await rowTooltip(page, APPLIED_ROW);
        expect(appliedTipAfterUndo, `［戻す］のあとの［適用］の行の説明：${appliedTipAfterUndo}`).toContain(APPLIED_ROW);
        expect(appliedTipAfterUndo, `［戻す］のあとの［適用］の行の説明：${appliedTipAfterUndo}`).toContain("編集履歴：誤字脱字の指摘を反映した");
        expect(appliedTipAfterUndo, `［戻す］のあとの［適用］の行の説明：${appliedTipAfterUndo}`).toContain("誤字の指摘を反映した");
        console.log(`［戻す］のあとの欄：${await describeTimeline(page)}`);
        const revertedTip = await rowTooltip(page, REVERTED_ROW);
        expect(revertedTip, `［戻す］の行の説明：${revertedTip}`).toContain(REVERTED_ROW);
        expect(revertedTip, `［戻す］の行の説明：${revertedTip}`).toContain("編集履歴：誤字脱字の反映を戻した");
        expect(revertedTip, `［戻す］の行の説明：${revertedTip}`).toContain("誤字の指摘を戻した");

        /* ── ［見送る］（前の名前は［無視］）：「を退けた」の1行 ── */
        const dismissedAt = Date.now();
        await issueRow(proposals, "見上げけて").locator('button[data-action="dismiss"]').click();
        const dismissedMs = await waitForRow(page, DISMISSED_ROW, dismissedAt, "［見送る］のあと、保存なしで欄に「AIの指摘（誤字脱字）を退けた」が出る");
        console.log(`［見送る］から欄に行が出るまで ${dismissedMs}ms`);
        expect(dismissedMs).toBeLessThan(REFRESH_LIMIT_MS);
        await rowsHold(
          page,
          (rows) => countRows(rows, DISMISSED_ROW) === 1 && countRows(rows, "無視した") === 0,
          "［見送る］の記録は「を退けた」の1行だけ（操作ログの「無視した」は行にならない）"
        );
        const dismissedTip = await rowTooltip(page, DISMISSED_ROW);
        expect(dismissedTip, `［見送る］の行の説明：${dismissedTip}`).toContain(DISMISSED_ROW);
        expect(dismissedTip, `［見送る］の行の説明：${dismissedTip}`).toContain("誤字の指摘を無視した");
        // 本文は見送りでは変わらない
        expect(await fileText(session)).toBe(TEXT);
      },
      launchOptions
    );
  },
  240_000
);

/*
  固定しない欄（既定）の様子。2026-11-06 に走らせて分かったこと：提案パネル（WebView のパネル）が前に出ると、
  VS Code 1.145 の欄は追う先を失って「The active editor cannot provide timeline information.」になり、
  ［適用］を押しても欄には何も出ない（製品の知らせが届いても、欄は話を指していない）。原稿のタブへ戻ると、
  欄はその話を読み直し、［適用］の回は「を採った」の1行で出る。**この戻り道は 0.130.2 の直しが無くても
  読み直す**（欄の追う先が替わるため）ので、ここで見ているのは「1行にまとまる」と「保存しないでよい」だけ。
  「すぐ新しくなる」は1件目（固定した欄）で見ている
*/
test.skipIf(!versionAtLeast(E2E_VSCODE_VERSION, [1, 145]))(
  "固定しないタイムラインの欄は、提案パネルが前に出ている間は話を指さず、原稿のタブへ戻ると保存なしで［適用］の回が「AIの指摘（誤字脱字）を採った」の1行で出る",
  async () => {
    await withVsCode(
      "タイムラインの適用（固定しない）",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        await showEpisodeTimeline(page);
        const proposals = await openProposals(page);
        await issueRow(proposals, "以外").locator('button[data-action="apply"]').click();
        await waitUntil(async () => (await fileText(session)).includes("男は意外にも若かった。"), "［適用］で本文のファイルが直る", 15_000);
        // 提案パネルが前に出ている間の欄（VS Code の作り。変わったら気づけるよう、字を残す）
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        console.log(`固定しない欄・提案パネルが前のとき：${await describeTimeline(page)}`);
        expect(countRows(await timelineRows(page), FOUND_ROW), "提案パネルが前の間、欄は話を指さない（VS Code 1.145 の作り）").toBe(0);

        // 原稿のタブへ戻る（保存はしない）
        await activateTab(page, EPISODE);
        await waitUntil(async () => countRows(await timelineRows(page), APPLIED_ROW) === 1, "原稿のタブへ戻ると、欄に［適用］の回が「を採った」で出る", 15_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（${await describeTimeline(page)}）`);
          }
        );
        await rowsHold(
          page,
          (rows) => countRows(rows, APPLIED_ROW) === 1 && countRows(rows, "反映した") === 0,
          "原稿のタブへ戻った欄でも、［適用］の回は「を採った」の1行だけ"
        );
        expect(await tabIsDirty(page, EPISODE), "原稿は未保存の印が付いていない（保存しないで済む）").toBe(false);
      },
      launchOptions
    );
  },
  180_000
);
