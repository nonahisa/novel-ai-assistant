/**
 * スケジュール画面の続き（画面の自動テスト、設計書6.111・6.113）。
 *
 * 実機確認リスト 0.82.4〜0.83.13 の節の項目を機械へ移したもの（2026-10-04）：
 * - 済んだ・過ぎた予定だけの作品は列に並ばず、「済んだ作品も見る」を入れると出る
 * - WEB連載の点が、投稿済み・書き溜め・未執筆・過ぎて未投稿に分かれ、書き溜めの残りが出る
 * - 作業量の設定（水曜を休み・土日の割合）を変えると画面が描き直され、休みの日に薄い帯が付き、
 *   祝日の名前が日付の横に出る
 * - 自費出版のスケジュールを作ると、表紙の用意が推敲と並行の「人に頼む段」として最初から入る
 * - 「今日」の札が月の見出し・月曜の日付と重ならない高さにある（0.96.3 の直しの見張り）
 *
 * 見た目の良し悪し（色の見分けやすさ）は見ていない。日付は今日からの日数で組む（画面の「今日」は
 * 拡張機能の側の時計で決まり、動かせない）。**AI は呼ばない。**
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { answerInput, runCommand, waitForQuickInput } from "./support/quickInput";
import {
  dayKey,
  drawnBars,
  readScheduleFile,
  schedule,
  scheduleFrame,
  selfPublishSteps,
  serialRule,
  step,
  writePostingLedger,
  writeScheduleFile,
} from "./support/scheduleFixture";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pickQuickPickRow } from "./support/workbenchDom";

const EPISODE = { name: "001_はじまり.txt", text: "一行目の文。\n" };
const LAUNCH_DAYS = 150;

/** 作業中のスケジュールの見本（自費出版。発売日は先） */
const ACTIVE = (): Parameters<typeof writeScheduleFile>[1] => [
  schedule({
    id: "sch-1",
    kind: "selfPublish",
    name: "Kindle版",
    milestone: dayKey(LAUNCH_DAYS),
    targetChars: 80_000,
    steps: selfPublishSteps(),
  }),
];

/** コマンドパレットの「スケジュール」で画面を開き、画面の面を返す（帯が描かれるのは待たない） */
async function openScheduleByPalette(session: E2ESession): Promise<Frame> {
  await runCommand(session.page, "スケジュール");
  let frame: Frame | undefined;
  await waitUntil(async () => (frame = await scheduleFrame(session.page)) !== undefined, "スケジュール画面が開く", 30_000);
  if (!frame) throw new Error("スケジュール画面の面が見つかりません");
  return frame;
}

test("済んだ・過ぎた予定だけの作品は並ばず、「済んだ作品も見る」を入れると列が出る", async () => {
  await withVsCode(
    "スケジュールの済んだ作品",
    [EPISODE],
    async (session) => {
      const frame = await openScheduleByPalette(session);
      // 作業のある作品が無い：列は並ばず、済んだ作品がある旨が出る
      await waitUntil(
        async () => (await frame.locator("#empty").innerText()).includes("スケジュールのある作品がありません。"),
        "空の案内が出る",
        15_000
      );
      const empty = await frame.locator("#empty").innerText();
      expect(empty).toContain("済んだ・過ぎた予定だけの作品が1つあります（上の「済んだ作品も見る」で出せます）。");
      expect(await frame.locator(".work").count(), "作業のある作品の列").toBe(0);
      // 「済んだ作品も見る」を入れると、その作品の列が出る
      await frame.locator("#showFinished").check();
      await waitUntil(async () => (await frame.locator(".work .work-title").count()) === 1, "済んだ作品の列が出る", 15_000);
      expect((await frame.locator(".work .work-title").innerText()).trim()).toBe("画面テストの作品");
      expect(await frame.locator(".lane-head .name").innerText()).toBe("Kindle版");
      // 外すと、また並ばない
      await frame.locator("#showFinished").uncheck();
      await waitUntil(async () => (await frame.locator(".work").count()) === 0, "外すと列が消える", 15_000);
    },
    {
      prepareWork: async ({ workFolder }) => {
        // すべての段が済みで、発売日も過ぎている
        const done = selfPublishSteps().map((s) => ({ ...s, status: "done" as const, doneAt: dayKey(-40) }));
        await writeScheduleFile(workFolder, [
          schedule({ id: "sch-old", kind: "selfPublish", name: "Kindle版", milestone: dayKey(-30), targetChars: 80_000, steps: done }),
        ]);
      },
    }
  );
});

