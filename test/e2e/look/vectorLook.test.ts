/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、ベクトル検索を使う2つの画面の写真——
 * 「類似場面検出」（別の話どうしの似た場面）と、「再開用資料」の「この話に関係しそうな前の場面」
 * （2026-10-09 の二段目。作者が見た目の良し悪しを判断するための写真。判断そのものはしない）。
 *
 * **本物の AI も本物の埋め込みも使わない。** 偽の Ollama が、決まった語の出方だけで作った見本のベクトルを返す。
 * 近さの出来（本当に似た場面が上に来るか）は見えない。見られるのは画面の並び・文言・押したときの開き方。
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "../support/fakeOllama";
import { manuscriptFrames } from "../support/manuscriptFrame";
import { runCommand } from "../support/quickInput";
import { withVsCode, type E2ESession } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dialogText, editorGroupTabs, pickQuickPickRow, pressDialogButton, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { lookEnabled, lookNote, shootPage, shootPageKeepingToasts } from "./lookSupport";

const STATION = (extra: string) =>
  [
    "　雨の降る駅の改札で、少女は駅員から古い切符を受け取った。",
    "　切符には、見たことのない駅の名前が書かれていた。駅員は何も言わずに帽子を直した。",
    `　${extra}`,
    "　切符を握りしめたまま、少女は雨の中のホームへ歩いた。駅員の背中が遠くなった。",
    "",
  ].join("\n");

const EPISODES = [
  { name: "第1話_切符.txt", text: STATION("雨は夜まで降り続け、駅の灯りだけが濡れた線路を照らしていた。") },
  { name: "第2話_港.txt", text: ["　朝の港では、漁師たちが船を出す支度をしていた。", "　海は凪いで、灯台の光が薄れていく。船の甲板で、少年は網を繕った。", "　漁師の一人が、遠い海の向こうを指さした。", ""].join("\n") },
  { name: "第3話_駅の夜.txt", text: STATION("駅員は、少女の切符を見て小さくうなずいた。ここで降りる客は珍しいのだ。") },
  { name: "第4話_続き.txt", text: "　翌朝、少女は同じ駅の改札に立っていた。\n" },
];

const EPISODE_PLOT_FILLED = [
  "# 第4話の単話プロット",
  "",
  "## 視点",
  "少女の三人称",
  "",
  "## この話の目標",
  "少女が駅員から受け取った切符の意味を知る",
  "",
  "## 展開（箇条書き）",
  "- 少女が駅の改札で切符を確かめる",
  "- 駅員が切符の古い秘密を話す",
  "- 雨の中、少女はホームへ向かう",
  "",
].join("\n");

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => "{}");
});
afterAll(async () => {
  await fake.close();
});

async function newestGenerated(session: E2ESession, prefix: string): Promise<string> {
  const folder = path.join(session.workFolder, ".aiwriter", "generated");
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.startsWith(prefix)).sort();
  return names.length > 0 ? await readFile(path.join(folder, names[names.length - 1]), "utf8") : "";
}

/** 出た確認の窓・選ぶ画面を通して、`done` が真になるまで進める */
async function drive(page: Page, done: () => Promise<boolean>, accept: readonly string[] = ["実行", "作る", "続ける"]): Promise<void> {
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      if (await done()) return true;
      const dialog = await dialogText(page);
      if (dialog) {
        for (const name of accept) if (await pressDialogButton(page, name).then(() => true, () => false)) break;
        return false;
      }
      if ((await quickPickTitle(page)) !== undefined) {
        const rows = await quickPickRows(page);
        const target = accept.find((name) => rows.some((row) => row.label.includes(name)));
        if (target) await pickQuickPickRow(page, target).catch(() => undefined);
      }
      return false;
    },
    "画面が出る",
    90_000
  );
}

