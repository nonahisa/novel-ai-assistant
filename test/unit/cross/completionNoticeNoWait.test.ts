import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * 終わりの知らせのボタンを、**待たない**（ノートPCの実機、2026-09-23）。
 *
 * ボタン付きの通知は、閉じられるまで返事が来ない（通知センターへ沈んだ
 * だけでは来ない）。これを `await` したままだと、押した操作の
 * 「動いている」札（`extension.ts` の `registerCommand`）を持ち続け、
 * 知らせを閉じるまで同じ操作を押しても「いま動いています」と断られる。
 * 抽出の完了の知らせで実際に起きた。
 *
 * ここで見るのは**同じ形を直した所が、また `await` に戻っていないか**
 * である。抽出そのものの振る舞い（知らせを閉じなくても戻る・あとで
 * 押したボタンも効く）は `extractCharactersFlow.test.ts` で動かして見ている。
 * ほかは画面の部品を大量に偽らないと走らせられないので、書き方で押さえる。
 */

const SRC = join(__dirname, "..", "..", "..", "src");

/** 直した所。ファイルと、その知らせの文にしか無い言葉 */
const SITES: ReadonlyArray<{ file: string; phrase: string; why: string }> = [
  {
    file: "features/generateSettingsDocs.ts",
    phrase: "の一覧を生成しました。",
    why: "抽出のあとに続けて出る。抽出の札を持ったまま待っていた",
  },
  {
    file: "features/generateSynopses.ts",
    phrase: "サブタイトルの案が",
    why: "各話あらすじの終わりに出る",
  },
  {
    file: "features/unifyCharacters.ts",
    phrase: "にまとめました。",
    why: "重複をまとめるの終わりに出る",
  },
  {
    file: "features/applyPendingUpdates.ts",
    phrase: "人は反映できませんでした。",
    why: "更新分を反映の終わりに出る",
  },
  {
    file: "features/gitSync.ts",
    phrase: "件のファイルが更新されました。",
    why: "同期（取り込み）の終わりに出る",
  },
  {
    file: "features/gitSync.ts",
    phrase: "\"すべてあとで\"",
    why: "すべて同期の終わりに、まとめて1回出る",
  },
  {
    file: "features/nameRename.ts",
    phrase: "件を提案パネルに出しました。",
    why: "名前の付け替えの終わりに、資料への反映のボタン付きで出る（0.76.7）",
  },
  {
    file: "extension.ts",
    phrase: "意味検索が「切」になっています。",
    why: "索引づくりを押したが意味検索が切のとき",
  },
];

/** 言葉を含む `vscode.window.showXxxMessage(` の呼び出しの頭の位置 */
function callStartBefore(source: string, phraseAt: number): number {
  const pattern = /vscode\.window\.show(?:Information|Warning|Error)Message\(/g;
  let last = -1;
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || match.index > phraseAt) break;
    last = match.index;
  }
  return last;
}

describe("終わりの知らせのボタンを待たない", () => {
  test.each(SITES)("$file：$why", ({ file, phrase }) => {
    const source = readFileSync(join(SRC, file), "utf8");
    const at = source.indexOf(phrase);
    expect(at, `${file} に「${phrase}」が見つからない`).toBeGreaterThan(-1);

    const start = callStartBefore(source, at);
    expect(start).toBeGreaterThan(-1);
    // 呼び出しの直前が `await` なら、押されるまで札を持ち続ける
    const before = source.slice(Math.max(0, start - 20), start);
    expect(before).not.toMatch(/await\s*\(?\s*$/);
  });
});
