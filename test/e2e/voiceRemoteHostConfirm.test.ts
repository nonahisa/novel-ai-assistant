/**
 * 読み上げの「人物の声」で、音声合成のエンジンの接続先がこの PC の外のホストのときの確認の窓（画面の自動テスト、
 * 設計書6.42.3・6.89・6.113。実機確認リスト 24行〔0.127.5〕「設定 `novelai.readAloud.voiceEngineUrl` をこの PC の
 * 外のホストにして［声］の「人物の声」で［▶ 読む］を押すと、画面の真ん中に「本文が … へ送られます。」の窓が
 * 警告の印つきで出て…ボタンは［送る］［送る（以降は訊かない）］の2つ。閉じると送らない。［送る（以降は訊かない）］の
 * あと VS Code を開き直しても同じホストでは訊かれず、…「人物の声の送り先：…へ本文を送る」が出て、外すとまた訊かれる」
 * の、押して起きることを機械へ移した。作者の答え 2026-11-05「真ん中の窓に戻す」）。
 *
 * 見張ること：
 * 1. 原稿エディターの読み上げの列で［声］を「人物の声」にして［▶ 読む］を押すと、確認の窓が「本文が <ホスト> へ
 *    送られます。」・警告の印つきで出て、製品のボタンは［送る］［送る（以降は訊かない）］の2つ
 * 2. 窓を閉じる（Esc）と、本文を運ぶ頼み（`/audio_query`・`/synthesis`）はエンジンへ1つも届かない
 * 3. もう一度［▶ 読む］→［送る（以降は訊かない）］で本文が届き、ユーザーの設定 `novelai.confirm.remembered` に
 *    `voice.remoteHost.<ホスト>` が「送る」で入る
 * 4. 開き直して［▶ 読む］を押しても窓は出ず、本文が届く
 * 5. 「確認省略解除」（項目の「訊かないことにした確認を見直す」。0.127.5 のあと名前が替わり、詳細メニューからは
 *    しまわれてコマンドパレットから呼ぶ。`core/actionTree.ts`）に「人物の声の送り先：<ホスト>へ本文を送る」が並び、
 *    外すと設定から消える
 * 6. 開き直して［▶ 読む］を押すと、また窓が出る（許したホストはその起動の間だけ覚える作りなので、外したあとは
 *    開き直してから確かめる。`features/voiceReading.ts` の `allowedRemoteHosts`）
 *
 * **本物の外のホストへは送らない。** 偽の音声エンジンをこの機械の上に立て、製品からは「外」に見える番地で待ち受ける。
 * 製品が「この PC」と見なすのは 127.0.0.1・localhost・::1 だけ（`core/voiceEngine.ts` の `engineHostOutsideThisPc`）。
 * - Windows：127.0.0.2（127.0.0.0/8 の全部がこの PC へ戻る）。**LAN の番地は使わない**——そこで待ち受けると、
 *   Windows Defender の「アクセスを許可」の窓が作者の画面に出ることがある（画面を取らない決まり）
 * - それ以外：まず 127.0.0.2（Linux は待ち受けられる）。Mac の既定は 127.0.0.1 以外の 127.x を持たないので、
 *   次に、この機械の LAN の IPv4 の番地（`os.networkInterfaces()` の内向きでないもの）を使う（2026-11-07。Mac で
 *   写したときも LAN の番地で通した）。待ち受けるのはこの機械の上なので、本文はこの機械の外へは出ない
 * どれでも待ち受けられなければ、理由を出して飛ばす。選んだ番地が製品から「外」に見えることも、始めに確かめる。
 *
 * **作者の手に残すもの**：窓が「目に留まるか」（見た目の判断）と、本物の別の機械（LAN の AivisSpeech）へ届くこと。
 * 音は鳴らさない（偽のエンジンは無音の WAV を返す。耳では聞かない）。**AI は呼ばない。**
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { engineHostOutsideThisPc } from "../../src/core/voiceEngine";
import { clickToolButton, openEpisode } from "./support/manuscriptFrame";
import { runCommand } from "./support/quickInput";
import { restartVsCode, withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { acceptQuickPick, closeDialog, dialogText, pressDialogButton, quickInputWaitContext, toggleQuickPickRow, waitForQuickPick } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "　朝の駅は静かだった。\n「おはよう」と彼女が言った。\n";
const LOOPBACK_OUTSIDE = "127.0.0.2";

/**
 * 偽のエンジンを待ち受けさせてみる番地を、試す順に（理由は頭のコメント）。
 * Windows は 127.0.0.2 だけ。それ以外は 127.0.0.2 のあとに LAN の IPv4（内向きでなく、127.x・169.254.x でないもの）
 */
