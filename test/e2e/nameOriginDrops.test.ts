/**
 * 名前の候補の系統と前段（画面の自動テスト、設計書6.37.2・6.4.8・6.113。仕分け 2026-10-12 の束 E16 として、
 * 実機確認リスト 458・579・6103 行を移した。2026-10-13）。
 *
 * 1. 458：カタカナの作品で名前点検から系統「ドイツ」を選んで候補を出し、札は「ドイツ」なのに中身がフランス・
 *    英語の名前（ギヨーム・エリオット）が混ざったとき、落とした候補の欄に「系統（ドイツ）の名前に見えません
 *    （ギヨームはフランスでよく使う名前です）」の形で並び、通知の「2件は系統・表記が揃わないため」と
 *    作品のログの終了の行（`fitted.dropped.length`）に数えられるか
 * 2. 6103：「指定なし（作品に合わせる）」で、AI がドイツと見立てた答えに札の違う候補（フランス）が1件・
 *    英字の名前が1件混ざったとき、札の違う1件が「落としました：… — 系統が揃っていません（…）」で出て、
 *    英字の名前は読みからカタカナに直り（残った候補に英字が無い）、通知が件数と直したことを言うか
 * 3. 579：プロットモードの［名前の候補を出す］で、役名だけの人物が全員選ばれた状態で並び（迷ったものに
 *    「役名か迷いました」）、外した人物には候補が出ず、続く系統の選ぶ画面の先頭が「指定なし（作品に合わせる）」か
 *
 * **古い前提の置き換え**：458・6103 は「出なければ確かめようがない」とされていた（実機の e4b・26b では
 * 系統の揃わない候補がめったに出ない）。ここでは偽の Ollama に、揃わない候補をわざと混ぜて返させる。
 * 混ぜた答え（`support/nameOrigin.ts`）は、作るときに本物の検算（`parseNameSuggestAnswer` →
 * `planNameOrigin` → `fitNameCandidates` → `screenNameCandidates`）へ通して、狙いどおり落ちる・残ることを
 * 確かめてある。**AI の出来（実機で混ざるかどうか）は見えない**——それは AI の測定の側。
 *
 * 名前点検は、作者が系統を選ぶと作品の設定に系統を覚える（`rememberOrigin`）。覚えた系統は次の「指定なし」の
 * 決め方を変えるので、458 と 6103 は**別の作品（別の起動）で**押す。
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeFakeRequests, fakeOllamaLaunch, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { actionLogLines, openNameCheck, suggestNamesFor } from "./support/nameCheckPanel";
import {
  GERMAN_TAGGED_ANSWER,
  GERMAN_TAGGED_DROPS,
  KATAKANA_EPISODE,
  KATAKANA_PEOPLE,
  MIXED_AUTO_ANSWER,
  MIXED_AUTO_CONVERTED,
  MIXED_AUTO_DROP,
  RENAME_TARGET,
  UNSURE_ROLE_PLOT,
} from "./support/nameOrigin";
import { describeNotices, waitForNotice } from "./support/noticeRecord";
import { EXISTING_PERSON, isPlotNamesRequest, openPlotMode, plotNamesAnswer, preparePlotWork, startNameSuggest, waitNameResults } from "./support/plotNames";
import { defaultCharactersFolder, writeCharactersTo } from "./support/settingsFixture";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { toggleQuickPickRow, type QuickPickRow } from "./support/workbenchDom";

/** 名前点検の頼み（プロットの名前の候補でないもの）への答え。件の頭で差し替える */
let nameCheckAnswer = "{}";

let fake: FakeOllama;
beforeAll(async () => {
  /*
    答えは頼みの文の系統で振り分けず、件ごとに決めた変数で返す。頼みの文の系統は、作品が覚えた系統や
    世界観で変わる——そこに頼ると、狙いと別の答えが返っても気づけない
  */
  fake = await startFakeOllama((request) => {
    if (isPlotNamesRequest(request)) return plotNamesAnswer(request);
    if (request.user.includes("名前の候補")) return nameCheckAnswer;
    return "{}";
  });
});
afterAll(async () => {
  await fake.close();
});

