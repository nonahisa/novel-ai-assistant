/**
 * エクスプローラーから相談パネルへバックアップを落とす（Shift あり・なし）（画面の自動テスト、
 * 設計書6.99 の「相談パネルへバックアップを渡す」・6.113。実機確認リスト 981。仕分け 2026-10-15 の
 * 「E・未着手・難」。設計書の残課題「ドロップが VS Code に横取りされずに画面まで届くかは実機未確認」）。
 *
 * 何を見張るか：
 * 1. Shift なし：VS Code のエクスプローラーの行を相談パネルの上へ引きずって落とすと、VS Code が
 *    横取りしてそのファイルをエディターで開き、相談パネルには何も届かない（取り込みの確認も出ない）
 * 2. Shift あり：途中で Shift を押して落とすと、VS Code は横取りせず（ファイルは開かない）落とし先は
 *    相談パネルの WebView になる。同じドラッグの中身が WebView の中へ渡ると、相談パネルが
 *    「受け取りました。どの作品のものか確かめています…」と出し、照合の確認（登録済みの作品には
 *    見当たりませんでした。新しい作品として取り込みますか？）が開く
 * 3. OS のエクスプローラーから（ファイルそのもの）：WebView にファイルが落ちると、同じ確認が開く
 * どの件も確認は［Cancel］で閉じ、書庫に新しい作品ができないことを確かめる。
 *
 * **Playwright の引きずりは、WebView の中まで届かない（2026-10-15 母艦・VS Code 1.141.0 で確かめた）。**
 * 相談パネルの WebView の外側の枠は**別プロセスの枠**（Playwright で専用の CDP の口が開く。
 * 内側の枠は開かない）。Playwright の `mouse` で引きずると、引きずりの便は本体の窓（ページ）へ
 * 送られ、本体の文書の `drop` は WebView の `<iframe>` 要素で止まり、枠の中の文書には
 * dragenter も drop も1つも来なかった。
 * そこで2つに分けて確かめる：
 * - **VS Code が横取りするかどうか**は、本物の引きずり（エクスプローラーの行で dragstart が起き、
 *   本体の文書で drop が起きる）で見る。Shift なしは本体の落とし先（ファイルを開く）、Shift ありは
 *   WebView の `<iframe>` 要素。ここで、引きずり始めにエクスプローラーが載せた中身を控える
 * - **WebView に落ちたあと**は、控えた中身をそのまま、WebView の外側の枠の CDP の口から
 *   `Input.dispatchDragEvent`（Shift つき）で落とす。本物のブラウザが枠の中へ渡すのと同じ便で、
 *   製品の受け口（`views/workChatPanelHtml.ts` の drop）がそのまま動く
 * **2つの段のつなぎ目（本体の窓が、落ちた中身を別プロセスの枠へ渡すところ）は Chromium の中で、
 * ここは見ていない。** 作者の実機で1回落とせば、残りはこのテストが見張る。
 *
 * **製品には何も足さない。** 見本のバックアップは、なろうの合本を展開した .txt の形
 * （【Nコード】の欄があるもの）を、書庫の直下（作品の外）に置く。
 */
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { activateTab, dialogText, editorGroupTabs, pressDialogButton, pressWorkbenchKey, tabNamesInclude } from "./support/workbenchDom";

const BACKUP_NAME = "N0000ZY.txt";
const SEP = (n: number) => `------------------------- エピソード${n}開始 -------------------------`;
/** なろうの合本を展開した .txt（どの作品にも当たらない Nコード・題） */
const BACKUP_TEXT = [
  "【Nコード】",
  "N0000ZY",
  "",
  "【タイトル】",
  "照合試験_無関係",
  "",
  SEP(1),
  "【エピソードタイトル】",
  "1話　はじめ",
  "",
  "【本文】",
  "はじめの本文。",
  "",
].join("\n");

