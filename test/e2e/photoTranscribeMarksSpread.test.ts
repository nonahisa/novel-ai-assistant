/**
 * 写真から原稿を起こす画面（設計書6.117、`views/photoTranscribePanelHtml.ts`）の確かめのうち、
 * 機械で届く2つ（作者の裁定 2026-10-15 深夜「写真の確かめの残り3つ → 機械で届くぶんを先に」。
 * 引継ぎ書の同じ日の裁定3。3つ目「昔の書き方の字がそのまま写るか」は AI の出来なので作者が見る）。
 *
 * 何を見張るか：
 * 1. **目印と色**：書き起こした文の英字の連なり・読めない字（〓）・指示に例として挙げた旧字（國 など）に、
 *    目印（`<mark>`）が付き、色が製品の割り当てどおりに付くこと——旧字＝青（`--vscode-editorInfo-foreground`）、
 *    英字＝黄（`--vscode-editorWarning-foreground`）、〓＝赤（`--vscode-editorError-foreground`）。
 *    **画面の文言も「英字…（黄色）」「例として挙げた字…（青）」と言っている**ので、その文も見る。
 *    （裁定の言葉は「英字が青で目立つか」だが、製品で青なのは例に挙げた旧字。元の確かめの項目は
 *    「昔の書き方の字がそのまま写ったか・青で目立ったか」で、青は旧字の側の話と読める。3色とも見る）
 * 2. **見開きを左右に切る**：横長（幅が高さの `SPREAD_ASPECT` 倍以上）の写真を入れると「見開き：左右に切る」に
 *    印が入り、手元のAIの向きの推し（偽の Ollama が「そのまま・見開き」と答える）の札が出て、
 *    ［書き起こす］で左右2ページ（左のページ・右のページ）に切って並べる。左半分を赤・右半分を青で塗った
 *    写真にして、切ったページの絵の真ん中の色で、左右が取り違えずに切れたことまで見る。
 *    送る確認の文が「写真 1枚を切り分けた 2ページ」と言い、AI へは1ページに写真1枚ずつ届くことも見る
 *
 * **写真を選ぶ窓は VS Code の簡易の窓（`files.simpleDialog.enable`）で開く**（`backupFileDialog.test.ts` と同じ）。
 * 既定の Windows では OS のダイアログになり、Playwright から押せないうえ、作者の画面の前面に出る。
 * 製品に写真を引数で渡す口は足していない（設計書6.117.10 の「口を足してから書く」は、この窓で要らなくなった）。
 *
 * **本物の AI は呼ばない。** 偽の Ollama（`support/fakeOllama.ts`）が、写真を読めるモデル（`vision`）を名乗り、
 * 向きの問い（P-49）と書き起こし（P-48）に決まった答えを返す。写真は作者のものを使わず、テストの中で
 * 小さな PNG を作る（`support/testImage.ts`）。
 *
 * 見ていないもの：OS のファイル選択の窓そのもの、本物の AI の書き起こしの出来、色の見やすさ（作者の目）。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { describePhotoSend } from "../../src/core/photoTranscribeConfirm";
import { SPREAD_ASPECT } from "../../src/core/photoOrientValidation";
import {
  describeFakeRequests,
  FAKE_OLLAMA_MODEL,
  fakeOllamaLaunch,
  passLocalAiGate,
  startFakeOllama,
  type FakeOllama,
  type FakeOllamaRequest,
} from "./support/fakeOllama";
import { fillInput, runCommand } from "./support/quickInput";
import { paintedPng, type Rgb } from "./support/testImage";
import { withVsCode, type E2ESession, type FixtureEpisode, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  clearNotifications,
  dialogText,
  notificationTexts,
  pressDialogButton,
  quickInputWaitContext,
  quickPickTitle,
  webviewLayers,
} from "./support/workbenchDom";

/** 作品の話（この画面は話を読まない。作品が登録されていればよい） */
const EPISODES: FixtureEpisode[] = [{ name: "001_はじまり.txt", text: "　港に霧が出た。\n" }];

/** コマンドパレットでの名前（package.json の title） */
const COMMAND_TITLE = "写真から書き起こし（手書き）";
/** 写真を選ぶ窓の題（`features/photoTranscribe.ts` の `addPhotos`） */
const PICK_TITLE = "書き起こす写真を選んでください（複数選べます）";

const RED: Rgb = [220, 30, 30];
const BLUE: Rgb = [30, 30, 220];
const PAPER: Rgb = [235, 230, 215];

