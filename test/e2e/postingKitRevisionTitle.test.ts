/**
 * 修正版の出し直しで、題を直した話にだけ題の貼り替えを案内し、出し直しだけで終えた回は
 * 手順の段を進めない（画面の自動テスト、設計書6.68.7・6.104・6.113。0.125.2。作者の裁定 2026-11-03 夜）。
 * 実機確認リスト「（0.125.2。2026-11-04 足した）はじめの案内の『新話投稿』の段で…」を機械へ移したもの。
 *
 * 単体テスト（`test/unit/features/postingKitRevision.test.ts` の「題の貼り替えの案内」）は選ぶ画面を
 * 作り物で答えている。ここでは本物の VS Code で、作品の「新話投稿」から出し直しへ進んだときの
 * **案内の選ぶ画面の薄い字（placeholder）**を読む：
 *
 * 1. 最後にカクヨムへ渡した題（台帳の `titleHash`）が今の題と違う話 → 案内に
 *    「題（サブタイトル）も貼り替えてください（「サブタイトルをコピー」でコピーできます）。」が出る。
 *    ［出し直しました］のあと、出し直しの記録に今の題の印が残る（次に比べる相手になる）
 * 2. 題は同じで本文だけ直した話 → その文は出ない（本文の貼り替えの案内は出る）
 * 3. 手順の段：**「はじめの案内」（作家タイプ診断のあと）の段には新話投稿が無い**（`core/writerStyle.ts`
 *    の `tutorialAdvice`。「書いたものを出す」の段は投稿用コピー・投稿先・告知だけ）。新話投稿を段に持つ
 *    手順は、ヘルプの「場面別案内」の「投稿の準備をする」（`core/procedures.ts`。相談の「画面で案内して
 *    もらう」と同じ手順）なので、そこで見る。段が進むかの判定はどちらも同じ `countsAsDone`／
 *    `isCancelledOutcome`（`extension.ts` の新話投稿は `postedNew` が偽なら `CHECK_CANCELLED` を返す）。
 *    - 出し直しだけで終えると、案内は終わらず（「…の案内が終わりました」が出ない）、▶ は1段目のまま
 *    - 続けて新しい話を本当に投稿すると、最後の段（新話投稿）が済んで案内が終わる
 *      （何をしても進まない作りでも上が通ってしまうので、進むほうも確かめる）
 *
 * **外のブラウザは開かせない**（`postingKitRevision.test.ts` と同じく本体側の `shell.openExternal` を替える）。
 * AI は呼ばない（1段目の各話あらすじは押さない）。クリップボードは本物の OS のものを通るので、走らせたあと戻す。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { SIDEBAR_LAUNCH, showSidebar } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  notificationTexts,
  pickQuickPickRow,
  pressDialogButton,
  quickPickPlaceholder,
  quickPickRows,
  quickPickTitle,
} from "./support/workbenchDom";
import { runCommand } from "./support/quickInput";
import { postingTextHash, postingTitleHash } from "../../src/core/postingBodyHash";

const TITLE_HINT = "題（サブタイトル）も貼り替えてください（「サブタイトルをコピー」でコピーできます）。";
const BODY_HINT = "本文を貼り替えてください";
const KAKUYOMU_POST_URL = "https://kakuyomu.jp/my/works/1177354054934574437/episodes/new";
const KAKUYOMU_MANAGE_URL = "https://kakuyomu.jp/my/works/1177354054934574437";
const EPISODE_PATH = "本文/第1話_はじまり.txt";
/** 投稿したときの本文（いまの第1話は、このあとに「直したあとの一文。」を足した） */
const POSTED_TEXT = "　朝の駅は静かだった。\n";
const EDITED_TEXT = "　朝の駅は静かだった。\n　直したあとの一文。\n";
const EPISODE_1 = { name: "第1話_はじまり.txt", text: EDITED_TEXT };

/**
 * 投稿の記録。`sentTitle` は最後にカクヨムへ渡した題。いまのファイル名の題は「はじまり」。
 * 題を直した話は、投稿したときの題（「出会い」）の印が残っている形にする
 * （単体テストと同じ置き方。ファイル名を変えると記録の道が変わるので、記録の側で古い題を持たせる）
 */
