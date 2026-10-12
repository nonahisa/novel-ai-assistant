/**
 * 単話プロットと本文の照合（P-28）の、提案パネルでの出方の残り（画面の自動テスト、設計書6.36.3 の 12・6.113。
 * 実機確認リストの 0.89.4・0.88.4 の3項目を、仕分けの束 E15〔2026-10-12-field-triage-unmarked.md〕として 2026-10-13 に移した）。
 *
 *   1. あらすじどおりの単話プロットで、AI が「主筋の改変」を**筋の言い直し**の理由で挙げたら、
 *      提案パネルに札「主筋の改変」が出ず、完了の知らせの捨てた内訳に
 *      「改変の理由が筋の言い直し（逆の結果を言っていない） 1件」が数で出る（0.89.4）
 *   2. 箇条書きの1行を本文と結果が逆になる文にしたとき、札「主筋の改変」が出て、
 *      「箇条書きでは」にその行、注記「場面はありますが、結果や決断が箇条書きと逆になっています」が並び、
 *      ［本文を見る］で本文のその場面へ飛ぶ（0.88.4 の1つ目）
 *   3. 本文に無い出来事を「出来事の欠落」で挙げたとき（引用なし）、注記
 *      「本文には見当たりません（飛び先は話の先頭です）」が出て、［本文を見る］で話の先頭へ飛ぶ（0.88.4 の2つ目）
 *
 * **本物の AI は呼ばない。** 偽の Ollama（`support/fakeOllama.ts`）が件ごとに決まった答えを返す。
 * 見られるのは、答えが返ったあとの配線——コードの検算（`core/episodePlotValidation.ts`）を通って
 * 残ったもの・捨てたものが、パネルと知らせにどう出るか。**AI が本当に言い直しを返すか、逆の結果を
 * 「主筋の改変」で拾えるかは見えない**（`→〔AIの測定〕`。2026-10-10 の MCP の測定が記録にある）。
 *
 * 見本の答えの理由文は、検算の網（打ち消し・対比・「無い」の言い切り・決断の語の対）に
 * 狙いどおり当たるように書いてある。言い回しを変えるときは `validateEpisodePlotContrast` に
 * 当て直して、残る札・捨てる理由が変わらないことを確かめること。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  describeFakeRequests,
  fakeOllamaLaunch,
  passLocalAiGate,
  startFakeOllama,
  type FakeOllama,
} from "./support/fakeOllama";
import { caretPosition, frameLayer, manuscriptFrames } from "./support/manuscriptFrame";
import { describeNotices, waitForNotice } from "./support/noticeRecord";
import { openPlotMode } from "./support/plotNames";
import { proposalPanelFrame } from "./support/sampleFinding";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, editorGroupTabs, pickQuickPickRow, quickPickRows, webviewLayers } from "./support/workbenchDom";

const EPISODE = "第1話_はじまり.txt";
const BODY = [
  "　朝、リナは港の市場へ出かけた。",
  "　市場の入口で、見知らぬ老人から古い地図を渡された。",
  "　老人は宝探しの旅に付き合ってくれと頼んだが、リナはきっぱりと断った。",
  "　リナは地図を懐にしまい、船着き場へ向かった。",
  "",
].join("\n");

/** 単話プロット。展開の箇条書き（3行）だけを件ごとに替える */
function plotWith(items: readonly string[]): string {
  return [
    "# 第1話の単話プロット",
    "",
    "## 視点",
    "リナの三人称",
    "",
    "## この話の目標",
    "リナが市場から船着き場へ向かう",
    "",
    "## 展開（箇条書き）",
    ...items.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

/* ── 件1（0.89.4）：あらすじどおりの箇条書きに、言い直しの「主筋の改変」 ── */
const AS_IS_ITEM = "老人の頼みを断り、船着き場へ向かう";
const PLOT_AS_IS = plotWith(["リナが港の市場へ出かける", "市場で老人から古い地図を受け取る", AS_IS_ITEM]);
/** 半ば誤検出の「箇条書きに無い」（2026-10-10 の 26b の実測と同じ形）。パネルを1件で開かせる役 */
const AS_IS_EXTRA = "宝探しの旅に付き合ってくれと頼んだ";
const ANSWER_AS_IS = JSON.stringify({
  findings: [
    {
      kind: "主筋の改変",
      plotItem: AS_IS_ITEM,
      excerpt: "リナはきっぱりと断った",
      // 箇条書きの筋（老人・船着き場）を言い直しただけで、逆の結果を一言も言っていない
      // （2026-09-25 の e4b の第14話の実物と同じ形。打ち消し・対比・決断の語を含めない）
      reason: "本文では、老人から宝探しの旅に誘われ、リナが船着き場へ向かう流れになっている",
    },
    {
      kind: "箇条書きに無い",
      plotItem: null,
      excerpt: AS_IS_EXTRA,
      reason: "老人が宝探しの旅に誘う細部に当たる行が、箇条書きにありません",
    },
  ],
});

/* ── 件2（0.88.4）：箇条書きの1行を、本文と結果が逆になる文に ── */
const REVERSED_ITEM = "老人の頼みを引き受け、宝探しの旅に出る";
const PLOT_REVERSED = plotWith(["リナが港の市場へ出かける", "市場で老人から古い地図を受け取る", REVERSED_ITEM]);
const REVERSED_EXCERPT = "リナはきっぱりと断った";
const ANSWER_REVERSED = JSON.stringify({
  findings: [
    {
      kind: "主筋の改変",
      plotItem: REVERSED_ITEM,
      excerpt: REVERSED_EXCERPT,
      reason: "箇条書きでは頼みを引き受けるが、本文ではリナが頼みを断っていて、決断が逆になっている",
    },
  ],
});

/* ── 件3（0.88.4）：本文に無い出来事（引用なしの「出来事の欠落」） ── */
const MISSING_ITEM = "灯台の上で、地図の印の意味に気づく";
const PLOT_MISSING = plotWith(["リナが港の市場へ出かける", "市場で老人から古い地図を受け取る", MISSING_ITEM]);
/** 先に3行目へ飛んでおき、欠落の［本文を見る］で先頭へ戻ることを見るための1件 */
const MISSING_EXTRA = "リナはきっぱりと断った";
const ANSWER_MISSING = JSON.stringify({
  findings: [
    {
      kind: "出来事の欠落",
      plotItem: MISSING_ITEM,
      excerpt: null,
      reason: "灯台で地図の印に気づく場面が、本文のどこにも書かれていません",
    },
    {
      kind: "箇条書きに無い",
      plotItem: null,
      excerpt: MISSING_EXTRA,
      reason: "老人の頼みを断る場面に当たる行が、箇条書きにありません",
    },
  ],
});

/** いまの件で偽の AI が返す答え（件の頭で替える） */
let answer = "";
let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => answer);
});
afterAll(async () => {
  await fake.close();
});