/** 向きの問い（P-49）か。system の書き出しで見分ける（`prompts/photoOrient.ts`） */
function isOrientRequest(request: FakeOllamaRequest): boolean {
  return request.system.includes("写真の向きを見分ける係");
}

/** 書き起こし（P-48）か（`prompts/photoTranscribe.ts`） */
function isTranscribeRequest(request: FakeOllamaRequest): boolean {
  return request.system.includes("写真から書き起こす係");
}

/**
 * 向きの問いへの答え。製品は見えている向き（0度）→ 右へ90度回した写し → 左へ90度回した写し、の順に
 * 1枚ずつ尋ね、**読み替えた向きが2つ一致したら推す**（`core/photoOrientValidation.ts` の `combinePhotoOrient`）。
 * 3回の問いは文が同じで区別できないので、**呼ばれた順**で答える：
 * 1回目（0度の写し）は字の頭が「上」、2回目（右へ90度回した写し）は「右」——90＋270＝360 で、
 * どちらも「そのまま（回さない）」に読み替わって一致し、3回目は尋ねられない
 */
function orientAnswer(orientIndex: number, layout: "single" | "spread"): string {
  return JSON.stringify({ top: orientIndex === 0 ? "up" : "right", layout });
}

/** 偽の Ollama を立てる。向きの問いには `layout` で、書き起こしには `transcribe` の答えで返す */
async function startPhotoFake(layout: "single" | "spread", transcribe: (request: FakeOllamaRequest) => string[]): Promise<FakeOllama> {
  let orientCount = 0;
  return startFakeOllama(
    (request) => {
      if (isOrientRequest(request)) return orientAnswer(orientCount++, layout);
      if (isTranscribeRequest(request)) return JSON.stringify({ lines: transcribe(request).map((text) => ({ text })) });
      return "{}";
    },
    { capabilities: ["completion", "vision"] }
  );
}

function launchFor(fake: FakeOllama): LaunchOptions {
  return fakeOllamaLaunch(fake, {
    settings: {
      // 写真を選ぶ窓を、OS のダイアログでなく VS Code の中の簡易の窓で出す（冒頭の断り書き）
      "files.simpleDialog.enable": true,
    },
  });
}

/** 写真から原稿を起こす画面の面（写真の並びの箱を持つ） */
async function photoPanelFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame.evaluate(() => document.querySelector('[data-testid="photo-list"]') !== null).catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 画面の様子（落ちたときに添える）：AIの帯・写真の札・状況の文・ページの数 */
async function panelState(frame: Frame | undefined): Promise<string> {
  if (!frame) return "画面の面なし";
  return frame
    .evaluate(() => {
      const text = (selector: string) => (document.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const cards = Array.from(document.querySelectorAll('[data-testid="photo-card"]')).map((card) =>
        (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160)
      );
      const pages = Array.from(document.querySelectorAll('[data-testid="photo-page"]')).map((row) =>
        (row.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160)
      );
      return `AIの帯「${text('[data-testid="photo-ai"]')}」／写真の札 ${JSON.stringify(cards)}／状況「${text("#status")}」／ページ ${JSON.stringify(pages)}／［書き起こす］${
        (document.getElementById("run") as HTMLButtonElement | null)?.disabled ? "押せない" : "押せる"
      }`;
    })
    .catch((error: unknown) => `画面を読めない：${String(error)}`);
}

/**
 * コマンドパレットから画面を開き、出てくる写真を選ぶ窓で `photoPath` を選ぶ。
 * 画面が開くと、製品はすぐ写真を選ぶ窓を出す（`ready` → `addPhotos`）
 */
async function openPanelWithPhoto(page: Page, photoPath: string): Promise<Frame> {
  await clearNotifications(page);
  await runCommand(page, COMMAND_TITLE);
  await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes(PICK_TITLE), "写真を選ぶ窓が出る", 30_000).catch(
    async (error: unknown) => {
      throw new Error(
        `${String(error)}（いまの題：「${(await quickPickTitle(page)) ?? ""}」／知らせ：${JSON.stringify(await notificationTexts(page))}）${await quickInputWaitContext(page)}`
      );
    }
  );
  await fillInput(page, photoPath);
  /*
    簡易の窓は、打った道を候補の行と突き合わせてから受ける。1回の Enter で決まらず、
    行を選んだだけで止まることがあるので、窓の題が消えるまで（3回まで）押す（backupFileDialog と同じ）
  */
  for (let attempt = 0; attempt < 3 && ((await quickPickTitle(page)) ?? "").includes(PICK_TITLE); attempt++) {
    await page.keyboard.press("Enter");
    await waitUntil(async () => !((await quickPickTitle(page)) ?? "").includes(PICK_TITLE), "写真を選ぶ窓が閉じる", 3_000).catch(() => undefined);
  }
  let frame: Frame | undefined;
  await waitUntil(
    async () => {
      frame = await photoPanelFrame(page);
      if (!frame) return false;
      return frame.evaluate(() => document.querySelectorAll('[data-testid="photo-card"]').length === 1).catch(() => false);
    },
    "写真の札が1枚並ぶ",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（${await panelState(frame)}／選んだ道：${JSON.stringify(photoPath)}／窓の題：「${(await quickPickTitle(page)) ?? ""}」／` +
        `知らせ：${JSON.stringify(await notificationTexts(page))}／WebView：${JSON.stringify(await webviewLayers(page))}）`
    );
  });
  if (!frame) throw new Error("写真から原稿を起こす画面が見つかりません");
  return frame;
}

/** 手元のAIの向きの推しが札に出るまで待ち、その札の文を返す */
async function waitOrientGuess(frame: Frame, fake: FakeOllama): Promise<string> {
  let note = "";
  await waitUntil(
    async () => {
      note = ((await frame.locator('[data-testid="photo-orient-guess"]').first().textContent({ timeout: 500 }).catch(() => "")) ?? "").trim();
      return note !== "";
    },
    "手元のAIの向きの推しが写真の札に出る",
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await panelState(frame)}）${describeFakeRequests(fake.requests)}`);
  });
  return note;
}

