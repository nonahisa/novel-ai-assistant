/**
 * 提案パネルの［適用］の変わり種（画面の自動テスト、設計書6.113。実機確認リストの仕分け 2026-10-12 の
 * 束 E6 を移したもの。作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 1. **ワークスペースの外にある作品**（書庫を開かずに、作品一覧から開いた話）で［適用］を押しても、
 *    ファイルと原稿エディターの本文が直った字になる（実機確認リスト 118 行。これまでの
 *    `proposalApply.test.ts` はワークスペースの中の本文でしか見ていない）
 * 2. **一人称の作品の、台詞が多い話**で、地の文に語り手の名前が出た所（「相沢は」）の指摘を
 *    ［適用］すると「俺は」に戻り、**台詞の中の同じ字と「相沢くん」は変わらない**
 *    （実機確認リスト 466・599 行。どちらも「適用で戻ることは画面が要る」が残りだった）
 *
 * **AI は呼ばない。** 指摘は製品が読む形（`.aiwriter/findings.jsonl`）で見本を置く。
 * 2 の見本は、推敲が地の文の名前を見つけたときに製品が残す形に合わせた——分類名（`label`）は
 * 「推敲」、種類は `proofread`、説明は「視点：…」（`proposalPanel.ts` が `reason：detail` で残す）、
 * 原文も直す範囲も「相沢は」、修正案は「俺は」（`checkProofread.ts` の語り手の名前の指摘）。
 * **置き場から戻した行のタブと見出しは分類名（「推敲」）になる**（`primeFindings.ts` の `toItem`）
 * ので、「視点」の字は説明の中に出る。推敲を押したその場で出る「視点」の札そのものは、
 * 推敲（AI を含む）を走らせないと出ないので見ていない。見つける側（台詞の中の名前・
 * 「相沢くん」を拾わない）は単体テスト `core/narratorNameSlip.test.ts` が見張っている。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, manuscriptFrames, openEpisode } from "./support/manuscriptFrame";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame, writeSampleFinding } from "./support/sampleFinding";
import { expandTreeRow, showSidebar, SIDEBAR_LAUNCH, treeRow, treeRowLabels } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  countTabsNamed,
  dialogText,
  editorGroupTabs,
  notificationTexts,
  pressWorkbenchKey,
  webviewLayers,
} from "./support/workbenchDom";

/** 本文のファイルを読む（`\r\n` は `\n` に揃える。書き換えの合間で無いときは空） */
async function readEpisode(file: string): Promise<string> {
  return (await readFile(file, "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

/** 失敗の文へ添える、列とタブ・WebView の重なり・知らせ */
async function layoutDetail(page: Page): Promise<string> {
  return (
    `（列とタブ：${JSON.stringify(await editorGroupTabs(page).catch(() => []))}` +
    `／WebView の重なり：${JSON.stringify(await webviewLayers(page).catch(() => []))}` +
    `／知らせ：${JSON.stringify(await notificationTexts(page).catch(() => []))}）`
  );
}

/** 提案パネルを開き、［適用］が並ぶまで待って面を返す */
async function openProposalsWithApply(page: Page): Promise<Frame> {
  await clearNotifications(page);
  // 原稿エディター（WebView）に焦点があると素の押下は本体のキー割り当てに届かないので、本体へ戻して押す
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
    const panelText = found ? (await found.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 300) : "（パネルの面なし）";
    throw new Error(`${String(error)}（パネルの字：${panelText}）${await layoutDetail(page)}`);
  });
  if (!found) throw new Error("提案パネルが見つかりません");
  return found;
}

/** 原稿エディターの面のどれかに `marker` が描かれるまで待つ */
async function waitFaceShows(page: Page, marker: string, label: string): Promise<void> {
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(page)) {
        if ((await composeText(frame).catch(() => "")).includes(marker)) return true;
      }
      return false;
    },
    label,
    20_000
  ).catch(async (error: unknown) => {
    const shown: string[] = [];
    for (const frame of await manuscriptFrames(page)) shown.push((await composeText(frame).catch(() => "")).slice(0, 80));
    throw new Error(`${String(error)}（原稿の面に出ている字：${JSON.stringify(shown)}）${await layoutDetail(page)}`);
  });
}

/* ── 1. ワークスペースの外にある作品 ── */

const OUTSIDE_EPISODE = "第1話_駅.txt";
const OUTSIDE_TEXT = ["　終電を逃した駅のホームに、雨の音だけが残っていた。", "　近づいてみると、男は以外にも若かった。", "　ホームの時計が、零時を指していた。", ""].join("\n");
const OUTSIDE_ORIGINAL = "男は以外にも若かった。";
const OUTSIDE_FIXED = "男は意外にも若かった。";

