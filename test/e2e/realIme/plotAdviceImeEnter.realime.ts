/**
 * 本物の日本語入力（オリジナルIME）で、プロットモードの相談の欄に打つとき、**変換中の Enter は確定だけで、送らない**
 * （2026-11-16。製品：オリジナルIME からの頼み）。
 *
 * 欄の Enter の守りは `views/imeEnterGuardScript.ts`。Windows の日本語入力では、compositionend のあとに確定の Enter が
 * isComposing=false・keyCode 13 で届くことがあり、isComposing と 229 だけの見分けをすり抜けて送っていた（作者の実機、
 * 2026-10-19）。Playwright の変換の口では、この順番の崩れが起きないので、本物の IME で確かめる。
 *
 * 確かめること：
 * 1. ひらがなのまま Enter で確定 → 欄に字が残り、相談は送られない
 * 2. 漢字に変換して Enter で確定 → 同じ
 * 3. **変換していない Enter では送る**（何もしない作りでも 1・2 は通るので、送れることも確かめる）
 *
 * **流すのは作者がこの PC を使っていないときだけ**。門は `NOVELAI_REAL_IME=1`。AI は偽の Ollama。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Frame } from "playwright-core";
import { openPlotMode } from "../look/nameLookSupport";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "../support/fakeOllama";
import { SIDEBAR_LAUNCH } from "../support/sidebar";
import { waitUntil } from "../support/wait";
import { REAL_IME_ENABLED, runRealImeTest } from "./support/imeBridge";

const INPUT = "#adviceInput";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => "了解しました。");
});
afterAll(async () => {
  await fake?.close();
});

async function authorTurns(plot: Frame): Promise<number> {
  return await plot.locator(".advice-turn.author").count();
}

async function inputValue(plot: Frame): Promise<string> {
  return await plot.locator(INPUT).inputValue();
}

test.skipIf(!REAL_IME_ENABLED)("本物の IME：プロットモードの相談の欄で、変換中の Enter は確定だけで送らない（変換していない Enter では送る）", async (ctx) => {
  await runRealImeTest(
    ctx,
    "プロットモード 相談の欄の Enter",
    [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
    async (session, ime) => {
      const plot = await openPlotMode(session);
      await waitUntil(async () => await plot.locator(INPUT).isVisible(), "相談の欄が出る", 30_000);
      const requestsBefore = fake.requests.length;
      const turnsBefore = await authorTurns(plot);

      // 1. ひらがなのまま Enter で確定
      await ime.type(plot, ["romaji:aa", "wait:300", "key:ENTER", "wait:800"], { focus: INPUT });
      await waitUntil(async () => (await inputValue(plot)).includes("ああ"), "ひらがなが欄に確定する", 15_000);
      await session.page.waitForTimeout(1_500);
      expect(await authorTurns(plot), "ひらがなの確定の Enter で相談が送られた").toBe(turnsBefore);
      expect(fake.requests.length, describeFakeRequests(fake.requests, requestsBefore)).toBe(requestsBefore);

      // 2. 漢字に変換して Enter で確定
      const beforeKanji = await inputValue(plot);
      await ime.type(plot, ["romaji:kawa", "wait:300", "key:SPACE", "wait:600", "key:ENTER", "wait:800"], { focus: INPUT });
      await waitUntil(
        async () => {
          const value = await inputValue(plot);
          return value.length > beforeKanji.length && !/[a-z]/.test(value);
        },
        "変換した字が欄に確定する",
        15_000
      );
      await session.page.waitForTimeout(1_500);
      const confirmed = await inputValue(plot);
      console.error(`[本物のIME] 相談の欄：確定したあとの欄「${confirmed}」`);
      expect(await authorTurns(plot), `変換の確定の Enter で相談が送られた（欄「${confirmed}」）`).toBe(turnsBefore);
      expect(fake.requests.length, describeFakeRequests(fake.requests, requestsBefore)).toBe(requestsBefore);

      // 3. 変換していない Enter では送る
      await ime.type(plot, ["key:ENTER"], { focus: INPUT });
      await waitUntil(
        async () => {
          await passLocalAiGate(session.page);
          return (await authorTurns(plot)) > turnsBefore;
        },
        "変換していない Enter で相談が送られる",
        30_000
      );
      await ctx.annotate(`確定したあとの欄「${confirmed}」`, "相談の欄");
    },
    fakeOllamaLaunch(fake, {
      ...SIDEBAR_LAUNCH,
      settings: {
        ...SIDEBAR_LAUNCH.settings,
        "workbench.editorAssociations": { "*.txt": "novelai.manuscriptEditorHorizontal", "*.md": "default" },
      },
      prepareWork: async ({ workFolder }) => {
        await mkdir(path.join(workFolder, "設定"), { recursive: true });
        await writeFile(path.join(workFolder, "設定", "plot.md"), "# 見本の物語\n\n## 主要登場人物\n- 主人公：高校生。\n", "utf8");
      },
    })
  );
});