const OPEN_CHAT_PRESS = "Control+Alt+Shift+KeyC";
const SHOW_EXPLORER_PRESS = "Control+Alt+Shift+KeyE";
const CHAT_TAB = "AIに相談";

const LAUNCH = {
  keybindings: [
    { key: "ctrl+alt+shift+c", command: "novelai.openChat" },
    { key: "ctrl+alt+shift+e", command: "workbench.view.explorer" },
  ],
  // 書庫の直下（作品の外）に置く。作品の中に置くと、本文の一部と見なされうる
  prepareWork: async ({ workFolder }: { workFolder: string }) => {
    await writeFile(path.join(workFolder, "..", BACKUP_NAME), BACKUP_TEXT, "utf8");
  },
};

/** 大きい相談画面の面（`#context-what` と `#to-sub` を持つ） */
async function largeChatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-sub") !== null)
      .catch(() => false);
    if (found) return frame;
  }
  return undefined;
}

/**
 * 相談を大きい画面（エディターの列）で開き、左の列をエクスプローラーにする。
 * 横の相談パネルは左の列（統合小説執筆環境）の中にあり、エクスプローラーと同時には見えないため
 * （面の作りは同じ `workChatPanelHtml.ts`。大きさで見た目を変えているだけ）
 */
async function openChatBesideExplorer(page: Page): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_CHAT_PRESS);
  await waitUntil(
    async () => {
      for (const frame of page.frames()) {
        if (await frame.evaluate(() => document.getElementById("to-main") !== null).catch(() => false)) {
          await frame.locator("#to-main").click();
          return true;
        }
      }
      return false;
    },
    "横の相談パネルが開いて［メインに表示］を押せる",
    30_000
  );
  await waitUntil(async () => (await largeChatFrame(page)) !== undefined, "大きい相談画面が開く", 30_000);
  const chat = (await largeChatFrame(page)) as Frame;
  await pressWorkbenchKey(page, SHOW_EXPLORER_PRESS);
  await waitUntil(async () => (await explorerRow(page).count()) > 0, `エクスプローラーに「${BACKUP_NAME}」の行が出る`, 15_000);
  // 面の中の引きずりの便を数える（製品の受け口より先に聞く。数えるだけで止めない）
  await chat.evaluate(() => {
    const target = window as Window & { __e2eDrags?: string[] };
    if (target.__e2eDrags) return;
    target.__e2eDrags = [];
    for (const type of ["dragenter", "drop"]) {
      document.addEventListener(type, (event) => target.__e2eDrags?.push(`${type}:shift=${String((event as DragEvent).shiftKey)}`), true);
    }
  });
  return chat;
}

function explorerRow(page: Page) {
  return page.locator(`.monaco-list-row[aria-label^="${BACKUP_NAME}"]`).first();
}

async function chatLog(chat: Frame): Promise<string> {
  return chat.evaluate(() => document.getElementById("log")?.innerText ?? "").catch(() => "");
}

async function dragsInChat(chat: Frame): Promise<string[]> {
  return chat.evaluate(() => (window as Window & { __e2eDrags?: string[] }).__e2eDrags ?? []).catch(() => []);
}