test("WEB連載の点が、投稿済み・書き溜め・未執筆・過ぎて未投稿に分かれ、書き溜めの残りと過ぎた話の数が詳細に出る", async () => {
  const episodes = [1, 2, 3, 4].map((n) => ({ name: `00${n}_第${n}話.txt`, text: `第${n}話の本文。${"あ".repeat(50)}\n` }));
  await withVsCode(
    "スケジュールの連載",
    episodes,
    async (session) => {
      const frame = await openScheduleByPalette(session);
      await waitUntil(async () => (await frame.locator(".lane .dot").count()) > 0, "連載の点が描かれる", 20_000);
      const all = await frame.evaluate(() =>
        Array.from(document.querySelectorAll(".lane .dot")).map((dot) => Array.from(dot.classList).filter((name) => name !== "dot")[0])
      );
      const count = (state: string) => all.filter((name) => name === state).length;
      // 開始は3日前：第1話（投稿済み）、第2・3話（書いてあるが予定日を過ぎて未投稿）、
      // 第4話（今日。書き溜め）、第5話以降（未執筆）
      expect(count("posted"), "投稿済み").toBe(1);
      expect(count("missed"), "過ぎて未投稿 " + JSON.stringify(all)).toBe(2);
      expect(count("stocked"), "書き溜め").toBe(1);
      expect(count("unwritten"), "未執筆").toBeGreaterThanOrEqual(1);
      // 凡例も出ている
      const legend = await frame.locator(".legend").innerText();
      for (const word of ["投稿済み", "書き溜め", "未執筆", "過ぎて未投稿"]) expect(legend).toContain(word);
      // 点の吹き出し（title）に話数と状態が出る
      const titles = await frame.locator(".lane .dot").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("title") ?? ""));
      expect(titles.some((t) => t.startsWith("第2話") && t.includes("過ぎて未投稿"))).toBe(true);
      // 連載の列頭を押すと詳細が開き、書き溜めの残りと過ぎた話の数が出る
      await frame.locator(".lane-head").first().click();
      await waitUntil(async () => (await frame.locator("#detail.open").count()) === 1, "詳細が開く", 10_000);
      const detail = await frame.locator("#detail").innerText();
      expect(detail).toContain("書き溜めの残り 3話");
      expect(detail).toContain("予定日を過ぎて未投稿の話が2話あります");
    },
    {
      prepareWork: async ({ workFolder }) => {
        await writePostingLedger(workFolder, ["本文/001_第1話.txt"]);
        await writeScheduleFile(workFolder, [
          schedule({
            id: "sch-serial",
            kind: "webSerial",
            name: "カクヨム連載",
            milestone: dayKey(-3),
            serial: serialRule({ bufferEpisodes: 2, firstEpisode: 1 }),
            steps: [
              step("se-1", "serialBuffer", "書き溜めの執筆", 5, { status: "done", doneAt: dayKey(-10) }),
              step("se-2", "serialPrep", "投稿の準備", 2, { status: "done", doneAt: dayKey(-5) }),
            ],
          }),
        ]);
      },
    }
  );
});

test("作業量の設定を変えると画面が描き直され、休みの日に薄い帯が付き、日付の横に祝日の名前が出る", async () => {
  await withVsCode(
    "スケジュールの作業量",
    [EPISODE],
    async (session) => {
      const frame = await openScheduleByPalette(session);
      await waitUntil(async () => (await frame.locator(".lane .bar").count()) > 0, "段の帯が描かれる", 20_000);
      // 祝日の名前が日付の横に出る（「祝 ○○」。月の縮尺）。発売日が先なので、期間のどこかに祝日がある
      const holidays = await frame.locator(".axis-label.holiday").allInnerTexts();
      expect(holidays.length, "祝日の札").toBeGreaterThan(0);
      for (const text of holidays) expect(text).toMatch(/^祝 /);
      // 設定の前：休みの日の帯は無い
      expect(await frame.locator(".rest-band").count(), "設定の前の休みの帯").toBe(0);
      const before = await frame.locator("#workload").innerText();
      // 設定を書き換える（水曜を休み、土日の割合を3）。画面が描き直される
      const settingsFile = path.join(session.root, "user-data", "User", "settings.json");
      const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
      settings["novelai.schedule.weekdayOverrides"] = { wed: 0 };
      settings["novelai.schedule.weekendWeight"] = 3;
      await writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");
      await waitUntil(async () => (await frame.locator(".rest-band").count()) > 0, "水曜に休みの帯が付く（描き直し）", 30_000);
      // 帯は水曜の数だけあり、1日分の高さ（月の縮尺で8px）
      const bands = await frame
        .locator(".rest-band")
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).getBoundingClientRect().height));
      expect(bands.length).toBeGreaterThanOrEqual(10);
      for (const height of bands) expect(Math.round(height)).toBe(8);
      const after = await frame.locator("#workload").innerText();
      expect(after, "作業量の表示も描き直される").not.toBe(before);
    },
    { prepareWork: async ({ workFolder }) => writeScheduleFile(workFolder, ACTIVE()) }
  );
});

