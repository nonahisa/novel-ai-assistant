/**
 * 「別人に分ける」で分けた記録に、抽出のあとも中身が入らなかったら取り下げを持ちかける
 * （画面の自動テスト、設計書6.5.8・6.113）。
 *
 * 実機確認リスト 0.96.11 の項目を機械へ移したもの（作者の裁定、2026-10-03「取り下げを持ちかける」）。
 * 実機では、元の人物への呼びかけ「お嬢様」を別人に分けたため、空の記録が残り続けた。見張るのは次のとおり。
 *
 * - 「設定資料を抽出」を最後まで回すと「本文から「お嬢様」の中身が見つかりませんでした。この記録を
 *   取り下げますか？」が出て、ファイル名・空であること・退避先が書かれている
 * - 「取り下げる」で `設定/characters/.novelai-recovery` へ移り、開いている設定資料パネルから消える
 * - 押さずに閉じたら、次の抽出では訊かれない（`.aiwriter/separation-retraction-offered.json` に残る）
 *
 * 相手の選び方と断り方そのものは単体テスト（`core/characterSeparate.test.ts`「中身の入らなかった、分けた記録」）
 * が見ている。ここで見るのは**本物の抽出の道を最後まで通したときに出るか**である。
 *
 * ## AI は呼ばない
 *
 * 抽出は、全部のチャンクの答えが覚え（`.aiwriter/cache/chunks.json`）にあれば、AI へ繋がずに
 * 保存まで進む（`features/extractCharacters.ts` の「すべてのチャンクが処理済みです」の道）。
 * そこで次の3つを、製品と同じ形で先に置く。
 *
 * 1. **AI の選択**：globalState の `novelai.ai.provider`・`novelai.ai.model`（`LaunchOptions.globalState`）。
 *    選ぶのは ChatGPT の口で、モデル名は作り物。この口はモデルの詳細を通信せずに組む
 *    （`ai/openaiProvider.ts` の `getModel`）。鍵は置かず、口の行き先は捨て settings で
 *    `127.0.0.1:9`（すぐ断られる場所）へ向ける——万一どこかで送ろうとしても、外へは出ない
 * 2. **人物**：元の人物から呼び名「お嬢様」を製品と同じ関数（`core/characterSeparate.ts` の
 *    `planCharacterSeparation`）で分けた2つの記録
 * 3. **チャンクの覚え**：製品と同じ切り方（`core/episodeChunks.ts`）と同じ鍵
 *    （`core/knownCharacterNames.ts` の `characterExtractCacheKey`）で、「この話に出るのは元の人物だけ」
 *    という答えを置く
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { ChunkCacheStore } from "../../src/core/chunkCacheStore";
import { planCharacterSeparation } from "../../src/core/characterSeparate";
import { mergeAdjacentChunks } from "../../src/core/chunker";
import { chunksOfEpisodeFile } from "../../src/core/episodeChunks";
import { characterExtractCacheKey } from "../../src/core/knownCharacterNames";
import { characterFileName, emptyCharacter, type Character } from "../../src/models/character";
import {
  charactersFolder,
  defaultCharactersFolder,
  settingsListRows,
  settingsPanelFrame,
  writeCharactersTo,
} from "./support/settingsFixture";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications, closeDialog, dialogText, pressDialogButton } from "./support/workbenchDom";

const OPEN_SETTINGS_KEY = "ctrl+alt+shift+f1";
const OPEN_SETTINGS_PRESS = "Control+Alt+Shift+F1";
const EXTRACT_KEY = "ctrl+alt+shift+f2";
const EXTRACT_PRESS = "Control+Alt+Shift+F2";

/** 作り物のモデル名（AI を呼ばないので、どこにも無い名前でよい） */
const MODEL = "e2e-fixture-model";
const PROVIDER = "openai";

const EPISODE = {
  name: "001_はじまり.txt",
  // 「お嬢様」は白瀬灯への呼びかけ（実機の形）
  text: "「お嬢様、朝です」と黒川湊が言った。\n白瀬灯は目をこすった。\n",
};

const RETRACT_QUESTION = "本文から「お嬢様」の中身が見つかりませんでした。この記録を取り下げますか？";

const launchOptions: LaunchOptions = {
  globalState: { "novelai.ai.provider": PROVIDER, "novelai.ai.model": MODEL },
  settings: { "novelai.openai.endpoint": "http://127.0.0.1:9/v1" },
  keybindings: [
    { key: OPEN_SETTINGS_KEY, command: "novelai.openSettingsPanel" },
    { key: EXTRACT_KEY, command: "novelai.extractSettings" },
  ],
  // **人物と覚えは起こす前に置く**（起きてから書くと「外で変更されました」の知らせが出て、
  // その時機にキーが届かないことがあった。`LaunchOptions.prepareWork`）
  prepareWork: async ({ workFolder, manuscriptFolder }) => {
    const { original, created } = separatedCast();
    await writeCharactersTo(defaultCharactersFolder(workFolder), [original, created]);
    await seedExtractionCache(workFolder, manuscriptFolder, [original, created]);
  },
};