/** 生成した資料（原稿エディターの面で開く）の中で、`needle` を含む行を窓の上へ転がす */
async function scrollSheetTo(page: Page, needle: string): Promise<void> {
  for (const frame of await manuscriptFrames(page)) {
    const found = await frame
      .evaluate((text) => {
        const compose = document.getElementById("compose");
        if (!compose || !(compose.innerText ?? "").includes(text)) return false;
        const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node.textContent ?? "").includes(text)) {
            const target = node.parentElement as HTMLElement;
            const chain: string[] = [];
            for (let box: HTMLElement | null = target; box; box = box.parentElement) {
              chain.push(`${box.tagName}#${box.id}.${box.className}:${box.scrollTop}/${box.scrollHeight}/${box.clientHeight}:${getComputedStyle(box).overflowY}`);
            }
            (window as unknown as { __scrollChain: string[] }).__scrollChain = chain;
            // 画面の中で転がせる祖先（枠）を探して、その枠を動かす
            for (let box: HTMLElement | null = target.parentElement; box; box = box.parentElement) {
              const style = getComputedStyle(box);
              if (box.scrollHeight > box.clientHeight + 4 && /(auto|scroll)/.test(style.overflowY)) {
                box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - 10;
                break;
              }
            }
            return true;
          }
        }
        return false;
      }, needle)
      .catch(() => false);
    await lookNote(`[scroll] ${needle}：${found}：${found ? JSON.stringify(await frame.evaluate(() => (window as unknown as { __scrollChain?: string[] }).__scrollChain)) : ""}`);
  }
  await page.waitForTimeout(500);
}

function launch(withPlot: boolean) {
  return fakeOllamaLaunch(fake, {
    windowSize: { width: 1280, height: 900 },
    settings: { "novelai.vectorSearch.enabled": true },
    prepareWork: async ({ workFolder }) => {
      if (!withPlot) return;
      const folder = path.join(workFolder, "設定", "episode-plots");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "第4話.md"), EPISODE_PLOT_FILLED, "utf8");
    },
  });
}