function postedRecord(sentTitle: string): Record<string, unknown> {
  return {
    episodePath: EPISODE_PATH,
    site: "kakuyomu",
    postedAt: "2026-10-01T00:00:00.000Z",
    bodyHash: postingTextHash(sentTitle, POSTED_TEXT),
    titleHash: postingTitleHash(sentTitle),
  };
}

function launchWith(posts: unknown[]) {
  const ledger = { schemaVersion: "1", sites: [{ site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST_URL }], posts };
  return {
    ...SIDEBAR_LAUNCH,
    globalState: { "novelai.siteLink.browserGuideShown": true },
    prepareWork: async ({ workFolder }: { workFolder: string }) => {
      await mkdir(path.join(workFolder, "設定"), { recursive: true });
      await writeFile(path.join(workFolder, "設定", "投稿状態.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    },
  };
}

async function blockBrowser(session: E2ESession): Promise<void> {
  await session.app.evaluate(({ shell }) => {
    const target = globalThis as unknown as { __e2eOpened?: string[] };
    target.__e2eOpened = [];
    (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => {
      target.__e2eOpened?.push(url);
    };
  });
}

async function openedUrls(session: E2ESession): Promise<string[]> {
  return session.app.evaluate(() => (globalThis as unknown as { __e2eOpened?: string[] }).__e2eOpened ?? []);
}

interface LedgerShape {
  posts?: Array<Record<string, unknown>>;
  revisions?: Array<Record<string, unknown>>;
}

async function ledger(session: E2ESession): Promise<LedgerShape> {
  const text = await readFile(path.join(session.workFolder, "設定", "投稿状態.json"), "utf8");
  return JSON.parse(text) as LedgerShape;
}

/** 選ぶ画面の題が `needle` を含むまで待つ。VS Code 自身の「外のサイトを開きますか」は［Open］で進める */
async function waitTitle(page: Page, needle: string, what: string): Promise<string> {
  let title: string | undefined;
  await waitUntil(
    async () => {
      const dialog = await dialogText(page);
      if (dialog?.includes("open the external website")) {
        await pressDialogButton(page, "Open").catch(() => undefined);
        return false;
      }
      title = await quickPickTitle(page);
      return title !== undefined && title.includes(needle);
    },
    what,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（いまの題：${JSON.stringify(title)}／行：${JSON.stringify((await quickPickRows(page).catch(() => [])).map((row) => row.label))}` +
        `／知らせ：${JSON.stringify(await notificationTexts(page).catch(() => []))}）`
    );
  });
  return title ?? "";
}

/** 作品の「新話投稿」→ 出し直しの促し → 第1話を出し直す → カクヨム（既定の印）で Enter → 修正版の案内まで */
async function walkToRevisionGuide(session: E2ESession): Promise<string> {
  const { page } = session;
  await runCommand(page, "新話投稿");
  await waitTitle(page, "投稿のあとに直した話があります", "出し直しの促しが出る");
  await pickQuickPickRow(page, "を出し直す");
  await waitTitle(page, "修正版を出し直すサイト", "出し直すサイトを選ぶ画面が出る");
  await page.keyboard.press("Enter");
  await waitTitle(page, "の修正版を カクヨム へ", "「… の修正版を カクヨム へ」の案内が出る");
  await waitUntil(async () => (await openedUrls(session)).length > 0, "作品の管理画面を開こうとする", 15_000);
  expect(await openedUrls(session), "開いたのが作品の管理画面ではない").toEqual([KAKUYOMU_MANAGE_URL]);
  return (await quickPickPlaceholder(page)) ?? "";
}

async function withClipboardRestored(session: E2ESession, body: () => Promise<void>): Promise<void> {
  const before = await session.app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => "");
  try {
    await body();
  } finally {
    await session.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), before).catch(() => undefined);
  }
}

test("題を直した話を出し直すと、案内に「題（サブタイトル）も貼り替えてください」が出て、出し直しの記録に今の題の印が残る", async () => {
  await withVsCode(
    "出し直しの題の貼り替え",
    [EPISODE_1],
    async (session) => {
      const { page } = session;
      await withClipboardRestored(session, async () => {
        await blockBrowser(session);
        const hint = await walkToRevisionGuide(session);
        expect(hint, `題を直した話なのに、題の貼り替えの案内が無い（案内：${JSON.stringify(hint)}）`).toContain(TITLE_HINT);
        expect(hint, `本文の貼り替えの案内が無い（案内：${JSON.stringify(hint)}）`).toContain(BODY_HINT);
        // 「サブタイトルをコピー」で貼れるのは今の題
        const rows = await quickPickRows(page);
        expect(rows.some((row) => row.label.includes("サブタイトルをコピー")), `「サブタイトルをコピー」が無い（${JSON.stringify(rows.map((row) => row.label))}）`).toBe(true);
        const detail = await page.locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: "サブタイトルをコピー" }).first().innerText();
        expect(detail, "「サブタイトルをコピー」の題が今の題（はじまり）ではない").toContain("「はじまり」を題名の欄へ貼れます");

        await pickQuickPickRow(page, "出し直しました");
        await waitUntil(async () => ((await ledger(session)).revisions ?? []).length === 1, "台帳に出し直しの記録が1件入る", 20_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（台帳：${JSON.stringify(await ledger(session))}）`);
          }
        );
        const saved = await ledger(session);
        expect(saved.revisions?.[0], "出し直しの記録に今の題の印が無い（次の出し直しで、また題を直したと言ってしまう）").toMatchObject({
          episodePath: EPISODE_PATH,
          site: "kakuyomu",
          titleHash: postingTitleHash("はじまり"),
          bodyHash: postingTextHash("はじまり", EDITED_TEXT),
        });
        expect(saved.posts, "投稿の記録が変わった（出し直しは新しい話として数えない）").toEqual([postedRecord("出会い")]);
      });
    },
    launchWith([postedRecord("出会い")])
  );
}, 180_000);