function launch(extra: LaunchOptions = {}): LaunchOptions {
  return fakeOllamaLaunch(fake, {
    ...SIDEBAR_LAUNCH,
    ...extra,
    settings: {
      ...SIDEBAR_LAUNCH.settings,
      // plot.md は作者の既定どおり素のテキストエディターで開く（6.4.8）
      "workbench.editorAssociations": { "*.txt": "novelai.manuscriptEditorHorizontal", "*.md": "default" },
      ...extra.settings,
    },
    keybindings: [...SIDEBAR_LAUNCH.keybindings, ...(extra.keybindings ?? [])],
  });
}

/**
 * カタカナの作品（人物3人。plot.md は置かない——世界観の一言で系統の決め方が変わるため）。
 * 付け直すのは「リナ」。残る2人（ボリス・アリシア）がカタカナなので、「指定なし」はカタカナの系統になる
 */
const katakanaWork: LaunchOptions = {
  prepareWork: async ({ workFolder }) => {
    await writeCharactersTo(defaultCharactersFolder(workFolder), KATAKANA_PEOPLE);
  },
};

/** 作品のログの「名前の候補を終了」の行が出るまで待って返す（落ちたらログの終わりを添える） */
async function waitEndLogLine(session: E2ESession): Promise<{ end: string; lines: string[] }> {
  let lines: string[] = [];
  await waitUntil(
    async () => (lines = await actionLogLines(session)).some((line) => line.includes("名前の候補を終了:")),
    "作品のログに「名前の候補を終了」の行が書かれる",
    15_000
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}（ログの終わり：\n${lines.slice(-12).join("\n")}）`);
  });
  return { end: lines.filter((line) => line.includes("名前の候補を終了:")).pop() ?? "", lines };
}

/** 落ちたときに添える：その人物の候補の欄・知らせ・偽の AI への頼み */
async function describeNameCheck(session: E2ESession, boxText: string, since: number, sentBefore: number): Promise<string> {
  return `（候補の欄：${JSON.stringify(boxText.replace(/\s+/g, " ").slice(0, 500))}／${await describeNotices(session, since - 1_000)}／${describeFakeRequests(fake.requests, sentBefore)}）`;
}

/* ── 1. 458：系統「ドイツ」の札で、中身がフランス・英語の名前 ── */

test("カタカナの作品で名前点検から系統「ドイツ」を選ぶと、ドイツの札のギヨーム・エリオットが落とした候補に理由つきで並び、通知と作品のログが「系統・表記が揃わないため 2件」と数える", async () => {
  nameCheckAnswer = GERMAN_TAGGED_ANSWER;
  await withVsCode(
    "名前点検・ドイツの札の混ざり",
    [KATAKANA_EPISODE],
    async (session) => {
      const frame = await openNameCheck(session, KATAKANA_PEOPLE.length);
      // 偽の AI はファイルの中の件で共有なので、この件で増えた分だけを見る
      const sentBefore = fake.requests.length;
      const since = Date.now();
      await suggestNamesFor(session, frame, RENAME_TARGET.id, "ドイツ", () => fake.requests.length > sentBefore);
      const box = frame.locator(`#candidates-${RENAME_TARGET.id}`);
      const context = async (): Promise<string> => describeNameCheck(session, await box.innerText().catch(() => ""), since, sentBefore);

      // 頼みは1回だけで、作者が選んだ「ドイツ」1つで出すよう頼んでいる
      expect(fake.requests.length - sentBefore, `この件の頼みが1回ではありません${await context()}`).toBe(1);
      expect(fake.requests[sentBefore].user, `頼みの文が系統「ドイツ」で出させていません${await context()}`).toContain("各候補の origin には「ドイツ」");

      /* ── ファイル：作品のログの終了の行が、系統で落とした数を数えている ── */
      const { end } = await waitEndLogLine(session);
      expect(end, "終了の行が、系統・表記で落とした2件と残った4件を数えていません").toContain("候補 4件 / 系統・表記が揃わず落とした 2件 / 響きが重なって落とした 0件");

      /* ── 通知：何件を何で落としたかと、揃えた系統 ── */
      const notice = await waitForNotice(session, (message) => message.includes("系統・表記が揃わない"), "「系統・表記が揃わないため」の通知が出る", { since });
      expect(notice, `通知の文が違います${await context()}`).toContain(
        "候補 6件のうち、2件は系統・表記が揃わないため落としました（理由は画面に出ています）。系統：ドイツ（作者が選んだ系統）。"
      );

      /* ── 画面：落とした候補の欄に理由つきで並び、残った4件はドイツの名前 ── */
      expect((await box.locator(".dropped").allInnerTexts()).map((text) => text.trim()), `落とした候補の欄が違います${await context()}`).toEqual(
        GERMAN_TAGGED_DROPS.map((drop) => `落としました：${drop.name} — ${drop.reason}`)
      );
      expect(await box.locator(".candidate .meta b").allInnerTexts(), `残った候補が違います${await context()}`).toEqual(["ゲルトルート", "ラインハルト", "エルンスト", "ヘルムート"]);
      expect((await box.locator(".origin-note").innerText()).trim()).toBe("系統：ドイツ（作者が選んだ系統）");
    },
    launch(katakanaWork)
  );
});