/** 起こし方：偽の AI・左の列のキー・単話プロットの見本。plot.md は素のテキストエディターで開く（既存の件と同じ） */
function launchWith(plot: string): LaunchOptions {
  return fakeOllamaLaunch(fake, {
    ...SIDEBAR_LAUNCH,
    settings: {
      ...SIDEBAR_LAUNCH.settings,
      "workbench.editorAssociations": {
        "*.txt": "novelai.manuscriptEditorHorizontal",
        "*.md": "default",
      },
    },
    prepareWork: async ({ workFolder }) => {
      const folder = path.join(workFolder, "設定", "episode-plots");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "第1話.md"), plot, "utf8");
    },
  });
}

/**
 * プロットモードの第1話の行で［本文と照合］を押し、処理量の確認を［実行］で通して、
 * 提案パネルに指摘が `cards` 件並ぶまで待つ。パネルの面を返す
 */
async function runContrast(session: E2ESession, cards: number, requestsFrom: number): Promise<Frame> {
  const { page } = session;
  const plot = await openPlotMode(session);
  const contrast = plot.locator('button.check-plot[data-check="contrast"]').first();
  await waitUntil(async () => (await contrast.count()) > 0, "第1話の行に［本文と照合］が出る（単話プロットがあり、本文もある話）", 30_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（パネルの字：${JSON.stringify((await plot.evaluate(() => document.getElementById("episodes")?.innerText ?? "")).slice(0, 300))}）`);
    }
  );
  await contrast.click();

  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const rows = await quickPickRows(page);
      if (!rows.map((row) => row.label).join(" ").includes("照らし合わせます")) return false;
      await pickQuickPickRow(page, "実行");
      return true;
    },
    "処理量の確認が出て［実行］で進む",
    30_000
  ).catch(async (error: unknown) => {
    const rows = await quickPickRows(page).catch(() => []);
    throw new Error(`${String(error)}（選ぶ画面の行：${JSON.stringify(rows.map((row) => row.label))}／${await describeNotices(session)}）`);
  });

  let proposals: Frame | undefined;
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      proposals = await proposalPanelFrame(page);
      return proposals !== undefined && (await proposals.locator(".issue").count()) >= cards;
    },
    `提案パネルに指摘が${cards}件並ぶ`,
    60_000
  ).catch(async (error: unknown) => {
    const text = proposals ? await proposals.evaluate(() => document.body.innerText) : "（提案パネルが開いていません）";
    throw new Error(
      `${String(error)}（提案パネル：${JSON.stringify(text.slice(0, 400))}／${await describeNotices(session)}／` +
        `偽のAIへの頼み：${describeFakeRequests(fake.requests, requestsFrom)}）`
    );
  });
  if (!proposals) throw new Error("提案パネルが見つかりません");
  return proposals;
}

/** パネルに並んだ指摘（`.issue`）の字を、上から順に。空白は1つに畳んで読む（落ちた文に添える用も兼ねる） */
async function cardTexts(proposals: Frame): Promise<string[]> {
  const cards = proposals.locator(".issue");
  const texts: string[] = [];
  for (let i = 0; i < (await cards.count()); i++) texts.push((await cards.nth(i).innerText()).replace(/\s+/g, " "));
  return texts;
}

/** 失敗の文へ添える、列とタブ・WebView の重なり */
async function layoutDetail(page: Page): Promise<string> {
  return `（列とタブ：${JSON.stringify(await editorGroupTabs(page).catch(() => []))}／WebView の重なり：${JSON.stringify(await webviewLayers(page))}）`;
}

/**
 * `hasText` を含む1件の［本文を見る］を押し、原稿のカーソルが `lineMarker` を含む行へ来るまで待つ。
 * **押す前に提案パネルが前に出ていることを確かめる**（裏に回ったパネルの行を押すと、前の WebView が
 * 押下を受け止めて押し直しになる。findingJumpVertical と同じ理由）
 */
async function jumpAndWaitCaret(page: Page, proposals: Frame, hasText: string, lineMarker: string, label: string): Promise<void> {
  await waitUntil(async () => (await frameLayer(page, proposals).catch(() => undefined))?.inFront === true, `${label}の前に、提案パネルが前に出ている`, 15_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}${await layoutDetail(page)}`);
    }
  );
  await proposals
    .locator(".issue", { hasText })
    .first()
    .locator('button[data-action="jump"]')
    .click({ timeout: 15_000 })
    .catch(async (error: unknown) => {
      throw new Error(`${label}：［本文を見る］を押せません：${String(error).split("\n")[0]}${await layoutDetail(page)}`);
    });
  let seen: string[] = [];
  await waitUntil(
    async () => {
      seen = [];
      for (const frame of await manuscriptFrames(page)) {
        const caret = await caretPosition(frame).catch(() => undefined);
        if (caret) seen.push(caret.lineText);
        if (caret?.lineText.includes(lineMarker)) return true;
      }
      return false;
    },
    label,
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（原稿のカーソルの行：${JSON.stringify(seen)}）${await layoutDetail(page)}`);
  });
}

async function readBody(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

test("あらすじどおりの単話プロットで、筋を言い直しただけの「主筋の改変」は提案パネルに出ず、完了の知らせの捨てた内訳に「改変の理由が筋の言い直し（逆の結果を言っていない） 1件」が出る", async () => {
  answer = ANSWER_AS_IS;
  const from = fake.requests.length;
  await withVsCode(
    "照合の言い直しを捨てる",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      await clearNotifications(session.page);
      const since = Date.now();
      const proposals = await runContrast(session, 1, from);
      expect(fake.requests.length - from, `偽のAIがこの件で1回だけ呼ばれたはずです（${describeFakeRequests(fake.requests, from)}）`).toBe(1);

      /* ── 完了の知らせ：残った1件と、捨てた1件の内訳 ── */
      const notice = await waitForNotice(
        session,
        (message) => message.includes("本文と単話プロットの照合が完了しました"),
        "照合の完了の知らせが出る",
        { since }
      );
      expect(notice, "完了の知らせに、残った指摘の数が出ていません").toContain("指摘 1件");
      expect(notice, "完了の知らせの捨てた内訳に、言い直しの数が出ていません").toContain(
        "捨てた 1件（改変の理由が筋の言い直し（逆の結果を言っていない） 1件）"
      );

      /* ── パネル：「単話プロットと本文」に1件だけ。札「主筋の改変」は無い ── */
      expect(await proposals.evaluate(() => document.body.innerText), "分類名が「単話プロットと本文」ではありません").toContain("単話プロットと本文");
      const cards = await cardTexts(proposals);
      expect(cards, `指摘は1件のはずです：${JSON.stringify(cards)}`).toHaveLength(1);
      expect(cards[0]).toContain("箇条書きに無い");
      expect(cards[0]).toContain(AS_IS_EXTRA);
      const badges = await proposals.locator(".issue .badge.cat").allInnerTexts();
      expect(badges, "捨てたはずの「主筋の改変」が札として出ています").not.toContain("主筋の改変");

      // 照合は本文を書き換えない
      expect(await readBody(session)).toBe(BODY);
    },
    launchWith(PLOT_AS_IS)
  );
});

test("箇条書きの1行を本文と結果が逆の文にして照合すると、札「主筋の改変」が出て、「箇条書きでは」にその行と注記「場面はありますが、結果や決断が箇条書きと逆になっています」が並び、［本文を見る］でその場面の行へ飛ぶ", async () => {
  answer = ANSWER_REVERSED;
  const from = fake.requests.length;
  await withVsCode(
    "照合の主筋の改変",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      await clearNotifications(page);
      const since = Date.now();
      const proposals = await runContrast(session, 1, from);
      expect(fake.requests.length - from, `偽のAIがこの件で1回だけ呼ばれたはずです（${describeFakeRequests(fake.requests, from)}）`).toBe(1);

      const card = proposals.locator(".issue").first();
      expect(await card.locator(".badge.cat").innerText()).toBe("主筋の改変");
      // 見出しの引用と場所は、本文の場面（3行目）
      expect(await card.locator(".quote").innerText()).toBe(REVERSED_EXCERPT);
      expect(await card.locator(".location").innerText()).toContain("3行目");
      // 「箇条書きでは」にその行、「この話では」に理由
      const sides = (await card.locator(".compare > div").allInnerTexts()).map((text) => text.replace(/\s+/g, " "));
      expect(sides.some((text) => text.startsWith("箇条書きでは") && text.includes(REVERSED_ITEM)), `「箇条書きでは」の行がありません：${JSON.stringify(sides)}`).toBe(true);
      expect(sides.some((text) => text.startsWith("この話では")), `「この話では」の行がありません：${JSON.stringify(sides)}`).toBe(true);
      expect((await card.innerText()).replace(/\s+/g, " "), "注記が出ていません").toContain("場面はありますが、結果や決断が箇条書きと逆になっています");
      expect(await card.locator('button[data-action="jump"]').innerText()).toBe("本文を見る");

      // 完了の知らせは指摘1件、捨てたものは無い
      const notice = await waitForNotice(
        session,
        (message) => message.includes("本文と単話プロットの照合が完了しました"),
        "照合の完了の知らせが出る",
        { since }
      );
      expect(notice).toContain("指摘 1件");
      expect(notice, "捨てたものが無いのに、捨てた内訳が出ています").not.toContain("捨てた");

      /* ── ［本文を見る］で、引用のある3行目へ ── */
      await jumpAndWaitCaret(page, proposals, REVERSED_ITEM, REVERSED_EXCERPT, "［本文を見る］で、逆になった場面の行（3行目）へ原稿のカーソルが来る");
      expect(await readBody(session)).toBe(BODY);
    },
    launchWith(PLOT_REVERSED)
  );
});

test("本文に無い出来事の「出来事の欠落」（引用なし）は、注記「本文には見当たりません（飛び先は話の先頭です）」が出て、［本文を見る］で話の先頭（1行目）へ飛ぶ", async () => {
  answer = ANSWER_MISSING;
  const from = fake.requests.length;
  await withVsCode(
    "照合の出来事の欠落",
    [{ name: EPISODE, text: BODY }],
    async (session) => {
      const { page } = session;
      const proposals = await runContrast(session, 2, from);
      expect(fake.requests.length - from, `偽のAIがこの件で1回だけ呼ばれたはずです（${describeFakeRequests(fake.requests, from)}）`).toBe(1);

      const missing = proposals.locator(".issue", { hasText: MISSING_ITEM }).first();
      expect(await missing.count(), `欠落の1件がありません：${JSON.stringify(await cardTexts(proposals))}`).toBe(1);
      expect(await missing.locator(".badge.cat").innerText()).toBe("出来事の欠落");
      // 本文を指していないので、見出しは箇条書きの行、場所は話の先頭
      expect(await missing.locator(".quote").innerText()).toBe(MISSING_ITEM);
      expect(await missing.locator(".location").innerText()).toContain("1行目");
      expect((await missing.innerText()).replace(/\s+/g, " "), "注記が出ていません").toContain("本文には見当たりません（飛び先は話の先頭です）");

      /*
        ── 先にもう1件で3行目へ飛び、欠落の［本文を見る］で1行目へ戻ることを見る ──
        開いた直後の原稿はもともと1行目にカーソルがあるので、いきなり欠落を押しても
        「先頭へ飛んだ」のか「何も起きなかった」のかを分けられない
      */
      await jumpAndWaitCaret(page, proposals, MISSING_EXTRA, MISSING_EXTRA, "［本文を見る］で、引用のある行（3行目）へ原稿のカーソルが来る");
      await jumpAndWaitCaret(page, proposals, MISSING_ITEM, "朝、リナは港の市場へ出かけた", "欠落の［本文を見る］で、話の先頭（1行目）へ原稿のカーソルが戻る");
      expect(await readBody(session)).toBe(BODY);
    },
    launchWith(PLOT_MISSING)
  );
});
