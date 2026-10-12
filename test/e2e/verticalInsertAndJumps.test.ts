/**
 * 縦書きでの「行へ飛ぶ」と、台本の作品の「この話の前に挿入」（画面の自動テスト、設計書6.113・6.25.11・
 * 6.70・6.109。実機確認リストの仕分け 2026-10-12 の束 E7 を移したもの。作者の裁定「仕分けて機械の分から
 * 減らす」）。
 *
 * 1. **台本の作品**で、作品一覧の話の右クリック「この話の前に挿入」を押すと、差し込んだ話が
 *    **縦書きで**開く。対照に、小説の作品ではこれまでどおり横書きで開く（実機確認リスト 201 行。
 *    入口が種類の既定であることは単体テスト `cross/manuscriptOpenOneWay.test.ts` が見ている。
 *    ここで見るのは本物の画面で押したときの向き）
 * 2. **縦書きで開いている話**で、校正・メモパネルの行を押すと、左の縦書きの原稿へ戻ってその行を示し、
 *    右に同じ話を増やさず、左も空白にならず、縦書きのまま（実機確認リスト 230 行。横書きは
 *    `sceneMemoPanel.test.ts` が見ている）
 * 3. 同じく縦書きで開いている話で、提案パネルの行（場所）と［適用］を押しても、縦書きのまま行へ戻り、
 *    本文が直り、同じ話のタブは増えない（230 行の「提案パネルの行からも同じか」。横書きは
 *    `proposalApply.test.ts`、縦書きでの場所の押下だけなら `findingJumpVertical.test.ts` が見ている。
 *    ここでは［適用］のあとの読み直しまで縦書きで通す）
 *
 * 台本の作品は、作品の設定（`.aiwriter/config.json`）に種類 `script` を書いて起こす
 * （登録は既にある設定を上書きしない。`workRegistry.ts` の `addExistingNow`）。
 * git の置き場にはしない（挿入のあとの「名前だけのコミット」の窓は出ない）。**AI は呼ばない。**
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { CONFIG_SCHEMA_VERSION, DEFAULT_MANUSCRIPT_DIR, DEFAULT_SETTINGS_DIR, type WorkKindKey } from "../../src/models/types";
import {
  caretPosition,
  composeText,
  frameLayer,
  manuscriptFrames,
  memoPanelFrame,
  openEpisode,
  placeCaretAfter,
  selectionCollapsed,
} from "./support/manuscriptFrame";
import { answerInput, waitForQuickInput } from "./support/quickInput";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame, writeSampleFinding } from "./support/sampleFinding";
import { expandTreeRow, showSidebar, SIDEBAR_LAUNCH, treeContextMenu, treeRowLabels, waitTreeSettled } from "./support/sidebar";
import { isVerticalFace, turnVertical, VERTICAL_LAUNCH } from "./support/verticalFace";
import { E2E_WORK_TITLE, withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  countTabsNamed,
  dialogText,
  editorGroupTabs,
  notificationTexts,
  pressDialogButton,
  pressWorkbenchKey,
  quickInputWaitContext,
  webviewLayers,
} from "./support/workbenchDom";

/** 失敗の文へ添える、列とタブ・WebView の重なり・知らせ */
async function layoutDetail(page: Page): Promise<string> {
  return (
    `（列とタブ：${JSON.stringify(await editorGroupTabs(page).catch(() => []))}` +
    `／WebView の重なり：${JSON.stringify(await webviewLayers(page).catch(() => []))}` +
    `／知らせ：${JSON.stringify(await notificationTexts(page).catch(() => []))}）`
  );
}

/* ── 1. 台本の作品で「この話の前に挿入」 ── */