/* ── 2. 6103：「指定なし」で、札の違う候補と英字の名前が混ざる ── */

test("名前点検で「指定なし（作品に合わせる）」を選ぶと、札の違うベルナデットが「系統が揃っていません」で落とした候補に出て、英字の Konrad はコンラートに直って英字が残らず、通知が落とした件数と直したことを言う", async () => {
  nameCheckAnswer = MIXED_AUTO_ANSWER;
  await withVsCode(
    "名前点検・指定なしの混ざり",
    [KATAKANA_EPISODE],
    async (session) => {
      const frame = await openNameCheck(session, KATAKANA_PEOPLE.length);
      const sentBefore = fake.requests.length;
      const since = Date.now();
      await suggestNamesFor(session, frame, RENAME_TARGET.id, "指定なし（作品に合わせる）", () => fake.requests.length > sentBefore);
      const box = frame.locator(`#candidates-${RENAME_TARGET.id}`);
      const context = async (): Promise<string> => describeNameCheck(session, await box.innerText().catch(() => ""), since, sentBefore);

      // 「指定なし」は系統を1つに縛らず、作品の人物名（カタカナ）から選ばせる頼みになる
      expect(fake.requests.length - sentBefore, `この件の頼みが1回ではありません${await context()}`).toBe(1);
      const user = fake.requests[sentBefore].user;
      expect(user, `頼みの文が「指定なし」の形ではありません${await context()}`).toContain("【系統】\n指定なし（既にある人物名がカタカナ中心");
      expect(user, `頼みの文が系統を1つに決め打ちしています${await context()}`).not.toContain("各候補の origin には「");

      /* ── ファイル：作品のログに、系統で落とした1件と、英字を直したこと ── */
      const { end, lines } = await waitEndLogLine(session);
      expect(end, "終了の行が、系統・表記で落とした1件と残った4件を数えていません").toContain("候補 4件 / 系統・表記が揃わず落とした 1件 / 響きが重なって落とした 0件");
      expect(
        lines.some((line) => line.includes(`名前の候補：英字の名前を読みからカタカナに直しました（${MIXED_AUTO_CONVERTED.from}→${MIXED_AUTO_CONVERTED.to}）`)),
        `英字を直した行がログにありません（ログの終わり：\n${lines.slice(-12).join("\n")}）`
      ).toBe(true);

      /* ── 通知：件数・揃えた系統と根拠・英字を直したこと ── */
      const notice = await waitForNotice(session, (message) => message.includes("系統・表記が揃わない"), "「系統・表記が揃わないため」の通知が出る", { since });
      expect(notice, `通知の文が違います${await context()}`).toContain(
        "候補 5件のうち、1件は系統・表記が揃わないため落としました（理由は画面に出ています）。" +
          "系統：ドイツ（既にある人物名がカタカナ中心（カタカナ2・漢字0））。" +
          "英字で返った1件は、読みからカタカナに直しました。"
      );

      /* ── 画面：落とした候補の欄・残った候補に英字が無い・揃えた系統の一文 ── */
      expect((await box.locator(".dropped").allInnerTexts()).map((text) => text.trim()), `落とした候補の欄が違います${await context()}`).toEqual([
        `落としました：${MIXED_AUTO_DROP.name} — ${MIXED_AUTO_DROP.reason}`,
      ]);
      const kept = await box.locator(".candidate .meta b").allInnerTexts();
      expect(kept, `残った候補が違います${await context()}`).toEqual(["ゲルトルート", "ラインハルト", "エルンスト", MIXED_AUTO_CONVERTED.to]);
      expect(kept.filter((name) => /[A-Za-z]/.test(name)), "残った候補に英字の名前があります").toEqual([]);
      expect((await box.locator(".origin-note").innerText()).trim()).toBe("系統：ドイツ（既にある人物名がカタカナ中心（カタカナ2・漢字0））");
    },
    launch(katakanaWork)
  );
});