/** 元の人物（中身あり）と、そこから「お嬢様」を分けた空の記録 */
function separatedCast(): { original: Character; created: Character } {
  const source: Character = {
    ...emptyCharacter("char_001", "白瀬灯"),
    reading: "しらせあかり",
    aliases: ["お嬢様"],
    summary: "朝に弱い令嬢。",
    appearedChapters: [1],
    evidence: "白瀬灯は目をこすった。",
  };
  const plan = planCharacterSeparation(source, "お嬢様", [source]);
  return { original: plan.original, created: plan.created };
}

/**
 * 「この話に出るのは元の人物だけ」という答えを、製品と同じ鍵でチャンクの覚えへ置く。
 * 鍵に入る人物の顔ぶれは、置いた2人（読み込みの順には左右されない）
 */
async function seedExtractionCache(
  workFolder: string,
  manuscriptFolder: string,
  characters: readonly Character[]
): Promise<void> {
  const episodePath = path.join(manuscriptFolder, EPISODE.name);
  const raw = await readFile(episodePath, "utf8");
  // 1話だけの短い本文なので、チャンクの大きさに関わらず1つになる（製品のまとめ送信も同じ1つ）
  const chunks = mergeAdjacentChunks(
    chunksOfEpisodeFile(episodePath, raw, { chapterStart: 1, chapterEnd: 1 }, { maxChars: 20_000 }),
    { maxChars: 20_000 }
  );
  expect(chunks).toHaveLength(1);
  const file = path.join(workFolder, ".aiwriter", "cache", "chunks.json");
  const store = new ChunkCacheStore(file, {
    async read(target) {
      return existsSync(target) ? new Uint8Array(await readFile(target)) : undefined;
    },
    async write(target, bytes) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },
    log() {},
  });
  await store.load();
  /*
    答えは「元の人物だけが出る」形（実機と同じ。AI は「お嬢様」を元の人物の呼び名として読む）。
    **空の一覧にはしない**——抽出で人物が1人も取れなかった回は、人物の保存の段そのものが
    無く（`planCharacterSave` が undefined）、取り下げも訊かない作りである
  */
  await store.set(chunks[0].hash, characterExtractCacheKey(PROVIDER, MODEL, [...characters]), {
    characters: [
      {
        name: "白瀬灯",
        entityType: "person",
        summary: "朝に弱い令嬢。",
        // 本文の連続した引用（検算で「本文に無い」と落とされないように）
        evidence: "白瀬灯は目をこすった。",
      },
    ],
  });
  await store.save();
}

/** 設定資料パネルを開いて「お嬢様」が並ぶところまで（人物と覚えは起こす前に置いてある） */
async function prepare(session: E2ESession): Promise<{ panel: Frame; created: Character }> {
  const { created } = separatedCast();
  // 起こす前に置いた場所が、登録で決まった置き場と同じであること
  expect(await charactersFolder(session)).toBe(defaultCharactersFolder(session.workFolder));

  await session.page.keyboard.press(OPEN_SETTINGS_PRESS);
  let panel: Frame | undefined;
  await waitUntil(async () => (panel = await settingsPanelFrame(session)) !== undefined, "設定資料パネルが開く", 30_000);
  if (!panel) throw new Error("設定資料パネルの面が見つかりません");
  const frame = panel;
  await waitUntil(
    async () => (await settingsListRows(frame)).some((row) => row.includes("お嬢様")),
    "設定資料パネルに「お嬢様」が並ぶ",
    15_000
  );
  return { panel: frame, created };
}

/**
 * 待ちが時間切れになったら、作品の操作ログの終わりと、出ている知らせを例外の文へ足す。
 * 抽出は画面に出ない所で止まることが多く、写真だけでは理由が分からない
 */
async function withDiagnostics<T>(session: E2ESession, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const log = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(
      () => "（操作ログがありません）"
    );
    const toasts = await session.page
      .locator(".notification-toast")
      .allInnerTexts()
      .catch(() => []);
    if (error instanceof Error) {
      error.message += `\n出ている知らせ: ${JSON.stringify(toasts)}\n操作ログの終わり:\n${log.split("\n").slice(-25).join("\n")}`;
    }
    throw error;
  }
}

/** 作品の操作ログに「抽出を開始」が何回書かれたか */
async function extractionStarts(session: E2ESession): Promise<number> {
  const log = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8").catch(() => "");
  return log.split("\n").filter((line) => line.includes("抽出を開始:")).length;
}

/**
 * 抽出を押し、操作ログに「抽出を開始」と「チャンクの処理を終了」が書かれるまで待つ。
 * **AI へ送っていないことは、ログに「AIへ送信」が無いことで見る**（知らせの「AIは呼ばず」は、
 * 続けて出る確認画面と重なって読み取れないことがあるので、ログを正とする）。
 *
 * **届かなければ押し直す。** 起きてから人物を書いていた頃、「外で変更されました」の知らせが
 * 出た回に、押したのにログに何も書かれないことがあった（2026-10-03、焦点は設定資料パネル
 * 〈WebView〉の中）。いまは起こす前に置くので知らせは出ないが、念のため残す。抽出は覚えだけで
 * 1秒足らずで終わるので、5秒待って書かれなければ届かなかったとみなす
 */