test("自費出版のスケジュールを作ると、表紙の用意が最初から入り、推敲と同時に進む人に頼む段として描かれる", async () => {
  await withVsCode("スケジュールの作成", [EPISODE], async (session) => {
    const { page } = session;
    const frame = await openScheduleByPalette(session);
    await waitUntil(
      async () => (await frame.locator("#empty").innerText()).includes("スケジュールのある作品がありません。"),
      "空の案内が出る",
      15_000
    );
    await frame.locator("#empty button.primary").click();
    // 作品 → 種類 → 名前 → 発売日 → 予定の字数
    await waitForQuickInput(page, "スケジュールを足す作品");
    await pickQuickPickRow(page, "画面テストの作品");
    await waitForQuickInput(page, "に足すスケジュールの種類");
    await pickQuickPickRow(page, "自費出版");
    await waitForQuickInput(page, "自費出版の名前");
    await answerInput(page, "電子書籍の試し");
    await waitForQuickInput(page, "発売日");
    await answerInput(page, dayKey(LAUNCH_DAYS));
    await waitForQuickInput(page, "予定の字数");
    await answerInput(page, "80000");
    await waitUntil(async () => (await frame.locator(".lane .bar").count()) > 0, "段の帯が描かれる", 20_000);
    const bars = await drawnBars(frame);
    const labels = bars.map((bar) => bar.label);
    expect(labels, "雛形の段").toContain("表紙の用意");
    expect(labels).toContain("推敲");
    const cover = bars.find((bar) => bar.label === "表紙の用意");
    const revise = bars.find((bar) => bar.label === "推敲");
    expect(cover?.classes, "表紙は人に頼む段").toContain("others");
    // 推敲と同時に進める：同じ日に終わり、横に並ぶ
    expect(Math.abs((cover?.top ?? 0) + (cover?.height ?? 0) - ((revise?.top ?? 0) + (revise?.height ?? 0)))).toBeLessThan(2);
    expect(cover?.left).toBeGreaterThan(revise?.left ?? 0);
    // ファイルにも、表紙が推敲と並行の印で入っている
    const saved = (await readScheduleFile(session.workFolder)).schedules[0];
    const savedCover = saved?.steps.find((s) => s.key === "cover");
    const savedRevise = saved?.steps.find((s) => s.key === "revise");
    expect(savedCover?.parallelWith).toBe(savedRevise?.id);
  });
});

test("今日の札は、月の見出し・月曜の日付の札と重ならない高さに置かれる（描かれた矩形で見る）", async () => {
  await withVsCode(
    "スケジュールの今日の札",
    [EPISODE],
    async (session) => {
      const frame = await openScheduleByPalette(session);
      await waitUntil(async () => (await frame.locator(".axis .axis-label.today").count()) === 1, "今日の札が描かれる", 20_000);
      const boxes = await frame.evaluate(() => {
        const rects = (selector: string) =>
          Array.from(document.querySelectorAll(`.axis ${selector}`)).map((node) => {
            const r = node.getBoundingClientRect();
            return { text: node.textContent ?? "", top: r.top, bottom: r.bottom, left: r.left, right: r.right };
          });
        return {
          today: rects(".axis-label.today")[0],
          others: [...rects(".axis-label.month"), ...rects(".axis-label:not(.today):not(.holiday):not(.month)")],
        };
      });
      // 札の矩形には行の余白があり、隣り合う札は1〜2px触れることがある（字はぶつからない）。
      // 読めなくなる重なり＝縦に半行以上（6px以上）かぶさること
      const overlaps = boxes.others.filter((other) => {
        const sideBySide = boxes.today.left < other.right && other.left < boxes.today.right;
        const depth = Math.min(boxes.today.bottom, other.bottom) - Math.max(boxes.today.top, other.top);
        return sideBySide && depth >= 6;
      });
      expect(overlaps, `「${boxes.today.text}」の札が重なっています ${JSON.stringify(boxes.today)}`).toEqual([]);
    },
    { prepareWork: async ({ workFolder }) => writeScheduleFile(workFolder, ACTIVE()) }
  );
});
