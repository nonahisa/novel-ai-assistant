/**
 * 作者モードの「編集者の提案を見る」と、前の版で置かれた手書きの提案の出方・編集者モードの原稿エディターの
 * 右クリック（画面の自動テスト、設計書5.6・6.113。実機確認リスト 0.120.2 の「編集者の提案を見る」が1つだけ…
 * 「編集部」が残っていない…の2項目のうち、editorModeMenus が見ていない残りを機械へ移した。
 * 作者の判断 2026-11-01「1つにまとめる」「画面はすべて『編集者』にそろえる」）。
 *
 * 見張ること：
 * 1. 編集者が返した提案のうち2件が**自動の同期で先に作品の台帳へ届いている**（作品の
 *    `.aiwriter/proposals/proposals.jsonl` に置いてある）状態で、詳細メニュー「作品管理」→「編集者連携」→
 *    「編集者の提案を見る」を押すと、GitHub の代わりの置き場からまだ届いていなかった1件も受け取り、未決の3件が
 *    提案パネルに並び、知らせが「編集者からの提案が 3 件あります。…」になる（「すべて取り込み済み」
 *    「未決の提案はありません」で止まらない）
 * 2. 前の版の編集者が置いた手書きの提案（台帳の分類は今も `編集部の直し`・`編集部のメモ` のまま）が、提案パネルで
 *    「編集者の修正：…」「編集者のメモ：…」と出て、パネルにも知らせにも「編集部」が出ない
 * 3. つながらないとき（送り先の置き場の名前を変えて取りに行けなくする。outboxInboxReceiveFirst と同じ手）に押すと、
 *    手元の未決3件が並び（その間に送られた4件目は並ばない）、知らせに「GitHubから受け取れませんでした。」と
 *    「手元にある分を並べています。」が添えられる
 * 4. 編集者モードで原稿エディターの本文を選んで右クリックすると、品書きに「修正を提案する」が出て、
 *    「編集部」の字はどこにも無い（素のエディターの右クリックと詳細メニューは editorModeMenus が見ている）
 *
 * **GitHub は呼ばない。** 編集用フォルダー（作者の側の写し）は一時フォルダーの中の本物の git の置き場で、
 * 送り先は同じ一時フォルダーの中の裸の置き場（`support/gitFixture.ts`）。編集者の側は、その送り先を clone した
 * フォルダーから提案の台帳を送る（編集者が「校閲を終えて返す」で送るのと同じ形）。作品フォルダーそのものは
 * git にしない（同期の見張りが動かず、受け取りの道が「編集者の提案を見る」の1本になる）。
 * どこに編集用フォルダーがあるかは、製品が「編集者へ渡す」のときに書くのと同じ形の
 * `.aiwriter/cache/editing.json` を起こす前に置く。**AI は呼ばない。**
 *
 * **見ていないもの**：既定の置き場の `編集部/` フォルダーを製品が作る所（「編集者へ渡す」は GitHub に
 * リポジトリを作る道なので届かない。置き場の名前の決め方は単体テスト unit/core/editingRepoAuto が見ている）。
 */
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { HAND_EDIT_CATEGORY, HAND_MEMO_CATEGORY, proposalId } from "../../src/models/proposal";
import { addLocalRemote, git, initRepoWithFirstCommit } from "./support/gitFixture";
import { openEpisode, selectText } from "./support/manuscriptFrame";
import { proposalPanelFrame } from "./support/sampleFinding";
import { SIDEBAR_LAUNCH, expandTreeRow, scrollTreeUntilRow, showSidebar, treeRow } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, notificationTexts, quickInputWaitContext } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const LINE = "　終電を逃した駅のホームに、雨の音だけが残っていた。";
const TEXT = `${LINE}\n`;
const FILE = `本文/${EPISODE}`;
const PROPOSER = "画面テスト編集者";

interface HandProposal {
  target: string;
  suggestion: string;
  reason: string;
  category: string;
  time: string;
}

/** 前の版の編集者が手で置いた形（`buildHandProposal` と同じ番号の作り方。分類は台帳の値のまま） */
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

