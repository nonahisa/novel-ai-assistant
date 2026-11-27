import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 話の名前を変える入口は、どれも先に未保存の本文を保存させる（実装ルール1）。
 *
 * 打ちかけのまま名前を変えると、未保存の面は古い名前に残り（`closeRenamedManuscript` は
 * 未保存の面を閉じない）、あとで保存すると古い名前のファイルが戻る。同じ話が
 * 「新しい名前＝保存前の内容」と「古い名前＝最新の内容」の2つに割れ、走査は両方を話と数える。
 * 原稿エディターの F2 だけが確かめていて、作品一覧の F2 と右クリックは素通りしていた（2026-11-27）。
 */
const src = readFileSync(resolve(__dirname, "../../../src/extension.ts"), "utf8");

function commandBody(id: string): string {
  // 命令の名前はほかの所（キーの振り分けなど）にも出るので、登録の所を探す
  const start = src.search(new RegExp(`registerCommand\\(\\s*"${id.replace(/\./g, "\\.")}"`));
  expect(start).toBeGreaterThan(0);
  const end = src.indexOf("registerCommand(", start + id.length);
  return src.slice(start, end < 0 ? undefined : end);
}

describe("名前を変える前に未保存の本文を保存させる", () => {
  for (const id of ["novelai.renameWithSubtitle", "novelai.renameSelectedEpisode"]) {
    test(`${id}：保存の確認が名前を変える前にあり、原稿エディターから来たときに限らない`, () => {
      const body = commandBody(id);
      const save = body.indexOf("saveDirtyDocumentsBeforeExtraction(");
      const rename = body.indexOf("renameWithSubtitle(node.work");
      expect(save).toBeGreaterThan(0);
      expect(rename).toBeGreaterThan(save);
      // 原稿エディターから来たときだけ確かめる形（`manuscriptKeyFileOf(node) &&`）へ戻さない
      expect(body).not.toMatch(/manuscriptKeyFileOf\(node\)\s*&&\s*!\(await saveDirtyDocumentsBeforeExtraction/);
    });
  }
});
