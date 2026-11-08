/**
 * 同期で編集者の提案が届いたときの知らせと、窓を開き直したあとの提案パネルの作品の選び欄（画面の自動テスト、
 * 設計書5.6・6.113。実機確認リスト 0.120.2 の「編集者の提案が届いたあとに窓を読み込み直して提案パネルを開くと、
 * 左上の作品の選び欄にその作品が「（N件）」付きで出る…」を機械へ移した。作者の実機 2026-11-01 で、自動の同期で
 * 届いた提案が選び欄に出ず「編集部提案確認」を押すまで見えなかった不具合の見張り。作者の判断 2026-11-01
 * 「知らせに［提案を見る］を付ける」）。
 *
 * 見張ること：
 * 1. 作品が2つ（作品A＝編集者に渡した作品・作品B＝校正の指摘が1件ある作品）で、編集者が提案を2件返した
 *    （GitHub の代わりの置き場にだけある）状態で「保存・同期」を押すと、「編集者から提案が 2 件届きました
 *    （「画面テストの作品」）。」と［提案を見る］の知らせが出る。**提案パネルは勝手には開かない**
 * 2. ［提案を見る］を押すと、校正・メモパネルにその作品の提案2件が並ぶ（作者の指示 2026-11-08「編集からの
 *    提案も校正メモにうつしてください」。それまでは提案パネル）
 * 3. VS Code を閉じて開き直し、提案パネルを開くと、作品Bの指摘だけが並び、編集者の提案だけの作品（画面テストの
 *    作品）は選び欄にも一覧にも出ない（作者モードの編集者の提案は提案パネルに並べない）。**指摘のある作品が
 *    作品Bの1つだけになるので、選び欄そのものが出ない**（`views/proposalPanelHtml.ts` の `renderWorks` は
 *    2作品以上のときだけ出す）。0.143 までは編集者の提案の作品も数えて2作品になり、選び欄が出ていた
 * 4. 開き直したあとも、画面テストの作品の話を開いて校正・メモパネルを開くと、未決の提案2件が並ぶ
 *    （開き直しで消えない。台帳から読み直す）
 *
 * 引き金を「保存・同期」にしたのは、開いたときの点検（窓の読み込み直し）の知らせが、起こし直しの部品
 * （`restartVsCode`）が最後に知らせを閉じるのと競るため。同期のあとの取り込み（`editingAutomation.ts` の
 * `collectEditorInboxQuietly`）は、開いたときの点検と同じ関数で、知らせの文もボタンも同じ。
 * 作品は git にしないので「保存・同期」は同期するものが無く、提案の取り込みだけが走る。
 *
 * **GitHub は呼ばない。** 編集用フォルダー（作者の側の写し）は一時フォルダーの中の本物の git の置き場で、
 * 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts`）。どこに編集用フォルダーがあるかの記録
 * （`.aiwriter/cache/editing.json`）は**登録のあと**に置く——起こした直後の点検が先に取り込むと、知らせが
 * 登録の途中で閉じられて見られない。**AI は呼ばない。**
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { HAND_EDIT_CATEGORY, HAND_MEMO_CATEGORY, proposalId } from "../../src/models/proposal";
import { addLocalRemote, git, initRepoWithFirstCommit } from "./support/gitFixture";
import { runCommand } from "./support/quickInput";
import { OPEN_SCENE_MEMOS_PRESS } from "./support/keys";
import { memoPanelFrame, openEpisode } from "./support/manuscriptFrame";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame, writeSampleFinding, type SampleFinding } from "./support/sampleFinding";
import { E2E_WORK_TITLE, restartVsCode, withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, dialogText, notificationTexts, pressWorkbenchKey, quickInputWaitContext } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const LINE = "　終電を逃した駅のホームに、雨の音だけが残っていた。";
const TEXT = `${LINE}\n`;
const FILE = `本文/${EPISODE}`;
const PROPOSER = "画面テスト編集者";

const OTHER_TITLE = "作品B";
const REGISTER_OTHER_KEY = "ctrl+alt+shift+b";
const REGISTER_OTHER_PRESS = "Control+Alt+Shift+KeyB";
const EPISODE_B = "001_港.txt";
const TEXT_B = "　夜の港は静かだった。\n　灯台を見上げけて、息を吐いた。\n";
const SAMPLE_B: SampleFinding = { episode: EPISODE_B, text: TEXT_B, original: "灯台を見上げけて、息を吐いた。", target: "見上げけて", suggestion: "見上げて", message: "作品Bの指摘：けが重なっている" };

interface HandProposal {
  target: string;
  suggestion: string;
  reason: string;
  category: string;
  time: string;
}

const RETURNED: HandProposal[] = [
  { target: "雨の音", suggestion: "雨音", reason: "届いた直しの理由", category: HAND_EDIT_CATEGORY, time: "2026-11-01T10:00:00.000Z" },
  { target: "駅のホーム", suggestion: "", reason: "届いた意見の理由", category: HAND_MEMO_CATEGORY, time: "2026-11-01T10:01:00.000Z" },
];

function proposalLine(entry: HandProposal): string {
  return JSON.stringify({
    kind: "proposal",
    id: proposalId(FILE, 1, entry.target, `${entry.suggestion}\u0000${entry.reason}`),
    time: entry.time,
    proposer: PROPOSER,
    file: FILE,
    line: 1,
    original: LINE,
    target: entry.target,
    suggestion: entry.suggestion,
    reason: entry.reason,
    category: entry.category,
  });
}

const LEDGER_RELATIVE = path.join(".aiwriter", "proposals", "proposals.jsonl");

function places(root: string): { editing: string; remote: string; editorSide: string } {
  return {
    editing: path.join(root, "編集部", `${E2E_WORK_TITLE}-編集用`),
    remote: path.join(root, "編集用送り先.git"),
    editorSide: path.join(root, "編集者の機械"),
  };
}

function launchOptions(): LaunchOptions {
  const registerOther: Record<string, unknown> = { key: REGISTER_OTHER_KEY, command: "novelai.addWork", args: { folderPath: "", title: OTHER_TITLE } };
  return {
    keybindings: [...OPEN_PROPOSALS_LAUNCH.keybindings, registerOther],
    prepareWork: async ({ workFolder }) => {
      const root = path.dirname(path.dirname(workFolder));
      const { editing, remote, editorSide } = places(root);

      // 作者の側の編集用フォルダー（渡したときの形。提案はまだ無い）を送り先へ送ってある
      await mkdir(path.join(editing, "本文"), { recursive: true });
      await writeFile(path.join(editing, "本文", EPISODE), TEXT, "utf8");
      await initRepoWithFirstCommit(editing);
      await addLocalRemote(editing, remote);

      // 編集者の側：送り先を clone して、提案2件を送る（作者の側の写しはまだ受け取っていない）
      await git(root, ["clone", "--quiet", remote, editorSide]);
      await git(editorSide, ["config", "user.name", PROPOSER]);
      await git(editorSide, ["config", "user.email", "e2e-editor@example.invalid"]);
      await git(editorSide, ["config", "core.autocrlf", "false"]);
      await mkdir(path.join(editorSide, ".aiwriter", "proposals"), { recursive: true });
      await writeFile(path.join(editorSide, LEDGER_RELATIVE), `${RETURNED.map(proposalLine).join("\n")}\n`, "utf8");
      await git(editorSide, ["add", "-A"]);
      await git(editorSide, ["commit", "--quiet", "-m", "校閲を終えて返す"]);
      await git(editorSide, ["push", "--quiet"]);

      // 作品B：校正の指摘が1件ある作品
      const other = path.join(path.dirname(workFolder), OTHER_TITLE);
      await mkdir(path.join(other, "本文"), { recursive: true });
      await writeFile(path.join(other, "本文", EPISODE_B), TEXT_B, "utf8");
      await writeSampleFinding(other, SAMPLE_B);
      registerOther.args = { folderPath: other, title: OTHER_TITLE };
    },
  };
}

interface PanelView {
  options: string[];
  selected: string;
  reasons: string[];
}

async function readPanel(frame: Frame): Promise<PanelView> {
  return frame.evaluate(() => {
    const select = document.querySelector("#works select") as HTMLSelectElement | null;
    return {
      options: select ? Array.from(select.options).map((option) => (option.textContent ?? "").trim()) : [],
      selected: select ? (select.selectedOptions[0]?.textContent ?? "").trim() : "",
      reasons: Array.from(document.querySelectorAll("#list .issue")).map((issue) => (issue.textContent ?? "").replace(/\s+/g, " ").trim()),
    };
  });
}

/** 提案パネルが `ready` を満たすまで待って読む */
async function waitPanel(page: Page, ready: (view: PanelView) => boolean, label: string): Promise<{ frame: Frame; view: PanelView }> {
  let last: PanelView | undefined;
  let frame: Frame | undefined;
  await waitUntil(
    async () => {
      frame = await proposalPanelFrame(page);
      if (!frame) return false;
      last = await readPanel(frame).catch(() => undefined);
      return last !== undefined && ready(last);
    },
    label,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（パネル：${JSON.stringify(last)}／知らせ：${JSON.stringify(await notificationTexts(page))}）`);
  });
  return { frame: frame as Frame, view: last as PanelView };
}

/**
 * 校正・メモパネルの、編集者の提案の行の文（2026-11-08 から）。提案の行は［見送る］
 * （`data-act="proposalReject"`）を持つ
 */
async function waitMemoProposals(page: Page, count: number, label: string): Promise<string[]> {
  let last: string[] = [];
  await waitUntil(
    async () => {
      const frame = await memoPanelFrame(page);
      if (!frame) return false;
      last = await frame
        .evaluate(() =>
          Array.from(document.querySelectorAll(".memo"))
            .filter((row) => row.querySelector('[data-act="proposalReject"]'))
            .map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim())
        )
        .catch(() => []);
      return last.length === count;
    },
    label,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（行：${JSON.stringify(last)}／知らせ：${JSON.stringify(await notificationTexts(page))}）`);
  });
  return last;
}