describe.skipIf(!lookEnabled)("見た目の写真：ベクトル検索を使う画面", () => {
  test("索引が無いとき・作ったあと：類似場面検出と再開用資料", async () => {
    await withVsCode(
      "見た目の写真：類似場面検出と執筆再開",
      EPISODES,
      async (session) => {
        const { page } = session;
        await clearNotifications(page);

        // ── 索引がまだ無いとき ──
        await runCommand(page, "類似場面検出（別の話どうしの似た場面）");
        await page.waitForTimeout(2500);
        const toasts0 = await page.locator(".notification-toast").allInnerTexts();
        const dialog0 = await dialogText(page);
        await lookNote(`[678] 索引が無いとき：知らせ ${toasts0.map((text) => text.replace(/\s+/g, " ")).join(" ／ ")}／窓 ${dialog0?.replace(/\s+/g, " ") ?? "（なし）"}`);
        await shootPageKeepingToasts(page, "678-類似場面検出-索引が無いとき");
        if (dialog0) await pressDialogButton(page, "閉じる").catch(() => page.keyboard.press("Escape"));
        await clearNotifications(page);

        await runCommand(page, "再開用資料");
        await drive(page, async () => (await editorGroupTabs(page)).flat().some((name) => name.startsWith("執筆再開")), ["最新話", "実行", "続ける"]);
        await page.waitForTimeout(1500);
        const sheet0 = await newestGenerated(session, "執筆再開");
        await lookNote(`[680] 索引が無いとき（単話プロットは中身あり）：「前の場面」の節 ${sheet0.split("\n").filter((line) => line.includes("前の場面") || line.includes("索引") || line.includes("ベクトル")).join(" ／ ") || "（無し）"}`);
        await scrollSheetTo(page, "この話に関係しそうな前の場面");
        await shootPage(page, "680-執筆再開用資料-索引が無いとき");

        // ── 索引を作る ──
        await clearNotifications(page);
        await runCommand(page, "検索索引作成／更新");
        await waitUntil(
          async () => {
            await passLocalAiGate(page);
            const toasts = await page.locator(".notification-toast").allInnerTexts();
            return toasts.some((text) => /索引|作りました|追いつ/.test(text)) || (await dialogText(page)) !== undefined;
          },
          "索引づくりの結果が出る",
          90_000
        );
        await page.waitForTimeout(1500);
        const toasts1 = await page.locator(".notification-toast").allInnerTexts();
        await lookNote(`[678] 索引づくり：${toasts1.map((text) => text.replace(/\s+/g, " ")).join(" ／ ").slice(0, 400)}`);
        await clearNotifications(page);

        // ── 類似場面検出 ──
        await runCommand(page, "類似場面検出（別の話どうしの似た場面）");
        await drive(page, async () => {
          const rows = await quickPickRows(page);
          return rows.length > 0 && rows.some((row) => row.label.includes("第"));
        });
        await page.waitForTimeout(800);
        const rows = await quickPickRows(page);
        await lookNote(`[678] 類似場面の選ぶ画面（${await quickPickTitle(page)}）：${rows.map((row) => `${row.label}〔${row.description}〕`).join(" / ").slice(0, 700)}`);
        await shootPage(page, "678-類似場面検出-組の一覧");
        const first = rows.find((row) => row.label.includes("第"));
        if (first) {
          await pickQuickPickRow(page, first.label);
          await page.waitForTimeout(3000);
          const tabs = (await editorGroupTabs(page)).map((group) => group.join("｜")).join(" ／ ");
          await lookNote(`[678] 組を選んだあとのタブ：${tabs}`);
          await shootPage(page, "678-類似場面検出-選んだあと2つが並ぶ");
        }

        // ── 再開用資料（索引あり） ──
        await clearNotifications(page);
        await runCommand(page, "再開用資料");
        await drive(page, async () => (await newestGenerated(session, "執筆再開")) !== sheet0 && (await newestGenerated(session, "執筆再開")) !== "", ["最新話", "実行", "続ける"]);
        await page.waitForTimeout(2000);
        const sheet1 = await newestGenerated(session, "執筆再開");
        const at = sheet1.indexOf("この話に関係しそうな前の場面");
        await lookNote(`[680] 索引ありのとき：「前の場面」の節 ${at >= 0 ? sheet1.slice(at, at + 420).replace(/\s+/g, " ") : "（無し）"}`);
        await scrollSheetTo(page, "この話に関係しそうな前の場面");
        await shootPage(page, "680-執筆再開用資料-索引あり");
      },
      launch(true)
    );
  });

  test("単話プロットが無い・雛形のままのときは「前の場面」の節が出ない", async () => {
    await withVsCode(
      "見た目の写真：執筆再開（単話プロットなし・雛形）",
      EPISODES,
      async (session) => {
        const { page } = session;
        await clearNotifications(page);
        // 単話プロットが無い
        await runCommand(page, "再開用資料");
        await drive(page, async () => (await editorGroupTabs(page)).flat().some((name) => name.startsWith("執筆再開")), ["最新話", "実行", "続ける"]);
        await page.waitForTimeout(1500);
        const none = await newestGenerated(session, "執筆再開");
        await lookNote(`[680] 単話プロットが無いとき：「前の場面」の節 ${none.includes("前の場面") ? "あり" : "なし"}`);
        await shootPage(page, "680-執筆再開用資料-単話プロットなし");

        // 雛形のままの単話プロットを作る
        await clearNotifications(page);
        await runCommand(page, "単話プロット作成");
        await drive(page, async () => (await editorGroupTabs(page)).flat().some((name) => /^第\d+話\.md$/.test(name)), ["最新話", "第4話", "第"]);
        await page.waitForTimeout(1500);
        await clearNotifications(page);
        await runCommand(page, "再開用資料");
        await page.waitForTimeout(500);
        await drive(page, async () => (await newestGenerated(session, "執筆再開")).length > 0 && (await editorGroupTabs(page)).flat().filter((name) => name.startsWith("執筆再開")).length >= 1, ["最新話", "実行", "続ける"]);
        await page.waitForTimeout(2000);
        const template = await newestGenerated(session, "執筆再開");
        await lookNote(`[680] 雛形のままのとき：「前の場面」の節 ${template.includes("前の場面") ? "あり" : "なし"}`);
        await shootPage(page, "680-執筆再開用資料-雛形のまま");
      },
      launch(false)
    );
  });
});