function fakeHostCandidates(): string[] {
  if (process.platform === "win32") return [LOOPBACK_OUTSIDE];
  const lan = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("127.") && !entry.address.startsWith("169.254."))
    .map((entry) => entry.address);
  return [LOOPBACK_OUTSIDE, ...new Set(lan)];
}

interface FakeVoiceEngine {
  /** `<番地>:<port>`（製品が窓に出すホスト。Windows なら 127.0.0.2:<port>） */
  host: string;
  /** 受けた頼みの道（`/speakers`・`/audio_query`・`/synthesis`）と、本文を運ぶ頼みの `text` */
  requests: Array<{ path: string; text: string }>;
  close(): Promise<void>;
}

/** 0.1秒の無音の WAV（16bit・モノラル・24000Hz）。製品は頭の RIFF を見て音として受ける */
function silentWav(): Buffer {
  const samples = 2_400;
  const data = samples * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(data, 40);
  return wav;
}

/**
 * 偽の音声エンジン（AivisSpeech・VOICEVOX と同じ口の形）を、`fakeHostCandidates` の番地のうち最初に待ち受けられた所に立てる。
 * どこでも待ち受けられなければ undefined。
 * 話者は1人・スタイル1つ（声の割り当てが無いとき、製品は最初の話者の最初のスタイルで読む。`core/voiceCast.ts`）
 */
async function startFakeVoiceEngine(): Promise<FakeVoiceEngine | undefined> {
  const requests: FakeVoiceEngine["requests"] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    // 本文は送られた分だけ控える（中身を外へは出さない。一時のこの試験の中だけ）
    request.resume();
    request.on("end", () => {
      requests.push({ path: url.pathname, text: url.searchParams.get("text") ?? "" });
      if (url.pathname === "/speakers") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify([{ name: "画面テストの話者", speaker_uuid: "e2e-speaker", styles: [{ name: "ノーマル", id: 1, type: "talk" }] }]));
        return;
      }
      if (url.pathname === "/audio_query") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ accent_phrases: [], speedScale: 1 }));
        return;
      }
      if (url.pathname === "/synthesis") {
        response.writeHead(200, { "Content-Type": "audio/wav" });
        response.end(silentWav());
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  let address: string | undefined;
  for (const candidate of fakeHostCandidates()) {
    const listening = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once("error", onError);
      server.listen(0, candidate, () => {
        server.off("error", onError);
        resolve(true);
      });
    });
    if (listening) {
      address = candidate;
      break;
    }
  }
  if (!address) return undefined;
  const { port } = server.address() as AddressInfo;
  return {
    host: `${address}:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 本文を運ぶ頼みの数（`/speakers` は本文を運ばないので数えない） */
function textCarrying(fake: FakeVoiceEngine): number {
  return fake.requests.filter((request) => request.path === "/audio_query" || request.path === "/synthesis").length;
}

function settingsFile(session: E2ESession): string {
  return path.join(session.root, "user-data", "User", "settings.json");
}

/** ユーザーの設定 `novelai.confirm.remembered`（無ければ空） */
async function rememberedConfirms(session: E2ESession): Promise<Record<string, unknown>> {
  const text = await readFile(settingsFile(session), "utf8").catch(() => "{}");
  try {
    const settings = JSON.parse(text) as Record<string, unknown>;
    const remembered = settings["novelai.confirm.remembered"];
    return typeof remembered === "object" && remembered !== null ? (remembered as Record<string, unknown>) : {};
  } catch {
    // 書き換えの途中で読んだ。次の回で読めればよい
    return {};
  }
}

/** 話を開き、読み上げの列を出して、読み方を「人物の声」にする。押せるようになった面を返す */
async function openVoiceReading(session: E2ESession): Promise<Frame> {
  const frame = await openEpisode(session.page, EPISODE, "朝の駅は静かだった");
  await clickToolButton(frame, "aloudToggle");
  // 「人物の声」が選べる（拡張機能が使えると知らせてくる）まで待ってから選ぶ。前の選択を覚えていれば、もう選ばれている
  await waitUntil(
    async () => (await frame.locator('#aloudEngine option[value="aivisspeech"]').isDisabled().catch(() => true)) === false,
    "［声］で「人物の声」が選べる",
    20_000
  );
  if ((await frame.locator("#aloudEngine").inputValue()) !== "aivisspeech") await frame.locator("#aloudEngine").selectOption("aivisspeech");
  await waitUntil(async () => !(await frame.locator("#aloudPlay").isDisabled()), "［▶ 読む］が押せる", 20_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（列の注：${JSON.stringify(await frame.locator("#aloudNote").innerText().catch(() => ""))}）`);
  });
  return frame;
}

