/**
 * 本物の日本語入力（オリジナルIME。殻は Setsuna）で、**「」の対のカーソル**（2026-11-15 作者の依頼。②）。
 *
 * 「 のキー → ENTER → romaji:a → ENTER と OS のキーで打つ。殻は「 を確定すると 」 を足し、カーソルを
 * 「」の間に置く。続けて打った「あ」は間に入り、本文は「あ」になるのが正しい。
 *
 * 2026-11-15 の IME の側の答えでは、殻が 」 を足したあとカーソルが 」 の後ろへ行き、本文が「」あ になっていた
 * （括弧のカーソルの置き直しは、そのあと IME の側で直した）。テストは正しい動き（「あ」）を確かめる形で書いてあり、
 * `test.fails` にはしない。
 *
 * 落ちたとき（と通ったときも）の調べのために、殻の合図の pairs（括弧の対）・carets（カーソルの置き直し）を
 * 失敗の文と試しの注記（annotate）に添える。
 *
 * **流すのは作者がこの PC を使っていないときだけ**。門は `NOVELAI_REAL_IME=1`。AI は呼ばない。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { composeText, openEpisode, placeCaretBefore } from "../support/manuscriptFrame";
import { saveAndSettle } from "../support/fileSettle";
import { waitUntil } from "../support/wait";
import { describeSignals, REAL_IME_ENABLED, runRealImeTest } from "./support/imeBridge";

/*
  **打つ所は行の頭**（2026-11-16）。IME の今の決まり（作者 2026-11-15「行頭でやる場合は今までどおりで、行中では「だけ」）
  では、開き括弧の前が行の初めから空白と開き括弧だけのときだけ閉じ括弧を足す。行の途中で打つと 」 は付かない
*/
const EPISODE = "002_かぎ括弧.txt";
const BODY = "雨が上がった。\n二行目の終わり。\n";
const NEEDLE = "二行目の終わり。";
const EXPECTED_LINE = "「あ」二行目の終わり。";
const EXPECTED_BODY = "雨が上がった。\n「あ」二行目の終わり。\n";

test.skipIf(!REAL_IME_ENABLED)("本物の IME：行の頭で「 を確定すると 」 が付いてカーソルが間に来て、続けて打った「あ」が間に入る", async (ctx) => {
  await runRealImeTest(ctx, "かぎ括弧の対", [{ name: EPISODE, text: BODY }], async (session, ime) => {
    const frame = await openEpisode(session.page, EPISODE, NEEDLE);
    await placeCaretBefore(frame, NEEDLE);
    const mark = await ime.mark();
    await ime.type(frame, ["char:[", "key:ENTER", "wait:300", "romaji:a", "key:ENTER"]);
    // 打った字が画面に出きるのを待つ（「 と 」 と あ の3字が増える）
    await waitUntil(async () => (await composeText(frame)).includes("あ"), "打った「あ」が画面に出る", 15_000).catch(() => undefined);
    await session.page.waitForTimeout(500);
    const signals = await ime.signalsSince(mark);
    const report = describeSignals(signals);
    console.error(`[本物のIME] かぎ括弧の対：${report}`);
    await ctx.annotate(report, "殻の合図");

    const shown = await composeText(frame);
    expect(shown, `画面の本文（${report}）`).toContain(EXPECTED_LINE);

    const file = path.join(session.manuscriptFolder, EPISODE);
    await saveAndSettle(session.page, file, "かぎ括弧を打った話");
    const saved = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
    expect(saved, `保存したファイル（${report}）`).toBe(EXPECTED_BODY);
  });
});
