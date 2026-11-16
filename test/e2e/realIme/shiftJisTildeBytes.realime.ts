/**
 * 本物の日本語入力（オリジナルIME。殻は Setsuna）で打った波線が、**Shift_JIS の原稿で 81 60 になる**か
 * （2026-11-15 作者の依頼。④。作り方は `test/e2e/shiftJisSaveBytes.test.ts` を写した）。
 *
 * 1. ~ のキー（日本語の配列では Shift+^）を打って ENTER で確定 → 日本語の入力では全角のチルダ（U+FF5E）が入る。
 *    保存したファイルのその所が 81 60
 * 2. romaji:kara → SPACE で候補を出し、**7番目**の波ダッシュ（U+301C）で確定して保存 → 製品が保存の直前に
 *    Shift_JIS に書ける全角のチルダへ置き換えるので、ファイルは 81 60。画面の本文も全角のチルダへ替わる
 *
 * **7番目の選び方**：SPACE で変換を始め（1番目が選ばれる）、少し待って候補が届いてから DOWN を6回。核は「から」の
 * 読みに、ふつうの語の2つのあと3位から記号を出すが、あとで足す英語の候補に押されて波ダッシュは7位
 * （novel-ime の docs/引継ぎ書.md、2026-11-14「から〜」）。数字のキー（7）は候補の窓の1頁の数しだいなので使わない。
 * **DOWN の回数は決め打ちしない**（2026-11-16）：学習で並びが替わるので、候補の窓の並びを殻の合図から読んで、
 * 波ダッシュの番目まで動かす（`RealIme.typeAndChoose`）。「7位」は学習の無いときの並び。
 * 選び間違い（候補の順が違う）と製品の不具合を分けるため、**保存の前に**画面の本文が U+301C になったことを確かめる。
 * 7番目を選ぶと IME の学習に入るので、試しの作品で打つ（試しの後が学習を消す）。
 *
 * 2つの波線は見た目で見分けにくいので、コードではエスケープ（～・〜）で書く。
 * 落ちたときは読んだバイト列を16進で添える。**流すのは作者がこの PC を使っていないときだけ**。門は `NOVELAI_REAL_IME=1`。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import iconv = require("iconv-lite");
import { expect, test } from "vitest";
import { composeText, openEpisode, placeCaretAfter } from "../support/manuscriptFrame";
import { saveAndSettle } from "../support/fileSettle";
import { waitUntil } from "../support/wait";
import { REAL_IME_ENABLED, runRealImeTest } from "./support/imeBridge";

const EPISODE = "004_シフトJISの波線.txt";
const BODY = "終電を逃した駅のホーム。\n雨の音だけが残っていた。\n";
/** 全角のチルダ（～）。Shift_JIS（CP932）で 81 60 */
const FULLWIDTH_TILDE = "～";
/** 波ダッシュ（〜）。Shift_JIS（CP932）に無い。製品が保存の直前に全角のチルダへ置き換える */
const WAVE_DASH = "〜";
const TILDE_BYTES = [0x81, 0x60];

function hex(bytes: Uint8Array | readonly number[]): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

/** 期待のバイト：本文の片々を Shift_JIS にし、間に 81 60 を挟む（前後の字が変わっていないことも見る） */
function expectedBytes(pieces: readonly string[]): number[] {
  const out: number[] = [];
  pieces.forEach((piece, index) => {
    if (index > 0) out.push(...TILDE_BYTES);
    out.push(...iconv.encode(piece, "shift_jis"));
  });
  return out;
}

test.skipIf(!REAL_IME_ENABLED)("本物の IME：Shift_JIS の原稿で、~ のキーの「～」も、「から」の7番目の候補の「〜」も、保存すると 81 60 になる", async (ctx) => {
  await runRealImeTest(
    ctx,
    "Shift_JIS の波線",
    [{ name: EPISODE, text: BODY }],
    async (session, ime) => {
      const { page, manuscriptFolder } = session;
      const file = path.join(manuscriptFolder, EPISODE);
      const frame = await openEpisode(page, EPISODE, "雨の音");

      // 1. ~ のキー → ENTER
      await placeCaretAfter(frame, "雨の音");
      await ime.type(frame, ["char:~", "wait:200", "key:ENTER"]);
      await waitUntil(async () => (await composeText(frame)).includes(`雨の音${FULLWIDTH_TILDE}だけ`), "全角のチルダが画面に出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（画面の本文：${JSON.stringify(await composeText(frame))}）`);
        }
      );
      await saveAndSettle(page, file, "~ のキーを打った話");
      const first = await readFile(file);
      const firstWanted = expectedBytes(["終電を逃した駅のホーム。\n雨の音", "だけが残っていた。\n"]);
      expect(Array.from(first), `~ のキーのあとのファイル：${hex(first)}（期待：${hex(firstWanted)}）`).toEqual(firstWanted);

      // 2. から → SPACE → 7番目（波ダッシュ）で確定 → 保存
      await placeCaretAfter(frame, "駅の");
      await ime.typeAndChoose(frame, ["romaji:kara", "key:SPACE", "wait:600"], WAVE_DASH);
      // 保存の前に、選んだのが波ダッシュであることを確かめる（候補の順の違いを製品の不具合と取り違えない）
      await waitUntil(async () => (await composeText(frame)).includes(`駅の${WAVE_DASH}ホーム`), "7番目の候補の波ダッシュが画面に出る", 15_000).catch(
        async (error: unknown) => {
          throw new Error(
            `${String(error)}（画面の本文：${JSON.stringify(await composeText(frame))}。` +
              "候補の7番目が波ダッシュでない、または候補が届く前に選んだ見込み）"
          );
        }
      );
      await saveAndSettle(page, file, "波ダッシュを選んだ話");
      const second = await readFile(file);
      const secondWanted = expectedBytes(["終電を逃した駅の", "ホーム。\n雨の音", "だけが残っていた。\n"]);
      expect(Array.from(second), `波ダッシュのあとのファイル：${hex(second)}（期待：${hex(secondWanted)}）`).toEqual(secondWanted);
      expect(second.includes(0x3f), `「?」で書かれていない：${hex(second)}`).toBe(false);
      // 画面の本文も、保存の直前の置き換えに揃う
      await waitUntil(async () => (await composeText(frame)).includes(`駅の${FULLWIDTH_TILDE}ホーム`), "画面の波ダッシュが全角のチルダに替わる", 15_000);
    },
    {
      settings: { "files.encoding": "shiftjis" },
      // 見本はいったん UTF-8 で書かれるので、起こす前に Shift_JIS のバイトで置き直す
      prepareWork: async ({ manuscriptFolder }) => {
        await writeFile(path.join(manuscriptFolder, EPISODE), iconv.encode(BODY, "shift_jis"));
      },
    }
  );
});
