/**
 * Mac の画面の文に、「右クリック」の添え書き「（Mac は control＋クリック）」が付いているか
 * （画面の自動テスト、設計書2.4・6.113。0.148.0。作者の問い 2026-11-08「右クリックはMacではどう操作しますか？」）。
 *
 * 実機確認リスト 0.148.0 の〔Mac〕項目（画面の写真）を機械へ移したもの。文の組み立て（`keysForHost`・
 * 「文ごとに最初の1回だけ添える」）は単体テスト `keyLabelsOnMac.test.ts` が見ている。ここで見るのは
 * **本物の画面に出た文**。**Mac でだけ走らせる**（`process.platform !== "darwin"` なら飛ばす。
 * Windows では添え書きが付かないのが正しいので、見るものが無い）。
 *
 * 見る場所：
 * 1・2. 作品一覧のメモの行と、編集者メニューの「修正を提案する」に指を置いたときの説明は、**ここでは見ない**。
 *    画面の外に起こした Mac の VS Code では、行に指を置いても吹き出しが出なかった（2026-11-13 Mac で2件とも、
 *    3回置き直して各5秒）。説明の文は `keysForHost` を通る（単体テスト keyLabelsOnMac の
 *    「src の注釈でない行の「Ctrl+…」「右クリック」は、keysForHost・…のどれかと同じ行にある」が見張る）ので、
 *    添え書きが付くこと・1行に1つだけなことは単体テストの決まりで覆う
 * 3. 使い方（マニュアル）：「右クリック」を含む行は、最初の「右クリック」の直後に添えてあり、
 *    同じ行の2回目の「右クリック」には添えていない
 * 4. EPUBエディターの右の並びの下の文（「ドラッグで並べ替え。右クリックで挿入・上へ・下へ・削除。」）
 *
 * **見るのは「右クリック」の直後に添え書きがあること・同じ行に1つだけであること**。読みやすさは作者。
 * 写真を `NOVELAI_E2E_PHOTOS`（無ければ一時フォルダーの `novelai-e2e-photos`）へ残す——Mac のセッションが
 * 画面を見て、文の位置・重なりを確かめられるように。
 *
 * **AI は呼ばない。**
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { RIGHT_CLICK_MAC_NOTE } from "../../src/core/keyLabels";
import { runCommand } from "./support/quickInput";
import { SHOW_SIDEBAR_KEY } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  clearNotifications,
  pickQuickPickRow,
  quickPickTitle,
} from "./support/workbenchDom";

const isMac = process.platform === "darwin";

/** 写真の置き場（Mac のセッションが見る）。環境変数 `NOVELAI_E2E_PHOTOS`、無ければ一時フォルダーの下 */
function photoFolder(): string {
  return process.env.NOVELAI_E2E_PHOTOS || path.join(os.tmpdir(), "novelai-e2e-photos");
}

async function takePhoto(page: Page, name: string): Promise<string> {
  const folder = photoFolder();
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `右クリック添え書き-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** 「右クリック」の数と、添え書きの数 */
function countClicks(text: string): { clicks: number; notes: number } {
  return {
    clicks: (text.match(/右クリック/g) ?? []).length,
    notes: text.split(RIGHT_CLICK_MAC_NOTE).length - 1,
  };
}

/** 添え書きは「最初の右クリック」の直後（その行の1回目だけ） */
function expectNoteOncePerLine(text: string, where: string): void {
  const bad: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("右クリック")) continue;
    const { notes } = countClicks(line);
    const first = line.indexOf("右クリック");
    const note = line.indexOf(RIGHT_CLICK_MAC_NOTE);
    if (notes !== 1 || note !== first + "右クリック".length) bad.push(line.slice(0, 120));
  }
  expect(bad, `${where}：「右クリック」の直後に添え書きが1つだけ付いていない行`).toEqual([]);
}

/** EPUBエディター（目印は「本の設定」の行 `#railBook` と並びの箱 `#blockList`） */
async function epubFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("railBook") !== null && document.getElementById("blockList") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 拡張機能の保管庫から、いま組んだ「使い方」の写し（.md）を探す */
async function findManualFile(session: E2ESession): Promise<string | undefined> {
  const base = path.join(session.root, "user-data");
  const names = await readdir(base, { recursive: true }).catch(() => [] as string[]);
  const found = names.map(String).filter((name) => name.endsWith(".md") && path.basename(name).includes("使い方"));
  return found.length > 0 ? path.join(base, found[found.length - 1]) : undefined;
}

test.skipIf(!isMac)("Mac：使い方（マニュアル）・EPUBエディターの右の並びの下の文の「右クリック」に添え書きが付き、同じ行の2回目には付かない", async () => {
  await withVsCode(
    "Mac 右クリックの添え書き",
    [{ name: "第1話_駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n" }],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);

      /* ── 3. 使い方（マニュアル） ── */
      await runCommand(page, "使い方（マニュアル）");
      let file: string | undefined;
      await waitUntil(async () => (file = await findManualFile(session)) !== undefined, "使い方（マニュアル）の写しが保管庫にできる", 30_000);
      const manual = await readFile(file ?? "", "utf8");
      expect(manual.length, "使い方の文").toBeGreaterThan(1000);
      expectNoteOncePerLine(manual, "使い方（マニュアル）");
      expect(countClicks(manual).clicks, "使い方に「右クリック」が1つも無い（確かめる行が無い）").toBeGreaterThan(0);
      await takePhoto(page, "使い方");

      /* ── 4. EPUBエディターの右の並びの下の文 ── */
      await runCommand(page, "EPUBエディター（試作）");
      await page.waitForTimeout(500);
      if ((await quickPickTitle(page)) !== undefined) await pickQuickPickRow(page, E2E_WORK_TITLE);
      let epub: Frame | undefined;
      await waitUntil(async () => (epub = await epubFrame(page)) !== undefined, "EPUBエディターが開く", 30_000);
      if (!epub) throw new Error("EPUBエディターが見つかりません");
      const hint = epub.locator(".rail-hint").first();
      await hint.waitFor({ state: "visible", timeout: 15_000 });
      // 面の中の字は、描いたあとに WebView の台本が直すことがある。落ち着いた字を読む
      let hintText = "";
      await waitUntil(async () => (hintText = ((await hint.textContent()) ?? "").trim()).includes(RIGHT_CLICK_MAC_NOTE), "右の並びの下の文に添え書きが付く", 10_000).catch(
        () => undefined
      );
      expect(hintText, "右の並びの下の文").toBe(`ドラッグで並べ替え。右クリック${RIGHT_CLICK_MAC_NOTE}で挿入・上へ・下へ・削除。`);
      await takePhoto(page, "EPUBエディターの右の並び");
    },
    {
      // 作品に1つメモを置く（メモの枝は、メモが1つ以上あるときだけ作品の下に出る）
      prepareWork: async ({ workFolder }) => {
        const folder = path.join(workFolder, "設定", "メモ");
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "見本のメモ.md"), "# 見本のメモ\n", "utf8");
      },
      // **左の列を出すキーを割り当てる。** 割り当てが無いと、押してもエクスプローラーのまま
      // 作品一覧が出ず、「メモ」の枝を20秒待って落ちた（Mac。2026-11-13）。
      // 吹き出しを読む件なので、`SIDEBAR_LAUNCH.settings`（吹き出しを出さない設定）は足さない
      keybindings: [{ key: SHOW_SIDEBAR_KEY, command: "workbench.view.extension.novelai" }],
    }
  );
}, 300_000);