/**
 * ［書き起こす］を押し、送る確認（手元のAIなので「…で読みます」）で進むボタンを押す。
 * 確認の本文に、`pages`・`photos` から `describePhotoSend` が組む「この写真 N枚…」が入っていることを見る
 */
async function runTranscription(page: Page, frame: Frame, fake: FakeOllama, pages: number, photos: number): Promise<void> {
  const confirm = describePhotoSend({ providerId: "ollama", providerName: "", model: FAKE_OLLAMA_MODEL, pages, photos, isPaid: false });
  // 「この写真 2枚（写真 1枚を切り分けた 2ページ）」の部分（AI の名前の前まで）
  const countPart = confirm.message.slice(0, confirm.message.indexOf("を『"));
  await waitUntil(async () => frame.evaluate(() => !(document.getElementById("run") as HTMLButtonElement).disabled), "［書き起こす］が押せるようになる", 20_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（${await panelState(frame)}）`);
    }
  );
  await frame.locator('[data-testid="photo-run"]').click();
  let shown = "";
  await waitUntil(
    async () => {
      // 機械の GPU が忙しいと、手元のAIへ送る前の関所が先に出る（出ていれば通す）
      await passLocalAiGate(page);
      shown = (await dialogText(page)) ?? "";
      return shown.includes(countPart);
    },
    "写真を送る前の確認が出る",
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（確認の窓：${JSON.stringify(shown)}／待った文：${JSON.stringify(countPart)}／${await panelState(frame)}）`);
  });
  expect(shown, "手元のAIなのに、外へ送る言い方になっています").toContain("このパソコンの外へは出ません");
  await pressDialogButton(page, confirm.proceed);
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      return fake.requests.filter(isTranscribeRequest).length >= pages;
    },
    `偽のAIへ書き起こしが${pages}ページぶん届く`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await panelState(frame)}）${describeFakeRequests(fake.requests)}`);
  });
}

/** 書き起こしの結果がそのページに出るまで待つ（欄が触れるようになり、文が入る） */
async function waitPagesFilled(frame: Frame, count: number): Promise<void> {
  await waitUntil(
    async () =>
      frame
        .evaluate(
          (n) => {
            const areas = Array.from(document.querySelectorAll('[data-testid="photo-text"]')) as HTMLTextAreaElement[];
            return areas.length === n && areas.every((area) => !area.disabled && area.value !== "");
          },
          count
        )
        .catch(() => false),
    `書き起こした文が${count}ページに入る`,
    30_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await panelState(frame)}）`);
  });
}

async function writePhoto(session: E2ESession, name: string, png: Buffer): Promise<string> {
  const file = path.join(session.root, name);
  await writeFile(file, png);
  return file;
}

