/**
 * 拡張機能は応えるが、打った字が原稿へ入らないときの知らせと［開き直す］（画面の自動テスト、
 * 設計書6.25.9・6.113。実機確認リスト 289 の残り。仕分け 2026-10-15 の「E・未着手・難」）。
 *
 * 289 のうち「拡張機能から何も届かない」場合は `restartAndDisconnect.test.ts` が覆っている
 * （2段目で［開き直す］を出さず、ウィンドウの再読み込みを案内する）。ここで見るのは、
 * **拡張機能は生きていて画面へ便を送ってくるが、打った字だけが原稿へ入らない**場合である。
 *
 * 何を見張るか：
 * 1. 打った字が入らないと、4秒で赤字の知らせ（1段目「送り直しています（N秒）」）が出て、30秒で
 *    2段目「入りません。［本文をコピー］で控えてから、［開き直す］を押してください」へ変わり、
 *    ［開き直す］が**出るが押せない**。［本文をコピー］で押せるようになる。
 *    ［開き直す］で同じ話が開き直り（2枚目のタブはできない）、開き直した画面の上に
 *    「前回、原稿に入らなかった字があります」と［戻す］が出る。［戻す］→ 保存で、打った字が
 *    ファイルに入る
 * 2. 項目の「［開き直す］で3秒後に『ウィンドウの再読み込み』の案内が出るか」：拡張機能が
 *    開き直しの頼み（reopen）を受け取れなかったとき、3秒で再読み込みを案内する
 *
 * **入らない状態は、画面から拡張機能へ向かう「打った字の便」（edit）だけを WebView の外側の枠で
 * 落として作る**（`support/manuscriptFrame.ts` の `dropEditsToHost`。製品には何も足さない）。
 * 288 と違い、拡張機能から画面への便（字数の知らせ等）は止めないので、画面は「相手はいる」と
 * 判断して2段目に［開き直す］を出す。［開き直す］の頼みは edit ではないので届き、開き直した
 * 画面は新しい枠で作られるので、そこからは打った字の便も届く。
 *
 * 最初は VS Code の設定 `files.readonlyInclude` で本文を読み取り専用にして「書き込みだけ通らない」を
 * 作ろうとしたが、1.141.0 では拡張機能の `applyEdit` が**通ってしまい**（true が返り、メモリ上の文書に
 * 字が入るのにタブに未保存の印が付かない）、この形にはならなかった（2026-10-15 母艦で確かめた）。
 *
 * **項目の前提と実装が違っていたところ**（変えずに報告する）：
 * - 項目は「［開き直す］で3秒後に再読み込みの案内」と書くが、拡張機能が生きていれば
 *   開き直しの返事（reopenAccepted）が届き、案内は出ずにその場で開き直る（1件目）。
 *   3秒の案内は、開き直しの頼みが拡張機能へ届かないときだけ出る（2件目。頼みの便だけを
 *   外側の枠で落として作る）
 *
 * **［本文をコピー］は押すが、OS のクリップボードは書き換えない。** 画面の内側の
 * `document.execCommand("copy")` をこのテストの中だけ差し替え、写そうとした字を控えて
 * 「写せた」と返す（テストを走らせる機械で作者が控えたものを消さないため。
 * `restartAndDisconnect.test.ts` の 288 と同じ考え）。押したときの製品の道（copyForRescue）は
 * そのまま通る。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { actionLogLines } from "./support/nameCheckPanel";
import { classOpen, dropEditsToHost, openEpisode, placeCaretAfter, rescueBarText, waitForManuscriptFrame } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, countTabsNamed, editorGroupTabs, notificationTexts, pressWorkbenchKey } from "./support/workbenchDom";

const EPISODE = "001_入らない字.txt";
const FIRST_LINE = "　一行目の文。";
const TYPED = "乙丙";

const SAVE_KEY = "ctrl+alt+shift+s";
const SAVE_PRESS = "Control+Alt+Shift+KeyS";
const LAUNCH = { keybindings: [{ key: SAVE_KEY, command: "workbench.action.files.save" }] };

async function unsentText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("unsentText")?.textContent ?? "").catch(() => "");
}

async function reopenButtonState(frame: Frame): Promise<{ hidden: boolean; disabled: boolean }> {
  return frame.evaluate(() => {
    const button = document.getElementById("unsentReopen") as HTMLButtonElement | null;
    return { hidden: button?.hidden ?? true, disabled: button?.disabled ?? true };
  });
}

async function readEpisode(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

/**
 * 画面の内側の `document.execCommand("copy")` を、このテストの中だけ差し替える。
 * 写そうとした字（製品が一時の入力欄へ入れて選んだ字）を `window.__e2eCopied` に控え、
 * 「写せた」と返す。OS のクリップボードには触らない
 */
