/**
 * EPUBエディターの右の並び（本の並び）と目次の章（画面の自動テスト、設計書6.113・6.65.15・
 * 6.66。実機確認リスト F-65・F-66・F-75 を 2026-10-04 に移した）。
 *
 * 何を見張るか：
 * - 「本の設定」で題名を打ちかけ、ほかの面へ移って戻っても、打ちかけの字が残る
 *   （画面を切り替えるたびに欄を作り直すと消える。段D）
 * - 目次の並べ方を「章ごとに区切る」にすると、目次が章立ての台帳（`設定/章立て.json`）の
 *   章の名前で束なる。並びの右クリック「この後ろに挿入 ▶」→「章区切り」で章を足すと、
 *   開き直さずに目次が変わる
 * - 並びの右クリック「保留にする」で、その行が薄くなり「保留」の札が付く
 * - 行をドラッグして別の行の上半分で離すと、離す前に線が出て、並びが変わる。
 *   **Esc で取りやめたとき・並びの外で離したときは何も変わらない**
 *
 * 書き出した本の中身・保留の面が本に入らないことは単体テスト（`epubPackage.test.ts`・
 * `epubEditorPanelPreview.test.ts`）が見ている。ここで見るのは押したときの画面。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { answerInput, runCommand, waitForQuickInput } from "./support/quickInput";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { pickQuickPickRow, quickPickTitle } from "./support/workbenchDom";

const EPISODES = [
  { name: "第1話_はじまり.txt", text: "一話の本文。\n" },
  { name: "第2話_つづき.txt", text: "二話の本文。\n" },
  { name: "第3話_山場.txt", text: "三話の本文。\n" },
];

/** EPUBエディター（目印は「本の設定」の行 `#railBook` と並びの箱 `#blockList`） */
async function epubFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("railBook") !== null && document.getElementById("blockList") !== null)
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 右の並びの行の名前（上から） */
async function railLabels(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll("#blockList .rail-row")).map(
      (row) => (row.querySelector(".rail-label")?.textContent ?? "").trim()
    )
  );
}

function railRow(frame: Frame, label: string) {
  return frame.locator("#blockList .rail-row", { has: frame.locator(".rail-label", { hasText: label }) }).first();
}

async function pagesText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("pages")?.innerText ?? "");
}

/** 並びの行を右クリックし、自前の品書きが出るまで待つ */
async function openRailMenu(frame: Frame, label: string): Promise<void> {
  await railRow(frame, label).click({ button: "right" });
  await waitUntil(
    async () => (await frame.locator("#blockMenu .menu-item").count()) > 0,
    `「${label}」の行の右クリックで品書きが出る`,
    5_000
  );
}

/** 並びの行を右クリックし、自前の品書きの `item` を押す */
async function railMenu(frame: Frame, label: string, item: string): Promise<void> {
  await openRailMenu(frame, label);
  const entry = frame.locator("#blockMenu .menu-item", { hasText: item }).first();
  /*
    「この後ろに挿入 ▶」は入れ子の品書きの開き口で、**指を載せると開き、押すと開閉が
    入れ替わる**。Playwright の click は指を載せてから押すので、開いた直後に閉じてしまう。
    作者が指を載せて開く形に合わせ、開き口だけは載せるだけにする
  */
  if (item.startsWith("この後ろに挿入")) {
    await entry.hover({ timeout: 5_000 });
    return;
  }
  await entry.click();
}

/** EPUBエディターを開いて、その面を返す */
async function openEpubEditor(page: Page): Promise<Frame> {
  await runCommand(page, "EPUBエディター（試作）");
  // 作品を訊かれたら選ぶ（登録している作品は1つ）
  await page.waitForTimeout(500);
  if ((await quickPickTitle(page)) !== undefined) await pickQuickPickRow(page, E2E_WORK_TITLE);
  let found: Frame | undefined;
  await waitUntil(async () => {
    found = await epubFrame(page);
    return found !== undefined && (await railLabels(found)).length > 0;
  }, "EPUBエディターが開いて本の並びが出る", 30_000);
  if (!found) throw new Error("EPUBエディターが見つかりません");
  return found;
}