/** 読んでいれば止めて、［▶ 読む］が出るまで待つ */
async function stopReading(frame: Frame): Promise<void> {
  if (!(await frame.locator("#aloudStop").isDisabled().catch(() => true))) await frame.locator("#aloudStop").click();
  await waitUntil(async () => (await frame.locator("#aloudPlay").innerText()).includes("読む"), "［▶ 読む］に戻る", 15_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（ボタン：${JSON.stringify(await frame.locator("#aloudPlay").innerText().catch(() => ""))}）`);
  });
}

/** 送り先の確認の窓が出るまで待ち、その文を返す */
async function waitSendConfirm(page: Page, frame: Frame, host: string, label: string): Promise<string> {
  let text = "";
  /*
    0.141.1 から、OS が端末名を引けると「本文が <名前>（<ホスト>）へ送られます。」になる（127.0.0.2 は、
    この機械の名前が引ける OS がある）。引けなければ今までどおり「本文が <ホスト> へ送られます。」
  */
  const asked = (shown: string) =>
    shown.includes(`本文が ${host} へ送られます。`) || (shown.includes("本文が ") && shown.includes(`（${host}）へ送られます。`));
  await waitUntil(async () => asked((text = (await dialogText(page)) ?? "")), label, 30_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（窓：${JSON.stringify(text)}／列の注：${JSON.stringify(await frame.locator("#aloudNote").innerText().catch(() => ""))}）${await quickInputWaitContext(page)}`);
  });
  return text;
}

/** 確認の窓の製品のボタン。VS Code が足す［キャンセル］は除く */
async function dialogButtons(page: Page): Promise<string[]> {
  return (await page.locator(".monaco-dialog-box .monaco-button").allInnerTexts())
    .map((text) => text.trim())
    .filter((text) => text !== "" && text !== "Cancel" && text !== "キャンセル");
}