async function captureCopies(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const target = window as Window & { __e2eCopied?: string[] };
    if (target.__e2eCopied) return;
    target.__e2eCopied = [];
    const original = document.execCommand.bind(document);
    document.execCommand = ((command: string, ...rest: unknown[]) => {
      if (command === "copy") {
        const active = document.activeElement;
        const text = active instanceof HTMLTextAreaElement ? active.value : String(window.getSelection() ?? "");
        target.__e2eCopied?.push(text);
        return true;
      }
      return (original as (...args: unknown[]) => boolean)(command, ...rest);
    }) as typeof document.execCommand;
  });
}

async function copiedTexts(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => (window as Window & { __e2eCopied?: string[] }).__e2eCopied ?? []);
}

/**
 * 画面から拡張機能へ向かう「開き直しの頼み」（reopen）だけを、WebView の外側の枠で落とす。
 * 作りは `dropEditsToHost` と同じ（外側の枠の MessagePort をくるむ。製品には何も足さない）
 */
async function dropReopenToHost(frame: Frame): Promise<void> {
  const outer = frame.parentFrame();
  if (!outer) throw new Error("WebView の外側の枠が見つかりません");
  await outer.evaluate(() => {
    const proto = MessagePort.prototype as MessagePort & { __e2eDropReopen?: boolean };
    if (proto.__e2eDropReopen) return;
    proto.__e2eDropReopen = true;
    const original = proto.postMessage;
    proto.postMessage = function (this: MessagePort, ...args: unknown[]) {
      const message = args[0] as { channel?: string; data?: { message?: { type?: string } } } | undefined;
      if (message?.channel === "onmessage" && message.data?.message?.type === "reopen") return;
      return (original as (...rest: unknown[]) => void).apply(this, args);
    } as typeof proto.postMessage;
  });
}

/**
 * 打った字の便を落としてから打ち、4秒で1段目 → 30秒で2段目（［開き直す］が出るが押せない）→
 * ［本文をコピー］で押せる、まで進める。両方の件で同じ道を通るので1つにまとめた
 */
async function typeUntilReopenEnabled(session: E2ESession, frame: Frame): Promise<void> {
  const { page } = session;
  await dropEditsToHost(frame);
  await placeCaretAfter(frame, FIRST_LINE);
  const typedAt = Date.now();
  await page.keyboard.insertText(TYPED);

  await waitUntil(() => classOpen(frame, "unsent"), "入らない字の赤字が出る", 20_000).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（いまの文：${JSON.stringify(await unsentText(frame))}／知らせ：${JSON.stringify(await notificationTexts(page))}）`
    );
  });
  const shownAfter = Date.now() - typedAt;
  expect(shownAfter, `打ってから赤字が出るまで ${shownAfter}ms（製品の待ちは4秒）`).toBeGreaterThanOrEqual(3_500);
  const first = await unsentText(frame);
  expect(first, `1段目の文：${JSON.stringify(first)}`).toMatch(/打った字を原稿へ送り直しています（\d+秒）/);
  expect((await reopenButtonState(frame)).hidden, "1段目では［開き直す］は出ない").toBe(true);

  // 30秒で2段目。拡張機能からの便は届いているので［開き直す］を出す（コピーするまで押せない）
  await waitUntil(async () => (await unsentText(frame)).includes("打った字が原稿に入りません"), "30秒で2段目（入りません）に変わる", 45_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（いまの文：${JSON.stringify(await unsentText(frame))}）`);
    }
  );
  const second = await unsentText(frame);
  expect(second).toContain("［本文をコピー］で控えてから、［開き直す］を押してください");
  expect(second, "相手がいるのに再読み込みへ誘わない").not.toContain("ウィンドウの再読み込み");
  expect(second, "タブを閉じる道へ誘わない").toContain("タブは閉じないでください");
  expect(await reopenButtonState(frame), "2段目：［開き直す］は出るが、コピーするまで押せない").toEqual({ hidden: false, disabled: true });

  // ［本文をコピー］で［開き直す］が押せるようになる
  await captureCopies(frame);
  await frame.locator("#unsentCopy").click();
  await waitUntil(async () => !(await reopenButtonState(frame)).disabled, "［本文をコピー］のあと［開き直す］が押せる", 5_000);
  const copied = await copiedTexts(frame);
  expect(copied.length, "［本文をコピー］で1回写した").toBe(1);
  expect(copied[0], "写した本文に打った字が入っている").toContain(`${FIRST_LINE}${TYPED}`);
  const afterCopy = await unsentText(frame);
  expect(afterCopy).toContain("クリップボードへ写しました");
  expect(afterCopy).toContain("［開き直す］を押してください");

  // 打った字はファイルに入っていない
  expect(await readEpisode(session), "入らないはずの字がファイルに入りました").toBe(`${FIRST_LINE}\n`);
}

