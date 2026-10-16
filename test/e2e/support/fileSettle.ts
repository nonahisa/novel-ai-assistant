/**
 * 書き込みの「途中」を読まないための部品（画面の自動テスト、設計書6.113）。
 *
 * ディスクのファイルを読んで確かめるテストは、書き込みのどの瞬間に読むかで答えが変わる。
 * 書き込み口は2種類あり、途中で見えるものが違う。
 *
 * | 書き込み口 | 途中で見えるもの | 使う部品 |
 * |---|---|---|
 * | VS Code 本体の保存（Ctrl+S・`document.save()`。原稿エディターの保存もこれ） | **空のファイル**（いったん空にしてから書く。一時ファイルを経ない） | `saveAndSettle` |
 * | 製品の既存ファイルの書き戻し（`writeTextFilePreservingFormat`・人物や場所など既存レコードの更新） | **ファイルが無い**（退避のコピー → 削除 → 一時ファイルから作り直す） | `readFileWhenPresent`・`readJsonWhenPresent` |
 * | 製品の `atomicWriteFile` の指定なし（スケジュール・焼いた表紙）と新規作成 | 隙間なし（一時ファイルからの rename で一度に入れ替わる） | ふつうの `readFile` でよい |
 *
 * **「打った字が入るまで待つ」のように、新しい中身を正の形で待つ所は、この部品が要らない。**
 * 空も「無い」も、その述語を偽にするだけで待ちが続く（無いときに投げる読み方なら
 * `.catch` で握るか、ここの `readFileWhenPresent` を使う）。要るのは次の2つ：
 * - 保存しても**変わらない**こと・何かが**無い**ことを、保存の直後に読んで確かめる所（空が「変わった」に見える）
 * - 読みが例外を投げる所（`waitUntil` は確かめの中の例外を握らないので、消えた瞬間を読むとそこで落ちる）
 */
import { readFile, stat } from "node:fs/promises";
import type { Page } from "playwright-core";
import { waitUntil } from "./wait";
import { notificationTexts } from "./workbenchDom";

/** 製品の書き戻しの「無い」隙間を待つ既定の長さ。負荷の下では退避のコピー＋削除＋作り直しが伸びる */
const PRESENT_TIMEOUT_MS = 5_000;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * ファイルを読む。**無い（ENOENT）ときだけ**少し待って読み直す。
 *
 * 製品の書き戻しは「退避 → 削除 → 作り直し」なので、一瞬ファイルが無い。その瞬間に当たると
 * `readFile` が投げ、`waitUntil` の中ならそのまま落ちる。期限を過ぎても無ければ、最後の例外を
 * そのまま投げる——`""` を返して黙ると、「変わらない」「無い」の確かめが偽の成功になる。
 * ほかの例外（権限など）は待たずに投げる
 */
export async function readFileWhenPresent(file: string, timeoutMs = PRESENT_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (!isMissing(error) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * JSON のファイルを読む。無いときと、**読めた字が JSON として壊れている**ときは少し待って読み直す。
 *
 * 製品の書き込みは一度に入れ替わるので壊れた JSON は見えないはずだが、テストの側が `writeFile` で
 * 置いた直後（書いている途中）を読むことはある。期限を過ぎたら最後の例外をそのまま投げる
 */
export async function readJsonWhenPresent<T>(file: string, timeoutMs = PRESENT_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
      if (!(isMissing(error) || error instanceof SyntaxError) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Ctrl+S を押し、保存の書き込みが**終わるまで**待つ。`file` は保存される文書のファイル（絶対パス）。
 *
 * **VS Code 本体の保存は、ファイルをいったん空にしてから書く**（一時ファイルを経ない）。
 * 書いている途中に読むと空の中身が返る。母艦（0.107.14、1.141.0、2026-10-16）で、CPU を
 * 8本回した負荷の下では5回中2〜3回、保存の直後に読んだ .txt が `""` で「保存しても
 * ファイルは変わらない」が崩れた（plainEditorKeys。全件の走りで1回落ちたのもこれ。単独では
 * 書き込みが一瞬で終わり、読む刻みに当たらない）。空の中身は落ちたあとには残っておらず、製品は
 * 保存の前に本文を書き換えない（`onWillSaveTextDocument` を持たない）ので、本体の書き込みの途中を読んだもの。
 *
 * そこで「保存がファイルに届いた（更新時刻が進んだ）」→「中身が空でなく、続けて読んでも
 * 同じ」の2段を名乗って待つ。中身の正しさは、待ったあとに呼び手が確かめる。
 * 保存が断られた（「ファイルのほうが新しい」など）ときは右下の知らせに出るので、落ちた文に添える
 */
export async function saveAndSettle(page: Page, file: string, label: string): Promise<void> {
  const before = (await stat(file)).mtimeMs;
  await page.keyboard.press("Control+KeyS");
  let last = "";
  try {
    await waitUntil(
      async () => ((await stat(file).catch(() => undefined))?.mtimeMs ?? before) > before,
      `Ctrl+S の保存が${label}のファイルに届く`,
      10_000
    );
    let same = 0;
    await waitUntil(
      async () => {
        const now = await readFile(file, "utf8").catch(() => "");
        same = now !== "" && now === last ? same + 1 : 0;
        last = now;
        return same >= 3;
      },
      `${label}の保存の書き込みが終わる`,
      10_000
    );
  } catch (error) {
    if (error instanceof Error) {
      const notices = await notificationTexts(page).catch(() => [] as string[]);
      error.message +=
        `［最後に読めた中身 ${JSON.stringify(last.slice(0, 200))}］` +
        `［右下の知らせ ${JSON.stringify(notices.map((entry) => entry.replace(/\s+/g, " ").slice(0, 160)))}］`;
    }
    throw error;
  }
}
