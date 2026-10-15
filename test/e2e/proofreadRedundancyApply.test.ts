/**
 * 推敲の「冗長」の指摘を提案パネルの［適用］で当てると、本文の重なった語だけが置き換わる
 * （画面の自動テスト、設計書6.113・6.9.2。実機確認リスト 600 行「推敲の『冗長』の指摘は
 * 実データで1件も出ておらず、適用の道〔『適用』で本文が置き換わる〕が通っているかは
 * 確かめていない」を、2026-10-15 の仕分け〔docs/measurements/2026-10-15-field-triage-hands.md〕で移した）。
 *
 * これまで推敲の［適用］を見ていたのは「視点」（語り手の名前のよじれ）だけだった
 * （`proposalApplyVariants.test.ts`）。「冗長」は**直す範囲より修正案が短い**（語を1つ消す）ので、
 * 置き換えで前後の字を食わないか・余計な所を変えないかを、ファイルと画面の両方で見る。
 *
 * **AI は呼ばない。** 指摘は製品が読む形（`.aiwriter/findings.jsonl`）で見本を置く。
 * 形は推敲が残すものに合わせた——種類 `proofread`、分類名「推敲」、説明は `reason：detail`
 * （`proposalPanel.ts`）で、detail はプロンプトが求める「重なっている2つの語を挙げる」言い方
 * （`prompts/proofread.ts` の「冗長」の項）。**本物の推敲が「冗長」を出すかは見ていない**
 * （AI の出来。実機確認リストの同じ行に残る）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { composeText, manuscriptFrames, openEpisode } from "./support/manuscriptFrame";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame, writeSampleFinding } from "./support/sampleFinding";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
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

const EPISODE = "第1話_朝.txt";
// 「まず最初に」は2行目にだけ置く。「最初に」は4行目にも単独で置き、消してはいけない所にする
const TEXT = [
  "　目覚ましが鳴る前に、目が覚めた。",
  "　まず最初に、窓を開けて空を見た。",
  "　雲ひとつない朝だった。",
  "　最初に浮かんだのは、昨日の約束のことだった。",
  "",
].join("\n");
const REDUNDANT_LINE = "　まず最初に、窓を開けて空を見た。";
const FIXED_LINE = "　まず、窓を開けて空を見た。";

test("推敲の「冗長」の指摘（まず最初に → まず）を提案パネルの［適用］で当てると、その1か所だけが短くなり、別の行の「最初に」は変わらない", async () => {
  await withVsCode(
    "推敲の冗長の適用",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFinding(session.workFolder, {
        episode: EPISODE,
        text: TEXT,
        original: "まず最初に",
        target: "まず最初に",
        suggestion: "まず",
        message: "冗長：「まず」と「最初に」が同じ意味です",
        category: "proofread",
        label: "推敲",
      });
      await openEpisode(page, EPISODE, "昨日の約束");

      const proposals = await openProposalsWithApply(page);
      const rowText = (await proposals.locator(".issue").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      expect(rowText, `提案パネルの行：${rowText}`).toContain("冗長");
      expect(rowText, `提案パネルの行：${rowText}`).toContain("2行目");

      await proposals.locator('button[data-action="apply"]').first().click();

      const file = path.join(session.manuscriptFolder, EPISODE);
      await waitUntil(async () => (await readEpisode(file)).includes(FIXED_LINE), "「まず最初に」が「まず」になってファイルに入る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまのファイル：${JSON.stringify(await readEpisode(file))}）${await layoutDetail(page)}`);
        }
      );
      // 変わるのは2行目の1か所だけ。4行目の単独の「最初に」・句読点・前後の字はそのまま
      expect(await readEpisode(file), "2行目のほかに変わった所があります").toBe(TEXT.replace(REDUNDANT_LINE, FIXED_LINE));

      // 原稿エディターの面も追う
      await waitUntil(
        async () => {
          for (const frame of await manuscriptFrames(page)) {
            if ((await composeText(frame).catch(() => "")).includes("まず、窓を開けて")) return true;
          }
          return false;
        },
        "原稿エディターの本文が「まず、窓を開けて」になる",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}${await layoutDetail(page)}`);
      });
      const shown = await composeText((await manuscriptFrames(page))[0]);
      expect(shown, "原稿エディターで4行目の「最初に」が消えました").toContain("最初に浮かんだのは");
      expect(await dialogText(page), "思いがけず確認の窓が出ています").toBeUndefined();
      // 原稿の面は1枚・同じ話のタブも1枚（［適用］で素のエディターや2枚目が開かない）
      expect((await manuscriptFrames(page)).length, await layoutDetail(page)).toBe(1);
      expect(countTabsNamed((await editorGroupTabs(page)).flat(), EPISODE), await layoutDetail(page)).toBe(1);
    },
    OPEN_PROPOSALS_LAUNCH
  );
});