test("拡張機能は応えるが打った字が原稿へ入らないと、30秒で［開き直す］が出て［本文をコピー］で押せるようになり、押すと同じ話が1枚のまま開き直って「前回、原稿に入らなかった字」が出て、［戻す］と保存で字がファイルに入る", async () => {
  await withVsCode(
    "入らない字：開き直す",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "一行目の文");
      await typeUntilReopenEnabled(session, frame);
      await clearNotifications(page);

      // ［開き直す］：拡張機能が受け取り、同じ話を開き直す
      await frame.locator("#unsentReopen").click();
      const reopened = await waitForManuscriptFrame(page, "一行目の文", "開き直した原稿エディターの面", 30_000);
      await waitUntil(() => classOpen(reopened, "rescue"), "開き直した画面の上に控えの帯が出る", 20_000).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（帯：${JSON.stringify(await rescueBarText(reopened))}／タブ：${JSON.stringify(await editorGroupTabs(page))}／操作ログの末尾：${JSON.stringify((await actionLogLines(session)).slice(-8))}）`
        );
      });
      const bar = await rescueBarText(reopened);
      expect(bar, `帯の文：${JSON.stringify(bar)}`).toMatch(/前回、原稿に入らなかった字があります（\d+字の差）/);
      expect(await reopened.locator("#rescueRestore").isVisible(), "［戻す］がある").toBe(true);
      expect(await classOpen(reopened, "unsent"), "開き直した画面には赤字の知らせは無い").toBe(false);

      // 同じ話の2枚目ができない
      await holdsFor(async () => countTabsNamed((await editorGroupTabs(page)).flat(), EPISODE) === 1, "同じ話のタブが1枚だけ", 3_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（タブ：${JSON.stringify(await editorGroupTabs(page))}）`);
        }
      );
      expect(await readEpisode(session), "開き直しただけではファイルは変わらない").toBe(`${FIRST_LINE}\n`);

      // ［戻す］→ 本文に字が戻る → 保存でファイルに入る（開き直した画面は新しい枠なので、便は届く）
      await reopened.locator("#rescueRestore").click();
      await waitUntil(
        async () => !(await classOpen(reopened, "rescue")) && (await reopened.evaluate(() => document.body.innerText)).includes(`一行目の文。${TYPED}`),
        "［戻す］で打った字が本文へ戻る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(
          `${String(error)}（帯：${JSON.stringify(await rescueBarText(reopened))}／赤字：${JSON.stringify(await unsentText(reopened))}）`
        );
      });
      await waitUntil(
        async () => {
          await pressWorkbenchKey(page, SAVE_PRESS);
          return (await readEpisode(session)) === `${FIRST_LINE}${TYPED}\n`;
        },
        "保存で打った字がファイルに入る",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（ファイル：${JSON.stringify(await readEpisode(session))}）`);
      });
    },
    LAUNCH
  );
}, 240_000);

test("拡張機能は応えるが打った字が原稿へ入らないとき、［開き直す］の頼みが拡張機能へ届かなければ、3秒で「ウィンドウの再読み込み」を案内する", async () => {
  await withVsCode(
    "入らない字：開き直しが届かない",
    [{ name: EPISODE, text: `${FIRST_LINE}\n` }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "一行目の文");
      await typeUntilReopenEnabled(session, frame);
      await clearNotifications(page);

      await dropReopenToHost(frame);
      const pressedAt = Date.now();
      await frame.locator("#unsentReopen").click();
      expect(await unsentText(frame), "押した直後は頼んでいる最中の文").toContain("開き直しを頼んでいます");
      await waitUntil(async () => (await unsentText(frame)).includes("拡張機能に届きません"), "3秒で再読み込みの案内に変わる", 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（いまの文：${JSON.stringify(await unsentText(frame))}）`);
        }
      );
      const waited = Date.now() - pressedAt;
      expect(waited, `押してから案内まで ${waited}ms（製品の待ちは3秒）`).toBeGreaterThanOrEqual(2_500);
      const guide = await unsentText(frame);
      expect(guide).toContain("コマンドパレット（Ctrl+Shift+P）で「開発者: ウィンドウの再読み込み」を実行してください");
      expect(guide).toContain("開き直した画面で、打った字を戻せます");
      expect((await reopenButtonState(frame)).disabled, "頼んだあとは［開き直す］を押し直せない").toBe(true);

      // 開き直してはいない：タブは1枚のまま、ファイルも変わらない
      await holdsFor(async () => countTabsNamed((await editorGroupTabs(page)).flat(), EPISODE) === 1, "タブは1枚のまま", 2_000);
      expect(await readEpisode(session), "入らないはずの字がファイルに入りました").toBe(`${FIRST_LINE}\n`);
    },
    LAUNCH
  );
}, 240_000);