/** 自動の同期で先に届いていた2件（直し1件・意見だけ1件） */
const DELIVERED: HandProposal[] = [
  { target: "雨の音", suggestion: "雨音", reason: "音の重なりを避けたい", category: HAND_EDIT_CATEGORY, time: "2026-11-01T10:00:00.000Z" },
  { target: "駅のホーム", suggestion: "", reason: "駅名を出すと場所が伝わります", category: HAND_MEMO_CATEGORY, time: "2026-11-01T10:01:00.000Z" },
];
/** まだ送り先にしか無い1件（押したときに受け取る） */
const NOT_YET: HandProposal = {
  target: "終電",
  suggestion: "最終電車",
  reason: "表記をそろえたい",
  category: HAND_EDIT_CATEGORY,
  time: "2026-11-01T10:02:00.000Z",
};
/** つながらない間に送られた1件（並ばないはず） */
const WHILE_OFFLINE: HandProposal = {
  target: "残っていた",
  suggestion: "残る",
  reason: "言い切りにしたい",
  category: HAND_EDIT_CATEGORY,
  time: "2026-11-01T10:03:00.000Z",
};

const LEDGER_RELATIVE = path.join(".aiwriter", "proposals", "proposals.jsonl");

/** 一時フォルダーの根の中の置き場（作品フォルダーは 根/書庫/作品） */
function places(root: string): { editing: string; remote: string; editorSide: string } {
  return {
    editing: path.join(root, "編集部", `${E2E_WORK_TITLE}-編集用`),
    remote: path.join(root, "編集用送り先.git"),
    editorSide: path.join(root, "編集者の機械"),
  };
}

/** 編集者の側（送り先の clone）で、提案の台帳に1件足して送る */
async function sendFromEditor(editorSide: string, entry: HandProposal): Promise<void> {
  const file = path.join(editorSide, LEDGER_RELATIVE);
  const before = await readFile(file, "utf8");
  await writeFile(file, `${before}${proposalLine(entry)}\n`, "utf8");
  await git(editorSide, ["add", "-A"]);
  await git(editorSide, ["commit", "--quiet", "-m", `提案：${entry.target}`]);
  await git(editorSide, ["push", "--quiet"]);
}

const AUTHOR_LAUNCH: LaunchOptions = {
  ...SIDEBAR_LAUNCH,
  prepareWork: async ({ workFolder }) => {
    const root = path.dirname(path.dirname(workFolder));
    const { editing, remote, editorSide } = places(root);
    const delivered = `${DELIVERED.map(proposalLine).join("\n")}\n`;

    // 作者の側の編集用フォルダー：届いた2件の入った台帳を記録して、送り先へ送ってある
    await mkdir(path.join(editing, ".aiwriter", "proposals"), { recursive: true });
    await mkdir(path.join(editing, "本文"), { recursive: true });
    await writeFile(path.join(editing, "本文", EPISODE), TEXT, "utf8");
    await writeFile(path.join(editing, LEDGER_RELATIVE), delivered, "utf8");
    await initRepoWithFirstCommit(editing);
    await addLocalRemote(editing, remote);

    // 編集者の側：送り先を clone して、3件目を送る（作者の側の写しはまだ受け取っていない）
    await git(root, ["clone", "--quiet", remote, editorSide]);
    await git(editorSide, ["config", "user.name", PROPOSER]);
    await git(editorSide, ["config", "user.email", "e2e-editor@example.invalid"]);
    await git(editorSide, ["config", "core.autocrlf", "false"]);
    await sendFromEditor(editorSide, NOT_YET);

    // 作品の台帳：自動の同期で先に届いた2件（受け取りの口が足すのと同じ行）
    await mkdir(path.join(workFolder, ".aiwriter", "proposals"), { recursive: true });
    await writeFile(path.join(workFolder, LEDGER_RELATIVE), delivered, "utf8");
    // どこに編集用フォルダーがあるか（製品が「編集者へ渡す」で書く形。features/shareWithEditor.ts の EditingPointer）
    await mkdir(path.join(workFolder, ".aiwriter", "cache"), { recursive: true });
    await writeFile(
      path.join(workFolder, ".aiwriter", "cache", "editing.json"),
      `${JSON.stringify({ folderPath: editing, sharedAt: "2026-11-01T09:00:00.000Z" }, null, 2)}\n`,
      "utf8"
    );
  },
};

/**
 * 左の列の区画を、見出しの左端（畳みの矢印）を押して開く・畳む（editorModeMenus と同じ押し方）。
 * 見出しの真ん中を押すと、指を載せて出たボタン（作品一覧の「保存・同期」など）に当たることがある
 */