/** 本体の文書で起きた引きずりの便と、引きずり始めにエクスプローラーが載せた中身を控える */
async function watchWorkbenchDrag(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as Window & { __e2eWorkbenchDrag?: { events: string[]; data: Record<string, string> } };
    target.__e2eWorkbenchDrag = { events: [], data: {} };
    // 2回目以降の観察は、聞き手を重ねず控えだけ空にする
    const previousOver = (window as Window & { __e2eOver?: { count: number; last: string; lastOutside: boolean; lastShift: boolean; sawOutsideShift: boolean; sawShift: boolean } }).__e2eOver;
    if (previousOver) Object.assign(previousOver, { count: 0, last: "?", lastOutside: false, lastShift: false, sawOutsideShift: false, sawShift: false });
    if ((window as Window & { __e2eWorkbenchWatch?: boolean }).__e2eWorkbenchWatch) return;
    (window as Window & { __e2eWorkbenchWatch?: boolean }).__e2eWorkbenchWatch = true;
    // dragend も控える：落ちたときに「drop が無いまま引きずりが終わった」のか「まだ終わっていない」のかを分けるため
    // dragenter も控える（落とし先に入ったかを見るため。前と同じ便は重ねない。dragover は下の「受け付けたか」で控える）
    for (const type of ["dragstart", "dragenter", "drop", "dragend"]) {
      document.addEventListener(
        type,
        (event) => {
          const record = (window as Window & { __e2eWorkbenchDrag?: { events: string[]; data: Record<string, string> } }).__e2eWorkbenchDrag;
          if (!record) return;
          const element = event.target instanceof Element ? event.target : null;
          const entry = `${type}:${element?.tagName ?? "?"}.${String(element?.className ?? "").slice(0, 40)}`;
          if (record.events[record.events.length - 1] !== entry) record.events.push(entry);
        },
        true
      );
    }
    // 落とし先が受け付けたか（dragover を止めたか・dropEffect）。泡の側で、各所の処理が済んだあとに読む
    document.addEventListener("dragover", (event) => {
      const record = (window as Window & { __e2eWorkbenchDrag?: { events: string[]; data: Record<string, string> } }).__e2eWorkbenchDrag;
      if (!record) return;
      const entry = `dragover-after:effect=${(event as DragEvent).dataTransfer?.dropEffect ?? "?"},prevented=${String(event.defaultPrevented)}`;
      if (record.events[record.events.length - 1] !== entry) record.events.push(entry);
    });
    /*
      dragover の対象と shiftKey を控える（ノートPCの失敗を「エクスプローラーの上から進んでいない」のか
      「エディター側まで来て IFRAME だけ来ない」のかで見分けるため）。outside は、対象がサイドバー
      （エクスプローラー）の外にあること。キャプチャ段で読む（各所が止める前の、実際の対象と修飾キー）
    */
    const over = { count: 0, last: "?", lastOutside: false, lastShift: false, sawOutsideShift: false, sawShift: false };
    (window as Window & { __e2eOver?: typeof over }).__e2eOver = over;
    document.addEventListener(
      "dragover",
      (event) => {
        const element = event.target instanceof Element ? event.target : null;
        over.count += 1;
        over.last = `${element?.tagName ?? "?"}.${String(element?.className ?? "").slice(0, 40)}`;
        over.lastOutside = element !== null && element.closest(".part.sidebar") === null;
        over.lastShift = (event as DragEvent).shiftKey;
        if (over.lastOutside && over.lastShift) over.sawOutsideShift = true;
        if (over.lastShift) over.sawShift = true;
      },
      true
    );
    // 中身はエクスプローラーが dragstart で載せ終えたあと（泡の側）に読む
    document.addEventListener("dragstart", (event) => {
      const transfer = (event as DragEvent).dataTransfer;
      const record = (window as Window & { __e2eWorkbenchDrag?: { events: string[]; data: Record<string, string> } }).__e2eWorkbenchDrag;
      if (!transfer || !record) return;
      record.data = Object.fromEntries(Array.from(transfer.types).map((type) => [type, transfer.getData(type)]));
    });
  });
}

async function workbenchDrag(page: Page): Promise<{ events: string[]; data: Record<string, string> }> {
  return page.evaluate(
    () => (window as Window & { __e2eWorkbenchDrag?: { events: string[]; data: Record<string, string> } }).__e2eWorkbenchDrag ?? { events: [], data: {} }
  );
}

interface OverState {
  count: number;
  last: string;
  lastOutside: boolean;
  lastShift: boolean;
  sawOutsideShift: boolean;
  sawShift: boolean;
}

