/**
 * 設定「変換中の線」（`novelai.compositionLine`）で入力欄が切り替わる（画面の自動テスト。
 * 設計書6.25.2 の【裁定】2026-11-16 夜・6.113）。
 *
 * 何を見張るか：
 * - **既定（左）では今までの面**（組んで書く面）が使われ、右傍線の入力欄（#rline）は出ない
 * - 縦書きで右を選ぶと右傍線の入力欄が出て、打った字が原稿ファイルへ届く。打った字のほかは
 *   1字も変わらない
 * - 右を選んでいても、横書きでは今までの面。縦書きにすると右の入力欄、横書きへ戻すと組んで書く面へ戻る
 *
 * 日本語入力の本物の変換（線が右に出るか・候補の窓の位置）は、ここでは見張れない
 * （字は確定した形で入る）。本物の IME の試しと作者の手で確かめる。
 *
 * **作者の原稿は使わない。AI は呼ばない。**
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { clickToolButton, openEpisode } from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";

const EPISODE = "001_変換中の線.md";
const MARKER = "朝の駅は静かだった。";
const TEXT = `　${MARKER}\n　改札を抜けて、白い息を吐いた。\n`;
const TYPED = "【右】";

async function readEpisode(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
}

/** 面の様子（待ちで落ちたときに添える） */
async function surfaceState(frame: Frame): Promise<string> {
  return frame
    .evaluate(() => {
      const shown = (id: string) => {
        const el = document.getElementById(id);
        return el ? getComputedStyle(el).display : "無い";
      };
      return JSON.stringify({
        body: document.body.className,
        write: shown("write"),
        compose: shown("compose"),
        rline: shown("rline"),
        editContext: "EditContext" in window,
        note: document.getElementById("note")?.textContent ?? "",
      });
    })
    .catch((error: unknown) => `（読めない：${String(error)}）`);
}

/** 右傍線の入力欄に出ている字（カーソルの印の見えない字は除く） */
async function rlineText(frame: Frame): Promise<string> {
  return frame.evaluate(() => (document.getElementById("rline")?.textContent ?? "").replace(/​/g, ""));
}

async function rlineShown(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const el = document.getElementById("rline");
    return document.body.classList.contains("rline") && !!el && getComputedStyle(el).display !== "none";
  });
}

async function typeAndSave(session: E2ESession, frame: Frame): Promise<void> {
  const { page } = session;
  // 欄を押して焦点を移す（押した点にカーソルが置かれる）
  await frame.locator("#rline").click();
  await page.keyboard.insertText(TYPED);
  await waitUntil(async () => (await rlineText(frame)).includes(TYPED), "右傍線の入力欄に打った字が出る").catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（面：${await surfaceState(frame)}／欄：${JSON.stringify(await rlineText(frame))}）`);
    }
  );
  // 打った字の便が本体へ着いて当たるのを待ってから保存する
  await page.waitForTimeout(800);
  await page.keyboard.press("ControlOrMeta+KeyS");
  await waitUntil(async () => (await readEpisode(session)).includes(TYPED), "打った字が原稿ファイルに入る").catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（ファイル：${JSON.stringify(await readEpisode(session))}）`);
    }
  );
}