async function setSidebarPane(page: Page, title: string, expanded: boolean): Promise<void> {
  const header = page.locator(".pane-header", { hasText: title }).first();
  await header.waitFor({ state: "visible", timeout: 15_000 });
  const now = async () => (await header.getAttribute("aria-expanded")) === "true";
  if ((await now()) === expanded) return;
  await header.click({ position: { x: 8, y: 10 } });
  await waitUntil(async () => (await now()) === expanded, `左の列の「${title}」を${expanded ? "開く" : "畳む"}`, 5_000);
}

/** 詳細メニュー「作品管理」→「編集者連携」→「編集者の提案を見る」を押す */
async function pressViewProposals(page: Page): Promise<void> {
  // 木は見えている行しか描かないので、詳細メニューだけを開いて背を高くする
  for (const pane of ["作品一覧", "簡単ステップメニュー", "AIに相談"]) await setSidebarPane(page, pane, false);
  await setSidebarPane(page, "詳細メニュー", true);
  await scrollTreeUntilRow(page, "執筆データ", "作品管理");
  await expandTreeRow(page, "作品管理");
  await scrollTreeUntilRow(page, "執筆データ", "編集者連携");
  await expandTreeRow(page, "編集者連携");
  const row = await scrollTreeUntilRow(page, "執筆データ", "編集者の提案を見る");
  await row.scrollIntoViewIfNeeded();
  await row.click();
}

interface PanelView {
  count: number;
  reasons: string[];
  text: string;
}

async function readPanel(frame: Frame): Promise<PanelView> {
  return frame.evaluate(() => {
    const issues = Array.from(document.querySelectorAll(".issue"));
    return {
      count: issues.length,
      reasons: issues.map((issue) =>
        Array.from(issue.querySelectorAll(".reason"))
          .map((node) => (node.textContent ?? "").trim())
          .join(" ")
      ),
      text: document.body.innerText,
    };
  });
}

/** 提案パネルに `count` 件並ぶまで待って読む */
async function waitPanel(page: Page, count: number, label: string): Promise<PanelView> {
  let last: PanelView | undefined;
  await waitUntil(
    async () => {
      const frame = await proposalPanelFrame(page);
      if (!frame) return false;
      last = await readPanel(frame);
      return last.count === count;
    },
    label,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（パネル：${JSON.stringify(last)}／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
  });
  return last as PanelView;
}

