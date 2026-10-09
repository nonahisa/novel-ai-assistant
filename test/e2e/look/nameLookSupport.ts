/**
 * 名前の候補（名前点検・プロットモード）の写真撮りで共有する部品。
 * 偽の Ollama の答え方、プロットモードを開く・候補を出す・plot.md を書き換えて保存する・更新分反映を開く。
 *
 * **本物の AI は呼ばない。** 名前の出来（良し悪し）は見えない。見られるのは答えが返ったあとの配線と画面だけ。
 */
import type { Frame, Page } from "playwright-core";
import type { FakeOllamaRequest } from "../support/fakeOllama";
import { passLocalAiGate } from "../support/fakeOllama";
import { runCommand } from "../support/quickInput";
import { proposalPanelFrame } from "../support/sampleFinding";
import { expandTreeRow, showSidebar, treeContextMenu } from "../support/sidebar";
import { E2E_WORK_TITLE, type E2ESession } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { acceptQuickPick, clearNotifications, dialogText, pickQuickPickRow, pressDialogButton, quickOpen, quickPickTitle } from "../support/workbenchDom";
import { lookNote } from "./lookSupport";

export interface PoolName {
  name: string;
  reading: string;
  note: string;
}

/** 漢字の名前の見本（姓 名）。最後の1つは、既にいる人物（白瀬 灯）と同じ名前 */
export const KANJI_POOL: PoolName[] = [
  { name: "相馬 誠", reading: "そうま まこと", note: "実直な響き" },
  { name: "高橋 蓮", reading: "たかはし れん", note: "若い世代の名" },
  { name: "望月 渉", reading: "もちづき わたる", note: "港を渡る意味" },
  { name: "橘 悠真", reading: "たちばな ゆうま", note: "柔らかい印象" },
  { name: "柊 直人", reading: "ひいらぎ なおと", note: "まっすぐな人柄" },
  { name: "三浦 陽", reading: "みうら よう", note: "明るさを添える" },
  { name: "葛西 湊", reading: "かさい みなと", note: "港の町に合う" },
  { name: "桐生 慎", reading: "きりゅう しん", note: "慎み深い" },
  { name: "久世 遥", reading: "くぜ はるか", note: "遠くを見る" },
  { name: "日向 凪", reading: "ひゅうが なぎ", note: "凪の海のよう" },
  { name: "松永 恒一", reading: "まつなが こういち", note: "年配の落ち着き" },
  { name: "岩田 重蔵", reading: "いわた じゅうぞう", note: "古風で頑固" },
  { name: "須藤 満", reading: "すどう みつる", note: "面倒見のよさ" },
  { name: "北条 隆", reading: "ほうじょう たかし", note: "堂々とした響き" },
  { name: "安西 玄", reading: "あんざい げん", note: "寡黙な印象" },
  { name: "神崎 一", reading: "かんざき はじめ", note: "短く強い" },
  { name: "白瀬 灯", reading: "しらせ あかり", note: "（既にいる人物と同じ名前）" },
];

/** カタカナの名前の見本。既にいる人物（ミレイユ・ボリス・アリシア）とは響きが重ならないもの */
export const KATAKANA_POOL: PoolName[] = [
  { name: "ロデリック", reading: "ろでりっく", note: "古い騎士の名" },
  { name: "フェリクス", reading: "ふぇりくす", note: "幸運という意味" },
  { name: "エドモンド", reading: "えどもんど", note: "富の守り手" },
  { name: "ガブリエル", reading: "がぶりえる", note: "使者の名" },
  { name: "ハロルド", reading: "はろるど", note: "軍を率いる者" },
  { name: "ニコラス", reading: "にこらす", note: "民の勝利" },
  { name: "セドリック", reading: "せどりっく", note: "首領の名" },
  { name: "ティモシー", reading: "てぃもしー", note: "神を敬う" },
  { name: "ダミアン", reading: "だみあん", note: "穏やかな響き" },
  { name: "レナード", reading: "れなーど", note: "獅子の勇気" },
  { name: "オスカー", reading: "おすかー", note: "神の槍" },
  { name: "ベネディクト", reading: "べねでぃくと", note: "祝福された者" },
  { name: "クリストフ", reading: "くりすとふ", note: "キリストを運ぶ者" },
  { name: "ヴィクトル", reading: "う゛ぃくとる", note: "勝者" },
  { name: "ラファエル", reading: "らふぁえる", note: "癒やしの名" },
  { name: "エミール", reading: "えみーる", note: "励む者" },
  { name: "テオドール", reading: "ておどーる", note: "神の贈り物" },
  { name: "ジェラルド", reading: "じぇらるど", note: "槍の支配者" },
];

/**
 * 名前の候補の頼み（名前点検 P-29・プロットモード P-45）への、偽の Ollama の答え。
 * 表記の指示（カタカナ）と系統の指定を、頼みの文から読んで合わせる
 */