/** 最後の dragover の対象・shiftKey・エクスプローラーの外へ出たか */
async function overState(page: Page): Promise<OverState> {
  return page.evaluate(
    () =>
      (window as Window & { __e2eOver?: { count: number; last: string; lastOutside: boolean; lastShift: boolean; sawOutsideShift: boolean; sawShift: boolean } }).__e2eOver ?? {
        count: 0,
        last: "?",
        lastOutside: false,
        lastShift: false,
        sawOutsideShift: false,
        sawShift: false,
      }
  );
}

function describeOver(state: OverState): string {
  return `最後の dragover=${state.last}／shiftKey=${String(state.lastShift)}／エクスプローラーの外=${String(state.lastOutside)}／dragover ${state.count}回／外でShiftあり=${String(state.sawOutsideShift)}／Shift付きdragover有り=${String(state.sawShift)}`;
}

/** 引きずりの 1 回の結果。`released` が false なら、離さずに取り消した（`why` に理由） */
interface DragAttempt {
  started: boolean;
  released: boolean;
  why: string;
}

/**
 * エクスプローラーの行を、相談画面の真ん中へ本物の引きずりで落とす（`shift` なら途中で Shift を押す）。
 *
 * **落とし先へは少しずつ動かし、dragover の対象がエクスプローラーの外へ出たのを見てから先へ進む。**
 * 1回で大きく動かすと、遅い機械では位置がエクスプローラーの上から先へ進まないまま離してしまい、
 * drop が誰にも届かなかった（ノートPCで Shift ありだけ3回とも落ちた）。固定の待ちは延ばさず、
 * 動かしたあとの dragover が来たかで待つ。Shift ありは、エクスプローラーの外で shiftKey 付きの
 * dragover と、WebView の枠（または覆い）への dragenter を見届けてから離す。
 * 見届けられなければ離さずに Escape で取り消し、`released: false` を返す（呼び出し側がやり直す）
 */
/**
 * 途中の様子を標準出力へ1行ずつ出し、控えにも残す。
 *
 * ノートPCでは Shift ありの件が、診断の文を出す前にテストの制限時間（180秒）で止まり、
 * どこで止まったか分からなかった（2026-11-04）。どの段まで進んだかを逐次出す
 */
const dragSteps: string[] = [];
function stepLog(text: string): void {
  const line = `[E2E 引きずり ${new Date().toISOString().slice(11, 23)}] ${text}`;
  dragSteps.push(line);
  console.log(line);
}

/** 1回の試しの上限。3回で制限時間（180秒）の手前に収まるようにする */
const ATTEMPT_LIMIT_MS = 40_000;

