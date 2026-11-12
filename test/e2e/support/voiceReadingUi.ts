/**
 * 読み上げの列（人物の声）を押す画面の部品。`voiceEngineChoiceFlow.test.ts` の中の同じ部品の写しで、
 * エンジンを混ぜる件（`voiceEngineMixFlow.test.ts`）・頭の欄を読まない件・端末名の窓の件が使う
 * （2026-11-12。既存の件は触らず、重なりは写しで持つ）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { clickToolButton, openEpisode } from "./manuscriptFrame";
import { describeNotices } from "./noticeRecord";
import type { E2ESession } from "./vscodeApp";
import { waitUntil } from "./wait";
import { dialogText } from "./workbenchDom";
import type { VoiceEngineId } from "../../../src/core/voiceEngine";

/** 面の中の OS の声を偽物に替える（読む文を `__e2eSpoken` へ控える。音は出ない） */
export async function installFakeOsVoice(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const spoken: string[] = [];
    (window as unknown as { __e2eSpoken: string[] }).__e2eSpoken = spoken;
    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    const fake = {
      speaking: false,
      paused: false,
      getVoices: () => [{ name: "E2E 日本語", lang: "ja-JP" }],
      speak: (utterance: FakeUtterance) => {
        spoken.push(utterance.text);
      },
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      addEventListener: () => undefined,
    };
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true, writable: true });
    Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true });
  });
}

export async function aloudNote(frame: Frame): Promise<string> {
  return frame.locator("#aloudNote").innerText().catch(() => "");
}

/** 話を開き、偽の OS の声を入れ、読み上げの列を出して、人物の声が選べるまで待つ */
export async function openReadingRow(session: E2ESession, episode: string, marker: string): Promise<Frame> {
  const frame = await openEpisode(session.page, episode, marker);
  await installFakeOsVoice(frame);
  await clickToolButton(frame, "aloudToggle");
  await waitUntil(
    async () => (await frame.locator('#aloudEngine option[value="aivisspeech"]').isDisabled().catch(() => true)) === false,
    "［声］で人物の声が選べる",
    20_000
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列の注：${JSON.stringify(await aloudNote(frame))}）`);
  });
  return frame;
}

/** 読み上げの列のボタン（列は上の段の外にあるので `clickToolButton` は使えない） */
export async function clickAloudButton(frame: Frame, id: "aloudVoiceAssign" | "aloudVoiceExport"): Promise<void> {
  await waitUntil(async () => frame.locator(`#${id}`).isVisible().catch(() => false), `読み上げの列に #${id} が出る`, 10_000);
  await frame.locator(`#${id}`).click();
}

/** ［声］をそのエンジンにして、［▶ 読む］が押せるまで待つ */
export async function chooseEngine(frame: Frame, choice: "os" | VoiceEngineId): Promise<void> {
  if ((await frame.locator("#aloudEngine").inputValue()) !== choice) await frame.locator("#aloudEngine").selectOption(choice);
  await waitUntil(async () => !(await frame.locator("#aloudPlay").isDisabled()), "［▶ 読む］が押せる", 20_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列の注：${JSON.stringify(await aloudNote(frame))}）`);
  });
}

/** 読んでいれば止めて、［▶ 読む］に戻るまで待つ */
export async function stopReading(frame: Frame): Promise<void> {
  if (!(await frame.locator("#aloudStop").isDisabled().catch(() => true))) await frame.locator("#aloudStop").click();
  await waitUntil(async () => (await frame.locator("#aloudPlay").innerText()).includes("読む"), "［▶ 読む］に戻る", 15_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（ボタン：${JSON.stringify(await frame.locator("#aloudPlay").innerText().catch(() => ""))}）`);
  });
}

/** 真ん中の窓（モーダル）の製品のボタン。VS Code が足す［キャンセル］は除く */
export async function dialogButtons(page: Page): Promise<string[]> {
  return (await page.locator(".monaco-dialog-box .monaco-button").allInnerTexts())
    .map((text) => text.trim())
    .filter((text) => text !== "" && text !== "Cancel" && text !== "キャンセル");
}

/** 真ん中の窓が `needle` を含んで出るまで待ち、窓の文を返す */
export async function waitDialog(session: E2ESession, frame: Frame, needle: string, label: string): Promise<string> {
  let text = "";
  await waitUntil(async () => (text = (await dialogText(session.page)) ?? "").includes(needle), label, 30_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（窓：${JSON.stringify(text)}／列の注：${JSON.stringify(await aloudNote(frame))}／${await describeNotices(session)}）`);
  });
  return text;
}

/** `.aiwriter/voices.json`（無ければ undefined） */
export async function readVoicesFile(session: E2ESession): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(path.join(session.workFolder, ".aiwriter", "voices.json"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