const INSERT_EPISODES = [
  { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
  { name: "第2話_つづき.txt", text: "二話の本文。\n" },
  { name: "第3話_おわり.txt", text: "三話の本文。\n" },
];

/** 作品の設定を、登録が書くのと同じ形に種類を足して置く（起こす前に） */
function withWorkKind(kind: WorkKindKey): LaunchOptions {
  return {
    ...SIDEBAR_LAUNCH,
    prepareWork: async ({ workFolder }) => {
      const folder = path.join(workFolder, ".aiwriter");
      await mkdir(folder, { recursive: true });
      await writeFile(
        path.join(folder, "config.json"),
        JSON.stringify(
          {
            schemaVersion: CONFIG_SCHEMA_VERSION,
            workTitle: E2E_WORK_TITLE,
            manuscriptDir: DEFAULT_MANUSCRIPT_DIR,
            settingsDir: DEFAULT_SETTINGS_DIR,
            createdAt: new Date().toISOString(),
            kind,
          },
          null,
          2
        ),
        "utf8"
      );
    },
  };
}

/**
 * 作品一覧で第2話の前に「割り込み」を差し込み、差し込んだ話の原稿の面を返す。
 * 差し込んだ話は空のファイルなので、本文の目印では探せない——**ほかの話を開かずに始め**、
 * 原稿の面が1枚だけ前に出るのを待つ
 */
async function insertBeforeSecond(page: Page, manuscriptFolder: string): Promise<Frame> {
  await showSidebar(page, E2E_WORK_TITLE);
  await expandTreeRow(page, E2E_WORK_TITLE);
  await waitUntil(async () => (await treeRowLabels(page)).some((label) => label.startsWith("第3話")), "作品の下に話が並ぶ").catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
    }
  );
  // 一覧が裏の走査で描き直している最中に押さない（`waitTreeSettled` の説明）
  await waitTreeSettled(page);
  await treeContextMenu(page, "第2話", "この話の前に挿入");
  await waitForQuickInput(page, "この話の前に挿入", 30_000);
  await answerInput(page, "割り込み");
  await waitUntil(async () => ((await dialogText(page)) ?? "").includes("話数を付け替えます"), "付け替えの確認の窓が出る", 20_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}${await quickInputWaitContext(page)}`);
    }
  );
  await pressDialogButton(page, "付け替える");

  // 差し込んだ話のファイルができる（名前は「第2話_割り込み」の形。ほかの話は第3話・第4話へずれる）
  let inserted = "";
  await waitUntil(
    async () => {
      inserted = (await readdir(manuscriptFolder)).find((name) => name.includes("割り込み")) ?? "";
      return inserted !== "";
    },
    "差し込んだ話のファイルができる",
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（本文フォルダー：${JSON.stringify(await readdir(manuscriptFolder))}）${await layoutDetail(page)}`);
  });
  expect(inserted.startsWith("第2話"), `差し込んだ話の名前：${inserted}`).toBe(true);

  // 差し込んだ話が原稿エディターで開き、前に出る（ほかの話は開いていないので、面は1枚）
  let face: Frame | undefined;
  await waitUntil(
    async () => {
      const frames = await manuscriptFrames(page);
      if (frames.length !== 1) return false;
      if (!(await frameLayer(page, frames[0]).catch(() => undefined))?.inFront) return false;
      face = frames[0];
      return true;
    },
    `差し込んだ話（${inserted}）が原稿エディターで開いて前に出る`,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（原稿の面：${(await manuscriptFrames(page)).length}枚）${await layoutDetail(page)}`);
  });
  if (!face) throw new Error("差し込んだ話の原稿の面が見つかりません");
  expect(
    countTabsNamed((await editorGroupTabs(page)).flat(), inserted),
    `差し込んだ話のタブが1枚（探した名前：${JSON.stringify(inserted)}／本文フォルダー：${JSON.stringify(await readdir(manuscriptFolder))}）${await layoutDetail(page)}`
  ).toBe(1);
  return face;
}

test("台本の作品で、作品一覧の話の右クリック「この話の前に挿入」を押すと、差し込んだ話が縦書きで開く", async () => {
  await withVsCode(
    "台本の作品で話を挿入",
    INSERT_EPISODES,
    async (session) => {
      const { page } = session;
      const face = await insertBeforeSecond(page, session.manuscriptFolder);
      await waitUntil(async () => await isVerticalFace(face), "差し込んだ話が縦書きで組まれる", 15_000).catch(async (error: unknown) => {
        const mode = await face.evaluate(() => {
          const compose = document.getElementById("compose");
          return compose ? getComputedStyle(compose).writingMode : "（#compose が無い）";
        }).catch(() => "（読めない）");
        throw new Error(`${String(error)}（本文の writing-mode：${mode}）${await layoutDetail(page)}`);
      });
    },
    withWorkKind("script")
  );
}, 180_000);

test("対照：小説の作品で同じように「この話の前に挿入」を押すと、差し込んだ話はこれまでどおり横書きで開く", async () => {
  await withVsCode(
    "小説の作品で話を挿入",
    INSERT_EPISODES,
    async (session) => {
      const { page } = session;
      const face = await insertBeforeSecond(page, session.manuscriptFolder);
      // 面ができた直後に一瞬だけ見て「横」としない。しばらく横のままであることを見る
      await waitUntil(async () => (await face.evaluate(() => document.getElementById("compose") !== null).catch(() => false)), "差し込んだ話の本文の面が組まれる", 15_000);
      await holdsFor(async () => !(await isVerticalFace(face)), "小説の作品で差し込んだ話が横書きのまま", 2_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
    },
    withWorkKind("novel")
  );
}, 180_000);

/* ── 2. 縦書きで開いている話で、校正・メモパネルの行を押す ── */

const MEMO_EPISODE = "001_はじまり.txt";
const MEMO_TEXT = "一行目の文。\n二行目の文。\n// 見張りのメモ\n四行目の文。\n五行目の文。\n";

test("縦書きで開いている話で、校正・メモパネルの行を押すと、左の縦書きの原稿へ戻ってその行を示し、右に2枚目を作らず、左も空白にならない", async () => {
  await withVsCode(
    "縦書きでメモパネルの行",
    [{ name: MEMO_EPISODE, text: MEMO_TEXT }],
    async (session) => {
      const { page } = session;
      await openEpisode(page, MEMO_EPISODE, "五行目の文");
      // 縦書きの面は作り直されるので、返ってきた新しい面を使う
      const frame = await turnVertical(session, "五行目の文");

      // 原稿の中から Ctrl+Alt+M で、校正・メモパネルを原稿の横（右の列）に開く
      await placeCaretAfter(frame, "一行目");
      await page.keyboard.press("Control+Alt+KeyM");
      let panel: Frame | undefined;
      await waitUntil(
        async () => {
          panel = await memoPanelFrame(page);
          return panel !== undefined && (await panel.locator("button.go").count()) > 0;
        },
        "校正・メモパネルにメモの行が出る",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      if (!panel) throw new Error("校正・メモパネルが見つかりません");
      const groupsBefore = await editorGroupTabs(page);
      expect(groupsBefore.length, `列が2つになっていません：${JSON.stringify(groupsBefore)}`).toBe(2);
      expect(countTabsNamed(groupsBefore[0], MEMO_EPISODE), `左の列に原稿がありません：${JSON.stringify(groupsBefore)}`).toBe(1);

      // パネルの行（メモ）を押す
      await panel.locator("button.go").first().click();

      // 左の原稿へカーソルが戻り、メモの行が示される
      let landed: Frame | undefined;
      await waitUntil(
        async () => {
          for (const candidate of await manuscriptFrames(page)) {
            if (((await caretPosition(candidate))?.lineText ?? "").includes("見張りのメモ")) {
              landed = candidate;
              return true;
            }
          }
          return false;
        },
        "縦書きの原稿のカーソルがメモの行へ動く",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      if (!landed) throw new Error("カーソルの載った原稿の面が見つかりません");

      // 右の列に同じ話が増えない・左が空白にならない。少し遅れて開く2枚目も見逃さないよう見続ける
      await holdsFor(async () => {
        const groups = await editorGroupTabs(page);
        return countTabsNamed(groups.flat(), MEMO_EPISODE) === 1 && countTabsNamed(groups[0] ?? [], MEMO_EPISODE) === 1;
      }, "原稿のタブが左の列に1枚だけ").catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      const frames = await manuscriptFrames(page);
      expect(frames.length, await layoutDetail(page)).toBe(1);
      const shown = await composeText(frames[0]);
      expect(shown, "左の原稿が空白になりました").toContain("一行目の文。");
      expect(shown).toContain("五行目の文。");
      // 飛んだあとも縦書きのまま（横書きの面で開き直していない）
      expect(await isVerticalFace(frames[0]), "メモの行へ飛んだら縦書きでなくなりました").toBe(true);
      // 示された行は選ばれず、行の頭にカーソルだけ（作者の裁定、2026-10-03）
      expect(await selectionCollapsed(frames[0]), "パネルから飛んだ先で行が選ばれています").toBe(true);
      expect((await caretPosition(frames[0]))?.column).toBe(0);
    },
    VERTICAL_LAUNCH
  );
});

/* ── 3. 縦書きで開いている話で、提案パネルの行と［適用］ ── */

const PROPOSAL_EPISODE = "001_駅.txt";
const PROPOSAL_TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。", "　ホームの時計が、零時を指していた。", ""].join("\n");
const PROPOSAL_ORIGINAL = "男は以外にも若かった。";
const PROPOSAL_FIXED = "男は意外にも若かった。";

test("縦書きで開いている話で、提案パネルの行と［適用］を押すと、縦書きのまま行へ戻って本文が直り、同じ話のタブは増えない", async () => {
  await withVsCode(
    "縦書きで提案の行と適用",
    [{ name: PROPOSAL_EPISODE, text: PROPOSAL_TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, {
        episode: PROPOSAL_EPISODE,
        text: PROPOSAL_TEXT,
        original: PROPOSAL_ORIGINAL,
        target: "以外",
        suggestion: "意外",
        message: "「思いのほか」の意味なら「意外」です",
      });
      await openEpisode(page, PROPOSAL_EPISODE, "零時を指していた");
      const frame = await turnVertical(session, "零時を指していた");
      await placeCaretAfter(frame, "終電を逃した");

      await clearNotifications(page);
      await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
      let found: Frame | undefined;
      await waitUntil(
        async () => {
          found = await proposalPanelFrame(page);
          return found !== undefined && (await found.locator('button[data-action="apply"]').count()) > 0;
        },
        "提案パネルに［適用］が並ぶ",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      if (!found) throw new Error("提案パネルが見つかりません");
      const proposals = found;

      const episodeTabs = async () => countTabsNamed((await editorGroupTabs(page)).flat(), PROPOSAL_EPISODE);

      // ── 提案パネルの行（場所）を押す：縦書きの原稿のその行へ戻る ──
      await proposals.locator('.location[data-action="jump"]').first().click();
      await waitUntil(
        async () => {
          for (const candidate of await manuscriptFrames(page)) {
            if (((await caretPosition(candidate))?.lineText ?? "").includes("以外にも")) return true;
          }
          return false;
        },
        "提案パネルの行を押すと、縦書きの原稿のカーソルが指摘の行へ動く",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      await holdsFor(async () => (await episodeTabs()) === 1, "提案パネルの行を押したあとも同じ話のタブが1枚").catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      expect((await manuscriptFrames(page)).length, await layoutDetail(page)).toBe(1);
      const afterJump = (await manuscriptFrames(page))[0];
      expect(await composeText(afterJump), "提案パネルの行を押したら左の原稿が空白になりました").toContain("零時を指していた");
      expect(await isVerticalFace(afterJump), "提案パネルの行を押したら縦書きでなくなりました").toBe(true);

      // ── ［適用］：ファイルが直り、縦書きの面にも直した字が出る ──
      await proposals.locator('button[data-action="apply"]').first().click();
      const file = path.join(session.manuscriptFolder, PROPOSAL_EPISODE);
      await waitUntil(
        async () => (await readFile(file, "utf8").catch(() => "")).includes(PROPOSAL_FIXED),
        "直した字がファイルに入る"
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまのファイル：${JSON.stringify(await readFile(file, "utf8").catch(() => ""))}）${await layoutDetail(page)}`);
      });
      expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n"), "ファイルのほかの行が変わりました").toBe(
        PROPOSAL_TEXT.replace(PROPOSAL_ORIGINAL, PROPOSAL_FIXED)
      );
      await waitUntil(
        async () => {
          for (const candidate of await manuscriptFrames(page)) {
            if ((await composeText(candidate).catch(() => "")).includes(PROPOSAL_FIXED)) return true;
          }
          return false;
        },
        "原稿エディターの本文が直した字になる",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      expect(await dialogText(page), "思いがけず確認の窓が出ています").toBeUndefined();
      await holdsFor(async () => (await episodeTabs()) === 1, "［適用］のあとも同じ話のタブが1枚").catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      const faces = await manuscriptFrames(page);
      expect(faces.length, await layoutDetail(page)).toBe(1);
      // 読み直しのあとも縦書きのまま（横書きの面や素のエディターで開き直していない）
      expect(await isVerticalFace(faces[0]), "［適用］のあと縦書きでなくなりました").toBe(true);
    },
    { keybindings: [...VERTICAL_LAUNCH.keybindings, ...OPEN_PROPOSALS_LAUNCH.keybindings] }
  );
});
