/**
 * 実機確認リストの 〔作者の手：見た目〕 のうち、紹介文・キャッチコピー・更新告知文の確認画面にある
 * 「狙いの読者（○○・○○）に向けて書きました」の一行の写真（狙いを決めている・決めていない作品の両方。2026-10-09 の二段目）。
 *
 * **本物の AI は呼ばない。** 偽の Ollama が決まった文を返す。**文の出来は見えない**。判断は作者がする。
 * `NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, test } from "vitest";
import { fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "../support/fakeOllama";
import { answerInput, runCommand } from "../support/quickInput";
import { withVsCode, type E2ESession } from "../support/vscodeApp";
import { waitUntil } from "../support/wait";
import { clearNotifications, dialogText, editorGroupTabs, pickQuickPickRow, pressDialogButton, quickPickRows, quickPickTitle } from "../support/workbenchDom";
import { lookEnabled, lookNote, shootPage, shootPageKeepingToasts } from "./lookSupport";

const EPISODE = "001_はじまり.txt";
const PLOT = [
  "# 朝の駅の物語",
  "",
  "## ログライン",
  "終電を逃した少女が、朝の駅で不思議な駅員に出会う。",
  "",
  "## あらすじ",
  "少女は駅で一晩を過ごし、駅員から古い切符を渡される。",
  "",
].join("\n");

const SHEET_WITH_AIM = [
  "# ターゲットシート",
  "",
  "このファイルは「ターゲット読者」で作り直されます。",
  "",
  "<!-- 作者の欄 ここから -->",
  "狙い：考察層、没入層",
  "",
  "理由：謎を追いながら世界に入り込んでほしい",
  "<!-- ここまで -->",
  "",
].join("\n");

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama((request) => {
    const user = request.user;
    if (user.includes("告知")) {
      return JSON.stringify({
        xPost: "第1話を更新しました。朝の駅から物語が始まります。",
        activityReport: "活動報告：第1話を公開しました。",
        afterword: "後書き：朝の駅の冷たさを思い出して書きました。",
        spoilerCheck: "結末には触れていません",
        confidence: "high",
      });
    }
    if (user.includes("キャッチコピー")) {
      return JSON.stringify({
        catchphrases: [
          { text: "終電を逃した朝、切符は誰の手にあったのか。", kind: "謎・引き型", intent: "切符の謎で引く" },
          { text: "駅員だけが、私の名前を知っていた。", kind: "感情・関係性型", intent: "関係の不穏さ" },
          { text: "朝の駅は、もうひとつの世界の入口。", kind: "世界観・スケール型", intent: "世界の広がり" },
        ],
        confidence: "high",
      });
    }
    return JSON.stringify({
      blurb: "終電を逃した少女は、朝の駅で不思議な駅員に出会う。渡された古い切符が、少女を知らない世界へ導いていく。",
      spoilerCheck: "結末の展開は伏せています",
      confidence: "high",
    });
  });
});
afterAll(async () => {
  await fake.close();
});

/** 確認の窓・選ぶ画面を順に通して、`done` が真になるまで進める（通した確認の文を残す） */
async function drive(page: Page, label: string, done: () => Promise<boolean>, accept: readonly string[] = ["実行"]): Promise<void> {
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      if (await done()) return true;
      const dialog = await dialogText(page);
      if (dialog && !dialog.includes("ができました")) {
        await lookNote(`[628-${label}] 確認：${dialog.replace(/\s+/g, " ").slice(0, 160)}`);
        for (const name of [...accept, "続ける", "OK"]) {
          if (await pressDialogButton(page, name).then(() => true, () => false)) break;
        }
        return false;
      }
      const title = await quickPickTitle(page);
      if (title !== undefined) {
        const rows = await quickPickRows(page);
        if (rows.some((row) => accept.some((name) => row.label.includes(name)))) await pickQuickPickRow(page, accept.find((name) => rows.some((row) => row.label.includes(name))) as string);
      }
      return false;
    },
    `${label}：画面が出る`,
    90_000
  );
}