async function runExtraction(session: E2ESession): Promise<void> {
  const { page } = session;
  await clearNotifications(page);
  const before = await extractionStarts(session);
  await withDiagnostics(session, async () => {
    for (let attempt = 1; ; attempt++) {
      await page.keyboard.press(EXTRACT_PRESS);
      try {
        await waitUntil(async () => (await extractionStarts(session)) > before, "操作ログに「抽出を開始」が書かれる", 5_000);
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
      }
    }
    const logFile = path.join(session.workFolder, ".aiwriter", "logs", "actions.log");
    const thisRun = async () => (await readFile(logFile, "utf8")).split("抽出を開始:").slice(before + 1).join("");
    await waitUntil(async () => (await thisRun()).includes("チャンクの処理を終了: 1/1 （失敗 0件）"), "チャンクの処理が終わる", 15_000);
    expect(await thisRun(), "AI へ送っています（覚えが当たっていません）").not.toContain("AIへ送信:");
  });
}

async function waitForQuestion(session: E2ESession): Promise<string> {
  let text: string | undefined;
  await withDiagnostics(session, () =>
    waitUntil(
      async () => (text = await dialogText(session.page))?.includes(RETRACT_QUESTION) === true,
      "取り下げを訊く確認画面が出る",
      30_000
    )
  );
  return text ?? "";
}

async function readOffered(session: E2ESession): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(session.workFolder, ".aiwriter", "separation-retraction-offered.json"), "utf8")
  );
}

test("分けた記録に抽出のあとも中身が入らないと、取り下げを訊く画面にファイル名・空・退避先が出て、「取り下げる」で回復用の場所へ移り、開いている設定資料パネルから消える", async () => {
  await withVsCode(
    "分けた空の記録の取り下げ",
    [EPISODE],
    async (session) => {
      const { panel, created } = await prepare(session);
      const folder = await charactersFolder(session);
      const fileName = characterFileName(created);
      expect(existsSync(path.join(folder, fileName))).toBe(true);

      await runExtraction(session);
      const question = await waitForQuestion(session);
      expect(question).toContain(`ファイル：${fileName}`);
      expect(question).toContain("中身：空（紹介・役割・性格・登場話は入っていません）");
      expect(question).toContain("回復用の場所（設定/characters/.novelai-recovery）へ移します");

      await pressDialogButton(session.page, "取り下げる");

      // **ファイルで見る**：正規の場所から消え、回復用の場所へ移る。元の人物はそのまま
      const recovery = path.join(folder, ".novelai-recovery");
      await waitUntil(() => !existsSync(path.join(folder, fileName)), "「お嬢様」のファイルが正規の場所から消える", 15_000);
      // 回復用の場所の名前は中身のハッシュなので、中身で探す
      const moved = await Promise.all(
        (await readdir(recovery)).map(async (name) => ({ name, text: await readFile(path.join(recovery, name), "utf8") }))
      );
      const retired = moved.find((entry) => {
        try {
          const record = JSON.parse(entry.text) as Partial<Character>;
          return record.id === created.id && record.name === "お嬢様";
        } catch {
          return false;
        }
      });
      expect(retired, `回復用の場所に「お嬢様」の記録がありません: ${moved.map((entry) => entry.name).join(", ")}`).toBeDefined();
      expect(existsSync(path.join(folder, characterFileName(separatedCast().original)))).toBe(true);
      // 一度訊いた記録として覚えている
      expect(await readOffered(session)).toEqual({ offered: [{ id: created.id, name: "お嬢様" }] });

      // 開いている設定資料パネルから消える（元の人物は残る）
      await waitUntil(
        async () => !(await settingsListRows(panel)).some((row) => row.includes("お嬢様")),
        "設定資料パネルから「お嬢様」が消える",
        15_000
      );
      expect((await settingsListRows(panel)).some((row) => row.includes("白瀬灯"))).toBe(true);
    },
    launchOptions
  );
});

test("取り下げを訊く画面を押さずに閉じると記録は残り、次の抽出では同じ記録について訊かれない", async () => {
  await withVsCode(
    "分けた空の記録の取り下げを見送る",
    [EPISODE],
    async (session) => {
      const { created } = await prepare(session);
      const folder = await charactersFolder(session);
      const fileName = characterFileName(created);

      await runExtraction(session);
      await waitForQuestion(session);
      await closeDialog(session.page);

      // 押さずに閉じた：ファイルはそのまま、覚書には残る
      expect(existsSync(path.join(folder, fileName))).toBe(true);
      expect(await readOffered(session)).toEqual({ offered: [{ id: created.id, name: "お嬢様" }] });

      // もう一度抽出しても、訊く画面は出ない
      await runExtraction(session);
      await holdsFor(async () => (await dialogText(session.page)) === undefined, "取り下げを訊く画面が出ない", 5_000);
      expect(existsSync(path.join(folder, fileName))).toBe(true);
    },
    launchOptions
  );
});
