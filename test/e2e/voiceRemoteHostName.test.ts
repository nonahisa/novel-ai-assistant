/**
 * 本文を PC の外のホストへ送る確かめの窓に、端末名が出る（画面の自動テスト。設計書6.42.3・6.89・6.113。
 * 実機確認リスト 125行〔0.141.1。作者の答え「IPアドレスではなく、端末名にできないでしょうか？」〕）。
 *
 * 名前つきの窓を必ず出せる道：**この機械自身の LAN の IPv4 の番地**は、逆引き（`dns.lookupService`）でこの機械の名前を
 * 返すことが多い（127.0.0.2 は引けない機械がある）。偽のエンジンをその番地で待ち受けさせ、接続先をその番地にして
 * ［▶ 読む］を押すと、窓の文が「本文が 〈名前〉（〈番地:ポート〉）へ送られます。」の形になることを確かめる。
 * 本文は窓で止める（閉じる）ので、**外のホストへは本当に送らない**（待ち受けるのもこの機械の上）。
 *
 * 窓の写真を残す：`NOVELAI_E2E_PHOTOS`（無ければ `<一時フォルダー>/novelai-e2e-photos`）へ
 * `voiceRemoteHostName-<時刻>.png`（画面全体）と `…-dialog.png`（窓だけ）。作者が「目に留まるか」を見る材料。
 *
 * 飛ばす場合（理由を console.warn に出す）：LAN の番地が無い機械・どの番地も逆引きで名前が引けない機械・待ち受けられない機械・
 * `NOVELAI_E2E_NO_LAN=1`（Windows で防火壁の窓を出したくないとき）。名前が引けない機械では、窓は番地だけの形で、
 * そちらは `voiceRemoteHostConfirm.test.ts` が見ている。
 *
 * **作者の手に残すもの**：窓が目に留まるか（写真を見て）、本物の別の機械へ届くこと。**AI は呼ばない。**
 */
import { mkdir } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { engineHostOutsideThisPc } from "../../src/core/voiceEngine";
import { closedEngineUrl, describeVoiceRequests, startFakeVoiceEngine, textCarrying, type FakeVoiceEngine } from "./support/fakeVoiceEngine";
import { withVsCode } from "./support/vscodeApp";
import { chooseEngine, dialogButtons, openReadingRow } from "./support/voiceReadingUi";
import { holdsFor, waitUntil } from "./support/wait";
import { closeDialog } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n「おはよう」と彼女が言った。\n";

/** この機械の LAN の IPv4 の番地のうち、逆引きで名前が引けるもの（番地と名前）。無ければ undefined */
async function lanAddressWithName(): Promise<{ address: string; name: string } | undefined> {
  const dns = await import("node:dns");
  const candidates = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("127.") && !entry.address.startsWith("169.254."))
    .map((entry) => entry.address);
  for (const address of new Set(candidates)) {
    try {
      const { hostname } = await dns.promises.lookupService(address, 80);
      const name = hostname.trim().replace(/\.$/, "");
      // 引けないと OS が番地そのものを返すことがある。製品も同じ見方で「引けなかった」とする
      if (name !== "" && name.toLowerCase() !== address.toLowerCase()) return { address, name };
    } catch {
      // 次の番地へ
    }
  }
  return undefined;
}

test("PC の外のホストへ送る確かめの窓に、端末名が「〈名前〉（〈番地:ポート〉）」の形で出る（窓の写真を残す）", async (context) => {
  if (process.env.NOVELAI_E2E_NO_LAN === "1") {
    console.warn("voiceRemoteHostName を飛ばします：NOVELAI_E2E_NO_LAN=1");
    context.skip();
    return;
  }
  const lan = await lanAddressWithName();
  if (!lan) {
    console.warn("voiceRemoteHostName を飛ばします：この機械の LAN の番地が無いか、どの番地も逆引きで名前が引けません（名前つきの窓を出せない）");
    context.skip();
    return;
  }
  let fake: FakeVoiceEngine;
  try {
    fake = await startFakeVoiceEngine({ brand: "AivisSpeech", listenHost: lan.address });
  } catch (error) {
    console.warn(`voiceRemoteHostName を飛ばします：${lan.address} で待ち受けられません（${String(error)}）`);
    context.skip();
    return;
  }
  try {
    // 選んだ番地が製品の決め方で「外」に見えなければ、窓が出ないのはテストの側の誤り
    expect(engineHostOutsideThisPc(fake.url), `偽のエンジンの番地 ${fake.host} が、製品からこの PC と見なされます`).toBe(fake.host);
    await withVsCode(
      "端末名つきの送り先の確認",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        const { page } = session;
        const frame = await openReadingRow(session, EPISODE, "朝の駅は静かだった");
        await chooseEngine(frame, "aivisspeech");
        await frame.locator("#aloudPlay").click();
        const expected = `本文が ${lan.name}（${fake.host}）へ送られます。`;
        let shown = "";
        await waitUntil(
          async () => {
            shown = (await page.locator(".monaco-dialog-box").first().innerText().catch(() => "")) ?? "";
            return shown.replace(/\s+/g, "").includes(expected.replace(/\s+/g, ""));
          },
          "確認の窓に「本文が 〈名前〉（〈番地:ポート〉）へ送られます。」が出る",
          30_000
        ).catch((error: unknown) => {
          throw new Error(`${String(error)}（窓：${JSON.stringify(shown)}／期待：${JSON.stringify(expected)}）`);
        });
        expect([...(await dialogButtons(page))].sort(), `窓：${shown}`).toEqual(["送る", "送る（以降は訊かない）"].sort());
        expect(textCarrying(fake), "窓で答える前に、本文がエンジンへ届きました").toHaveLength(0);

        // 窓の写真（作者が「目に留まるか」を見る）。窓は閉じる前に撮る
        const folder = process.env.NOVELAI_E2E_PHOTOS ?? path.join(tmpdir(), "novelai-e2e-photos");
        await mkdir(folder, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await page.screenshot({ path: path.join(folder, `voiceRemoteHostName-${stamp}.png`) });
        await page.locator(".monaco-dialog-box").first().screenshot({ path: path.join(folder, `voiceRemoteHostName-${stamp}-dialog.png`) });
        console.info(`voiceRemoteHostName：窓の写真を ${folder} へ残しました（窓の文：${shown.replace(/\s+/g, " ")}）`);

        // 閉じれば送らない
        await closeDialog(page);
        await holdsFor(async () => textCarrying(fake).length === 0, "窓を閉じたあと、本文がエンジンへ届かない", 3_000).catch((error: unknown) => {
          throw new Error(`${String(error)}（届いた頼み：${describeVoiceRequests(fake)}）`);
        });
      },
      { settings: { "novelai.readAloud.aivisSpeechUrl": fake.url, "novelai.readAloud.voicevoxUrl": await closedEngineUrl() } }
    );
  } finally {
    await fake.close();
  }
}, 240_000);