export function nameFakeRespond(request: FakeOllamaRequest): string {
  const katakana = request.user.includes("name はカタカナで書いてください");
  const pool = katakana ? KATAKANA_POOL : KANJI_POOL;
  const usable = pool.length - 1;
  const only = /origin と、各候補の origin には「(.+?)」/.exec(request.user)?.[1];
  const origin = only ?? (katakana ? "英語圏" : "和風");
  const ids = [...request.user.matchAll(/id：(\d+)/g)].map((match) => match[1]);
  if (ids.length === 0) {
    // 名前点検（1人に10件）
    const candidates = Array.from({ length: 10 }, (_, k) => pool[k % usable]);
    return JSON.stringify({ origin, candidates: candidates.map((entry) => ({ ...entry, origin })) });
  }
  const people = ids.map((id, index) => {
    const candidates = Array.from({ length: 6 }, (_, k) => pool[(index * 5 + k) % usable]);
    // 1人目の最後は、既にいる人物と同じ名前（コードが落とす）。カタカナの作品ではそのまま
    if (index === 0 && !katakana) candidates[5] = pool[pool.length - 1];
    return { id, candidates: candidates.map((entry) => ({ ...entry, origin })) };
  });
  return JSON.stringify({ origin, people });
}

export async function plotPanelFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("namesHeading") !== null && document.getElementById("headings") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 左の列からプロットモードを開く（plot.md も左に開く） */
export async function openPlotMode(session: E2ESession): Promise<Frame> {
  const { page } = session;
  await showSidebar(page, E2E_WORK_TITLE);
  await expandTreeRow(page, E2E_WORK_TITLE);
  await treeContextMenu(page, E2E_WORK_TITLE, "プロットモード");
  let panel: Frame | undefined;
  await waitUntil(async () => (panel = await plotPanelFrame(page)) !== undefined, "プロットモードのパネルが開く", 30_000);
  return panel as Frame;
}

/**
 * 「名前の候補を出す」を押して、選ぶ画面を順に通り、人物の欄が並ぶまで進める。
 * `onOriginPick` があれば、系統を選ぶ画面が出たところで呼ぶ（写真を撮る機会）
 */
export async function runNameSuggest(
  session: E2ESession,
  plot: Frame,
  options: { originRow?: string; onOriginPick?: () => Promise<void>; onTargetsPick?: () => Promise<void> } = {}
): Promise<void> {
  const { page } = session;
  const before = await plot.locator(".name-person").count();
  await plot.locator("[data-suggest-names]").click();
  let pickedOrigin = false;
  let pickedTargets = false;
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const title = (await quickPickTitle(page)) ?? "";
      if (title.includes("名前の候補を出す人物")) {
        if (!pickedTargets) {
          pickedTargets = true;
          if (options.onTargetsPick) await options.onTargetsPick();
        }
        await acceptQuickPick(page);
      } else if (title.includes("名前の系統")) {
        if (!pickedOrigin) {
          pickedOrigin = true;
          if (options.onOriginPick) await options.onOriginPick();
        }
        await pickQuickPickRow(page, options.originRow ?? "指定なし");
      } else {
        const dialog = await dialogText(page);
        if (dialog) {
          await lookNote(`[plot-names] 出た確認：${dialog.replace(/\s+/g, " ").slice(0, 200)}`);
          await pressDialogButton(page, "続ける").catch(() => pressDialogButton(page, "OK")).catch(() => undefined);
        }
      }
      // 押す前から候補が並んでいたときは、系統を選んだあとの並び直しを待つ
      return pickedOrigin && (await plot.locator(".name-person").count()) > 0 && (before === 0 || (await plot.locator("[data-suggest-names]").isEnabled()));
    },
    "人物ごとの名前の候補が並ぶ",
    60_000
  );
  await page.waitForTimeout(800);
}

/** plot.md を素のエディターで開いて、全文を入れ替えて保存する（作者が書き換えて Ctrl+S するのと同じ） */
export async function rewritePlotAndSave(page: Page, text: string): Promise<void> {
  await quickOpen(page, "plot.md");
  // プロットモードを開くと plot.md も左に開いている。その素のエディターを押して焦点を移す
  const lines = page.locator(".monaco-editor .view-lines", { hasText: "主要登場人物" }).first();
  await waitUntil(async () => (await lines.count()) > 0, "plot.md が開く", 15_000);
  await lines.click();
  await page.keyboard.press("Control+KeyA");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Control+KeyS");
  await page.waitForTimeout(1500);
}

/** 「設定資料更新分反映」を開いて、提案パネルの面を返す */
export async function openUpdates(session: E2ESession): Promise<Frame> {
  const { page } = session;
  await clearNotifications(page);
  await runCommand(page, "設定資料更新分反映");
  let panel: Frame | undefined;
  await waitUntil(async () => (panel = await proposalPanelFrame(page)) !== undefined, "提案パネルが開く", 30_000);
  await page.waitForTimeout(2000);
  return panel as Frame;
}

export async function panelText(frame: Frame): Promise<string> {
  return frame.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 900));
}
