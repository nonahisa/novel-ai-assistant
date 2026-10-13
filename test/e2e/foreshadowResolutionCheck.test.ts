/**
 * 「伏線回収確認」で回収の候補が提案パネルの「伏線の回収」に並び、［回収済みにする］で台帳と一覧が変わる
 * （画面の自動テスト、設計書6.35.3・6.35.5・6.113。実機確認リスト F-30 の 6290 行
 * 「「伏線の回収を確かめる」で、回収候補が「伏線の回収」に並ぶか。「回収済みにする」で台帳が更新され、
 * 一覧で回収済みへ移るか」を、仕分け 2026-10-12（未印の分）の束 E19 として移した。2026-10-13）。
 *
 * 何を見張るか：
 * - 未回収2件（第1話で張った「銀の懐中時計」「北の灯台」）の台帳で「伏線回収確認」を押し、処理量の確認で
 *   ［実行］を選ぶと、完了の知らせが「未回収 2件のうち、回収されたと読める 1件 / 本文と合わない 1件を除外」と言う
 * - 提案パネルの分類「伏線の回収」に、検算を通った1件（銀の懐中時計）だけが「第1話で張った：「…」」
 *   「第2話で回収：「…」」の形で並び、押す語が［回収済みにする］。本文に無い引用を返した「北の灯台」は並ばない
 * - **押すまでは台帳が変わらない**（誤って回収済みの印が付くと、作者は回収を忘れる。6.35.3）
 * - ［回収済みにする］を押すと、その1件の台帳が `resolved`・回収の話 2・回収の引用になり、作者メモと
 *   張った箇所・作った時刻は無傷。もう1件は未回収のまま。行は「回収済みにしました」に変わる
 * - 「伏線一覧」を開くと、押す前は「未回収 2件」だけだった一覧が、押したあとは
 *   「未回収 1件／回収済み 1件」になり、銀の懐中時計が「回収済み」の見出しの下へ移る
 *
 * **本物の AI は呼ばない。** 偽の Ollama は、第2話の本文を渡された頼みにだけ、回収の候補2件
 * （本文にある引用1件・本文に無い引用1件）を返し、それ以外（第1話）には「回収なし」を返す。
 * この答えは、作るときに本物の検算（`parseForeshadowResolveResult` → `validateForeshadowResolutions`、
 * 第2話は `splitIntoChunks` で製品と同じ形のチャンクにして）へ通し、1件が通って1件が
 * `quote_not_found` で落ちることを確かめてある。**AI の出来（実機で当たるか・誤りが出るか）は見えない**
 * ——それは 6290 行の MCP の測定の側。
 *
 * 話が2つでも「どこまで見ますか」は出ない（回収の確認は範囲を選ばない）。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { emptyForeshadow, foreshadowFileName, type Foreshadow } from "../../src/models/foreshadow";
import { DEFAULT_SETTINGS_DIR } from "../../src/models/types";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { describeNotices, recordedNotices } from "./support/noticeRecord";
import { runCommand } from "./support/quickInput";
import { OPEN_PROPOSALS_LAUNCH, OPEN_PROPOSALS_PRESS, proposalPanelFrame } from "./support/sampleFinding";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  clearNotifications,
  notificationTexts,
  pickQuickPickRow,
  pressWorkbenchKey,
  quickInputWaitContext,
  quickPickRows,
  quickPickTitle,
  readTabState,
} from "./support/workbenchDom";

/* ── 見本の作品：第1話で2つ張り、第2話で1つだけ回収する ── */

const EPISODE_1 = "001_止まった時計.txt";
const EPISODE_2 = "002_父の話.txt";
const BODY_1 = "　祖母の形見の銀の懐中時計は、三時で止まっていた。\n　祖母は「北の灯台には近づくな」と言った。\n";
const BODY_2 = "　夕食のあと、父が重い口を開いた。\n　懐中時計が止まった三時は、母が家を出ていった時刻だった。\n　灯台の話は、誰もしなかった。\n";