test("ワークスペースの外にある作品を作品一覧から開き、提案パネルの［適用］を押すと、ファイルと原稿エディターの本文が直った字になり、同じ話のタブは増えない", async () => {
  await withVsCode(
    "ワークスペースの外の作品で提案の適用",
    [{ name: OUTSIDE_EPISODE, text: OUTSIDE_TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, {
        episode: OUTSIDE_EPISODE,
        text: OUTSIDE_TEXT,
        original: OUTSIDE_ORIGINAL,
        target: "以外",
        suggestion: "意外",
        message: "「思いのほか」の意味なら「意外」です",
      });

      // 書庫はワークスペースに無いので、クイックオープンでは出ない。作品一覧から開く（作者と同じ道）
      await showSidebar(page, E2E_WORK_TITLE);
      await expandTreeRow(page, E2E_WORK_TITLE);
      await waitUntil(async () => (await treeRow(page, "第1話").count()) > 0, "作品の下に第1話の行が出る").catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
      });
      await treeRow(page, "第1話").click();
      await waitFaceShows(page, "零時を指していた", "作品一覧から開いた第1話が原稿エディターに描かれる");

      const proposals = await openProposalsWithApply(page);
      await proposals.locator('button[data-action="apply"]').first().click();

      const file = path.join(session.manuscriptFolder, OUTSIDE_EPISODE);
      await waitUntil(async () => (await readEpisode(file)).includes(OUTSIDE_FIXED), "直した字がファイルに入る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまのファイル：${JSON.stringify(await readEpisode(file))}）${await layoutDetail(page)}`);
        }
      );
      expect(await readEpisode(file), "ファイルのほかの行が変わりました").toBe(OUTSIDE_TEXT.replace(OUTSIDE_ORIGINAL, OUTSIDE_FIXED));
      // 原稿エディターの面にも直した字が出る（ワークスペースの外の文書でも、読み直しが原稿エディターへ届く）
      await waitFaceShows(page, OUTSIDE_FIXED, "原稿エディターの本文が直した字になる");
      expect(await dialogText(page), "思いがけず確認の窓が出ています").toBeUndefined();
      await holdsFor(
        async () => countTabsNamed((await editorGroupTabs(page)).flat(), OUTSIDE_EPISODE) === 1,
        "［適用］のあとも同じ話のタブが1枚"
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      expect((await manuscriptFrames(page)).length, await layoutDetail(page)).toBe(1);
    },
    {
      ...SIDEBAR_LAUNCH,
      keybindings: [...SIDEBAR_LAUNCH.keybindings, ...OPEN_PROPOSALS_LAUNCH.keybindings],
      outsideWorkspace: true,
    }
  );
});

/* ── 2. 一人称の作品の、台詞が多い話 ── */

const NARRATOR_EPISODE = "001_雨の日.txt";
/*
  台詞が多く、地の文の「俺」は1回だけの話。**台詞の中にも「相沢は」がある**
  （最初の出現は台詞の中）。指摘が指すのは2回目の、地の文の「相沢は」
*/
const NARRATOR_TEXT = [
  "　「相沢は、まだ来ないの？」",
  "　「さあな。あいつはいつも遅れる」",
  "　俺は窓の外を見た。",
  "　「相沢くん、傘は持ってる？」",
  "　「持ってない」",
  "　「また濡れて帰るつもり？」",
  "　相沢は黙ってうなずいた。",
  "　「ほんとに、しょうがないんだから」",
  "",
].join("\n");
const SLIP_LINE = "　相沢は黙ってうなずいた。";
const SLIP_FIXED_LINE = "　俺は黙ってうなずいた。";

test("一人称の作品の台詞が多い話で、地の文の「相沢は」の指摘（推敲・視点）を［適用］すると「俺は」に戻り、台詞の中の「相沢は」「相沢くん」は変わらない", async () => {
  await withVsCode(
    "語り手の名前の指摘の適用",
    [{ name: NARRATOR_EPISODE, text: NARRATOR_TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, {
        episode: NARRATOR_EPISODE,
        text: NARRATOR_TEXT,
        original: "相沢は",
        target: "相沢は",
        suggestion: "俺は",
        // 製品の形：`reason`（視点）と説明を「：」でつなぐ。説明は `describeNarratorNameSlip` の頭と同じ言い方
        message: "視点：「俺」（相沢 春人）の語りの地の文に「相沢は」と名前が出ていて、ここだけ三人称の語りに読めます",
        category: "proofread",
        label: "推敲",
        // 1回目は台詞の中。地の文の2回目を指す
        occurrence: 1,
      });
      await openEpisode(page, NARRATOR_EPISODE, "しょうがないんだから");

      const proposals = await openProposalsWithApply(page);
      // 並んだ行の説明に「視点」が出ている（置き場から戻した行は、説明の中に札の名前が残る）
      const rowText = (await proposals.locator(".issue").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      expect(rowText, `提案パネルの行：${rowText}`).toContain("視点");
      expect(rowText, `提案パネルの行：${rowText}`).toContain("7行目");

      await proposals.locator('button[data-action="apply"]').first().click();

      const file = path.join(session.manuscriptFolder, NARRATOR_EPISODE);
      await waitUntil(async () => (await readEpisode(file)).includes(SLIP_FIXED_LINE), "地の文の「相沢は」が「俺は」になってファイルに入る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまのファイル：${JSON.stringify(await readEpisode(file))}）${await layoutDetail(page)}`);
        }
      );
      // 変わるのは地の文の1か所だけ。台詞の中の「相沢は」「相沢くん」はそのまま
      expect(await readEpisode(file), "地の文の1か所のほかに変わった所があります").toBe(NARRATOR_TEXT.replace(SLIP_LINE, SLIP_FIXED_LINE));
      await waitFaceShows(page, "俺は黙ってうなずいた", "原稿エディターの本文が「俺は」になる");
      const shown = await composeText((await manuscriptFrames(page))[0]);
      expect(shown, "原稿エディターで台詞の中の「相沢は」が消えました").toContain("「相沢は、まだ来ないの？」");
      expect(shown).toContain("「相沢くん、傘は持ってる？」");
      expect(await dialogText(page), "思いがけず確認の窓が出ています").toBeUndefined();
      // 原稿の面は1枚・同じ話のタブも1枚（［適用］で素のエディターや2枚目が開かない）
      expect((await manuscriptFrames(page)).length, await layoutDetail(page)).toBe(1);
      expect(countTabsNamed((await editorGroupTabs(page)).flat(), NARRATOR_EPISODE), await layoutDetail(page)).toBe(1);
    },
    OPEN_PROPOSALS_LAUNCH
  );
});