async function waitNotice(page: Page, includes: string, label: string): Promise<string> {
  let found = "";
  await waitUntil(
    async () => {
      found = (await notificationTexts(page)).find((text) => text.includes(includes)) ?? "";
      return found !== "";
    },
    label,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`);
  });
  return found;
}

test("自動の同期で先に届いた提案があっても「編集者の提案を見る」で未決がすべて提案パネルに並び、前の版の手書きの提案は「編集者の修正：」「編集者のメモ：」と出て、つながらないときは手元の分を並べて「GitHubから受け取れませんでした。」を添える", async () => {
  await withVsCode(
    "編集者の提案を見る",
    [{ name: EPISODE, text: TEXT }],
    async (session: E2ESession) => {
      const { page, root } = session;
      await showSidebar(page, E2E_WORK_TITLE);
      await clearNotifications(page);

      /* ── 1. つながるとき：先に届いた2件＋いま届く1件 ── */
      await pressViewProposals(page);
      const notice = await waitNotice(page, "編集者からの提案が", "「編集者からの提案が N 件あります。」の知らせが出る");
      expect(notice, `知らせ：${notice}`).toContain("編集者からの提案が 3 件あります");
      expect(notice).toContain("「提案」パネルで1件ずつご確認ください。");
      expect(notice, "つながるのに受け取れなかったと言っています").not.toContain("受け取れませんでした");
      const panel = await waitPanel(page, 3, "提案パネルに未決の3件が並ぶ");
      const all = await notificationTexts(page);
      for (const stopped of ["すべて取り込み済み", "未決の提案はありません"]) {
        expect(all.some((text) => text.includes(stopped)), `「${stopped}」で止まっています：${JSON.stringify(all)}`).toBe(false);
      }
      // いま受け取った1件（3件目）も並ぶ
      expect(panel.reasons.some((reason) => reason.includes(NOT_YET.reason)), `いま届いた提案が並んでいません：${JSON.stringify(panel.reasons)}`).toBe(true);
      // 作品の台帳にも足された（受け取りの口が書いた）
      const ledger = await readFile(path.join(session.workFolder, LEDGER_RELATIVE), "utf8");
      expect(ledger).toContain(NOT_YET.reason);

      /* ── 2. 前の版の手書きの提案の出方 ── */
      const edit = panel.reasons.find((reason) => reason.includes(DELIVERED[0].reason)) ?? "";
      const memo = panel.reasons.find((reason) => reason.includes(DELIVERED[1].reason)) ?? "";
      expect(edit, `直しの提案の文：${JSON.stringify(panel.reasons)}`).toContain(`編集者の修正：${DELIVERED[0].reason}（${PROPOSER} さんの提案）`);
      expect(memo, `意見の提案の文：${JSON.stringify(panel.reasons)}`).toContain(`編集者のメモ：${DELIVERED[1].reason}（${PROPOSER} さんの提案）`);
      expect(panel.text.includes("編集部"), `提案パネルに「編集部」が出ています：${panel.text}`).toBe(false);
      expect(all.some((text) => text.includes("編集部")), `知らせに「編集部」が出ています：${JSON.stringify(all)}`).toBe(false);

      /* ── 3. つながらないとき ── */
      const { remote, editorSide } = places(root);
      await sendFromEditor(editorSide, WHILE_OFFLINE);
      await rename(remote, `${remote}-つながらない`);
      await clearNotifications(page);
      await pressViewProposals(page);
      const offline = await waitNotice(page, "受け取れませんでした", "つながらないときの知らせが出る");
      expect(offline, `知らせ：${offline}`).toContain("編集者からの提案が 3 件あります");
      expect(offline).toContain("GitHubから受け取れませんでした");
      expect(offline).toContain("手元にある分を並べています。");
      const kept = await waitPanel(page, 3, "つながらなくても手元の未決3件が並ぶ");
      await holdsFor(
        async () => {
          const frame = await proposalPanelFrame(page);
          return frame !== undefined && (await readPanel(frame)).count === 3;
        },
        "つながらない間に送られた4件目は並ばない",
        2_000
      );
      expect(kept.reasons.some((reason) => reason.includes(WHILE_OFFLINE.reason)), "受け取れていない提案が並んでいます").toBe(false);
    },
    AUTHOR_LAUNCH
  );
}, 240_000);

test("編集者モードで原稿エディターの本文を選んで右クリックすると、品書きに「修正を提案する」が出て「編集部」の字は無い", async () => {
  await withVsCode(
    "編集者モードの原稿エディターの右クリック",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "雨の音");
      await selectText(frame, "雨の音");
      const menu = frame.locator("#menu");
      let items: string[] = [];
      /*
        編集者モードかどうかは、開いたあとに拡張機能から届く（`message.editorMode`）。届く前に
        右クリックすると「修正を提案する」の無い品書きになるので、出るまで開き直す
      */
      // 選んだ字の上で右クリックする（選択の外を押すと、カーソルが動いて選択が外れることがある）
      const rightClickOnSelection = async (): Promise<void> => {
        const spot = await frame.evaluate(() => {
          const compose = document.getElementById("compose") as HTMLElement;
          const range = window.getSelection()?.getRangeAt(0);
          const box = range?.getBoundingClientRect();
          const outer = compose.getBoundingClientRect();
          return box ? { x: box.left - outer.left + box.width / 2, y: box.top - outer.top + box.height / 2 } : undefined;
        });
        await frame.locator("#compose").click({ button: "right", ...(spot ? { position: spot } : {}) });
      };
      await waitUntil(
        async () => {
          await rightClickOnSelection();
          await waitUntil(async () => ((await menu.innerText().catch(() => "")) ?? "").length > 0, "右クリックの品書きが出る", 5_000);
          items = (await menu.innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
          if (items.some((item) => item.startsWith("修正を提案する"))) return true;
          await page.keyboard.press("Escape");
          await selectText(frame, "雨の音");
          return false;
        },
        "編集者モードの右クリックに「修正を提案する」が出る",
        20_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（品書き：${items.join(" / ")}）`);
      });
      expect(items.some((item) => item.includes("編集部")), `品書きに「編集部」があります：${items.join(" / ")}`).toBe(false);
      // 押せる（選んでいるので灰色でない）
      const proposeItem = menu.locator(".item", { hasText: "修正を提案する" }).first();
      expect(await proposeItem.getAttribute("class"), "「修正を提案する」が押せない形です").not.toContain("disabled");
      await page.keyboard.press("Escape");
      // 本文は変わらない
      expect((await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n")).toBe(TEXT);
      // 左の列の木（作品一覧など）にも「編集部」が出ていない
      expect(await treeRow(page, "編集部").count()).toBe(0);
    },
    { settings: { "novelai.mode": "editor" } }
  );
});
