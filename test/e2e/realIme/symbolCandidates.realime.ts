/**
 * 本物の日本語入力（オリジナルIME。殻は Setsuna）で、**記号の候補の『 と『彼は**（2026-11-15 作者の依頼。③）。
 *
 * 1. 「 のキー → SPACE で候補が出る（核の表：「 『 （ ( 【 …。novel-ime の docs/記号の候補.md）。2番目の 『 で
 *    確定すると、殻が 』 を足して 『』 が入り、カーソルが間に来る
 * 2. 「 のキー → romaji:kareha → SPACE で、2番目の候補『彼は で確定すると、殻が 』 を足して『彼は』になる
 *    （novel-ime の docs/実機確認リスト.md の「「かれは と打ってスペースで、2番目に『彼は が出て、選ぶと 』 が付く」）
 *
 * **2番目の選び方は DOWN**。殻（setsuna の ime-core/src/engine_bridge.rs）は、変換中（Converting）の SPACE を
 * `handle_down` へ回すので SPACE でも同じ所へ進むが、SPACE は先に別の扱い（登録した語の読み・英語の混ざった
 * 読み）を通る。DOWN は候補の選びを1つ下げるだけなので、こちらにする。数字のキーは候補の窓の1頁の数しだいなので
 * 使わない。SPACE の直後は候補が非同期で届く（届く前は仮の1件だけ）ので、少し待ってから DOWN を押す。
 * **何回押すかは決め打ちしない**（2026-11-16）：作者の学習で 『 が1番目に上がっている機械があるので、候補の窓の並びを
 * 殻の合図から読み、『（『彼は）の番目まで動かす（`RealIme.typeAndChoose`）。「2番目」は学習の無いときの並び
 *
 * 2番目を選ぶと IME の学習に入る。試しの作品（`試しの前後.ps1 -Before` が知らせる test-realime）で打ち、
 * 試しの後（`-After`）が学習を消す。
 *
 * **流すのは作者がこの PC を使っていないときだけ**。門は `NOVELAI_REAL_IME=1`。AI は呼ばない。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { caretPosition, composeText, openEpisode, placeCaretBefore } from "../support/manuscriptFrame";
import { saveAndSettle } from "../support/fileSettle";
import { waitUntil } from "../support/wait";
import { describeSignals, REAL_IME_ENABLED, runRealImeTest } from "./support/imeBridge";

/*
  **打つ所は行の頭**（2026-11-16）。IME の今の決まりでは、閉じ括弧が付くのは開き括弧が行の頭にあるときだけ
  （作者 2026-11-15「行頭でやる場合は今までどおりで、行中では「だけ」）
*/
const EPISODE = "003_記号の候補.txt";
const BODY = "一行目の終わり。\n二行目の終わり。\n";
const FIRST = "一行目の終わり。";
const SECOND = "二行目の終わり。";
const EXPECTED_BODY = "『』一行目の終わり。\n『彼は』二行目の終わり。\n";

test.skipIf(!REAL_IME_ENABLED)("本物の IME：「 → SPACE の2番目の 『 で 『』 が入ってカーソルが間に来る。「かれは → SPACE の2番目の『彼は で 』 が付く", async (ctx) => {
  await runRealImeTest(ctx, "記号の候補", [{ name: EPISODE, text: BODY }], async (session, ime) => {
    const frame = await openEpisode(session.page, EPISODE, FIRST);

    // 1. 「 → SPACE → 2番目（『）で確定
    await placeCaretBefore(frame, FIRST);
    const mark1 = await ime.mark();
    await ime.typeAndChoose(frame, ["char:[", "key:SPACE", "wait:600"], "『");
    await waitUntil(async () => (await composeText(frame)).includes(`『』${FIRST}`), "『』 が画面に出る", 15_000).catch(
      async (error: unknown) => {
        throw new Error(
          `${String(error)}（画面の本文：${JSON.stringify(await composeText(frame))}・${describeSignals(await ime.signalsSince(mark1))}）`
        );
      }
    );
    expect(await caretPosition(frame), `カーソルが 『』 の間にある（${describeSignals(await ime.signalsSince(mark1))}）`).toEqual({
      lineText: `『』${FIRST}`,
      column: "『".length,
    });

    // 2. 「 → かれは → SPACE → 2番目（『彼は）で確定
    await placeCaretBefore(frame, SECOND);
    const mark2 = await ime.mark();
    await ime.typeAndChoose(frame, ["char:[", "romaji:kareha", "key:SPACE", "wait:600"], "『彼は");
    await waitUntil(async () => (await composeText(frame)).includes(`『彼は』${SECOND}`), "『彼は』 が画面に出る", 15_000).catch(
      async (error: unknown) => {
        throw new Error(
          `${String(error)}（画面の本文：${JSON.stringify(await composeText(frame))}・${describeSignals(await ime.signalsSince(mark2))}）`
        );
      }
    );

    const file = path.join(session.manuscriptFolder, EPISODE);
    await saveAndSettle(session.page, file, "記号の候補を打った話");
    const saved = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
    expect(saved, "保存したファイル").toBe(EXPECTED_BODY);
  });
});