test("題を直さず本文だけ直した話を出し直すときは、案内に題の貼り替えの文が出ない", async () => {
  await withVsCode(
    "出し直しの題そのまま",
    [EPISODE_1],
    async (session) => {
      const { page } = session;
      await withClipboardRestored(session, async () => {
        await blockBrowser(session);
        const hint = await walkToRevisionGuide(session);
        // 案内そのものは読めている（空の字と比べて「出ない」にしない）
        expect(hint, `本文の貼り替えの案内が読めない（案内：${JSON.stringify(hint)}）`).toContain(BODY_HINT);
        expect(hint, `題を直していない話に、題の貼り替えの案内が出た（案内：${JSON.stringify(hint)}）`).not.toContain("題（サブタイトル）も貼り替えて");
        await pickQuickPickRow(page, "中止する");
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 10_000);
        expect((await ledger(session)).revisions ?? [], "中止したのに出し直しの記録が入った").toEqual([]);
      });
    },
    launchWith([postedRecord("はじまり")])
  );
}, 180_000);

/* ── 手順の段（場面別案内「投稿の準備をする」）── */

const SCENE = "投稿の準備をする";
const STEP1 = "各話あらすじ";
const TOUR_END = `「${SCENE}」の案内が終わりました`;

/** 左の列の行のうち、「▶」の印が付いている行の名前（`sceneGuideSpotlight.test.ts` と同じ読み方） */
async function spotlightedRows(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".monaco-list-row"))
      .filter((row) =>
        Array.from(row.querySelectorAll<HTMLElement>("*")).some((el) => {
          // 飾りの札は擬似要素の content に入る（DOM の字にはならない）
          const after = getComputedStyle(el, "::after").content;
          return after.includes("▶") || (el.textContent ?? "").includes("▶");
        })
      )
      .map((row) => row.getAttribute("aria-label") ?? "")
  );
}

/** 相談パネルの面（入力欄と「本文へ」の口がある iframe） */
async function chatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const ok = await frame.evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null).catch(() => false);
    if (ok) return frame;
  }
  return undefined;
}

async function chatText(page: Page): Promise<string> {
  const frame = await chatFrame(page);
  if (!frame) return "";
  return (await frame.evaluate(() => document.body.innerText).catch(() => "")).replace(/\s+/g, " ");
}

async function describeTour(page: Page): Promise<string> {
  return (
    `（印の付いた行：${JSON.stringify(await spotlightedRows(page).catch(() => []))}` +
    `／選ぶ画面：${await quickPickTitle(page).catch(() => undefined)}` +
    `／知らせ：${JSON.stringify(await notificationTexts(page).catch(() => []))}` +
    `／相談パネルの末尾：${(await chatText(page).catch(() => "")).slice(-400)}）`
  );
}