/* ── 3. 579：プロットモードの人物の選ぶ画面と系統の選ぶ画面 ── */

test("プロットモードの［名前の候補を出す］で、役名だけの人物が全員選ばれて並び（男Aに「役名か迷いました」）、外したヒロインには候補が出ず、系統の選ぶ画面の先頭が「指定なし（作品に合わせる）」", async () => {
  await withVsCode(
    "プロットモード・名前の候補の前段",
    [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
    async (session) => {
      const { page } = session;
      const plot = await openPlotMode(session);
      const sentBefore = fake.requests.length;
      let targetRows: QuickPickRow[] = [];
      let originTitle = "";
      let originRows: QuickPickRow[] = [];
      await startNameSuggest(session, plot, () => fake.requests.slice(sentBefore).some(isPlotNamesRequest), "指定なし", {
        onTargets: async (rows) => {
          targetRows = rows;
          // ヒロインだけ外して［OK］へ進む
          await toggleQuickPickRow(page, "ヒロイン");
        },
        onOrigin: async (title, rows) => {
          originTitle = title;
          originRows = rows;
        },
      });
      const shown = JSON.stringify(targetRows);

      /* ── 人物の選ぶ画面：役名だけの3人が全員選ばれて並び、迷ったものに「役名か迷いました」 ── */
      expect(targetRows.map((row) => row.label), `人物の選ぶ画面の並びが違います：${shown}`).toEqual(["主人公", "ヒロイン", "男A"]);
      expect(targetRows.every((row) => row.checked === true), `全員が選ばれた状態で並んでいません：${shown}`).toBe(true);
      expect(targetRows.find((row) => row.label === "男A")?.description ?? "", `男Aに「役名か迷いました」がありません：${shown}`).toContain("役名か迷いました");
      for (const role of ["主人公", "ヒロイン"]) {
        expect(targetRows.find((row) => row.label === role)?.description ?? "", `役名と言い切れる${role}に「迷いました」が付いています：${shown}`).not.toContain("迷いました");
      }

      /* ── 系統の選ぶ画面：外した人を数えず、先頭が「指定なし（作品に合わせる）」 ── */
      expect(originTitle, `系統の選ぶ画面の題が、外したあとの2人を数えていません`).toContain("2人に");
      expect(originRows[0]?.label ?? "", `系統の選ぶ画面の先頭が「指定なし」ではありません：${JSON.stringify(originRows)}`).toContain("指定なし（作品に合わせる）");

      /* ── AI へは、外した人物を送らない ── */
      const request = fake.requests.slice(sentBefore).find(isPlotNamesRequest);
      const roles = [...(request?.user ?? "").matchAll(/役名：(.+)/g)].map((match) => match[1].trim());
      expect(roles, `AI へ送った人物が違います（${describeFakeRequests(fake.requests, sentBefore)}）`).toEqual(["主人公", "男A"]);

      /* ── パネル：候補の欄は選んだ2人だけ。男Aの欄に「役名か迷いました（理由）」 ── */
      await waitNameResults(plot, page);
      const people = plot.locator(".name-person");
      const results = (await plot.locator("#nameResults").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 500);
      expect(await people.locator(".role").allInnerTexts(), `候補の欄の人物が違います：${results}`).toEqual(["主人公", "男A"]);
      const unsure = await plot.locator(".name-person", { hasText: "男A" }).first().locator(".unsure").allInnerTexts();
      expect(unsure.join(" "), `男Aの欄に「役名か迷いました」が出ていません：${results}`).toContain("役名か迷いました（英字・数字で終わる呼び方です");
      for (const index of [0, 1]) {
        expect(await people.nth(index).locator('input[type="radio"]').count(), `候補が並んでいない人物があります：${results}`).toBeGreaterThan(1);
      }
    },
    launch({ prepareWork: async ({ workFolder }) => preparePlotWork(workFolder, [EXISTING_PERSON], UNSURE_ROLE_PLOT) })
  );
});