/** 上限を過ぎたら、そこまでの様子を添えて投げる（引きずりの途中で Playwright の操作が戻らない形を捕まえる） */
async function withAttemptLimit<T>(label: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}が ${ATTEMPT_LIMIT_MS}ms で終わりません（途中の様子：${JSON.stringify(dragSteps.slice(-40))}）`)),
      ATTEMPT_LIMIT_MS
    );
  });
  try {
    return await Promise.race([run(), limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function dragRowOntoChat(page: Page, chat: Frame, shift: boolean): Promise<DragAttempt> {
  stepLog(`始め（Shift ${shift ? "あり" : "なし"}）`);
  const row = await explorerRow(page).boundingBox();
  const frameElement = await chat.parentFrame()?.frameElement();
  const box = frameElement ? await frameElement.boundingBox() : null;
  if (!row || !box) throw new Error(`引きずりの位置が取れません（行：${JSON.stringify(row)}／面：${JSON.stringify(box)}）`);
  const startX = row.x + row.width / 2 + 20;
  const startY = row.y + row.height / 2 + 5;
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
  await page.mouse.down();
  stepLog("行の上で押した");
  // 少し動かして引きずりを始めてから Shift を押す（作者の手と同じ順。先に押すと行の範囲選択になる）
  await page.mouse.move(startX, startY, { steps: 5 });
  stepLog("最初の小さな動きを終えた");
  /*
    **dragstart が来るのを見届けてから先へ進む。** 遅い機械では dragstart が最初の小さな動きより遅れ、
    その前に先の動きへ進むと Playwright が引きずりを引き取らない。来なければこの回は諦めて指を離す
  */
  const started = await waitUntil(async () => (await workbenchDrag(page)).events.some((event) => event.startsWith("dragstart:")), "本体の文書で dragstart が起きる", 4_000)
    .then(() => true)
    .catch(() => false);
  if (!started) {
    stepLog("dragstart 来ず。指を離す");
    await page.mouse.up();
    return { started: false, released: false, why: "dragstart 来ず" };
  }
  stepLog("dragstart 来た");
  if (shift) {
    await page.keyboard.down("Shift");
    stepLog("Shift を押した");
  }
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  // 動かすたびに、その動きのあとの dragover が来る（来た数が増える）のを待つ。遅い機械では長くなり、速い機械では待たない
  const moveAndSettle = async (x: number, y: number): Promise<OverState> => {
    const before = (await overState(page)).count;
    await page.mouse.move(x, y, { steps: 2 });
    await waitUntil(async () => (await overState(page)).count > before, "動かしたあとの dragover が来る", 1_500).catch(() => undefined);
    return overState(page);
  };
  const reachedFrame = async () => (await workbenchDrag(page)).events.some((event) => /^dragenter:(IFRAME\.webview|DIV\.webview-overlay)/.test(event));
  const ready = async (state: OverState) => (shift ? state.sawShift && (await reachedFrame()) : state.lastOutside);

  // 1) エクスプローラーの外（エディター側・WebView の枠・覆い）へ出るまで、少しずつ動かす
  const STEPS = 30;
  let state = await overState(page);
  for (let i = 1; i <= STEPS && !state.lastOutside && !(await reachedFrame()); i++) {
    state = await moveAndSettle(startX + ((centerX - startX) * i) / STEPS, startY + ((centerY - startY) * i) / STEPS);
    if (i % 5 === 0) stepLog(`${i}/${STEPS}歩：${describeOver(state)}`);
  }
  stepLog(`外へ出る動きを終えた：${describeOver(state)}／枠へのdragenter=${String(await reachedFrame())}`);
  // 2) 真ん中で、Shift ありなら枠への dragenter と shiftKey 付きの dragover が揃うまで、小さく揺らして促す
  const wiggles = [0, 6, -6, 12, -12, 0];
  for (let i = 0; i < wiggles.length && !(await ready(state)); i++) {
    state = await moveAndSettle(centerX + wiggles[i], centerY + wiggles[i]);
    if (!(await ready(state))) await waitUntil(async () => ready(await overState(page)), "引きずりが落とし先に入る", 1_500).catch(() => undefined);
    state = await overState(page);
    stepLog(`揺らし ${i + 1}/${wiggles.length}：${describeOver(state)}`);
  }
  if (!(await ready(state))) {
    stepLog("落とし先に入らず。Escape で取り消す");
    /*
      離さずに取り消す。Playwright は Escape で自分の引きずりを取り消す（dragCancel を送って状態を戻す）ので、
      先に Escape、そのあとで指を離す（逆だと取り消しでなく drop になる）
    */
    await page.keyboard.press("Escape");
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
    stepLog("取り消しを終えた");
    return { started: true, released: false, why: `落とし先に入らず取り消し（${describeOver(state)}／枠へのdragenter=${String(await reachedFrame())}）` };
  }
  stepLog("落とし先に入った。指を離す");
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
  stepLog("指を離した");
  return { started: true, released: true, why: describeOver(state) };
}

/**
 * 本物の引きずりで落とし、本体の文書で drop が起きるまで、引きずりを最大3回やり直す。
 *
 * **やり直すのは、Playwright が引きずりを引き取りそこねたときだけ。** 15回に1回ほど、エクスプローラーの
 * 行で dragstart は起きたのに、drop も dragend も来ないまま終わった（2026-10-25 母艦で捕まえた。
 * 0.111.7 より前の 10-16 にも同じ形で落ちている）。Playwright は引きずりを自分で引き取って
 * 便を送り直す作りで、引き取るかどうかを「動かした直後に dragstart が来たか」で決めている
 * （playwright-core の crDragDrop）。dragstart がその見張りより遅れると、引きずりは始まったのに
 * 誰も drop を送らない——と読んだ（便の形は合うが、Playwright の中を覗いて確かめたわけではない）。ここは製品が関わる前の段なので、やり直しても製品の不具合は隠れない。
 * drop が起きたあと（落とし先がどこか・ファイルが開くか）は、やり直さずに呼び出し側が確かめる
 */
async function dragRowUntilDropped(session: E2ESession, chat: Frame, shift: boolean): Promise<void> {
  const { page } = session;
  const tries: string[] = [];
  dragSteps.length = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    stepLog(`${attempt}回目の試し`);
    await watchWorkbenchDrag(page);
    const attempted = await withAttemptLimit(`${attempt}回目の引きずり`, () => dragRowOntoChat(page, chat, shift));
    const started = attempted.started;
    const dropped = attempted.released && await waitUntil(async () => (await workbenchDrag(page)).events.some((event) => event.startsWith("drop:")), "本体の文書で drop が起きる", 5_000)
      .then(() => true)
      .catch(() => false);
    stepLog(`${attempt}回目：drop ${dropped ? "来た" : "来ず"}`);
    if (dropped) {
      // やり直して通った回は、どれだけ揺れているかが後で分かるようにログへ残す
      if (attempt > 1) console.warn(`[E2E] 引きずりを ${attempt} 回目で落とせました（前の回の本体の便：${JSON.stringify(tries)}）`);
      return;
    }
    /*
      引き取られなかった引きずりは、本体の窓の中で「引きずり中」のまま残り、次の引きずりが始まらない
      （Escape では消えず、2回目・3回目は dragstart すら来なかった。2026-10-25）。Playwright が
      取り消しに使うのと同じ dragCancel の便を本体の窓へ送って終わらせてから、やり直す
    */
    await withAttemptLimit(`${attempt}回目の引きずりの取り消し`, async () => {
      stepLog("dragCancel を送る");
      const cdp = await session.app.context().newCDPSession(page);
      try {
        await cdp.send("Input.dispatchDragEvent", { type: "dragCancel", x: 0, y: 0, data: { items: [], dragOperationsMask: 65535 } }).catch(() => undefined);
      } finally {
        await cdp.detach().catch(() => undefined);
      }
      await page.keyboard.press("Escape");
      stepLog("dragCancel と Escape を送った");
    });
    /*
      引きずり状態が戻ったこと（dragend が来たか）を確かめてから次の回へ進む。固定の待ちでなく起きたことで
      待つ。dragstart が来なかった回は始まっていないので dragend も来ない（それは正常）。
      戻らないまま次へ進んでも失敗の文に残るよう、戻ったかを回の記録に書く
    */
    const ended = started
      ? await waitUntil(async () => (await workbenchDrag(page)).events.some((event) => event.startsWith("dragend:")), "引きずりが終わる（dragend）", 2_000)
          .then(() => true)
          .catch(() => false)
      : true;
    tries.push(`${attempt}回目：${started ? "dragstart 来た" : "dragstart 来ず"}／${attempted.released ? "離した" : "離さず"}／${attempted.why}／dragend ${started ? (ended ? "来た" : "来ず") : "不要"}／便=${JSON.stringify((await workbenchDrag(page)).events)}`);
  }
  throw new Error(
    `本体の文書で drop が起きるまで3回引きずりましたが、起きません（回ごとの様子：${JSON.stringify(tries)}／面に来た便：${JSON.stringify(await dragsInChat(chat))}／タブ：${JSON.stringify(await editorGroupTabs(page))}）`
  );
}

/** 相談画面の WebView の外側の枠（別プロセスの枠）への CDP の口と、その枠の大きさ */
async function chatFrameSession(session: E2ESession, chat: Frame): Promise<{ cdp: CDPSession; width: number; height: number }> {
  const outer = chat.parentFrame();
  if (!outer) throw new Error("WebView の外側の枠が見つかりません");
  const element = await outer.frameElement();
  const box = await element.boundingBox();
  if (!box) throw new Error("WebView の枠の大きさが取れません");
  const cdp = await session.app.context().newCDPSession(outer);
  return { cdp, width: box.width, height: box.height };
}

/** WebView の枠の中へ、引きずりの便（入る → 上を動く → 落とす）を Shift つきで送る */
async function dropIntoChatFrame(
  session: E2ESession,
  chat: Frame,
  data: { items: Array<{ mimeType: string; data: string }>; files?: string[] }
): Promise<void> {
  const { cdp, width, height } = await chatFrameSession(session, chat);
  // コピー・移動・リンクのどれでも受けられると申告する（エクスプローラーの引きずりと同じく、受け手が選ぶ）
  const dragData = { ...data, dragOperationsMask: 1 | 2 | 16 };
  const at = { x: width / 2, y: height / 2 };
  try {
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await cdp.send("Input.dispatchDragEvent", { type, ...at, data: dragData, modifiers: 8 });
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** 照合の確認が開くまで待ち、文を返す */
async function waitForMatchDialog(page: Page, chat: Frame): Promise<string> {
  await waitUntil(async () => (await dialogText(page)) !== undefined, "照合の確認の窓が開く", 20_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（相談画面の末尾：${JSON.stringify((await chatLog(chat)).slice(-300))}／面に来た便：${JSON.stringify(await dragsInChat(chat))}）`);
  });
  return (await dialogText(page)) ?? "";
}