test("場面別案内「投稿の準備をする」の途中で、新話投稿で出し直しだけを済ませて終えても案内は進まず、新しい話を投稿すると最後の段が済んで終わる", async () => {
  await withVsCode(
    "出し直しで段が進まない",
    // 第1話は投稿後に本文を直した（題は同じ）。第2話は未投稿
    [EPISODE_1, { name: "第2話_つづき.txt", text: "　二話の本文。\n" }],
    async (session) => {
      const { page } = session;
      await withClipboardRestored(session, async () => {
        await blockBrowser(session);
        await showSidebar(page, E2E_WORK_TITLE);
        await clearNotifications(page);

        await runCommand(page, "場面別案内");
        await waitUntil(async () => (await quickPickTitle(page)) !== undefined, "場面を選ぶ画面が出る", 20_000);
        const scenes = await quickPickRows(page);
        const scene = scenes.find((row) => row.label.includes(SCENE));
        expect(scene, `場面の一覧に「${SCENE}」が無い：${JSON.stringify(scenes.map((row) => row.label))}`).toBeTruthy();
        await pickQuickPickRow(page, scene?.label ?? SCENE);

        // 1段目（各話あらすじ。AI を使うので押さない）に ▶ が付き、札にも1段目の名前が出る
        await waitUntil(
          async () => {
            const rows = await spotlightedRows(page);
            return rows.length === 1 && rows[0].startsWith(STEP1);
          },
          `「${STEP1}」の行だけに▶が付く`,
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}${await describeTour(page)}`);
        });
        await waitUntil(async () => (await chatText(page)).includes(STEP1), `相談パネルの札に「${STEP1}」が出る`, 20_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}${await describeTour(page)}`);
        });

        // ── 出し直しだけで終える：促し → 第1話を出し直す → カクヨム → 出し直しました → 「ここで終える」 ──
        await walkToRevisionGuide(session);
        await pickQuickPickRow(page, "出し直しました");
        await waitUntil(async () => ((await ledger(session)).revisions ?? []).length === 1, "台帳に出し直しの記録が1件入る", 20_000);
        await waitTitle(page, "続けて新しい話を投稿しますか", "続けて新しい話を投稿するかを訊く");
        await pickQuickPickRow(page, "ここで終える");
        await waitUntil(async () => (await quickPickTitle(page)) === undefined, "選ぶ画面が閉じる", 10_000);
        expect((await ledger(session)).posts ?? [], "出し直しだけなのに、投稿の記録が増えた").toHaveLength(1);

        // 案内は終わらず、▶ は1段目に残る（最後の段＝新話投稿を済ませたことにしない）
        await holdsFor(
          async () => {
            const rows = await spotlightedRows(page);
            return !(await chatText(page)).includes(TOUR_END) && rows.length === 1 && rows[0].startsWith(STEP1);
          },
          "出し直しだけで終えたあと、案内が終わらず▶が1段目に残る",
          5_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}${await describeTour(page)}`);
        });

        // ── 新しい話（第2話）を本当に投稿すると、最後の段が済んで案内が終わる ──
        await runCommand(page, "新話投稿");
        await waitTitle(page, "を カクヨム へ", "第2話の新しい話の案内「… を カクヨム へ」が出る");
        const title = (await quickPickTitle(page)) ?? "";
        expect(title, `出し直した第1話がまた案内された（題：${title}）`).toContain("第2話");
        expect(title, "新しい話の案内のはずが修正版の案内になった").not.toContain("修正版");
        await pickQuickPickRow(page, "投稿しました");
        await waitUntil(async () => ((await ledger(session)).posts ?? []).length === 2, "投稿の記録が2件になる", 20_000);
        await waitTitle(page, "投稿おつかれさまでした", "告知の質問が出る");
        await pickQuickPickRow(page, "告知は作らずに終わる");
        await waitUntil(async () => (await chatText(page)).includes(TOUR_END), `相談パネルに「${TOUR_END}」が出る`, 20_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}${await describeTour(page)}`);
        });
        await waitUntil(async () => (await spotlightedRows(page)).length === 0, "案内が終わり、▶ が外れる", 10_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}${await describeTour(page)}`);
        });
      });
    },
    launchWith([postedRecord("はじまり")])
  );
}, 240_000);
