/**
 * ［声の割り当て］で声を選ぶ窓が、区切りの見出しで分かれて並ぶ（画面の自動テスト。設計書6.42.3。
 * 作者の頼み 2026-11-13「キャラの声を選ぶとき、選択肢が長すぎるので、分類してわかりやすくしてください」）。
 *
 * 偽のエンジンを2つ立てる：VOICEVOX 役は同梱の表にある uuid の話者（四国めたん＝女性・青山龍星＝男性・
 * ちび式じい＝高齢・ナースロボ＝人でない）、AivisSpeech 役は `/aivm_models` の説明で区切りが決まる話者
 * （「老人の声」＝高齢・「朗らかおじさん」＝男性・説明の当たらない話者＝その他）。作品には語り手の声を1つ置き、
 * 「この作品で使っている声」が先頭に出ることも見る。
 *
 * 窓の写真を残す：`NOVELAI_E2E_PHOTOS`（無ければ `<一時フォルダー>/novelai-e2e-photos`）へ
 * `voiceAssignGroups-<時刻>.png`（画面全体）と `…-picker.png`（選ぶ窓だけ）。作者が「分かりやすいか」を見る材料。
 *
 * **作者の手に残すもの**：区切りの名前と並びが分かりやすいか（写真を見て）。本物のエンジンの44話者の振り分けが
 * 合っているか。**AI は呼ばない。本文はエンジンへ運ばない**（窓を開いて閉じるだけ）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { VOICE_ENGINE_LABEL } from "../../src/core/voiceEngine";
import { startFakeVoiceEngine, textCarrying, voiceEngineSettings } from "./support/fakeVoiceEngine";
import { withVsCode } from "./support/vscodeApp";
import { chooseEngine, clickAloudButton, openReadingRow } from "./support/voiceReadingUi";
import { quickInputWaitContext, quickPickRows, waitForQuickPick } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n「おはよう」と彼女が言った。\n";

/** VOICEVOX 役の話者（uuid は作者の VOICEVOX 0.26.1 と同じもの＝同梱の表で引ける） */
const VOICEVOX_SPEAKERS = [
  { name: "四国めたん", speaker_uuid: "7ffcb7ce-00ec-4bdc-82cd-45a8889e43ff", styles: [{ name: "ノーマル", id: 2, type: "talk" }, { name: "あまあま", id: 0, type: "talk" }] },
  { name: "青山龍星", speaker_uuid: "4f51116a-d9ee-4516-925d-21f183e2afad", styles: [{ name: "ノーマル", id: 13, type: "talk" }, { name: "しっとり", id: 84, type: "talk" }, { name: "喜び", id: 83, type: "talk" }] },
  { name: "ちび式じい", speaker_uuid: "468b8e94-9da4-4f7a-8715-a22a48844f9e", styles: [{ name: "ノーマル", id: 42, type: "talk" }] },
  { name: "ナースロボ＿タイプＴ", speaker_uuid: "882a636f-3bac-431a-966d-c5e6bba9f949", styles: [{ name: "ノーマル", id: 47, type: "talk" }, { name: "恐怖", id: 49, type: "talk" }] },
];

/** AivisSpeech 役の話者（区切りは `/aivm_models` の説明で決まる） */
const AIVIS_SPEAKERS = [
  { name: "ろてじん（長老ボイス）", speaker_uuid: "aivis-old", styles: [{ name: "ノーマル", id: 900001 }] },
  { name: "阿井田 茂", speaker_uuid: "aivis-uncle", styles: [{ name: "ノーマル", id: 900011 }, { name: "Calm", id: 900012 }, { name: "Shout", id: 900013 }] },
  { name: "まお", speaker_uuid: "aivis-mao", styles: [{ name: "ノーマル", id: 900021 }, { name: "あまあま", id: 900022 }] },
];
const AIVIS_MODELS = {
  "m-old": { manifest: { name: "ろてじん（長老ボイス）", description: "老人の声を意識した演技でセリフ収録したボイスモデルです。", speakers: [{ name: "ろてじん（長老ボイス）", uuid: "aivis-old" }] } },
  "m-uncle": { manifest: { name: "阿井田 茂", description: "バリトンボイスの朗らかおじさん", speakers: [{ name: "阿井田 茂", uuid: "aivis-uncle" }] } },
  "m-mao": { manifest: { name: "まお", description: "いたずらっ子な小悪魔ボイス。", speakers: [{ name: "まお", uuid: "aivis-mao" }] } },
};