test("書き起こした文の、指示に例として挙げた旧字は青・英字の連なりは黄・読めない字〓は赤の目印で目立ち、状況の文も「黄色」「青」と色を言う", async () => {
  const fake = await startPhotoFake("single", () => ["國の港にwiderな風が吹いた。", "灯台の〓が読めない。"]);
  try {
    await withVsCode(
      "写真の書き起こしの目印の色",
      EPISODES,
      async (session) => {
        const { page } = session;
        // 縦長の1ページ（見開きの既定に入らない形）
        const photo = await writePhoto(session, "縦長の1ページ.png", paintedPng(100, 160, () => PAPER));
        const frame = await openPanelWithPhoto(page, photo);
        const guess = await waitOrientGuess(frame, fake);
        expect(guess, `向きの推しの札：${guess}`).toContain("1ページ");
        await runTranscription(page, frame, fake, 1, 1);
        await waitPagesFilled(frame, 1);

        const marks = await frame.evaluate(() => {
          const box = document.querySelector('[data-testid="photo-page"] .marks');
          /** 製品の CSS と同じ「変数（なければ予備の色）」を、仮の要素に塗って読んだ色 */
          const resolve = (css: string): string => {
            const probe = document.createElement("span");
            probe.style.background = css;
            document.body.appendChild(probe);
            const color = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return color;
          };
          const read = (kind: string) =>
            Array.from(box?.querySelectorAll(`mark.${kind}`) ?? []).map((mark) => ({
              text: mark.textContent ?? "",
              color: getComputedStyle(mark).backgroundColor,
            }));
          return {
            html: box?.innerHTML ?? "",
            example: read("example"),
            latin: read("latin"),
            unread: read("unread"),
            // views/photoTranscribePanelHtml.ts の mark.* と同じ指定（予備の色まで写す）
            blue: resolve("var(--vscode-editorInfo-foreground, #3794ff)"),
            yellow: resolve("var(--vscode-editorWarning-foreground, #bf8803)"),
            red: resolve("var(--vscode-editorError-foreground, #e51400)"),
            status: (document.querySelector('[data-testid="photo-page"] .edit > div')?.textContent ?? "").trim(),
          };
        });
        const where = `（目印の箱：${marks.html}）`;

        // 目印が付く字
        expect(marks.example.map((one) => one.text), `例に挙げた旧字「國」に目印がありません${where}`).toEqual(["國"]);
        expect(marks.latin.map((one) => one.text), `英字の連なり「wider」に目印がありません${where}`).toEqual(["wider"]);
        expect(marks.unread.map((one) => one.text), `読めない字〓に目印がありません${where}`).toEqual(["〓"]);

        // 色は製品の割り当てどおり（テーマで値が変わるので、同じ変数を塗った色と比べる）
        expect(marks.example[0].color, `旧字の目印が青（editorInfo）ではありません${where}`).toBe(marks.blue);
        expect(marks.latin[0].color, `英字の目印が黄（editorWarning）ではありません${where}`).toBe(marks.yellow);
        expect(marks.unread[0].color, `〓の目印が赤（editorError）ではありません${where}`).toBe(marks.red);
        // 「青」「黄」「赤」の向きも念のため（変数が空で、3つとも同じ色に落ちていないか）
        const rgb = (color: string): number[] => (color.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
        const [br, bg, bb] = rgb(marks.blue);
        expect(bb > br && bb > bg, `旧字の目印の色が青系ではありません：${marks.blue}`).toBe(true);
        const [yr, yg, yb] = rgb(marks.yellow);
        expect(yr > yb && yg > yb, `英字の目印の色が黄系ではありません：${marks.yellow}`).toBe(true);
        const [rr, rg, rb] = rgb(marks.red);
        expect(rr > rg && rr > rb, `〓の目印の色が赤系ではありません：${marks.red}`).toBe(true);
        expect(new Set([marks.blue, marks.yellow, marks.red]).size, "3つの目印が同じ色です").toBe(3);

        // 状況の文が、英字と例の字の件数と色を言う
        expect(marks.status, `状況の文：${marks.status}`).toContain("英字が混じった所が 1か所あります（黄色）");
        expect(marks.status, `状況の文：${marks.status}`).toMatch(/例として挙げた字（[^）]*）が 1か所あります（青）/);
        // 〓の件数（欄のすぐ下の行。状況の文も同じ class を持つことがあるので、欄の次で引く）
        const count = await frame.locator('[data-testid="photo-page"] .edit > textarea + .count').first().textContent();
        expect(count ?? "", `〓の件数の文：${count}`).toContain("1か所");
        // 1ページに写真1枚
        expect(fake.requests.filter(isTranscribeRequest).map((request) => request.images), describeFakeRequests(fake.requests)).toEqual([1]);
      },
      launchFor(fake)
    );
  } finally {
    await fake.close();
  }
});

test("横長の見開きの写真を入れると「左右に切る」に印が入り、手元のAIの推し（そのまま・見開き）の札が出て、書き起こすと左右2ページに切って左のページ→右のページの順に並べる", async () => {
  const fake = await startPhotoFake("spread", (request) =>
    request.user.includes("左のページ") ? ["左のページの文。"] : request.user.includes("右のページ") ? ["右のページの文。"] : ["どのページか分からない頼み。"]
  );
  try {
    await withVsCode(
      "写真の書き起こしの見開き",
      EPISODES,
      async (session) => {
        const { page } = session;
        // 横長（240×120＝2.0 倍）。左半分を赤・右半分を青で塗る
        const width = 240;
        const height = 120;
        expect(width / height, "見本の写真が横長の線を超えていません").toBeGreaterThanOrEqual(SPREAD_ASPECT);
        const photo = await writePhoto(session, "見開き.png", paintedPng(width, height, (x) => (x < width / 2 ? RED : BLUE)));
        const frame = await openPanelWithPhoto(page, photo);

        // 推しが返る前でも横長なら切るのが既定だが、推しの札が出てから見る（推しで置き直した結果を見るため）
        const guess = await waitOrientGuess(frame, fake);
        expect(guess, `向きの推しの札：${guess}`).toContain("そのまま・見開き");
        expect(await frame.locator('[data-testid="photo-split"]').isChecked(), `「見開き：左右に切る」に印がありません（${await panelState(frame)}）`).toBe(true);
        expect(await frame.locator('[data-testid="photo-order"]').count(), "読む順の選び欄が出ていません").toBe(1);
        expect(await frame.locator('[data-testid="photo-order"]').inputValue(), "読む順の既定が左のページからではありません").toBe("lr");
        // 向きの問いは2回で決まる（3回目は尋ねない）
        expect(fake.requests.filter(isOrientRequest).length, describeFakeRequests(fake.requests)).toBe(2);

        await runTranscription(page, frame, fake, 2, 1);
        await waitPagesFilled(frame, 2);

        // 写真が img に読み込まれるまで待ってから、大きさと真ん中の色を読む
        await waitUntil(
          async () =>
            frame
              .evaluate(() =>
                Array.from(document.querySelectorAll('[data-testid="photo-page"] .shot img')).every(
                  (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0
                )
              )
              .catch(() => false),
          "切ったページの絵が読み込まれる",
          10_000
        );
        const pages = await frame.evaluate(() =>
          Array.from(document.querySelectorAll('[data-testid="photo-page"]')).map((row) => {
            const img = row.querySelector(".shot img") as HTMLImageElement;
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const context = canvas.getContext("2d");
            context?.drawImage(img, 0, 0);
            const pixel = context?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
            return {
              label: (row.querySelector(".shot .count")?.textContent ?? "").trim(),
              width: img.naturalWidth,
              height: img.naturalHeight,
              center: pixel ? [pixel[0], pixel[1], pixel[2]] : [],
              text: (row.querySelector("textarea") as HTMLTextAreaElement).value,
            };
          })
        );
        const where = `（ページ：${JSON.stringify(pages)}）`;
        expect(pages.map((one) => one.label), `左右2ページに切れていません${where}`).toEqual(["1枚目・左のページ", "1枚目・右のページ"]);
        // 切ったページは元の半分の幅（120×120）。長辺2,000px より小さいので縮めない
        for (const one of pages) {
          expect([one.width, one.height], `切ったページの大きさが元の半分ではありません${where}`).toEqual([width / 2, height]);
        }
        // 左のページは赤、右のページは青（JPEG で少しにじむので、色の勝ち方で見る）
        const [lr, , lb] = pages[0].center;
        expect(lr > 150 && lb < 100, `左のページの真ん中が赤ではありません${where}`).toBe(true);
        const [rr, , rb] = pages[1].center;
        expect(rb > 150 && rr < 100, `右のページの真ん中が青ではありません${where}`).toBe(true);
        // ページごとの書き起こしが、そのページの欄に入る
        expect(pages.map((one) => one.text), `書き起こしの文がページと食い違っています${where}`).toEqual(["左のページの文。", "右のページの文。"]);

        // AI へは1ページに写真1枚ずつ、左→右の順に届いた
        const sent = fake.requests.filter(isTranscribeRequest);
        expect(sent.map((request) => request.images), describeFakeRequests(fake.requests)).toEqual([1, 1]);
        expect(sent.map((request) => (request.user.includes("左のページ") ? "左" : request.user.includes("右のページ") ? "右" : "?")), describeFakeRequests(fake.requests)).toEqual([
          "左",
          "右",
        ]);
      },
      launchFor(fake)
    );
  } finally {
    await fake.close();
  }
});