test("人物の声の接続先がこの PC の外なら［▶ 読む］で送り先の確認の窓が出て、閉じれば送らず、［送る（以降は訊かない）］は開き直しても効き、「確認省略解除」で外すとまた訊かれる", async (context) => {
  const fake = await startFakeVoiceEngine();
  if (!fake) {
    // 黙って飛ばすと、見張れていないことに気づけない
    console.warn(`voiceRemoteHostConfirm を飛ばします：${fakeHostCandidates().join("・")} のどれでも待ち受けられない機械です（偽のエンジンを外のホストに見せられない）`);
    context.skip();
    return;
  }
  const memoryId = `voice.remoteHost.${fake.host}`;
  // 選んだ番地が製品の決め方で「外」に見えなければ、窓が出ないのはテストの側の誤り（先に止める）
  expect(engineHostOutsideThisPc(`http://${fake.host}`), `偽のエンジンの番地 ${fake.host} が、製品からこの PC と見なされます`).toBe(fake.host);
  try {
    await withVsCode(
      "人物の声の送り先の確認",
      [{ name: EPISODE, text: TEXT }],
      async (session) => {
        /* ── 1. 確認の窓 ── */
        let frame = await openVoiceReading(session);
        await frame.locator("#aloudPlay").click();
        const ask = await waitSendConfirm(session.page, frame, fake.host, "［▶ 読む］で送り先の確認の窓が出る");
        expect(ask.replace(/\s+/g, " "), `窓の文：${ask}`).toContain("このホストはこの PC の外にあるため、送った文は相手に届きます。");
        expect(await session.page.locator(".monaco-dialog-box .codicon-dialog-warning").count(), "確認の窓に警告の印がありません").toBeGreaterThan(0);
        // 並びは OS で違う（Mac は［送る（以降は訊かない）］［Cancel］［送る］）。集まりとして比べる
        expect([...(await dialogButtons(session.page))].sort(), `窓の文：${ask}`).toEqual(["送る", "送る（以降は訊かない）"].sort());
        expect(textCarrying(fake), "窓で答える前に、本文がエンジンへ届きました").toBe(0);

        /* ── 2. 閉じれば送らない ── */
        await closeDialog(session.page);
        await holdsFor(async () => textCarrying(fake) === 0, "窓を閉じたあと、本文がエンジンへ届かない", 3_000).catch((error: unknown) => {
          throw new Error(`${String(error)}（届いた頼み：${JSON.stringify(fake.requests)}）`);
        });
        expect(await rememberedConfirms(session), "閉じただけなのに「以降は訊かない」を覚えました").not.toHaveProperty([memoryId]);

        /* ── 3. ［送る（以降は訊かない）］ ── */
        await stopReading(frame);
        await frame.locator("#aloudPlay").click();
        await waitSendConfirm(session.page, frame, fake.host, "もう一度［▶ 読む］で、また確認の窓が出る（閉じた答えは覚えない）");
        await pressDialogButton(session.page, "送る（以降は訊かない）");
        await waitUntil(async () => textCarrying(fake) > 0, "［送る（以降は訊かない）］で本文がエンジンへ届く", 15_000).catch((error: unknown) => {
          throw new Error(`${String(error)}（届いた頼み：${JSON.stringify(fake.requests)}）`);
        });
        expect(fake.requests.some((request) => request.path === "/audio_query" && request.text.includes("朝の駅は静かだった")), `届いた頼み：${JSON.stringify(fake.requests)}`).toBe(true);
        await waitUntil(async () => (await rememberedConfirms(session))[memoryId] === "送る", `設定 novelai.confirm.remembered に ${memoryId} が入る`, 15_000).catch(
          async (error: unknown) => {
            throw new Error(`${String(error)}（覚え：${JSON.stringify(await rememberedConfirms(session))}）`);
          }
        );
        await stopReading(frame);

        /* ── 4. 開き直しても訊かれない ── */
        await restartVsCode(session);
        frame = await openVoiceReading(session);
        const beforeReopenedRead = textCarrying(fake);
        await frame.locator("#aloudPlay").click();
        await waitUntil(async () => textCarrying(fake) > beforeReopenedRead, "開き直したあとは訊かれずに本文がエンジンへ届く", 20_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（窓：${JSON.stringify(await dialogText(session.page))}／届いた頼み：${JSON.stringify(fake.requests.slice(-6))}）`);
        });
        expect(await dialogText(session.page), "「以降は訊かない」にしたのに、開き直したあと確認の窓が出ました").toBeUndefined();
        await stopReading(frame);

        /* ── 5. 「確認省略解除」に並び、外せる ── */
        await runCommand(session.page, "確認省略解除");
        const rows = await waitForQuickPick(session.page, "訊かないことにした確認（1件）", 20_000);
        const label = `人物の声の送り先：${fake.host}へ本文を送る`;
        expect(rows.map((row) => row.label), `見直しの一覧：${JSON.stringify(rows)}`).toContain(label);
        await toggleQuickPickRow(session.page, label);
        await acceptQuickPick(session.page);
        await waitUntil(async () => !(memoryId in (await rememberedConfirms(session))), `設定から ${memoryId} が消える`, 15_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（覚え：${JSON.stringify(await rememberedConfirms(session))}）`);
        });

        /* ── 6. 開き直すと、また訊かれる ── */
        await restartVsCode(session);
        frame = await openVoiceReading(session);
        const beforeAskedAgain = textCarrying(fake);
        await frame.locator("#aloudPlay").click();
        await waitSendConfirm(session.page, frame, fake.host, "外したあと開き直すと、また確認の窓が出る");
        await closeDialog(session.page);
        await holdsFor(async () => textCarrying(fake) === beforeAskedAgain, "外したあとの窓を閉じれば、本文は届かない", 3_000);
      },
      // 接続先は使い捨てのユーザー設定へ（作者の設定には触れない）。0.146.0 からは古い設定として読まれ、
      // 口が 50021 でないので AivisSpeech の接続先になる（前の版の設定のまま使えることも、ここで見る）
      { settings: { "novelai.readAloud.voiceEngineUrl": `http://${fake.host}` } }
    );
  } finally {
    await fake.close();
  }
}, 360_000);
