/**
 * 相談パネル（横のパネル・大きい画面・対話式プロット）の入力欄に問いを入れて［送る］を押し、
 * 自分の問いが会話に出るまで待つ（設計書6.113。2026-10-16 に chatLocateAndMain の ask() から切り出した）。
 *
 * **入力欄は座標で押さず、`fill` で焦点を渡して入れる。** 横の相談パネルは左の列の一番下に押し込まれると
 * 枠（WebView）の高さが約100pxになり、入力欄はその下（窓の外）にある。押すたびに中を巻いて押すが、
 * 左の列の木の高さがまだ動いている最中だと、押下が外側の枠にだけ届いて入力欄に届かず、
 * 打った字がどこにも入らないまま［送る］が空振りし、「答えが出ない」で落ちていた（単独で24回中4回）。
 * 大きい画面は枠が広いのでふだんは外れないが、同じ部品を使えば入れ方の揺れを1か所で直せる。
 *
 * ここを使うテストが見張っているのは「送ったあとに何が起きるか」で、入れ方はキーで打つことにこだわらない。
 * **「押したら焦点が移ること」を見ているテストには使わない**（見ているものが変わる）。
 *
 * **［送る］も同じ小さい枠の中にある**ので、押したあと自分の問いが会話に出るのを待ち、出なければ1回だけ押し直す。
 * 「送るのが外れた」と「答えが来ない」を失敗の文で分けるため、答えを待つのは呼び出し側に残す。
 */
import type { Frame } from "playwright-core";
import { waitUntil } from "./wait";

/** 相談の会話欄の字（`#log` の innerText） */
async function chatLogText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("log")?.innerText ?? "").catch(() => "");
}

/** 入力欄と枠の様子（入れるのや送るのが外れたとき、失敗の文に添える） */
export async function chatInputState(frame: Frame): Promise<string> {
  const inner = await frame
    .evaluate(() => ({
      active: document.activeElement?.id || document.activeElement?.tagName || "",
      hasFocus: document.hasFocus(),
      value: (document.getElementById("input") as HTMLTextAreaElement | null)?.value ?? null,
    }))
    .catch((error: unknown) => String(error));
  const outerBox = await frame
    .parentFrame()
    ?.frameElement()
    .then((element) => element.boundingBox())
    .catch(() => null);
  const inputBox = await frame.locator("#input").boundingBox().catch(() => null);
  return `面の中：${JSON.stringify(inner)}／枠：${JSON.stringify(outerBox)}／入力欄：${JSON.stringify(inputBox)}`;
}

/**
 * 問いを入力欄へ入れて送り、自分の問いが会話に出るまで待つ。答えは待たない（呼び出し側で待つ）。
 * `where` は失敗の文に出す場所の名前（「横の相談パネル」など）
 */
export async function sendChatQuestion(frame: Frame, question: string, where: string): Promise<void> {
  const input = frame.locator("#input");
  await input.fill(question);
  const typed = await input.inputValue().catch(() => "");
  if (typed !== question) {
    throw new Error(`${where}の入力欄に問いが入りません（入った字：${JSON.stringify(typed)}／${await chatInputState(frame)}）`);
  }

  // 製品は送るときに前後の空白を落として会話へ出す（workChatPanelHtml の send）
  const shown = question.trim();
  const sent = async (): Promise<boolean> => (await chatLogText(frame)).includes(shown);
  await frame.locator("#send").click();
  const sentFirst = await waitUntil(sent, `${where}の会話に自分の問いが出る`, 5_000).then(
    () => true,
    () => false
  );
  if (sentFirst) return;
  // 1回目の押下が外れたときだけ押し直す（入力欄に字が残っている＝まだ送っていない）。
  // 字が消えているなら送れていて、会話への表示が遅れているだけなので押さない（2回送らないため）
  if ((await input.inputValue().catch(() => "")) === question) await frame.locator("#send").click();
  await waitUntil(sent, `${where}の会話に自分の問いが出る（［送る］を押し直したあと）`, 10_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await chatInputState(frame)}／${where}の会話：${JSON.stringify((await chatLogText(frame)).slice(-400))}）`);
  });
}