async function scenario(session: E2ESession, kind: "aim" | "none"): Promise<void> {
  const { page } = session;
  await clearNotifications(page);

  // 作品紹介文
  await runCommand(page, "作品紹介文");
  await drive(page, `紹介文-${kind}`, async () => ((await dialogText(page)) ?? "").includes("ができました"));
  const blurb = (await dialogText(page)) ?? "";
  await lookNote(`[628] ${kind}：紹介文の確認画面の字：${blurb.replace(/\s+/g, " ").slice(0, 500)}`);
  await shootPage(page, `628-紹介文の確認画面-${kind === "aim" ? "狙いあり" : "狙いなし"}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // キャッチコピー案
  await runCommand(page, "キャッチコピー案");
  await drive(page, `キャッチ-${kind}`, async () => ((await quickPickTitle(page)) ?? "").includes("キャッチコピー") && (await quickPickRows(page)).some((row) => row.label.includes("朝の駅")), ["実行"]);
  await page.waitForTimeout(600);
  const placeholder = await page.locator(".quick-input-widget input").first().getAttribute("placeholder");
  await lookNote(`[628] ${kind}：キャッチコピーの選ぶ画面の案内：${placeholder}`);
  await shootPage(page, `628-キャッチコピーの選ぶ画面-${kind === "aim" ? "狙いあり" : "狙いなし"}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // 更新告知文
  await runCommand(page, "更新SNS告知文作成");
  let seenToast = "";
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const title = (await quickPickTitle(page)) ?? "";
      if (title.includes("ハッシュタグ")) await answerInput(page, "創作 小説").catch(() => undefined);
      else if (title.includes("作品ページのURL")) await answerInput(page, "https://example.com/e2e").catch(() => undefined);
      else if (title.includes("の更新告知")) await pickQuickPickRow(page, EPISODE).catch(() => undefined);
      else {
        const rows = await quickPickRows(page);
        if (rows.some((row) => row.label.includes("更新告知文を作ります"))) await pickQuickPickRow(page, "実行").catch(() => undefined);
      }
      const toasts = await page.locator(".notification-toast").allInnerTexts();
      if (toasts.some((text) => text.includes("更新告知文ができました")) && seenToast === "") {
        seenToast = toasts.map((text) => text.replace(/\s+/g, " ")).join(" ／ ");
        await shootPageKeepingToasts(page, `628-更新告知文の通知-${kind === "aim" ? "狙いあり" : "狙いなし"}`);
      }
      return (await editorGroupTabs(page)).flat().some((name) => name.startsWith("更新告知文"));
    },
    "更新告知文の文書が開く",
    90_000
  );
  await page.waitForTimeout(1200);
  await lookNote(`[628] ${kind}：更新告知文の通知：${seenToast || "（通知は撮れませんでした）"}`);
  await shootPage(page, `628-更新告知文の文書-${kind === "aim" ? "狙いあり" : "狙いなし"}`);
}

describe.skipIf(!lookEnabled)("見た目の写真：紹介文・キャッチコピー・告知文の確認画面", () => {
  for (const kind of ["none", "aim"] as const) {
    test(kind === "aim" ? "狙いの読者を決めている作品" : "狙いの読者を決めていない作品", async () => {
      await withVsCode(
        `見た目の写真：確認画面の読者の一行（${kind}）`,
        [{ name: EPISODE, text: "　朝の駅は静かだった。改札を抜けて、白い息を吐いた。\n" }],
        (session) => scenario(session, kind),
        fakeOllamaLaunch(fake, {
          windowSize: { width: 1280, height: 900 },
          prepareWork: async ({ workFolder }) => {
            await mkdir(path.join(workFolder, "設定"), { recursive: true });
            await writeFile(path.join(workFolder, "設定", "plot.md"), PLOT, "utf8");
            if (kind === "aim") await writeFile(path.join(workFolder, "設定", "ターゲットシート.md"), SHEET_WITH_AIM, "utf8");
          },
        })
      );
    });
  }
});
