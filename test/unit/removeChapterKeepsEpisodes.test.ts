import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withoutChapterStartingAt } from "../../src/models/chapter";

/**
 * **章を外しても、話は1つも消えない**（設計書6.66）。実機確認 F-60 の項目。
 *
 * 章は `設定/章立て.json` に「どの話から始まるか」を書いた台帳でしかなく、
 * 本文の置き場とは関係が無い。**外すとは、台帳からその1件を落とすこと**である。
 *
 * ただし画面の見え方は変わる——章ノードが消えて、話が章なしの並びへ戻る。
 * **作者には「章ごと消えた」ように見える**ので、ここで本文まで消す実装が
 * 紛れ込むと、気づかれるのは次に読み返したときになる。
 *
 * そこで2つを押さえる。
 *
 * - 台帳の側：ほかの章が残ること（`chapter.test.ts` の「章を外しても、ほかの章は残る」）
 * - 配線の側：**章の操作が、本文を書く口をそもそも持っていないこと**
 */

const source = readFileSync(
  resolve(__dirname, "../../src/features/manageChapters.ts"),
  "utf8"
);

describe("章を外す", () => {
  test("台帳から、その章だけが落ちる", () => {
    const chapters = [
      { name: "第一部", startEpisodePath: "本文/001.txt" },
      { name: "第二部", startEpisodePath: "本文/010.txt" },
      { name: "第三部", startEpisodePath: "本文/020.txt" },
    ];

    const left = withoutChapterStartingAt(chapters, "本文/010.txt");

    expect(left.map((chapter) => chapter.name)).toEqual(["第一部", "第三部"]);
  });

  test("無い章を外そうとしても、台帳は変わらない", () => {
    const chapters = [{ name: "第一部", startEpisodePath: "本文/001.txt" }];
    expect(withoutChapterStartingAt(chapters, "本文/999.txt")).toEqual(chapters);
  });

  test("**章の操作は、本文を書く口を持たない**", () => {
    // ここが崩れると、章を外したときに本文まで消せてしまう。
    // 章は台帳（ChapterStore）だけを触る
    expect(source).toContain('from "../core/chapterStore"');
    for (const forbidden of [
      "core/textFile",
      "core/atomicWrite",
      "workspace.fs.delete",
      "workspace.fs.rename",
      "workspace.fs.writeFile",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  test("外す前に、確認を1回だけ出す", () => {
    // 取り消せる操作（もう一度その話から章を始めれば戻る）なので、
    // 二重に確かめない。ただし1回は要る——押し間違いで章が消えるため
    const at = source.indexOf("export async function removeChapter(");
    expect(at).toBeGreaterThan(0);
    const body = source.slice(at, at + 1200);

    expect(body).toContain("showWarningMessage");
    expect((body.match(/showWarningMessage/g) ?? []).length).toBe(1);
    // **話は消えない**と、確認の文が自分で言っている
    expect(body).toContain("話は削除されません");
    // 承諾しなければ、そこで戻る（台帳を読みにも行かない）
    expect(body).toContain('if (answer !== "章を外す") return false;');
  });
});