/** 章立ての台帳（第2話から「第二章　旅立ち」）を置く。目次の束ねに使う */
async function writeChapters(workFolder: string): Promise<void> {
  await mkdir(path.join(workFolder, "設定"), { recursive: true });
  await writeFile(
    path.join(workFolder, "設定", "章立て.json"),
    JSON.stringify({ schemaVersion: "1", chapters: [{ name: "第二章　旅立ち", startEpisodePath: "本文/第2話_つづき.txt" }] }, null, 2),
    "utf8"
  );
}

/** 目次の面を選び、並べ方を「章ごとに区切る」にして、章の名前が出るまで待つ */
async function tocByChapters(frame: Frame): Promise<void> {
  await railRow(frame, "目次").click();
  await frame.locator("#tocPattern").selectOption("chapters");
  await waitUntil(async () => (await pagesText(frame)).includes("第二章　旅立ち"), "目次が台帳の章の名前で束なる").catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（面：${(await pagesText(frame)).slice(0, 200)}）`);
    }
  );
}

test("EPUBエディターで、打ちかけの題名が面を移っても残り、目次が章の名前で束なって章区切りの挿入で開き直さずに変わり、保留にした行が薄くなり、ドラッグで並びが変わって Esc・枠の外では変わらない", async () => {
  await withVsCode("EPUBエディターの並び", EPISODES, async (session) => {
    const { page } = session;
    await writeChapters(session.workFolder);
    const epub = await openEpubEditor(page);

    /* ── 打ちかけの題名が残る（F-65） ── */
    await epub.locator("#railBook").click();
    const title = epub.locator("#bookTitle");
    await title.waitFor({ state: "visible" });
    await title.click();
    await page.keyboard.press("Control+KeyA");
    await page.keyboard.insertText("打ちかけの題");
    await railRow(epub, "目次").click();
    await waitUntil(async () => !(await title.isVisible()), "目次の面へ移る（本の設定が隠れる）");
    await epub.locator("#railBook").click();
    await title.waitFor({ state: "visible" });
    expect(await title.inputValue(), "面を移って戻ったら、打ちかけの題名が消えました").toBe("打ちかけの題");

    /* ── 目次を章で束ねる（F-66） ── */
    await tocByChapters(epub);
    expect(await pagesText(epub)).not.toContain("第三章　山場");

    /*
      並びの右クリックから章区切りを足すと、開き直さずに目次が変わる。
      **右クリックは中表紙の行で行う**——目次の行では品書きがすぐ閉じていた（下の別の件。
      2026-10-04 に直した）。章区切りは面ではないので、どの行から挿しても同じ
    */
    await railMenu(epub, "中表紙", "この後ろに挿入");
    const chapterEntry = epub.locator("#blockMenu .menu-item", { hasText: "章区切り" }).first();
    await waitUntil(async () => await chapterEntry.isVisible().catch(() => false), "「この後ろに挿入」に「章区切り」が出る");
    await chapterEntry.click();
    await waitForQuickInput(page, "章区切りを入れる");
    await pickQuickPickRow(page, "第3話");
    await waitForQuickInput(page, "ここから章を始める");
    await answerInput(page, "第三章　山場");
    await railRow(epub, "目次").click();
    await waitUntil(async () => (await pagesText(epub)).includes("第三章　山場"), "開き直さずに目次へ新しい章が出る").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（面：${(await pagesText(epub)).slice(0, 200)}）`);
      }
    );

    /* ── 保留にする（F-75） ── */
    await railMenu(epub, "中表紙", "保留にする");
    await waitUntil(async () => (await railRow(epub, "中表紙").getAttribute("class"))?.includes("suspended") === true, "中表紙の行に保留の印が付く");
    const opacity = await railRow(epub, "中表紙").evaluate((row) => Number(getComputedStyle(row).opacity));
    expect(opacity, "保留の行が薄くなっていません").toBeLessThan(1);
    expect(await railRow(epub, "中表紙").innerText()).toContain("保留");

    /* ── ドラッグで並べ替える（F-65） ── */
    const before = await railLabels(epub);
    const from = before.indexOf("奥付");
    const to = before.indexOf("目次");
    expect(from, `並び：${before.join(" / ")}`).toBeGreaterThan(to);

    /*
      掴む・動かす・離すは Playwright の hover と mouse で送る（locator の dragTo と同じ手順。
      座標だけで mouse.move を送ると、WebView の中でドラッグが始まらなかった）。
      **取りやめの2回も、いちど目次の上で線が出るのを見てから**取りやめる——ドラッグが
      始まっていないまま「変わらない」を見ても、何も確かめたことにならない
    */
    const upperHalf = async () => {
      const box = await railRow(epub, "目次").boundingBox();
      if (!box) throw new Error("目次の行の位置が測れません");
      return { x: box.width / 2, y: box.height * 0.25 };
    };
    const lineShown = () =>
      waitUntil(
        async () => (await railRow(epub, "目次").getAttribute("class"))?.includes("drop-before") === true,
        "奥付を目次の上半分へ動かすと、目次の行の上に落とす先の線が出る",
        5_000
      );
    const grabAndHoverToc = async () => {
      await railRow(epub, "奥付").hover();
      await page.mouse.down();
      await railRow(epub, "目次").hover({ position: await upperHalf() });
      await railRow(epub, "目次").hover({ position: await upperHalf() });
      await lineShown();
    };

    // 1回目：Esc で取りやめる → 並びは変わらない
    await grabAndHoverToc();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(500);
    expect(await railLabels(epub), "Esc で取りやめたのに並びが変わりました").toEqual(before);

    // 2回目：並びの外（プレビューの上）で離す → 並びは変わらない
    await grabAndHoverToc();
    await epub.locator("#pages").hover({ position: { x: 40, y: 40 } });
    await page.mouse.up();
    await page.waitForTimeout(500);
    expect(await railLabels(epub), "並びの外で離したのに並びが変わりました").toEqual(before);

    // 3回目：目次の行の上半分で離す → 奥付が目次の前へ入る
    await grabAndHoverToc();
    await page.mouse.up();
    await waitUntil(async () => {
      const after = await railLabels(epub);
      return after.indexOf("奥付") === to && after.indexOf("目次") === to + 1;
    }, "奥付が目次の前へ移る").catch(async (error: unknown) => {
      throw new Error(`${String(error)}（並び：${(await railLabels(epub)).join(" / ")}）`);
    });
  });
});