test("既定（左）では、今までの面を使い、右傍線の入力欄は出ない", async () => {
  await withVsCode("変換中の線・既定", [{ name: EPISODE, text: TEXT }], async (session) => {
    const { page } = session;
    // E2E の設定は *.txt を横書きの入口に結んでいるので、開いたあと［縦書き］を押す（Mac の 1.0.21 の流しで分かった）
    const frame = await openEpisode(page, EPISODE, MARKER);
    await clickToolButton(frame, "dir");
    await waitUntil(async () => (await surfaceState(frame)).includes("vertical"), "［縦書き］で縦書きの面になる").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（面：${await surfaceState(frame)}）`);
      }
    );
    const state = await surfaceState(frame);
    const parsed = JSON.parse(state) as { body: string; compose: string; rline: string };
    expect(parsed.body, `縦書きの組んで書く面で開く：${state}`).toContain("vertical");
    expect(parsed.body, `組んで書く面：${state}`).toContain("compose");
    expect(parsed.compose, `組んで書く面が出ている：${state}`).not.toBe("none");
    expect(parsed.rline, `右傍線の入力欄は出ない：${state}`).toBe("none");
    // 遅れて切り替わらない
    await holdsFor(async () => !(await rlineShown(frame)), "既定で右の入力欄に切り替わらないこと", 2_000);
  });
}, 180_000);

test("縦書きで右を選ぶと右傍線の入力欄が出て、打った字が原稿ファイルへ届く", async () => {
  await withVsCode(
    "変換中の線・右",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      // 横書きの入口で開き（右でも横書きでは組んで書く面）、［縦書き］で右傍線の入力欄へ
      const frame = await openEpisode(page, EPISODE, MARKER);
      await clickToolButton(frame, "dir");
      await waitUntil(async () => (await rlineText(frame).catch(() => "")).includes(MARKER), "縦書きにすると右傍線の入力欄に本文が出る").catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（面：${await surfaceState(frame)}）`);
        }
      );
      expect(await rlineShown(frame), `右傍線の入力欄が出る：${await surfaceState(frame)}`).toBe(true);
      const state = JSON.parse(await surfaceState(frame)) as { compose: string; write: string; editContext: boolean };
      expect(state.editContext, "テスト用の VS Code に EditContext がある").toBe(true);
      expect(state.compose).toBe("none");
      expect(state.write).toBe("none");

      await typeAndSave(session, frame);
      // 打った字のほかは1字も変わらない（書き戻しは今までの道で、変わった1か所だけ）
      const saved = await readEpisode(session);
      expect(saved.replace(TYPED, "")).toBe(TEXT);
      expect(saved.split(TYPED).length - 1, "打った字は1回だけ入る").toBe(1);
    },
    { settings: { "novelai.compositionLine": "right" } }
  );
}, 180_000);

test("右を選んでいても横書きでは今までの面。縦書きにすると右の入力欄、横書きへ戻すと組んで書く面", async () => {
  await withVsCode(
    "変換中の線・横書き",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      // 横書きで開く（組んで書く面に本文が出る）
      const frame = await openEpisode(page, EPISODE, MARKER);
      const before = JSON.parse(await surfaceState(frame)) as { body: string; rline: string };
      expect(before.body).not.toContain("vertical");
      expect(before.body).toContain("compose");
      expect(before.rline).toBe("none");
      await holdsFor(async () => !(await rlineShown(frame)), "横書きのあいだ右の入力欄に切り替わらないこと", 2_000);

      // 縦書きにする → 右傍線の入力欄
      await clickToolButton(frame, "dir");
      await waitUntil(async () => rlineShown(frame), "縦書きにすると右傍線の入力欄が出る").catch(async (error: unknown) => {
        throw new Error(`${String(error)}（面：${await surfaceState(frame)}）`);
      });
      expect(await rlineText(frame)).toContain(MARKER);

      // 横書きへ戻す → 組んで書く面へ戻る（組んで書くの覚えが消えていない）
      await clickToolButton(frame, "dir");
      await waitUntil(
        async () => {
          const now = JSON.parse(await surfaceState(frame)) as { body: string; rline: string };
          return now.body.includes("compose") && now.rline === "none";
        },
        "横書きへ戻すと組んで書く面へ戻る"
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（面：${await surfaceState(frame)}）`);
      });
      const shown = await frame.evaluate(() => document.getElementById("compose")?.innerText ?? "");
      expect(shown).toContain(MARKER);
      // 行き来しただけで、原稿は変わらない
      expect(await readEpisode(session)).toBe(TEXT);
    },
    { settings: { "novelai.compositionLine": "right", "novelai.manuscriptEditor.vertical": false } }
  );
}, 180_000);