/** 書庫に、見本の作品以外のフォルダーができていないか（取り込みを取りやめたので、できないはず） */
async function libraryFolders(session: E2ESession): Promise<string[]> {
  const entries = await readdir(path.dirname(session.workFolder), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

test("エクスプローラーの行を Shift なしで相談画面へ落とすと、VS Code が横取りしてファイルを開き、相談画面には何も届かない", async () => {
  await withVsCode(
    "相談へ落とす：Shift なし",
    [{ name: "001_はじまり.txt", text: "本文。\n" }],
    async (session) => {
      const { page } = session;
      const chat = await openChatBesideExplorer(page);
      const logBefore = await chatLog(chat);

      await dragRowUntilDropped(session, chat, false);
      await waitUntil(async () => tabNamesInclude((await editorGroupTabs(page)).flat(), BACKUP_NAME), "落としたファイルがエディターで開く", 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（タブ：${JSON.stringify(await editorGroupTabs(page))}／本体の便：${JSON.stringify((await workbenchDrag(page)).events)}）`);
        }
      );
      const drag = await workbenchDrag(page);
      expect(drag.events[0], `本物の引きずりがエクスプローラーの行から始まった（${JSON.stringify(drag.events)}）`).toMatch(/^dragstart:.*monaco-list-row/);
      expect(
        drag.events.some((event) => event.startsWith("drop:") && !event.startsWith("drop:IFRAME")),
        `落とし先は WebView ではなく本体の側（${JSON.stringify(drag.events)}）`
      ).toBe(true);

      // 相談画面には何も届かない：便も、受け取りの行も、照合の確認も無い
      await holdsFor(async () => (await dialogText(page)) === undefined, "照合の確認が開かない", 3_000);
      expect(await dragsInChat(chat), "相談画面の中に引きずりの便は来ない").toEqual([]);
      await activateTab(page, CHAT_TAB);
      expect(await chatLog(chat), "相談画面に受け取りの行は出ない").toBe(logBefore);
      expect(await libraryFolders(session)).toEqual([path.basename(session.workFolder)]);
    },
    LAUNCH
  );
}, 180_000);

test("エクスプローラーの行を Shift を押しながら相談画面へ落とすと、VS Code は横取りせず、WebView に落ちた中身から照合の確認が開く", async () => {
  await withVsCode(
    "相談へ落とす：Shift あり",
    [{ name: "001_はじまり.txt", text: "本文。\n" }],
    async (session) => {
      const { page } = session;
      const chat = await openChatBesideExplorer(page);

      // 1段目：本物の引きずり。VS Code は横取りせず、落とし先は WebView の <iframe> 要素になる
      await dragRowUntilDropped(session, chat, true);
      const drag = await workbenchDrag(page);
      expect(drag.events[0], `本物の引きずりがエクスプローラーの行から始まった（${JSON.stringify(drag.events)}）`).toMatch(/^dragstart:.*monaco-list-row/);
      expect(drag.events.find((event) => event.startsWith("drop:")), `落とし先は WebView の枠（${JSON.stringify(drag.events)}）`).toMatch(/^drop:IFRAME\.webview/);
      await holdsFor(async () => !tabNamesInclude((await editorGroupTabs(page)).flat(), BACKUP_NAME), "VS Code がファイルを開かない（横取りしない）", 3_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（タブ：${JSON.stringify(await editorGroupTabs(page))}）`);
        }
      );
      // エクスプローラーが載せた中身に、ファイルの場所（uri-list）がある
      const uriList = drag.data["application/vnd.code.uri-list"] ?? drag.data["text/uri-list"] ?? "";
      expect(uriList, `引きずりの中身：${JSON.stringify(Object.keys(drag.data))}`).toContain(BACKUP_NAME);

      // 2段目：同じ中身を WebView の中へ（Shift つき）。製品の受け口が場所を拡張機能へ渡し、照合の確認が開く
      const items = Object.entries(drag.data).map(([mimeType, value]) => ({ mimeType, data: value }));
      await dropIntoChatFrame(session, chat, { items });
      const dialog = await waitForMatchDialog(page, chat);
      expect(await dragsInChat(chat), "相談画面の中に Shift つきの drop が来た").toContain("drop:shift=true");
      expect(await chatLog(chat)).toContain(`「${BACKUP_NAME}」を受け取りました。どの作品のものか確かめています…`);
      expect(dialog).toContain("登録済みの作品には見当たりませんでした。新しい作品として取り込みますか？");
      expect(dialog).toContain("話の数：1話");

      await pressDialogButton(page, "Cancel");
      await holdsFor(async () => (await dialogText(page)) === undefined, "確認を閉じたあと次の窓が出ない", 2_000);
      expect(await libraryFolders(session), "取りやめたので、新しい作品はできない").toEqual([path.basename(session.workFolder)]);
    },
    LAUNCH
  );
}, 180_000);

test("OS のエクスプローラーからファイルを相談画面へ落とすと（WebView にファイルが落ちると）、照合の確認が開く", async () => {
  await withVsCode(
    "相談へ落とす：OS から",
    [{ name: "001_はじまり.txt", text: "本文。\n" }],
    async (session) => {
      const { page } = session;
      const chat = await openChatBesideExplorer(page);
      const file = path.join(path.dirname(session.workFolder), BACKUP_NAME);
      await dropIntoChatFrame(session, chat, { items: [], files: [file] });
      const dialog = await waitForMatchDialog(page, chat);
      expect(await chatLog(chat)).toContain(`「${BACKUP_NAME}」を受け取りました`);
      expect(dialog).toContain("登録済みの作品には見当たりませんでした。新しい作品として取り込みますか？");
      await pressDialogButton(page, "Cancel");
      expect(await libraryFolders(session), "取りやめたので、新しい作品はできない").toEqual([path.basename(session.workFolder)]);
    },
    LAUNCH
  );
}, 180_000);