const ARRIVED = `編集者から提案が ${RETURNED.length} 件届きました（「${E2E_WORK_TITLE}」）。`;

test("同期で編集者の提案が届くと［提案を見る］付きの知らせが出て（パネルは勝手に開かない）、押すと校正・メモパネルにその作品の提案が並び、開き直した提案パネルの選び欄にはその作品が出ない", async () => {
  await withVsCode(
    "編集者の提案が届いたときの知らせと選び欄",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page, root, workFolder } = session;
      const other = path.join(path.dirname(workFolder), OTHER_TITLE);
      await page.keyboard.press(REGISTER_OTHER_PRESS);
      await waitUntil(() => existsSync(path.join(other, ".aiwriter", "config.json")), "作品Bの登録の印（config.json）ができる", 30_000);
      // 登録のあとに、編集用フォルダーの在りかを置く（製品が「編集者へ渡す」で書く形。features/shareWithEditor.ts の EditingPointer）
      await mkdir(path.join(workFolder, ".aiwriter", "cache"), { recursive: true });
      await writeFile(
        path.join(workFolder, ".aiwriter", "cache", "editing.json"),
        `${JSON.stringify({ folderPath: places(root).editing, sharedAt: "2026-11-01T09:00:00.000Z" }, null, 2)}\n`,
        "utf8"
      );
      await page.waitForTimeout(1_500);
      await clearNotifications(page);
      expect(await proposalPanelFrame(page), "押す前から提案パネルが開いています").toBeUndefined();

      /* ── 1. 同期で届く → 知らせ（パネルは開かない） ── */
      await runCommand(page, "保存・同期");
      const toast = page.locator(".notification-toast", { hasText: ARRIVED }).first();
      await waitUntil(async () => (await toast.count()) > 0, "「編集者から提案が 2 件届きました」の知らせが出る", 60_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}／窓：${JSON.stringify(await dialogText(page))}）${await quickInputWaitContext(page)}`);
      });
      const buttons = (await toast.locator(".monaco-button").allInnerTexts()).map((text) => text.trim());
      expect(buttons, `知らせのボタン：${JSON.stringify(buttons)}`).toContain("提案を見る");
      await holdsFor(async () => (await proposalPanelFrame(page)) === undefined, "届いても提案パネルは勝手に開かない", 2_500).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });

      /* ── 2. ［提案を見る］ → 校正・メモパネルにその作品の提案が並ぶ（2026-11-08） ── */
      await toast.locator(".monaco-button", { hasText: "提案を見る" }).first().click();
      const shown = await waitMemoProposals(page, RETURNED.length, "［提案を見る］で、届いた提案2件が校正・メモパネルに並ぶ");
      for (const entry of RETURNED) {
        expect(shown.some((text) => text.includes(entry.reason)), `並んだ行：${JSON.stringify(shown)}`).toBe(true);
      }
      // 提案パネルには並べない（2つに割れて見えないように）
      expect(await proposalPanelFrame(page), "［提案を見る］で提案パネルが開いています").toBeUndefined();

      /* ── 3. 開き直して提案パネルを開く → 作品Bの指摘だけが並び、編集者の提案だけの作品は出ない ── */
      await restartVsCode(session);
      const reopenedPage = session.page;
      await pressWorkbenchKey(reopenedPage, OPEN_PROPOSALS_PRESS);
      const reopened = await waitPanel(
        reopenedPage,
        (view) => view.reasons.some((reason) => reason.includes(SAMPLE_B.message)),
        "開き直した提案パネルに作品Bの指摘が並ぶ"
      );
      // 指摘のある作品は作品Bだけなので、選び欄は出ない（出ていれば、編集者の提案の作品も数えている）
      expect(reopened.view.options, `提案パネルに作品の選び欄が出ています：${JSON.stringify(reopened.view)}`).toEqual([]);
      expect(reopened.view.reasons, `提案パネルの一覧：${JSON.stringify(reopened.view)}`).toHaveLength(1);
      for (const entry of RETURNED) {
        expect(
          reopened.view.reasons.some((reason) => reason.includes(entry.reason)),
          `編集者の提案が提案パネルに並んでいます：${JSON.stringify(reopened.view)}`
        ).toBe(false);
      }

      /* ── 4. 開き直しても、画面テストの作品の校正・メモパネルには未決の提案2件が並ぶ ── */
      await openEpisode(reopenedPage, EPISODE, "雨の音");
      await reopenedPage.keyboard.press(OPEN_SCENE_MEMOS_PRESS);
      const kept = await waitMemoProposals(reopenedPage, RETURNED.length, "開き直したあとの校正・メモパネルに、届いた提案2件が並ぶ");
      for (const entry of RETURNED) {
        expect(kept.some((text) => text.includes(entry.reason)), `並んだ行：${JSON.stringify(kept)}`).toBe(true);
      }
    },
    launchOptions()
  );
}, 300_000);
