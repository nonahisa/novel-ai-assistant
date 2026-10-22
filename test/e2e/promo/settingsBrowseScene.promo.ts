/**
 * Discord「機能紹介」用の広報素材：設定資料集閲覧（作者の依頼 2026-10-22）。
 * features.md の文：左が一覧、右が詳細の画面で、名前・読み・別名・性別・役割・性格・外見・説明・作者メモをその場で直せる。
 *
 * 人物の記録は製品が読む形で起こす前に置く（広報用の作り物。AI は呼ばない）。
 * 走らせ方：`npx vitest run -c vitest.promo.config.mts test/e2e/promo/settingsBrowseScene.promo.ts`
 */
import { test } from "vitest";
import { emptyCharacter, type Character } from "../../../src/models/character";
import { runCommand } from "../support/quickInput";
import { defaultCharactersFolder, settingsPanelFrame, writeCharactersTo } from "../support/settingsFixture";
import { waitUntil } from "../support/wait";
import { recordFeature } from "./support/featureScene";

function cast(): Character[] {
  const mina: Character = {
    ...emptyCharacter("char_001", "ミナ"),
    reading: "みな",
    gender: "女性",
    role: "終電を逃した乗客",
    summary: "切符を握ったまま、雨の駅で朝を待つ。",
    personality: "慎重で、人に頼るのが苦手",
    appearance: "黒髪で、濡れたコートを着ている",
    appearedChapters: [1, 2],
  };
  const souji: Character = {
    ...emptyCharacter("char_002", "宗次"),
    reading: "そうじ",
    aliases: ["駅員さん"],
    gender: "男性",
    role: "駅員",
    summary: "改札から声をかけ、傘を貸してくれる。",
    personality: "口数は少ないが、面倒見がよい",
    appearance: "制帽をかぶった中年の男",
    appearedChapters: [1, 2],
  };
  return [mina, souji];
}

test("設定資料集閲覧の広報素材を撮る", async () => {
  await recordFeature({
    name: "settings-browse",
    subtitle: "設定資料集閲覧 — 見ながら、その場で直す",
    workTitle: "雨の駅",
    episodes: [{ name: "001_雨の駅.txt", text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n　ミナは切符を握ったまま、坂の上を見上げる。\n　駅員の宗次が、改札の向こうから声をかけた。\n" }],
    prepareWork: async ({ workFolder }) => {
      await writeCharactersTo(defaultCharactersFolder(workFolder), cast());
    },
    snapAt: 6.5,
    play: async (session, caption) => {
      const { page } = session;
      await caption("左が一覧、右が詳細");
      await page.waitForTimeout(1_000);
      await runCommand(page, "設定資料集閲覧");
      await waitUntil(async () => (await settingsPanelFrame(session)) !== undefined, "設定資料パネルが開く", 30_000);
      const frame = (await settingsPanelFrame(session))!;
      await waitUntil(async () => (await frame.locator("#list .item", { hasText: "宗次" }).count()) > 0, "一覧に人物が並ぶ", 20_000);
      await page.waitForTimeout(1_500);
      await frame.locator("#list .item", { hasText: "宗次" }).first().click();
      await page.waitForTimeout(3_500);
      await caption("名前・役割・性格・外見などを、その場で直せる");
      const field = frame.locator("#detail .field", { hasText: "性格" }).locator("textarea, input").first();
      await field.fill("口数は少ないが、面倒見がよい。傘は必ず貸す");
      await page.waitForTimeout(2_500);
      await frame.locator("#detail .saverow button.action", { hasText: "保存" }).click();
      await page.waitForTimeout(3_500);
    },
  });
});