/** 回収の引用（第2話にだけある、連続した1文） */
const RESOLVED_QUOTE = "懐中時計が止まった三時は、母が家を出ていった時刻だった";
/** 本文に無い引用（検算の `quote_not_found` で落ちるはずのもの） */
const UNGROUNDED_QUOTE = "灯台の地下で、祖母の古い日記を見つけた";

const CREATED_AT = "2026-10-01T09:00:00.000Z";

/** 台帳の2件（作者が手で足した形。どちらも未回収） */
function ledger(): Foreshadow[] {
  const watch: Foreshadow = {
    ...emptyForeshadow("foreshadow_001", "銀の懐中時計"),
    note: "止まった時刻に意味がある",
    plantedChapter: 1,
    plantedQuote: "銀の懐中時計は、三時で止まっていた",
    // 作者メモは押しても無傷であることを見る（実装ルール2）
    authorNotes: "母の家出と結ぶつもり",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const lighthouse: Foreshadow = {
    ...emptyForeshadow("foreshadow_002", "北の灯台"),
    note: "灯台に家族の秘密がある",
    plantedChapter: 1,
    plantedQuote: "北の灯台には近づくな",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  return [watch, lighthouse];
}

/** 回収の確認の頼みへの答え（第2話の本文を渡されたときだけ候補を返す） */
const SECOND_EPISODE_ANSWER = JSON.stringify({
  resolutions: [
    { id: "foreshadow_001", quote: RESOLVED_QUOTE, note: "止まった時刻が、母が出ていった時刻だと父が明かした。" },
    { id: "foreshadow_002", quote: UNGROUNDED_QUOTE, note: "灯台に隠されていた日記が見つかった。" },
  ],
});
/** それ以外の本文（第1話）への答え。`{}` だと読めない応答として失敗に数えられるので、空の並びを返す */
const NO_RESOLUTION = JSON.stringify({ resolutions: [] });

/** 回収の確認の頼みか（`prompts/foreshadowResolve.ts` の頭の一文） */
function isResolveRequest(user: string): boolean {
  return user.includes("未回収の伏線が回収されたか");
}

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama((request) => {
    if (!isResolveRequest(request.user)) return "{}";
    // 第2話の本文が入った頼みにだけ候補を返す（頼みの中の伏線の一覧には、この文は無い）
    return request.user.includes("母が家を出ていった") ? SECOND_EPISODE_ANSWER : NO_RESOLUTION;
  });
});
afterAll(async () => {
  await fake.close();
});

function foreshadowsFolder(workFolder: string): string {
  return path.join(workFolder, DEFAULT_SETTINGS_DIR, "foreshadows");
}

/** 台帳を id で読む（ファイル名は label から決まるが、書き直しで変わっても id で拾う） */
async function readLedger(workFolder: string): Promise<Map<string, Foreshadow>> {
  const folder = foreshadowsFolder(workFolder);
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith(".json") && !name.includes(".novelai-"));
  const records = new Map<string, Foreshadow>();
  for (const name of names) {
    const raw = await readFile(path.join(folder, name), "utf8").catch(() => "");
    if (!raw) continue;
    try {
      const record = JSON.parse(raw) as Foreshadow;
      records.set(record.id, record);
    } catch {
      // 書いている途中で読めないことがある。次の回で読めればよい
    }
  }
  return records;
}

/** 伏線の一覧の写し（`.aiwriter/generated/伏線の一覧_*.md`）の中身。書き込み途中の一時ファイルは拾わない */
async function foreshadowLists(workFolder: string): Promise<string[]> {
  const folder = path.join(workFolder, ".aiwriter", "generated");
  const names = (await readdir(folder).catch(() => [] as string[])).filter(
    (name) => name.startsWith("伏線の一覧_") && name.endsWith(".md") && !name.includes(".novelai-")
  );
  const texts: string[] = [];
  for (const name of names) texts.push((await readFile(path.join(folder, name), "utf8").catch(() => "")).replace(/\r\n/g, "\n"));
  return texts;
}