test("声を選ぶ窓が「この作品で使っている声」と声の印象の区切りで分かれて並ぶ（窓の写真を残す）", async () => {
  const voicevox = await startFakeVoiceEngine({ brand: "VOICEVOX", speakers: VOICEVOX_SPEAKERS });
  const aivis = await startFakeVoiceEngine({ brand: "AivisSpeech", speakers: AIVIS_SPEAKERS, terms: { aivmModels: AIVIS_MODELS } });
  try {
    await withVsCode(
      "声を選ぶ窓の区切り",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        const frame = await openReadingRow(session, EPISODE, "朝の駅は静かだった");
        await chooseEngine(frame, "voicevox");
        await clickAloudButton(frame, "aloudVoiceAssign");
        const listTitle = `声の割り当て（この作品の声。選ぶと ${VOICE_ENGINE_LABEL.voicevox}・${VOICE_ENGINE_LABEL.aivisspeech} の声から選べます）`;
        const rows = await waitForQuickPick(page, listTitle, 20_000);
        await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").nth(rows.findIndex((row) => row.label === "台詞の既定")).click();
        await waitForQuickPick(page, `台詞の既定の声（${VOICE_ENGINE_LABEL.voicevox}・${VOICE_ENGINE_LABEL.aivisspeech}）`, 20_000);

        // 区切りの見出しは窓の中の字として出る（行の形は VS Code の版で違うので、窓全体の字で見る）
        const pickerText = (await page.locator(".quick-input-widget").innerText().catch(() => "")) ?? "";
        const headings = ["この作品で使っている声", "女性", "男性", "高齢", "人でない（ロボット・動物など）", "その他"];
        for (const heading of headings) {
          expect(pickerText, `見出し「${heading}」が窓にありません${await quickInputWaitContext(page)}`).toContain(heading);
        }
        // 見出しは上から決まった順に並ぶ（見えている所まで）
        const positions = headings.map((heading) => pickerText.indexOf(heading));
        expect([...positions].sort((a, b) => a - b), `見出しの並び：${JSON.stringify(positions)}`).toEqual(positions);
        // 感情のスタイルの行は無い（龍星の「喜び」・めたんの「あまあま」）。声の形は行になる（龍星／しっとり）
        const labels = (await quickPickRows(page)).map((row) => row.label);
        expect(labels.some((label) => label.includes("喜び") || label.includes("あまあま")), `行：${JSON.stringify(labels)}`).toBe(false);
        expect(labels, `行：${JSON.stringify(labels)}`).toContain("青山龍星／しっとり");

        // 窓の写真（作者が「分かりやすいか」を見る）。閉じる前に撮る
        const folder = process.env.NOVELAI_E2E_PHOTOS ?? path.join(tmpdir(), "novelai-e2e-photos");
        await mkdir(folder, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await page.screenshot({ path: path.join(folder, `voiceAssignGroups-${stamp}.png`) });
        await page.locator(".quick-input-widget").screenshot({ path: path.join(folder, `voiceAssignGroups-${stamp}-picker.png`) });
        console.info(`voiceAssignGroups：選ぶ窓の写真を ${folder} へ残しました（行：${labels.join("・")}）`);
        await page.keyboard.press("Escape");

        // 窓を開いただけでは本文はどちらのエンジンへも届かない
        expect(textCarrying(voicevox)).toHaveLength(0);
        expect(textCarrying(aivis)).toHaveLength(0);
      },
      {
        settings: voiceEngineSettings({ aivisspeech: aivis.url, voicevox: voicevox.url }),
        prepareWork: async ({ workFolder }) => {
          // 語り手に青山龍星（VOICEVOX）を置く：「この作品で使っている声」の先頭に出る
          const aiwriter = path.join(workFolder, ".aiwriter");
          await mkdir(aiwriter, { recursive: true });
          await writeFile(
            path.join(aiwriter, "voices.json"),
            JSON.stringify({
              version: 1,
              narrator: { speakerUuid: "4f51116a-d9ee-4516-925d-21f183e2afad", speakerName: "青山龍星", styleName: "ノーマル", styleId: 13, engine: "voicevox" },
              characters: {},
            }),
            "utf8"
          );
        },
      }
    );
  } finally {
    await voicevox.close();
    await aivis.close();
  }
}, 240_000);