/*
  **目次の面を選んだまま、目次の行を右クリックしても品書きが開いたままになる**
  （設計書6.65.15 段D。実機確認リスト F-65 の右クリックの挿入・削除）。

  2026-10-04 に移したとき**落ちた**（同日に直した。開いた直後の描き直しの転がりでは閉じない。
  設計書6.65.15 段D の8）。記録を取って分かったこと：
  右クリックはその面を選び直して描き直す（`selectBlock` → `renderPages`）。目次が縦書きで
  枠からあふれていると、描き直しで面（`.epub-page.vertical`）が転がり、その scroll の知らせを
  「転がったら品書きを閉じる」受け手（`window` の scroll。捕まえる段で受けている）が拾って、
  開いた3ミリ秒後に閉じる。間に押す操作は無い。中表紙の行（あふれない面）なら開いたまま
*/
test("目次の面を選んだまま目次の行を右クリックすると、品書きが開いたままになる", async () => {
  await withVsCode("目次の行の右クリック", EPISODES, async (session) => {
    const { page } = session;
    await writeChapters(session.workFolder);
    const epub = await openEpubEditor(page);
    await tocByChapters(epub);
    // 並べ方の変更が拡張機能へ届いて画面が落ち着くまで待つ（待ち合わせのあとに送られる）
    await page.waitForTimeout(1_500);

    await openRailMenu(epub, "目次");
    await holdsFor(
      async () => (await epub.locator("#blockMenu .menu-item").count()) > 0,
      "目次の行の右クリックの品書きが開いたまま",
      1_500
    );
  });
});