/** 「伏線一覧」を押し、`matches` に合う一覧の写しができるまで待って返す */
async function openListUntil(session: E2ESession, matches: (text: string) => boolean, label: string): Promise<string> {
  await runCommand(session.page, "伏線一覧");
  let found: string | undefined;
  let seen: string[] = [];
  await waitUntil(
    async () => {
      seen = await foreshadowLists(session.workFolder);
      found = seen.find(matches);
      return found !== undefined;
    },
    label,
    20_000
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}（いまある一覧の写し：${JSON.stringify(seen.map((text) => text.replace(/\n/g, "⏎").slice(0, 300)))}）`);
  });
  return found ?? "";
}

/**
 * 伏線の回収の確認の完了の知らせ（右下か記録ファイル）のうち、`since` より後のもの。
 * 一部が失敗したときは「完了しました」でなく「一部を処理できませんでした」の形になるので、両方を拾って
 * あとの期待で見分ける（失敗の形のまま待ち続けて時間切れにしない）
 */
async function completionNotice(session: E2ESession, since: number): Promise<string | undefined> {
  const matches = (text: string): boolean =>
    text.includes("伏線の回収の確認が完了しました") || text.includes("伏線の回収の確認は一部を処理できませんでした");
  const fromToasts = (await notificationTexts(session.page)).find(matches);
  if (fromToasts) return fromToasts;
  return (await recordedNotices(session))
    .filter((entry) => Date.parse(entry.at) >= since - 1_000)
    .map((entry) => entry.message)
    .find(matches);
}

/** 一覧の Markdown から、見出し「## <見出し>（n件）」の節に並ぶ伏線の名前（### の行） */
function labelsUnder(markdown: string, heading: string): string[] {
  const sections = markdown.split(/\n(?=## )/);
  const section = sections.find((part) => part.startsWith(`## ${heading}（`)) ?? "";
  return [...section.matchAll(/^### (.+)$/gm)].map((match) => match[1].trim());
}

test("未回収2件の台帳で「伏線回収確認」を走らせると、検算を通った1件だけが提案パネルの「伏線の回収」に［回収済みにする］で並び、押すと台帳がその1件だけ回収済みになり、伏線の一覧でも回収済みの見出しへ移る", async () => {
  await withVsCode(
    "伏線の回収を確かめる",
    [
      { name: EPISODE_1, text: BODY_1 },
      { name: EPISODE_2, text: BODY_2 },
    ],
    async (session) => {
      const { page, workFolder } = session;
      await clearNotifications(page);
      const before = ledger();

      /* ── 押す前の一覧：未回収2件だけで、回収済みの見出しは無い ── */
      const listBefore = await openListUntil(session, (text) => text.includes("未回収 2件"), "押す前の伏線の一覧（未回収 2件）ができる");
      expect(labelsUnder(listBefore, "未回収"), "押す前の一覧の未回収が違います").toEqual(["銀の懐中時計", "北の灯台"]);
      expect(listBefore, "押す前の一覧に回収済みの見出しがあります").not.toContain("## 回収済み");
      let tabs: string[] = [];
      await waitUntil(
        async () => (tabs = (await readTabState(page)).flatMap((group) => group.tabs.map((tab) => tab.name))).some((name) => name.includes("伏線の一覧")),
        "伏線の一覧のタブが開く",
        15_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（いまのタブ：${JSON.stringify(tabs)}）`);
      });

      /* ── 「伏線回収確認」：処理量の確認で［実行］、完了の知らせを待つ ── */
      // 偽の AI はファイルの中で共有なので、この件の頭で数を控えて、増えた分だけを見る
      const sentBefore = fake.requests.length;
      const started = Date.now();
      await runCommand(page, "伏線回収確認");
      const seenTitles: string[] = [];
      let notice: string | undefined;
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const title = (await quickPickTitle(page)) ?? "";
          if (title !== "" && seenTitles[seenTitles.length - 1] !== title) seenTitles.push(title);
          if (title !== "") {
            // 処理量の確認（上の選ぶ画面）。文の頭は題に、残りは行に入る（`views/notify.ts` の `askInTopPicker`）
            const rows = await quickPickRows(page);
            const words = [title, ...rows.map((row) => row.label)].join(" ");
            if (rows.some((row) => row.label === "実行") && words.includes("伏線の回収を確かめます")) {
              await pickQuickPickRow(page, "実行");
            }
          }
          notice = await completionNotice(session, started);
          return notice !== undefined;
        },
        "処理量の確認を通って、伏線の回収の確認の完了の知らせが出る",
        120_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（通った選ぶ画面：${JSON.stringify(seenTitles)}／${describeFakeRequests(fake.requests, sentBefore)}／` +
            `${await describeNotices(session, started - 1_000)}）${await quickInputWaitContext(page)}`
        );
      });
      const requests = fake.requests.slice(sentBefore);
      const context = `（${describeFakeRequests(fake.requests, sentBefore)}）`;
      expect(notice, `完了の知らせが違います${context}`).toContain("伏線の回収の確認が完了しました。");
      expect(notice, `完了の知らせが件数を言っていません${context}`).toContain("未回収 2件のうち、回収されたと読める 1件 / 本文と合わない 1件を除外");

      // 頼みは第1話・第2話の2か所（どちらも張った話＝第1話より後ろか同じ）。構造化出力で、未回収の2件を渡している
      const resolveRequests = requests.filter((request) => isResolveRequest(request.user));
      expect(resolveRequests.length, `回収の確認の頼みが2回ではありません${context}`).toBe(2);
      expect(resolveRequests.every((request) => request.structured), `構造化出力で頼んでいません${context}`).toBe(true);
      const secondEpisode = resolveRequests.find((request) => request.user.includes("母が家を出ていった"));
      expect(secondEpisode, `第2話の本文を渡した頼みがありません${context}`).toBeDefined();
      expect(secondEpisode?.user ?? "", `第2話の頼みに未回収の2件が並んでいません${context}`).toContain("foreshadow_001｜銀の懐中時計");
      expect(secondEpisode?.user ?? "").toContain("foreshadow_002｜北の灯台");

      /* ── 押すまでは台帳が変わらない ── */
      const untouched = await readLedger(workFolder);
      for (const record of before) {
        expect(untouched.get(record.id)?.status, `押す前に「${record.label}」の状態が変わりました`).toBe("open");
      }

      /* ── 提案パネルの「伏線の回収」に、検算を通った1件だけが並ぶ ── */
      let proposals: Frame | undefined;
      let pressedOpen = false;
      const shownAt = Date.now();
      await waitUntil(
        async () => {
          proposals = await proposalPanelFrame(page);
          if (proposals !== undefined && (await proposals.locator("#category").innerText().catch(() => "")) === "伏線の回収") {
            return (await proposals.locator('button[data-action="apply"]').count()) > 0;
          }
          // 結果を出すときに自分で前へ出るはずだが、数秒出なければ作者と同じく「提案パネルを開く」で開く
          if (!pressedOpen && Date.now() - shownAt > 5_000) {
            pressedOpen = true;
            await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
          }
          return false;
        },
        "提案パネルの「伏線の回収」に回収の候補が並ぶ",
        30_000
      ).catch(async (error: unknown) => {
        const text = proposals ? await proposals.evaluate(() => document.body.innerText) : "（提案パネルが開いていません）";
        throw new Error(`${String(error)}（提案パネル：${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 500))}）`);
      });
      if (!proposals) throw new Error("提案パネルが見つかりません");
      const panel = proposals;
      const panelText = async (): Promise<string> => JSON.stringify((await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 600));

      const cards = panel.locator(".issue", { has: panel.locator('button[data-action="apply"]') });
      expect(await cards.count(), `回収の候補が1件ではありません：${await panelText()}`).toBe(1);
      const card = cards.first();
      expect((await card.locator(".meta .reason").first().innerText()).trim(), "候補の名前が違います").toBe("銀の懐中時計");
      const quote = (await card.locator(".quote").innerText()).replace(/\r\n/g, "\n");
      expect(quote, `張った箇所の行が違います：${quote}`).toContain("第1話で張った：「銀の懐中時計は、三時で止まっていた」");
      expect(quote, `回収の行が違います：${quote}`).toContain(`第2話で回収：「${RESOLVED_QUOTE}」`);
      expect((await card.locator('button[data-action="apply"]').innerText()).trim(), "押す語が「回収済みにする」ではありません").toBe("回収済みにする");
      expect(await panel.locator(".issue", { hasText: "北の灯台" }).count(), `本文に無い引用の「北の灯台」が並んでいます：${await panelText()}`).toBe(0);

      /* ── ［回収済みにする］を押す → 台帳（ファイル）がその1件だけ回収済みになる ── */
      await card.locator('button[data-action="apply"]').click();
      let after = new Map<string, Foreshadow>();
      await waitUntil(
        async () => (after = await readLedger(workFolder)).get("foreshadow_001")?.status === "resolved",
        "台帳の「銀の懐中時計」が回収済みになる",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（台帳：${JSON.stringify([...after.values()])}／提案パネル：${await panelText()}）`);
      });
      const watch = after.get("foreshadow_001");
      const [watchBefore, lighthouseBefore] = before;
      expect(watch?.resolvedChapter, "回収した話が第2話ではありません").toBe(2);
      expect(watch?.resolvedQuote, "回収の引用が違います").toBe(RESOLVED_QUOTE);
      expect(watch?.authorNotes, "作者メモが書き換わりました").toBe(watchBefore.authorNotes);
      expect(watch?.plantedQuote, "張った箇所が書き換わりました").toBe(watchBefore.plantedQuote);
      expect(watch?.plantedChapter).toBe(1);
      expect(watch?.createdAt, "台帳へ入った時刻が書き換わりました").toBe(CREATED_AT);
      expect(watch?.source).toBe("author");
      expect(after.get("foreshadow_002"), "押していない「北の灯台」が書き換わりました").toEqual(lighthouseBefore);
      expect(after.size, "台帳の件数が変わりました").toBe(2);

      /* ── 画面：その行が「回収済みにしました」に変わる ── */
      await waitUntil(
        async () => (await panel.locator(".issue.applied", { hasText: "銀の懐中時計" }).innerText().catch(() => "")).includes("回収済みにしました"),
        "提案パネルの行が「回収済みにしました」に変わる",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（提案パネル：${await panelText()}）`);
      });

      /* ── 押したあとの一覧：銀の懐中時計が回収済みへ移り、北の灯台は未回収に残る ── */
      const listAfter = await openListUntil(session, (text) => text.includes("回収済み 1件"), "押したあとの伏線の一覧（回収済み 1件）ができる");
      expect(listAfter, "一覧の要約が違います").toContain("未回収 1件／回収済み 1件");
      expect(labelsUnder(listAfter, "未回収"), "押したあとの一覧の未回収が違います").toEqual(["北の灯台"]);
      expect(labelsUnder(listAfter, "回収済み"), "押したあとの一覧の回収済みが違います").toEqual(["銀の懐中時計"]);
      expect(listAfter, "一覧に回収した話と引用が出ていません").toContain(`- 第2話で回収\n  - 引用：「${RESOLVED_QUOTE}」`);

      /* ── 本文は書き換えない ── */
      const read = async (name: string) => (await readFile(path.join(session.manuscriptFolder, name), "utf8")).replace(/\r\n/g, "\n");
      expect(await read(EPISODE_1)).toBe(BODY_1);
      expect(await read(EPISODE_2)).toBe(BODY_2);
    },
    fakeOllamaLaunch(fake, {
      ...OPEN_PROPOSALS_LAUNCH,
      prepareWork: async ({ workFolder }) => {
        const folder = foreshadowsFolder(workFolder);
        await mkdir(folder, { recursive: true });
        for (const record of ledger()) {
          await writeFile(path.join(folder, foreshadowFileName(record)), `${JSON.stringify(record, null, 2)}\n`, "utf8");
        }
      },
    })
  );
});
